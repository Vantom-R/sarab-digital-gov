// Provisions secrets like a tiny "central authority" would:
//   secrets/keys/<member>.private.jwk.json  — one Ed25519 key per Jisr member (mounted only into that member)
//   secrets/trust/members.json              — public trust list (mounted into every service)
//   secrets/nats.conf                       — event bus config: one user per member, least-privilege permissions
//   .env                                    — random DB/bus passwords, master key, staff passwords
//                                             (+ TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID for admin sign-in codes, added by hand)
// Idempotent: existing keys and .env values are kept.
// Run: node scripts/init-secrets.ts   (inside a node:24 container; no npm deps needed)

import { generateKeyPairSync, randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { MEMBERS } from '../packages/shared/src/catalog.ts';
import { BUS_MEMBERS, natsPermissions } from '../packages/shared/src/event-policy.ts';

const root = new URL('..', import.meta.url).pathname;
const keysDir = `${root}secrets/keys`;
const trustDir = `${root}secrets/trust`;
mkdirSync(keysDir, { recursive: true });
mkdirSync(trustDir, { recursive: true });

const trust: Record<string, unknown> = {};
for (const m of MEMBERS) {
  const file = `${keysDir}/${m.id}.private.jwk.json`;
  let jwk: any;
  if (existsSync(file)) {
    jwk = JSON.parse(readFileSync(file, 'utf8'));
  } else {
    const { privateKey } = generateKeyPairSync('ed25519');
    jwk = privateKey.export({ format: 'jwk' });
    const thumb = createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).digest('base64url');
    jwk = { ...jwk, kid: `${m.id}#${thumb.slice(0, 12)}`, alg: 'EdDSA', use: 'sig' };
    writeFileSync(file, JSON.stringify(jwk, null, 2));
    console.log(`generated key for ${m.id}`);
  }
  chmodSync(file, 0o644); // readable by the non-root container user; the directory itself is 0700
  const { d: _d, ...pub } = jwk;
  trust[m.id] = { id: m.id, class: m.class, sector: m.sector, name: m.name, jwk: pub };
}
writeFileSync(`${trustDir}/members.json`, JSON.stringify({ issued_at: new Date().toISOString(), members: trust }, null, 2));
console.log(`trust list: ${Object.keys(trust).length} members`);

// ---- .env ----
const envFile = `${root}.env`;
const env = new Map<string, string>();
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && !line.startsWith('#')) env.set(line.slice(0, i), line.slice(i + 1));
  }
}
const ensure = (k: string, v: () => string) => { if (!env.get(k)) env.set(k, v()); };
const pw = () => randomBytes(18).toString('base64url');
ensure('PUBLIC_ORIGIN', () => 'http://localhost:18090');
ensure('RP_ID', () => 'localhost');
ensure('GATEWAY_PORT', () => '18090');
ensure('MASTER_KEY', () => randomBytes(32).toString('base64'));
for (const db of ['IDENTITY', 'REGISTRY', 'JISR', 'CONSENT', 'BANK', 'EDUCATION', 'HEALTH', 'LABOR', 'PROPERTY']) ensure(`${db}_DB_PASSWORD`, pw);
// DEMO_MODE=true (local use, the default here): the sign-in page lists the demo citizens and their shared
// password. A public deployment sets DEMO_MODE=false: the demo citizens still exist (tests use them), but
// their shared password is then known only to whoever holds .env.
ensure('DEMO_MODE', () => 'true');
ensure('DEMO_PASSWORD', pw);   // random; with DEMO_MODE=true the sign-in page shows it
// Automated tests sign in as staff "test" (TEST-0001), never as the administrator; only with a test ticket.
ensure('TEST_STAFF_PASSWORD', pw);
// Jisr's running service uses its own database user, which may only read and append the audit log.
ensure('JISR_APP_DB_PASSWORD', pw);
// Each caller of the notifier has its own key; Mithaq's key opens only /send and /feed.
ensure('NOTIFIER_KEY_MITHAQ', () => randomBytes(32).toString('base64url'));
ensure('NOTIFIER_KEY_OPS', () => randomBytes(32).toString('base64url'));

// The site is public: no HTTP basic auth any more. The admin has a private password + a one-time code sent by Telegram.
env.delete('BASIC_AUTH_USER');
env.delete('BASIC_AUTH_PASSWORD');
ensure('ADMIN_PASSWORD', pw);
env.delete('ADMIN_TOTP_SECRET'); // replaced by Telegram codes
env.delete('CLERK_TOTP_SECRET'); // replaced by Telegram codes (every one-time code goes to Telegram)
if (!env.get('TELEGRAM_BOT_TOKEN') || !env.get('TELEGRAM_CHAT_ID')) {
  console.warn('note: no TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID in .env — the notifier runs in console mode: one-time codes are printed by `docker compose logs -f notifier`');
}
// Service-centre employee (Phase 4): also private; password + Telegram code.
ensure('CLERK_PASSWORD', pw);

// Event bus: one NATS user per member; permissions generated from packages/shared/src/event-policy.ts.
const natsVar = (m: string) => `NATS_PW_${m.toUpperCase().replace(/-/g, '_')}`;
for (const m of BUS_MEMBERS) ensure(natsVar(m), pw);
const users = BUS_MEMBERS.map((m) => ({ user: m, password: env.get(natsVar(m)), permissions: natsPermissions(m) }));
writeFileSync(`${root}secrets/nats.conf`, [
  '# Generated by scripts/init-secrets.ts from event-policy.ts — do not edit by hand',
  'port: 4222',
  'server_name: sarab-bus',
  'max_payload: 65536',
  'http: "127.0.0.1:8222"  # monitoring, container-local only (health check)',
  'jetstream { store_dir: "/data", max_memory_store: 8MB, max_file_store: 256MB }',
  `authorization ${JSON.stringify({ users }, null, 2)}`,
  '',
].join('\n'));
chmodSync(`${root}secrets/nats.conf`, 0o644);
console.log(`nats.conf: ${users.length} bus users`);

const out = ['# Generated by scripts/init-secrets.ts — do NOT commit', ...[...env].map(([k, v]) => `${k}=${v}`)].join('\n') + '\n';
writeFileSync(envFile, out);
chmodSync(envFile, 0o600);
console.log('.env ready');
