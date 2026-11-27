// Phase 6 — early session revocation.
//
// Sessions are still self-contained EdDSA JWTs (so services verify them offline), but Mithaq now also
// keeps a server-side list. A session is dead when:
//   * its own row is revoked (sign out, "sign out this device", admin revoke), or
//   * it was signed in before the account's sessions_not_before ("sign out everywhere", admin revoke-all), or
//   * it is a citizen/employee session signed in before the global kill-switch time.
// The gateway asks /internal/session-check on every API call, so revocation is immediate everywhere.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '#shared/db.ts';
import { httpError, S } from '#shared/http.ts';
import { tx } from '#shared/db.ts';
import { randomId } from '#shared/crypto.ts';
import { emitEvent } from '#shared/events.ts';
import { requireStaff, type Staff } from './staff.ts';
import { revokeAppDevices } from './apps.ts';
import { requireSession, verifySessionToken, setSessionValidator, SESSION_COOKIE, type Session } from '#shared/session.ts';

export async function recordSession(db: Db, s: Session, req: FastifyRequest): Promise<void> {
  const ua = String(req.headers['user-agent'] ?? '').slice(0, 160);
  await db.query(
    `INSERT INTO sessions (sid, subject, role, amr, auth_time, expires_at, user_agent) VALUES ($1,$2,$3,$4,to_timestamp($5),to_timestamp($6),$7)
     ON CONFLICT (sid) DO UPDATE SET expires_at = EXCLUDED.expires_at, last_refreshed_at = now()`,
    [s.sid, s.sub, s.role, s.amr, s.auth_time, s.exp, ua],
  );
}

/** true = still valid. Small in-process cache keeps the gateway check cheap. */
const cache = new Map<string, { ok: boolean; until: number }>();
export async function sessionIsValid(db: Db, s: Session): Promise<boolean> {
  const hit = cache.get(s.sid);
  if (hit && hit.until > Date.now()) return hit.ok;
  const { rows: [r] } = await db.query(
    `SELECT
       (SELECT revoked_at FROM sessions WHERE sid = $1) AS revoked_at,
       (SELECT sessions_not_before FROM accounts WHERE subject = $2) AS not_before,
       (SELECT value FROM settings WHERE key = 'kill_switch_not_before') AS kill`,
    [s.sid, s.sub],
  );
  const authMs = s.auth_time * 1000;
  // auth_time has whole seconds; compare at that precision, or a sign-in in the same second as "sign out everywhere" would count as revoked
  // (sessions that existed at that moment are revoked row by row anyway).
  const sec = (t: string) => Math.floor(new Date(t).getTime() / 1000) * 1000;
  let ok = !r.revoked_at && !(r.not_before && authMs < sec(r.not_before));
  if (ok && r.kill && s.role !== 'admin' && authMs < new Date(r.kill).getTime()) ok = false;   // strict: no row-by-row revocation backs it up
  cache.set(s.sid, { ok, until: Date.now() + 1000 });
  if (cache.size > 5000) cache.clear();
  return ok;
}
export const forgetSession = (sid?: string) => (sid ? cache.delete(sid) : cache.clear());
const forget = forgetSession;

/** Local log + an event, so Jisr writes the action into the audit chain with the admin's staff ID. */
async function adminLog(db: Db, admin: Staff, action: string, detail: Record<string, unknown>, subjects: string[] = []) {
  await tx(db, async (c) => {
    await c.query('INSERT INTO admin_actions (admin, action, detail) VALUES ($1,$2,$3)', [admin.subject, action, detail]);
    await emitEvent(c, 'mithaq.admin.action', { subjects, correlationId: `adm-${randomId(8)}`, data: { action, actor: admin.tag, ...detail } });
  });
}

