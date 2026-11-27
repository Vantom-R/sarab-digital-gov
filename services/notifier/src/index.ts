// Notifier — the only container with internet access and the only one holding the Telegram bot token.
// It plays the role of an SMS gateway for every one-time code in Sarab, carries the government news feed,
// and the operator's channel (alerts, audit anchors, encrypted backups). Only Mithaq and the ops container
// reach it, over a private Docker network nothing else is on. Callers can never pick a recipient.
//
// Each caller proves who it is with its own key (header x-notifier-key), and each may use only its own
// endpoints: Mithaq only /send and /feed, ops everything else. Mithaq never sends text: it sends structured
// fields and the notifier builds the message from fixed templates (packages/shared/src/telegram-text.ts),
// so a compromised Mithaq cannot post arbitrary text, fake an alert or a maintenance notice (red-team H).
//   POST /send     {template, code, …}  → a one-time code, sent at once (Mithaq)
//   POST /feed     {title, people, …}   → a news-feed message; 429 {"retry_after": s} when it must wait — Mithaq
//                                         keeps it queued and tries again, so nothing is dropped (Mithaq)
//   POST /alert    {"text","resolved"?} → monitoring alert; the notifier adds the heading so an alert always
//                                         looks like one ("🚨 تنبيه | ALERT" / "✅ زال التنبيه | RESOLVED")
//   POST /anchor   {"text","silent"?}   → the audit-chain anchor: hourly and silent (no sound, no phone notification),
//                                         once a day as a normal message (ops writes its own first line)
//   POST /notice   {"text"}             → a short operator notice, e.g. "🔧 صيانة: تم تحديث …" after a redeploy
//   POST /status-report {"text"}       → the daily status report ("📊 تقرير يومي | DAILY STATUS")
//   POST /heartbeat                     → the ops container is alive; if it stays silent for 10 minutes the
//                                         notifier itself raises an alert (ops does all other monitoring)
//   GET  /probe                         → fetches the PUBLIC site (fixed: PUBLIC_ORIGIN, through the host's reverse proxy)
//                                         and reads its TLS certificate's expiry — ops has no internet
//   POST /document?name=…&caption=…     → a file (raw body, Content-Length required, at most 49 MB), streamed
//                                         to Telegram without being held in memory; heading "💾 …" is added
// Telegram's limits: about one message per second to one chat (20 per minute in a group). Every message
// goes through ONE pacing queue here (at least 1.1 s apart); the feed may use at most 15 a minute, so codes
// and alerts always get through. If Telegram itself says "too many requests", its retry_after is honoured
// for everything. The token is never logged; Telegram errors are reduced to a status code.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { codeRequestProblem, codeText, feedRequestProblem, feedText, type CodeRequest, type FeedRequest } from '#shared/telegram-text.ts';
import { connect as tlsConnect } from 'node:tls';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const CHAT = process.env.TELEGRAM_CHAT_ID ?? '';
// Console mode (local use): with no Telegram bot configured, every message is printed to this container's
// log instead — read your one-time codes with `docker compose logs -f notifier`.
const CONSOLE = !TOKEN && !CHAT;
if (CONSOLE) console.log('notifier: no Telegram bot configured — CONSOLE MODE: messages are printed here, nothing is sent');
else if (!/^\d+:[\w-]{20,}$/.test(TOKEN) || !/^-?\d+$/.test(CHAT)) {
  console.error('notifier: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID malformed (see .env), or leave both empty for console mode');
  process.exit(1);
}

export const HEADINGS = {
  alert: '🚨 تنبيه | ALERT',
  resolved: '✅ زال التنبيه | RESOLVED',
  document: '💾 نسخة احتياطية مشفّرة | ENCRYPTED BACKUP',
  report: '📊 تقرير يومي | DAILY STATUS',
  security: '🛡️ تقرير أمني | SECURITY REPORT',
};
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN ?? '';

