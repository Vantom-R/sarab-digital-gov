// Registering a new adult citizen (naturalisation / missing from the registry) + first-time activation.
//
//  Registrar (employee or admin, permission "registry.register")
//    → Mithaq → Jisr (purpose civil-registration, on_behalf_of "employee:<staff ID>") → Civil Registry
//      allocates the national ID, links the family, emits registry.person.registered (actor = staff ID).
//    → Mithaq creates a sign-in account WITHOUT a password and issues a one-time activation code, sent by
//      Telegram like every code in Sarab (event mithaq.activation.issued, actor = staff ID). Both events land
//      in Jisr's audit chain. The registrar only learns that the code was sent.
//  New citizen at /activate: national ID + activation code → choose a password → signed in → add a passkey.
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Db } from '#shared/db.ts';
import { tx } from '#shared/db.ts';
import { httpError, S } from '#shared/http.ts';
import { jisrCall } from '#shared/jisr.ts';
import { hashPassword, randomId, sha256hex } from '#shared/crypto.ts';
import { emitEvent } from '#shared/events.ts';
import { CITIES, DISTRICTS, isValidNationalId } from '#shared/seed.ts';
import { requireSession } from '#shared/session.ts';

const ORIGIN = process.env.PUBLIC_ORIGIN ?? 'http://localhost:18090';
import { PERMISSIONS, permissionsOf, requireStaff, type Staff } from './staff.ts';
import { deliverCode } from './codes.ts';

const ACTIVATION_DAYS = 7;
const MAX_ATTEMPTS = 5;
const authLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** Issue (or re-issue) a one-time activation code and send it (Telegram). Any previous code stops working.
 *  Returns only that it was sent — never the code (automated tests get it as test_code). */
async function issueActivation(db: Db, req: any, staff: Staff, nationalId: string) {
  const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
  return tx(db, async (c) => {
    const row = (await c.query(
      `INSERT INTO activation_codes (subject, code_hash, attempts, expires_at, issued_by, issued_at, token_hash, token_expires_at)
       VALUES ($1, $2, 0, now() + make_interval(days => $3), $4, now(), NULL, NULL)
       ON CONFLICT (subject) DO UPDATE SET code_hash = $2, attempts = 0, expires_at = now() + make_interval(days => $3), issued_by = $4, issued_at = now(), token_hash = NULL, token_expires_at = NULL
       RETURNING expires_at`,
      [nationalId, sha256hex(`${nationalId}:${code}`), ACTIVATION_DAYS, staff.employee_id],
    )).rows[0];
    await emitEvent(c, 'mithaq.activation.issued', { subjects: [nationalId], correlationId: `act-${randomId(8)}`, data: { actor: staff.tag, expires_at: row.expires_at } });
    const sent = await deliverCode(c, req, {
      key: `activation:${nationalId}`, template: 'activation', code: `${code.slice(0, 4)} ${code.slice(4)}`, expires_at: row.expires_at,
      national_id: nationalId, employee_id: staff.employee_id,
    });
    return { sent: true, sent_via: 'telegram', expires_at: row.expires_at, ...sent };
  });
}

