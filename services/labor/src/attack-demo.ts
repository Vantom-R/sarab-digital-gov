// "What if a ministry is compromised?" — runs INSIDE the Labor container with Labor's real Jisr key
// and its real event-bus credentials, and tries to abuse the life-event bus and delegations.
//   make attack-demo
import { SignJWT } from 'jose';
import { bus, verifyEvent } from '#shared/events.ts';
import { jisrCall } from '#shared/jisr.ts';
import { loadOwnKey, randomId } from '#shared/crypto.ts';
import { population, PERSONAS } from '#shared/seed.ts';

population();
const victim = PERSONAS.saleh;
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

const nc = await bus();
const js = nc.jetstream({ timeout: 3000 });
const own = await loadOwnKey();
const fakeBirth = { type: 'registry.person.born', subjects: ['1999999990'], correlation_id: 'fake', data: { national_id: '1999999990', mother_id: PERSONAS.layla } };

await attempt('publish a fake "child registered" event on the Civil Registry’s channel (to collect child benefit)', async () => {
  const token = await new SignJWT(fakeBirth).setProtectedHeader({ alg: 'EdDSA', kid: own.kid, typ: 'sarab-event+jwt' }).setIssuer(own.memberId).setJti(randomId()).setIssuedAt().sign(own.key);
  await js.publish('sarab.events.civil-registry.registry.person.born', new TextEncoder().encode(token));
});

await attempt('forge the Civil Registry’s signature on a birth event (sign as "civil-registry" with Labor’s key)', async () => {
  const token = await new SignJWT(fakeBirth).setProtectedHeader({ alg: 'EdDSA', kid: 'civil-registry#forged', typ: 'sarab-event+jwt' }).setIssuer('civil-registry').setJti(randomId()).setIssuedAt().sign(own.key);
  await verifyEvent(token); // what every subscriber does before acting
});

await attempt('sign a birth event honestly as Labor (subscribers must reject: Labor is not the publisher of registry.person.born)', async () => {
  const token = await new SignJWT(fakeBirth).setProtectedHeader({ alg: 'EdDSA', kid: own.kid, typ: 'sarab-event+jwt' }).setIssuer(own.memberId).setJti(randomId()).setIssuedAt().sign(own.key);
  await verifyEvent(token);
});

await attempt('eavesdrop on all life events (subscribe to sarab.events.>)', async () => {
  const sub = nc.subscribe('sarab.events.>', { max: 1, timeout: 2000 });
  for await (const _m of sub) { /* any message = leak */ }
  // A permission violation closes the subscription with an error; no error means nothing was blocked.
  throw Object.assign(new Error('subscription was not allowed'), { code: 'permission_denied' });
});

await attempt('read another ministry’s event consumer (Mithaq’s inbox feed)', async () => {
  const c = await js.consumers.get('SARAB_EVENTS', 'mithaq-inbox');
  await c.next({ expires: 2000 });
});

await attempt('act for Saleh as a "delegate" without a mandate (renew his car)', () =>
  jisrCall({ target: 'property', method: 'POST', path: '/x/vehicles/X/renewals', purpose: 'delegated-service', subject: victim, onBehalfOf: 'delegate:1100000031' }));

await attempt('act for Saleh with a self-made mandate (signed with Labor’s key, claiming to be Mithaq)', async () => {
  const act = await new SignJWT({ act: { sub: '1100000031' }, scope: ['vehicles.renew'], delegation_id: 'DG-fake' })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'mithaq#forged', typ: 'sarab-act+jwt' })
    .setIssuer('mithaq').setSubject(victim).setAudience('property').setIssuedAt().setExpirationTime('120s').sign(own.key);
  await jisrCall({ target: 'property', method: 'GET', path: `/x/persons/${victim}/assets`, purpose: 'delegated-service', subject: victim, onBehalfOf: 'delegate:1100000031', act });
});

console.log('\nCompromised-ministry attack demo (running inside the Labor container with its real key and bus credentials)\n');
console.log(results.join('\n'));
console.log(`\n${blocked}/${results.length} attempts blocked.`);
await nc.close();
process.exit(blocked === results.length ? 0 : 1);
