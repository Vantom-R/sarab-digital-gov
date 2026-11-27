// Jisr's database set-up, run by the one-shot "jisr-migrate" container before Jisr starts (red-team item B).
//
// Only this step uses the table OWNER (user "jisr"). It applies the schema, syncs the access policy from
// code, and (re)creates the restricted user "jisr_app" that the running Jisr service uses. jisr_app may only:
//   audit_log     SELECT, INSERT          — never UPDATE, DELETE, TRUNCATE; it does not own the table, so
//                                           it cannot disable the append-only trigger either
//   seen_jti      SELECT, INSERT, DELETE  — replay protection and its clean-up
//   access_rules  SELECT                  — the policy is written here, from code
// The Jisr container never sees the owner password.
//   node services/jisr/src/migrate.ts
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { RULES } from './policy.ts';

const OWNER_URL = process.env.DATABASE_URL;
const APP_PASSWORD = process.env.JISR_APP_DB_PASSWORD ?? '';
if (!OWNER_URL) throw new Error('DATABASE_URL (the owner) missing');
if (APP_PASSWORD.length < 16) throw new Error('JISR_APP_DB_PASSWORD missing or too short (run make init)');

const c = new pg.Client({ connectionString: OWNER_URL });
for (let attempt = 1; ; attempt++) {
  try { await c.connect(); break; } catch (err) {
    if (attempt >= 30) throw err;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
try {
  await c.query(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  await c.query('BEGIN');
  await c.query('SELECT pg_advisory_xact_lock(7244)');
  const exists = (await c.query("SELECT 1 FROM pg_roles WHERE rolname = 'jisr_app'")).rowCount;
  await c.query(`${exists ? 'ALTER' : 'CREATE'} ROLE jisr_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${c.escapeLiteral(APP_PASSWORD)}`);
  await c.query(`
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM jisr_app;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM jisr_app;
    GRANT CONNECT ON DATABASE jisr TO jisr_app;
    GRANT USAGE ON SCHEMA public TO jisr_app;
    GRANT SELECT, INSERT ON audit_log TO jisr_app;
    GRANT USAGE ON SEQUENCE audit_log_seq_seq TO jisr_app;
    GRANT SELECT, INSERT, DELETE ON seen_jti TO jisr_app;
    GRANT SELECT ON access_rules TO jisr_app;
  `);
  // The access policy comes from code (the admin UI shows it read-only in this prototype).
  await c.query('DELETE FROM access_rules');
  for (const r of RULES) {
    await c.query(
      'INSERT INTO access_rules (client, target, method, path_pattern, purposes, requires_consent, description) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [r.client, r.target, r.method, r.path_pattern, r.purposes, r.requires_consent ?? false, r.description],
    );
  }
  await c.query('COMMIT');
  console.log(`jisr-migrate: schema applied, ${RULES.length} access rules synced, user jisr_app may only read and append the audit log`);
} catch (err) {
  await c.query('ROLLBACK').catch(() => {});
  throw err;
} finally {
  await c.end();
}
