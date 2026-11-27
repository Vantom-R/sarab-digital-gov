// Mithaq — digital identity: passkeys + fallback login, sessions, citizen key pairs,
// document signatures, and SD-JWT credential issuance for consented sharing.
import { randomInt, randomBytes, timingSafeEqual } from 'node:crypto';
const safeEqualHex = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
import rateLimit from '@fastify/rate-limit';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { CompactSign, compactVerify, decodeProtectedHeader, importJWK, type CryptoKey } from 'jose';
import { createService, start, httpError, S } from '#shared/http.ts';
import { createDb, migrate, tx } from '#shared/db.ts';
import { hashPassword, verifyPassword, loadOwnKey, randomId, sha256hex } from '#shared/crypto.ts';
import { installJisrGuard, requireJisr, jisrCall } from '#shared/jisr.ts';
import { issueSession, requireSession, readSession, setSessionCookie, SESSION_COOKIE, SESSION_MAX_SECONDS, type Role } from '#shared/session.ts';
import { issueSdJwt, presentSdJwt } from '#shared/sdjwt.ts';
import { CLAIMS, CREDENTIALS } from '#shared/catalog.ts';
import { population, isValidNationalId, PERSONAS } from '#shared/seed.ts';
import { readCivilRecord, fullName, claimsFromRecord, citizenKey, publicKeyByKid } from './citizen.ts';
import { deliverCode, hasTestTicket } from './codes.ts';
import { clearFailures, recordFailure, startThrottleCleanup, throttleTurn } from './throttle.ts';
import { initEvents, startOutboxPump } from '#shared/events.ts';
import { registerLifeEvents } from './life-events.ts';
import { registerDelegations } from './delegations.ts';
import { registerCounter, startCounterExpiry } from './counter.ts';
import { registerSessions, recordSession, forgetSession } from './sessions.ts';
import { registerApps, EXPECTED_ORIGINS, isStrongRecentSignIn } from './apps.ts';
import { registerDeviceKeys } from './device-keys.ts';
import { registerRegistration } from './registration.ts';
import { registerRecords } from './records.ts';
import { registerBirths } from './births.ts';
import { registerFeed, startFeedPump } from './feed.ts';

const RP_ID = process.env.RP_ID ?? 'localhost';
const ORIGIN = process.env.PUBLIC_ORIGIN ?? 'http://localhost:18090';
const RP_NAME = 'Mithaq — Republic of Sarab (demo)';

const db = createDb();
await migrate(db, new URL('./schema.sql', import.meta.url));
await initEvents(db);
const own = await loadOwnKey();

// ---------- Seed demo accounts (credentials only; civil data stays in the registry) ----------
// DEMO_MODE=true (local use): the sign-in page lists the demo citizens and their shared password.
// DEMO_MODE=false (production): nothing shows or serves the password; it is a random value kept in .env only.
const DEMO_MODE = process.env.DEMO_MODE === 'true';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? '';
if (DEMO_PASSWORD.length < 12) {
  throw new Error('DEMO_PASSWORD in .env must be a random value of 12+ characters. Run make init.');
}
{
  const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM accounts');
  if (n === 0) {
    const demo = await hashPassword(DEMO_PASSWORD);
    for (const p of population()) {
      await db.query(
        'INSERT INTO accounts (subject, kind, role, password_hash, webauthn_user_id) VALUES ($1, $2, $3, $4, $5)',
        [p.national_id, 'citizen', 'citizen', demo, randomBytes(16).toString('base64url')],
      );
    }
  } else {
    // The seeded citizens all share the demo password: when it changed in .env, apply the new one to all of them
    // (their accounts, sessions and data stay; only accounts that still hold the old shared password change).
    const ids = population().map((p) => p.national_id);
    const { rows: [probe] } = await db.query("SELECT password_hash FROM accounts WHERE subject = $1 AND kind = 'citizen'", [ids[0]]);
    if (probe?.password_hash && !(await verifyPassword(DEMO_PASSWORD, probe.password_hash))) {
      const r = await db.query("UPDATE accounts SET password_hash = $2 WHERE subject = ANY($1) AND kind = 'citizen' AND password_hash = $3",
        [ids, await hashPassword(DEMO_PASSWORD), probe.password_hash]);
      console.log(`demo password changed in .env: applied to ${r.rowCount} seeded citizen accounts`);
    }
  }
}

