// Maintenance mode: planned rebuilds and redeploys must not look like crashes.
//
//   make up / make deploy S="…" / make restart / make reset   (and make openapi)
//     1. `cli.ts maintenance start` — remembers every container (id + start time) and opens a window
//        (at most 30 minutes) in which the monitor stays silent about containers going down, restarting,
//        being missing or unhealthy, about the gateway / public site not answering, and about error lines
//        in the logs (lines written during a window, or up to 90 s after it, are never counted — even by
//        the 5-minute error check that runs after the window closed);
//     2. docker compose does its work (and waits until every container is healthy);
//     3. `cli.ts maintenance end` — compares with the snapshot and sends ONE message:
//        "🔧 صيانة: تم تحديث identity، jisr، gateway". Nothing changed → no message.
// Outside such a window every crash alerts as before. A window nobody closes ends by itself after 30
// minutes (the monitor then closes it and sends the same message), so it can never hide problems for long.
import { load, save } from './state.ts';
import { postText } from './notify.ts';
import { riyadhAr } from '#shared/time.ts';

const DOCKER = process.env.DOCKER_API ?? 'http://docker-api:2375';
const PROJECT = process.env.COMPOSE_PROJECT ?? 'sarab';
export const MAX_MINUTES = 30;

/** Containers keep logging errors for a short while after they were replaced (old ones shutting down, new ones warming up). */
export const GRACE_MS = 90_000;
export interface Window { from: number; to: number }
export interface Maintenance { active: boolean; started_at: number; until: number; before: Record<string, { id: string; started: string }>; ended_at: number; windows?: Window[] }
export const loadMaintenance = (): Maintenance => load('maintenance', { active: false, started_at: 0, until: 0, before: {}, ended_at: 0, windows: [] });
export function inMaintenance(m = loadMaintenance()): boolean { return m.active && Date.now() < m.until; }
/** The recent maintenance windows (plus the grace period after each), for the error-log check: an error line
 *  written during planned work never counts, even when the check that reads it runs after the window closed. */
export function maintenanceWindows(m = loadMaintenance()): Window[] {
  const w = [...(m.windows ?? [])];
  if (m.active) w.push({ from: m.started_at, to: Math.max(Date.now(), m.until) });
  return w.map((x) => ({ from: x.from, to: x.to + GRACE_MS }));
}
export const duringMaintenance = (t: number, windows: Window[]) => windows.some((w) => t >= w.from && t <= w.to);
const keepWindows = (m: Maintenance, add?: Window) => [...(m.windows ?? []), ...(add ? [add] : [])].filter((w) => w.to > Date.now() - 86_400_000).slice(-50);

async function containers(): Promise<Record<string, { id: string; started: string; running: boolean }>> {
  const filter = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${PROJECT}`] }));
  const r = await fetch(`${DOCKER}/containers/json?all=1&filters=${filter}`, { signal: AbortSignal.timeout(10_000) });
  const list = await r.json() as any[];
  const out: Record<string, { id: string; started: string; running: boolean }> = {};
  for (const c of list) {
    const svc = c.Labels?.['com.docker.compose.service'];
    if (!svc || c.Labels?.['com.docker.compose.oneoff'] === 'True') continue;
    const info = await (await fetch(`${DOCKER}/containers/${c.Id}/json`, { signal: AbortSignal.timeout(10_000) })).json() as any;
    // A one-shot set-up container (jisr-migrate) that finished well counts as "running" (it did its job).
    const done = c.Labels?.['sarab.oneshot'] === 'true' && info.State?.Status === 'exited' && info.State?.ExitCode === 0;
    out[svc] = { id: c.Id, started: info.State?.StartedAt ?? '', running: info.State?.Status === 'running' || done };
  }
  return out;
}

export async function startMaintenance(minutes = MAX_MINUTES): Promise<void> {
  const m = loadMaintenance();
  const now = Date.now();
  const before = m.active && now < m.until ? m.before : Object.fromEntries(Object.entries(await containers()).map(([k, v]) => [k, { id: v.id, started: v.started }]));
  save('maintenance', { active: true, started_at: m.active && now < m.until ? m.started_at : now, until: now + Math.min(minutes, MAX_MINUTES) * 60_000, before, ended_at: m.ended_at, windows: keepWindows(m) });
}

/** Closes the window and sends the one "🔧" message. Returns the services that changed. */
export async function endMaintenance(how: 'done' | 'expired' = 'done'): Promise<string[]> {
  const m = loadMaintenance();
  if (!m.active) return [];
  const now = await containers();
  const changed = Object.keys(now).filter((s) => !m.before[s] || m.before[s]!.id !== now[s]!.id || m.before[s]!.started !== now[s]!.started).sort();
  const removed = Object.keys(m.before).filter((s) => !now[s]).sort();
  const notRunning = Object.keys(now).filter((s) => !now[s]!.running).sort();
  save('maintenance', { active: false, started_at: m.started_at, until: 0, before: {}, ended_at: Date.now(), windows: keepWindows(m, { from: m.started_at, to: Math.min(Date.now(), m.until) }) });
  if (changed.length || removed.length) {
    const lines = [`🔧 صيانة: تم تحديث ${changed.join('، ') || '—'}`];
    if (removed.length) lines.push(`أُزيلت: ${removed.join('، ')}`);
    if (notRunning.length) lines.push(`⚠️ لا تعمل بعد الصيانة: ${notRunning.join('، ')} (سيصل تنبيه إن استمر ذلك)`);
    if (how === 'expired') lines.push(`انتهت نافذة الصيانة تلقائيًا بعد ${MAX_MINUTES} دقيقة`);
    lines.push(riyadhAr(Date.now()));
    await postText('/notice', { text: lines.join('\n') });
  }
  return changed;
}
