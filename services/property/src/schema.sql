-- Property & Vehicles Authority — vehicle registrations and property deeds.
CREATE TABLE IF NOT EXISTS vehicles (
  plate                text PRIMARY KEY,
  owner_id             text NOT NULL,
  make                 text NOT NULL,
  model                text NOT NULL,
  year                 integer NOT NULL,
  color                jsonb NOT NULL,
  registration_expiry  date NOT NULL
);
CREATE INDEX IF NOT EXISTS vehicles_owner_idx ON vehicles (owner_id);

CREATE TABLE IF NOT EXISTS properties (
  deed_no        text PRIMARY KEY,
  owner_id       text NOT NULL,
  type           jsonb NOT NULL,
  city           jsonb NOT NULL,
  district       jsonb NOT NULL,
  area_m2        integer NOT NULL,
  share_percent  integer NOT NULL
);
CREATE INDEX IF NOT EXISTS properties_owner_idx ON properties (owner_id);

-- Phase 3: renewals (by the owner, or by a delegate under a Mithaq mandate).
CREATE TABLE IF NOT EXISTS renewals (
  id            text PRIMARY KEY,
  plate         text NOT NULL REFERENCES vehicles(plate),
  owner_id      text NOT NULL,
  renewed_by    text NOT NULL,                  -- national ID of the person who did it
  on_behalf_of  text NOT NULL,                  -- 'self', 'delegate:<id>' or 'employee:<id>'
  delegation_id text,
  old_expiry    date NOT NULL,
  new_expiry    date NOT NULL,
  fee           integer NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Record maintenance by Authority staff ("Manage citizen").
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS deregistered_at timestamptz;   -- scrapped / exported (history kept)
CREATE TABLE IF NOT EXISTS transfers (
  id               bigserial PRIMARY KEY,
  plate            text NOT NULL REFERENCES vehicles(plate),
  from_id          text NOT NULL,
  to_id            text NOT NULL,
  actor            text NOT NULL,
  jisr_request_id  text NOT NULL,
  at               timestamptz NOT NULL DEFAULT now()
);
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