// Staff accounts and their credentials are (re)applied from .env on every start. Staff are never listed
// in the public demo data. Their second factor, like every one-time code in Sarab, is a code sent by
// Telegram (see codes.ts). (Rotate passwords by editing .env and restarting the identity container.)
const STAFF = [
  { username: 'admin', role: 'admin', name: { ar: 'مسؤول التدقيق', en: 'Audit administrator' }, employee_id: 'ADM-0001',
    centre: { ar: 'الإدارة المركزية', en: 'Central administration' }, password: process.env.ADMIN_PASSWORD },
  { username: 'clerk', role: 'employee', name: { ar: 'فهد الريمي', en: 'Fahad Al-Rimi' }, employee_id: 'EMP-1042',
    centre: { ar: 'مركز خدمة واحة النخيل', en: 'Wahat Al-Nakheel Service Centre' }, password: process.env.CLERK_PASSWORD },
  // Automated tests act as this account, never as the administrator, so the admin's own history stays theirs.
  // It holds every staff permission (the tests cover all of them) but can only sign in with a test ticket,
  // which needs shell access to this server (services/identity/src/test-ticket.ts).
  { username: 'test', role: 'admin', name: { ar: 'حساب الاختبارات الآلية', en: 'Automated test account' }, employee_id: 'TEST-0001',
    centre: { ar: 'الاختبارات الآلية (ليست أفعال موظف حقيقي)', en: 'Automated tests (not a real employee)' }, password: process.env.TEST_STAFF_PASSWORD, automated: true },
];
if (!process.env.NOTIFIER_URL) throw new Error('NOTIFIER_URL must be set: every one-time code is sent by Telegram');
for (const st of STAFF) {
  if (!st.password || st.password.length < 12) throw new Error(`password (12+ chars) for staff "${st.username}" must be set in .env`);
  await db.query(
    `INSERT INTO accounts (subject, kind, role, password_hash, staff_name_ar, staff_name_en, webauthn_user_id, employee_id, centre, second_factor, automated)
     VALUES ($1, 'staff', $2, $3, $4, $5, $6, $7, $8, 'telegram', $9)
     ON CONFLICT (subject) DO UPDATE SET role = $2, password_hash = $3, staff_name_ar = $4, staff_name_en = $5,
       employee_id = $7, centre = $8, second_factor = 'telegram', automated = $9`,
    [`staff:${st.username}`, st.role, await hashPassword(st.password), st.name.ar, st.name.en, randomBytes(16).toString('base64url'),
      st.employee_id, st.centre, !!st.automated],
  );
}

const app = await createService({
  prefix: 'identity',
  title: 'Mithaq — Digital Identity',
  description: 'Sign-in with passkeys (WebAuthn) or password + one-time code, sessions, citizen key pairs and digital signatures. `/x/*` routes are reachable only through Jisr.',
});
await app.register(rateLimit, { global: false });
await installJisrGuard(app);

const authLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };
const DUMMY_HASH = await hashPassword(randomId());

// ---------- helpers ----------

async function account(subject: string) {
  return (await db.query('SELECT * FROM accounts WHERE subject = $1', [subject])).rows[0];
}

async function startSession(reply: any, req: any, subject: string, amr: string[]) {
  const acc = await account(subject);
  if (!acc) throw httpError(401, 'invalid_credentials', 'Unknown account');
  let name;
  if (acc.kind === 'citizen') {
    // Name comes from the Civil Registry via Jisr (logged as "authentication").
    name = fullName(await readCivilRecord(subject, 'authentication'));
  } else {
    name = { ar: acc.staff_name_ar, en: acc.staff_name_en };
  }
  const { token, session } = await issueSession({ sub: subject, role: acc.role as Role, name, amr });
  await recordSession(db, session, req);
  await db.query('UPDATE accounts SET last_login_at = now() WHERE subject = $1', [subject]);
  setSessionCookie(reply, token);
  // Native apps (iOS/Android/desktop) ask for the token explicitly; browsers rely on the HttpOnly cookie.
  return { session, ...(req.headers['x-sarab-client'] === 'native' ? { token } : {}) };
}

