-- Ministry of Education — single source of truth for qualifications.
CREATE TABLE IF NOT EXISTS degrees (
  id               text PRIMARY KEY,
  national_id      text NOT NULL,
  level            text NOT NULL CHECK (level IN ('secondary','diploma','bachelor','master','doctorate')),
  level_name       jsonb NOT NULL,
  field            jsonb NOT NULL,
  institution      jsonb NOT NULL,
  graduation_year  integer NOT NULL,
  grade            jsonb NOT NULL,
  verified         boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS degrees_person_idx ON degrees (national_id);

CREATE TABLE IF NOT EXISTS enrollments (
  national_id  text PRIMARY KEY,
  institution  jsonb NOT NULL,
  stage        jsonb NOT NULL,
  since_year   integer NOT NULL
);

-- Record maintenance by Education staff ("Manage citizen"): this ministry's own change log.
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
