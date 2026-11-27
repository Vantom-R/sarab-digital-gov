CREATE TABLE IF NOT EXISTS persons (
  national_id     text PRIMARY KEY,
  given_name_ar   text NOT NULL,
  given_name_en   text NOT NULL,
  family_name_ar  text NOT NULL,
  family_name_en  text NOT NULL,
  gender          char(1) NOT NULL CHECK (gender IN ('M','F')),
  birth_date      date NOT NULL,
  nationality     text NOT NULL,
  marital_status  text NOT NULL,
  city_ar         text NOT NULL,
  city_en         text NOT NULL,
  district_ar     text NOT NULL,
  district_en     text NOT NULL,
  street          text NOT NULL,
  phone           text,
  father_id       text REFERENCES persons(national_id) DEFERRABLE INITIALLY DEFERRED,
  mother_id       text REFERENCES persons(national_id) DEFERRABLE INITIALLY DEFERRED,
  spouse_id       text REFERENCES persons(national_id) DEFERRABLE INITIALLY DEFERRED,
  status          text NOT NULL DEFAULT 'alive',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS persons_father_idx ON persons (father_id);
CREATE INDEX IF NOT EXISTS persons_mother_idx ON persons (mother_id);

-- Phase 3: births registered from hospital notifications (idempotency + provenance).
CREATE TABLE IF NOT EXISTS births (
  notification_id  text PRIMARY KEY,
  national_id      text NOT NULL REFERENCES persons(national_id),
  registered_at    timestamptz NOT NULL DEFAULT now()
);

-- Registration of an adult by a registrar (naturalisation, or a person missing from the registry).
CREATE TABLE IF NOT EXISTS registrations (
  national_id      text PRIMARY KEY REFERENCES persons(national_id),
  reason           text NOT NULL CHECK (reason IN ('naturalization','missing-record')),
  reference        text,                      -- e.g. naturalisation decree number
  registered_by    text NOT NULL,             -- "employee:<staff ID>" as stated in the Jisr request
  jisr_request_id  text NOT NULL,             -- links to the hash-chained audit entry
  registered_at    timestamptz NOT NULL DEFAULT now()
);

-- National IDs of records that were removed (automated-test clean-up). Never allocated again.
CREATE TABLE IF NOT EXISTS retired_national_ids (
  national_id  text PRIMARY KEY,
  retired_at   timestamptz NOT NULL DEFAULT now()
);

-- Record maintenance by Civil Registry staff ("Manage citizen"): this ministry's own change log.
-- (The request is also in Jisr's audit chain; jisr_request_id links the two.)
CREATE TABLE IF NOT EXISTS record_changes (
  id               bigserial PRIMARY KEY,
  national_id      text NOT NULL,
  action           text NOT NULL,
  detail           jsonb NOT NULL DEFAULT '{}',
  actor            text NOT NULL,              -- "employee:<staff ID>"
  jisr_request_id  text NOT NULL,
  at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS record_changes_person_idx ON record_changes (national_id, id DESC);

-- Marriages registered by staff (seeded couples predate this table and have no row).
CREATE TABLE IF NOT EXISTS marriages (
  id               bigserial PRIMARY KEY,
  a                text NOT NULL,
  b                text NOT NULL,
  married_on       date NOT NULL,
  dissolved_on     date,
  registered_by    text NOT NULL,
  jisr_request_id  text NOT NULL
);
CREATE INDEX IF NOT EXISTS marriages_a_idx ON marriages (a);
CREATE INDEX IF NOT EXISTS marriages_b_idx ON marriages (b);

-- A birth the hospital reported waits here for its name: one parent proposes, the other confirms (or the
-- only parent with an account confirms alone). Then the child is registered (national_id is set).
ALTER TABLE births ALTER COLUMN national_id DROP NOT NULL;
ALTER TABLE births ALTER COLUMN registered_at DROP NOT NULL;
ALTER TABLE births ALTER COLUMN registered_at DROP DEFAULT;
ALTER TABLE births ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'registered' CHECK (status IN ('awaiting_name', 'registered'));
ALTER TABLE births ADD COLUMN IF NOT EXISTS mother_id text;
ALTER TABLE births ADD COLUMN IF NOT EXISTS father_id text;
ALTER TABLE births ADD COLUMN IF NOT EXISTS gender char(1);
ALTER TABLE births ADD COLUMN IF NOT EXISTS birth_date date;
ALTER TABLE births ADD COLUMN IF NOT EXISTS hospital jsonb;
ALTER TABLE births ADD COLUMN IF NOT EXISTS reported_at timestamptz;
ALTER TABLE births ADD COLUMN IF NOT EXISTS name_deadline timestamptz;
ALTER TABLE births ADD COLUMN IF NOT EXISTS overdue_notified boolean NOT NULL DEFAULT false;
ALTER TABLE births ADD COLUMN IF NOT EXISTS named_by text;            -- 'both:<id>,<id>', 'sole:<id>' or 'deadline:<id>'
CREATE INDEX IF NOT EXISTS births_parents_idx ON births (mother_id, father_id);

CREATE TABLE IF NOT EXISTS birth_name_proposals (
  id               bigserial PRIMARY KEY,
  notification_id  text NOT NULL REFERENCES births(notification_id) ON DELETE CASCADE,
  given_name_ar    text NOT NULL,
  given_name_en    text NOT NULL,
  proposed_by      text NOT NULL,
  proposed_at      timestamptz NOT NULL DEFAULT now(),
  awaiting         text,             -- national ID that must confirm; NULL = the proposer confirms alone
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'replaced', 'confirmed', 'deadline')),
  decided_by       text,
  decided_at       timestamptz
);
CREATE INDEX IF NOT EXISTS birth_name_proposals_birth_idx ON birth_name_proposals (notification_id, id DESC);