const sessionSchema = {
  type: 'object',
  properties: {
    session: {
      type: 'object',
      properties: { sub: { type: 'string' }, role: { type: 'string' }, name: S.bilingual, amr: { type: 'array', items: { type: 'string' } }, auth_time: { type: 'integer' }, sid: { type: 'string' }, exp: { type: 'integer' } },
    },
    token: { type: 'string', description: 'Only when the request has header X-Sarab-Client: native' },
  },
} as const;

const resolveSubject = (username: string) => {
  const u = username.trim();
  if (isValidNationalId(u)) return u;
  if (/^[a-z][a-z0-9._-]{1,30}$/i.test(u)) return `staff:${u.toLowerCase()}`;
  return null;
};

// ---------- Fallback login: password + one-time code ----------

app.post('/api/identity/auth/password', {
  config: authLimit,
  schema: {
    tags: ['auth'], summary: 'Step 1 of fallback sign-in: national ID (or staff username) + password',
    body: { type: 'object', required: ['username', 'password'], properties: { username: { type: 'string', maxLength: 64 }, password: { type: 'string', maxLength: 200 } } },
    response: {
      200: {
        type: 'object',
        properties: {
          otp_challenge_id: { type: 'string' },
          method: { type: 'string', enum: ['telegram'], description: 'The 6-digit code is sent by Telegram (every one-time code in Sarab is)' },
          test_code: { type: 'string', description: 'Only for automated tests holding a server-issued test ticket' },
          test_message: { type: 'string', description: 'Only for automated tests: the text that would have been sent' },
        },
      },
      401: S.error, 429: S.error, 503: S.error,
    },
  },
}, async (req, reply) => {
  const { username, password } = req.body as { username: string; password: string };
  const subject = resolveSubject(username);
  // Per-account brake (throttle.ts): after 5 wrong passwords every attempt waits its turn, 1–5 s. Never a lock.
  if (subject) {
    const wait = await throttleTurn(db, subject).catch((e) => {
      if (e?.statusCode === 429 && e.details?.retry_after) reply.header('retry-after', String(e.details.retry_after));
      throw e;
    });
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  const acc = subject ? await account(subject) : null;
  // Unknown accounts take as long as known ones (a dummy scrypt), so timing does not reveal who exists.
  const ok = await verifyPassword(password, acc?.password_hash ?? DUMMY_HASH);
  // The automated-test account answers like a wrong password unless the request carries a test ticket.
  if (!acc?.password_hash || !ok || (acc.automated && !(await hasTestTicket(db, req)))) {
    if (subject) await recordFailure(db, subject);
    throw httpError(401, 'invalid_credentials', 'National ID or password is incorrect');
  }
  await clearFailures(db, subject!);
  // Everyone (citizens and staff) gets a 6-digit code by Telegram. A new code replaces any earlier one.
  const id = randomId();
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const staff = acc.kind === 'staff';
  const sent = await tx(db, async (c) => {
    await c.query("DELETE FROM challenges WHERE kind = 'otp' AND subject = $1", [subject]);
    const { rows: [ch] } = await c.query(
      "INSERT INTO challenges (id, kind, subject, secret, expires_at) VALUES ($1, 'otp', $2, $3, now() + interval '5 minutes') RETURNING expires_at",
      [id, subject, sha256hex(`${id}:${code}`)]);
    return deliverCode(c, req, staff
      ? { key: `login:${subject}`, template: 'staff-login', code, expires_at: ch.expires_at, username: subject!.slice(6), employee_id: acc.employee_id }
      : { key: `login:${subject}`, template: 'login', code, expires_at: ch.expires_at, national_id: subject! });
  }).catch((e) => {
    if (e?.statusCode === 429 && e.details?.retry_after) reply.header('retry-after', String(e.details.retry_after));
    throw e;
  });
  return { otp_challenge_id: id, method: 'telegram', ...sent };
});

app.post('/api/identity/auth/otp', {
  config: authLimit,
  schema: {
    tags: ['auth'], summary: 'Step 2 of fallback sign-in: the one-time code',
    body: { type: 'object', required: ['otp_challenge_id', 'code'], properties: { otp_challenge_id: { type: 'string' }, code: { type: 'string', pattern: '^\\d{6}$' } } },
    response: { 200: sessionSchema, 401: S.error },
  },
}, async (req, reply) => {
  const { otp_challenge_id, code } = req.body as { otp_challenge_id: string; code: string };
  // Count the attempt BEFORE checking the code (atomically), so parallel guesses cannot exceed 5.
  const ch = (await db.query(
    "UPDATE challenges SET attempts = attempts + 1 WHERE id = $1 AND kind = 'otp' AND expires_at > now() AND attempts < 5 RETURNING *", [otp_challenge_id],
  )).rows[0];
  if (!ch) throw httpError(401, 'otp_expired', 'The code has expired or too many wrong codes were entered. Please start again.');
  if (!safeEqualHex(ch.secret, sha256hex(`${otp_challenge_id}:${code}`))) {
    throw httpError(401, 'otp_invalid', 'The code is incorrect');
  }
  // Single use: only one request can delete the challenge.
  if ((await db.query('DELETE FROM challenges WHERE id = $1', [otp_challenge_id])).rowCount !== 1) {
    throw httpError(401, 'otp_expired', 'The code has expired. Please start again.');
  }
  return startSession(reply, req, ch.subject, ['pwd', 'otp']);
});

// ---------- Passkey login (usernameless / discoverable credentials) ----------

app.post('/api/identity/auth/passkey/options', {
  config: authLimit,
  schema: { tags: ['auth'], summary: 'Get WebAuthn options to sign in with a passkey' },
}, async () => {
  const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: 'preferred', allowCredentials: [] });
  const id = randomId();
  await db.query("INSERT INTO challenges (id, kind, secret, expires_at) VALUES ($1, 'webauthn-login', $2, now() + interval '5 minutes')", [id, options.challenge]);
  return { challenge_id: id, options };
});

