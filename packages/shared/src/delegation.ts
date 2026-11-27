// Act-as tokens: proof that a delegate may act for someone else, for a given scope.
// Issued by Mithaq (which holds the delegation, itself a mandate signed with the grantor's own key),
// short-lived, audience-restricted, and checked twice: by Jisr (on every delegated-service exchange)
// and by the target service (scope + subject). Modelled on the `act` claim of OAuth token exchange (RFC 8693).
import { SignJWT, jwtVerify } from 'jose';
import { loadOwnKey, memberPublicKey } from './crypto.ts';
import { httpError } from './http.ts';

export interface ActClaims {
  /** the person being represented (grantor) */
  sub: string;
  /** who is acting: a delegate (national ID) or a service-centre employee (employee ID) */
  act: { sub: string; kind: 'delegate' | 'employee' };
  scope: string[];
  /** delegation id */
  delegation_id: string;
  /** the member the token is for */
  aud: string;
}

export async function issueActToken(a: { grantor: string; delegate: string; scopes: string[]; delegationId: string; audience: string; kind?: 'delegate' | 'employee' }): Promise<string> {
  const own = await loadOwnKey();
  if (own.memberId !== 'mithaq') throw new Error('only Mithaq issues act-as tokens');
  return new SignJWT({ act: { sub: a.delegate, kind: a.kind ?? 'delegate' }, scope: a.scopes, delegation_id: a.delegationId })
    .setProtectedHeader({ alg: 'EdDSA', kid: own.kid, typ: 'sarab-act+jwt' })
    .setIssuer('mithaq').setSubject(a.grantor).setAudience(a.audience)
    .setIssuedAt().setExpirationTime('120s')
    .sign(own.key);
}

/** Verifies signature, audience and that it represents `subject`; returns the claims. */
export async function verifyActToken(token: string | undefined, expect: { subject: string; audience: string; scope?: string }): Promise<ActClaims> {
  if (!token) throw httpError(403, 'mandate_required', 'Acting for someone else needs a delegation mandate');
  let payload: any;
  try {
    ({ payload } = await jwtVerify(token, await memberPublicKey('mithaq'), { issuer: 'mithaq', audience: expect.audience, typ: 'sarab-act+jwt' }));
  } catch (e) {
    throw httpError(403, 'mandate_invalid', `Invalid delegation mandate: ${(e as Error).message}`);
  }
  if (payload.sub !== expect.subject) throw httpError(403, 'mandate_subject_mismatch', 'The mandate is for a different person');
  if (expect.scope && !(payload.scope as string[]).includes(expect.scope)) {
    throw httpError(403, 'mandate_scope', `The mandate does not cover "${expect.scope}"`);
  }
  return payload as ActClaims;
}

export const delegateTag = (nationalId: string) => `delegate:${nationalId}`;
export const employeeTag = (employeeId: string) => `employee:${employeeId}`;
/** The on_behalf_of value an act-as token entitles its holder to use. */
export const actorTag = (act: ActClaims['act']) => `${act.kind ?? 'delegate'}:${act.sub}`;
