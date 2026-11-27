// Minimal SD-JWT (Selective Disclosure JWT, IETF RFC 9901) with Key Binding.
//
//   issuer-signed JWT  ~ disclosure ~ disclosure ~ ... ~ KB-JWT
//
// * Each selectively-disclosable claim becomes a "disclosure": base64url(JSON [salt, name, value]).
// * The issuer signs only the SHA-256 digests of the disclosures (in "_sd"), never the values.
// * The holder reveals a SUBSET of disclosures. The verifier can check each revealed one
//   against the signed digests, but learns nothing about the hidden ones.
// * The Key-Binding JWT is signed by the holder's key (bound in "cnf") over the verifier's
//   audience + nonce + a hash of the presentation, so it can't be replayed elsewhere.

import { SignJWT, jwtVerify, decodeJwt, importJWK, type JWK, type CryptoKey } from 'jose';
import { randomBytes } from 'node:crypto';
import { b64url, sha256 } from './crypto.ts';

export const PID_VCT = 'urn:sarab:credential:pid:1';

const digestOf = (disclosure: string) => b64url(sha256(disclosure));

export interface IssueInput {
  issuer: string;
  issuerKid: string;
  issuerKey: CryptoKey;
  holderPublicJwk: JWK;
  /** all of these become selectively disclosable */
  claims: Record<string, unknown>;
  vct?: string;
  ttlSeconds?: number;
}

export async function issueSdJwt(input: IssueInput): Promise<string> {
  const disclosures: string[] = [];
  for (const [name, value] of Object.entries(input.claims)) {
    const salt = randomBytes(16).toString('base64url');
    disclosures.push(b64url(JSON.stringify([salt, name, value])));
  }
  // Digests are sorted so their order leaks nothing about claim order.
  const _sd = disclosures.map(digestOf).sort();
  const jwt = await new SignJWT({ vct: input.vct ?? PID_VCT, _sd, _sd_alg: 'sha-256', cnf: { jwk: input.holderPublicJwk } })
    .setProtectedHeader({ alg: 'EdDSA', kid: input.issuerKid, typ: 'dc+sd-jwt' })
    .setIssuer(input.issuer)
    .setIssuedAt()
    .setExpirationTime(`${input.ttlSeconds ?? 3600}s`)
    .sign(input.issuerKey);
  return `${jwt}~${disclosures.join('~')}~`;
}

export function parseDisclosure(d: string): { salt: string; name: string; value: unknown } {
  const arr = JSON.parse(Buffer.from(d, 'base64url').toString('utf8'));
  if (!Array.isArray(arr) || arr.length !== 3) throw new Error('bad disclosure');
  return { salt: arr[0], name: arr[1], value: arr[2] };
}

export interface PresentInput {
  sdJwt: string;
  reveal: string[];
  holderKey: CryptoKey;
  audience: string;
  nonce: string;
}

/** Holder: keep only the disclosures for `reveal`, then append a Key-Binding JWT. */
export async function presentSdJwt(p: PresentInput): Promise<string> {
  const [jwt, ...rest] = p.sdJwt.split('~');
  const kept = rest.filter(Boolean).filter((d) => p.reveal.includes(parseDisclosure(d).name));
  const unbound = `${jwt}~${kept.map((d) => `${d}~`).join('')}`;
  const kb = await new SignJWT({ nonce: p.nonce, sd_hash: b64url(sha256(unbound)) })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'kb+jwt' })
    .setAudience(p.audience)
    .setIssuedAt()
    .sign(p.holderKey);
  return unbound + kb;
}

export interface VerifiedPresentation {
  issuer: string;
  vct: string;
  issuedAt: number;
  /** only the claims the holder chose to reveal */
  claims: Record<string, unknown>;
  holderJwk: JWK;
  /** number of digests in the credential that stayed hidden */
  undisclosedCount: number;
}

/** Verifier: check issuer signature, each disclosure digest, and the key binding. */
export async function verifySdJwtPresentation(
  presentation: string,
  opts: { resolveIssuerKey: (iss: string, kid?: string) => Promise<CryptoKey>; audience: string; nonce: string; maxKbAgeSeconds?: number },
): Promise<VerifiedPresentation> {
  const parts = presentation.split('~');
  if (parts.length < 2) throw new Error('not an SD-JWT presentation');
  const jwt = parts[0]!;
  const kbJwt = parts[parts.length - 1]!;
  const disclosures = parts.slice(1, -1).filter(Boolean);
  if (!kbJwt) throw new Error('key binding JWT missing');

  const iss = decodeJwt(jwt).iss;
  if (!iss) throw new Error('issuer missing');
  const { payload, protectedHeader } = await jwtVerify(jwt, (h) => opts.resolveIssuerKey(iss, h.kid), { typ: 'dc+sd-jwt' });
  if (protectedHeader.alg !== 'EdDSA') throw new Error('unexpected alg');
  if (payload._sd_alg !== 'sha-256') throw new Error('unsupported _sd_alg');
  const digests = new Set(payload._sd as string[]);

  const claims: Record<string, unknown> = {};
  for (const d of disclosures) {
    if (!digests.has(digestOf(d))) throw new Error('disclosure not signed by issuer');
    const { name, value } = parseDisclosure(d);
    if (name in claims) throw new Error('duplicate disclosure');
    claims[name] = value;
  }

  const holderJwk = (payload.cnf as any)?.jwk as JWK;
  if (!holderJwk) throw new Error('credential is not holder-bound');
  // Holder keys: Ed25519 (server-held "cloud wallet") or P-256 (device-held, generated in the browser).
  const holderAlg = holderJwk.kty === 'EC' && holderJwk.crv === 'P-256' ? 'ES256' : holderJwk.kty === 'OKP' && holderJwk.crv === 'Ed25519' ? 'EdDSA' : null;
  if (!holderAlg) throw new Error('unsupported holder key');
  const holderKey = (await importJWK(holderJwk, holderAlg)) as CryptoKey;
  const { payload: kb } = await jwtVerify(kbJwt, holderKey, {
    algorithms: [holderAlg],
    typ: 'kb+jwt',
    audience: opts.audience,
    maxTokenAge: `${opts.maxKbAgeSeconds ?? 300}s`,
  });
  if (kb.nonce !== opts.nonce) throw new Error('nonce mismatch');
  const unbound = presentation.slice(0, presentation.length - kbJwt.length);
  if (kb.sd_hash !== b64url(sha256(unbound))) throw new Error('sd_hash mismatch');

  return {
    issuer: iss,
    vct: payload.vct as string,
    issuedAt: payload.iat as number,
    claims,
    holderJwk,
    undisclosedCount: digests.size - disclosures.length,
  };
}
