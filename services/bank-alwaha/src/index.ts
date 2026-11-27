// Bank Al-Waha — FICTIONAL private-sector demo. Opens an account with NO forms:
// identity verification (Mithaq) + citizen consent (Idhn) + a verified SD-JWT proof.
import { randomInt } from 'node:crypto';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { createService, start, httpError, HttpError } from '#shared/http.ts';
import { createDb, migrate } from '#shared/db.ts';
import { memberPublicKey, randomId, trustList } from '#shared/crypto.ts';
import { jisrCall } from '#shared/jisr.ts';
import { verifySdJwtPresentation, parseDisclosure } from '#shared/sdjwt.ts';
import { CLAIMS, CREDENTIALS } from '#shared/catalog.ts';

const db = createDb();
await migrate(db, new URL('./schema.sql', import.meta.url));

const app = await createService({
  prefix: 'bank',
  title: 'Bank Al-Waha (fictional demo bank)',
  description: 'A private-sector relying party: opens accounts using only Mithaq identity + Idhn consent + selective-disclosure proofs. It never sees data the citizen did not approve.',
});

const ME = 'bank-alwaha';
const FLOW_COOKIE = 'alwaha_flow';
const CUSTOMER_COOKIE = 'alwaha_customer';
const cookieOpts = { path: '/api/bank', httpOnly: true, secure: process.env.COOKIE_SECURE !== 'false', sameSite: 'lax' as const, maxAge: 3600 };

const SCENARIOS: Record<string, string[]> = {
  // What the bank needs for KYC — all within the regulator's allow-list.
  standard: ['full_name', 'national_id', 'age_over_18', 'address_city', 'employment_status', 'income_bracket'],
  // A greedy bank also asks for birth date, marital status and the exact salary → automatically rejected.
  overreach: ['full_name', 'national_id', 'birth_date', 'marital_status', 'address_city', 'monthly_income'],
};

app.post('/api/bank/onboarding/start', {
  schema: {
    tags: ['onboarding'], summary: 'Start account opening: ask the citizen (via Idhn) for KYC claims',
    body: { type: 'object', properties: { scenario: { type: 'string', enum: Object.keys(SCENARIOS), default: 'standard' } } },
  },
}, async (req, reply) => {
  const { scenario } = (req.body ?? { scenario: 'standard' }) as { scenario: string };
  const claims = SCENARIOS[scenario] ?? SCENARIOS.standard!;
  const id = randomId(12);
  const nonce = randomId(16); // fixed now, so a citizen's device can bind its proof to it at approval
  try {
    const out = await jisrCall<{ request_id: string; consent_url: string }>({
      target: 'idhn', method: 'POST', path: '/x/requests', purpose: 'account-opening',
      body: { claims, return_url: '/bank/callback', validity_days: 365, nonce },
    });
    await db.query("INSERT INTO onboardings (id, request_id, scenario, status, nonce) VALUES ($1,$2,$3,'started',$4)", [id, out.request_id, scenario, nonce]);
    reply.setCookie(FLOW_COOKIE, id, cookieOpts);
    return { status: 'redirect', redirect: out.consent_url, requested_claims: claims };
  } catch (e) {
    if (e instanceof HttpError && e.code === 'rejected_by_policy') {
      await db.query("INSERT INTO onboardings (id, scenario, status, detail) VALUES ($1,$2,'rejected_by_policy',$3)", [id, scenario, { message: e.message }]);
      return { status: 'rejected_by_policy', message: e.message, requested_claims: claims, details: e.details };
    }
    throw e;
  }
});

const accountNumber = () => `SRB${String(randomInt(10, 99))} WAHA ${String(randomInt(1000, 9999))} ${String(randomInt(1000, 9999))} ${String(randomInt(1000, 9999))}`;

// Which authority the bank trusts for which credential type (from the national trust framework).
const TRUSTED_ISSUER: Record<string, string> = Object.fromEntries(Object.values(CREDENTIALS).map((c) => [c.vct, c.issuer]));

interface Presented { credential: string; vct: string; issuer: string; presentation: string }