app.post('/api/identity/auth/passkey/verify', {
  config: authLimit,
  schema: {
    tags: ['auth'], summary: 'Verify a passkey assertion and start a session',
    body: { type: 'object', required: ['challenge_id', 'response'], properties: { challenge_id: { type: 'string' }, response: { type: 'object', additionalProperties: true } } },
    response: { 200: sessionSchema, 401: S.error },
  },
}, async (req, reply) => {
  const { challenge_id, response } = req.body as { challenge_id: string; response: any };
  const ch = (await db.query("DELETE FROM challenges WHERE id = $1 AND kind = 'webauthn-login' AND expires_at > now() RETURNING secret", [challenge_id])).rows[0];
  if (!ch) throw httpError(401, 'challenge_expired', 'Sign-in request expired. Please try again.');
  const cred = (await db.query('SELECT * FROM passkeys WHERE credential_id = $1', [response?.id])).rows[0];
  if (!cred) throw httpError(401, 'unknown_passkey', 'This passkey is not registered with Mithaq');
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response, expectedChallenge: ch.secret, expectedOrigin: EXPECTED_ORIGINS, expectedRPID: RP_ID, requireUserVerification: false,
      credential: { id: cred.credential_id, publicKey: new Uint8Array(cred.public_key), counter: Number(cred.counter), transports: cred.transports },
    });
  } catch (e) {
    throw httpError(401, 'passkey_invalid', (e as Error).message);
  }
  if (!result.verified) throw httpError(401, 'passkey_invalid', 'Passkey could not be verified');
  await db.query('UPDATE passkeys SET counter = $2, last_used_at = now() WHERE credential_id = $1', [cred.credential_id, result.authenticationInfo.newCounter]);
  return startSession(reply, req, cred.subject, result.authenticationInfo.userVerified ? ['hwk', 'user'] : ['hwk']);
});

// ---------- Session ----------

app.get('/api/identity/session', { schema: { tags: ['auth'], summary: 'Current session', security: [{ session: [] }], response: { 200: sessionSchema, 401: S.error } } }, async (req) => {
  return { session: await requireSession(req) };
});

