-- Ministry of Health — deliberately minimal and fake. Sensitive: no private-sector access at all.
CREATE TABLE IF NOT EXISTS health_records (
  national_id         text PRIMARY KEY,
  blood_type          text NOT NULL,
  allergies           jsonb NOT NULL DEFAULT '[]',
  chronic_conditions  jsonb NOT NULL DEFAULT '[]',
  primary_clinic      jsonb NOT NULL,
  organ_donor         boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS vaccinations (
  id           serial PRIMARY KEY,
  national_id  text NOT NULL REFERENCES health_records(national_id),
  name         jsonb NOT NULL,
  given_on     date NOT NULL
);
CREATE INDEX IF NOT EXISTS vaccinations_person_idx ON vaccinations (national_id);

-- Phase 3: birth notifications (normally sent by the hospital; in the demo a parent simulates it).
CREATE TABLE IF NOT EXISTS birth_notifications (
  id                 text PRIMARY KEY,
  mother_id          text NOT NULL,
  father_id          text,
  child_given_name   jsonb NOT NULL,
  child_gender       char(1) NOT NULL CHECK (child_gender IN ('M','F')),
  birth_date         date NOT NULL,
  hospital           jsonb NOT NULL,
  reported_via       text NOT NULL,
  reported_by        text NOT NULL,
  child_national_id  text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Record maintenance by Health staff ("Manage citizen"): who changed the record and when (not what).
CREATE TABLE IF NOT EXISTS record_changes (
  id               bigserial PRIMARY KEY,
  national_id      text NOT NULL,
  action           text NOT NULL,
  actor            text NOT NULL,
  jisr_request_id  text NOT NULL,
  at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS record_changes_person_idx ON record_changes (national_id, id DESC);

-- Births are now reported by the hospital WITHOUT a name: the parents choose it afterwards (Civil Registry).
ALTER TABLE birth_notifications ALTER COLUMN child_given_name DROP NOT NULL;
ALTER TABLE birth_notifications ADD COLUMN IF NOT EXISTS record_no text;          -- the hospital's own file number
ALTER TABLE birth_notifications ADD COLUMN IF NOT EXISTS hospital_index int;
CREATE INDEX IF NOT EXISTS birth_notifications_mother_idx ON birth_notifications (mother_id, birth_date);
