// End-to-end test of all phases, through the public gateway, like a browser would.
// No dependencies: Node 24 fetch + crypto. Includes a tiny software passkey authenticator.
//   make e2e
import { createHash, createHmac, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:18090';
const ORIGIN = process.env.ORIGIN ?? 'http://localhost:18090';
const RP_ID = new URL(ORIGIN).hostname;
// The demo citizens' shared password comes from .env (make e2e passes it), never from the page: in
// production (DEMO_MODE=false) no page or endpoint shows it.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? '';
const DEMO_MODE = process.env.DEMO_MODE === 'true';
// Staff actions in tests are done by the automated-test account (TEST-0001), never by the administrator.
const TEST_STAFF_PASSWORD = process.env.TEST_STAFF_PASSWORD ?? '';
if (!DEMO_PASSWORD || TEST_STAFF_PASSWORD.length < 12) { console.error('DEMO_PASSWORD / TEST_STAFF_PASSWORD missing: run via make e2e (it reads them from .env)'); process.exit(2); }
// The documented demo citizens (fixed IDs from the deterministic seed, see README).
const PERSONA = { layla: '1100000049', omar: '1100000031', saleh: '1100000015', aminah: '1100000023', yousef: '1100000056', noor: '1100000064' };
// Every one-time code goes to Telegram. A server-minted test ticket (make e2e mints one) makes the API return
// the code as test_code instead, so the tests never send Telegram messages. Without it we refuse to run.
const TEST_TICKET = process.env.TEST_TICKET ?? '';
if (TEST_TICKET.length < 32) { console.error('TEST_TICKET missing: run via make e2e (otherwise every code would go to Telegram)'); process.exit(2); }
const CLERK_PASSWORD = process.env.CLERK_PASSWORD ?? '';
// Every name this run types ends with RUN ("qa" + 6 hex). scripts/test-cleanup.sh finds and deletes
// all of it afterwards (make e2e runs it whether the tests pass or fail).
const RUN = /^qa[0-9a-f]{6}$/.test(process.env.TEST_RUN ?? '') ? process.env.TEST_RUN : `qa${randomBytes(3).toString('hex')}`;


let passed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${extra !== undefined ? ` — ${JSON.stringify(extra).slice(0, 400)}` : ''}`); }
}

/**
 * A "browser": a cookie jar (ignores the Secure flag because we talk plain HTTP locally).
 * Each simulated user gets its own client IP (X-Real-IP, which the gateway trusts only from the local
 * proxy hop — the host's reverse proxy overwrites it for real visitors), so per-IP rate limits apply per user.
 */
let browsers = 0;
class Browser {
  jar = new Map();
  ip = `10.250.${Math.floor(Math.random() * 250)}.${++browsers}`;
  async req(path, { method, body, headers: extra } = {}) {
    const headers = { accept: 'application/json', 'x-real-ip': this.ip, 'x-sarab-test-ticket': TEST_TICKET, ...extra };
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(BASE + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const expired = attrs.some((a) => /max-age=0/i.test(a) || /expires=thu, 01 jan 1970/i.test(a));
      if (!value || expired) this.jar.delete(name); else this.jar.set(name, value);
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data };
  }
  async login(username, password) {
    const a = await this.req('/api/identity/auth/password', { body: { username, password } });
    if (a.status !== 200) return a;
    return this.req('/api/identity/auth/otp', { body: { otp_challenge_id: a.data.otp_challenge_id, code: a.data.test_code } });
  }
}

// ---------- minimal CBOR encoder (enough for WebAuthn "none" attestation) ----------
function cborHead(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
function cbor(v) {
  if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([cborHead(3, b.length), b]); }
  if (v instanceof Uint8Array) return Buffer.concat([cborHead(2, v.length), Buffer.from(v)]);
  if (v instanceof Map) return Buffer.concat([cborHead(5, v.size), ...[...v].flatMap(([k, val]) => [cbor(k), cbor(val)])]);
  throw new Error('cbor: unsupported');
}
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha = (b) => createHash('sha256').update(b).digest();

class SoftAuthenticator {
  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
    this.credId = randomBytes(16);
    this.counter = 0;
  }
  register(options) {
    this.userHandle = options.user.id;
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: ORIGIN, crossOrigin: false }));
    const idLen = Buffer.alloc(2); idLen.writeUInt16BE(this.credId.length);
    const authData = Buffer.concat([sha(RP_ID), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), idLen, this.credId, this.cose]);
    const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return { id: b64u(this.credId), rawId: b64u(this.credId), type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
      response: { clientDataJSON: b64u(clientData), attestationObject: b64u(att), transports: ['internal'] } };
  }
  authenticate(options, { origin = ORIGIN } = {}) {
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }));
    const cnt = Buffer.alloc(4); cnt.writeUInt32BE(++this.counter);
    const authData = Buffer.concat([sha(RP_ID), Buffer.from([0x05]), cnt]);
    const signature = sign('sha256', Buffer.concat([authData, sha(clientData)]), this.privateKey);
    return { id: b64u(this.credId), rawId: b64u(this.credId), type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: this.userHandle } };
  }
}

// ---------- Phase 6: a "device" wallet (WebCrypto, non-extractable P-256 key), as the portal does it ----------
const subtle = globalThis.crypto.subtle;
const enc = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
async function deviceKeyPair() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const { kty, crv, x, y } = await subtle.exportKey('jwk', kp.publicKey);
  return { privateKey: kp.privateKey, publicJwk: { kty, crv, x, y } };
}
async function es256(privateKey, header, payloadString) {
  const input = `${enc(header)}.${enc(payloadString)}`;
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, Buffer.from(input));
  return `${input}.${Buffer.from(sig).toString('base64url')}`;
}
async function devicePresent(sdJwt, reveal, privateKey, aud, nonce) {
  const [jwt, ...rest] = sdJwt.split('~');
  const kept = rest.filter(Boolean).filter((d) => reveal.includes(JSON.parse(Buffer.from(d, 'base64url').toString())[1]));
  const unbound = `${jwt}~${kept.map((d) => `${d}~`).join('')}`;
  const kb = await es256(privateKey, { alg: 'ES256', typ: 'kb+jwt' }, JSON.stringify({ nonce, aud, iat: Math.floor(Date.now() / 1000), sd_hash: sha(unbound).toString('base64url') }));
  return unbound + kb;
}

// ======================================================================
console.log(`\nE2E against ${BASE}\n`);

console.log('Gateway');
const anon = new Browser();
const home = await fetch(BASE + '/');
check('portal is public (no basic-auth prompt)', home.status === 200 && !home.headers.get('www-authenticate'));
check('security headers present (CSP, X-Frame-Options, noindex)', !!home.headers.get('content-security-policy') && home.headers.get('x-frame-options') === 'DENY' && /noindex/.test(home.headers.get('x-robots-tag') ?? ''));
check('internal /x/ routes are not reachable from outside', (await anon.req('/x/exchange', { body: {} })).status !== 200 && (await anon.req('/api/registry/x/persons/1')).status === 404);
const demoRes = await anon.req('/api/identity/demo-accounts');
const sleep0 = (ms) => new Promise((r) => setTimeout(r, ms));
const waitInbox0 = async (who, pred) => waitFor(async () => ((await who.req('/api/identity/me/notifications')).data?.notifications ?? []).some(pred));
async function waitFor(fn, tries = 40) { for (let i = 0; i < tries; i++) { if (await fn()) return true; await sleep0(250); } return false; }
const layla = { username: PERSONA.layla, name: { en: 'Layla Al-Murjani' } }; const yousef = { username: PERSONA.yousef, name: { en: 'Yousef Al-Nakhli' } };
if (DEMO_MODE) {
  check('DEMO_MODE: the demo personas are listed', demoRes.status === 200 && demoRes.data.accounts?.[0]?.username === PERSONA.layla, demoRes.data);
  check('DEMO_MODE: the demo list does NOT include staff', !/admin|clerk|test|ADM-|EMP-|TEST-/.test(JSON.stringify(demoRes.data.accounts)));
} else {
  check('production (DEMO_MODE=false): no endpoint serves the demo accounts or their password', demoRes.status === 404 && !JSON.stringify(demoRes.data ?? '').includes(DEMO_PASSWORD), demoRes.status);
  check('production: the portal is told demo mode is off (and nothing else)', JSON.stringify((await anon.req('/api/identity/portal-config')).data) === '{"demo_mode":false}');
  const portalJs = await (async () => { const html = await (await fetch(BASE + '/')).text(); const src = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1]; return src ? (await fetch(BASE + src)).text() : ''; })();
  check('production: the portal code does not contain the demo password', portalJs.length > 1000 && !portalJs.includes(DEMO_PASSWORD));
}

console.log('Identity (fallback login)');
const L = new Browser();
check('wrong password is rejected', (await L.req('/api/identity/auth/password', { body: { username: layla.username, password: 'nope' } })).status === 401);
{ // Per-account brake (red-team D): after 5 wrong passwords each attempt waits 1–5 s, from any address. Never a lock.
  // On a username that has no account (the brake works the same, so it does not reveal who exists).
  const ghost = `ghost-${Math.random().toString(16).slice(2, 10)}`;
  const ms = [];
  for (let i = 0; i < 7; i++) { const t0 = Date.now(); const r = await new Browser().req('/api/identity/auth/password', { body: { username: ghost, password: `wrong${i}` } }); ms.push(r.status === 401 ? Date.now() - t0 : -r.status); }
  check('per-account brake: 5 wrong passwords are answered at once, then each further one waits (1 s, 2 s …)', ms.slice(0, 5).every((m) => m >= 0 && m < 900) && ms[5] >= 900 && ms[6] >= 1900, ms);
}
const ls = await L.login(layla.username, DEMO_PASSWORD);
check('password + OTP login works', ls.status === 200 && ls.data.session.sub === layla.username, ls);
check('session carries the name from the Civil Registry', ls.data?.session?.name?.en === layla.name.en, ls.data?.session);
const rf = await L.req('/api/identity/session/refresh', { body: {} });
check('"stay signed in" extends the session, keeping sign-in time and session id', rf.status === 200 && rf.data.session.exp >= ls.data.session.exp && rf.data.session.auth_time === ls.data.session.auth_time && rf.data.session.sid === ls.data.session.sid, rf.data);
check('refresh needs a session', (await anon.req('/api/identity/session/refresh', { body: {} })).status === 401);
const rec = await L.req('/api/identity/me/record');
check('citizen can read own civil record (via Jisr)', rec.status === 200 && rec.data.national_id === layla.username && rec.data.family.length > 0, rec);

console.log('Bank Al-Waha: standard account opening');
const start = await L.req('/api/bank/onboarding/start', { body: { scenario: 'standard' } });
check('bank creates a consent request', start.data?.status === 'redirect' && start.data.redirect.startsWith('/consent/'), start);
const reqId = start.data.redirect.split('/').pop();
const view = await L.req(`/api/consent/requests/${reqId}`);
check('citizen sees exactly the requested claims', view.status === 200 && view.data.claims.map((c) => c.name).sort().join() === 'address_city,age_over_18,employment_status,full_name,income_bracket,national_id', view.data);
check('consent screen says birth date and exact salary will NOT be shared', ['birth_date', 'monthly_income'].every((n) => view.data.not_requested?.some((c) => c.name === n)));
const appr = await L.req(`/api/consent/requests/${reqId}/approve`, { method: 'POST', body: {} });
check('approve returns redirect to the bank with a consent id', appr.status === 200 && /\/bank\/callback\?request=.+&consent=.+/.test(appr.data.redirect), appr);
const consentId = new URL(appr.data.redirect, BASE).searchParams.get('consent');
const done = await L.req('/api/bank/onboarding/complete', { body: { request_id: reqId, consent_id: consentId } });
check('account opened (or refreshed on re-run)', ['opened', 'already_customer'].includes(done.data?.status) && /^SRB\d\d WAHA/.test(done.data.account.number), done);
const got = Object.keys(done.data?.received_claims ?? {}).sort().join();
check('bank received ONLY the approved claims', got === 'address_city,age_over_18,employment_status,full_name,income_bracket,national_id', got);
check('bank got age_over_18 = true, not a birth date', done.data?.received_claims?.age_over_18 === true && !('birth_date' in (done.data?.received_claims ?? {})));
check('bank got an income BRACKET, never the exact salary', done.data?.received_claims?.income_bracket?.en === '10,000 – 20,000 SRD' && !('monthly_income' in (done.data?.received_claims ?? {})), done.data?.received_claims);
const ins = done.data?.inspection ?? [];
check('two independent proofs: PID signed by Mithaq, employment signed by Labor', ins.length === 2 && ins[0].issuer === 'mithaq' && ins[1].issuer === 'labor', ins.map((i) => i.issuer));
check('SD-JWT kept the other claims hidden (8 of 12 PID, 2 of 4 employment)', ins[0]?.undisclosed_digests === 8 && ins[1]?.undisclosed_digests === 2, ins.map((i) => i.undisclosed_digests));
check('both proofs are bound to the same citizen key', JSON.stringify(ins[0]?.issuer_payload?.cnf) === JSON.stringify(ins[1]?.issuer_payload?.cnf));
check('presentations are holder-bound (KB-JWT aud = bank)', ins.every((i) => i.key_binding_payload?.aud === 'bank-alwaha'));
const replay = await L.req('/api/bank/onboarding/complete', { body: { request_id: reqId, consent_id: consentId } });
check('replaying the callback is refused', [400, 409].includes(replay.status), replay);
const kyc1 = await L.req('/api/bank/me/kyc-refresh', { method: 'POST', body: {} });
check('KYC refresh works while consent is active', kyc1.data?.ok === true, kyc1);

console.log('Regulator policy');
const over = await L.req('/api/bank/onboarding/start', { body: { scenario: 'overreach' } });
const rejected = (over.data?.details?.rejected_claims ?? []).map((c) => c.name).sort().join();
check('over-reaching request is rejected automatically (birth date, marital status, exact salary)', over.data?.status === 'rejected_by_policy' && rejected === 'birth_date,marital_status,monthly_income', over.data);

console.log('Phase 2 ministries (citizen self-service, each via Jisr)');
const edu = await L.req('/api/identity/me/education');
check('Education: Layla has a bachelor + master in Computer Science', edu.status === 200 && ['bachelor', 'master'].every((l) => edu.data.degrees.some((d) => d.level === l && d.field.en === 'Computer Science')), edu.data);
const emp = await L.req('/api/identity/me/employment');
check('Labor: Layla employed at Sarab Telecom, 14,500 SRD, social insurance on file', emp.status === 200 && emp.data.status === 'employed' && emp.data.employer?.name?.en === 'Sarab Telecom Company' && emp.data.monthly_income === 14500 && !!emp.data.social_insurance?.number, emp.data);
const hl = await L.req('/api/identity/me/health');
check('Health: summary with blood type and vaccinations', hl.status === 200 && /^(A|B|AB|O)[+-]$/.test(hl.data.blood_type) && hl.data.vaccinations.length > 0, hl.data);
const as = await L.req('/api/identity/me/assets');
check('Property: assets endpoint returns vehicles + properties arrays', as.status === 200 && Array.isArray(as.data.vehicles) && Array.isArray(as.data.properties), as.data);
const S = new Browser();
await S.login(PERSONA.saleh, DEMO_PASSWORD);
const sv = await S.req('/api/identity/me/assets');
check('Property: Saleh (elderly) has a vehicle registration expiring soon', sv.data?.vehicles?.some((v) => v.status === 'expiring_soon'), sv.data);
const se = await S.req('/api/identity/me/employment');
check('Labor: Saleh is retired with a pension', se.data?.status === 'retired' && se.data.social_insurance?.pension > 0, se.data);
check('anonymous cannot read ministry data', (await anon.req('/api/identity/me/health')).status === 401);

console.log('Who accessed my data');
const mine = await L.req('/api/jisr/audit/mine');
const entries = mine.data?.entries ?? [];
check('access log lists exchanges about me', entries.length >= 5, entries.length);
check('access log shows the bank as the requester-on-behalf', entries.some((e) => e.on_behalf_of === 'bank-alwaha' && e.client === 'mithaq' && e.target === 'civil-registry'));
check('access log shows my own self-service view', entries.some((e) => e.purpose === 'citizen-self-service'));
check('access log shows each ministry I viewed', ['education', 'health', 'labor', 'property'].every((t) => entries.some((e) => e.target === t && e.on_behalf_of === 'self')), entries.map((e) => e.target));
check('access log shows Labor issuing a credential for the bank', entries.some((e) => e.target === 'labor' && e.purpose === 'credential-issuance' && e.on_behalf_of === 'bank-alwaha' && e.consent_id));

console.log('Revocation');
const consents = (await L.req('/api/consent/consents/mine')).data?.consents ?? [];
check('consent listed as active', consents.some((c) => c.id === consentId && c.status === 'active'));
check('revoke works', (await L.req(`/api/consent/consents/${consentId}/revoke`, { method: 'POST', body: {} })).status === 200);
const kyc2 = await L.req('/api/bank/me/kyc-refresh', { method: 'POST', body: {} });
check('bank is refused after revocation', kyc2.data?.ok === false && kyc2.data.reason === 'consent_revoked', kyc2);

console.log('Under-18 citizen: proof without birth date');
const Y = new Browser();
check('Yousef logs in', (await Y.login(yousef.username, DEMO_PASSWORD)).status === 200);
const ys = await Y.req('/api/bank/onboarding/start', { body: { scenario: 'standard' } });
const yReq = ys.data.redirect.split('/').pop();
const ya = await Y.req(`/api/consent/requests/${yReq}/approve`, { method: 'POST', body: {} });
const yc = new URL(ya.data.redirect, BASE).searchParams.get('consent');
const yd = await Y.req('/api/bank/onboarding/complete', { body: { request_id: yReq, consent_id: yc } });
check('bank refuses: age_over_18 = false', yd.data?.status === 'refused' && yd.data.received_claims.age_over_18 === false, yd.data);
check('bank never saw his birth date', !('birth_date' in (yd.data?.received_claims ?? {})));

console.log('Deny flow');
const ds = await Y.req('/api/bank/onboarding/start', { body: { scenario: 'standard' } });
const dReq = ds.data.redirect.split('/').pop();
const dd = await Y.req(`/api/consent/requests/${dReq}/deny`, { method: 'POST', body: {} });
check('deny redirects with error=denied', /error=denied/.test(dd.data?.redirect ?? ''), dd);
const dc = await Y.req('/api/bank/onboarding/complete', { body: { request_id: dReq, error: 'denied' } });
check('bank records "declined" and gets no data', dc.data?.status === 'declined' && !dc.data.received_claims, dc);

console.log('Cross-citizen protection');
check("Yousef can't approve Layla's old request", (await Y.req(`/api/consent/requests/${reqId}/approve`, { method: 'POST', body: {} })).status === 409);
check("Yousef can't revoke Layla's consent", (await Y.req(`/api/consent/consents/${consentId}/revoke`, { method: 'POST', body: {} })).status === 404);
check('citizen cannot read the admin audit log', (await Y.req('/api/jisr/audit')).status === 403);

console.log('Digital signatures');
const content = 'I agree to rent apartment no. 4 for one year.';
const sig = await L.req('/api/identity/me/signatures', { body: { title: 'Lease', content } });
check('citizen signs a document with their own key', sig.status === 200 && sig.data.jws.split('.').length === 3, sig);
const v1 = await anon.req('/api/identity/signatures/verify', { body: { jws: sig.data.jws, content } });
check('anyone can verify the signature', v1.data?.valid === true && v1.data.payload.signer === layla.username, v1);
const v2 = await anon.req('/api/identity/signatures/verify', { body: { jws: sig.data.jws, content: content + ' (edited)' } });
check('editing the document invalidates it', v2.data?.valid === false && v2.data.reason === 'document_changed', v2);

console.log('Births: the hospital reports, the parents name the baby, then registry → health → child benefit (event bus)');
const ev = await anon.req('/api/jisr/events');
check('event-bus policy is public (publishers + subscribers)', ev.status === 200 && ev.data.event_types.some((e) => e.type === 'registry.person.born' && e.publisher === 'civil-registry') && ev.data.subscriptions.some((x) => x.consumer === 'labor-child-benefit'), ev.data);
check('naming events are in the public policy too', ['registry.birth.awaiting_name', 'registry.birth.name_proposed', 'registry.birth.named'].every((ty) => ev.data.event_types.some((e) => e.type === ty && e.publisher === 'civil-registry')));
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const feedStart = (await anon.req('/api/identity/test/feed')).data?.messages?.at(-1)?.id ?? 0;
check('the mocked news feed is only for tests (no ticket → 403)', (await fetch(`${BASE}/api/identity/test/feed`, { headers: { 'x-real-ip': '10.250.99.1' } })).status === 403);
const omarId0 = PERSONA.omar;
const O0 = new Browser();
check('Omar (Layla’s husband) signs in', (await O0.login(omarId0, DEMO_PASSWORD)).status === 200);
const H = new Browser(); // the admin, acting as hospital staff (permission births.report)
check('the automated-test staff account (TEST-0001) signs in to play the hospital', (await H.login('test', TEST_STAFF_PASSWORD)).status === 200);
const hosp = (await H.req('/api/identity/staff/births/options')).data;
check('hospital list and the 14-day naming deadline are served', hosp?.hospitals?.length > 3 && hosp.name_deadline_days === 14 && hosp.employee_id === 'TEST-0001', hosp);
check('a citizen cannot report a birth', (await L.req('/api/identity/staff/births', { body: { mother_id: layla.username, child_gender: 'F', birth_date: today, hospital_index: 0 } })).status === 403);
check('the old "parent reports a birth" endpoint is gone', (await L.req('/api/identity/me/life-events/birth', { body: {} })).status === 404);
const report = (body) => H.req('/api/identity/staff/births', { body: { child_gender: 'F', birth_date: today, hospital_index: 1, record_no: `HOSP-${RUN}`, ...body } });
const probs = (r) => (r.data?.details?.problems ?? []).map((p) => `${p.field}:${p.code}`).sort().join(',');
check('hospital: invalid IDs are refused with clear field errors', probs(await report({ mother_id: '1234', father_id: '1100000000' })) === 'father_id:invalid_id,mother_id:invalid_id');
check('hospital: a future birth date is refused', probs(await report({ mother_id: layla.username, birth_date: '2999-01-01' })) === 'birth_date:in_future');
check('hospital: a birth older than 60 days is refused', probs(await report({ mother_id: layla.username, birth_date: '2020-01-01' })) === 'birth_date:too_late');
check('hospital: the mother must be female, the father male', probs(await report({ mother_id: omarId0, father_id: layla.username })) === 'father_id:wrong_gender,mother_id:wrong_gender');
check('hospital: the father cannot be the mother', probs(await report({ mother_id: layla.username, father_id: layla.username })) === 'father_id:same_person');
check('hospital: an unknown national ID is refused', probs(await report({ mother_id: '1999999996' })) === 'mother_id:not_found');
check('hospital: a bad hospital file number is refused', probs(await report({ mother_id: layla.username, record_no: '<script>' })) === 'record_no:invalid_record_no');
const rep = await report({ mother_id: layla.username, father_id: omarId0 });
check('hospital reports a birth: mother Layla, father Omar, no name', rep.status === 200 && /^BN-/.test(rep.data?.notification_id) && rep.data.mother.has_account && rep.data.father?.has_account, rep);
const bn = rep.data?.notification_id;
check('a second report for the same mother and day must say "another baby" (twins)', (await report({ mother_id: layla.username, father_id: omarId0 })).data?.error === 'possible_duplicate');
const myBirth = async (who, id = bn) => {
  for (let i = 0; i < 40; i++) { const x = (await who.req('/api/identity/me/births')).data?.births?.find((y) => y.notification_id === id); if (x) return x; await sleep0(250); }
  return null;
};
const lb = await myBirth(L);
check('Layla sees the baby waiting for a name, with a 14-day deadline', lb?.status === 'awaiting_name' && lb.gender === 'F' && lb.proposal === null && Math.round((Date.parse(lb.name_deadline) - Date.now()) / 86_400_000) === 14 && lb.other_parent?.national_id === omarId0 && lb.sole_parent === false, lb);
check('Omar sees it too (as the father)', (await myBirth(O0))?.my_role === 'father');
check('Yousef (not a parent) does not see it', !((await Y.req('/api/identity/me/births')).data?.births ?? []).some((x) => x.notification_id === bn));
check('both parents are told to choose the name, with the deadline', await waitFor(async () => (await Promise.all([L, O0].map(async (w) => ((await w.req('/api/identity/me/notifications')).data?.notifications ?? []).some((n) => n.type === 'registry.birth.awaiting_name' && /14|\d{4}/.test(n.body.en))))).every(Boolean)));
const name = (ar, en) => L.req(`/api/identity/me/births/${bn}/name`, { body: { given_name: { ar, en } } });
check('naming: Latin letters in the Arabic name are refused', probs(await name('Sama', 'Sama')) === 'given_name.ar:name_not_arabic');
check('naming: Arabic letters / digits in the English name are refused', probs(await name('سما', 'سما1')) === 'given_name.en:name_not_latin');
check('naming: both names are required', probs(await name('', '')) === 'given_name.ar:required,given_name.en:required');
check('naming: Yousef cannot name someone else’s baby', (await Y.req(`/api/identity/me/births/${bn}/name`, { body: { given_name: { ar: 'سما', en: 'Sama' } } })).status === 404);
const p1 = await name('سما', 'Sama');
check('Layla proposes "سما / Sama" — waiting for Omar', p1.status === 200 && p1.data.proposal?.given_name?.en === 'Sama' && p1.data.waiting_for_other === true && p1.data.can_confirm === false, p1.data);
check('Layla cannot confirm her own proposal', (await L.req(`/api/identity/me/births/${bn}/confirm`, { body: { proposal_id: p1.data?.proposal?.id } })).data?.error === 'other_parent_confirms');
check('Omar is asked to confirm "Sama"', await waitInbox0(O0, (n) => n.type === 'registry.birth.name_proposed' && n.body.en.includes('Sama')));
const p2 = await O0.req(`/api/identity/me/births/${bn}/name`, { body: { given_name: { ar: 'ريم', en: 'Reem' } } });
check('Omar proposes a different name instead ("ريم / Reem") — now Layla confirms', p2.status === 200 && p2.data.proposal?.given_name?.en === 'Reem' && p2.data.waiting_for_other === true, p2.data);
check('confirming the replaced proposal is refused (the name changed meanwhile)', (await O0.req(`/api/identity/me/births/${bn}/confirm`, { body: { proposal_id: p1.data?.proposal?.id } })).data?.error === 'proposal_changed');
const lb2 = await myBirth(L);
check('Layla now sees Omar’s proposal and may confirm it', lb2?.can_confirm === true && lb2.proposal?.given_name?.ar === 'ريم');
const conf = await L.req(`/api/identity/me/births/${bn}/confirm`, { body: { proposal_id: lb2?.proposal?.id } });
check('Layla confirms: the Civil Registry registers the child at once', conf.status === 200 && conf.data.status === 'registered' && /^1\d{9}$/.test(conf.data.child?.national_id ?? '') && conf.data.child?.name?.en?.startsWith('Reem '), conf.data);
check('naming again after registration is refused', (await name('سما', 'Sama')).data?.error === 'already_registered');
let le = null;
for (let i = 0; i < 40 && !le?.complete; i++) {
  await sleep0(300);
  le = (await L.req('/api/identity/me/life-events')).data?.life_events?.find((e) => e.correlation_id === bn);
}
check('all five steps complete (report → name → registry → health file → child benefit)', le?.complete === true && le.steps.length === 5 && le.steps[1].type === 'registry.birth.named', le?.steps);
const childId = le?.data?.child_national_id;
check('the timeline carries the confirmed name and the child’s national ID', childId === conf.data?.child?.national_id && le?.data?.child_given_name?.en === 'Reem', le?.data);
const rec2 = await L.req('/api/identity/me/record');
check('the child appears in the mother’s family record', rec2.data?.family?.some((f) => f.national_id === childId && f.relation === 'child'));
check('…and in the father’s', ((await O0.req('/api/identity/me/record')).data?.family ?? []).some((f) => f.national_id === childId && f.relation === 'child'));
const emp2 = await L.req('/api/identity/me/employment');
check('child benefit awarded to the mother without applying', emp2.data?.benefits?.some((x) => x.kind === 'child_benefit' && x.monthly_amount > 0), emp2.data?.benefits);
const inbox = (await L.req('/api/identity/me/notifications')).data;
check('the mother’s inbox explains each step', ['registry.birth.awaiting_name', 'registry.birth.named', 'registry.person.born', 'labor.benefit.awarded'].every((ty) => inbox?.notifications?.some((n) => n.type === ty)), inbox?.notifications?.map((n) => n.type));
const lAudit = (await L.req('/api/jisr/audit/mine?limit=300')).data?.entries ?? [];
check('access log: the hospital report names the employee', lAudit.some((e) => e.client === 'mithaq' && e.target === 'health' && e.purpose === 'birth-notification' && e.on_behalf_of === 'employee:TEST-0001'));
check('access log: the Registry pulled the report from Health via Jisr', lAudit.some((e) => e.client === 'civil-registry' && e.target === 'health' && e.purpose === 'birth-registration'));
check('access log: the naming requests are there (purpose birth-naming)', lAudit.some((e) => e.target === 'civil-registry' && e.purpose === 'birth-naming' && e.path.includes('/confirmation')));
check('access log: the bus events themselves are recorded', ['health.birth.notified', 'registry.birth.named', 'labor.benefit.awarded'].every((p) => lAudit.some((e) => e.method === 'EVENT' && e.path === p)));
const nameReads = ((await H.req('/api/jisr/audit?limit=300')).data?.entries ?? []).filter((e) => e.purpose === 'news-feed');
check('the news feed’s name look-ups go through Jisr, one person at a time, name only (they show in that citizen’s access log)', nameReads.length > 0 && nameReads.every((e) => e.path === `/x/persons/${e.subject}/name` && e.client === 'mithaq'), nameReads.slice(0, 2));
// Only one parent: no father declared → the mother proposes, checks, and confirms alone.
const rep2 = await report({ mother_id: layla.username, birth_date: yesterday, child_gender: 'M' });
check('hospital reports a second birth with no father declared', rep2.status === 200 && rep2.data.father === null, rep2.data);
const sb = await myBirth(L, rep2.data?.notification_id);
check('Layla is the only parent: she confirms alone', sb?.sole_parent === true && sb.other_parent === null);
const sp = await L.req(`/api/identity/me/births/${rep2.data?.notification_id}/name`, { body: { given_name: { ar: 'زياد', en: 'Ziyad' } } });
check('…her proposal waits for her own check (not for anyone else)', sp.data?.can_confirm === true && sp.data.waiting_for_other === false && sp.data.proposal?.awaiting === null, sp.data);
const sc = await L.req(`/api/identity/me/births/${rep2.data?.notification_id}/confirm`, { body: { proposal_id: sp.data?.proposal?.id } });
check('…and she confirms it: the child is registered', sc.data?.status === 'registered' && sc.data.child?.name?.en?.startsWith('Ziyad '), sc.data);
check('the father (Omar) cannot see a birth he is not named in', !((await O0.req('/api/identity/me/births')).data?.births ?? []).some((x) => x.notification_id === rep2.data?.notification_id));

console.log('Delegation (Saleh lets his son Omar renew his car registration)');
const O = new Browser();
const omarId = PERSONA.omar;
const salehId = PERSONA.saleh;
check('Omar logs in', (await O.login(omarId, DEMO_PASSWORD)).status === 200);
check('acting without a delegation is refused', (await O.req('/api/identity/acting/DG-nothing/assets')).status === 404);
check('cannot delegate to a minor', (await S.req('/api/identity/me/delegations', { body: { delegate_id: yousef.username, scopes: ['vehicles.renew'], days: 30 } })).data?.error === 'delegate_not_eligible');
check('cannot delegate to yourself', (await S.req('/api/identity/me/delegations', { body: { delegate_id: salehId, scopes: ['vehicles.renew'], days: 30 } })).status === 400);
const dg = await S.req('/api/identity/me/delegations', { body: { delegate_id: omarId, scopes: ['vehicles.renew'], days: 90 } });
check('Saleh authorises Omar (vehicles.renew, 90 days)', dg.status === 200 && dg.data.status === 'active' && dg.data.delegate === omarId, dg);
const pub = (await anon.req(`/api/identity/citizens/${salehId}/public-key`)).data?.public_jwk;
const [mh, mp, ms] = (dg.data?.mandate_jws ?? '..').split('.');
const mandateOk = !!pub && verify(null, Buffer.from(`${mh}.${mp}`), createPublicKey({ key: { kty: pub.kty, crv: pub.crv, x: pub.x }, format: 'jwk' }), Buffer.from(ms, 'base64url'));
check('the mandate is signed with Saleh’s own key (verifiable by anyone)', mandateOk && JSON.parse(Buffer.from(mp, 'base64url')).delegate === omarId);
const recv = (await O.req('/api/identity/me/delegations')).data?.received ?? [];
check('Omar sees the delegation', recv.some((d) => d.id === dg.data.id && d.status === 'active'));
const oa = await O.req(`/api/identity/acting/${dg.data.id}/assets`);
const car = oa.data?.assets?.vehicles?.find((v) => v.status === 'expiring_soon');
check('Omar sees his father’s expiring registration (and no property deeds: not in scope)', !!car && oa.data.assets.properties.length === 0, oa.data?.assets);
const rn = await O.req(`/api/identity/acting/${dg.data.id}/vehicles/${encodeURIComponent(car?.plate ?? 'x')}/renew`, { method: 'POST', body: {} });
check('Omar renews it on Saleh’s behalf', rn.status === 200 && rn.data.days_left > 300, rn);
check('renewing again is refused (too early)', (await O.req(`/api/identity/acting/${dg.data.id}/vehicles/${encodeURIComponent(car?.plate ?? 'x')}/renew`, { method: 'POST', body: {} })).data?.error === 'too_early');
check('Yousef cannot use Omar’s delegation', (await Y.req(`/api/identity/acting/${dg.data.id}/assets`)).status === 404);
const sAudit = (await S.req('/api/jisr/audit/mine?limit=50')).data?.entries ?? [];
check('Saleh’s access log names Omar as the delegate who acted', sAudit.some((e) => e.purpose === 'delegated-service' && e.on_behalf_of === `delegate:${omarId}` && e.target === 'property' && e.method === 'POST'));
let sInbox = [];
for (let i = 0; i < 20 && !sInbox.some((n) => n.type === 'property.vehicle.renewed'); i++) { await new Promise((r) => setTimeout(r, 300)); sInbox = (await S.req('/api/identity/me/notifications')).data?.notifications ?? []; }
check('Saleh is notified that his delegate renewed the registration', sInbox.some((n) => n.type === 'property.vehicle.renewed'));
check('Saleh revokes the delegation', (await S.req(`/api/identity/me/delegations/${dg.data.id}`, { method: 'DELETE' })).data?.status === 'revoked');
check('revocation is immediate', (await O.req(`/api/identity/acting/${dg.data.id}/assets`)).data?.error === 'delegation_inactive');

console.log('Passkeys (software authenticator)');
const auth = new SoftAuthenticator();
const ro = await L.req('/api/identity/me/passkeys/options', { method: 'POST', body: {} });
check('registration options use RP ID ' + RP_ID, ro.data?.options?.rp?.id === RP_ID, ro.data?.options?.rp);
const rr = await L.req('/api/identity/me/passkeys', { body: { challenge_id: ro.data.challenge_id, response: auth.register(ro.data.options), nickname: 'E2E key' } });
check('passkey registered', rr.status === 200, rr);
const P = new Browser();
const ao = await P.req('/api/identity/auth/passkey/options', { method: 'POST', body: {} });
const av = await P.req('/api/identity/auth/passkey/verify', { body: { challenge_id: ao.data.challenge_id, response: auth.authenticate(ao.data.options) } });
check('passkey login works (no password)', av.status === 200 && av.data.session.sub === layla.username && av.data.session.amr.includes('hwk'), av);
const ao2 = await P.req('/api/identity/auth/passkey/options', { method: 'POST', body: {} });
const phish = await P.req('/api/identity/auth/passkey/verify', { body: { challenge_id: ao2.data.challenge_id, response: auth.authenticate(ao2.data.options, { origin: 'https://evil.example' }) } });
check('passkey from a phishing origin is rejected', phish.status === 401, phish);
const keys = (await L.req('/api/identity/me/passkeys')).data?.passkeys ?? [];
for (const k of keys) await L.req(`/api/identity/me/passkeys/${encodeURIComponent(k.credential_id)}`, { method: 'DELETE' });

console.log('Admin login is real (private password + one-time code by Telegram)');
const A = new Browser();
check('anonymous cannot read the audit log', (await A.req('/api/jisr/audit')).status === 401);
check('anonymous cannot verify the chain', (await A.req('/api/jisr/audit/verify', { method: 'POST', body: {} })).status === 401);
check('anonymous cannot list consent requests', (await A.req('/api/consent/requests')).status === 401);
// Staff sign-in is tested on the automated-test account (same code path as the administrator's).
const adminPw = (b, ticket = TEST_TICKET) => b.req('/api/identity/auth/password', { body: { username: 'test', password: TEST_STAFF_PASSWORD }, headers: { 'x-sarab-test-ticket': ticket } });
const NO_TICKET = { 'x-sarab-test-ticket': '' }; // only used where the 60-second limit refuses before anything is sent
check('the automated-test account cannot sign in without a test ticket (answers like a wrong password, sends nothing)',
  (await new Browser().req('/api/identity/auth/password', { body: { username: 'test', password: TEST_STAFF_PASSWORD }, headers: NO_TICKET })).data?.error === 'invalid_credentials');
const otp = (b, id, code) => b.req('/api/identity/auth/otp', { body: { otp_challenge_id: id, code } });
const wrongOf = (c) => c.replace(/\d$/, (d) => String((+d + 1) % 10));
// 1) Five wrong codes burn the challenge: even the right code is then refused.
const ap0 = await adminPw(A);
check('staff password step: code goes by Telegram, nothing shown on screen', ap0.data?.method === 'telegram' && Object.keys(ap0.data).sort().join() === 'method,otp_challenge_id,test_code,test_message' && /^\d{6}$/.test(ap0.data.test_code ?? ''), { ...ap0.data, test_code: ap0.data?.test_code ? '(present)' : undefined });
const wrongs = [];
for (let i = 0; i < 5; i++) wrongs.push((await otp(A, ap0.data.otp_challenge_id, wrongOf(ap0.data.test_code))).data?.error);
check('wrong codes are rejected (5 tries)', wrongs.every((e) => e === 'otp_invalid'), wrongs);
check('after 5 wrong codes even the right code is refused (new code required)', (await otp(A, ap0.data.otp_challenge_id, ap0.data.test_code)).data?.error === 'otp_expired');
// 2) A newer code replaces the older one.
const apOld = await adminPw(A);
const ap = await adminPw(A);
check('requesting a new code invalidates the previous one', (await otp(A, apOld.data.otp_challenge_id, apOld.data.test_code)).status === 401);
const aok = await otp(A, ap.data.otp_challenge_id, ap.data.test_code);
check('staff (TEST-0001, every admin permission) logs in with password + Telegram code', aok.status === 200 && aok.data.session.role === 'admin', aok);
check('the same code cannot be used twice', (await otp(new Browser(), ap.data.otp_challenge_id, ap.data.test_code)).status === 401);
// 3) Sending is rate limited (1 per 60 s) — no Telegram message is sent by this check.
const A2 = new Browser();
const fake = await adminPw(A2, 'x'.repeat(43));
check('a bogus test ticket gets no code in the response', !fake.data?.test_code);
check('the automated-test account refuses a bogus test ticket outright (nothing sent; the 60 s limit is checked on the clerk below)', fake.status === 401 && fake.data?.error === 'invalid_credentials', fake);
check('a wrong password never triggers a code', (await A2.req('/api/identity/auth/password', { body: { username: 'test', password: 'wrong-password-123' } })).status === 401);

console.log('Service-centre counter (assisted channel, employee EMP-1042)');
const C = new Browser();
const cp = await C.req('/api/identity/auth/password', { body: { username: 'clerk', password: CLERK_PASSWORD } });
check('employee sign-in: code goes by Telegram like the admin’s (no authenticator app, nothing on screen)', cp.data?.method === 'telegram' && /^\d{6}$/.test(cp.data.test_code ?? '') && Object.keys(cp.data).sort().join() === 'method,otp_challenge_id,test_code,test_message', cp.data);
check('the clerk’s Telegram message names the account, purpose and expiry (EN + AR)', /Staff sign-in code/.test(cp.data.test_message ?? '') && /For: staff account "clerk" \(EMP-1042\)/.test(cp.data.test_message) && /Expires: .* Riyadh time \(in 5 minutes\)/.test(cp.data.test_message) && /رمز/.test(cp.data.test_message), cp.data.test_message);
const cl = await C.req('/api/identity/auth/otp', { body: { otp_challenge_id: cp.data.otp_challenge_id, code: cp.data.test_code } });
check('employee logs in with own password + Telegram code', cl.status === 200 && cl.data.session.role === 'employee', cl);
check('the clerk’s code cannot be used twice', (await new Browser().req('/api/identity/auth/otp', { body: { otp_challenge_id: cp.data.otp_challenge_id, code: cp.data.test_code } })).status === 401);
const cpFast = await new Browser().req('/api/identity/auth/password', { body: { username: 'clerk', password: CLERK_PASSWORD }, headers: NO_TICKET });
check('a second clerk code within 60 s is refused (nothing sent)', cpFast.status === 429 && cpFast.data?.error === 'code_recently_sent' && !cpFast.data.test_code, cpFast.data);
check('another staff password does not work for the employee', (await new Browser().req('/api/identity/auth/password', { body: { username: 'clerk', password: TEST_STAFF_PASSWORD } })).status === 401);
check('a citizen cannot use the counter', (await S.req('/api/identity/counter/sessions', { body: { national_id: salehId } })).status === 403);
check('the admin can use the counter too (has every staff permission)', (await A.req('/api/identity/counter/me')).data?.employee?.employee_id === 'TEST-0001');
const cs = await C.req('/api/identity/counter/sessions', { body: { national_id: salehId } });
check('employee starts serving Saleh: the code is sent by Telegram, the employee only sees "sent"', cs.status === 200 && cs.data.status === 'pending' && cs.data.sent === true && /^\d{6}$/.test(cs.data.test_code ?? '') && Object.keys(cs.data).sort().join() === 'id,sent,status,test_code,test_message', cs.data);
const csFast = await C.req('/api/identity/counter/sessions', { body: { national_id: salehId }, headers: NO_TICKET });
check('a second counter code for the same citizen within 60 s is refused (nothing sent)', csFast.status === 429 && csFast.data?.error === 'code_recently_sent', csFast.data);
check('before the citizen confirms, the employee sees nothing', (await C.req(`/api/identity/counter/sessions/${cs.data.id}/record`)).data?.error === 'counter_session_inactive');
check('a wrong code is rejected', (await C.req(`/api/identity/counter/sessions/${cs.data.id}/confirm`, { body: { code: cs.data.test_code === '000000' ? '111111' : '000000' } })).status === 401);
const cc = await C.req(`/api/identity/counter/sessions/${cs.data.id}/confirm`, { body: { code: cs.data.test_code } });
check('the code Saleh reads out opens a 20-minute counter session', cc.data?.status === 'active' && cc.data.minutes === 20, cc);
const crec = await C.req(`/api/identity/counter/sessions/${cs.data.id}/record`);
check('employee sees Saleh’s civil record (through Jisr)', crec.data?.record?.national_id === salehId, crec);
const cas = await C.req(`/api/identity/counter/sessions/${cs.data.id}/assets`);
check('employee sees Saleh’s vehicles', Array.isArray(cas.data?.vehicles) && cas.data.vehicles.length > 0, cas);
const crn = await C.req(`/api/identity/counter/sessions/${cs.data.id}/vehicles/${encodeURIComponent(cas.data?.vehicles?.[0]?.plate ?? 'x')}/renew`, { method: 'POST', body: {} });
check('renewal at the counter reaches Property (renewed, or too early after Omar’s renewal)', crn.status === 200 || crn.data?.error === 'too_early', crn);
const cdg = await C.req(`/api/identity/counter/sessions/${cs.data.id}/delegations`, { body: { delegate_id: omarId, scopes: ['vehicles.renew'], days: 30 } });
check('employee records Saleh’s delegation to Omar (marked as service-centre, with employee ID)', cdg.data?.created_via === 'service-centre' && cdg.data.created_by === 'EMP-1042', cdg);
check('Saleh sees the delegation recorded for him', ((await S.req('/api/identity/me/delegations')).data?.granted ?? []).some((d) => d.id === cdg.data?.id));
await S.req(`/api/identity/me/delegations/${cdg.data?.id}`, { method: 'DELETE' });
check('employee finishes; the file closes again', (await C.req(`/api/identity/counter/sessions/${cs.data.id}/end`, { body: {} })).status === 200 && (await C.req(`/api/identity/counter/sessions/${cs.data.id}/record`)).data?.error === 'counter_session_inactive');
const another = await new Browser().req('/api/identity/counter/me');
check('anonymous cannot reach the counter', another.status === 401);
const sAssisted = (await S.req('/api/identity/me/assisted-actions')).data?.actions ?? [];
check('Saleh sees each counter action with the employee ID', ['session.opened', 'record.viewed', 'delegation.recorded', 'session.ended'].every((a) => sAssisted.some((x) => x.action === a && x.employee_id === 'EMP-1042')), sAssisted.map((x) => x.action));
const sAudit2 = (await S.req('/api/jisr/audit/mine?limit=100')).data?.entries ?? [];
check('Saleh’s access log: Registry and Property reads by "employee:EMP-1042"', ['civil-registry', 'property'].every((tg) => sAudit2.some((e) => e.target === tg && e.purpose === 'assisted-service' && e.on_behalf_of === 'employee:EMP-1042')));
const adminAssisted = (await A.req('/api/identity/admin/assisted-actions')).data?.actions ?? [];
check('the auditor sees all counter actions by employee ID', adminAssisted.some((a) => a.employee_id === 'EMP-1042' && a.citizen === salehId));
check('a citizen cannot see the auditor’s counter-action list', (await S.req('/api/identity/admin/assisted-actions')).status === 403);

console.log('Long lists: 20 per page, filters (date, employee, citizen, result)');
{
  const p1 = (await A.req('/api/jisr/audit?limit=20&offset=0')).data;
  const p2 = (await A.req('/api/jisr/audit?limit=20&offset=20')).data;
  check('audit log pages: 20 rows, a total, and page 2 continues where page 1 ended', p1?.entries?.length === 20 && p1.total > 40 && p2?.entries?.[0]?.seq < p1.entries[19].seq, { total: p1?.total });
  const nr = (await A.req('/api/jisr/audit?limit=50&result=no_record')).data;
  check('result "no record" = an allowed exchange the ministry answered 404 (not a policy denial)', nr?.entries?.length > 0 && nr.entries.every((e) => e.decision === 'allow' && e.status === 404), nr?.entries?.slice(0, 2));
  const dn = (await A.req('/api/jisr/audit?limit=50&result=denied')).data;
  check('result "denied" = only real policy refusals', (dn?.entries ?? []).every((e) => e.decision === 'deny'));
  const emp = (await A.req('/api/jisr/audit?limit=50&employee=EMP-1042')).data;
  check('employee filter: only exchanges on behalf of that employee', emp?.entries?.length > 0 && emp.entries.every((e) => e.on_behalf_of === 'employee:EMP-1042'));
  const cit = (await A.req(`/api/jisr/audit?limit=50&subject=${salehId}`)).data;
  check('citizen filter: only that citizen', cit?.entries?.length > 0 && cit.entries.every((e) => e.subject === salehId));
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
  const td = (await A.req(`/api/jisr/audit?limit=5&from=${day}&to=${day}`)).data;
  const old = (await A.req('/api/jisr/audit?limit=5&from=2000-01-01&to=2000-01-02')).data;
  check('date filter (Riyadh days): today has entries, a day in 2000 has none', td?.total > 0 && old?.total === 0, { today: td?.total, y2000: old?.total });
  check('a malformed date is refused', (await A.req('/api/jisr/audit?from=yesterday')).status === 400);
  const aa = (await A.req('/api/identity/admin/assisted-actions?limit=20&employee=TEST-0001')).data;
  check('service-centre actions: paged, filterable by employee, and test actions are flagged "automated"', aa?.actions?.length > 0 && aa.actions.length <= 20 && aa.actions.every((a) => a.employee_id === 'TEST-0001' && a.automated === true) && aa.total >= aa.actions.length, aa?.actions?.[0]);
  const ac = (await A.req(`/api/identity/admin/assisted-actions?limit=20&employee=EMP-1042&citizen=${salehId}&action=record.viewed`)).data;
  check('service-centre actions: citizen + action filters', ac?.actions?.length > 0 && ac.actions.every((a) => a.citizen === salehId && a.action === 'record.viewed' && a.automated === false));
  const mine = (await C.req('/api/identity/counter/actions?limit=20&action=session.ended')).data;
  check('the counter’s "My recent actions": only the employee’s own, filterable, paged', mine?.actions?.length > 0 && mine.actions.every((a) => a.employee_id === 'EMP-1042' && a.action === 'session.ended') && typeof mine.total === 'number');
  check('an employee cannot see someone else’s actions through the filter', ((await C.req('/api/identity/counter/actions?employee=TEST-0001')).data?.actions ?? []).every((a) => a.employee_id === 'EMP-1042'));
}

console.log('Tamper demo (admin)');
check('citizens cannot run the tamper demo', (await S.req('/api/jisr/audit/tamper-demo', { body: { kind: 'modify' } })).status === 403);
const tm = await A.req('/api/jisr/audit/tamper-demo', { body: { kind: 'modify' } });
check('editing an entry is detected at exactly that entry', tm.data?.verification_while_tampered?.ok === false && tm.data.verification_while_tampered.broken_at === tm.data.tamper.seq && /modified/.test(tm.data.verification_while_tampered.problem), tm.data);
const td = await A.req('/api/jisr/audit/tamper-demo', { body: { kind: 'delete' } });
check('deleting an entry is detected (broken link)', td.data?.verification_while_tampered?.ok === false && /removed or reordered/.test(td.data.verification_while_tampered.problem), td.data);
check('the demo rolls back: the real chain is intact', tm.data?.verification_after_rollback?.ok === true && td.data?.verification_after_rollback?.ok === true);


console.log('Admin has every staff permission; every staff action is in the audit chain with the staff ID');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auditFind = async (pred, tries = 25) => {
  for (let i = 0; i < tries; i++) {
    const r = await A.req('/api/jisr/audit?limit=300');
    // A server error is a bug, not "not there yet": stop instead of retrying it 25 times (each retry is a
    // 5xx in the gateway log, and enough of them raise a real "Many ERRORS" alert).
    if (r.status >= 500) { console.log(`  (audit log answered HTTP ${r.status}: not retrying)`); return null; }
    const hit = (r.data?.entries ?? []).find(pred);
    if (hit) return hit;
    await sleep(300);
  }
  return null;
};
{ // block scope: these names are local to this section
const staffMe = (await A.req('/api/identity/staff/me')).data;
const perms = (staffMe?.permissions ?? []).map((p) => p.permission);
check('admin holds every staff permission (counter, civil registration, audit, sessions)', ['counter', 'registry.register', 'audit', 'sessions.admin'].every((p) => perms.includes(p)), perms);
check('the employee holds only employee permissions', JSON.stringify((await C.req('/api/identity/staff/me')).data?.permissions?.map((p) => p.permission)) === JSON.stringify(['counter', 'registry.register']));
const acs = await A.req('/api/identity/counter/sessions', { body: { national_id: salehId } });
check('admin opens a counter session (citizen still has to confirm with a code)', acs.data?.status === 'pending' && !!acs.data.test_code, acs.data);
await A.req(`/api/identity/counter/sessions/${acs.data.id}/confirm`, { body: { code: acs.data.test_code } });
check('admin reads Saleh’s record at the counter', (await A.req(`/api/identity/counter/sessions/${acs.data.id}/record`)).data?.record?.national_id === salehId);
await A.req(`/api/identity/counter/sessions/${acs.data.id}/end`, { body: {} });
check('Jisr audit: the admin’s counter read is logged as employee:TEST-0001', !!(await auditFind((e) => e.subject === salehId && e.purpose === 'assisted-service' && e.on_behalf_of === 'employee:TEST-0001')));
check('Jisr audit: the counter events carry the admin’s staff ID too', !!(await auditFind((e) => e.method === 'EVENT' && e.path === 'mithaq.assisted.action' && e.subject === salehId && e.on_behalf_of === 'employee:TEST-0001')));
check('Saleh sees that administrator TEST-0001 served him', ((await S.req('/api/identity/me/assisted-actions')).data?.actions ?? []).some((a) => a.employee_id === 'TEST-0001'));

console.log('Civil registration of a new adult (naturalisation / missing record) + activation');
const tag = RUN;
const PHONE = '+999 50 555 0101';
const person = (o = {}) => ({
  given_name: { ar: 'تجربة', en: `Test${tag}` }, family_name: { ar: 'المجنّس', en: 'Al-Mujannas' }, gender: 'F', birth_date: '1962-03-04',
  city_index: 1, district_index: 2, street: '3 Harbour Rd', phone: PHONE, reason: 'naturalization', reference: `DEC-${tag}`, ...o,
  ...(o.given_name ? { given_name: { ar: `${o.given_name.ar} ${tag}`, en: o.given_name.en } } : { given_name: { ar: `تجربة ${tag}`, en: `Test${tag}` } }),
});
check('anonymous cannot register people', (await new Browser().req('/api/identity/registry/persons', { body: person() })).status === 401);
check('a citizen cannot register people', (await S.req('/api/identity/registry/persons', { body: person() })).status === 403);
const notAdult = await A.req('/api/identity/registry/persons', { body: person({ birth_date: '2015-01-01' }) });
check('a minor cannot be registered here (births have their own path)', notAdult.status === 422 && notAdult.data?.details?.problems?.[0]?.code === 'not_adult', notAdult.data);
const ghostParent = await A.req('/api/identity/registry/persons', { body: person({ mother_id: '1999999992' }) });
check('a family link to a non-existent person is refused', ghostParent.status === 422, ghostParent.data);
// 1) The mother (registered by the admin).
const rm = await A.req('/api/identity/registry/persons', { body: person() });
const momId = rm.data?.person?.national_id;
check('admin registers a naturalised adult: the Civil Registry issues a valid national ID', rm.status === 201 && /^1\d{9}$/.test(momId ?? ''), rm.data);
check('…the registrar is told only that the code was sent by Telegram (no code; tests get test_code)', rm.data?.activation?.sent === true && rm.data.activation.sent_via === 'telegram' && Object.keys(rm.data.activation).sort().join() === 'expires_at,sent,sent_via,test_code,test_message', rm.data?.activation);
const momCode = rm.data?.activation?.test_code;
const momMsg = rm.data?.activation?.test_message ?? '';
const momLink = momMsg.match(/https?:\/\/\S+\/activate\?nid=(\d{10})/);
check('the activation message has a direct link with the national ID pre-filled (and not the code)', momLink?.[1] === momId && !momLink[0].includes(momCode?.replace(' ', '') ?? 'none') && /Account activation code/.test(momMsg) && new RegExp(`For: new citizen, national ID ${momId}`).test(momMsg) && /in 7 days/.test(momMsg), momMsg);
check('the activation code has 8 digits', /^\d{4} \d{4}$/.test(momCode ?? ''), momCode);
const dupe = await A.req('/api/identity/registry/persons', { body: person() });
check('the same name + birth date is flagged as a possible duplicate', dupe.status === 409 && dupe.data?.details?.national_ids?.includes(momId), dupe.data);
check('Jisr audit: the registration request is logged as employee:TEST-0001', !!(await auditFind((e) => e.method === 'POST' && e.path === '/x/persons' && e.purpose === 'civil-registration' && e.on_behalf_of === 'employee:TEST-0001' && e.decision === 'allow')));
check('Jisr audit: the new person’s registration event names the admin', !!(await auditFind((e) => e.method === 'EVENT' && e.path === 'registry.person.registered' && e.subject === momId && e.on_behalf_of === 'employee:TEST-0001')));
check('Jisr audit: the activation code issue names the admin', !!(await auditFind((e) => e.method === 'EVENT' && e.path === 'mithaq.activation.issued' && e.subject === momId && e.on_behalf_of === 'employee:TEST-0001')));
check('before activation the account cannot sign in', (await new Browser().req('/api/identity/auth/password', { body: { username: momId, password: DEMO_PASSWORD } })).status === 401);
// Activate the mother.
const M = new Browser();
const wrongCode = momCode.replace(/\d$/, (d) => String((+d + 1) % 10));
check('a wrong activation code is refused', (await M.req('/api/identity/auth/activation/verify', { body: { national_id: momId, code: wrongCode } })).data?.error === 'activation_invalid');
const av = await M.req('/api/identity/auth/activation/verify', { body: { national_id: momId, code: momCode } });
check('the right code (with a space) is accepted', av.status === 200 && !!av.data?.activation_token, av.data);
check('a short password is refused', (await M.req('/api/identity/auth/activation/complete', { body: { activation_token: av.data.activation_token, password: 'short' } })).data?.error === 'password_too_short');
check('a password containing the national ID is refused', (await M.req('/api/identity/auth/activation/complete', { body: { activation_token: av.data.activation_token, password: `x${momId}x` } })).data?.error === 'password_contains_id');
const newPw = `Sarab-new-${tag}-pw`;
const ac = await M.req('/api/identity/auth/activation/complete', { body: { activation_token: av.data.activation_token, password: newPw } });
check('activation sets the password and signs the citizen in', ac.status === 200 && ac.data?.session?.role === 'citizen' && ac.data.session.sub === momId && ac.data.session.amr.includes('activation'), ac.data);
const momRec = (await M.req('/api/identity/me/record')).data;
check('the new citizen sees her civil record', (momRec?.national_id ?? momRec?.record?.national_id) === momId, momRec);
const mpk = new SoftAuthenticator();
const mro = await M.req('/api/identity/me/passkeys/options', { method: 'POST', body: {} });
check('…and adds a passkey', (await M.req('/api/identity/me/passkeys', { body: { challenge_id: mro.data.challenge_id, response: mpk.register(mro.data.options), nickname: 'New citizen (e2e)' } })).status === 200);
const mpo = await new Browser().req('/api/identity/auth/passkey/options', { method: 'POST', body: {} });
const M2 = new Browser();
check('she can sign in with that passkey', (await M2.req('/api/identity/auth/passkey/verify', { body: { challenge_id: mpo.data.challenge_id, response: mpk.authenticate(mpo.data.options) } })).data?.session?.sub === momId);
check('…and with her new password (+ SMS code)', (await new Browser().login(momId, newPw)).status === 200);
check('the activation code cannot be used twice', (await new Browser().req('/api/identity/auth/activation/verify', { body: { national_id: momId, code: momCode } })).status === 401);
check('a new code cannot be issued for an activated account', (await A.req(`/api/identity/registry/persons/${momId}/activation-code`, { method: 'POST', body: {} })).status === 409);
// 2) Her adult son (registered by the clerk), linked to her as mother.
const rs = await C.req('/api/identity/registry/persons', { body: person({ given_name: { ar: 'ابن', en: `Son${tag}` }, gender: 'M', birth_date: '1990-07-08', mother_id: momId, reason: 'missing-record' }) });
const sonId = rs.data?.person?.national_id;
check('the employee registers a missing adult, linked to his mother', rs.status === 201 && rs.data.person.family.some((f) => f.relation === 'mother' && f.national_id === momId), rs.data);
check('Jisr audit: that registration names the employee (EMP-1042)', !!(await auditFind((e) => e.method === 'EVENT' && e.path === 'registry.person.registered' && e.subject === sonId && e.on_behalf_of === 'employee:EMP-1042')));
let momInbox = [];
for (let i = 0; i < 20 && !momInbox.some((n) => n.type === 'registry.person.registered'); i++) { await sleep(300); momInbox = (await M.req('/api/identity/me/notifications')).data?.notifications ?? []; }
check('the mother is told her family record changed', momInbox.some((n) => n.type === 'registry.person.registered' && n.body.en.includes(sonId)));
check('a mother cannot be male / implausible links are refused', (await C.req('/api/identity/registry/persons', { body: person({ given_name: { ar: 'س', en: `X${tag}` }, birth_date: '1995-01-01', mother_id: sonId }) })).status === 422);
// 3) His wife, linked as spouse; then the spouse is no longer available.
const rw = await C.req('/api/identity/registry/persons', { body: person({ given_name: { ar: 'زوجة', en: `Wife${tag}` }, birth_date: '1992-02-02', spouse_id: sonId }) });
const wifeId = rw.data?.person?.national_id;
check('registering a spouse links both records', rw.status === 201 && rw.data.person.family.some((f) => f.relation === 'spouse' && f.national_id === sonId), rw.data);
check('a person who is already married cannot be linked as a spouse again', (await C.req('/api/identity/registry/persons', { body: person({ given_name: { ar: 'ص', en: `Y${tag}` }, birth_date: '1993-03-03', spouse_id: sonId }) })).data?.details?.problems?.[0]?.code === 'not_available');
// Lockout + re-issue for the wife.
const wifeCode = rw.data?.activation?.test_code;
for (let i = 0; i < 5; i++) await new Browser().req('/api/identity/auth/activation/verify', { body: { national_id: wifeId, code: '00000000' } });
check('after 5 wrong codes the right one is refused (locked)', (await new Browser().req('/api/identity/auth/activation/verify', { body: { national_id: wifeId, code: wifeCode } })).data?.error === 'activation_locked');
check('the employee sees her as locked', ((await C.req('/api/identity/registry/registrations')).data?.registrations ?? []).find((r) => r.national_id === wifeId)?.locked === true);
const re = await C.req(`/api/identity/registry/persons/${wifeId}/activation-code`, { method: 'POST', body: {} });
check('a new code can be issued (the old one stops working)', re.status === 200 && (await new Browser().req('/api/identity/auth/activation/verify', { body: { national_id: wifeId, code: wifeCode } })).status === 401);
const wifeCode2 = re.data?.test_code;
check('…it is sent by Telegram again, not shown to the employee', !('code' in (re.data ?? {})) && re.data?.sent_via === 'telegram' && /^\d{4} \d{4}$/.test(wifeCode2 ?? '') && wifeCode2 !== wifeCode, re.data);
check('another new code within 60 s is refused (nothing sent)', (await C.req(`/api/identity/registry/persons/${wifeId}/activation-code`, { method: 'POST', body: {}, headers: NO_TICKET })).data?.error === 'code_recently_sent');
check('the new code works', (await new Browser().req('/api/identity/auth/activation/verify', { body: { national_id: wifeId, code: wifeCode2 } })).status === 200);
check('the employee lists only their own registrations; the admin sees everyone’s',
  !((await C.req('/api/identity/registry/registrations')).data?.registrations ?? []).some((r) => r.national_id === momId) &&
  ((await A.req('/api/identity/registry/registrations')).data?.registrations ?? []).some((r) => r.national_id === sonId));

// ---------------- Manage citizen: ministry staff screens (admin acting as an employee of each ministry) ----------------
console.log('Manage citizen: records in every ministry, through Jisr, as employee TEST-0001');
// Paced: the gateway allows 10 requests/second per IP (burst 40), and this section sends a lot from one admin.
const mg = async (path, o = {}) => { await sleep(120); return A.req(`/api/identity/manage${path}`, o); };
const auditMine = async (who) => ((await who.req('/api/jisr/audit/mine?limit=200')).data?.entries ?? []);
const waitInbox = async (who, pred) => { let n = []; for (let i = 0; i < 25 && !n.some(pred); i++) { await sleep(300); n = (await who.req('/api/identity/me/notifications')).data?.notifications ?? []; } return n.some(pred); };
const problem = (r) => r.data?.details?.problems?.[0]?.code;
const GHOST = '1999999996'; // a valid national ID (check digit) that nobody holds
const opts = (await mg('/options')).data;
check('admin may manage all five ministries', JSON.stringify(opts?.ministries?.map((m) => m.key)) === JSON.stringify(['civil', 'education', 'labor', 'property', 'health']), opts?.ministries);
check('a service-centre employee has no records permissions', (await C.req('/api/identity/manage/options')).status === 403);
check('…nor the hospital permission (cannot report births)', (await C.req('/api/identity/staff/births/options')).status === 403);
check('a citizen cannot use Manage citizen', (await M.req(`/api/identity/manage/civil/persons/${momId}`)).status === 403);
check('anonymous cannot use Manage citizen', (await new Browser().req(`/api/identity/manage/civil/persons/${momId}`)).status === 401);
// Search
const byId = await mg(`/search?q=${momId}`);
check('search by national ID finds the person', byId.data?.results?.length === 1 && byId.data.results[0].national_id === momId, byId.data);
const byName = await mg(`/search?q=${encodeURIComponent(`Test${tag}`)}`);
check('search by name finds the person', byName.data?.results?.some((r) => r.national_id === momId), byName.data);
check('a 1-letter search is refused with a clear reason', problem(await mg('/search?q=a')) === 'too_short');
check('an invalid national ID is refused', problem(await mg('/search?q=1234567890')) === 'invalid_id');
const unknownId = await mg(`/search?q=${GHOST}`);
check('an unknown (valid) national ID finds nothing', unknownId.data?.results?.length === 0, unknownId);
// Overview: one read per ministry, each through Jisr, each in the citizen's "who accessed my data"
const ov = await mg(`/persons/${momId}/overview`);
check('overview lists the five ministries with a summary each', ov.status === 200 && ov.data.ministries.length === 5 && ov.data.ministries.every((m) => m.ok), ov.data);
check('the overview shows no health details (only whether a record exists)', JSON.stringify(ov.data?.ministries?.find((m) => m.key === 'health')?.summary) === '{"exists":false}', ov.data?.ministries);
const seen = await auditMine(M);
check('every ministry read shows in the citizen’s “who accessed my data”, naming the employee',
  ['civil-registry', 'education', 'labor', 'property', 'health'].every((t) => seen.some((e) => e.target === t && e.purpose === 'record-maintenance' && e.on_behalf_of === 'employee:TEST-0001')),
  seen.filter((e) => e.purpose === 'record-maintenance').map((e) => e.target));
// Defense in depth: the ministry refuses a request without a valid staff token (Jisr also checks)
const pol = (await A.req('/api/jisr/rules')).data?.rules ?? [];
check('Jisr policy: one record-maintenance rule per ministry, Mithaq only', ['civil-registry', 'education', 'labor', 'property', 'health'].every((t) => pol.some((r) => r.client === 'mithaq' && r.target === t && r.purposes.includes('record-maintenance'))) && pol.filter((r) => r.purposes.includes('record-maintenance')).every((r) => r.client === 'mithaq'), pol.filter((r) => r.purposes.includes('record-maintenance')));

// --- Civil Registry ---
const addr = await mg(`/civil/persons/${momId}/address`, { method: 'PUT', body: { city_index: 3, district_index: 1, street: '7 Moon Rd' } });
check('Civil: change address', addr.status === 200 && addr.data.address.city.en === 'Madinat Al-Qamar' && addr.data.address.street === '7 Moon Rd', addr.data);
check('Civil: the same address again is refused (no change)', (await mg(`/civil/persons/${momId}/address`, { method: 'PUT', body: { city_index: 3, district_index: 1, street: '7 Moon Rd' } })).data?.error === 'no_change');
const emptyStreet = await mg(`/civil/persons/${momId}/address`, { method: 'PUT', body: { city_index: 3, district_index: 1, street: '   ' } });
check('Civil: an empty street is refused', emptyStreet.status === 400, emptyStreet);
check('Civil: an unknown city is refused', (await mg(`/civil/persons/${momId}/address`, { method: 'PUT', body: { city_index: 99, district_index: 1, street: 'x' } })).status === 400);
check('Civil: the change names the employee in the registry’s own log', addr.data?.changes?.[0]?.action === 'address.changed' && addr.data.changes[0].actor === 'employee:TEST-0001');
check('Jisr audit: the address change event names the employee', !!(await auditFind((e) => e.method === 'EVENT' && e.path === 'registry.address.changed' && e.subject === momId && e.on_behalf_of === 'employee:TEST-0001')));
check('the citizen is told her address changed', await waitInbox(M, (n) => n.type === 'registry.address.changed'));
// a husband for the mother (another test person)
const rh = await A.req('/api/identity/registry/persons', { body: person({ given_name: { ar: 'زوج', en: `Husband${tag}` }, gender: 'M', birth_date: '1958-05-05' }) });
const husbandId = rh.data?.person?.national_id;
const mar = (body) => mg(`/civil/persons/${momId}/marriage`, { body });
check('Civil: marriage date in the future is refused', problem(await mar({ spouse_id: husbandId, married_on: '2999-01-01' })) === 'in_future');
check('Civil: marrying oneself is refused', problem(await mar({ spouse_id: momId, married_on: '2000-01-01' })) === 'same_person');
check('Civil: marrying one’s own child is refused', problem(await mar({ spouse_id: sonId, married_on: '2020-01-01' })) === 'not_available' || problem(await mar({ spouse_id: sonId, married_on: '2020-01-01' })) === 'close_relative');
check('Civil: a marriage date before both were adults is refused', problem(await mar({ spouse_id: husbandId, married_on: '1975-01-01' })) === 'before_adult');
check('Civil: a malformed date is refused', (await mar({ spouse_id: husbandId, married_on: '2020-02-30' })).status === 400 || problem(await mar({ spouse_id: husbandId, married_on: '2020-02-30' })) === 'invalid_date');
const married = await mar({ spouse_id: husbandId, married_on: '1985-06-01' });
check('Civil: register a marriage — both records updated', married.status === 200 && married.data.marital_status === 'married' && married.data.family.some((f) => f.relation === 'spouse' && f.national_id === husbandId) && married.data.married_on === '1985-06-01', married.data);
const hRec = (await mg(`/civil/persons/${husbandId}`)).data;
check('…the spouse’s record says married to her', hRec?.marital_status === 'married' && hRec.family.some((f) => f.relation === 'spouse' && f.national_id === momId));
check('Civil: someone already married cannot marry again', problem(await mg(`/civil/persons/${wifeId}/marriage`, { body: { spouse_id: husbandId, married_on: '2015-01-01' } })) === 'already_married');
check('Jisr audit: the marriage event is in both people’s audit, naming the employee', !!(await auditFind((e) => e.path === 'registry.marriage.registered' && e.subject === momId && e.on_behalf_of === 'employee:TEST-0001')) && !!(await auditFind((e) => e.path === 'registry.marriage.registered' && e.subject === husbandId)));
check('the citizen is told her marriage was registered', await waitInbox(M, (n) => n.type === 'registry.marriage.registered' && n.body.en.includes(husbandId)));
check('Civil: marital status cannot be “corrected” while a spouse is linked', problem(await mg(`/civil/persons/${momId}/marital-status`, { method: 'PUT', body: { marital_status: 'single' } })) === 'has_spouse');
// parents and children
const par = await mg(`/civil/persons/${sonId}/parents`, { method: 'PUT', body: { father_id: husbandId, mother_id: momId } });
check('Civil: set the son’s father', par.status === 200 && par.data.family.some((f) => f.relation === 'father' && f.national_id === husbandId), par.data);
check('Civil: the same person cannot be both parents', problem(await mg(`/civil/persons/${sonId}/parents`, { method: 'PUT', body: { father_id: husbandId, mother_id: husbandId } })) === 'same_parent');
check('Civil: a mother must be a woman', problem(await mg(`/civil/persons/${sonId}/parents`, { method: 'PUT', body: { father_id: null, mother_id: husbandId } })) === 'wrong_gender');
check('Civil: a parent must be at least 12 years older', problem(await mg(`/civil/persons/${husbandId}/parents`, { method: 'PUT', body: { father_id: sonId, mother_id: null } })) === 'not_plausible');
check('Civil: a parent ID that does not exist is refused', problem(await mg(`/civil/persons/${sonId}/parents`, { method: 'PUT', body: { father_id: GHOST, mother_id: momId } })) === 'not_found');
const unl = await mg(`/civil/persons/${momId}/children/${sonId}`, { method: 'DELETE' });
check('Civil: unlink a child', unl.status === 200 && !unl.data.family.some((f) => f.national_id === sonId && f.relation === 'child'), unl.data?.family);
const rel = await mg(`/civil/persons/${momId}/children`, { body: { child_id: sonId } });
check('Civil: link the child again', rel.status === 200 && rel.data.family.some((f) => f.national_id === sonId && f.relation === 'child'), rel.data?.family);
check('Civil: linking the same child twice says “no change”', (await mg(`/civil/persons/${momId}/children`, { body: { child_id: sonId } })).data?.error === 'no_change');
check('Civil: a “child” older than the parent is refused', problem(await mg(`/civil/persons/${wifeId}/children`, { body: { child_id: husbandId } })) === 'not_plausible');
const div = await mg(`/civil/persons/${momId}/divorce`, { body: { divorced_on: '1984-01-01' } });
check('Civil: a divorce dated before the marriage is refused', problem(div) === 'before_marriage', div.data);
const div2 = await mg(`/civil/persons/${momId}/divorce`, { body: { divorced_on: '2010-03-03' } });
check('Civil: register a divorce — both become divorced', div2.data?.marital_status === 'divorced' && !div2.data.family.some((f) => f.relation === 'spouse') && (await mg(`/civil/persons/${husbandId}`)).data?.marital_status === 'divorced', div2.data);
check('the citizen is told about the divorce', await waitInbox(M, (n) => n.type === 'registry.marriage.dissolved'));

// --- Education ---
const ed = (path, o) => mg(`/education/persons/${momId}${path}`, o);
const deg = { level: 'bachelor', institution_index: 0, major_index: 1, graduation_year: 1985, grade_index: 0 };
const d1 = await ed('/degrees', { body: deg });
check('Education: add a degree', d1.status === 200 && d1.data.degrees.some((d) => d.level === 'bachelor' && d.graduation_year === 1985 && d.institution.en === 'Sarab National University'), d1.data);
check('Education: the same degree twice is refused', (await ed('/degrees', { body: deg })).data?.error === 'duplicate_degree');
check('Education: a graduation year before she was 14 is refused', problem(await ed('/degrees', { body: { ...deg, graduation_year: 1970 } })) === 'too_young');
check('Education: a graduation year in the future is refused', problem(await ed('/degrees', { body: { ...deg, graduation_year: 2099 } })) === 'in_future');
check('Education: an unknown level is refused', (await ed('/degrees', { body: { ...deg, level: 'wizard' } })).status === 400);
check('Education: a missing field is refused', (await ed('/degrees', { body: { level: 'bachelor' } })).status === 400);
const degId = d1.data?.degrees?.find((d) => d.level === 'bachelor')?.id;
const d2 = await ed(`/degrees/${degId}`, { method: 'PUT', body: { ...deg, grade_index: 2, major_index: 4 } });
check('Education: correct a degree', d2.data?.degrees?.find((d) => d.id === degId)?.grade.en === 'Good' && d2.data.degrees.find((d) => d.id === degId).field.en === 'Business Administration', d2.data);
const en1 = await ed('/enrollment', { method: 'PUT', body: { institution_index: 1, stage_index: 1, since_year: 2024 } });
check('Education: record current studies', en1.data?.enrollment?.stage?.en === 'Postgraduate student', en1.data);
check('Education: end current studies', (await ed('/enrollment', { method: 'DELETE' })).data?.enrollment === null);
check('Education: remove a degree', !(await ed(`/degrees/${degId}`, { method: 'DELETE' })).data?.degrees?.some((d) => d.id === degId));
await ed('/degrees', { body: deg });
check('the citizen sees the degree in her own education view', ((await M.req('/api/identity/me/education')).data?.degrees ?? []).some((d) => d.level === 'bachelor' && d.graduation_year === 1985));
check('the citizen is told her education record changed', await waitInbox(M, (n) => n.type === 'education.record.changed'));
check('Jisr audit: education change event names the employee', !!(await auditFind((e) => e.path === 'education.record.changed' && e.subject === momId && e.on_behalf_of === 'employee:TEST-0001')));

// --- Labor ---
const lb = (path, o) => mg(`/labor/persons/${momId}${path}`, o);
const job = { employer_index: 0, job_title_index: 1, monthly_salary: 12000, start_date: '2020-01-15', end_date: null };
check('Labor: a new citizen starts with no employment record', (await lb('')).data?.current === null);
const j1 = await lb('/jobs', { body: job });
check('Labor: add a current job → status employed, salary is the income', j1.data?.current?.status === 'employed' && j1.data.current.monthly_income === 12000 && j1.data.current.employer.name.en === 'Sarab Telecom Company' && j1.data.current.income_source.en === 'Salary', j1.data);
check('Labor: a social-insurance number is created', /^SI-\d{7}$/.test(j1.data?.social_insurance?.number ?? ''));
check('Labor: an overlapping job is refused', problem(await lb('/jobs', { body: { ...job, start_date: '2021-01-01' } })) === 'overlaps');
check('Labor: an end date before the start is refused', problem(await lb('/jobs', { body: { ...job, start_date: '2010-01-01', end_date: '2009-01-01' } })) === 'before_start');
check('Labor: a start date in the future is refused', problem(await lb('/jobs', { body: { ...job, start_date: '2999-01-01' } })) === 'in_future');
check('Labor: a job started before age 15 is refused', problem(await lb('/jobs', { body: { ...job, start_date: '1970-01-01', end_date: '1971-01-01' } })) === 'too_young');
check('Labor: a zero salary is refused', (await lb('/jobs', { body: { ...job, monthly_salary: 0 } })).status === 400);
check('Labor: a past job is added to the history', (await lb('/jobs', { body: { ...job, employer_index: 2, job_title_index: 6, start_date: '2000-01-01', end_date: '2019-12-31', monthly_salary: 8000 } })).data?.jobs?.length === 2);
const empNow = (await M.req('/api/identity/me/employment')).data;
check('the citizen’s employment (what her income proof is built from) shows the new job', empNow?.status === 'employed' && empNow.employer?.name?.en === 'Sarab Telecom Company' && empNow.monthly_income === 12000, empNow);
check('the citizen is told her employment changed and that banks will see it', await waitInbox(M, (n) => n.type === 'labor.employment.changed' && /bank/.test(n.body.en)));
const curJob = j1.data?.jobs?.[0]?.id;
const j2 = await lb(`/jobs/${curJob}`, { method: 'PUT', body: { ...job, end_date: '2025-06-30' } });
check('Labor: end the current job → no current employer, job-seeking', j2.data?.current?.status === 'job_seeking' && j2.data.current.employer === null && j2.data.current.monthly_income === 0, j2.data?.current);
check('Labor: job-seeking with an income is refused', problem(await lb('/status', { method: 'PUT', body: { status: 'job_seeking', monthly_income: 500 } })) === 'must_be_zero');
const st = await lb('/status', { method: 'PUT', body: { status: 'self_employed', monthly_income: 9000 } });
check('Labor: set self-employed with business income', st.data?.current?.status === 'self_employed' && st.data.current.monthly_income === 9000 && st.data.current.income_source.en === 'Business income', st.data?.current);
check('Labor: remove a job recorded in error', (await lb(`/jobs/${curJob}`, { method: 'DELETE' })).data?.jobs?.length === 1);
check('Labor: a made-up job ID is not found', (await lb('/jobs/JOB-nope', { method: 'DELETE' })).status === 404);

// --- Property & Vehicles (between test people only) ---
const pr = (path, o, who = momId) => mg(`/property/persons/${who}${path}`, o);
const v1 = await pr('/vehicles', { body: { make_index: 0, model_index: 1, year: 2022, color_index: 2 } });
const plate = v1.data?.plate;
check('Property: register a vehicle (a plate is allocated, valid one year)', v1.data?.vehicles?.some((v) => v.plate === plate && v.make === 'Najm' && v.model === 'Rihla' && v.status === 'valid'), v1.data);
check('Property: a model that the make does not have is refused', problem(await pr('/vehicles', { body: { make_index: 1, model_index: 2, year: 2022, color_index: 0 } })) === 'not_this_make');
check('Property: a model year in the future is refused', problem(await pr('/vehicles', { body: { make_index: 0, model_index: 0, year: 2090, color_index: 0 } })) === 'in_future');
check('Property: renewing a new registration is too early', (await pr(`/vehicles/${encodeURIComponent(plate)}/renewal`, { body: {} })).data?.error === 'too_early');
check('Property: transfer to a non-existent person is refused', problem(await pr(`/vehicles/${encodeURIComponent(plate)}/transfer`, { body: { new_owner_id: GHOST } })) === 'not_found');
check('Property: transfer to oneself is refused', problem(await pr(`/vehicles/${encodeURIComponent(plate)}/transfer`, { body: { new_owner_id: momId } })) === 'same_person');
const tr = await pr(`/vehicles/${encodeURIComponent(plate)}/transfer`, { body: { new_owner_id: sonId } });
check('Property: transfer the vehicle to her son', tr.status === 200 && !tr.data.vehicles.some((v) => v.plate === plate) && (await pr('', {}, sonId)).data?.vehicles?.some((v) => v.plate === plate), tr.data);
check('Jisr audit: Property checked the new owner at the Civil Registry (in the son’s audit)', !!(await auditFind((e) => e.client === 'property' && e.target === 'civil-registry' && e.purpose === 'ownership-transfer' && e.subject === sonId)));
check('Jisr audit: the transfer event is in both people’s audit', !!(await auditFind((e) => e.path === 'property.vehicle.transferred' && e.subject === sonId && e.on_behalf_of === 'employee:TEST-0001')) && !!(await auditFind((e) => e.path === 'property.vehicle.transferred' && e.subject === momId)));
check('the previous owner is told', await waitInbox(M, (n) => n.type === 'property.vehicle.transferred' && n.body.en.includes(sonId)));
check('Property: deregister the vehicle', !(await pr(`/vehicles/${encodeURIComponent(plate)}`, { method: 'DELETE' }, sonId)).data?.vehicles?.some((v) => v.plate === plate));
check('Property: a deregistered vehicle cannot be renewed or transferred', (await pr(`/vehicles/${encodeURIComponent(plate)}/transfer`, { body: { new_owner_id: momId } }, sonId)).status === 404);
const p1 = await pr('/properties', { body: { type_index: 0, city_index: 2, district_index: 3, area_m2: 140, share_percent: 50 } });
const deed = p1.data?.properties?.[0]?.deed_no;
check('Property: add a property deed', /^DEED-/.test(deed ?? '') && p1.data.properties[0].area_m2 === 140, p1.data);
check('Property: a share over 100 % is refused', (await pr('/properties', { body: { type_index: 0, city_index: 2, district_index: 3, area_m2: 140, share_percent: 150 } })).status === 400);
check('Property: correct the deed', (await pr(`/properties/${deed}`, { method: 'PUT', body: { type_index: 1, city_index: 2, district_index: 3, area_m2: 300, share_percent: 100 } })).data?.properties?.[0]?.area_m2 === 300);
check('Property: remove the deed', (await pr(`/properties/${deed}`, { method: 'DELETE' })).data?.properties?.length === 0);

// --- Health (minimal, fake; events carry no medical details) ---
const hl = (path, o) => mg(`/health/persons/${momId}${path}`, o);
check('Health: a vaccination needs the health summary first', (await hl('/vaccinations', { body: { vaccine_index: 2, given_on: '2024-10-01' } })).data?.error === 'no_health_record');
const h1 = await hl('', { method: 'PUT', body: { blood_type: 'A+', allergy_indices: [0], condition_indices: [], clinic_index: 0, organ_donor: true } });
check('Health: create the health summary', h1.data?.exists === true && h1.data.blood_type === 'A+' && h1.data.allergies[0].en === 'Penicillin' && h1.data.organ_donor === true, h1.data);
check('Health: an unknown blood type is refused', (await hl('', { method: 'PUT', body: { blood_type: 'Z', allergy_indices: [], condition_indices: [], clinic_index: 0, organ_donor: false } })).status === 400);
const vx = await hl('/vaccinations', { body: { vaccine_index: 2, given_on: '2024-10-01' } });
check('Health: record a vaccination', vx.data?.vaccinations?.some((v) => v.name.en === 'Seasonal influenza' && v.given_on === '2024-10-01'), vx.data);
check('Health: a vaccination before birth is refused', problem(await hl('/vaccinations', { body: { vaccine_index: 0, given_on: '1950-01-01' } })) === 'before_birth');
check('Health: a vaccination in the future is refused', problem(await hl('/vaccinations', { body: { vaccine_index: 0, given_on: '2999-01-01' } })) === 'in_future');
check('Health: remove a vaccination', (await hl(`/vaccinations/${vx.data.vaccinations[0].id}`, { method: 'DELETE' })).data?.vaccinations?.length === 0);
const hev = await auditFind((e) => e.path === 'health.record.updated' && e.subject === momId && e.on_behalf_of === 'employee:TEST-0001');
check('Jisr audit: health change event names the employee', !!hev);
check('the citizen is told her health record changed (no details in the message)', await waitInbox(M, (n) => n.type === 'health.record.updated' && !/Penicillin|A\+/.test(n.body.en)));
check('Health: the change log says who and when, not what', JSON.stringify((await hl('')).data?.changes?.[0] ?? {}).match(/Penicillin|blood/) === null);
// an address change in another city → Health moves her to that city's health centre (pulled through Jisr)
await mg(`/civil/persons/${momId}/address`, { method: 'PUT', body: { city_index: 4, district_index: 0, street: '1 Reem St' } });
let clinic = '';
for (let i = 0; i < 25 && !/Wadi Al-Reem/.test(clinic); i++) { await sleep(300); clinic = (await hl('')).data?.primary_clinic?.en ?? ''; }
check('life event: after an address change, Health assigns the new city’s health centre', /Wadi Al-Reem/.test(clinic), clinic);
check('Jisr audit: Health read the new address for care assignment', !!(await auditFind((e) => e.client === 'health' && e.purpose === 'care-assignment' && e.subject === momId)));

// --- Permissions and the staff token ---
check('a records path outside the five ministries is not found', (await mg(`/bank/persons/${momId}`)).status === 404);
check('a person who does not exist cannot get records', (await mg(`/education/persons/${GHOST}/degrees`, { body: deg })).data?.error === 'person_not_found');
check('every record-maintenance exchange in the audit names an employee', ((await A.req('/api/jisr/audit?limit=500')).data?.entries ?? []).filter((e) => e.purpose === 'record-maintenance').every((e) => /^employee:/.test(e.on_behalf_of ?? '')));
}

console.log('No destructive endpoints exposed');
for (const [m, p] of [['DELETE', '/api/jisr/audit'], ['POST', '/api/jisr/audit/reset'], ['DELETE', '/api/consent/consents'], ['POST', '/api/identity/reset'], ['DELETE', '/api/bank/customers']]) {
  const r = await A.req(p, { method: m, body: m === 'POST' ? {} : undefined });
  check(`${m} ${p} does not exist (even for admin)`, r.status === 404, r.status);
}

console.log('Citizen key on her own device (Phase 6) — Aminah');
const W = new Browser();
const aminah = '1100000023';
check('Aminah logs in', (await W.login(aminah, DEMO_PASSWORD)).status === 200);
await W.req('/api/identity/me/device-key', { method: 'DELETE' }); // start from the cloud key (re-runnable)
for (const k of (await W.req('/api/identity/me/passkeys')).data?.passkeys ?? []) await W.req(`/api/identity/me/passkeys/${encodeURIComponent(k.credential_id)}`, { method: 'DELETE' });
check('by default the key is server-held ("cloud wallet")', (await W.req('/api/identity/me/device-key')).data?.mode === 'cloud');
check('enrolment needs a passkey first', (await W.req('/api/identity/me/device-key/options', { method: 'POST', body: {} })).data?.error === 'passkey_required');
const wa = new SoftAuthenticator();
const wro = await W.req('/api/identity/me/passkeys/options', { method: 'POST', body: {} });
await W.req('/api/identity/me/passkeys', { body: { challenge_id: wro.data.challenge_id, response: wa.register(wro.data.options), nickname: 'Aminah phone (e2e)' } });
const dev = await deviceKeyPair();
const eo = await W.req('/api/identity/me/device-key/options', { method: 'POST', body: {} });
const er = await W.req('/api/identity/me/device-key', { body: { ceremony_id: eo.data.ceremony_id, assertion: wa.authenticate(eo.data.options), public_jwk: dev.publicJwk } });
check('device key enrolled after a passkey check; server keeps no private key', er.data?.ok === true && er.data.server_holds_private_key === false, er);
const devStatus = (await W.req('/api/identity/me/device-key')).data;
check('status: key on device, server_holds_private_key = false', devStatus?.mode === 'device' && devStatus.server_holds_private_key === false && devStatus.public_jwk?.kty === 'EC');
check('Mithaq can no longer sign for her', (await W.req('/api/identity/me/signatures', { body: { title: 'x', content: 'y' } })).data?.error === 'device_key');
const evilKey = { ...dev.publicJwk, d: 'AAAA' };
const evilOpts = await W.req('/api/identity/me/device-key/options', { method: 'POST', body: {} });
const evilTry = await W.req('/api/identity/me/device-key', { body: { ceremony_id: evilOpts.data.ceremony_id, assertion: wa.authenticate(evilOpts.data.options), public_jwk: evilKey } });
check('a private key is never accepted as "public key"', evilTry.data?.error === 'bad_device_key', evilTry);

// Document signature on the device
const docText = 'Tenancy renewal for apartment 4, signed on my phone.';
const docC = await W.req('/api/identity/me/ceremonies', { body: { purpose: 'document', input: { title: 'Tenancy renewal', content: docText } } });
const djws = await es256(dev.privateKey, { alg: 'ES256', kid: docC.data.kid }, docC.data.payload_json);
const wrongJws = await es256(dev.privateKey, { alg: 'ES256', kid: docC.data.kid }, docC.data.payload_json.replace('Tenancy', 'Sale of'));
const dWrong = await W.req(`/api/identity/me/ceremonies/${docC.data.ceremony_id}/complete`, { body: { assertion: wa.authenticate(docC.data.options), jws: wrongJws } });
check('a device signature over a different text is rejected', dWrong.data?.error === 'bad_signature', dWrong);
const dc2 = await W.req('/api/identity/me/ceremonies', { body: { purpose: 'document', input: { title: 'Tenancy renewal', content: docText } } });
const djws2 = await es256(dev.privateKey, { alg: 'ES256', kid: dc2.data.kid }, dc2.data.payload_json);
check('signing without the passkey step is refused', (await W.req(`/api/identity/me/ceremonies/${dc2.data.ceremony_id}/complete`, { body: { assertion: {}, jws: djws2 } })).status === 401);
const dc3 = await W.req('/api/identity/me/ceremonies', { body: { purpose: 'document', input: { title: 'Tenancy renewal', content: docText } } });
const djws3 = await es256(dev.privateKey, { alg: 'ES256', kid: dc3.data.kid }, dc3.data.payload_json);
const dOk = await W.req(`/api/identity/me/ceremonies/${dc3.data.ceremony_id}/complete`, { body: { assertion: wa.authenticate(dc3.data.options), jws: djws3 } });
check('document signed ON THE DEVICE after a passkey check', dOk.status === 200 && dOk.data.jws === djws3, dOk);
const dv = await anon.req('/api/identity/signatures/verify', { body: { jws: djws3, content: docText } });
check('anyone verifies it; marked as a device-held key', dv.data?.valid === true && dv.data.key?.device_bound === true, dv.data);

// Bank account with a device-bound proof
const wb = await W.req('/api/bank/onboarding/start', { body: { scenario: 'standard' } });
const wReq = wb.data.redirect.split('/').pop();
const wv = (await W.req(`/api/consent/requests/${wReq}`)).data;
check('consent request carries the bank’s nonce and audience (for device binding)', wv?.audience === 'bank-alwaha' && (wv.nonce ?? '').length >= 16);
const wap = await W.req(`/api/consent/requests/${wReq}/approve`, { method: 'POST', body: {} });
const wConsent = wap.data.consent_id;
const wantClaims = wv.claims.map((c) => c.name);
const wc = await W.req('/api/identity/me/ceremonies', { body: { purpose: 'wallet', input: { consent_id: wConsent, claims: wantClaims } } });
const wcc = await W.req(`/api/identity/me/ceremonies/${wc.data.ceremony_id}/complete`, { body: { assertion: wa.authenticate(wc.data.options) } });
check('after a passkey check the wallet receives credentials bound to the DEVICE key', wcc.data?.credentials?.length === 2 && wcc.data.credentials.every((c) => JSON.parse(Buffer.from(c.sd_jwt.split('.')[1], 'base64url')).cnf.jwk.kty === 'EC'), wcc.data);
const presentations = [];
for (const c of wcc.data?.credentials ?? []) presentations.push({ credential: c.credential, vct: c.vct, issuer: c.issuer, presentation: await devicePresent(c.sd_jwt, wantClaims, dev.privateKey, wv.audience, wv.nonce) });
check('the device hands its selective-disclosure presentations to Idhn', (await W.req(`/api/consent/consents/${wConsent}/presentations`, { body: { presentations } })).status === 200);
const wdone = await W.req('/api/bank/onboarding/complete', { body: { request_id: wReq, consent_id: wConsent } });
check('the bank verifies the device-bound proofs and opens the account', ['opened', 'already_customer'].includes(wdone.data?.status) && wdone.data.received_claims?.age_over_18 === true && !('birth_date' in wdone.data.received_claims), wdone);
check('…key binding was made with the device key (ES256), not by Mithaq', (wdone.data?.inspection ?? []).every((i) => i.issuer_payload?.cnf?.jwk?.kty === 'EC'));
const wk = await W.req('/api/bank/me/kyc-refresh', { method: 'POST', body: {} });
check('KYC refresh now needs the citizen herself (no server key to sign with)', wk.data?.ok === false && wk.data.reason === 'citizen_presence_required', wk.data);

// Delegation mandate signed on the device
const mc = await W.req('/api/identity/me/ceremonies', { body: { purpose: 'mandate', input: { delegate_id: omarId, scopes: ['assets.view'], days: 30 } } });
const mjws = await es256(dev.privateKey, { alg: 'ES256', kid: mc.data.kid }, mc.data.payload_json);
const mdone = await W.req(`/api/identity/me/ceremonies/${mc.data.ceremony_id}/complete`, { body: { assertion: wa.authenticate(mc.data.options), jws: mjws } });
check('delegation mandate signed on the device', mdone.data?.status === 'active' && mdone.data.mandate_jws === mjws, mdone);
check('the old server-side delegation route refuses (device signature required)', (await W.req('/api/identity/me/delegations', { body: { delegate_id: omarId, scopes: ['assets.view'], days: 30 } })).data?.error === 'device_signature_required');
await W.req(`/api/identity/me/delegations/${mdone.data?.id}`, { method: 'DELETE' });

// Back to the demo default
check('demo: return to a server-held key', (await W.req('/api/identity/me/device-key', { method: 'DELETE' })).data?.mode === 'cloud');
check('the device-signed document still verifies after the key was retired', (await anon.req('/api/identity/signatures/verify', { body: { jws: djws3, content: docText } })).data?.valid === true);
for (const k of (await W.req('/api/identity/me/passkeys')).data?.passkeys ?? []) await W.req(`/api/identity/me/passkeys/${encodeURIComponent(k.credential_id)}`, { method: 'DELETE' });

console.log('Early session revocation (Phase 6)');
const D1 = new Browser(), D2 = new Browser();
await D1.login(layla.username, DEMO_PASSWORD);
const d2s = await D2.login(layla.username, DEMO_PASSWORD);
const mySessions = (await D1.req('/api/identity/me/sessions')).data?.sessions ?? [];
check('I can list my sessions (current one marked)', mySessions.length >= 2 && mySessions.filter((x) => x.current).length === 1, mySessions.length);
const other = mySessions.find((x) => x.id === d2s.data?.session?.sid);
check('sign out the other device', (await D1.req(`/api/identity/me/sessions/${other?.id}`, { method: 'DELETE' })).status === 200);
const r1 = await D2.req('/api/consent/consents/mine');
check('…its token is refused at once by OTHER services too (consent)', r1.status === 401 && r1.data?.error === 'session_revoked', r1);
const stolen = D1.jar.get('sarab_session');
check('my own session still works', (await D1.req('/api/jisr/audit/mine?limit=1')).status === 200);
await D1.req('/api/identity/auth/logout', { method: 'POST', body: {} });
const T = new Browser(); T.jar.set('sarab_session', stolen);
const r2 = await T.req('/api/jisr/audit/mine?limit=1');
check('sign-out revokes server-side: a copied token is useless afterwards', r2.status === 401 && r2.data?.error === 'session_revoked', r2);
const E1 = new Browser(), E2 = new Browser();
await E1.login(layla.username, DEMO_PASSWORD); await E2.login(layla.username, DEMO_PASSWORD);
const E1copy = new Browser(); E1copy.jar.set('sarab_session', E1.jar.get('sarab_session'));
check('"sign out everywhere"', (await E1.req('/api/identity/me/sessions/sign-out-everywhere', { method: 'POST', body: {} })).status === 200);
check('…ends every session of that person, including this one', (await E2.req('/api/identity/me/record')).data?.error === 'session_revoked' && (await E1copy.req('/api/bank/me')).data?.error === 'session_revoked');
check('signing in again afterwards works', (await new Browser().login(layla.username, DEMO_PASSWORD)).status === 200);
check('admin revokes all of Yousef’s sessions', (await A.req(`/api/identity/admin/subjects/${yousef.username}/revoke-sessions`, { method: 'POST', body: {} })).status === 200);
check('Jisr audit: the session revocation names the admin', !!(await auditFind((e) => e.method === 'EVENT' && e.path === 'mithaq.admin.action' && e.subject === yousef.username && e.on_behalf_of === 'employee:TEST-0001')));
check('…Yousef is signed out', (await Y.req('/api/identity/me/record')).data?.error === 'session_revoked');
check('citizens cannot use the kill-switch', (await S.req('/api/identity/admin/kill-switch', { method: 'POST', body: {} })).status === 403);
const adm = await A.req('/api/identity/admin/sessions');
check('admin sees active sessions by role and the revocation log', Array.isArray(adm.data?.active_by_role) && adm.data.admin_actions.some((x) => x.action === 'revoke_sessions'), adm.data?.admin_actions);

console.log('Native apps (API v1): bearer tokens, device registration, rotating refresh tokens');
{
  const NATIVE = { 'x-sarab-client': 'native' };
  const appSignIn = async (B) => {
    const p = await B.req('/api/v1/identity/auth/password', { body: { username: layla.username, password: DEMO_PASSWORD }, headers: NATIVE });
    const o = await B.req('/api/v1/identity/auth/otp', { body: { otp_challenge_id: p.data?.otp_challenge_id, code: p.data?.test_code }, headers: NATIVE });
    B.jar.clear();   // an app keeps no cookies: only the bearer token
    return o;
  };
  const App = new Browser();
  const ao = await appSignIn(App);
  check('app sign-in through /api/v1 returns the session token in the body', ao.status === 200 && typeof ao.data?.token === 'string', ao.status);
  let bearer = ao.data?.token;
  const H = () => ({ ...NATIVE, authorization: `Bearer ${bearer}` });
  const v1res = await fetch(`${BASE}/api/v1/identity/apps/config`);
  const cfg = await v1res.json();
  check('app config: API v1, passkey relying party, API-Version header', cfg.api_version === '1' && cfg.passkeys?.rp_id === RP_ID && v1res.headers.get('api-version') === '1', cfg);
  const spec = await (await fetch(`${BASE}/api/v1/openapi.json`)).json();
  check('combined public spec at /api/v1/openapi.json', spec.openapi === '3.1.0' && Object.keys(spec.paths ?? {}).some((p) => p === '/api/v1/identity/apps/token'), Object.keys(spec.paths ?? {}).length);
  const aasa = await (await fetch(`${BASE}/.well-known/apple-app-site-association`)).json();
  const al = await fetch(`${BASE}/.well-known/assetlinks.json`);
  check('associated-domain files for app passkeys are served as JSON', Array.isArray(aasa.webcredentials?.apps) && al.headers.get('content-type')?.includes('json') && Array.isArray(await al.json()));
  check('bearer token works on other services through /api/v1', (await App.req('/api/v1/jisr/audit/mine?limit=1', { headers: H() })).status === 200);
  const notNative = await App.req('/api/v1/identity/apps/devices', { body: { platform: 'ios', name: `x ${RUN}` }, headers: { authorization: `Bearer ${bearer}` } });
  check('only apps register devices', notNative.status === 400 && notNative.data?.error === 'native_only', notNative);
  const reg = await App.req('/api/v1/identity/apps/devices', { body: { platform: 'ios', name: `iPhone ${RUN}`, app_version: '0.1' }, headers: H() });
  check('device registered right after a real sign-in → refresh token', reg.status === 201 && /^srt_/.test(reg.data?.refresh_token ?? ''), reg);
  const t1 = await App.req('/api/v1/identity/apps/token', { body: { device_id: reg.data?.device_id, refresh_token: reg.data?.refresh_token } });
  check('refresh → new session token + a new refresh token', t1.status === 200 && !!t1.data?.token && t1.data.refresh_token !== reg.data?.refresh_token && t1.data.session?.amr?.includes('refresh'), t1);
  bearer = t1.data?.token;
  check('…the refreshed session works', (await App.req('/api/v1/identity/me/record', { headers: H() })).status === 200);
  const signR = await App.req('/api/v1/identity/me/signatures', { body: { title: 'x', content: 'y' }, headers: H() });
  check('…but signing a document needs a real sign-in, not a refresh', signR.status === 401 && signR.data?.error === 'reauth_required', signR);
  const regR = await App.req('/api/v1/identity/apps/devices', { body: { platform: 'android', name: `x ${RUN}` }, headers: H() });
  check('…and so does registering another device', regR.status === 401 && regR.data?.error === 'reauth_required', regR);
  check('push token stored for later', (await App.req(`/api/v1/identity/apps/devices/${reg.data?.device_id}/push`, { method: 'PUT', body: { provider: 'apns', token: 'test-push-token-123' }, headers: H() })).status === 200);
  const devs = await App.req('/api/v1/identity/apps/devices', { headers: H() });
  check('my devices (this one marked current; push tokens never shown)', !!devs.data?.devices?.some((d) => d.device_id === reg.data?.device_id && d.current && d.push === 'apns') && !JSON.stringify(devs.data).includes('test-push-token'), devs.data);
  const reuse = await App.req('/api/v1/identity/apps/token', { body: { device_id: reg.data?.device_id, refresh_token: reg.data?.refresh_token } });
  check('re-using an old refresh token is detected', reuse.status === 401 && reuse.data?.error === 'refresh_reused', reuse);
  const after = await App.req('/api/v1/identity/apps/token', { body: { device_id: reg.data?.device_id, refresh_token: t1.data?.refresh_token } });
  check('…and cuts the device off: its newest refresh token and its sessions stop working', after.status === 401 && (await App.req('/api/v1/identity/me/record', { headers: H() })).status === 401, after);
  // Device 2: removed by its owner. Device 3: cut off by "sign out everywhere".
  const App2 = new Browser();
  bearer = (await appSignIn(App2)).data?.token;
  const reg2 = await App2.req('/api/v1/identity/apps/devices', { body: { platform: 'android', name: `Pixel ${RUN}` }, headers: H() });
  const reg3 = await App2.req('/api/v1/identity/apps/devices', { body: { platform: 'windows', name: `Laptop ${RUN}` }, headers: H() });
  const t2 = await App2.req('/api/v1/identity/apps/token', { body: { device_id: reg2.data?.device_id, refresh_token: reg2.data?.refresh_token } });
  const dev2Bearer = t2.data?.token;
  const del = await App2.req(`/api/v1/identity/apps/devices/${reg2.data?.device_id}`, { method: 'DELETE', headers: H() });
  check('removing a device revokes its refresh token and the sessions it opened', del.status === 200 && del.data?.sessions_revoked >= 1
    && (await App2.req('/api/v1/identity/apps/token', { body: { device_id: reg2.data?.device_id, refresh_token: t2.data?.refresh_token } })).status === 401
    && (await App2.req('/api/v1/identity/me/record', { headers: { authorization: `Bearer ${dev2Bearer}` } })).status === 401, del);
  check('"sign out everywhere" also cuts off app devices', (await App2.req('/api/v1/identity/me/sessions/sign-out-everywhere', { method: 'POST', body: {}, headers: H() })).status === 200
    && (await App2.req('/api/v1/identity/apps/token', { body: { device_id: reg3.data?.device_id, refresh_token: reg3.data?.refresh_token } })).status === 401);
  check('a wrong refresh token is refused', (await App2.req('/api/v1/identity/apps/token', { body: { device_id: 'dev_nope', refresh_token: 'srt_nope' } })).status === 401);
}

console.log('Signed Jisr responses (Phase 6)');
const signedEntries = ((await A.req('/api/jisr/audit?limit=200')).data?.entries ?? []).filter((e) => e.method !== 'EVENT' && e.decision === 'allow' && e.status !== 502);
check('every forwarded exchange records the hash of the ministry’s signed response', signedEntries.length > 20 && signedEntries.every((e) => /^[A-Za-z0-9_-]{43}$/.test(e.response_sha256 ?? '')), signedEntries.filter((e) => !e.response_sha256).slice(0, 3));

console.log('Admin & audit chain');
const ver = await A.req('/api/jisr/audit/verify', { method: 'POST', body: {} });
check('hash chain verifies', ver.data?.ok === true && ver.data.entries > 10, ver.data);
const all = await A.req('/api/jisr/audit?limit=500');
check('denied exchanges are logged too', (all.data?.entries ?? []).some((e) => e.status >= 400), all.data?.entries?.length);
const reqs = await A.req('/api/consent/requests');
check('admin sees policy rejections', (reqs.data?.requests ?? []).some((r) => r.status === 'rejected_by_policy'));

console.log('Government news feed on Telegram (mocked during tests: stored, never sent)');
await sleep(1500);
const feed = (await anon.req(`/api/identity/test/feed?after=${feedStart}`)).data ?? {};
const fm = feed.messages ?? [];
const fFind = (type, pred = () => true) => fm.find((m) => m.type === type && pred(m.text));
check('every message of this run is mocked — nothing was sent to Telegram', fm.length > 20 && fm.every((m) => m.status === 'mocked') && feed.not_mocked === 0, { n: fm.length, statuses: [...new Set(fm.map((m) => m.status))], not_mocked: feed.not_mocked });
check('feed messages start with their own heading, unlike codes (🔐)', fm.every((m) => m.text.startsWith('📢 خبر حكومي | ')) && /^🔐 رمز تحقق/.test(ap0.data?.test_message ?? ''), ap0.data?.test_message?.split('\n')[0]);
check('feed: birth reported — mother and father by name + ID, the employee, the time', !!fFind('health.birth.notified', (t) => t.includes(`(${layla.username})`) && t.includes(`(${omarId0})`) && t.includes('الموظف TEST-0001') && /🕒 \d{4}-\d{2}-\d{2} \d{2}:\d{2} بتوقيت الرياض/.test(t)), fFind('health.birth.notified')?.text);
check('feed: name proposed and baby named (by the citizen)', !!fFind('registry.birth.name_proposed', (t) => t.includes('سما') && t.includes(`المواطن نفسه (${layla.username})`)) && !!fFind('registry.birth.named', (t) => t.includes('ريم')));
check('feed: birth registered, health file, child benefit', ['registry.person.born', 'health.record.opened', 'labor.benefit.awarded'].every((ty) => fFind(ty)));
check('feed: new citizen registered and account activated', !!fFind('registry.person.registered', (t) => t.includes('الموظف')) && !!fFind('mithaq.account.activated'));
check('feed: marriage and divorce, with both spouses and the employee', !!fFind('registry.marriage.registered', (t) => (t.match(/👤 .+ \(1\d{9}\)/g) ?? []).length === 2 && t.includes('💍') && t.includes('الموظف TEST-0001')) && !!fFind('registry.marriage.dissolved', (t) => (t.match(/\(1\d{9}\)/g) ?? []).length >= 2));
check('feed: address change, new job, new degree, vehicle registered / transferred / renewed', ['registry.address.changed', 'labor.employment.changed', 'education.record.changed', 'property.vehicle.registered', 'property.vehicle.transferred', 'property.vehicle.renewed'].every((ty) => fFind(ty)), [...new Set(fm.map((m) => m.type))].join(','));
check('feed: a new job names the employer and title', !!fFind('labor.employment.changed', (t) => t.includes('💼 وظيفة جديدة')));
check('feed: delegation granted and revoked', !!fFind('mithaq.delegation.granted', (t) => t.includes('🤝')) && !!fFind('mithaq.delegation.revoked'));
check('feed: no health details, codes or counter steps', !fm.some((m) => ['mithaq.activation.issued', 'mithaq.assisted.action', 'mithaq.admin.action'].includes(m.type)) && !fm.some((m) => /\b\d{6,8}\b(?!\))/.test(m.text.replace(/\(1\d{9}\)/g, '').replace(/\d{4}-\d{2}-\d{2}/g, ''))));


console.log('Rate limiting');
const R = new Browser();
const statuses = await Promise.all(Array.from({ length: 45 }, () => R.req('/api/identity/auth/password', { body: { username: '1100000015', password: 'wrong-password' } }).then((r) => r.status)));
check('sign-in is rate limited (429 after a burst)', statuses.includes(429), statuses.join(','));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED:\n - ' + failures.join('\n - ')); process.exit(1); }