app.post('/api/identity/session/refresh', {
  schema: {
    tags: ['auth'], security: [{ session: [] }],
    summary: '"Stay signed in": extend the current session by 30 minutes (same session id and sign-in time; at most 12 hours after sign-in)',
    response: { 200: sessionSchema, 401: S.error },
  },
}, async (req, reply) => {
  const s = await requireSession(req);
  if (Date.now() / 1000 - s.auth_time > SESSION_MAX_SECONDS - 60) throw httpError(401, 'reauth_required', 'Please sign in again');
  const { token, session } = await issueSession({ sub: s.sub, role: s.role, name: s.name, amr: s.amr, sid: s.sid, auth_time: s.auth_time });
  await recordSession(db, session, req);
  setSessionCookie(reply, token);
  return { session, ...(req.headers['x-sarab-client'] === 'native' ? { token } : {}) };
});

app.post('/api/identity/auth/logout', { schema: { tags: ['auth'], summary: 'Sign out (the session is revoked server-side, not just forgotten by the browser)' } }, async (req, reply) => {
  const s = await readSession(req);
  if (s) {
    await db.query("UPDATE sessions SET revoked_at = now(), revoked_by = $2, revoked_reason = 'signed_out' WHERE sid = $1 AND revoked_at IS NULL", [s.sid, s.sub]);
    forgetSession(s.sid);
  }
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  return { ok: true };
});

// ---------- Passkey management (signed in) ----------

app.post('/api/identity/me/passkeys/options', { schema: { tags: ['passkeys'], summary: 'Get WebAuthn options to add a passkey', security: [{ session: [] }] } }, async (req) => {
  const s = await requireSession(req);
  const acc = await account(s.sub);
  const existing = (await db.query('SELECT credential_id, transports FROM passkeys WHERE subject = $1', [s.sub])).rows;
  const options = await generateRegistrationOptions({
    rpName: RP_NAME, rpID: RP_ID,
    userName: s.role === 'citizen' ? s.sub : s.sub.replace('staff:', ''),
    userDisplayName: s.name.en,
    userID: Buffer.from(acc.webauthn_user_id, 'base64url'),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.credential_id, transports: c.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    supportedAlgorithmIDs: [-8, -7, -257],
  });
  const id = randomId();
  await db.query("INSERT INTO challenges (id, kind, subject, secret, expires_at) VALUES ($1, 'webauthn-register', $2, $3, now() + interval '5 minutes')", [id, s.sub, options.challenge]);
  return { challenge_id: id, options };
});

app.post('/api/identity/me/passkeys', {
  schema: {
    tags: ['passkeys'], summary: 'Register a new passkey', security: [{ session: [] }],
    body: { type: 'object', required: ['challenge_id', 'response'], properties: { challenge_id: { type: 'string' }, response: { type: 'object', additionalProperties: true }, nickname: { type: 'string', maxLength: 60 } } },
  },
}, async (req) => {
  const s = await requireSession(req);
  const { challenge_id, response, nickname } = req.body as { challenge_id: string; response: any; nickname?: string };
  const ch = (await db.query("DELETE FROM challenges WHERE id = $1 AND kind = 'webauthn-register' AND subject = $2 AND expires_at > now() RETURNING secret", [challenge_id, s.sub])).rows[0];
  if (!ch) throw httpError(400, 'challenge_expired', 'Registration request expired. Please try again.');
  let result;
  try {
    result = await verifyRegistrationResponse({ response, expectedChallenge: ch.secret, expectedOrigin: EXPECTED_ORIGINS, expectedRPID: RP_ID, requireUserVerification: false });
  } catch (e) {
    throw httpError(400, 'passkey_invalid', (e as Error).message);
  }
  if (!result.verified || !result.registrationInfo) throw httpError(400, 'passkey_invalid', 'Passkey could not be verified');
  const { credential, credentialBackedUp } = result.registrationInfo;
  await db.query(
    'INSERT INTO passkeys (credential_id, subject, public_key, counter, transports, nickname, backed_up) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [credential.id, s.sub, Buffer.from(credential.publicKey), credential.counter, credential.transports ?? [], nickname?.trim() || 'Passkey', credentialBackedUp],
  );
  return { ok: true, credential_id: credential.id };
});

app.get('/api/identity/me/passkeys', { schema: { tags: ['passkeys'], summary: 'List my passkeys', security: [{ session: [] }] } }, async (req) => {
  const s = await requireSession(req);
  const { rows } = await db.query('SELECT credential_id, nickname, backed_up, created_at, last_used_at FROM passkeys WHERE subject = $1 ORDER BY created_at', [s.sub]);
  return { passkeys: rows };
});

