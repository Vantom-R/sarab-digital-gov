// Assisted channel: a service-centre employee serves a citizen who is present at the counter.
//
//  1. The employee starts a counter session for a national ID.
//  2. A 6-digit code is sent to the citizen (by Telegram, like every code); the citizen reads it out.
//     Without it the employee can do nothing — an employee cannot open anyone's file on their own.
//  3. For 20 minutes the employee can act for that citizen only. Every action:
//       * goes through Jisr with purpose "assisted-service" and on_behalf_of "employee:<employee ID>",
//         carrying a Mithaq-signed act-as token that Jisr and the target both verify,
//       * is written to Mithaq's assisted_actions log with the employee ID,
//       * is announced to the citizen's inbox over the event bus.
import { randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '#shared/db.ts';
import { tx } from '#shared/db.ts';
import { httpError } from '#shared/http.ts';
import { jisrCall } from '#shared/jisr.ts';
import { randomId, sha256hex } from '#shared/crypto.ts';
import { requireSession } from '#shared/session.ts';
import { issueActToken, employeeTag } from '#shared/delegation.ts';
import { emitEvent } from '#shared/events.ts';
import { isValidNationalId } from '#shared/seed.ts';
import type { Bilingual } from '#shared/catalog.ts';
import type { CivilRecord } from './citizen.ts';
import { createDelegation } from './delegations.ts';
import { requireStaff, type Staff } from './staff.ts';
import { deliverCode } from './codes.ts';

const SESSION_MINUTES = 20;
const ASSISTED_SCOPES = ['record.view', 'assets.view', 'vehicles.renew', 'delegation.record'];

type Employee = Staff;

/** Anyone with the "counter" permission: service-centre employees, and the administrator. */
const employee = (db: Db, req: FastifyRequest): Promise<Employee> => requireStaff(db, req, 'counter');

/** The employee's ACTIVE counter session, or 403. */
async function activeSession(db: Db, emp: Employee, id: string) {
  const r = (await db.query('SELECT * FROM assisted_sessions WHERE id = $1 AND employee = $2', [id, emp.subject])).rows[0];
  if (!r) throw httpError(404, 'not_found', 'No such counter session');
  if (r.status !== 'active') throw httpError(403, 'counter_session_inactive', `This counter session is ${r.status}`);
  if (new Date(r.expires_at).getTime() < Date.now()) {
    await expireCounterSessions(db, id);
    throw httpError(403, 'counter_session_inactive', 'This counter session has expired');
  }
  return r;
}

/**
 * Counter sessions end by themselves: an open session past its 20 minutes is closed and logged as
 * "session.expired" (shown as "Session expired"), at the moment it expired, and the citizen's inbox is told.
 * A code that was never confirmed just lapses (nothing was opened, so nothing is logged).
 * Runs every minute, and at once when an employee touches an expired session. Returns how many it closed.
 */
export async function expireCounterSessions(db: Db, onlyId?: string): Promise<number> {
  return tx(db, async (c) => {
    await c.query("UPDATE assisted_sessions SET status = 'ended', ended_at = expires_at WHERE status = 'pending' AND expires_at < now() AND ($1::text IS NULL OR id = $1)", [onlyId ?? null]);
    const { rows } = await c.query(
      `UPDATE assisted_sessions s SET status = 'ended', ended_at = s.expires_at
       FROM accounts a WHERE a.subject = s.employee AND s.status = 'active' AND s.expires_at < now() AND ($1::text IS NULL OR s.id = $1)
       RETURNING s.id, s.citizen, s.employee_id, s.expires_at, a.centre`, [onlyId ?? null]);
    for (const r of rows) {
      const detail = { reason: 'timeout', minutes: SESSION_MINUTES, expired_at: r.expires_at };
      await c.query('INSERT INTO assisted_actions (assisted_session_id, employee_id, citizen, action, detail, at) VALUES ($1,$2,$3,$4,$5,$6)', [r.id, r.employee_id, r.citizen, 'session.expired', detail, r.expires_at]);
      await emitEvent(c, 'mithaq.assisted.action', { subjects: [r.citizen], correlationId: r.id, data: { action: 'session.expired', employee_id: r.employee_id, centre: r.centre, actor: employeeTag(r.employee_id), ...detail } });
    }
    return rows.length;
  });
}

/** Closes expired counter sessions every minute (see expireCounterSessions). */
export function startCounterExpiry(db: Db, log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void }): void {
  const run = () => expireCounterSessions(db).then((n) => { if (n) log.info({ n }, 'counter sessions expired'); }).catch((err) => log.error({ err }, 'counter expiry failed'));
  run();
  setInterval(run, 60_000).unref();
}

