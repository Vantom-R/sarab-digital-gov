-- Regulator-defined allow-lists (e.g. the Sarab Monetary Authority for banks).
CREATE TABLE IF NOT EXISTS sector_policies (
  sector            text PRIMARY KEY,
  regulator_ar      text NOT NULL,
  regulator_en      text NOT NULL,
  title_ar          text NOT NULL,
  title_en          text NOT NULL,
  allowed_claims    text[] NOT NULL,
  allowed_purposes  text[] NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS consent_requests (
  id               text PRIMARY KEY,
  client           text NOT NULL,
  sector           text NOT NULL,
  purpose          text NOT NULL,
  claims           text[] NOT NULL,
  return_url       text NOT NULL,
  validity_days    integer NOT NULL,
  status           text NOT NULL CHECK (status IN ('pending','approved','denied','rejected_by_policy')),
  rejected_claims  text[] NOT NULL DEFAULT '{}',
  reason           text,
  subject          text,
  consent_id       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  decided_at       timestamptz
);

CREATE TABLE IF NOT EXISTS consents (
  id            text PRIMARY KEY,
  request_id    text NOT NULL REFERENCES consent_requests(id),
  subject       text NOT NULL,
  client        text NOT NULL,
  purpose       text NOT NULL,
  claims        text[] NOT NULL,
  status        text NOT NULL CHECK (status IN ('active','revoked')),
  granted_at    timestamptz NOT NULL DEFAULT now(),
  valid_until   timestamptz NOT NULL,
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  use_count     integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS consents_subject_idx ON consents (subject, granted_at DESC);

-- Phase 6: the requester's nonce is fixed when it asks, so a citizen whose key is on their device can
-- build the key-bound presentation at approval time. Idhn holds it (once) for the requester.
ALTER TABLE consent_requests ADD COLUMN IF NOT EXISTS nonce text;
ALTER TABLE consents ADD COLUMN IF NOT EXISTS held_presentations jsonb;
ALTER TABLE consents ADD COLUMN IF NOT EXISTS held_at timestamptz;