app.delete('/api/identity/me/passkeys/:id', { schema: { tags: ['passkeys'], summary: 'Remove a passkey', security: [{ session: [] }] } }, async (req) => {
  const s = await requireSession(req);
  const { id } = req.params as { id: string };
  const r = await db.query('DELETE FROM passkeys WHERE credential_id = $1 AND subject = $2', [id, s.sub]);
  if (!r.rowCount) throw httpError(404, 'not_found', 'No such passkey');
  return { ok: true };
});

// ---------- Citizen self-service ----------

app.get('/api/identity/me/record', { schema: { tags: ['citizen'], summary: 'My civil record (fetched from the Civil Registry through Jisr)', security: [{ session: [] }] } }, async (req) => {
  const s = await requireSession(req, ['citizen']);
  return readCivilRecord(s.sub, 'citizen-self-service');
});

app.get('/api/identity/me/public-key', { schema: { tags: ['signatures'], summary: 'My public signing key', security: [{ session: [] }] } }, async (req) => {
  const s = await requireSession(req, ['citizen']);
  await citizenKey(db, s.sub).catch(() => null); // creates the cloud key on first use (no-op when device-bound)
  const row = (await db.query('SELECT public_jwk, device_bound FROM citizen_keys WHERE subject = $1', [s.sub])).rows[0];
  return { public_jwk: row.public_jwk, device_bound: row.device_bound };
});

app.get('/api/identity/citizens/:id/public-key', { schema: { tags: ['signatures'], summary: "A citizen's public signing key (for verifying their signatures)" } }, async (req) => {
  const { id } = req.params as { id: string };
  const row = (await db.query('SELECT public_jwk, device_bound FROM citizen_keys WHERE subject = $1', [id])).rows[0];
  if (!row) throw httpError(404, 'not_found', 'No key for this citizen');
  const { rows: retired } = await db.query('SELECT public_jwk, device_bound, retired_at FROM citizen_key_history WHERE subject = $1 ORDER BY retired_at DESC', [id]);
  return { public_jwk: row.public_jwk, device_bound: row.device_bound, retired_keys: retired };
});

// ---------- Digital signatures ----------

const RECENT_AUTH_SECONDS = 15 * 60;

app.post('/api/identity/me/signatures', {
  schema: {
    tags: ['signatures'], summary: 'Sign a document with my personal key (requires a sign-in within the last 15 minutes)', security: [{ session: [] }],
    body: { type: 'object', required: ['title', 'content'], properties: { title: { type: 'string', minLength: 1, maxLength: 200 }, content: { type: 'string', minLength: 1, maxLength: 100_000 } } },
  },
}, async (req) => {
  const s = await requireSession(req, ['citizen']);
  if (!isStrongRecentSignIn(s, RECENT_AUTH_SECONDS)) throw httpError(401, 'reauth_required', 'For your security, sign in again before signing a document');
  const { title, content } = req.body as { title: string; content: string };
  const key = await citizenKey(db, s.sub);
  const payload = { typ: 'sarab-document-signature', title, doc_sha256: sha256hex(content), signer: s.sub, signer_name: s.name, signed_at: new Date().toISOString(), amr: s.amr };
  const jws = await new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: 'EdDSA', kid: key.kid })
    .sign(key.privateKey);
  const id = randomId(9);
  await db.query('INSERT INTO signatures (id, subject, title, doc_sha256, jws) VALUES ($1,$2,$3,$4,$5)', [id, s.sub, title, payload.doc_sha256, jws]);
  return { id, jws, payload };
});

app.get('/api/identity/me/signatures', { schema: { tags: ['signatures'], summary: 'Documents I signed', security: [{ session: [] }] } }, async (req) => {
  const s = await requireSession(req, ['citizen']);
  const { rows } = await db.query('SELECT id, title, doc_sha256, jws, created_at FROM signatures WHERE subject = $1 ORDER BY created_at DESC', [s.sub]);
  return { signatures: rows };
});

