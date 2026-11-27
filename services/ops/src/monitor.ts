// Monitoring: checks every minute, alerts through the notifier ("🚨 تنبيه | ALERT", then "✅ … RESOLVED").
//
//   containers   every container of the project: running? healthy? restarted (and OOM-killed)? missing?
//                memory close to its limit? — read through a read-only Docker API proxy (GET /containers only)
//   host         RAM available, disk used (the root filesystem, seen through ./backups)
//   uptime       inside: portal, public API and Jisr through the gateway; outside: the public URL through
//                the host's reverse proxy and the TLS certificate's expiry (the notifier, which has internet, probes it)
//   errors       error/fatal log lines of every service and 5xx answers of the gateway, every 5 minutes
//                (lines written during a maintenance window are not counted: see maintenance.ts)
//   jobs         last backup < 26 h old, last audit anchor < 2.5 h old
// A problem must persist for a few checks before it alerts (deploys recreate containers), each alert is
// sent once and resolved once, and every morning at 09:00 Riyadh time a status report goes out — so silence never
// means "fine": if the report does not arrive, monitoring itself is down. The notifier also raises an
// alert on its own when this container stops sending heartbeats.
import { readFileSync, statfsSync } from 'node:fs';
import { notifierKey, postText } from './notify.ts';
import { load, save } from './state.ts';
import { duringMaintenance, endMaintenance, inMaintenance, loadMaintenance, maintenanceWindows } from './maintenance.ts';
import { hhmmToMinutes, riyadh, riyadhDay, riyadhHM, riyadhMinutes, TZ_LABEL } from '#shared/time.ts';

const DOCKER = process.env.DOCKER_API ?? 'http://docker-api:2375';
const GATEWAY = process.env.GATEWAY_URL ?? 'http://gateway:8080';
const NOTIFIER = process.env.NOTIFIER_URL ?? 'http://notifier:3000';
const PROJECT = process.env.COMPOSE_PROJECT ?? 'sarab';
const DISK_ALERT = 85, DISK_OK = 80;           // % used
const RAM_ALERT = 10, RAM_OK = 15;             // % available
const MEM_LIMIT_ALERT = 90;                    // % of a container's memory limit
const ERRORS_ALERT = 20;                       // error lines per service per 5 minutes
const REPORT_AT = hhmmToMinutes(process.env.REPORT_AT_RIYADH ?? '09:00');   // Riyadh time
/** Alert kinds that a planned rebuild / redeploy (maintenance window) legitimately causes. */
const DEPLOY_NOISE = /^((down|unhealthy|missing|inside|errors|mem|monitor):|outside$)/;

interface AlertState { since: number; count: number; notified: boolean; text: string; clear?: number }
interface MonState { alerts: Record<string, AlertState>; started: Record<string, string>; services: string[]; report_day: string; maint_seen: number; day: { restarts: number; alerts: number; errors: number } }
const fresh = (): MonState => ({ alerts: {}, started: {}, services: [], report_day: '', maint_seen: 0, day: { restarts: 0, alerts: 0, errors: 0 } });
let st: MonState = load('monitor', fresh());
export const snapshot: Record<string, unknown> = {};

let maint = false;          // inside a maintenance window this tick
let afterMaint = false;     // first tick after a window closed: containers were replaced on purpose
const ago = (ms: number) => (ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);
async function getJson(url: string, timeout = 10_000, headers: Record<string, string> = {}): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout), headers });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** A problem seen now. It alerts once it has been seen `after` times in a row. */
async function problem(key: string, text: string, after = 2): Promise<void> {
  if (maint && DEPLOY_NOISE.test(key)) {
    // A planned rebuild: forget what has not been reported yet; an alert already sent stays open.
    if (st.alerts[key] && !st.alerts[key]!.notified) delete st.alerts[key];
    return;
  }
  const a = st.alerts[key] ?? { since: Date.now(), count: 0, notified: false, text };
  a.count++; a.text = text; a.clear = 0;
  st.alerts[key] = a;
  if (!a.notified && a.count >= after) {
    await postText('/alert', { text: `${text}\nمنذ | since ${riyadhHM(a.since)} ${TZ_LABEL.ar}` });
    a.notified = true;
    st.day.alerts++;
  }
}
/** The same problem is gone (for `okAfter` checks in a row, so a flapping problem does not flood the chat). */
async function ok(key: string, text: string, okAfter = 1): Promise<void> {
  const a = st.alerts[key];
  if (!a) return;
  a.clear = (a.clear ?? 0) + 1;
  if (a.notified && a.clear < okAfter) return;
  delete st.alerts[key];
  if (a.notified) await postText('/alert', { resolved: true, text: `${text}\nاستمر | lasted ${ago(Date.now() - a.since)}` });
}
/** One-off event: no "resolved". */
async function event(text: string): Promise<void> {
  await postText('/alert', { text });
  st.day.alerts++;
}

