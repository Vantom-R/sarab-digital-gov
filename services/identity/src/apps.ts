// Native apps (iOS, Android, Windows): device registration, refresh tokens, push-token storage, the
// "associated domain" files that let apps use the site's passkeys, and an app configuration endpoint.
//
// Sign-in flow for an app:
//   1. sign in as usual (passkey or password + code) with header `X-Sarab-Client: native` → session token
//      (30 minutes) in the response body; send it as `Authorization: Bearer <token>`;
//   2. within 10 minutes of that sign-in, POST /api/identity/apps/devices → device_id + refresh_token
//      (shown once; store it in the Keychain / Keystore / Credential Locker);
//   3. when the session ends, POST /api/identity/apps/token {device_id, refresh_token} → a new session token
//      and a NEW refresh token (rotation: each refresh token works once; presenting an old one again means
//      it was copied, so the device is revoked).
// A refreshed session carries amr ["refresh"]: it can read and act, but signing documents and creating
// delegations still need a real sign-in (passkey / password + code). Refresh tokens are stored hashed,
// expire after 30 days without use and after 180 days in any case, and are revoked by "sign out
// everywhere", the admin's revoke-all and the kill switch. Citizens only (staff use the web portal).
import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '#shared/db.ts';
import { tx } from '#shared/db.ts';
import { httpError, S, API_VERSION } from '#shared/http.ts';
import { issueSession, requireSession, SESSION_TTL_SECONDS, type Session } from '#shared/session.ts';
import { randomId } from '#shared/crypto.ts';
import { readCivilRecord, fullName } from './citizen.ts';
import { recordSession, forgetSession } from './sessions.ts';

const tags = ['apps'];
const REFRESH_DAYS = 30;
const DEVICE_MAX_DAYS = 180;
const REGISTER_WITHIN_SECONDS = 10 * 60;
const MAX_DEVICES = 10;
const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const newRefresh = () => `srt_${randomBytes(32).toString('base64url')}`;

// ---------------- Associated domains / passkeys for apps ----------------
const ORIGIN = process.env.PUBLIC_ORIGIN ?? 'http://localhost:18090';
const list = (v?: string) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
/** "TEAMID.bundle.id" entries for iOS / macOS apps */
const IOS_APP_IDS = list(process.env.IOS_APP_IDS);
const ANDROID_PACKAGE = (process.env.ANDROID_APP_PACKAGE ?? '').trim();
/** SHA-256 fingerprints of the Android signing certificate, "AA:BB:…" */
const ANDROID_CERTS = list(process.env.ANDROID_CERT_SHA256).filter((f) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/i.test(f));

/** Origins a passkey assertion may come from: the website, and each Android app signing key. */
export const EXPECTED_ORIGINS: string[] = [
  ORIGIN,
  ...ANDROID_CERTS.map((f) => `android:apk-key-hash:${Buffer.from(f.replace(/:/g, ''), 'hex').toString('base64url')}`),
];

export function isStrongRecentSignIn(s: Session, seconds: number): boolean {
  return Date.now() / 1000 - s.auth_time <= seconds && !s.amr.includes('refresh');
}

const deviceSchema = {
  type: 'object',
  properties: {
    device_id: { type: 'string' }, platform: { type: 'string', enum: ['ios', 'android', 'windows'] }, name: { type: 'string' },
    app_version: { type: ['string', 'null'] }, push: { type: ['string', 'null'], description: 'push provider registered (apns / fcm / wns), never the token' },
    created_at: { type: 'string', format: 'date-time' }, last_used_at: { type: ['string', 'null'], format: 'date-time' },
    refresh_expires_at: { type: 'string', format: 'date-time' }, current: { type: 'boolean' },
  },
} as const;
const tokenSchema = {
  type: 'object',
  properties: {
    session: { type: 'object', properties: { sub: { type: 'string' }, role: { type: 'string' }, name: S.bilingual, amr: { type: 'array', items: { type: 'string' } }, auth_time: { type: 'integer' }, sid: { type: 'string' }, exp: { type: 'integer' } } },
    token: { type: 'string', description: 'Session token: send as Authorization: Bearer <token>' },
    refresh_token: { type: 'string', description: 'Replaces the previous refresh token, which no longer works' },
    refresh_expires_at: { type: 'string', format: 'date-time' },
  },
} as const;

