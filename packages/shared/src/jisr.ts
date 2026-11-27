// Jisr (data exchange layer) — client and target-side guard.
//
// Caller side:  service --(signed request JWT)--> Jisr --(signed assertion)--> target service
// - The caller signs {target, method, path, purpose, subject, consent, body hash} with ITS OWN key.
// - Jisr verifies it, checks the access policy, writes the hash-chained audit log, and forwards.
// - The target only accepts /x/* requests that carry a valid assertion signed by Jisr.

import { SignJWT, jwtVerify } from 'jose';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { loadOwnKey, memberPublicKey, randomId, sha256 } from './crypto.ts';
import { httpError } from './http.ts';

export interface JisrCall {
  target: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path on the target service, e.g. /x/persons/1000000016 (may include a query string) */
  path: string;
  purpose: string;
  /** National ID of the citizen whose data is involved (drives "who accessed my data") */
  subject?: string;
  consentId?: string;
  /** Original requester when acting for someone else (e.g. a bank, or "self") */
  onBehalfOf?: string;
  /** Mithaq-signed act-as token when a delegate acts for someone (purpose delegated-service) */
  act?: string;
  body?: unknown;
}

export interface JisrRequestClaims {
  iss: string;
  aud: 'jisr';
  target: string;
  method: string;
  path: string;
  purpose: string;
  sub?: string;
  consent_id?: string;
  on_behalf_of?: string;
  act?: string;
  body_sha256: string;
  jti: string;
}

export const bodyHash = (raw: string) => sha256(raw).toString('base64url');

/** Calls another member THROUGH Jisr. Throws HttpError with the remote error on non-2xx. */
export async function jisrCall<T = any>(call: JisrCall): Promise<T> {
  // Sign the path exactly as it will travel: fetch percent-encodes some characters the caller may have
  // left as they are (e.g. an apostrophe in a name search), which would break the signature check.
  const u = new URL(call.path, 'http://jisr');
  call = { ...call, path: `${u.pathname}${u.search}` };
  const own = await loadOwnKey();
  const raw = call.body === undefined ? '' : JSON.stringify(call.body);
  const claims: Omit<JisrRequestClaims, 'iss' | 'aud'> = {
    target: call.target,
    method: call.method,
    path: call.path,
    purpose: call.purpose,
    sub: call.subject,
    consent_id: call.consentId,
    on_behalf_of: call.onBehalfOf,
    act: call.act,
    body_sha256: bodyHash(raw),
    jti: randomId(),
  };
  const jwt = await new SignJWT(claims as any)
    .setProtectedHeader({ alg: 'EdDSA', kid: own.kid, typ: 'jisr-req+jwt' })
    .setIssuer(own.memberId)
    .setAudience('jisr')
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(own.key);

  const res = await fetch(`${process.env.JISR_URL ?? 'http://jisr:3000'}/x/exchange`, {
    method: 'POST',
    headers: { authorization: `Jisr ${jwt}`, 'content-type': 'application/json' },
    body: raw || undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  // End-to-end response integrity: the TARGET signs status + body hash + request id (Phase 6).
  // Jisr checks it too, but the caller re-verifies so that not even Jisr could alter the answer.
  const requestId = res.headers.get('x-jisr-request-id');
  const responseSig = res.headers.get('x-jisr-response-signature');
  if (responseSig) {
    await verifyResponseSignature(responseSig, { target: call.target, requestId: requestId ?? '', status: res.status, body: text });
  } else if (res.ok) {
    throw httpError(502, 'unsigned_response', `Response from ${call.target} is not signed`, { via: 'jisr', target: call.target, request_id: requestId });
  }
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: 'bad_gateway', message: text.slice(0, 200) }; }
  if (!res.ok) {
    throw httpError(res.status, data?.error ?? 'exchange_error', data?.message ?? `Jisr call failed (${res.status})`, {
      ...(data?.details && typeof data.details === 'object' ? data.details : {}),
      via: 'jisr',
      target: call.target,
      request_id: res.headers.get('x-jisr-request-id'),
    });
  }
  return data as T;
}

