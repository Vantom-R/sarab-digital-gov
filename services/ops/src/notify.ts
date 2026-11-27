// The ops container's only way out: the notifier (private 'notify' network). Retries until delivered —
// alerts, anchors and backups are never silently dropped.
import { createReadStream, statSync } from 'node:fs';
import { request } from 'node:http';

const NOTIFIER = process.env.NOTIFIER_URL ?? 'http://notifier:3000';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Ops proves who it is to the notifier (Mithaq has a different key and reaches only /send and /feed). */
export const notifierKey = () => ({ 'x-notifier-key': process.env.NOTIFIER_KEY ?? '' });

/** Ops messages are suppressed (logged only) while OPS_DRY_RUN=1 — used by the automated tests. */
export const dryRun = () => process.env.OPS_DRY_RUN === '1';

async function withRetry(what: string, attempt: () => Promise<{ status: number; retry_after?: number }>, tries = 8): Promise<void> {
  for (let i = 1; ; i++) {
    let r: { status: number; retry_after?: number };
    try { r = await attempt(); } catch (e) { r = { status: 0 }; console.error(`ops: ${what}: ${(e as Error).message}`); }
    if (r.status === 200) return;
    if (i >= tries) throw new Error(`${what} not delivered (HTTP ${r.status})`);
    await sleep(Math.min(300_000, (r.retry_after ? r.retry_after * 1000 : 2_000 * 2 ** i)));
  }
}

export async function postText(path: '/alert' | '/anchor' | '/status-report' | '/notice', body: { text: string; resolved?: boolean; silent?: boolean }): Promise<void> {
  if (dryRun()) { console.log(`ops (dry run) ${path}: ${body.text.split('\n')[0]}`); return; }
  if (path === '/alert') console.log(`ops: ${body.resolved ? 'resolved' : 'ALERT'}: ${body.text.split('\n')[0]}`);
  await withRetry(path, async () => {
    const r = await fetch(`${NOTIFIER}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...notifierKey() }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    const j = await r.json().catch(() => ({})) as any;
    return { status: r.status, retry_after: j?.retry_after };
  });
}

export async function postDocument(file: string, name: string, caption: string, kind: 'backup' | 'security' = 'backup'): Promise<void> {
  if (dryRun()) { console.log(`ops (dry run) document ${name}`); return; }
  const size = statSync(file).size;
  const url = new URL(`${NOTIFIER}/document`);
  url.searchParams.set('name', name);
  url.searchParams.set('caption', caption);
  url.searchParams.set('kind', kind);
  await withRetry(`upload ${name}`, () => new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'content-length': size, ...notifierKey() }, timeout: 600_000 }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let j: any = {}; try { j = JSON.parse(b); } catch { /* */ } resolve({ status: res.statusCode ?? 0, retry_after: j?.retry_after }); });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    createReadStream(file).pipe(req);
  }));
}