// ---------------- containers ----------------
async function checkContainers(): Promise<void> {
  const filter = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${PROJECT}`] }));
  const list: any[] = await getJson(`${DOCKER}/containers/json?all=1&filters=${filter}`);
  const seen = new Set<string>();
  let healthy = 0;
  const rows: unknown[] = [];
  const restarted: string[] = [];
  for (const c of list) {
    const svc = c.Labels?.['com.docker.compose.service'] ?? c.Names?.[0];
    if (c.Labels?.['com.docker.compose.oneoff'] === 'True') continue;   // `docker compose run` helpers
    seen.add(svc);
    const info = await getJson(`${DOCKER}/containers/${c.Id}/json`);
    const state = info.State ?? {};
    const health = state.Health?.Status ?? 'none';
    const wasDown = !!st.alerts[`down:${svc}`];   // its comeback is reported as "back up", not also as a restart
    // One-shot set-up containers (jisr-migrate) run, finish and stay "exited": that is success, not "down".
    const oneshot = c.Labels?.['sarab.oneshot'] === 'true';
    if (oneshot && state.Status === 'exited' && state.ExitCode === 0) { healthy++; await ok(`down:${svc}`, `اكتملت المهمة | One-shot job finished: ${svc}`); continue; }
    rows.push({ service: svc, state: state.Status, health, restarts: info.RestartCount });
    if (state.Status !== 'running' && !(oneshot && (state.Status === 'created' || state.Status === 'running'))) {
      await problem(`down:${svc}`, `الحاوية متوقفة | Container DOWN: ${svc}\nالحالة | state: ${state.Status}${state.ExitCode ? ` (exit ${state.ExitCode})` : ''}${state.OOMKilled ? ', killed: out of memory' : ''}`);
    } else {
      await ok(`down:${svc}`, `الحاوية تعمل من جديد | Container back up: ${svc}`);
    }
    if (state.Status === 'running' && health === 'unhealthy') {
      const last = state.Health?.Log?.at(-1)?.Output?.trim().slice(0, 150) ?? '';
      await problem(`unhealthy:${svc}`, `الحاوية غير سليمة | Container UNHEALTHY: ${svc}${last ? `\n${last}` : ''}`);
    } else if (state.Status === 'running') {
      await ok(`unhealthy:${svc}`, `الحاوية سليمة من جديد | Container healthy again: ${svc}`);
    }
    if (state.Status === 'running' && (health === 'healthy' || health === 'none')) healthy++;
    // Restart = same container, new start time (a deploy creates a NEW container, which is not a restart).
    const prev = st.started[c.Id];
    if (prev && state.StartedAt && prev !== state.StartedAt && !wasDown && !maint && !afterMaint) {
      st.day.restarts++;
      restarted.push(`${svc}${state.OOMKilled ? ' — نفدت الذاكرة | out of memory (OOM)' : ''} (restarts: ${info.RestartCount})`);
    }
    if (state.StartedAt) st.started[c.Id] = state.StartedAt;
    // Memory close to the container's limit (cache excluded, like `docker stats`).
    if (state.Status === 'running') {
      const s = await getJson(`${DOCKER}/containers/${c.Id}/stats?stream=false&one-shot=true`);
      const limit = s.memory_stats?.limit ?? 0;
      const used = (s.memory_stats?.usage ?? 0) - (s.memory_stats?.stats?.inactive_file ?? 0);
      if (limit > 0 && limit < 64 * 1024 ** 3) {
        const pct = Math.round((used / limit) * 100);
        if (pct >= MEM_LIMIT_ALERT) await problem(`mem:${svc}`, `ذاكرة الحاوية قرب الحد | Container memory HIGH: ${svc} ${pct}% of ${Math.round(limit / 1024 ** 2)} MiB`, 3);
        else if (pct < MEM_LIMIT_ALERT - 5) await ok(`mem:${svc}`, `ذاكرة الحاوية طبيعية | Container memory normal: ${svc} ${pct}%`);
      }
    }
  }
  // One message per check, so `make restart` gives one alert, not twenty.
  if (restarted.length) await event(`أُعيد تشغيل ${restarted.length > 1 ? 'حاويات' : 'حاوية'} | Container${restarted.length > 1 ? 's' : ''} RESTARTED${restarted.length > 4 ? ' (probably a manual restart)' : ''}:\n- ${restarted.join('\n- ')}`);
  for (const id of Object.keys(st.started)) if (!list.some((c) => c.Id === id)) delete st.started[id];
  // A service that used to exist and has no container at all any more.
  if (maint || afterMaint) st.services = [...seen].sort();   // services added or removed on purpose
  for (const svc of st.services) {
    if (!seen.has(svc)) await problem(`missing:${svc}`, `الحاوية مفقودة | Container MISSING: ${svc}`, 3);
    else await ok(`missing:${svc}`, `الحاوية موجودة من جديد | Container present again: ${svc}`);
  }
  st.services = [...new Set([...st.services, ...seen])].sort();
  const notOk = (rows as any[]).filter((r) => r.state !== 'running' || (r.health !== 'healthy' && r.health !== 'none'))
    .map((r) => `${r.service} (${r.state !== 'running' ? r.state : r.health === 'starting' ? 'starting' : r.health})`);
  snapshot.containers = { total: seen.size, healthy, not_ok: notOk, rows };
}

// ---------------- host ----------------
async function checkHost(): Promise<void> {
  const fs = statfsSync('/backups');
  const usedPct = Math.round((1 - fs.bavail / fs.blocks) * 100);
  const freeGb = (fs.bavail * fs.bsize) / 1024 ** 3;
  if (usedPct >= DISK_ALERT) await problem('disk', `القرص ممتلئ تقريبًا | Disk ALMOST FULL: ${usedPct}% used, ${freeGb.toFixed(1)} GB free`, 1);
  else if (usedPct < DISK_OK) await ok('disk', `مساحة القرص طبيعية | Disk OK: ${usedPct}% used`);
  const mem = Object.fromEntries(readFileSync('/proc/meminfo', 'utf8').split('\n').map((l) => l.split(/:\s+/)).filter((x) => x.length === 2).map(([k, v]) => [k, parseInt(v!, 10)]));
  const availPct = Math.round((mem.MemAvailable! / mem.MemTotal!) * 100);
  if (availPct < RAM_ALERT) await problem('ram', `الذاكرة منخفضة | Server RAM LOW: ${availPct}% available (${Math.round(mem.MemAvailable! / 1024)} MiB)`, 3);
  else if (availPct >= RAM_OK) await ok('ram', `ذاكرة الخادم طبيعية | Server RAM OK: ${availPct}% available`);
  snapshot.host = { disk_used_pct: usedPct, disk_free_gb: Number(freeGb.toFixed(1)), ram_available_pct: availPct, ram_available_mib: Math.round(mem.MemAvailable! / 1024) };
}

// ---------------- uptime ----------------
async function checkInside(): Promise<void> {
  const targets: [string, string][] = [['portal', '/'], ['public API', '/api/v1/identity/apps/config'], ['Jisr', '/api/jisr/audit/head']];
  for (const [name, path] of targets) {
    try {
      const r = await fetch(GATEWAY + path, { signal: AbortSignal.timeout(10_000), headers: { 'x-real-ip': '127.0.0.9' } });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      await r.arrayBuffer();
      await ok(`inside:${name}`, `يعمل من جديد | Back: ${name} (through the gateway)`);
    } catch (e) {
      await problem(`inside:${name}`, `لا يستجيب | NOT RESPONDING: ${name} (through the gateway)\n${(e as Error).message}`);
    }
  }
}

async function checkOutside(): Promise<void> {
  let p: { status?: number; ms?: number; cert_days_left?: number; error?: string };
  try { p = await getJson(`${NOTIFIER}/probe`, 30_000, notifierKey()); } catch (e) { p = { error: (e as Error).message }; }
  if (p.status === 200) await ok('outside', `الموقع متاح من الإنترنت من جديد | Public site reachable again (${p.ms} ms)`);
  else await problem('outside', `الموقع غير متاح من الإنترنت | Public site UNREACHABLE from outside\n${p.error ?? `HTTP ${p.status}`}`);
  if (typeof p.cert_days_left === 'number') {
    if (p.cert_days_left < 14) await problem('cert', `شهادة TLS تنتهي قريبًا | TLS certificate expires in ${p.cert_days_left} days (renew it on the reverse proxy)`, 1);
    else await ok('cert', `شهادة TLS جُدّدت | TLS certificate renewed: ${p.cert_days_left} days left`);
  }
  snapshot.outside = p;
}

// ---------------- error logs ----------------
let logsSince = Math.floor(Date.now() / 1000);
/** Docker multiplexes stdout/stderr in 8-byte-header frames (no TTY). */
function frames(buf: Buffer): string[] {
  const out: string[] = [];
  for (let i = 0; i + 8 <= buf.length;) {
    const n = buf.readUInt32BE(i + 4);
    out.push(buf.subarray(i + 8, i + 8 + n).toString('utf8'));
    i += 8 + n;
  }
  return out.join('').split('\n').filter(Boolean);
}
async function checkErrors(): Promise<void> {
  const until = Math.floor(Date.now() / 1000);
  const filter = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${PROJECT}`], status: ['running'] }));
  const list: any[] = await getJson(`${DOCKER}/containers/json?filters=${filter}`);
  const counts: Record<string, number> = {};
  let skipped = 0;
  const windows = maintenanceWindows();
  for (const c of list) {
    const svc = c.Labels?.['com.docker.compose.service'];
    if (!svc || svc.endsWith('-db') || svc === 'nats' || svc === 'docker-api') continue;
    const r = await fetch(`${DOCKER}/containers/${c.Id}/logs?stdout=1&stderr=1&timestamps=1&since=${logsSince}&until=${until}`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) continue;
    const lines = frames(Buffer.from(await r.arrayBuffer()));
    let n = 0;
    const samples: string[] = [];
    for (const raw of lines) {
      // Each line starts with Docker's own timestamp; lines from a maintenance window are planned noise.
      const sp = raw.indexOf(' ');
      const at = Date.parse(raw.slice(0, sp));
      const l = Number.isNaN(at) ? raw : raw.slice(sp + 1);
      let bad = false, msg = '';
      if (l.startsWith('{')) {
        try { const j = JSON.parse(l); if (j.level >= 50) { bad = true; msg = String(j.msg ?? j.err?.message ?? '').slice(0, 120); } } catch { /* not JSON */ }
      } else if (svc === 'gateway') {
        const m = /" (5\d\d) /.exec(l);
        if (m) { bad = true; msg = `${m[1]} ${(/"(\w+ [^"]+)"/.exec(l)?.[1] ?? '').replace(/\?.*$/, '').slice(0, 80)}`; }
      }
      if (bad && !Number.isNaN(at) && duringMaintenance(at, windows)) { skipped++; continue; }
      if (bad) { n++; if (samples.length < 2 && msg) samples.push(msg); }
    }
    counts[svc] = n;
    st.day.errors += n;
    if (n >= ERRORS_ALERT) await problem(`errors:${svc}`, `أخطاء كثيرة | Many ERRORS: ${svc}, ${n} in 5 min\n${samples.join('\n')}`, 1);
    else if (n === 0) await ok(`errors:${svc}`, `لا أخطاء منذ 15 دقيقة | No errors for 15 min: ${svc}`, 3);
  }
  logsSince = until;
  snapshot.errors_last_5_min = counts;
  snapshot.errors_skipped_maintenance = skipped;
}