// ---------------- callers ----------------
const KEYS = { mithaq: process.env.NOTIFIER_KEY_MITHAQ ?? '', ops: process.env.NOTIFIER_KEY_OPS ?? '' };
if (KEYS.mithaq.length < 32 || KEYS.ops.length < 32 || KEYS.mithaq === KEYS.ops) {
  console.error('notifier: NOTIFIER_KEY_MITHAQ / NOTIFIER_KEY_OPS missing or too short (run make init)');
  process.exit(1);
}
type Caller = keyof typeof KEYS;
const ALLOWED: Record<Caller, Set<string>> = {
  mithaq: new Set(['/send', '/feed']),
  ops: new Set(['/alert', '/anchor', '/notice', '/status-report', '/heartbeat', '/document', '/probe']),
};
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function caller(req: IncomingMessage): Caller | null {
  const k = req.headers['x-notifier-key'];
  if (typeof k !== 'string') return null;
  return (Object.keys(KEYS) as Caller[]).find((c) => same(k, KEYS[c])) ?? null;
}

const GAP_MS = 1_100;          // between any two messages to the chat
const FEED_PER_MINUTE = 15;    // the rest of Telegram's ~20/minute is left for codes and alerts
const CODES_PER_HOUR = 60;     // per lane: backstop in case a caller misbehaves (Mithaq limits each recipient to 1 per 60 s)
// Staff sign-in codes have their own lane, so codes anyone can trigger (citizens, the public demo accounts)
// can never exhaust the budget the administrator needs to sign in (red-team finding, 2026-11-24).
const ALERTS_PER_HOUR = 60;    // backstop against a flapping monitor
const MAX_DOCUMENT = 49 * 1024 * 1024; // Telegram bots may upload up to 50 MB

let nextFree = 0;              // earliest time the next message may go out
let blockedUntil = 0;          // Telegram said "retry after"
const feedSent: number[] = [];
const codesSent: number[] = [];
const staffCodesSent: number[] = [];
const alertsSent: number[] = [];
const prune = (a: number[], ms: number, now: number) => { while (a.length && a[0]! < now - ms) a.shift(); };
let chain: Promise<unknown> = Promise.resolve();

type Kind = 'code' | 'feed' | 'alert' | 'anchor' | 'document' | 'report' | 'notice';
type Result = { status: number; body: object };

async function telegram(method: string, init: RequestInit & { duplex?: 'half' }, timeoutMs = 10_000): Promise<Result> {
  if (CONSOLE) {
    if (method === 'sendMessage') console.log(`\n----- message (console mode) -----\n${JSON.parse(String(init.body)).text}\n----------------------------------`);
    else { for await (const _chunk of init.body as AsyncIterable<unknown>) { /* read the upload, send nothing */ } console.log(`notifier (console mode): ${method} not sent`); }
    return { status: 200, body: { ok: true } };
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (r.status === 429) {
      const wait = Number((await r.json().catch(() => ({})))?.parameters?.retry_after) || 5;
      blockedUntil = Date.now() + wait * 1000;
      console.error(`notifier: telegram asked to wait ${wait} s`);
      return { status: 429, body: { error: 'rate_limited', retry_after: wait } };
    }
    if (!r.ok) { console.error(`notifier: telegram answered HTTP ${r.status} to ${method}`); return { status: 502, body: { error: 'delivery_failed' } }; }
    return { status: 200, body: { ok: true } };
  } catch (e) {
    console.error(`notifier: telegram unreachable (${(e as any)?.cause?.code ?? (e as Error).name})`);
    return { status: 502, body: { error: 'delivery_failed' } };
  }
}

const sendText = (text: string, silent = false) => telegram('sendMessage', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ chat_id: CHAT, text, disable_web_page_preview: true, ...(silent ? { disable_notification: true } : {}) }),
});