export function registerApps(app: FastifyInstance, db: Db): void {
  // Apple: lets iOS apps listed in IOS_APP_IDS use this site's passkeys (webcredentials) and open its links.
  app.get('/.well-known/apple-app-site-association', { schema: { hide: true } }, async (_req, reply) => {
    reply.header('content-type', 'application/json').header('cache-control', 'public, max-age=3600');
    return {
      webcredentials: { apps: IOS_APP_IDS },
      applinks: { details: IOS_APP_IDS.length ? [{ appIDs: IOS_APP_IDS, components: [{ '/': '/activate*' }, { '/': '/inbox*' }] }] : [] },
    };
  });
  // Android: Digital Asset Links — the app may use this site's passkeys / saved sign-ins and open its links.
  app.get('/.well-known/assetlinks.json', { schema: { hide: true } }, async (_req, reply) => {
    reply.header('content-type', 'application/json').header('cache-control', 'public, max-age=3600');
    if (!ANDROID_PACKAGE || !ANDROID_CERTS.length) return [];
    return [{
      relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
      target: { namespace: 'android_app', package_name: ANDROID_PACKAGE, sha256_cert_fingerprints: ANDROID_CERTS },
    }];
  });

  app.get('/api/identity/apps/config', {
    schema: {
      tags, summary: 'What an app needs to know before sign-in: API version, passkey relying party, token lifetimes',
      response: {
        200: {
          type: 'object',
          properties: {
            api_version: { type: 'string' }, api_base: { type: 'string' }, openapi: { type: 'string' },
            passkeys: { type: 'object', properties: { rp_id: { type: 'string' }, origins: { type: 'array', items: { type: 'string' } } } },
            session_seconds: { type: 'integer' }, refresh_days: { type: 'integer' }, device_max_days: { type: 'integer' },
            register_within_seconds: { type: 'integer' }, push_providers: { type: 'array', items: { type: 'string' } }, push_sending: { type: 'boolean' },
          },
        },
      },
    },
  }, async () => ({
    api_version: API_VERSION, api_base: `/api/v${API_VERSION}`, openapi: `/api/v${API_VERSION}/openapi.json`,
    passkeys: { rp_id: process.env.RP_ID ?? 'localhost', origins: EXPECTED_ORIGINS },
    session_seconds: SESSION_TTL_SECONDS, refresh_days: REFRESH_DAYS, device_max_days: DEVICE_MAX_DAYS,
    register_within_seconds: REGISTER_WITHIN_SECONDS, push_providers: ['apns', 'fcm', 'wns'], push_sending: false,
  }));

  app.post('/api/identity/apps/devices', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags, security: [{ bearer: [] }],
      summary: 'Register this app installation (within 10 minutes of a real sign-in) and get its first refresh token',
      body: {
        type: 'object', required: ['platform', 'name'], additionalProperties: false,
        properties: {
          platform: { type: 'string', enum: ['ios', 'android', 'windows'] }, name: { type: 'string', minLength: 1, maxLength: 60 },
          app_version: { type: 'string', maxLength: 30 },
          push: { type: 'object', required: ['provider', 'token'], additionalProperties: false, properties: { provider: { type: 'string', enum: ['apns', 'fcm', 'wns'] }, token: { type: 'string', minLength: 8, maxLength: 4096 } } },
        },
      },
      response: { 201: { type: 'object', properties: { device_id: { type: 'string' }, refresh_token: { type: 'string', description: 'Shown once' }, refresh_expires_at: { type: 'string', format: 'date-time' } } }, 400: S.error, 401: S.error, 409: S.error },
    },
  }, async (req, reply) => {
    const s = await requireSession(req, ['citizen']);
    if (req.headers['x-sarab-client'] !== 'native') throw httpError(400, 'native_only', 'Only apps register devices (send X-Sarab-Client: native)');
    if (!isStrongRecentSignIn(s, REGISTER_WITHIN_SECONDS)) throw httpError(401, 'reauth_required', 'Sign in again (passkey or password + code) to register this device');
    const b = req.body as { platform: string; name: string; app_version?: string; push?: { provider: string; token: string } };
    const active = Number((await db.query('SELECT count(*) FROM app_devices WHERE subject = $1 AND revoked_at IS NULL AND refresh_expires_at > now()', [s.sub])).rows[0].count);
    if (active >= MAX_DEVICES) throw httpError(409, 'too_many_devices', `At most ${MAX_DEVICES} app devices; remove one first`);
    const id = `dev_${randomId(12)}`;
    const refresh = newRefresh();
    const { rows: [d] } = await db.query(
      `INSERT INTO app_devices (id, subject, platform, name, app_version, refresh_hash, refresh_expires_at, push_provider, push_token, registered_sid)
       VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(days => $7), $8, $9, $10) RETURNING refresh_expires_at`,
      [id, s.sub, b.platform, b.name.trim(), b.app_version ?? null, hash(refresh), REFRESH_DAYS, b.push?.provider ?? null, b.push?.token ?? null, s.sid],
    );
    await db.query('UPDATE sessions SET device_id = $1 WHERE sid = $2', [id, s.sid]);
    reply.status(201);
    return { device_id: id, refresh_token: refresh, refresh_expires_at: d.refresh_expires_at };
  });

  app.post('/api/identity/apps/token', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      tags, summary: 'Exchange the refresh token for a new session token and a new refresh token (each refresh token works once)',
      body: { type: 'object', required: ['device_id', 'refresh_token'], additionalProperties: false, properties: { device_id: { type: 'string', maxLength: 40 }, refresh_token: { type: 'string', maxLength: 100 } } },
      response: { 200: tokenSchema, 401: S.error },
    },
  }, async (req) => {
    const { device_id, refresh_token } = req.body as { device_id: string; refresh_token: string };
    const h = hash(refresh_token);
    const out = await tx(db, async (c) => {
      const { rows: [d] } = await c.query(
        `SELECT d.*, a.kind, a.role, a.sessions_not_before, (SELECT value FROM settings WHERE key = 'kill_switch_not_before') AS kill
           FROM app_devices d JOIN accounts a ON a.subject = d.subject WHERE d.id = $1 FOR UPDATE OF d`, [device_id]);
      if (!d || d.revoked_at) return { error: 'invalid_refresh' } as const;
      if (d.previous_hash && h === d.previous_hash) {
        // An already-used refresh token came back: someone copied it. Cut the device off completely.
        await c.query("UPDATE app_devices SET revoked_at = now(), revoked_reason = 'refresh_reused' WHERE id = $1", [d.id]);
        await c.query("UPDATE sessions SET revoked_at = now(), revoked_reason = 'refresh_reused' WHERE device_id = $1 AND revoked_at IS NULL", [d.id]);
        return { error: 'refresh_reused' } as const;
      }
      if (h !== d.refresh_hash) return { error: 'invalid_refresh' } as const;
      const created = new Date(d.created_at).getTime();
      if (new Date(d.refresh_expires_at).getTime() < Date.now() || created < Date.now() - DEVICE_MAX_DAYS * 86_400_000) return { error: 'refresh_expired' } as const;
      if ((d.sessions_not_before && new Date(d.sessions_not_before).getTime() > created) || (d.kill && new Date(d.kill).getTime() > created)) {
        await c.query("UPDATE app_devices SET revoked_at = now(), revoked_reason = 'signed_out_everywhere' WHERE id = $1", [d.id]);
        return { error: 'invalid_refresh' } as const;
      }
      const refresh = newRefresh();
      const { rows: [u] } = await c.query(
        `UPDATE app_devices SET previous_hash = refresh_hash, refresh_hash = $2, last_used_at = now(),
           refresh_expires_at = LEAST(now() + make_interval(days => $3), created_at + make_interval(days => $4)) WHERE id = $1 RETURNING refresh_expires_at`,
        [d.id, hash(refresh), REFRESH_DAYS, DEVICE_MAX_DAYS],
      );
      return { device: d, refresh, refresh_expires_at: u.refresh_expires_at };
    });
    if ('error' in out && out.error === 'refresh_reused') forgetSession();   // its sessions were just revoked: drop the cached "valid"
    if ('error' in out) throw httpError(401, out.error!, out.error === 'refresh_reused' ? 'This refresh token was already used; the device has been signed out' : 'Sign in again');
    const name = fullName(await readCivilRecord(out.device.subject, 'authentication'));
    const { token, session } = await issueSession({ sub: out.device.subject, role: out.device.role, name, amr: ['refresh'] });
    await recordSession(db, session, req);
    await db.query('UPDATE sessions SET device_id = $1 WHERE sid = $2', [out.device.id, session.sid]);
    return { session, token, refresh_token: out.refresh, refresh_expires_at: out.refresh_expires_at };
  });

  app.get('/api/identity/apps/devices', {
    schema: { tags, security: [{ session: [] }], summary: 'My registered app devices', response: { 200: { type: 'object', properties: { devices: { type: 'array', items: deviceSchema } } }, 401: S.error } },
  }, async (req) => {
    const s = await requireSession(req, ['citizen']);
    const current = (await db.query('SELECT device_id FROM sessions WHERE sid = $1', [s.sid])).rows[0]?.device_id ?? null;
    const { rows } = await db.query(
      `SELECT id AS device_id, platform, name, app_version, push_provider AS push, created_at, last_used_at, refresh_expires_at
         FROM app_devices WHERE subject = $1 AND revoked_at IS NULL AND refresh_expires_at > now() ORDER BY created_at DESC`, [s.sub]);
    return { devices: rows.map((r) => ({ ...r, current: r.device_id === current })) };
  });

  app.put('/api/identity/apps/devices/:id/push', {
    schema: {
      tags, security: [{ bearer: [] }], summary: 'Set or replace the push token of one of my devices (APNs, FCM or WNS); stored for when push notifications are switched on',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 40 } } },
      body: { type: 'object', required: ['provider', 'token'], additionalProperties: false, properties: { provider: { type: 'string', enum: ['apns', 'fcm', 'wns'] }, token: { type: 'string', minLength: 8, maxLength: 4096 } } },
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } }, 404: S.error },
    },
  }, async (req) => {
    const s = await requireSession(req, ['citizen']);
    const { id } = req.params as { id: string };
    const b = req.body as { provider: string; token: string };
    const r = await db.query('UPDATE app_devices SET push_provider = $3, push_token = $4 WHERE id = $1 AND subject = $2 AND revoked_at IS NULL', [id, s.sub, b.provider, b.token]);
    if (!r.rowCount) throw httpError(404, 'not_found', 'No such device');
    return { ok: true };
  });

  app.delete('/api/identity/apps/devices/:id', {
    schema: {
      tags, security: [{ session: [] }], summary: 'Remove a device: its refresh token and every session it opened stop working at once (use it for "sign out" in the app)',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 40 } } },
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' }, sessions_revoked: { type: 'integer' } } }, 404: S.error },
    },
  }, async (req) => {
    const s = await requireSession(req, ['citizen']);
    const { id } = req.params as { id: string };
    const r = await db.query("UPDATE app_devices SET revoked_at = now(), revoked_reason = 'removed_by_owner' WHERE id = $1 AND subject = $2 AND revoked_at IS NULL", [id, s.sub]);
    if (!r.rowCount) throw httpError(404, 'not_found', 'No such device');
    const sr = await db.query("UPDATE sessions SET revoked_at = now(), revoked_by = $2, revoked_reason = 'device_removed' WHERE device_id = $1 AND revoked_at IS NULL RETURNING sid", [id, s.sub]);
    for (const x of sr.rows) forgetSession(x.sid);
    return { ok: true, sessions_revoked: sr.rowCount ?? 0 };
  });
}

/** "Sign out everywhere" and the admin's revoke-all also cut off every app device. */
export async function revokeAppDevices(db: Db, subject: string, reason: string): Promise<void> {
  await db.query('UPDATE app_devices SET revoked_at = now(), revoked_reason = $2 WHERE subject = $1 AND revoked_at IS NULL', [subject, reason]);
}