async function logAction(db: Db, emp: Employee, sessionId: string, citizen: string, action: string, detail: Record<string, unknown> = {}) {
  await tx(db, async (c) => {
    await c.query('INSERT INTO assisted_actions (assisted_session_id, employee_id, citizen, action, detail) VALUES ($1,$2,$3,$4,$5)', [sessionId, emp.employee_id, citizen, action, detail]);
    await emitEvent(c, 'mithaq.assisted.action', { subjects: [citizen], correlationId: sessionId, data: { action, employee_id: emp.employee_id, centre: emp.centre, actor: emp.tag, ...detail } });
  });
}

/** Jisr call on behalf of the citizen at the counter, carrying a Mithaq-signed act-as token for the employee. */
async function assistedCall<T>(emp: Employee, citizen: string, sessionId: string, call: { target: string; method: 'GET' | 'POST'; path: string; body?: unknown }) {
  const act = await issueActToken({ grantor: citizen, delegate: emp.employee_id, kind: 'employee', scopes: ASSISTED_SCOPES, delegationId: sessionId, audience: call.target });
  return jisrCall<T>({ ...call, purpose: 'assisted-service', subject: citizen, onBehalfOf: employeeTag(emp.employee_id), act });
}

/** What a counter action list can be filtered by. Dates are calendar days in Riyadh time, inclusive. */
const actionQuery = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 }, offset: { type: 'integer', minimum: 0, default: 0 },
    employee: { type: 'string', maxLength: 20 }, citizen: { type: 'string', maxLength: 10 }, action: { type: 'string', maxLength: 40 },
    from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' },
  },
} as const;
interface ActionQuery { limit: number; offset: number; employee?: string; citizen?: string; action?: string; from?: string; to?: string }

async function listActions(db: Db, q: ActionQuery) {
  const where = `($1::text IS NULL OR a.employee_id = $1) AND ($2::text IS NULL OR a.citizen = $2) AND ($3::text IS NULL OR a.action = $3)
    AND ($4::date IS NULL OR a.at >= ($4::date)::timestamp AT TIME ZONE 'Asia/Riyadh')
    AND ($5::date IS NULL OR a.at < ($5::date + 1)::timestamp AT TIME ZONE 'Asia/Riyadh')`;
  const args = [q.employee?.trim() || null, q.citizen?.trim() || null, q.action?.trim() || null, q.from ?? null, q.to ?? null];
  const [{ rows }, { rows: [{ n }] }] = await Promise.all([
    db.query(`SELECT a.id, a.assisted_session_id, a.employee_id, a.citizen, a.action, a.detail, a.at, s.employee, (acc.kind = 'staff' AND acc.automated) AS automated
              FROM assisted_actions a JOIN assisted_sessions s ON s.id = a.assisted_session_id LEFT JOIN accounts acc ON acc.subject = s.employee
              WHERE ${where} ORDER BY a.at DESC, a.id DESC LIMIT $6 OFFSET $7`, [...args, q.limit, q.offset]),
    db.query(`SELECT count(*)::int AS n FROM assisted_actions a WHERE ${where}`, args),
  ]);
  return { total: n, offset: q.offset, limit: q.limit, actions: rows.map((r) => ({ ...r, id: Number(r.id), automated: !!r.automated })) };
}

