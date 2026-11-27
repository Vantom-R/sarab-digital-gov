// Ops — the operator's robot. It runs inside Compose like everything else, has no published port and no
// internet access; it reaches Telegram only through the notifier. All schedules are in Riyadh time.
//   * nightly encrypted backup (backup.ts) at BACKUP_AT_RIYADH (03:30), caught up after downtime
//   * audit anchor (anchor.ts) every hour at minute 05, kept on the server and fully verified, and posted to
//     Telegram every hour: SILENTLY (no sound, no phone notification) except the first one after
//     ANCHOR_POST_AT_RIYADH (09:00), which is the normal daily message. The hourly off-server copy keeps the
//     window for an undetected insider rewrite at one hour (red-team item A). A failed check alerts at once.
//   * monitoring (monitor.ts) every minute, daily status report at 09:00, heartbeat to the notifier
// Telegram rule: routine messages at most once a day; only real problems go out immediately, and a problem
// that persists is repeated at most once a day. The one exception, approved by the operator on 27 Nov 2026:
// the hourly anchor copy, which is sent silently.
import { createServer } from 'node:http';
import { runBackup } from './backup.ts';
import { postText } from './notify.ts';
import { anchorText, silentAnchorText, checkChain, fetchHead, loadAnchors, recordAnchor } from './anchor.ts';
import { load, save } from './state.ts';
import { heartbeat, monitorTick, reportText, snapshot } from './monitor.ts';
import { hhmmToMinutes, riyadhAr, riyadhDay, riyadhMinutes } from '#shared/time.ts';

const BACKUP_AT = hhmmToMinutes(process.env.BACKUP_AT_RIYADH ?? '03:30');
const ANCHOR_POST_AT = hhmmToMinutes(process.env.ANCHOR_POST_AT_RIYADH ?? '09:00');
const DAY = 86_400_000;
const status: Record<string, unknown> = { started_at: new Date().toISOString() };

/** The most recent time (today or yesterday) the clock in Riyadh showed `minutes` past midnight. */
function lastSlot(minutes: number, now = Date.now()): number {
  const t = Date.parse(`${riyadhDay(now)}T00:00:00+03:00`) + minutes * 60_000;
  return t <= now ? t : t - DAY;
}

// ---------------- Backups ----------------
let backupRunning = false;
let backupRetryAt = 0;
export async function backupJob(reason: string): Promise<void> {
  if (backupRunning) return;
  backupRunning = true;
  const st = load('backup', { last_ok: 0, failures: 0, alerted_at: 0 });
  try {
    const r = await runBackup();
    save('backup', { last_ok: Date.now(), failures: 0, alerted_at: 0, last: { name: r.name, size: r.size, parts: r.parts.length, rows: r.rows, seconds: r.seconds } });
    status.backup = { ok: true, at: new Date().toISOString(), name: r.name };
    console.log(`ops: backup ${r.name} done (${reason}): ${(r.size / 1024 / 1024).toFixed(2)} MB, ${r.parts.length} part(s), ${r.rows} rows, ${r.seconds} s`);
    if (st.alerted_at) await postText('/alert', { resolved: true, text: `النسخ الاحتياطي يعمل من جديد | Backup works again\n${riyadhAr(Date.now())}` }).catch(() => {});
  } catch (e) {
    const failures = st.failures + 1;
    backupRetryAt = Date.now() + 30 * 60_000;
    status.backup = { ok: false, at: new Date().toISOString(), error: (e as Error).message };
    console.error(`ops: backup failed: ${(e as Error).message}`);
    // First failure: at once. Still failing: a reminder at most once a day (retries continue every 30 min).
    let alerted_at = st.alerted_at;
    if (!alerted_at || Date.now() - alerted_at > DAY) {
      await postText('/alert', { text: `فشل النسخ الاحتياطي | Backup FAILED (attempt ${failures})\n${(e as Error).message.slice(0, 400)}\nتُعاد المحاولة كل 30 دقيقة دون رسائل جديدة | retrying every 30 min, quietly\n${riyadhAr(Date.now())}` }).catch((x) => console.error(`ops: ${x.message}`));
      alerted_at = Date.now();
    }
    save('backup', { ...st, failures, alerted_at });
  } finally {
    backupRunning = false;
  }
}

setInterval(() => {
  const st = load('backup', { last_ok: 0, failures: 0, alerted_at: 0 });
  if (st.last_ok < lastSlot(BACKUP_AT) && Date.now() >= backupRetryAt) void backupJob('schedule');
}, 30_000).unref();

