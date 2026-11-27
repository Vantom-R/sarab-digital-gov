// Citizen key pairs, civil-record lookups (via Jisr) and credential claims.
import { generateKeyPair, exportJWK, importJWK, type CryptoKey, type JWK } from 'jose';
import type { Db } from '#shared/db.ts';
import { decryptSecret, encryptSecret } from '#shared/crypto.ts';
import { httpError } from '#shared/http.ts';
import { jisrCall } from '#shared/jisr.ts';
import { ageOn } from '#shared/seed.ts';
import type { Bilingual } from '#shared/catalog.ts';

export interface CivilRecord {
  national_id: string;
  given_name: Bilingual;
  family_name: Bilingual;
  gender: string;
  birth_date: string;
  nationality: string;
  marital_status: string;
  address: { city: Bilingual; district: Bilingual; street: string };
  phone?: string;
  status: string;
  family: { national_id: string; relation: string; name: Bilingual }[];
}

/** Reads the citizen's record from the Civil Registry — through Jisr, so it is audited. */
export function readCivilRecord(nationalId: string, purpose: string, extra: { consentId?: string; onBehalfOf?: string } = {}) {
  return jisrCall<CivilRecord>({
    target: 'civil-registry', method: 'GET', path: `/x/persons/${nationalId}`,
    purpose, subject: nationalId, consentId: extra.consentId, onBehalfOf: extra.onBehalfOf ?? 'self',
  });
}

export const fullName = (r: CivilRecord): Bilingual => ({
  ar: `${r.given_name.ar} ${r.family_name.ar}`,
  en: `${r.given_name.en} ${r.family_name.en}`,
});

/** Every claim Mithaq can attest about a person. Derived proofs (age_over_*) never reveal the date. */
export function claimsFromRecord(r: CivilRecord): Record<string, unknown> {
  const age = ageOn(r.birth_date);
  return {
    national_id: r.national_id,
    full_name: fullName(r),
    given_name: r.given_name,
    family_name: r.family_name,
    age_over_18: age >= 18,
    age_over_21: age >= 21,
    birth_date: r.birth_date,
    nationality: r.nationality,
    gender: r.gender,
    marital_status: r.marital_status,
    address_city: r.address.city,
    address_full: { city: r.address.city, district: r.address.district, street: r.address.street },
  };
}

export interface CitizenKey { publicJwk: JWK; privateKey: CryptoKey; kid: string }

/** Is the citizen's key on their own device? (then Mithaq has no private key and cannot sign for them) */
export async function isDeviceBound(db: Db, subject: string): Promise<boolean> {
  return !!(await db.query('SELECT 1 FROM citizen_keys WHERE subject = $1 AND device_bound', [subject])).rowCount;
}

/** A citizen's public key by key id — current or retired (so old signatures stay verifiable). */
export async function publicKeyByKid(db: Db, kid: string): Promise<{ subject: string; jwk: JWK; device_bound: boolean } | null> {
  const subject = kid.startsWith('citizen:') ? kid.slice(8).split('#')[0]! : null;
  if (!subject) return null;
  const cur = (await db.query("SELECT public_jwk, device_bound FROM citizen_keys WHERE subject = $1 AND public_jwk->>'kid' = $2", [subject, kid])).rows[0];
  if (cur) return { subject, jwk: cur.public_jwk, device_bound: cur.device_bound };
  const old = (await db.query('SELECT public_jwk, device_bound FROM citizen_key_history WHERE kid = $1', [kid])).rows[0];
  return old ? { subject, jwk: old.public_jwk, device_bound: old.device_bound } : null;
}

/** Returns (creating on first use) the citizen's server-held ("cloud wallet") Ed25519 key pair. */
export async function citizenKey(db: Db, subject: string): Promise<CitizenKey> {
  let row = (await db.query('SELECT public_jwk, private_enc, device_bound FROM citizen_keys WHERE subject = $1', [subject])).rows[0];
  if (row?.device_bound) {
    throw httpError(409, 'device_key', 'This citizen keeps their private key on their own device; Mithaq cannot sign for them');
  }
  if (!row) {
    const { privateKey } = await generateKeyPair('EdDSA', { extractable: true });
    const priv = await exportJWK(privateKey);
    const { d: _d, ...pub } = priv;
    const kid = `citizen:${subject}`;
    await db.query(
      'INSERT INTO citizen_keys (subject, public_jwk, private_enc) VALUES ($1, $2, $3) ON CONFLICT (subject) DO NOTHING',
      [subject, { ...pub, kid, alg: 'EdDSA' }, encryptSecret(JSON.stringify(priv))],
    );
    row = (await db.query('SELECT public_jwk, private_enc FROM citizen_keys WHERE subject = $1', [subject])).rows[0];
  }
  const priv = JSON.parse(decryptSecret(row.private_enc));
  return { publicJwk: row.public_jwk, privateKey: (await importJWK(priv, 'EdDSA')) as CryptoKey, kid: row.public_jwk.kid };
}
