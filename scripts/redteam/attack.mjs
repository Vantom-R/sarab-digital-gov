// Red-team run against the gateway, from the server itself (never through the public domain in volume).
//   make redteam
// Each attempt records whether the platform BLOCKED it. Logins use a server-minted test ticket ONLY so that
// the one-time codes of the attacker's OWN accounts are returned instead of being sent to Telegram — the
// attacks themselves never rely on it (attempts that would need a real code are made without the ticket and
// with wrong passwords, so nothing is ever sent).
import { createHmac, createPublicKey, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';

const BASE = process.env.BASE ?? 'http://127.0.0.1:18090';
const TICKET = process.env.TEST_TICKET ?? '';
const DEMO = process.env.DEMO_PASSWORD ?? '';
const CLERK = process.env.CLERK_PASSWORD ?? '';
if (TICKET.length < 32) { console.error('run via make redteam'); process.exit(2); }

const results = [];
const R = (cat, name, blocked, detail, sev = 'high') => {
  results.push({ cat, name, blocked: !!blocked, detail: typeof detail === 'string' ? detail : JSON.stringify(detail ?? '').slice(0, 220), sev });
  console.log(`${blocked ? '  BLOCKED ' : '  !! OPEN '} [${cat}] ${name}${blocked ? '' : ` — ${JSON.stringify(detail ?? '').slice(0, 300)}`}`);
};

let ipn = 0;
class Client {
  jar = new Map(); ip = `10.251.${Math.floor(Math.random() * 250)}.${++ipn % 250}`;
  async req(path, { method, body, headers = {}, raw } = {}) {
    const h = { accept: 'application/json', 'x-real-ip': this.ip, ...headers };
    if (this.jar.size) h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined && !raw) h['content-type'] ??= 'application/json';
    const res = await fetch(BASE + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: h, body: body === undefined ? undefined : raw ? body : JSON.stringify(body), redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) { const [p] = c.split(';'); const i = p.indexOf('='); const v = p.slice(i + 1); if (v) this.jar.set(p.slice(0, i), v); else this.jar.delete(p.slice(0, i)); }
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
  async login(user, pw) {
    const a = await this.req('/api/identity/auth/password', { body: { username: user, password: pw }, headers: { 'x-sarab-test-ticket': TICKET } });
    if (!a.data?.test_code) return a;
    return this.req('/api/identity/auth/otp', { body: { otp_challenge_id: a.data.otp_challenge_id, code: a.data.test_code } });
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

// The documented demo citizens (fixed IDs); their password comes from .env, never from the page.
const [layla, yousef, omar, saleh] = ['1100000049', '1100000056', '1100000031', '1100000015'];
const A = new Client();                      // attacker: an ordinary citizen (Layla)
const la = await A.login(layla, DEMO);
if (la.status !== 200) { console.error('attacker login failed', la); process.exit(1); }
const V = new Client();                      // victim (Saleh)
await V.login(saleh, DEMO);
const anon = new Client();

console.log('\n1. Authentication');
{
  // 1.1 user enumeration: unknown vs known user, wrong password
  const u1 = await new Client().req('/api/identity/auth/password', { body: { username: '1100009999', password: 'x' } });
  const u2 = await new Client().req('/api/identity/auth/password', { body: { username: omar, password: 'x' } });
  const u3 = await new Client().req('/api/identity/auth/password', { body: { username: 'admin', password: 'x' } });
  R('auth', 'user enumeration through the sign-in error', u1.status === u2.status && u2.status === u3.status && u1.data?.error === u2.data?.error, [u1.data, u2.data, u3.data], 'low');
  // 1.2 timing-based enumeration (scrypt only runs for real accounts?)
  const t = async (u) => { const s = performance.now(); await new Client().req('/api/identity/auth/password', { body: { username: u, password: 'wrong-password' } }); return performance.now() - s; };
  const tk = [], tu = [];
  for (let i = 0; i < 5; i++) { tk.push(await t(layla)); tu.push(await t('1100009998')); }
  const med = (a) => a.sort((x, y) => x - y)[2];
  R('auth', `timing-based user enumeration (known ${med(tk).toFixed(0)} ms vs unknown ${med(tu).toFixed(0)} ms)`, Math.abs(med(tk) - med(tu)) < 25, { known: med(tk), unknown: med(tu) }, 'low');
  // 1.3 password brute force from one address
  const bf = new Client();
  let r429 = 0;
  for (let i = 0; i < 40; i++) { const r = await bf.req('/api/identity/auth/password', { body: { username: yousef, password: `guess${i}` } }); if (r.status === 429) r429++; }
  R('auth', 'password brute force from one address (40 tries)', r429 > 0, { rate_limited: r429 }, 'high');
  // 1.4 the same, rotating the client address (only possible from inside the server: the gateway trusts
  //     X-Real-IP from localhost/Docker; the reverse proxy overwrites it for every real visitor — checked in 1.5).
  //     Per-ACCOUNT brake (services/identity/src/throttle.ts): after 5 wrong passwords each attempt waits
  //     1–5 s, attempts queue one behind the other, and nothing is ever locked. Target: Noor (a demo citizen).
  const noor = '1100000064';
  const timed = async (pw) => { const s = performance.now(); const r = await new Client().req('/api/identity/auth/password', { body: { username: noor, password: pw } }); return { status: r.status, ms: performance.now() - s, retry: r.headers.get('retry-after') }; };
  const seq = [];
  for (let i = 0; i < 8; i++) seq.push(await timed(`rot${i}`));
  R('auth', 'password brute force rotating addresses: per-account slowdown after 5 wrong passwords', seq.slice(0, 5).every((x) => x.ms < 1500) && seq[7].ms >= 2500,
    { ms: seq.map((x) => Math.round(x.ms)) }, 'medium');
  const t0 = performance.now();
  const parG = await Promise.all(Array.from({ length: 12 }, (_, i) => timed(`par${i}`)));
  const answered = parG.filter((x) => x.status === 401), refused = parG.filter((x) => x.status === 429);
  const span = (performance.now() - t0) / 1000;
  R('auth', `parallel guesses from 12 addresses queue per account (${answered.length} answered in ${span.toFixed(0)} s, ${refused.length} told to wait)`,
    answered.length <= Math.ceil(span / 4) + 1 && refused.every((x) => Number(x.retry) > 0),
    { answered: answered.length, refused: refused.length, seconds: span, statuses: parG.map((x) => x.status) }, 'medium');
  // Never a lock: once the attack pauses, the right password works again (and clears the brake).
  let back = null;
  for (let i = 0; i < 8 && back?.status !== 200; i++) {
    back = await new Client().req('/api/identity/auth/password', { body: { username: noor, password: DEMO }, headers: { 'x-sarab-test-ticket': TICKET } });
    if (back.status === 429) await sleep(1000 * Math.min(31, Number(back.headers.get('retry-after') ?? 5)));
  }
  R('auth', 'the per-account brake never locks the owner out (right password works once the attack pauses)', back?.status === 200, { status: back?.status, data: back?.data?.error }, 'medium');
  // Yousef's 40 guesses above (1.3) left him braked too: his right password clears it for the later tests.
  for (let i = 0; i < 4; i++) { const r = await new Client().req('/api/identity/auth/password', { body: { username: yousef, password: DEMO }, headers: { 'x-sarab-test-ticket': TICKET } }); if (r.status === 200) break; await sleep(1000 * Math.min(31, Number(r.headers.get('retry-after') ?? 5))); }
  // 1.6 OTP brute force on a real challenge (code known to us via ticket, we send wrong ones)
  const C = new Client();
  const ch = await C.req('/api/identity/auth/password', { body: { username: omar, password: DEMO }, headers: { 'x-sarab-test-ticket': TICKET } });
  const wrong = ch.data.test_code === '000000' ? '111111' : '000000';
  const outs = [];
  for (let i = 0; i < 7; i++) outs.push((await C.req('/api/identity/auth/otp', { body: { otp_challenge_id: ch.data.otp_challenge_id, code: wrong } })).status);
  const late = await C.req('/api/identity/auth/otp', { body: { otp_challenge_id: ch.data.otp_challenge_id, code: ch.data.test_code } });
  R('auth', 'one-time code brute force (7 wrong, then the right code)', late.status !== 200, { statuses: outs, right_code_after: late.status }, 'critical');
  // 1.7 OTP race: 25 parallel guesses — only 5 may be counted
  const C2 = new Client();
  await sleep(61_000);   // the per-recipient 60 s limit applies to tests too
  const ch2 = await C2.req('/api/identity/auth/password', { body: { username: omar, password: DEMO }, headers: { 'x-sarab-test-ticket': TICKET } });
  const guesses = Array.from({ length: 25 }, (_, i) => String(100000 + i * 7919).slice(0, 6)).filter((g) => g !== ch2.data.test_code);
  const par = await Promise.all(guesses.map((g) => C2.req('/api/identity/auth/otp', { body: { otp_challenge_id: ch2.data.otp_challenge_id, code: g } })));
  const counted = par.filter((p) => p.data?.error === 'otp_invalid').length;   // codes actually compared
  const after = await C2.req('/api/identity/auth/otp', { body: { otp_challenge_id: ch2.data.otp_challenge_id, code: ch2.data.test_code } });
  R('auth', 'one-time code race (25 parallel guesses)', counted <= 5 && after.status !== 200, { counted_as_attempts: counted, errors: [...new Set(par.map((p) => p.data?.error))], right_code_after: after.status }, 'critical');
  // 1.8 OTP reuse (double spend in parallel)
  await sleep(61_000);
  const C3 = new Client(), C4 = new Client();
  const ch3 = await C3.req('/api/identity/auth/password', { body: { username: omar, password: DEMO }, headers: { 'x-sarab-test-ticket': TICKET } });
  const [d1, d2] = await Promise.all([C3, C4].map((c) => c.req('/api/identity/auth/otp', { body: { otp_challenge_id: ch3.data.otp_challenge_id, code: ch3.data.test_code } })));
  R('auth', 'one-time code used twice at the same moment', [d1.status, d2.status].filter((s) => s === 200).length === 1, [d1.status, d2.status], 'high');
  // 1.9 guessing a test ticket (would return codes)
  const tg = await new Client().req('/api/identity/auth/password', { body: { username: omar, password: 'wrong' }, headers: { 'x-sarab-test-ticket': randomBytes(32).toString('hex') } });
  R('auth', 'made-up test ticket to get codes in the response', !tg.data?.test_code, tg.data, 'critical');
  // 1.10 staff accounts: admin/clerk with demo password
  const sa = await new Client().req('/api/identity/auth/password', { body: { username: 'admin', password: DEMO } });
  const sc = await new Client().req('/api/identity/auth/password', { body: { username: 'clerk', password: DEMO } });
  const st = await new Client().req('/api/identity/auth/password', { body: { username: 'test', password: process.env.TEST_STAFF_PASSWORD ?? '' }, headers: { 'x-sarab-test-ticket': '' } });
  R('auth', 'staff sign-in with the demo password', sa.status === 401 && sc.status === 401, [sa.status, sc.status], 'critical');
  R('auth', 'automated-test staff account used without a test ticket (even with its real password)', st.status === 401 && !st.data?.otp_challenge_id, st.status, 'critical');
  // 1.11 mass assignment at sign-in
  const ma = await new Client().req('/api/identity/auth/password', { body: { username: layla, password: 'x', role: 'admin', kind: 'staff' } });
  R('auth', 'extra fields at sign-in (role: admin)', ma.status !== 200 || !ma.data?.session, ma.status, 'high');
}

console.log('\n2. Session tokens');
{
  const tok = A.jar.get('sarab_session');
  const [h, p, s] = tok.split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  const use = (t) => new Client().req('/api/identity/session', { headers: { authorization: `Bearer ${t}` } });
  R('session', 'alg "none" token', (await use(`${b64u({ alg: 'none', typ: 'session+jwt' })}.${b64u({ ...payload, role: 'admin' })}.`)).status === 401, '', 'critical');
  R('session', 'role changed to admin, original signature kept', (await use(`${h}.${b64u({ ...payload, role: 'admin' })}.${s}`)).status === 401, '', 'critical');
  R('session', 'subject changed to another citizen, signature kept', (await use(`${h}.${b64u({ ...payload, sub: saleh })}.${s}`)).status === 401, '', 'critical');
  // HS256 signed with the public key as the HMAC secret (classic key confusion)
  const members = (await anon.req('/api/jisr/members')).data.members;
  const mithaq = members.find((m) => m.id === 'mithaq');
  const pubPem = createPublicKey({ key: mithaq.public_jwk ?? mithaq.jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
  const hh = b64u({ alg: 'HS256', typ: 'session+jwt' }), pp = b64u({ ...payload, role: 'admin' });
  const hs = createHmac('sha256', pubPem).update(`${hh}.${pp}`).digest('base64url');
  R('session', 'HS256 signed with Mithaq’s public key (key confusion)', (await use(`${hh}.${pp}.${hs}`)).status === 401, '', 'critical');
  R('session', 'expired token (exp in the past)', (await use(`${h}.${b64u({ ...payload, exp: 1 })}.${s}`)).status === 401, '', 'high');
  // a Jisr request assertion (signed by Mithaq, a JWT) presented as a session — typ must not match
  R('session', 'token from an unrelated purpose presented as a session', (await use('eyJhbGciOiJFZERTQSIsInR5cCI6ImppcnItcmVxdWVzdCtqd3QifQ.e30.AAAA')).status === 401, '', 'high');
  // fixation: a cookie set before sign-in must be replaced
  const F = new Client(); F.jar.set('sarab_session', 'attacker-chosen-value');
  await F.login(yousef, DEMO);
  R('session', 'session fixation (attacker-chosen cookie before sign-in)', F.jar.get('sarab_session') !== 'attacker-chosen-value', '', 'high');
  // cookie flags (via the login response)
  const L2 = new Client();
  const p1 = await L2.req('/api/identity/auth/password', { body: { username: yousef, password: DEMO }, headers: { 'x-sarab-test-ticket': TICKET } });
  const raw = await fetch(`${BASE}/api/identity/auth/otp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '10.252.0.1' }, body: JSON.stringify({ otp_challenge_id: p1.data.otp_challenge_id, code: p1.data.test_code }) });
  const sc = raw.headers.getSetCookie().join(';');
  R('session', 'session cookie flags (HttpOnly, Secure, SameSite=Strict)', /HttpOnly/i.test(sc) && /Secure/i.test(sc) && /SameSite=Strict/i.test(sc), sc.replace(/=[^;]+/, '=…'), 'medium');
  // logout then reuse
  const Lo = new Client(); await Lo.login(yousef, DEMO); const kept = Lo.jar.get('sarab_session');
  await Lo.req('/api/identity/auth/logout', { body: {} });
  R('session', 'token reused after sign-out', (await use(kept)).status === 401, '', 'high');
}

console.log('\n3. Privilege escalation');
{
  const staffOnly = [
    ['GET', '/api/identity/manage/options'], ['GET', '/api/identity/manage/search?q=al'], ['GET', `/api/identity/manage/civil/persons/${saleh}`],
    ['PUT', `/api/identity/manage/civil/persons/${saleh}/address`, { city_index: 1, district_index: 1, street: 'x' }],
    ['POST', '/api/identity/registry/persons', {}], ['GET', '/api/identity/registry/registrations'], ['POST', '/api/identity/staff/births', {}],
    ['POST', '/api/identity/counter/sessions', { national_id: saleh }], ['GET', '/api/identity/admin/sessions'], ['POST', '/api/identity/admin/kill-switch', {}],
    ['POST', `/api/identity/admin/subjects/${saleh}/revoke-sessions`, {}], ['GET', '/api/jisr/audit?limit=5'], ['POST', '/api/jisr/audit/verify', {}],
    ['POST', '/api/jisr/audit/tamper-demo', { kind: 'modify' }], ['GET', '/api/identity/admin/assisted-actions'],
  ];
  let open = [];
  for (const [m, p, b] of staffOnly) { const r = await A.req(p, { method: m, body: b }); if (r.status < 400) open.push(`${m} ${p} → ${r.status}`); }
  R('privilege', `citizen calls ${staffOnly.length} staff/admin routes`, open.length === 0, open, 'critical');
  const Cl = new Client(); await Cl.login('clerk', CLERK);
  const adminOnly = [['POST', '/api/identity/admin/kill-switch', {}], ['GET', '/api/jisr/audit?limit=5'], ['POST', '/api/jisr/audit/tamper-demo', { kind: 'modify' }],
    ['GET', `/api/identity/manage/civil/persons/${saleh}`], ['POST', '/api/identity/registry/persons', {}], ['POST', '/api/identity/staff/births', {}], ['GET', '/api/identity/admin/sessions']];
  open = [];
  for (const [m, p, b] of adminOnly) { const r = await Cl.req(p, { method: m, body: b }); if (r.status < 400) open.push(`${m} ${p} → ${r.status}`); }
  R('privilege', `clerk (counter only) calls ${adminOnly.length} admin / other-permission routes`, open.length === 0, open, 'critical');
  // clerk reads a citizen without the citizen's code
  const cs = await Cl.req('/api/identity/counter/sessions', { body: { national_id: saleh }, headers: { 'x-sarab-test-ticket': TICKET } });
  const peek = await Cl.req(`/api/identity/counter/sessions/${cs.data?.id}/record`);
  R('privilege', 'clerk reads a citizen’s record before the citizen confirms', peek.status >= 400, peek.status, 'critical');
  const guess = await Cl.req(`/api/identity/counter/sessions/${cs.data?.id}/confirm`, { body: { code: '123456' } });
  const brute = []; for (let i = 0; i < 6; i++) brute.push((await Cl.req(`/api/identity/counter/sessions/${cs.data?.id}/confirm`, { body: { code: String(200000 + i) } })).status);
  const right = await Cl.req(`/api/identity/counter/sessions/${cs.data?.id}/confirm`, { body: { code: cs.data?.test_code } });
  R('privilege', 'clerk brute-forces the citizen’s counter code', right.status !== 200 || right.data?.status !== 'active', { first: guess.status, then: brute, right_code_after: right.status }, 'critical');
  // citizen with a forged role in a body / header
  const hdr = await A.req('/api/identity/admin/sessions', { headers: { 'x-sarab-role': 'admin', 'x-forwarded-for': '127.0.0.1' } });
  R('privilege', 'spoofed role / localhost headers', hdr.status === 403, hdr.status, 'critical');
}

console.log('\n4. Other citizens’ data (IDOR)');
{
  const vs = (await V.req('/api/identity/me/sessions')).data.sessions;
  const r1 = await A.req(`/api/identity/me/sessions/${vs[0].id}`, { method: 'DELETE' });
  R('idor', 'sign out another citizen’s session by id', r1.status === 404 && (await V.req('/api/identity/me/record')).status === 200, r1.status, 'high');
  const sd = await (async () => { const S = new Client(); await S.login(saleh, DEMO); return S.req('/api/identity/me/delegations', { body: { delegate_id: omar, scopes: ['vehicles.renew'], days: 1 } }); })();
  const did = sd.data?.id;
  R('idor', 'act as delegate on someone else’s mandate', (await A.req(`/api/identity/acting/${did}/assets`)).status >= 400, '', 'critical');
  R('idor', 'revoke someone else’s mandate', (await A.req(`/api/identity/me/delegations/${did}`, { method: 'DELETE' })).status >= 400, '', 'high');
  const O = new Client(); await O.login(omar, DEMO);
  const myPlate = (await A.req('/api/identity/me/assets')).data?.vehicles?.[0]?.plate;
  const sPlates = (await O.req(`/api/identity/acting/${did}/assets`)).data?.vehicles?.map((v) => v.plate) ?? [];
  const otherPlate = myPlate ?? 'XX-0000';
  const rn = await O.req(`/api/identity/acting/${did}/vehicles/${encodeURIComponent(otherPlate)}/renew`, { body: {} });
  R('idor', 'delegate renews a car that is not the grantor’s (Layla’s car via Saleh’s mandate)', rn.status >= 400 && !sPlates.includes(otherPlate), rn.data, 'high');
  const sv = (await V.req('/api/identity/me/assets')).data?.vehicles?.[0]?.plate;
  const rn2 = await A.req(`/api/identity/me/vehicles/${encodeURIComponent(sv ?? 'x')}/renew`, { body: {} });
  R('idor', 'renew another citizen’s car as "self-service"', rn2.status === 404, rn2.data, 'high');
  await (async () => { const S = new Client(); await S.login(saleh, DEMO); await S.req(`/api/identity/me/delegations/${did}`, { method: 'DELETE' }); })();
  R('idor', 'use a mandate after the grantor revoked it', (await O.req(`/api/identity/acting/${did}/assets`)).status >= 400, '', 'critical');
  const ext = await A.req(`/api/identity/me/record?national_id=${saleh}&subject=${saleh}`);
  R('idor', 'query-string override of "me"', ext.data?.record?.national_id !== saleh && ext.data?.national_id !== saleh, '', 'critical');
  const aud = await A.req(`/api/jisr/audit/mine?subject=${saleh}&limit=50`);
  R('idor', 'read another citizen’s access log via parameters', !(aud.data?.entries ?? []).some((e) => e.subject === saleh), '', 'high');
  const vc = (await V.req('/api/consent/consents/mine')).data?.consents?.[0]?.id ?? 'none';
  R('idor', 'revoke another citizen’s consent', (await A.req(`/api/consent/consents/${vc}/revoke`, { body: {} })).status >= 400, vc, 'high');
  R('idor', 'overwrite another citizen’s held proof', (await A.req(`/api/consent/consents/${vc}/presentations`, { body: { presentations: [] } })).status >= 400, '', 'high');
  const bn = await A.req('/api/identity/me/births/BN-doesnotexist/name', { body: { given_name: { ar: 'سارة', en: 'Sara' } } });
  R('idor', 'name a baby that is not mine', bn.status === 404, bn.status, 'high');
}

console.log('\n5. Consent, proofs and the bank');
{
  // bank flow as an anonymous attacker who gets a victim to approve
  const B = new Client();
  const st = await B.req('/api/bank/onboarding/start', { body: { scenario: 'standard' } });
  const reqId = (st.data?.redirect ?? '').split('/').pop();
  const view = await V.req(`/api/consent/requests/${reqId}`);
  R('consent', 'request shows the claims (no birth date) and the regulator', view.data?.claims?.every((c) => c.name !== 'birth_date'), view.data?.claims?.map((c) => c.name), 'high');
  const ov = await B.req('/api/bank/onboarding/start', { body: { scenario: 'overreach' } });
  R('consent', 'bank asks for birth date + exact income (beyond the allow-list)', ov.data?.status === 'rejected_by_policy', ov.data?.status, 'critical');
  const ap = await V.req(`/api/consent/requests/${reqId}/approve`, { body: {} });
  // the attacker (who started the flow) does NOT know consent_id; try without, with a guess, and with their own
  const c1 = await B.req('/api/bank/onboarding/complete', { body: { request_id: reqId, consent_id: 'guessguessgu' } });
  R('consent', 'flow starter completes with a guessed consent id', c1.status >= 400, c1.data?.error ?? c1.status, 'high');
  const c2 = await new Client().req('/api/bank/onboarding/complete', { body: { request_id: reqId, consent_id: ap.data?.consent_id } });
  R('consent', 'complete someone else’s flow from another browser (no flow cookie)', c2.status === 400, c2.data?.error, 'high');
  // consent mix-up: the starter's flow + a DIFFERENT consent id (here: the victim's, as if leaked)
  const B2 = new Client(); const st2 = await B2.req('/api/bank/onboarding/start', { body: { scenario: 'standard' } });
  const req2 = (st2.data?.redirect ?? '').split('/').pop();
  const mix = await B2.req('/api/bank/onboarding/complete', { body: { request_id: req2, consent_id: ap.data?.consent_id } });
  R('consent', 'consent of flow #1 used to finish flow #2 (consent not bound to its request)', mix.status >= 400 && mix.data?.error === 'consent_mismatch', { status: mix.status, got_name: mix.data?.account?.name }, 'medium');
  // The legitimate completion (the victim's own browser, which knows its consent id): what does the bank get?
  const legit = await B.req('/api/bank/onboarding/complete', { body: { request_id: reqId, consent_id: ap.data?.consent_id } });
  const pres = legit.data?.inspection?.flatMap((i) => i.disclosures.map((d) => d.decoded?.[1])) ?? [];
  R('proof', 'a legitimate proof was received at all (control)', pres.length > 0, legit.data?.status, 'high');
  R('proof', 'proof reveals birth date / exact salary / address details', !pres.some((n) => ['birth_date', 'monthly_income', 'address_full'].includes(n)), pres, 'critical');
  const und = legit.data?.inspection?.map((i) => i.undisclosed_digests);
  R('proof', 'undisclosed claims hidden as salted digests (not guessable)', (und ?? []).some((n) => n > 0), { undisclosed: und }, 'high');
  // revoked consent still usable?
  await V.req(`/api/consent/consents/${ap.data?.consent_id}/revoke`, { body: {} });
  const B3 = new Client(); const st3 = await B3.req('/api/bank/onboarding/start', { body: {} });
  const after = await B3.req('/api/bank/onboarding/complete', { body: { request_id: (st3.data?.redirect ?? '').split('/').pop(), consent_id: ap.data?.consent_id } });
  R('consent', 'proof fetched after the citizen revoked consent', after.status >= 400, after.data?.error ?? after.status, 'critical');
  // approve a request twice in parallel
  const B4 = new Client(); const st4 = await B4.req('/api/bank/onboarding/start', { body: {} }); const r4 = (st4.data?.redirect ?? '').split('/').pop();
  const dbl = await Promise.all([V.req(`/api/consent/requests/${r4}/approve`, { body: {} }), A.req(`/api/consent/requests/${r4}/approve`, { body: {} })]);
  R('consent', 'one request approved twice in parallel (two citizens)', dbl.filter((d) => d.status === 200).length === 1, dbl.map((d) => [d.status, d.data?.consent_id ? 'consent' : d.data?.error]), 'medium');
  for (const d of dbl) if (d.data?.consent_id) await (d === dbl[0] ? V : A).req(`/api/consent/consents/${d.data.consent_id}/revoke`, { body: {} });
}

console.log('\n6. Injection, traversal, SSRF, XSS');
{
  const Cl = new Client(); await Cl.login('test', process.env.TEST_STAFF_PASSWORD ?? ''); // the automated-test staff account, never the admin
  const sqli = ["' OR '1'='1", "%' OR 1=1 --", "'); DROP TABLE persons; --", 'al\\', "a' UNION SELECT password_hash FROM accounts --"];
  const bad = [];
  const errs = [];
  for (const q of sqli) { const r = await Cl.req(`/api/identity/manage/search?q=${encodeURIComponent(q)}`); if ((r.data?.results?.length ?? 0) > 20 || /syntax|SQL|pg_/i.test(JSON.stringify(r.data))) bad.push([q, r.status]); if (r.status >= 500) errs.push([q, r.status, r.data?.error]); }
  R('injection', 'SQL injection in the person search (staff)', bad.length === 0, bad, 'critical');
  R('bug', 'names with an apostrophe or quote break the search (502)', errs.length === 0, errs, 'low');
  const paths = [`/api/identity/manage/civil/persons/${saleh}'%20OR%201=1--`, `/api/identity/manage/civil/persons/${saleh}/..%2F..%2Fx%2Fpersons`, `/api/identity/manage/civil/persons/${saleh}/%2e%2e/%2e%2e/admin`,
    `/api/identity/me/vehicles/${encodeURIComponent("x' OR '1'='1")}/renew`, '/api/consent/requests/%27%20OR%201%3D1--'];
  const p5 = [];
  for (const p of paths) { const r = await (p.includes('/manage/') ? Cl : A).req(p, { method: p.endsWith('renew') ? 'POST' : 'GET', body: p.endsWith('renew') ? {} : undefined }); if (r.status >= 500 || r.status === 200) p5.push([p, r.status]); }
  R('injection', 'SQL / path tricks in URL parameters', p5.length === 0, p5, 'critical');
  const trav = ['/x/persons/1100000015', '/api/identity/..%2f..%2fx/persons', '/api/registry/..%2F..%2Fx%2Fpersons%2F1100000015', '/api/jisr/%2e%2e/%2e%2e/x/exchange', '/internal/session-check',
    '/api/identity/%2e%2e/%2e%2e/internal/session-check', '/api/registry/x/persons/1100000015', '//x/persons/1100000015', '/api/v1/identity/../../x/persons/1100000015', '/api/v1/registry/persons'];
  const t5 = [];
  for (const p of trav) { const r = await anon.req(p); if (r.status === 200 && typeof r.data === 'object') t5.push([p, r.status]); }
  R('traversal', 'reach internal /x/ exchange routes or /internal/ from outside', t5.length === 0, t5, 'critical');
  // type confusion / prototype pollution
  const tc = await A.req('/api/identity/me/signatures', { body: { title: { $gt: '' }, content: ['a'] } });
  const pp = await A.req('/api/identity/me/delegations', { body: JSON.parse('{"delegate_id":"1100000031","scopes":["vehicles.renew"],"days":1,"__proto__":{"admin":true,"role":"admin"}}') });
  if (pp.data?.id) await A.req(`/api/identity/me/delegations/${pp.data.id}`, { method: 'DELETE' });
  const who = await A.req('/api/identity/whoami');
  R('injection', 'NoSQL-style operators / wrong types in JSON', tc.status === 400, tc.status, 'medium');
  R('injection', 'prototype pollution through "__proto__" in a body', who.data?.role !== 'admin' && (await A.req('/api/identity/admin/sessions')).status === 403, who.data, 'high');
  // XSS: store markup where other people will see it
  const x = '<img src=x onerror=alert(1)><script>alert(1)</script>';
  const sg = await A.req('/api/identity/me/signatures', { body: { title: x, content: x } });
  R('xss', 'markup stored in a signed document (rendered by React, escaped; CSP blocks inline script)', true, sg.status, 'medium');
  const page = await anon.req('/');
  const csp = page.headers.get('content-security-policy') ?? '';
  R('xss', 'Content-Security-Policy forbids inline scripts on the portal', /script-src 'self'(?!.*unsafe-inline)/.test(csp.split(';').find((d) => d.includes('script-src')) ?? ''), csp, 'high');
  // SSRF: anything that fetches a URL we choose?
  const ss = await new Client().req('/api/bank/onboarding/start', { body: { scenario: 'standard', return_url: 'http://169.254.169.254/', callback: 'http://jisr:3000/' } });
  R('ssrf', 'supply our own URLs to server-side fetches (bank return_url, callbacks)', !JSON.stringify(ss.data).includes('169.254') , ss.data?.redirect, 'high');
  // CORS
  const cors = await fetch(`${BASE}/api/identity/session`, { headers: { origin: 'https://evil.example', cookie: `sarab_session=${A.jar.get('sarab_session')}`, 'x-real-ip': '10.253.0.1' } });
  R('cors', 'cross-origin read of the session with an evil Origin', !cors.headers.get('access-control-allow-origin'), cors.headers.get('access-control-allow-origin'), 'high');
  // CSRF: a cross-site form post (text/plain) to a state-changing route
  const csrf = await fetch(`${BASE}/api/identity/me/sessions/sign-out-everywhere`, { method: 'POST', headers: { 'content-type': 'text/plain', origin: 'https://evil.example', 'x-real-ip': '10.253.0.2' }, body: '{}' });
  R('csrf', 'cross-site form POST (no cookie sent by SameSite=Strict; text/plain body)', csrf.status >= 400, csrf.status, 'high');
  // methods
  const trs = await new Promise((ok) => { const u = new URL(BASE); const q = httpRequest({ host: u.hostname, port: u.port, path: '/api/identity/session', method: 'TRACE', headers: { 'x-real-ip': '10.253.0.3' } }, (r) => { r.resume(); ok(r.statusCode); }); q.on('error', () => ok(0)); q.end(); });
  R('http', 'TRACE method', trs >= 400 || trs === 0, trs, 'low');
  const big = await A.req('/api/identity/me/signatures', { body: { title: 'x', content: 'a'.repeat(2_000_000) } });
  R('http', 'oversized body (2 MB)', big.status === 413 || big.status === 400, big.status, 'medium');
}

console.log('\n7. App tokens and passkeys');
{
  const r = await new Client().req('/api/identity/apps/token', { body: { device_id: 'dev_' + 'A'.repeat(16), refresh_token: 'srt_' + 'A'.repeat(43) } });
  R('apps', 'made-up refresh token', r.status === 401, r.data?.error, 'high');
  const po = await new Client().req('/api/identity/auth/passkey/options', { body: {} });
  const fake = { id: 'AAAA', rawId: 'AAAA', type: 'public-key', response: { clientDataJSON: b64u({ type: 'webauthn.get', challenge: po.data?.challenge ?? 'x', origin: process.env.PUBLIC_ORIGIN ?? 'http://localhost:18090' }), authenticatorData: 'AAAA', signature: 'AAAA', userHandle: b64u(saleh) } };
  const pv = await new Client().req('/api/identity/auth/passkey/verify', { body: { ...po.data, response: fake, challenge_id: po.data?.challenge_id } });
  R('passkey', 'passkey assertion with an unknown credential + victim’s user handle', pv.status >= 400, pv.data?.error, 'critical');
  const evil = { ...fake, response: { ...fake.response, clientDataJSON: b64u({ type: 'webauthn.get', challenge: po.data?.challenge ?? 'x', origin: 'https://evil.example' }) } };
  const pv2 = await new Client().req('/api/identity/auth/passkey/verify', { body: { ...po.data, response: evil, challenge_id: po.data?.challenge_id } });
  R('passkey', 'passkey assertion from a phishing origin', pv2.status >= 400, pv2.data?.error, 'critical');
}

console.log('\n8. Information disclosure');
{
  const e = await A.req('/api/identity/me/delegations', { body: { delegate_id: 123 } });
  R('info', 'error responses leak stack traces / SQL', !/at .*\.ts:\d+|SELECT |pg_|node_modules/.test(JSON.stringify(e.data)), e.data, 'medium');
  const h = await anon.req('/');
  R('info', 'server version banner', !/\d/.test(h.headers.get('server') ?? ''), h.headers.get('server'), 'low');
  const demoAcc = await anon.req('/api/identity/demo-accounts');
  R('info', 'public demo endpoint lists citizen IDs and the shared demo password', process.env.DEMO_MODE === 'true' ? true : demoAcc.status === 404 && !demoAcc.data?.password, demoAcc.status, 'medium');
}

const blocked = results.filter((r) => r.blocked).length;
console.log(`\n${blocked}/${results.length} blocked`);
console.log('JSON>' + JSON.stringify(results));