/** One message through the pacing queue. Codes and alerts wait their turn (a second or two); feed messages are told to come back. */
function deliver(kind: Kind, send: () => Promise<Result>, lane: 'staff' | 'citizen' = 'citizen'): Promise<Result> {
  const run = async (): Promise<Result> => {
    const now = Date.now();
    if (kind === 'feed') {
      prune(feedSent, 60_000, now);
      const wait = Math.max(blockedUntil - now, feedSent.length >= FEED_PER_MINUTE ? feedSent[0]! + 60_000 - now : 0, nextFree - now > 5_000 ? nextFree - now : 0);
      if (wait > 0) return { status: 429, body: { error: 'rate_limited', retry_after: Math.ceil(wait / 1000) } };
    } else {
      const capped = kind === 'code' ? (lane === 'staff' ? staffCodesSent : codesSent) : kind === 'alert' ? alertsSent : null;
      if (capped) {
        prune(capped, 3_600_000, now);
        if (capped.length >= (kind === 'code' ? CODES_PER_HOUR : ALERTS_PER_HOUR)) return { status: 429, body: { error: 'rate_limited', retry_after: Math.ceil((capped[0]! + 3_600_000 - now) / 1000) } };
      }
      if (blockedUntil - now > 15_000) return { status: 429, body: { error: 'rate_limited', retry_after: Math.ceil((blockedUntil - now) / 1000) } };
    }
    const pause = Math.max(nextFree, blockedUntil) - Date.now();
    if (pause > 0) await new Promise((r) => setTimeout(r, pause));
    nextFree = Date.now() + GAP_MS;
    const res = await send();
    if (res.status === 200) {
      ({ feed: feedSent, code: lane === 'staff' ? staffCodesSent : codesSent, alert: alertsSent } as Record<string, number[]>)[kind]?.push(Date.now());
      console.log(`notifier: ${kind === 'code' ? 'message' : kind} delivered`);
    }
    return res;
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

const json = (res: ServerResponse, r: Result) => {
  res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.body));
};

