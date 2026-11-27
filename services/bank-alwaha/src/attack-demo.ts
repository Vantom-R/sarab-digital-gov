// "What if the bank is compromised?" — runs INSIDE the bank container, with the bank's real key,
// and tries to get data it is not entitled to. Every attempt must fail (and is audited by Jisr).
//   make attack-demo
import { SignJWT } from 'jose';
import { jisrCall, bodyHash, verifyResponseSignature } from '#shared/jisr.ts';
import { loadOwnKey, randomId } from '#shared/crypto.ts';
import { population, PERSONAS } from '#shared/seed.ts';

population();
const victim = PERSONAS.layla;
let blocked = 0;
const results: string[] = [];

async function attempt(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    results.push(`  ✗ ALLOWED (bad!) — ${name}`);
  } catch (e: any) {
    blocked++;
    results.push(`  ✓ blocked — ${name}\n      → ${e.statusCode ?? ''} ${e.code ?? e.name}: ${e.message}`);
  }
}

await attempt('read a citizen’s health record through Jisr', () =>
  jisrCall({ target: 'health', method: 'GET', path: `/x/persons/${victim}/health`, purpose: 'account-opening', subject: victim }));

await attempt('read the full civil record (incl. birth date) directly from the Civil Registry via Jisr', () =>
  jisrCall({ target: 'civil-registry', method: 'GET', path: `/x/persons/${victim}`, purpose: 'account-opening', subject: victim }));

await attempt('ask Labor for the exact salary', () =>
  jisrCall({ target: 'labor', method: 'GET', path: `/x/persons/${victim}/employment`, purpose: 'kyc-refresh', subject: victim }));

await attempt('use an allowed route with an undeclared purpose ("marketing")', () =>
  jisrCall({ target: 'idhn', method: 'POST', path: '/x/requests', purpose: 'marketing', body: { claims: ['full_name'], return_url: '/bank/callback' } }));

const fakeConsent = `fake-${randomId(6)}`;
await attempt('fetch a proof with a made-up consent id', () =>
  jisrCall({ target: 'idhn', method: 'GET', path: `/x/consents/${fakeConsent}/presentation?nonce=${randomId(12)}`, purpose: 'kyc-refresh', consentId: fakeConsent }));

await attempt('call the Civil Registry directly, bypassing Jisr (network isolation)', async () => {
  let r: Response;
  try {
    r = await fetch('http://civil-registry:3000/x/persons/' + victim, { signal: AbortSignal.timeout(3000) });
  } catch {
    throw Object.assign(new Error('the Civil Registry is not on any network the bank can reach'), { code: 'unreachable' });
  }
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { code: 'http_error' });
});

await attempt('impersonate Mithaq (sign a request as "mithaq" with the bank’s key)', async () => {
  const own = await loadOwnKey();
  const jwt = await new SignJWT({ target: 'civil-registry', method: 'GET', path: `/x/persons/${victim}`, purpose: 'citizen-self-service', sub: victim, on_behalf_of: 'self', body_sha256: bodyHash(''), jti: randomId() })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'mithaq#forged', typ: 'jisr-req+jwt' })
    .setIssuer('mithaq').setAudience('jisr').setIssuedAt().setExpirationTime('60s').sign(own.key);
  const r = await fetch('http://jisr:3000/x/exchange', { method: 'POST', headers: { authorization: `Jisr ${jwt}` } });
  const body: any = await r.json();
  if (!r.ok) throw Object.assign(new Error(body.message), { statusCode: r.status, code: body.error });
});

await attempt('replay a captured, validly signed request', async () => {
  const own = await loadOwnKey();
  const jwt = await new SignJWT({ target: 'idhn', method: 'POST', path: '/x/requests', purpose: 'account-opening', body_sha256: bodyHash('{"claims":["full_name"],"return_url":"/bank/callback"}'), jti: randomId() })
    .setProtectedHeader({ alg: 'EdDSA', kid: own.kid, typ: 'jisr-req+jwt' })
    .setIssuer(own.memberId).setAudience('jisr').setIssuedAt().setExpirationTime('60s').sign(own.key);
  const send = () => fetch('http://jisr:3000/x/exchange', { method: 'POST', headers: { authorization: `Jisr ${jwt}`, 'content-type': 'application/json' }, body: '{"claims":["full_name"],"return_url":"/bank/callback"}' });
  await send(); // first use is legitimate
  const r = await send();
  const body: any = await r.json();
  if (!r.ok) throw Object.assign(new Error(body.message), { statusCode: r.status, code: body.error });
});

await attempt('alter a signed answer in transit (as a man-in-the-middle — or a compromised Jisr — could)', async () => {
  const own = await loadOwnKey();
  const raw = '{"claims":["full_name"],"return_url":"/bank/callback"}';
  const jwt = await new SignJWT({ target: 'idhn', method: 'POST', path: '/x/requests', purpose: 'account-opening', body_sha256: bodyHash(raw), jti: randomId() })
    .setProtectedHeader({ alg: 'EdDSA', kid: own.kid, typ: 'jisr-req+jwt' })
    .setIssuer(own.memberId).setAudience('jisr').setIssuedAt().setExpirationTime('60s').sign(own.key);
  const r = await fetch('http://jisr:3000/x/exchange', { method: 'POST', headers: { authorization: `Jisr ${jwt}`, 'content-type': 'application/json' }, body: raw });
  const genuine = await r.text();
  const forged = genuine.replace(/"status":"[a-z_]+"/, '"status":"approved"'); // the attacker's edit
  await verifyResponseSignature(r.headers.get('x-jisr-response-signature') ?? '', { target: 'idhn', requestId: r.headers.get('x-jisr-request-id') ?? '', status: r.status, body: forged === genuine ? genuine + ' ' : forged });
});

console.log('\nCompromised-bank attack demo (running inside the bank container with its real key)\n');
console.log(results.join('\n'));
console.log(`\n${blocked}/${results.length} attempts blocked. Each Jisr denial is in the audit log (admin view).`);
process.exit(blocked === results.length ? 0 : 1);
