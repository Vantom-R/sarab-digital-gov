// Phase 6 — citizen keys on their own devices (passkey-bound).
//
// Enrolment: after a fresh passkey check, the browser generates a NON-EXTRACTABLE P-256 key with WebCrypto
// (kept in IndexedDB on that device) and sends only the public key. Mithaq stores it, moves the previous
// public key to history (old signatures stay verifiable) and DELETES its server-held private key.
//
// Every later use is a "ceremony":
//   1. POST /me/ceremonies {purpose, input} — Mithaq validates and fixes the exact payload, and returns
//      WebAuthn options restricted to the passkey the key was enrolled with.
//   2. The browser gets a passkey assertion (user verification) and signs the payload with the device key.
//   3. POST /me/ceremonies/:id/complete — Mithaq verifies BOTH (passkey assertion and device signature
//      over exactly that payload), then acts: store a document signature, store a delegation mandate, or
//      hand the wallet its credentials so the device can build a selective-disclosure presentation.
import type { FastifyInstance } from 'fastify';
import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { compactVerify, decodeProtectedHeader, importJWK, calculateJwkThumbprint, type JWK, type CryptoKey } from 'jose';
import type { Db } from '#shared/db.ts';
import { tx } from '#shared/db.ts';
import { httpError } from '#shared/http.ts';
import { jisrCall } from '#shared/jisr.ts';
import { EXPECTED_ORIGINS } from './apps.ts';
import { loadOwnKey, randomId, sha256hex } from '#shared/crypto.ts';
import { requireSession, type Session } from '#shared/session.ts';
import { issueSdJwt } from '#shared/sdjwt.ts';
import { CLAIMS, CREDENTIALS } from '#shared/catalog.ts';
import { readCivilRecord, claimsFromRecord } from './citizen.ts';
import { prepareDelegation, storeDelegation } from './delegations.ts';

const RP_ID = process.env.RP_ID ?? 'localhost';
const ORIGIN = process.env.PUBLIC_ORIGIN ?? 'http://localhost:18090';
const CLAIM_CREDENTIAL = new Map(CLAIMS.map((c) => [c.name, c.credential]));

function checkDevicePublicJwk(jwk: any): JWK {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string' || 'd' in jwk) {
    throw httpError(400, 'bad_device_key', 'Expected a public P-256 key (JWK) without private parts');
  }
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

/** Verifies a passkey assertion for `subject` against a ceremony challenge; optionally only one credential. */
async function verifyPasskey(db: Db, subject: string, challenge: string, response: any, onlyCredential?: string | null) {
  const cred = (await db.query('SELECT * FROM passkeys WHERE credential_id = $1 AND subject = $2', [response?.id, subject])).rows[0];
  if (!cred) throw httpError(401, 'unknown_passkey', 'That passkey does not belong to you');
  if (onlyCredential && cred.credential_id !== onlyCredential) throw httpError(401, 'wrong_passkey', 'Use the passkey your device key is bound to');
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response, expectedChallenge: challenge, expectedOrigin: EXPECTED_ORIGINS, expectedRPID: RP_ID, requireUserVerification: true,
      credential: { id: cred.credential_id, publicKey: new Uint8Array(cred.public_key), counter: Number(cred.counter), transports: cred.transports },
    });
  } catch (e) {
    throw httpError(401, 'passkey_invalid', (e as Error).message);
  }
  if (!result.verified) throw httpError(401, 'passkey_invalid', 'Passkey could not be verified');
  await db.query('UPDATE passkeys SET counter = $2, last_used_at = now() WHERE credential_id = $1', [cred.credential_id, result.authenticationInfo.newCounter]);
  return cred.credential_id as string;
}

async function newChallenge(db: Db, subject: string, payload: Record<string, unknown>, allow: { credential_id: string; transports: string[] }[]) {
  if (!allow.length) throw httpError(409, 'passkey_required', 'Add a passkey first: it protects your device key');
  const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: 'required', allowCredentials: allow.map((c) => ({ id: c.credential_id, transports: c.transports as any })) });
  const id = randomId();
  await db.query("INSERT INTO challenges (id, kind, subject, secret, payload, expires_at) VALUES ($1, 'ceremony', $2, $3, $4, now() + interval '5 minutes')", [id, subject, options.challenge, payload]);
  return { id, options };
}