/** A file upload, streamed: multipart head + the caller's body + multipart tail. */
function sendDocument(req: IncomingMessage, size: number, name: string, caption: string): () => Promise<Result> {
  return () => {
    const b = `sarab${randomBytes(12).toString('hex')}`;
    const field = (k: string, v: string) => `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
    const head = Buffer.from(`${field('chat_id', CHAT)}${field('caption', caption)}--${b}\r\nContent-Disposition: form-data; name="document"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${b}--\r\n`);
    let received = 0;
    async function* body() {
      yield head;
      for await (const chunk of req) { received += (chunk as Buffer).length; yield chunk as Buffer; }
      if (received !== size) throw new Error('short body');
      yield tail;
    }
    return telegram('sendDocument', {
      method: 'POST', duplex: 'half', body: body() as any,
      headers: { 'content-type': `multipart/form-data; boundary=${b}`, 'content-length': String(head.length + size + tail.length) },
    }, 300_000);
  };
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

// ---------------- watching the watcher ----------------
let lastHeartbeat = 0;          // 0 = never seen since start (ops may simply not be deployed yet)
let silentAlerted = false;
setInterval(() => {
  if (!lastHeartbeat) return;
  const silent = Date.now() - lastHeartbeat > 10 * 60_000;
  if (silent && !silentAlerted) {
    silentAlerted = true;
    void deliver('alert', () => sendText(`${HEADINGS.alert}\nحاوية التشغيل صامتة | The ops container is SILENT for 10 min\nالمراقبة والنسخ الاحتياطي والمراسي متوقفة | monitoring, backups and audit anchors are not running`));
  } else if (!silent && silentAlerted) {
    silentAlerted = false;
    void deliver('alert', () => sendText(`${HEADINGS.resolved}\nحاوية التشغيل تعمل من جديد | The ops container is back`));
  }
}, 60_000).unref();

/** The public site from outside (DNS → the host's reverse proxy → gateway) and its certificate. Fixed target only. */
async function probe(): Promise<Result> {
  if (CONSOLE) return { status: 200, body: { status: 200, ms: 0, note: 'console mode: no outside probe' } };
  if (!/^https:\/\/[\w.-]+$/.test(PUBLIC_ORIGIN)) return { status: 200, body: { error: 'PUBLIC_ORIGIN not set' } };
  const host = new URL(PUBLIC_ORIGIN).hostname;
  const out: Record<string, unknown> = {};
  const t0 = Date.now();
  try {
    const r = await fetch(`${PUBLIC_ORIGIN}/api/v1/identity/apps/config`, { signal: AbortSignal.timeout(15_000) });
    await r.arrayBuffer();
    out.status = r.status; out.ms = Date.now() - t0;
  } catch (e) { out.error = `unreachable (${(e as any)?.cause?.code ?? (e as Error).name})`; }
  out.cert_days_left = await new Promise<number | null>((resolve) => {
    const s = tlsConnect({ host, port: 443, servername: host, timeout: 10_000 }, () => {
      const c = s.getPeerCertificate();
      s.end();
      resolve(c?.valid_to ? Math.floor((Date.parse(c.valid_to) - Date.now()) / 86_400_000) : null);
    });
    s.on('error', () => resolve(null));
    s.on('timeout', () => { s.destroy(); resolve(null); });
  });
  return { status: 200, body: out };
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://notifier');
  if (req.method === 'GET' && url.pathname === '/health') return json(res, { status: 200, body: { ok: true } });
  // Everything else needs the caller's key, and each caller only reaches its own endpoints.
  const who = caller(req);
  if (!who) { req.resume(); return json(res, { status: 401, body: { error: 'unknown_caller' } }); }
  if (!ALLOWED[who].has(url.pathname)) { req.resume(); return json(res, { status: 403, body: { error: 'not_allowed_for_caller' } }); }
  if (req.method === 'GET' && url.pathname === '/probe') return json(res, await probe());
  if (req.method !== 'POST') { req.resume(); return json(res, { status: 404, body: { error: 'not_found' } }); }

  if (url.pathname === '/document') {
    const size = Number(req.headers['content-length']);
    const name = url.searchParams.get('name') ?? '';
    const caption = url.searchParams.get('caption') ?? '';
    if (!Number.isInteger(size) || size < 1 || size > MAX_DOCUMENT || !/^[\w.-]{1,100}$/.test(name) || caption.length > 900) {
      req.resume();
      return json(res, { status: 400, body: { error: 'bad_request' } });
    }
    const heading = url.searchParams.get('kind') === 'security' ? HEADINGS.security : HEADINGS.document;
    return json(res, await deliver('document', sendDocument(req, size, name, `${heading}\n${caption}`)));
  }

  if (url.pathname === '/heartbeat') { req.resume(); lastHeartbeat = Date.now(); return json(res, { status: 200, body: { ok: true } }); }
  const body = await readJson(req);

  // Mithaq: structured fields only; the text comes from the fixed templates.
  if (url.pathname === '/send') {
    const problem = codeRequestProblem(body);
    if (problem) { console.error(`notifier: code request refused (${problem})`); return json(res, { status: 400, body: { error: 'bad_request', problem } }); }
    const r = body as CodeRequest & { lane?: string };
    const { lane: _lane, ...fields } = r;
    return json(res, await deliver('code', () => sendText(codeText(fields, PUBLIC_ORIGIN)), r.template === 'staff-login' ? 'staff' : 'citizen'));
  }
  if (url.pathname === '/feed') {
    const problem = feedRequestProblem(body);
    if (problem) { console.error(`notifier: feed message refused (${problem})`); return json(res, { status: 400, body: { error: 'bad_request', problem } }); }
    return json(res, await deliver('feed', () => sendText(feedText(body as FeedRequest))));
  }

  // Ops: its own texts (alerts, anchors, notices, the daily report).
  const kind = ({ '/alert': 'alert', '/anchor': 'anchor', '/status-report': 'report', '/notice': 'notice' } as Record<string, Kind>)[url.pathname];
  if (!kind) return json(res, { status: 404, body: { error: 'not_found' } });
  const text = body?.text;
  if (typeof text !== 'string' || !text || text.length > 1500) return json(res, { status: 400, body: { error: 'bad_request' } });
  const full = kind === 'alert' ? `${body.resolved === true ? HEADINGS.resolved : HEADINGS.alert}\n${text}` : kind === 'report' ? `${HEADINGS.report}\n${text}` : text;
  json(res, await deliver(kind, () => sendText(full, kind === 'anchor' && body.silent === true)));
}).listen(Number(process.env.PORT ?? 3000), () => console.log('notifier listening'));
