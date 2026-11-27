// Sessions are short-lived EdDSA JWTs issued by Mithaq (identity). Any service can verify them
// with Mithaq's public key from the trust list, without calling Mithaq.

import { SignJWT, jwtVerify } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { loadOwnKey, memberPublicKey, randomId } from './crypto.ts';
import { httpError } from './http.ts';
import type { Bilingual } from './catalog.ts';

export type Role = 'citizen' | 'employee' | 'admin';

export interface Session {
  sub: string; // national ID for citizens, "staff:<username>" for staff
  role: Role;
  name: Bilingual;
  /** authentication methods: "pwd", "otp", "hwk" (passkey) */
  amr: string[];
  auth_time: number;
  sid: string;
  /** expiry (unix seconds) — lets clients warn before the session ends (WCAG 2.2.1) */
  exp?: number;
}

export const SESSION_COOKIE = 'sarab_session';
export const SESSION_TTL_SECONDS = 30 * 60;

/** Only Mithaq calls this (it holds the signing key). */
/** Absolute cap: a session can be extended ("stay signed in") but never beyond this since sign-in. */
export const SESSION_MAX_SECONDS = 12 * 60 * 60;

export async function issueSession(s: Omit<Session, 'sid' | 'auth_time' | 'exp'> & { sid?: string; auth_time?: number }): Promise<{ token: string; session: Session }> {
  const own = await loadOwnKey();
  const now = Math.floor(Date.now() / 1000);
  const session: Session = { ...s, sid: s.sid ?? randomId(), auth_time: s.auth_time ?? now };
  session.exp = Math.min(now + SESSION_TTL_SECONDS, session.auth_time + SESSION_MAX_SECONDS);
  const token = await new SignJWT({ role: session.role, name: session.name, amr: session.amr, auth_time: session.auth_time, sid: session.sid })
    .setProtectedHeader({ alg: 'EdDSA', kid: own.kid, typ: 'session+jwt' })
    .setIssuer('mithaq')
    .setAudience('sarab')
    .setSubject(session.sub)
    .setIssuedAt()
    .setExpirationTime(session.exp)
    .sign(own.key);
  return { token, session };
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: process.env.COOKIE_SECURE !== 'false',
    sameSite: 'strict',
    maxAge: SESSION_TTL_SECONDS,
  });
}

/**
 * Optional extra check (Mithaq installs one that consults its session list, so revoked sessions are
 * refused even by Mithaq's own routes; every other service is protected by the gateway's check).
 */
let validator: ((s: Session) => Promise<boolean>) | null = null;
export function setSessionValidator(fn: (s: Session) => Promise<boolean>): void { validator = fn; }

export async function readSession(req: FastifyRequest): Promise<Session | null> {
  const s = await verifySessionToken(req);
  if (s && validator && !(await validator(s))) return null;
  return s;
}

/** Signature/expiry check only (no revocation check). */
export async function verifySessionToken(req: FastifyRequest): Promise<Session | null> {
  // Browsers: HttpOnly cookie. Native apps: "Authorization: Bearer" or, while the demo sits
  // behind HTTP basic auth (which occupies Authorization), the X-Sarab-Session header.
  const auth = req.headers.authorization;
  const header = req.headers['x-sarab-session'];
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : typeof header === 'string' && header ? header : req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, await memberPublicKey('mithaq'), {
      issuer: 'mithaq',
      audience: 'sarab',
      typ: 'session+jwt',
    });
    return {
      sub: payload.sub!,
      role: payload.role as Role,
      name: payload.name as Bilingual,
      amr: payload.amr as string[],
      auth_time: payload.auth_time as number,
      sid: payload.sid as string,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

export async function requireSession(req: FastifyRequest, roles?: Role[]): Promise<Session> {
  const s = await readSession(req);
  if (!s) throw httpError(401, 'not_authenticated', 'Please sign in');
  if (roles && !roles.includes(s.role)) throw httpError(403, 'forbidden', 'Your role cannot use this function');
  return s;
}