/** Ask Idhn (through Jisr) for fresh proofs, then verify every one cryptographically. */
async function fetchAndVerify(consentId: string, purpose: 'account-opening' | 'kyc-refresh', fixedNonce?: string, requestId?: string) {
  const nonce = fixedNonce ?? randomId(16);
  const out = await jisrCall<{ presentations: Presented[]; consent: any }>({
    target: 'idhn', method: 'GET', path: `/x/consents/${encodeURIComponent(consentId)}/presentation?nonce=${nonce}${requestId ? `&request_id=${encodeURIComponent(requestId)}` : ''}`,
    purpose, consentId,
  });
  const claims: Record<string, unknown> = {};
  const inspection = [];
  let holder: string | null = null;
  for (const p of out.presentations) {
    const verified = await verifySdJwtPresentation(p.presentation, {
      audience: ME, nonce,
      resolveIssuerKey: async (iss) => {
        const m = trustList()[iss];
        if (!m || m.class !== 'GOV') throw new Error(`untrusted issuer ${iss}`);
        return memberPublicKey(iss);
      },
    });
    // Trust framework: each credential type has exactly one authoritative issuer.
    if (TRUSTED_ISSUER[verified.vct] !== verified.issuer) throw httpError(502, 'wrong_issuer', `${verified.issuer} is not authorised to issue ${verified.vct}`);
    // All credentials must be bound to the SAME citizen key (no mixing two people's proofs).
    const thumb = JSON.stringify(verified.holderJwk);
    if (holder && holder !== thumb) throw httpError(502, 'holder_mismatch', 'Credentials are bound to different holders');
    holder = thumb;
    Object.assign(claims, verified.claims);
    const [jwt, ...rest] = p.presentation.split('~');
    const kb = rest.pop()!;
    inspection.push({
      credential: p.credential,
      issuer: verified.issuer,
      vct: verified.vct,
      issuer_header: decodeProtectedHeader(jwt!),
      issuer_payload: decodeJwt(jwt!),
      disclosures: rest.filter(Boolean).map((d) => ({ encoded: d, decoded: parseDisclosure(d) })),
      key_binding_header: decodeProtectedHeader(kb),
      key_binding_payload: decodeJwt(kb),
      undisclosed_digests: verified.undisclosedCount,
    });
  }
  return { claims, consent: out.consent, inspection };
}

app.post('/api/bank/onboarding/complete', {
  schema: {
    tags: ['onboarding'], summary: 'Finish account opening after the citizen approved (verifies the SD-JWT proof)',
    body: { type: 'object', required: ['request_id'], properties: { request_id: { type: 'string' }, consent_id: { type: 'string' }, error: { type: 'string' } } },
  },
}, async (req, reply) => {
  const { request_id, consent_id, error } = req.body as { request_id: string; consent_id?: string; error?: string };
  const flow = (await db.query('SELECT * FROM onboardings WHERE request_id = $1', [request_id])).rows[0];
  if (!flow || flow.id !== req.cookies[FLOW_COOKIE]) throw httpError(400, 'unknown_flow', 'This account-opening session was not started in this browser');
  if (flow.status !== 'started') throw httpError(409, 'already_finished', 'This account-opening session is already finished');
  if (error || !consent_id) {
    await db.query("UPDATE onboardings SET status = 'declined' WHERE id = $1", [flow.id]);
    return { status: 'declined' };
  }

  const { claims, consent, inspection } = await fetchAndVerify(consent_id, 'account-opening', flow.nonce ?? undefined, flow.request_id).catch(async (e) => {
    if (e instanceof HttpError && e.code === 'consent_mismatch') await db.query("UPDATE onboardings SET status = 'declined', detail = $2 WHERE id = $1", [flow.id, { reason: 'consent_mismatch' }]);
    throw e;
  });
  // The consent must be the answer to THIS browser's request — not another flow's (red-team finding).
  if (consent?.request_id !== flow.request_id) {
    await db.query("UPDATE onboardings SET status = 'declined', detail = $2 WHERE id = $1", [flow.id, { reason: 'consent_mismatch' }]);
    throw httpError(400, 'consent_mismatch', 'This consent was given for a different request');
  }
  const c = claims as any;
  const received = Object.keys(c);
  const notReceived = CLAIMS.map((x) => x.name).filter((n) => !received.includes(n));

  if (c.age_over_18 !== true) {
    await db.query("UPDATE onboardings SET status = 'refused', detail = $2 WHERE id = $1", [flow.id, { reason: 'under_18' }]);
    return { status: 'refused', reason: 'under_18', received_claims: c, not_received: notReceived, inspection };
  }
  const existing = (await db.query('SELECT * FROM customers WHERE national_id = $1', [c.national_id])).rows[0];
  const account = existing?.account_number ?? accountNumber();
  await db.query(
    `INSERT INTO customers (account_number, national_id, full_name, city, consent_id, employment_status, income_bracket) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (national_id) DO UPDATE SET full_name = EXCLUDED.full_name, city = EXCLUDED.city, consent_id = EXCLUDED.consent_id,
       employment_status = EXCLUDED.employment_status, income_bracket = EXCLUDED.income_bracket, last_kyc_at = now(), kyc_status = 'verified'`,
    [account, c.national_id, c.full_name, c.address_city ?? null, consent_id, c.employment_status ?? null, c.income_bracket ?? null],
  );
  await db.query("UPDATE onboardings SET status = 'completed', detail = $2 WHERE id = $1", [flow.id, { account }]);
  reply.clearCookie(FLOW_COOKIE, { path: '/api/bank' });
  reply.setCookie(CUSTOMER_COOKIE, account, { ...cookieOpts, maxAge: 30 * 24 * 3600 });
  return {
    status: existing ? 'already_customer' : 'opened',
    account: { number: account, name: c.full_name, city: c.address_city, opened_at: existing?.opened_at ?? new Date().toISOString() },
    received_claims: c, not_received: notReceived, consent, inspection,
  };
});