export function registerSessions(app: FastifyInstance, db: Db): void {
  setSessionValidator((s) => sessionIsValid(db, s));

  // Called by the gateway (nginx auth_request) for every API request. Not routed publicly.
  app.get('/internal/session-check', { schema: { hide: true }, logLevel: 'warn' }, async (req, reply) => {
    const s = await verifySessionToken(req);
    if (!s) return reply.status(204).send(); // anonymous or expired token: let the service decide
    return (await sessionIsValid(db, s)) ? reply.status(204).send() : reply.status(401).send();
  });

  const tags = ['sessions'];
  const view = (r: any, current: string) => ({
    sid_hint: `${r.sid.slice(0, 6)}…`, id: r.sid, current: r.sid === current, created_at: r.created_at, auth_time: r.auth_time,
    expires_at: r.expires_at, last_refreshed_at: r.last_refreshed_at, user_agent: r.user_agent, amr: r.amr,
  });

  app.get('/api/identity/me/sessions', { schema: { tags, security: [{ session: [] }], summary: 'My active sessions (devices / browsers)' } }, async (req) => {
    const s = await requireSession(req);
    const { rows } = await db.query(
      `SELECT s.* FROM sessions s JOIN accounts a ON a.subject = s.subject
       WHERE s.subject = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND (a.sessions_not_before IS NULL OR s.auth_time >= a.sessions_not_before)
       ORDER BY s.created_at DESC`, [s.sub]);
    return { sessions: rows.map((r) => view(r, s.sid)) };
  });

  app.delete('/api/identity/me/sessions/:id', { schema: { tags, security: [{ session: [] }], summary: 'Sign out one of my sessions (e.g. a lost phone)' } }, async (req, reply) => {
    const s = await requireSession(req);
    const { id } = req.params as { id: string };
    const r = await db.query("UPDATE sessions SET revoked_at = now(), revoked_by = $2, revoked_reason = 'signed_out_by_user' WHERE sid = $1 AND subject = $2 AND revoked_at IS NULL", [id, s.sub]);
    if (!r.rowCount) throw httpError(404, 'not_found', 'No such active session');
    forget(id);
    if (id === s.sid) reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/identity/me/sessions/sign-out-everywhere', { schema: { tags, security: [{ session: [] }], summary: 'Sign out on every device, including this one' } }, async (req, reply) => {
    const s = await requireSession(req);
    await db.query('UPDATE accounts SET sessions_not_before = now() WHERE subject = $1', [s.sub]);
    await db.query("UPDATE sessions SET revoked_at = now(), revoked_by = $1, revoked_reason = 'sign_out_everywhere' WHERE subject = $1 AND revoked_at IS NULL", [s.sub]);
    await revokeAppDevices(db, s.sub, 'sign_out_everywhere');
    forget();
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // ---- Admin ----
  app.get('/api/identity/admin/sessions', { schema: { tags: ['admin'], security: [{ session: [] }], summary: 'Active sessions by role, recent sign-ins, kill-switch state (admin)' } }, async (req) => {
    await requireSession(req, ['admin']);
    const { rows: counts } = await db.query("SELECT role, count(*)::int AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > now() GROUP BY role");
    const { rows: recent } = await db.query('SELECT sid, subject, role, amr, created_at, expires_at, revoked_at, revoked_reason FROM sessions ORDER BY created_at DESC LIMIT 30');
    const kill = (await db.query("SELECT value FROM settings WHERE key = 'kill_switch_not_before'")).rows[0]?.value ?? null;
    const { rows: actions } = await db.query('SELECT admin, action, detail, at FROM admin_actions ORDER BY id DESC LIMIT 20');
    return { active_by_role: counts, recent: recent.map((r) => ({ ...r, sid: `${r.sid.slice(0, 6)}…` })), kill_switch_not_before: kill, admin_actions: actions };
  });

  app.post('/api/identity/admin/subjects/:subject/revoke-sessions', { schema: { tags: ['admin'], security: [{ session: [] }], summary: 'Sign one person out of every session (e.g. a stolen device) (admin)' } }, async (req) => {
    const a = await requireStaff(db, req, 'sessions.admin');
    const { subject } = req.params as { subject: string };
    const r = await db.query('UPDATE accounts SET sessions_not_before = now() WHERE subject = $1', [subject]);
    if (!r.rowCount) throw httpError(404, 'not_found', 'No such account');
    await db.query("UPDATE sessions SET revoked_at = now(), revoked_by = $2, revoked_reason = 'admin_revoked' WHERE subject = $1 AND revoked_at IS NULL", [subject, a.subject]);
    await revokeAppDevices(db, subject, 'admin_revoked');
    forget();
    await adminLog(db, a, 'revoke_sessions', { subject }, [subject]);
    return { ok: true };
  });

  app.post('/api/identity/admin/kill-switch', {
    schema: { tags: ['admin'], security: [{ session: [] }], summary: 'Emergency: sign out EVERY citizen and employee session now (admins stay signed in) (admin)',
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' }, not_before: { type: 'string', format: 'date-time', description: 'Sessions signed in before this instant no longer work' } } }, 401: S.error, 403: S.error } },
  }, async (req) => {
    const a = await requireStaff(db, req, 'sessions.admin');
    const at = new Date().toISOString();
    await db.query("INSERT INTO settings (key, value) VALUES ('kill_switch_not_before', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()", [at]);
    forget();
    await adminLog(db, a, 'kill_switch', { at });
    return { ok: true, not_before: at };
  });
}