async function takeChallenge(db: Db, id: string, subject: string) {
  const ch = (await db.query("DELETE FROM challenges WHERE id = $1 AND kind = 'ceremony' AND subject = $2 AND expires_at > now() RETURNING secret, payload", [id, subject])).rows[0];
  if (!ch) throw httpError(400, 'challenge_expired', 'This request expired. Please try again.');
  return ch as { secret: string; payload: any };
}

async function deviceKey(db: Db, subject: string) {
  const k = (await db.query('SELECT public_jwk, passkey_credential_id FROM citizen_keys WHERE subject = $1 AND device_bound', [subject])).rows[0];
  if (!k) throw httpError(409, 'no_device_key', 'Your key is not on a device yet');
  return k as { public_jwk: JWK & { kid: string }; passkey_credential_id: string };
}

/** Verifies the device's JWS over EXACTLY the payload string Mithaq fixed for this ceremony. */
async function verifyDeviceJws(jws: string, key: JWK & { kid: string }, expected: string) {
  let header;
  try { header = decodeProtectedHeader(jws); } catch { throw httpError(400, 'bad_signature', 'Not a JWS'); }
  if (header.alg !== 'ES256' || header.kid !== key.kid) throw httpError(400, 'bad_signature', 'Wrong algorithm or key id');
  try {
    const { payload } = await compactVerify(jws, (await importJWK(key, 'ES256')) as CryptoKey);
    if (new TextDecoder().decode(payload) !== expected) throw new Error('payload differs');
  } catch (e) {
    throw httpError(400, 'bad_signature', `Device signature invalid: ${(e as Error).message}`);
  }
}

