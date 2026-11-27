-- Ministry of Labor & Social Insurance — employment, income source, insurance record.
CREATE TABLE IF NOT EXISTS employment (
  national_id      text PRIMARY KEY,
  status           text NOT NULL CHECK (status IN ('employed','self_employed','student','retired','job_seeking','child')),
  status_name      jsonb NOT NULL,
  employer_name    jsonb,
  employer_sector  text,
  job_title        jsonb,
  since            date,
  monthly_income   integer NOT NULL DEFAULT 0,   -- Sarabi dinars (SRD)
  income_source    jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS social_insurance (
  national_id          text PRIMARY KEY REFERENCES employment(national_id),
  number               text NOT NULL UNIQUE,
  contribution_months  integer NOT NULL,
  pension              integer
);

-- Every employment credential Labor has issued (who, when, for which consent) — not the credential itself.
CREATE TABLE IF NOT EXISTS issued_credentials (
  id           serial PRIMARY KEY,
  national_id  text NOT NULL,
  consent_id   text,
  requested_by text NOT NULL,
  issued_at    timestamptz NOT NULL DEFAULT now()
);

-- Phase 3: benefits awarded proactively from life events (no application form).
CREATE TABLE IF NOT EXISTS benefits (
  id              text PRIMARY KEY,
  national_id     text NOT NULL,                 -- who is paid (a parent)
  kind            text NOT NULL,                 -- 'child_benefit'
  child_id        text,
  monthly_amount  integer NOT NULL,              -- SRD
  starts_on       date NOT NULL,
  status          text NOT NULL DEFAULT 'active',
  reason          jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, child_id)
);
CREATE INDEX IF NOT EXISTS benefits_person_idx ON benefits (national_id);

-- Record maintenance by Labor staff ("Manage citizen").
-- Job history; the current employment row above is recomputed from it after every change.
CREATE TABLE IF NOT EXISTS jobs (
  id              text PRIMARY KEY,
  national_id     text NOT NULL,
  employer        jsonb NOT NULL,
  sector          text NOT NULL,
  job_title       jsonb NOT NULL,
  monthly_salary  integer NOT NULL CHECK (monthly_salary > 0),
  start_date      date NOT NULL,
  end_date        date CHECK (end_date IS NULL OR end_date >= start_date),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_person_idx ON jobs (national_id);
-- What the person is when no job is current (chosen by staff), and that income.
ALTER TABLE employment ADD COLUMN IF NOT EXISTS base_status text;
ALTER TABLE employment ADD COLUMN IF NOT EXISTS base_income integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS record_changes (
  id               bigserial PRIMARY KEY,
  national_id      text NOT NULL,
  action           text NOT NULL,
  detail           jsonb NOT NULL DEFAULT '{}',
  actor            text NOT NULL,
  jisr_request_id  text NOT NULL,
  at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS record_changes_person_idx ON record_changes (national_id, id DESC);