// ---------------- jobs ----------------
async function checkJobs(): Promise<void> {
  const b = load('backup', { last_ok: 0 } as { last_ok: number; last?: { name: string; size: number } });
  const a = load('anchor', { last_at: 0 } as { last_at: number });
  if (b.last_ok && Date.now() - b.last_ok > 26 * 3_600_000) await problem('backup-age', `لا نسخة احتياطية حديثة | No backup for ${ago(Date.now() - b.last_ok)}`, 1);
  else if (b.last_ok) await ok('backup-age', 'النسخ الاحتياطي حديث | Backups are current again');
  if (a.last_at && Date.now() - a.last_at > 2.5 * 3_600_000) await problem('anchor-age', `لا مرساة حديثة لسجل التدقيق | No audit anchor for ${ago(Date.now() - a.last_at)}`, 1);
  else if (a.last_at) await ok('anchor-age', 'مراسي سجل التدقيق حديثة | Audit anchors are current again');
  snapshot.jobs = { backup: b.last_ok ? { at: riyadh(b.last_ok), age: ago(Date.now() - b.last_ok), mb: b.last ? (b.last.size / 1024 / 1024).toFixed(2) : '?' } : null, anchor_age: a.last_at ? ago(Date.now() - a.last_at) : null };
}

// ---------------- daily report ----------------
export function reportText(): string {
  const c = snapshot.containers as any, h = snapshot.host as any, o = snapshot.outside as any, j = snapshot.jobs as any;
  const active = Object.entries(st.alerts).filter(([, a]) => a.notified);
  return [
    `Sarab — ${riyadh(Date.now())} ${TZ_LABEL.ar}`,
    `الحاويات | containers: ${c ? `${c.healthy}/${c.total} running and healthy${c.not_ok?.length ? ` — not OK: ${c.not_ok.join(', ')}` : ''}` : 'unknown'}`,
    `الخادم | server: RAM ${h?.ram_available_pct ?? '?'}% available, disk ${h?.disk_used_pct ?? '?'}% used (${h?.disk_free_gb ?? '?'} GB free)`,
    `الموقع | public site: ${o?.status === 200 ? `up (${o.ms} ms)` : 'DOWN'}, TLS certificate ${o?.cert_days_left ?? '?'} days left`,
    `النسخ | last backup: ${j?.backup ? `${j.backup.at} (${j.backup.age} ago), ${j.backup.mb} MB` : 'none yet'}`,
    `المرساة | last audit anchor: ${j?.anchor_age ? `${j.anchor_age} ago` : 'none yet'}`,
    `آخر 24 ساعة | last 24 h: ${st.day.alerts} alerts, ${st.day.restarts} restarts, ${st.day.errors} error lines`,
    active.length ? `تنبيهات قائمة | open alerts (${active.length}):\n- ${active.map(([, a]) => a.text.split('\n')[0]).join('\n- ')}` : 'لا تنبيهات قائمة | no open alerts',
  ].join('\n');
}