export function registerDeviceKeys(app: FastifyInstance, db: Db): void {
  const tags = ['device keys (phase 6)'];
  const own = loadOwnKey();

  app.get('/api/identity/me/device-key', { schema: { tags, security: [{ session: [] }], summary: 'Where my signing key lives (server "cloud wallet" or my device)' } }, async (req) => {
    const s = await requireSession(req, ['citizen']);
    const k = (await db.query('SELECT public_jwk, device_bound, passkey_credential_id, enrolled_at, private_enc IS NOT NULL AS server_has_private FROM citizen_keys WHERE subject = $1', [s.sub])).rows[0];
    const pk = k?.passkey_credential_id ? (await db.query('SELECT nickname FROM passkeys WHERE credential_id = $1', [k.passkey_credential_id])).rows[0] : null;
    return {
      mode: k?.device_bound ? 'device' : 'cloud', kid: k?.public_jwk?.kid ?? null, public_jwk: k?.public_jwk ?? null,
      server_holds_private_key: !!k?.server_has_private, passkey: pk ? { credential_id: k.passkey_credential_id, nickname: pk.nickname } : null, enrolled_at: k?.enrolled_at ?? null,
    };
  });

  // ---- Enrolment ----
  app.post('/api/identity/me/device-key/options', { schema: { tags, security: [{ session: [] }], summary: 'Start moving my key to this device: passkey check first' } }, async (req) => {
    const s = await requireSession(req, ['citizen']);
    const { rows } = await db.query('SELECT credential_id, transports FROM passkeys WHERE subject = $1', [s.sub]);
    const c = await newChallenge(db, s.sub, { purpose: 'enrol' }, rows);
    return { ceremony_id: c.id, options: c.options };
  });

  app.post('/api/identity/me/device-key', {
    schema: {
      tags, security: [{ session: [] }], summary: 'Finish: register the device public key; Mithaq deletes its copy of my private key',
      body: { type: 'object', required: ['ceremony_id', 'assertion', 'public_jwk'], properties: { ceremony_id: { type: 'string' }, assertion: { type: 'object', additionalProperties: true }, public_jwk: { type: 'object', additionalProperties: true } } },
    },
  }, async (req) => {
    const s = await requireSession(req, ['citizen']);
    const b = req.body as { ceremony_id: string; assertion: any; public_jwk: any };
    const jwk = checkDevicePublicJwk(b.public_jwk);
    const ch = await takeChallenge(db, b.ceremony_id, s.sub);
    if (ch.payload?.purpose !== 'enrol') throw httpError(400, 'wrong_ceremony', 'Not an enrolment request');
    const credentialId = await verifyPasskey(db, s.sub, ch.secret, b.assertion);
    const kid = `citizen:${s.sub}#dev-${(await calculateJwkThumbprint(jwk)).slice(0, 10)}`;
    await tx(db, async (c) => {
      const old = (await c.query('SELECT public_jwk, device_bound FROM citizen_keys WHERE subject = $1 FOR UPDATE', [s.sub])).rows[0];
      if (old) await c.query('INSERT INTO citizen_key_history (kid, subject, public_jwk, device_bound) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [old.public_jwk.kid, s.sub, old.public_jwk, old.device_bound]);
      await c.query(
        `INSERT INTO citizen_keys (subject, public_jwk, private_enc, device_bound, passkey_credential_id, enrolled_at) VALUES ($1,$2,NULL,true,$3,now())
         ON CONFLICT (subject) DO UPDATE SET public_jwk = $2, private_enc = NULL, device_bound = true, passkey_credential_id = $3, enrolled_at = now()`,
        [s.sub, { ...jwk, kid, alg: 'ES256' }, credentialId],
      );
    });
    return { ok: true, kid, server_holds_private_key: false };
  });

  // DEMO ONLY (shared demo accounts): go back to a server-held key so other visitors can still use the account.
  app.delete('/api/identity/me/device-key', { schema: { tags, security: [{ session: [] }], summary: 'Demo: return to a server-held key (the device key is retired, its old signatures stay verifiable)' } }, async (req) => {
    const s = await requireSession(req, ['citizen']);
    await tx(db, async (c) => {
      const cur = (await c.query('SELECT public_jwk, device_bound FROM citizen_keys WHERE subject = $1 AND device_bound FOR UPDATE', [s.sub])).rows[0];
      if (!cur) return;
      await c.query('INSERT INTO citizen_key_history (kid, subject, public_jwk, device_bound) VALUES ($1,$2,$3,true) ON CONFLICT DO NOTHING', [cur.public_jwk.kid, s.sub, cur.public_jwk]);
      await c.query('DELETE FROM citizen_keys WHERE subject = $1', [s.sub]); // a fresh cloud key is created on next use
    });
    return { ok: true, mode: 'cloud' };
  });

  // ---- Ceremonies ----
  app.post('/api/identity/me/ceremonies', {
    schema: {
      tags, security: [{ session: [] }], summary: 'Prepare a device-signed action: document | mandate | wallet',
      body: { type: 'object', required: ['purpose', 'input'], properties: { purpose: { type: 'string', enum: ['document', 'mandate', 'wallet'] }, input: { type: 'object', additionalProperties: true } } },
    },
  }, async (req) => {
    const s = await requireSession(req, ['citizen']);
    const { purpose, input } = req.body as { purpose: 'document' | 'mandate' | 'wallet'; input: any };
    const k = await deviceKey(db, s.sub);
    let payload: Record<string, unknown>;
    if (purpose === 'document') {
      if (typeof input.title !== 'string' || !input.title.trim() || typeof input.content !== 'string' || !input.content) throw httpError(400, 'validation_error', 'title and content are required');
      payload = { typ: 'sarab-document-signature', title: input.title.slice(0, 200), doc_sha256: sha256hex(input.content.slice(0, 100_000)), signer: s.sub, signer_name: s.name, signed_at: new Date().toISOString(), amr: [...s.amr, 'device-key'] };
    } else if (purpose === 'mandate') {
      const p = await prepareDelegation(db, { grantor: s.sub, grantorName: s.name, delegate: String(input.delegate_id ?? '').trim(), scopes: input.scopes ?? [], days: Math.min(365, Math.max(1, Number(input.days) || 90)), via: 'portal' });
      payload = { ...p.mandate, _prepared: { id: p.id, delegateName: p.delegateName, validUntil: p.validUntil, scopes: input.scopes, delegate: String(input.delegate_id).trim() } };
    } else {
      if (typeof input.consent_id !== 'string' || !Array.isArray(input.claims) || !input.claims.length) throw httpError(400, 'validation_error', 'consent_id and claims are required');
      const unknown = input.claims.filter((c: string) => !CLAIM_CREDENTIAL.has(c));
      if (unknown.length) throw httpError(400, 'unknown_claims', `Unknown claims: ${unknown.join(', ')}`);
      payload = { typ: 'sarab-wallet-unlock', consent_id: input.consent_id, claims: input.claims, at: new Date().toISOString() };
    }
    // The exact bytes to be signed are fixed here and stored verbatim (jsonb would reorder keys).
    const { _prepared, ...toSign } = payload as any;
    const payloadJson = JSON.stringify(toSign);
    const c = await newChallenge(db, s.sub, { purpose, payload_json: payloadJson, prepared: _prepared ?? null }, [{ credential_id: k.passkey_credential_id, transports: [] }]);
    return { ceremony_id: c.id, options: c.options, payload_json: purpose === 'wallet' ? null : payloadJson, kid: k.public_jwk.kid };
  });

  app.post('/api/identity/me/ceremonies/:id/complete', {
    schema: {
      tags, security: [{ session: [] }], summary: 'Complete a ceremony: passkey assertion (+ device JWS for document/mandate)',
      body: { type: 'object', required: ['assertion'], properties: { assertion: { type: 'object', additionalProperties: true }, jws: { type: 'string', maxLength: 20_000 } } },
    },
  }, async (req) => {
    const s = await requireSession(req, ['citizen']);
    const { id } = req.params as { id: string };
    const { assertion, jws } = req.body as { assertion: any; jws?: string };
    const ch = await takeChallenge(db, id, s.sub);
    const k = await deviceKey(db, s.sub);
    await verifyPasskey(db, s.sub, ch.secret, assertion, k.passkey_credential_id);
    const { purpose, payload_json: payloadJson, prepared } = ch.payload as { purpose: string; payload_json: string; prepared: any };
    const payload = JSON.parse(payloadJson);

    if (purpose === 'document') {
      await verifyDeviceJws(jws ?? '', k.public_jwk, payloadJson);
      const sigId = randomId(9);
      await db.query('INSERT INTO signatures (id, subject, title, doc_sha256, jws) VALUES ($1,$2,$3,$4,$5)', [sigId, s.sub, payload.title, payload.doc_sha256, jws]);
      return { id: sigId, jws, payload };
    }
    if (purpose === 'mandate') {
      await verifyDeviceJws(jws ?? '', k.public_jwk, payloadJson);
      return storeDelegation(db, { id: prepared.id, mandate: payload, delegateName: prepared.delegateName, validUntil: prepared.validUntil },
        { grantor: s.sub, grantorName: s.name, delegate: prepared.delegate, scopes: prepared.scopes, days: 0, via: 'portal' }, jws!);
    }
    if (purpose === 'wallet') return walletCredentials(db, s, payload.consent_id, payload.claims, k.public_jwk, await own);
    throw httpError(400, 'wrong_ceremony', 'Unknown ceremony');
  });
}

/** After the passkey check: credentials bound to the DEVICE key, for the device to present selectively. */
async function walletCredentials(db: Db, s: Session, consentId: string, claims: string[], deviceJwk: JWK & { kid: string }, own: Awaited<ReturnType<typeof loadOwnKey>>) {
  const holder = { kty: deviceJwk.kty, crv: deviceJwk.crv, x: deviceJwk.x, y: deviceJwk.y, alg: 'ES256' } as JWK;
  const credentials: { credential: string; vct: string; issuer: string; sd_jwt: string }[] = [];
  if (claims.some((c) => CLAIM_CREDENTIAL.get(c) === 'pid')) {
    const record = await readCivilRecord(s.sub, 'credential-issuance', { consentId });
    const sdJwt = await issueSdJwt({ issuer: 'mithaq', issuerKid: own.kid, issuerKey: own.key, holderPublicJwk: holder, claims: claimsFromRecord(record), vct: CREDENTIALS.pid.vct, ttlSeconds: 600 });
    credentials.push({ credential: 'pid', vct: CREDENTIALS.pid.vct, issuer: 'mithaq', sd_jwt: sdJwt });
  }
  if (claims.some((c) => CLAIM_CREDENTIAL.get(c) === 'employment')) {
    const { credential } = await jisrCall<{ credential: string }>({
      target: 'labor', method: 'POST', path: '/x/credentials/employment', purpose: 'credential-issuance',
      subject: s.sub, consentId, onBehalfOf: 'self', body: { national_id: s.sub, holder_jwk: holder },
    });
    credentials.push({ credential: 'employment', vct: CREDENTIALS.employment.vct, issuer: 'labor', sd_jwt: credential });
  }
  return { credentials, claims };
}