export function registerCounter(app: FastifyInstance, db: Db): void {
  const tags = ['service centre (employees)'];

  app.get('/api/identity/counter/me', { schema: { tags, security: [{ session: [] }], summary: 'The signed-in employee and their open counter sessions' } }, async (req) => {
    const emp = await employee(db, req);
    const { rows } = await db.query("SELECT id, citizen, status, created_at, confirmed_at, expires_at FROM assisted_sessions WHERE employee = $1 AND status <> 'ended' AND expires_at > now() ORDER BY created_at DESC", [emp.subject]);
    return { employee: { employee_id: emp.employee_id, centre: emp.centre, name: emp.name }, open_sessions: rows };
  });

  app.post('/api/identity/counter/sessions', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags, security: [{ session: [] }], summary: 'Start serving a citizen: a confirmation code is sent to the citizen (by Telegram); the employee never sees it',
      body: { type: 'object', required: ['national_id'], properties: { national_id: { type: 'string', maxLength: 10 } } },
    },
  }, async (req, reply) => {
    const emp = await employee(db, req);
    const { national_id } = req.body as { national_id: string };
    if (!isValidNationalId(national_id) || !(await db.query("SELECT 1 FROM accounts WHERE subject = $1 AND kind = 'citizen'", [national_id])).rowCount) {
      throw httpError(404, 'citizen_not_found', 'No citizen with that national ID');
    }
    const id = `CS-${randomId(6)}`;
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const sent = await tx(db, async (c) => {
      const { rows: [r] } = await c.query(
        "INSERT INTO assisted_sessions (id, employee, employee_id, citizen, status, code_hash, expires_at) VALUES ($1,$2,$3,$4,'pending',$5, now() + interval '5 minutes') RETURNING expires_at",
        [id, emp.subject, emp.employee_id, national_id, sha256hex(`${id}:${code}`)],
      );
      return deliverCode(c, req, {
        key: `counter:${national_id}`, template: 'counter', code, expires_at: r.expires_at,
        national_id, employee_id: emp.employee_id,
        centre: emp.centre ?? { en: 'a service centre', ar: 'مركز خدمة' },
      });
    }).catch((e) => {
      if (e?.statusCode === 429 && e.details?.retry_after) reply.header('retry-after', String(e.details.retry_after));
      throw e;
    });
    // The employee only learns that the code was sent (test runs get it as test_code).
    return { id, status: 'pending', sent: true, ...sent };
  });

  app.post('/api/identity/counter/sessions/:id/confirm', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags, security: [{ session: [] }], summary: 'Enter the code the citizen received — opens a 20-minute counter session',
      body: { type: 'object', required: ['code'], properties: { code: { type: 'string', pattern: '^\\d{6}$' } } },
    },
  }, async (req) => {
    const emp = await employee(db, req);
    const { id } = req.params as { id: string };
    const { code } = req.body as { code: string };
    // Count the attempt first (atomically): at most 5 tries, even in parallel.
    const r = (await db.query(
      "UPDATE assisted_sessions SET attempts = attempts + 1 WHERE id = $1 AND employee = $2 AND status = 'pending' AND expires_at > now() AND attempts < 5 RETURNING *",
      [id, emp.subject])).rows[0];
    if (!r) throw httpError(401, 'otp_expired', 'The code has expired or too many wrong codes were entered. Start again.');
    if (r.code_hash !== sha256hex(`${id}:${code}`)) throw httpError(401, 'otp_invalid', 'The code is incorrect');
    // Single use: only one request can move it from pending to active.
    const ok = await db.query(`UPDATE assisted_sessions SET status = 'active', confirmed_at = now(), expires_at = now() + interval '${SESSION_MINUTES} minutes' WHERE id = $1 AND status = 'pending'`, [id]);
    if (ok.rowCount !== 1) throw httpError(401, 'otp_expired', 'The code has already been used. Start again.');
    await logAction(db, emp, id, r.citizen, 'session.opened');
    return { id, status: 'active', citizen: r.citizen, minutes: SESSION_MINUTES };
  });

  app.get('/api/identity/counter/sessions/:id/record', { schema: { tags, security: [{ session: [] }], summary: 'The citizen’s civil record (at the counter)' } }, async (req) => {
    const emp = await employee(db, req);
    const cs = await activeSession(db, emp, (req.params as { id: string }).id);
    const record = await assistedCall<CivilRecord>(emp, cs.citizen, cs.id, { target: 'civil-registry', method: 'GET', path: `/x/persons/${cs.citizen}` });
    await logAction(db, emp, cs.id, cs.citizen, 'record.viewed');
    return { session: { id: cs.id, citizen: cs.citizen, expires_at: cs.expires_at }, record };
  });

  app.get('/api/identity/counter/sessions/:id/assets', { schema: { tags, security: [{ session: [] }], summary: 'The citizen’s vehicles and properties (at the counter)' } }, async (req) => {
    const emp = await employee(db, req);
    const cs = await activeSession(db, emp, (req.params as { id: string }).id);
    const assets = await assistedCall(emp, cs.citizen, cs.id, { target: 'property', method: 'GET', path: `/x/persons/${cs.citizen}/assets` });
    await logAction(db, emp, cs.id, cs.citizen, 'assets.viewed');
    return assets;
  });

  app.post('/api/identity/counter/sessions/:id/vehicles/:plate/renew', { schema: { tags, security: [{ session: [] }], summary: 'Renew the citizen’s vehicle registration (at the counter)' } }, async (req) => {
    const emp = await employee(db, req);
    const { id, plate } = req.params as { id: string; plate: string };
    const cs = await activeSession(db, emp, id);
    const r = await assistedCall<any>(emp, cs.citizen, cs.id, { target: 'property', method: 'POST', path: `/x/vehicles/${encodeURIComponent(plate)}/renewals` });
    await logAction(db, emp, cs.id, cs.citizen, 'vehicle.renewed', { plate, new_expiry: r.new_expiry });
    return r;
  });

  app.post('/api/identity/counter/sessions/:id/delegations', {
    schema: {
      tags, security: [{ session: [] }], summary: 'Record a delegation for a citizen who does not use the portal (e.g. elderly Saleh → his son)',
      body: {
        type: 'object', required: ['delegate_id', 'scopes', 'days'],
        properties: { delegate_id: { type: 'string', maxLength: 10 }, scopes: { type: 'array', items: { type: 'string' }, minItems: 1 }, days: { type: 'integer', minimum: 1, maximum: 365 } },
      },
    },
  }, async (req) => {
    const emp = await employee(db, req);
    const cs = await activeSession(db, emp, (req.params as { id: string }).id);
    const b = req.body as { delegate_id: string; scopes: string[]; days: number };
    // The grantor's name for the mandate comes from the registry (read as part of this counter session).
    const rec = await assistedCall<CivilRecord>(emp, cs.citizen, cs.id, { target: 'civil-registry', method: 'GET', path: `/x/persons/${cs.citizen}` });
    const d = await createDelegation(db, {
      grantor: cs.citizen, grantorName: { ar: `${rec.given_name.ar} ${rec.family_name.ar}`, en: `${rec.given_name.en} ${rec.family_name.en}` },
      delegate: b.delegate_id.trim(), scopes: b.scopes, days: b.days, via: 'service-centre', employee: emp.employee_id,
    });
    await logAction(db, emp, cs.id, cs.citizen, 'delegation.recorded', { delegation_id: d.id, delegate: d.delegate, scopes: b.scopes });
    return d;
  });

  app.post('/api/identity/counter/sessions/:id/end', { schema: { tags, security: [{ session: [] }], summary: 'Finish serving the citizen' } }, async (req) => {
    const emp = await employee(db, req);
    const { id } = req.params as { id: string };
    const r = (await db.query("UPDATE assisted_sessions SET status = 'ended', ended_at = now() WHERE id = $1 AND employee = $2 AND status <> 'ended' RETURNING citizen", [id, emp.subject])).rows[0];
    if (r) await logAction(db, emp, id, r.citizen, 'session.ended');
    return { ok: true };
  });

  app.get('/api/identity/counter/actions', {
    schema: { tags, security: [{ session: [] }], summary: 'My counter actions, newest first, with filters and paging (employee)', querystring: actionQuery },
  }, async (req) => {
    const emp = await employee(db, req);
    return listActions(db, { ...(req.query as ActionQuery), employee: emp.employee_id });
  });

  // ---- Oversight ----
  app.get('/api/identity/admin/assisted-actions', {
    schema: { tags: ['admin'], security: [{ session: [] }], summary: 'Every assisted-channel action by employee ID, newest first, with filters and paging (admin)', querystring: actionQuery },
  }, async (req) => {
    await requireSession(req, ['admin']);
    return listActions(db, req.query as ActionQuery);
  });

  // Citizens can see every counter action taken for them.
  app.get('/api/identity/me/assisted-actions', { schema: { tags: ['citizen'], security: [{ session: [] }], summary: 'Service-centre actions taken for me' } }, async (req) => {
    const s = await requireSession(req, ['citizen']);
    const { rows } = await db.query(
      `SELECT a.id, a.employee_id, acc.centre, a.action, a.detail, a.at FROM assisted_actions a
       JOIN assisted_sessions s ON s.id = a.assisted_session_id JOIN accounts acc ON acc.subject = s.employee
       WHERE a.citizen = $1 ORDER BY a.id DESC LIMIT 100`, [s.sub]);
    return { actions: rows.map((r) => ({ ...r, id: Number(r.id) })) };
  });
}