app.get('/api/bank/me', { schema: { tags: ['customer'], summary: 'The customer account remembered in this browser (demo)' } }, async (req) => {
  const acct = req.cookies[CUSTOMER_COOKIE];
  if (!acct) return { customer: null };
  const r = (await db.query('SELECT account_number, full_name, city, employment_status, income_bracket, opened_at, last_kyc_at, kyc_status, consent_id FROM customers WHERE account_number = $1', [acct])).rows[0];
  return { customer: r ?? null };
});

app.post('/api/bank/me/kyc-refresh', { schema: { tags: ['customer'], summary: 'Re-check KYC using the existing consent (fails once the citizen revokes it)' } }, async (req) => {
  const acct = req.cookies[CUSTOMER_COOKIE];
  const cust = acct ? (await db.query('SELECT * FROM customers WHERE account_number = $1', [acct])).rows[0] : null;
  if (!cust) throw httpError(404, 'no_customer', 'No account in this browser');
  try {
    const { claims } = await fetchAndVerify(cust.consent_id, 'kyc-refresh');
    const c = claims as any;
    await db.query("UPDATE customers SET city = $2, full_name = $3, employment_status = $4, income_bracket = $5, last_kyc_at = now(), kyc_status = 'verified' WHERE account_number = $1",
      [acct, c.address_city ?? null, c.full_name, c.employment_status ?? null, c.income_bracket ?? null]);
    return { ok: true, received_claims: c };
  } catch (e) {
    if (e instanceof HttpError && e.code === 'citizen_presence_required') {
      // Device-held key: the bank cannot get a fresh proof without the citizen (correct behaviour).
      return { ok: false, reason: e.code, message: e.message };
    }
    if (e instanceof HttpError && ['consent_revoked', 'consent_expired'].includes(e.code)) {
      await db.query("UPDATE customers SET kyc_status = 'consent_revoked' WHERE account_number = $1", [acct]);
      return { ok: false, reason: e.code, message: e.message };
    }
    throw e;
  }
});

app.post('/api/bank/me/forget', { schema: { tags: ['customer'], summary: 'Forget the account in this browser (demo reset)' } }, async (_req, reply) => {
  reply.clearCookie(CUSTOMER_COOKIE, { path: '/api/bank' });
  return { ok: true };
});

await start(app);