/** Verifies a target's response signature (used by Jisr and by every caller). */
export async function verifyResponseSignature(token: string, expect: { target: string; requestId: string; status: number; body: string }): Promise<void> {
  try {
    const { payload } = await jwtVerify(token, await memberPublicKey(expect.target), { issuer: expect.target, typ: 'jisr-resp+jwt', maxTokenAge: '60s' });
    if (payload.request_id !== expect.requestId) throw new Error('request id mismatch');
    if (payload.status !== expect.status) throw new Error('status mismatch');
    if (payload.body_sha256 !== bodyHash(expect.body)) throw new Error('body does not match the signed hash');
  } catch (e) {
    throw httpError(502, 'response_signature_invalid', `Response signature from ${expect.target} is invalid: ${(e as Error).message}`);
  }
}

// ---------------- Target side ----------------

export interface JisrContext {
  requestId: string;
  client: string;
  purpose: string;
  subject?: string;
  consentId?: string;
  onBehalfOf?: string;
  act?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    jisr: JisrContext | null;
    rawBody?: string;
  }
}

/**
 * Protects every /x/* route: the request must carry an X-Jisr-Assertion signed by Jisr,
 * addressed to this member, for exactly this method + path + body.
 */
export async function installJisrGuard(app: FastifyInstance): Promise<void> {
  const own = await loadOwnKey();
  app.decorateRequest('jisr', null);

  // Sign every response to a Jisr-forwarded request: {request id, status, body hash} with this member's key.
  app.addHook('onSend', async (req, reply, payload) => {
    if (!req.jisr) return payload;
    const body = typeof payload === 'string' ? payload : Buffer.isBuffer(payload) ? payload.toString('utf8') : payload == null ? '' : String(payload);
    const sig = await new SignJWT({ request_id: req.jisr.requestId, status: reply.statusCode, body_sha256: bodyHash(body), method: req.method, path: req.url })
      .setProtectedHeader({ alg: 'EdDSA', kid: own.kid, typ: 'jisr-resp+jwt' })
      .setIssuer(own.memberId).setAudience('jisr').setIssuedAt()
      .sign(own.key);
    reply.header('x-jisr-response-signature', sig);
    return body;
  });

  // preValidation (not preHandler): the caller is authenticated BEFORE its input is validated, so even a
  // validation error is answered to a Jisr-verified request — and signed like any other response.
  app.addHook('preValidation', async (req: FastifyRequest) => {
    if (!req.url.startsWith('/x/')) return;
    const assertion = req.headers['x-jisr-assertion'];
    if (typeof assertion !== 'string') throw httpError(401, 'jisr_required', 'This endpoint is only reachable through Jisr');
    let payload: any;
    try {
      ({ payload } = await jwtVerify(assertion, await memberPublicKey('jisr'), {
        issuer: 'jisr',
        audience: own.memberId,
        typ: 'jisr-fwd+jwt',
        maxTokenAge: '30s',
      }));
    } catch (e) {
      throw httpError(401, 'jisr_invalid', `Invalid Jisr assertion: ${(e as Error).message}`);
    }
    if (payload.method !== req.method || payload.path !== req.url) {
      throw httpError(401, 'jisr_mismatch', 'Assertion does not match this request');
    }
    if (payload.body_sha256 !== bodyHash(req.rawBody ?? '')) {
      throw httpError(401, 'jisr_body_mismatch', 'Body does not match the signed hash');
    }
    req.jisr = {
      requestId: payload.request_id,
      client: payload.client,
      purpose: payload.purpose,
      subject: payload.sub,
      consentId: payload.consent_id,
      onBehalfOf: payload.on_behalf_of,
      act: payload.act,
    };
  });
}

export function requireJisr(req: FastifyRequest): JisrContext {
  if (!req.jisr) throw httpError(401, 'jisr_required', 'This endpoint is only reachable through Jisr');
  return req.jisr;
}