// ---------------- Audit anchor ----------------
interface AnchorState { last_at: number; failing: string; alerted_at: number; posted_day: string }
const anchorState = () => load<AnchorState>('anchor', { last_at: 0, failing: '', alerted_at: 0, posted_day: '' });
let anchorRunning = false;
export async function anchorJob(): Promise<void> {
  if (anchorRunning) return;
  anchorRunning = true;
  const st = anchorState();
  const fail = async (key: string, text: string) => {
    // A new problem alerts at once; the same problem again at most once a day.
    if (key !== st.failing || Date.now() - st.alerted_at > DAY) {
      await postText('/alert', { text: `${text}\n${riyadhAr(Date.now())}` }).catch(() => {});
      save('anchor', { ...st, failing: key, alerted_at: Date.now() });
    } else save('anchor', { ...st, failing: key });
  };
  try {
    const head = await fetchHead();
    const check = await checkChain(loadAnchors(), head);
    if (!check.ok) {
      // A failed check is never anchored (it would vouch for a rewritten log).
      await fail(check.problems.join('|'), `سجل التدقيق لا يطابق المراسي | AUDIT CHAIN CHECK FAILED\n${check.problems.slice(0, 6).join('\n').slice(0, 1100)}`);
      status.anchor = { ok: false, at: new Date().toISOString(), problems: check.problems };
      return;
    }
    recordAnchor(head);   // every hour, on the server (what the next checks compare against)
    let posted_day = st.posted_day;
    const today = riyadhDay();
    if (posted_day !== today && riyadhMinutes() >= ANCHOR_POST_AT) {
      await postText('/anchor', { text: anchorText(head, check) });   // once a day: the normal message
      posted_day = today;
    } else {
      // Every other hour: the same off-server copy, silent. An insider who rewrites the log and the
      // server's anchor file can then hide at most the last hour, not the last day.
      await postText('/anchor', { text: silentAnchorText(head), silent: true });
    }
    if (st.failing) await postText('/alert', { resolved: true, text: `سجل التدقيق سليم من جديد | Audit chain check passes again\n${riyadhAr(Date.now())}` }).catch(() => {});
    save('anchor', { last_at: Date.now(), failing: '', alerted_at: 0, posted_day });
    status.anchor = { ok: true, at: new Date().toISOString(), seq: head.seq, anchors_checked: check.checked };
    console.log(`ops: audit anchor #${head.seq} recorded and posted${posted_day === today && st.posted_day !== today ? ' (daily message)' : ' (silently)'} (${check.entries} entries verified, ${check.checked} anchors match)`);
  } catch (e) {
    console.error(`ops: audit anchor failed: ${(e as Error).message}`);
    status.anchor = { ok: false, at: new Date().toISOString(), error: (e as Error).message };
    await fail(`error:${(e as Error).message}`, `تعذّر أخذ مرساة سجل التدقيق | Audit anchor could not be taken\n${(e as Error).message.slice(0, 400)}`);
  } finally {
    anchorRunning = false;
  }
}

let anchorTriedAt = 0;
setInterval(() => {
  const st = anchorState();
  const now = new Date();
  const slot = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), 5);
  const due = slot <= now.getTime() ? slot : slot - 3_600_000;
  // Once per hour; while failing, try again every 10 minutes (silently: see fail()).
  if (st.last_at < due && Date.now() - anchorTriedAt > (st.failing ? 600_000 : 60_000)) {
    anchorTriedAt = Date.now();
    void anchorJob();
  }
}, 30_000).unref();

// ---------------- Monitoring ----------------
setTimeout(() => void monitorTick(), 20_000);
setInterval(() => void monitorTick(), 60_000).unref();
setInterval(() => void heartbeat(), 60_000).unref();
void heartbeat();

// Listens on localhost only: the health check and cli.ts run inside this container; nothing else needs it
// (red-team finding: the gateway, on the shared ex-jisr network, could read /status).
createServer((req, res) => {
  if (req.url === '/healthz') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  if (req.url === '/status') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...status, monitor: snapshot, report: reportText(), backup_state: load('backup', {}), anchor_state: load('anchor', {}) }));
  res.writeHead(404).end();
}).listen(Number(process.env.PORT ?? 3000), '127.0.0.1', () => console.log(`ops listening; backups daily at ${process.env.BACKUP_AT_RIYADH ?? '03:30'}, anchor and report posts at 09:00 (Riyadh time)`));