app.post('/api/identity/signatures/verify', {
  schema: {
    tags: ['signatures'], summary: 'Verify a document signature (anyone)',
    body: { type: 'object', required: ['jws'], properties: { jws: { type: 'string', maxLength: 20_000 }, content: { type: 'string', maxLength: 100_000 } } },
  },
}, async (req) => {
  const { jws, content } = req.body as { jws: string; content?: string };
  let kid: string | undefined;
  try { kid = decodeProtectedHeader(jws).kid; } catch { return { valid: false, reason: 'not_a_signature' }; }
  const key = kid ? await publicKeyByKid(db, kid) : null;
  if (!key) return { valid: false, reason: 'unknown_signer' };
  try {
    const { payload } = await compactVerify(jws, (await importJWK(key.jwk, key.jwk.alg ?? 'EdDSA')) as CryptoKey);
    const data = JSON.parse(new TextDecoder().decode(payload));
    const signer = data.signer ?? data.grantor;
    if (signer !== key.subject) return { valid: false, reason: 'signer_mismatch' };
    const contentMatches = content === undefined ? null : sha256hex(content) === data.doc_sha256;
    return { valid: contentMatches !== false, reason: contentMatches === false ? 'document_changed' : null, payload: data, content_matches: contentMatches, key: { kid, device_bound: key.device_bound } };
  } catch {
    return { valid: false, reason: 'bad_signature' };
  }
});

// ---------- Exchange API (via Jisr only) ----------

const CLAIM_CREDENTIAL = new Map(CLAIMS.map((c) => [c.name, c.credential]));

app.post('/x/presentations', {
  schema: {
    tags: ['exchange (via Jisr only)'], security: [{ jisr: [] }],
    summary: 'Acting as the citizen’s wallet: obtain holder-bound SD-JWT credentials from each authoritative issuer and present ONLY the approved claims',
    description: 'Identity claims come from Mithaq’s own PID credential (data read from the Civil Registry); employment claims come from a credential signed by the Ministry of Labor. Each presentation carries a key-binding JWT signed with the citizen’s key for the given audience and nonce.',
    body: {
      type: 'object', required: ['national_id', 'claims', 'audience', 'nonce'],
      properties: { national_id: { type: 'string' }, claims: { type: 'array', items: { type: 'string' }, minItems: 1 }, audience: { type: 'string' }, nonce: { type: 'string', minLength: 8 } },
    },
  },
}, async (req) => {
  const ctx = requireJisr(req);
  const { national_id, claims, audience, nonce } = req.body as { national_id: string; claims: string[]; audience: string; nonce: string };
  if (ctx.subject !== national_id) throw httpError(403, 'subject_mismatch', 'Declared subject does not match');
  const unknown = claims.filter((c) => !CLAIM_CREDENTIAL.has(c));
  if (unknown.length) throw httpError(400, 'unknown_claims', `Unknown claims: ${unknown.join(', ')}`);

  const holder = await citizenKey(db, national_id);
  const via = { consentId: ctx.consentId, onBehalfOf: ctx.onBehalfOf };
  const presentations: { credential: string; vct: string; issuer: string; presentation: string }[] = [];

  // 1) Identity claims: Mithaq issues a PID credential from Civil Registry data (only fetched if needed).
  const pidClaims = claims.filter((c) => CLAIM_CREDENTIAL.get(c) === 'pid');
  if (pidClaims.length) {
    const record = await readCivilRecord(national_id, 'credential-issuance', via);
    const credential = await issueSdJwt({ issuer: 'mithaq', issuerKid: own.kid, issuerKey: own.key, holderPublicJwk: holder.publicJwk, claims: claimsFromRecord(record), vct: CREDENTIALS.pid.vct, ttlSeconds: 600 });
    presentations.push({ credential: 'pid', vct: CREDENTIALS.pid.vct, issuer: 'mithaq', presentation: await presentSdJwt({ sdJwt: credential, reveal: pidClaims, holderKey: holder.privateKey, audience, nonce }) });
  }

  // 2) Employment claims: the Ministry of Labor is the issuer — Mithaq only holds and presents it.
  const empClaims = claims.filter((c) => CLAIM_CREDENTIAL.get(c) === 'employment');
  if (empClaims.length) {
    const { credential } = await jisrCall<{ credential: string }>({
      target: 'labor', method: 'POST', path: '/x/credentials/employment', purpose: 'credential-issuance',
      subject: national_id, consentId: ctx.consentId, onBehalfOf: ctx.onBehalfOf,
      body: { national_id, holder_jwk: holder.publicJwk },
    });
    presentations.push({ credential: 'employment', vct: CREDENTIALS.employment.vct, issuer: 'labor', presentation: await presentSdJwt({ sdJwt: credential, reveal: empClaims, holderKey: holder.privateKey, audience, nonce }) });
  }
  return { presentations, format: 'dc+sd-jwt' };
});