async function maybeReport(): Promise<void> {
  const day = riyadhDay();
  if (riyadhMinutes() < REPORT_AT || st.report_day === day) return;
  // First start after 09:00: today's report time has passed already — start with tomorrow's, not now.
  if (!st.report_day) { st.report_day = day; return; }
  if (maint) return;   // never report a half-deployed state; it goes out after the window
  await postText('/status-report', { text: reportText() });
  st.report_day = day;
  st.day = { restarts: 0, alerts: 0, errors: 0 };
}

// ---------------- loop ----------------
let tick = 0;
let running = false;
export async function monitorTick(): Promise<void> {
  if (running) return;
  running = true;
  const step = async (name: string, f: () => Promise<void>) => {
    try { await f(); await ok(`monitor:${name}`, `فحص ${name} يعمل من جديد | Monitor check "${name}" works again`); }
    catch (e) { await problem(`monitor:${name}`, `فحص المراقبة متعطل | Monitor check "${name}" FAILING\n${(e as Error).message.slice(0, 200)}`, 3).catch(() => {}); }
  };
  try {
    const m = loadMaintenance();
    if (m.active && Date.now() >= m.until) await endMaintenance('expired').catch(() => {});   // nobody closed it
    maint = inMaintenance();
    afterMaint = !maint && m.ended_at > (st.maint_seen ?? 0);
    if (afterMaint) st.maint_seen = m.ended_at;
    snapshot.maintenance = maint;
    await step('containers', checkContainers);
    await step('host', checkHost);
    await step('inside', checkInside);
    if (tick % 5 === 0) { await step('outside', checkOutside); await step('errors', checkErrors); }
    await step('jobs', checkJobs);
    if (tick > 0) await maybeReport();   // not on the very first tick (snapshot incomplete)
    tick++;
    snapshot.checked_at = new Date().toISOString();
    snapshot.open_alerts = Object.entries(st.alerts).filter(([, a]) => a.notified).map(([k]) => k);
    save('monitor', st);
  } finally {
    running = false;
  }
}

export async function heartbeat(): Promise<void> {
  await fetch(`${NOTIFIER}/heartbeat`, { method: 'POST', headers: notifierKey(), signal: AbortSignal.timeout(5000) }).catch(() => {});
}
