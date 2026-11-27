import { createHash, randomBytes, createCipheriv, createDecipheriv, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { importJWK, type JWK, type CryptoKey } from 'jose';
import { memberById, type MemberClass, type Bilingual } from './catalog.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const b64url = (buf: Buffer | Uint8Array | string) => Buffer.from(buf).toString('base64url');
export const sha256 = (data: string | Buffer | Uint8Array) => createHash('sha256').update(data).digest();
export const sha256hex = (data: string | Buffer | Uint8Array) => createHash('sha256').update(data).digest('hex');
export const randomId = (bytes = 16) => randomBytes(bytes).toString('base64url');

// ---------- Service (Jisr member) keys ----------

export interface TrustedMember {
  id: string;
  class: MemberClass;
  sector: string;
  name: Bilingual;
  jwk: JWK;
}

let trustCache: Record<string, TrustedMember> | null = null;

/** The trust list is provisioned by the "central authority" (scripts/init-secrets.ts). */
export function trustList(): Record<string, TrustedMember> {
  if (!trustCache) {
    const path = process.env.TRUST_LIST ?? '/trust/members.json';
    trustCache = JSON.parse(readFileSync(path, 'utf8')).members;
  }
  return trustCache!;
}

const pubKeyCache = new Map<string, CryptoKey>();
export async function memberPublicKey(memberId: string): Promise<CryptoKey> {
  const cached = pubKeyCache.get(memberId);
  if (cached) return cached;
  const m = trustList()[memberId];
  if (!m) throw new Error(`unknown member ${memberId}`);
  const key = (await importJWK(m.jwk, 'EdDSA')) as CryptoKey;
  pubKeyCache.set(memberId, key);
  return key;
}

export interface OwnKey { memberId: string; kid: string; key: CryptoKey; publicJwk: JWK }
let ownKey: OwnKey | null = null;

/** Loads this service's private key (mounted read-only at /keys/private.jwk.json). */
export async function loadOwnKey(): Promise<OwnKey> {
  if (ownKey) return ownKey;
  const memberId = process.env.MEMBER_ID;
  if (!memberId || !memberById(memberId)) throw new Error('MEMBER_ID env missing or unknown');
  const path = process.env.PRIVATE_KEY ?? '/keys/private.jwk.json';
  const jwk = JSON.parse(readFileSync(path, 'utf8')) as JWK;
  const key = (await importJWK(jwk, 'EdDSA')) as CryptoKey;
  const { d: _d, ...publicJwk } = jwk;
  ownKey = { memberId, kid: jwk.kid ?? memberId, key, publicJwk };
  return ownKey;
}

// ---------- Passwords ----------

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(pw, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

// ---------- Envelope encryption for citizen private keys ----------

function masterKey(): Buffer {
  const b64 = process.env.MASTER_KEY;
  if (!b64) throw new Error('MASTER_KEY env missing');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('MASTER_KEY must be 32 bytes (base64)');
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', masterKey(), iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${ct.toString('base64url')}.${c.getAuthTag().toString('base64url')}`;
}

export function decryptSecret(blob: string): string {
  const [v, iv, ct, tag] = blob.split('.');
  if (v !== 'v1' || !iv || !ct || !tag) throw new Error('bad secret blob');
  const d = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
