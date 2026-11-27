CREATE TABLE IF NOT EXISTS access_rules (
  id              serial PRIMARY KEY,
  client          text    NOT NULL,
  target          text    NOT NULL,
  method          text    NOT NULL,
  path_pattern    text    NOT NULL,
  purposes        text[]  NOT NULL,
  requires_consent boolean NOT NULL DEFAULT false,
  description     text,
  UNIQUE (client, target, method, path_pattern)
);

-- Replay protection: every request JWT id may be used once.
CREATE TABLE IF NOT EXISTS seen_jti (
  jti        text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);

-- Tamper-evident audit log: hash = sha256(prev_hash | canonical(entry)).
-- Rows are append-only: by privilege (jisr_app may only SELECT and INSERT) AND by trigger.
CREATE TABLE IF NOT EXISTS audit_log (
  seq          bigserial PRIMARY KEY,
  request_id   text UNIQUE NOT NULL,
  ts           text NOT NULL,
  client       text NOT NULL,
  target       text,
  method       text,
  path         text,
  purpose      text,
  subject      text,
  consent_id   text,
  on_behalf_of text,
  decision     text NOT NULL,
  reason       text,
  status       integer,
  duration_ms  integer,
  prev_hash    text NOT NULL,
  hash         text NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_subject_idx ON audit_log (subject, seq DESC);
CREATE INDEX IF NOT EXISTS audit_client_idx ON audit_log (client, seq DESC);

-- Second line of defence: the running service (user jisr_app, see migrate.ts) has no UPDATE/DELETE right at
-- all; this trigger also stops the owner by mistake. (The tamper demo now works on a copy in memory.)
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

-- Phase 6: hash of the target's signed response (part of the chained entry when present).
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS response_sha256 text;
