-- Bank Al-Waha (fictional private-sector app). It stores ONLY what the citizen agreed to share.
CREATE TABLE IF NOT EXISTS onboardings (
  id          text PRIMARY KEY,
  request_id  text UNIQUE,
  scenario    text NOT NULL,
  status      text NOT NULL CHECK (status IN ('started','completed','refused','declined','rejected_by_policy')),
  detail      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers (
  account_number  text PRIMARY KEY,
  national_id     text NOT NULL UNIQUE,
  full_name       jsonb NOT NULL,
  city            jsonb,
  consent_id      text NOT NULL,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  last_kyc_at     timestamptz NOT NULL DEFAULT now(),
  kyc_status      text NOT NULL DEFAULT 'verified'
);

-- Phase 2: employment KYC (bracket only — the bank never gets the exact salary).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS employment_status text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS income_bracket jsonb;

-- Phase 6: nonce chosen when the bank asks (citizens with device-held keys sign over it at approval).
ALTER TABLE onboardings ADD COLUMN IF NOT EXISTS nonce text;