// ---------- Citizen self-service views of each ministry (each one an audited Jisr exchange) ----------

const selfService = (target: string, suffix: string, summary: string) =>
  app.get(`/api/identity/me/${suffix}`, { schema: { tags: ['citizen'], summary, security: [{ session: [] }] } }, async (req) => {
    const s = await requireSession(req, ['citizen']);
    return jisrCall({ target, method: 'GET', path: `/x/persons/${s.sub}/${suffix}`, purpose: 'citizen-self-service', subject: s.sub, onBehalfOf: 'self' });
  });
selfService('education', 'education', 'My qualifications (from the Ministry of Education, via Jisr)');
selfService('health', 'health', 'My health summary (from the Ministry of Health, via Jisr)');
selfService('labor', 'employment', 'My employment & social insurance (from the Ministry of Labor, via Jisr)');
selfService('property', 'assets', 'My vehicles & properties (from the Property & Vehicles Authority, via Jisr)');

// DEMO_MODE only: list the documented test personas so testers can sign in. In production (DEMO_MODE=false)
// the route does not exist at all.
// What the portal needs to know at start: only whether this is a local demo (no secret in it).
app.get('/api/identity/portal-config', { schema: { tags: ['demo'], summary: 'Public portal settings (whether DEMO_MODE is on)', response: { 200: { type: 'object', properties: { demo_mode: { type: 'boolean' } } } } } }, async () => ({ demo_mode: DEMO_MODE }));

if (DEMO_MODE) app.get('/api/identity/demo-accounts', { schema: { tags: ['demo'], summary: 'Demo personas and passwords (only when DEMO_MODE=true)' } }, async () => {
  const people = population();
  const by = (id: string) => people.find((p) => p.national_id === id)!;
  const persona = (id: string, note: { ar: string; en: string }) => {
    const p = by(id);
    return { username: id, name: { ar: `${p.given_name.ar} ${p.family_name.ar}`, en: `${p.given_name.en} ${p.family_name.en}` }, note };
  };
  return {
    password: DEMO_PASSWORD,
    accounts: [
      persona(PERSONAS.layla, { ar: 'بالغة — استخدمها لعرض فتح الحساب البنكي', en: 'Adult — use for the bank account demo' }),
      persona(PERSONAS.yousef, { ar: 'عمره 16 سنة — يرفض البنك فتح حساب دون معرفة تاريخ ميلاده', en: 'Age 16 — the bank refuses without ever learning his birth date' }),
      persona(PERSONAS.omar, { ar: 'زوج ليلى وابن صالح — يجدد رخصة والده بالتفويض، ويؤكد اسم المولود بعد إبلاغ المستشفى', en: "Layla's husband, Saleh's son — renews his father's registration as delegate; confirms a newborn's name after the hospital's report" }),
      persona(PERSONAS.saleh, { ar: 'مواطن مسن تنتهي رخصة سيارته قريبًا — يفوّض ابنه عمر بتجديدها', en: 'Elderly; car registration about to expire — delegates the renewal to his son Omar' }),
      // Staff accounts are deliberately NOT listed: they use a private password + authenticator app.
    ],
  };
});

// ---------- Phase 3: life events, inbox, delegations ----------
registerLifeEvents(app, db);
registerDelegations(app, db);
registerCounter(app, db);
registerSessions(app, db);
registerApps(app, db);
registerDeviceKeys(app, db);
registerRegistration(app, db, startSession);
registerRecords(app, db);
registerBirths(app, db);
registerFeed(app, db);
startOutboxPump(db);
startFeedPump(db, app.log);
startCounterExpiry(db, app.log);
startThrottleCleanup(db);

// Who am I (for the portal header) — never fails, returns null when signed out.
app.get('/api/identity/whoami', { schema: { tags: ['auth'], summary: 'Session or null (never 401)' } }, async (req) => ({ session: await readSession(req) }));

await start(app);