export function registerRegistration(app: FastifyInstance, db: Db, startSession: (reply: any, req: any, subject: string, amr: string[]) => Promise<any>): void {
  const tags = ['civil registration (staff)'];

  // ---- What the signed-in staff member may do (the portal shows only those tools) ----
  app.get('/api/identity/staff/me', { schema: { tags: ['staff'], security: [{ session: [] }], summary: 'The signed-in staff member and their permissions' } }, async (req) => {
    const s = await requireSession(req, ['employee', 'admin']);
    const a = (await db.query('SELECT employee_id, centre, staff_name_ar, staff_name_en FROM accounts WHERE subject = $1', [s.sub])).rows[0];
    const permissions = permissionsOf(s.role);
    return {
      employee_id: a?.employee_id, role: s.role, centre: a?.centre, name: { ar: a?.staff_name_ar, en: a?.staff_name_en },
      permissions: permissions.map((p) => ({ permission: p, label: PERMISSIONS[p] })),
    };
  });

  app.get('/api/identity/registry/options', { schema: { tags, security: [{ session: [] }], summary: 'Choices for the registration form (cities, districts, reasons)' } }, async (req) => {
    await requireStaff(db, req, 'registry.register');
    return {
      cities: CITIES.map((c, i) => ({ index: i, name: c })),
      districts: DISTRICTS.map((d, i) => ({ index: i, name: d })),
      reasons: ['naturalization', 'missing-record'],
    };
  });

  app.post('/api/identity/registry/persons', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { tags, security: [{ session: [] }], summary: 'Register a new adult citizen: the Civil Registry allocates the national ID; Mithaq issues an activation code' },
  }, async (req, reply) => {
    const staff = await requireStaff(db, req, 'registry.register');
    // The Civil Registry validates the details; Jisr records who asked (on_behalf_of = this staff member).
    const person = await jisrCall<any>({
      target: 'civil-registry', method: 'POST', path: '/x/persons', purpose: 'civil-registration',
      onBehalfOf: staff.tag, body: req.body,
    });
    if (!isValidNationalId(person?.national_id)) throw httpError(502, 'bad_gateway', 'The Civil Registry returned no national ID');
    await db.query(
      `INSERT INTO accounts (subject, kind, role, password_hash, webauthn_user_id) VALUES ($1, 'citizen', 'citizen', NULL, $2) ON CONFLICT (subject) DO NOTHING`,
      [person.national_id, randomBytes(16).toString('base64url')],
    );
    await db.query('INSERT INTO staff_registrations (national_id, staff_subject, employee_id, reason) VALUES ($1,$2,$3,$4)',
      [person.national_id, staff.subject, staff.employee_id, (req.body as any)?.reason ?? null]);
    // If the code cannot be sent (Telegram down), the person and account exist; staff can use "Issue a new code".
    const activation = await issueActivation(db, req, staff, person.national_id)
      .catch((e) => ({ sent: false, error: e?.code ?? 'code_not_sent', retry_after: e?.details?.retry_after }));
    reply.status(201);
    return { person, activation };
  });

  app.get('/api/identity/registry/registrations', { schema: { tags, security: [{ session: [] }], summary: 'Recent registrations (mine; an administrator sees everyone’s) and whether each account is activated' } }, async (req) => {
    const staff = await requireStaff(db, req, 'registry.register');
    const { rows } = await db.query(
      `SELECT r.national_id, r.employee_id, r.reason, r.at, (a.password_hash IS NOT NULL) AS activated, ac.expires_at AS code_expires_at, ac.attempts
         FROM staff_registrations r JOIN accounts a ON a.subject = r.national_id LEFT JOIN activation_codes ac ON ac.subject = r.national_id
        WHERE $1 OR r.staff_subject = $2 ORDER BY r.at DESC LIMIT 50`,
      [staff.role === 'admin', staff.subject],
    );
    return { registrations: rows.map((r) => ({ ...r, locked: !r.activated && r.attempts >= MAX_ATTEMPTS })) };
  });

  app.post('/api/identity/registry/persons/:id/activation-code', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags, security: [{ session: [] }], summary: 'Issue a new activation code (the old one stops working) for a citizen who has not activated yet' },
  }, async (req) => {
    const staff = await requireStaff(db, req, 'registry.register');
    const { id } = req.params as { id: string };
    const acc = (await db.query("SELECT password_hash FROM accounts WHERE subject = $1 AND kind = 'citizen'", [id])).rows[0];
    if (!acc || !(await db.query('SELECT 1 FROM staff_registrations WHERE national_id = $1', [id])).rowCount) throw httpError(404, 'not_found', 'No registration for that national ID');
    if (acc.password_hash) throw httpError(409, 'already_activated', 'This account is already activated');
    return issueActivation(db, req, staff, id);
  });

  // ---- First-time activation by the citizen (public, rate limited) ----
  app.post('/api/identity/auth/activation/verify', {
    config: authLimit,
    schema: {
      tags: ['auth'], summary: 'Activation step 1: national ID + one-time activation code',
      body: { type: 'object', required: ['national_id', 'code'], properties: { national_id: { type: 'string', maxLength: 10 }, code: { type: 'string', maxLength: 12 } } },
      response: { 200: { type: 'object', properties: { activation_token: { type: 'string' }, expires_in: { type: 'integer' } } }, 401: S.error },
    },
  }, async (req) => {
    const { national_id, code } = req.body as { national_id: string; code: string };
    const nid = national_id.trim();
    const digits = code.replace(/\D/g, '');
    const generic = () => httpError(401, 'activation_invalid', 'The national ID or activation code is incorrect, or the code has expired');
    if (!isValidNationalId(nid) || digits.length !== 8) throw generic();
    // Count the attempt first (atomically): after 5 wrong codes the registrar must issue a new one.
    const row = (await db.query(
      `UPDATE activation_codes SET attempts = attempts + 1 WHERE subject = $1 AND expires_at > now() AND attempts < $2
       AND EXISTS (SELECT 1 FROM accounts WHERE subject = $1 AND password_hash IS NULL) RETURNING code_hash, attempts`, [nid, MAX_ATTEMPTS],
    )).rows[0];
    if (!row) {
      const locked = (await db.query('SELECT 1 FROM activation_codes WHERE subject = $1 AND attempts >= $2', [nid, MAX_ATTEMPTS])).rowCount;
      if (locked) throw httpError(401, 'activation_locked', 'Too many wrong codes. Ask a service centre for a new activation code.');
      throw generic();
    }
    if (!same(row.code_hash, sha256hex(`${nid}:${digits}`))) throw generic();
    const token = randomBytes(24).toString('base64url');
    await db.query("UPDATE activation_codes SET token_hash = $2, token_expires_at = now() + interval '15 minutes' WHERE subject = $1", [nid, sha256hex(token)]);
    return { activation_token: token, expires_in: 900 };
  });

  app.post('/api/identity/auth/activation/complete', {
    config: authLimit,
    schema: {
      tags: ['auth'], summary: 'Activation step 2: choose a password — the account is activated and you are signed in',
      body: { type: 'object', required: ['activation_token', 'password'], properties: { activation_token: { type: 'string', maxLength: 64 }, password: { type: 'string', maxLength: 200 } } },
      response: { 401: S.error, 422: S.error },
    },
  }, async (req, reply) => {
    const { activation_token, password } = req.body as { activation_token: string; password: string };
    const row = (await db.query('SELECT subject FROM activation_codes WHERE token_hash = $1 AND token_expires_at > now()', [sha256hex(activation_token)])).rows[0];
    if (!row) throw httpError(401, 'activation_expired', 'This activation step has expired. Enter your activation code again.');
    if (password.length < 10) throw httpError(422, 'password_too_short', 'Choose a password of at least 10 characters');
    if (password.includes(row.subject)) throw httpError(422, 'password_contains_id', 'The password must not contain your national ID');
    const hash = await hashPassword(password);
    const done = await tx(db, async (c) => {
      // Single use: the code row is deleted in the same transaction that sets the password.
      if (!(await c.query('DELETE FROM activation_codes WHERE subject = $1 AND token_hash = $2', [row.subject, sha256hex(activation_token)])).rowCount) return false;
      await c.query('UPDATE accounts SET password_hash = $2 WHERE subject = $1 AND password_hash IS NULL', [row.subject, hash]);
      await emitEvent(c, 'mithaq.account.activated', { subjects: [row.subject], correlationId: `act-${randomId(8)}`, data: {} });
      return true;
    });
    if (!done) throw httpError(401, 'activation_expired', 'This activation step has expired. Enter your activation code again.');
    return startSession(reply, req, row.subject, ['activation', 'pwd']);
  });
}
