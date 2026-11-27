// Builds the combined public API spec (gateway/openapi/sarab-v1.json) from the running services and reports
// how many operations have documented responses. Run with: make openapi-bundle (make openapi does it all).
//   BASE=http://127.0.0.1:18090 node scripts/openapi-bundle.mjs [--normalize]
// --normalize first rewrites services/*/openapi-responses.json with sorted keys (stable diffs).
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:18090';
const ORIGIN = process.env.PUBLIC_ORIGIN ?? 'http://localhost:18090';
const PUBLIC = ['identity', 'consent', 'jisr', 'bank'];
const ALL = [...PUBLIC, 'registry', 'education', 'health', 'labor', 'property'];
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;

if (process.argv.includes('--normalize')) {
  for (const d of readdirSync('services')) {
    const f = `services/${d}/openapi-responses.json`;
    if (existsSync(f)) writeFileSync(f, JSON.stringify(sortKeys(JSON.parse(readFileSync(f, 'utf8'))), null, 1) + '\n');
  }
}

const specs = {};
for (const s of ALL) {
  const r = await fetch(`${BASE}/api/${s}/docs/json`);
  if (!r.ok) throw new Error(`${s}: HTTP ${r.status}`);
  specs[s] = await r.json();
}

// Coverage: every operation of every service (internal /x routes included).
let total = 0, documented = 0;
const missing = [];
for (const [s, spec] of Object.entries(specs)) {
  let t = 0, d = 0;
  for (const [path, ops] of Object.entries(spec.paths)) {
    for (const [m, op] of Object.entries(ops)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(m)) continue;
      t++;
      if (Object.keys(op.responses ?? {}).some((c) => /^2/.test(c))) d++;
      else missing.push(`${s}: ${m.toUpperCase()} ${path}`);
    }
  }
  total += t; documented += d;
  console.log(`${s.padEnd(10)} ${d}/${t} operations with a documented success response`);
}
console.log(`total      ${documented}/${total}`);
if (missing.length) console.log(`without a documented success response:\n  ${missing.join('\n  ')}`);

// Combined public spec: only what the gateway exposes, under /api/v1.
const out = {
  openapi: '3.1.0',
  info: {
    title: 'Republic of Sarab — public API',
    version: '1.0.0',
    description: [
      'Every public route of Mithaq (identity), Idhn (consent), Jisr (audit, transparency) and Bank Al-Waha, for the web portal and native apps.',
      '',
      '**Versioning.** Call `/api/v1/<service>/…`. Within v1 changes are additive only (new routes, new optional fields); a breaking change gets `/api/v2` while v1 keeps working. Every response carries `API-Version: 1`.',
      '',
      '**Apps: sign-in.** 1. `GET /api/v1/identity/apps/config`. 2. Sign in with a passkey (`/auth/passkey/*`) or password + one-time code (`/auth/password`, `/auth/otp`), sending `X-Sarab-Client: native` to get the session token in the body. 3. Send it as `Authorization: Bearer <token>`. 4. Within 10 minutes: `POST /apps/devices` → `device_id` + `refresh_token` (store it in the Keychain / Keystore / Credential Locker). 5. When the 30-minute session ends: `POST /apps/token` → new session token + new refresh token (each refresh token works once). Signing documents and creating delegations need a real sign-in, not a refreshed session.',
      '',
      '**Passkeys in apps.** Relying party `' + new URL(ORIGIN).host + '`; associated-domain files at `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` (configured in `.env`).',
      '',
      '**Errors.** `{ "error": "<code>", "message": "…", "details"?: … }`. Responses marked "observed" were generated from the test suites (shape only).',
      '',
      'Ministry exchange APIs (`/x/…`) are internal (reachable only through Jisr); see each ministry\'s own docs, e.g. `/api/registry/docs`.',
    ].join('\n'),
  },
  servers: [{ url: ORIGIN }],
  tags: [],
  paths: {},
  components: { securitySchemes: {}, schemas: {} },
};
for (const s of PUBLIC) {
  const spec = specs[s];
  Object.assign(out.components.securitySchemes, spec.components?.securitySchemes ?? {});
  Object.assign(out.components.schemas, spec.components?.schemas ?? {});
  for (const [path, ops] of Object.entries(spec.paths)) {
    if (!path.startsWith(`/api/${s}/`) || path.includes('/docs')) continue;
    const v1 = path.replace(/^\/api\//, '/api/v1/');
    out.paths[v1] = {};
    for (const [m, op] of Object.entries(ops)) {
      const tags = (op.tags?.length ? op.tags : ['general']).map((t) => `${s} · ${t}`);
      for (const t of tags) if (!out.tags.some((x) => x.name === t)) out.tags.push({ name: t });
      out.paths[v1][m] = { ...op, tags };
    }
  }
}
delete out.components.securitySchemes.jisr;
out.tags.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync('gateway/openapi/sarab-v1.json', JSON.stringify(out, null, 1) + '\n');
console.log(`gateway/openapi/sarab-v1.json: ${Object.keys(out.paths).length} public paths`);
