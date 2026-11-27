-- Mithaq (digital identity). Holds authentication data and citizen signing keys.
-- It does NOT hold civil data (names, birth dates…) — that lives in the Civil Registry.
CREATE TABLE IF NOT EXISTS accounts (
  subject           text PRIMARY KEY,               -- national ID, or "staff:<username>"
  kind              text NOT NULL CHECK (kind IN ('citizen','staff')),
  role              text NOT NULL CHECK (role IN ('citizen','employee','admin')),
  password_hash     text,
  staff_name_ar     text,
  staff_name_en     text,
  webauthn_user_id  text NOT NULL UNIQUE,           -- random handle, never the national ID
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_login_at     timestamptz
);

CREATE TABLE IF NOT EXISTS passkeys (
  credential_id  text PRIMARY KEY,
  subject        text NOT NULL REFERENCES accounts(subject) ON DELETE CASCADE,
  public_key     bytea NOT NULL,
  counter        bigint NOT NULL DEFAULT 0,
  transports     text[] NOT NULL DEFAULT '{}',
  nickname       text NOT NULL,
  backed_up      boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz
);
CREATE INDEX IF NOT EXISTS passkeys_subject_idx ON passkeys (subject);

CREATE TABLE IF NOT EXISTS challenges (
  id          text PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('webauthn-register','webauthn-login','otp')),
  subject     text,
  secret      text NOT NULL,           -- WebAuthn challenge, or sha256 of the OTP
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL
);

-- One Ed25519 key pair per citizen, private part encrypted with the service master key
-- (a stand-in for an HSM / remote signing service).
CREATE TABLE IF NOT EXISTS citizen_keys (
  subject      text PRIMARY KEY REFERENCES accounts(subject) ON DELETE CASCADE,
  public_jwk   jsonb NOT NULL,
  private_enc  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS signatures (
  id          text PRIMARY KEY,
  subject     text NOT NULL REFERENCES accounts(subject) ON DELETE CASCADE,
  title       text NOT NULL,
  doc_sha256  text NOT NULL,
  jws         text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);


-- ---------------- Phase 3 ----------------
-- Delegations: a mandate signed with the grantor's OWN key, held by Mithaq, checked on every use.
CREATE TABLE IF NOT EXISTS delegations (
  id             text PRIMARY KEY,
  grantor        text NOT NULL,
  delegate       text NOT NULL,
  grantor_name   jsonb NOT NULL,                 -- display snapshot
  delegate_name  jsonb NOT NULL,                 -- display snapshot (masked unless family)
  scopes         text[] NOT NULL,
  valid_until    timestamptz NOT NULL,
  mandate_jws    text NOT NULL,
  created_via    text NOT NULL DEFAULT 'portal', -- 'portal' or 'service-centre'
  created_by     text,                           -- employee who recorded it at a service centre
  created_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  revoked_by     text
);
CREATE INDEX IF NOT EXISTS delegations_grantor_idx ON delegations (grantor);
CREATE INDEX IF NOT EXISTS delegations_delegate_idx ON delegations (delegate);

-- Citizen inbox, filled from bus events.
CREATE TABLE IF NOT EXISTS notifications (
  id          bigserial PRIMARY KEY,
  subject     text NOT NULL,
  event_id    text NOT NULL,
  type        text NOT NULL,
  title       jsonb NOT NULL,
  body        jsonb NOT NULL,
  link        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz,
  UNIQUE (subject, event_id)
);
CREATE INDEX IF NOT EXISTS notifications_subject_idx ON notifications (subject, id DESC);

-- Life events started from the portal, and each step as its event arrives.
CREATE TABLE IF NOT EXISTS life_events (
  correlation_id  text PRIMARY KEY,
  kind            text NOT NULL,
  parties         text[] NOT NULL,
  reported_by     text NOT NULL,
  data            jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS life_event_steps (
  correlation_id  text NOT NULL REFERENCES life_events(correlation_id) ON DELETE CASCADE,
  type            text NOT NULL,
  publisher       text NOT NULL,
  at              timestamptz NOT NULL,
  data            jsonb NOT NULL,
  PRIMARY KEY (correlation_id, type)
);

-- ---------------- Phase 4: staff + assisted channel ----------------
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS employee_id text;       -- e.g. EMP-1042
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS centre jsonb;           -- service centre (employees)

-- A counter session: an employee serves ONE citizen who is present and confirmed with a code
-- sent to the citizen's registered phone. Everything done in it is attributed to the employee.
CREATE TABLE IF NOT EXISTS assisted_sessions (
  id            text PRIMARY KEY,
  employee      text NOT NULL,          -- staff subject, e.g. staff:clerk
  employee_id   text NOT NULL,
  citizen       text NOT NULL,
  status        text NOT NULL CHECK (status IN ('pending','active','ended')),
  code_hash     text NOT NULL,
  attempts      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  confirmed_at  timestamptz,
  expires_at    timestamptz NOT NULL,
  ended_at      timestamptz
);
CREATE INDEX IF NOT EXISTS assisted_sessions_employee_idx ON assisted_sessions (employee, created_at DESC);

CREATE TABLE IF NOT EXISTS assisted_actions (
  id                   bigserial PRIMARY KEY,
  assisted_session_id  text NOT NULL REFERENCES assisted_sessions(id),
  employee_id          text NOT NULL,
  citizen              text NOT NULL,
  action               text NOT NULL,
  detail               jsonb NOT NULL DEFAULT '{}',
  at                   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assisted_actions_citizen_idx ON assisted_actions (citizen, id DESC);
CREATE INDEX IF NOT EXISTS assisted_actions_employee_idx ON assisted_actions (employee_id, id DESC);

-- ---------------- Phase 6: server-side session list (early revocation) ----------------
CREATE TABLE IF NOT EXISTS sessions (
  sid               text PRIMARY KEY,
  subject           text NOT NULL,
  role              text NOT NULL,
  amr               text[] NOT NULL,
  auth_time         timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  last_refreshed_at timestamptz,
  user_agent        text,
  revoked_at        timestamptz,
  revoked_by        text,
  revoked_reason    text
);
CREATE INDEX IF NOT EXISTS sessions_subject_idx ON sessions (subject, created_at DESC);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_id text;   -- set when an app device opened it
CREATE INDEX IF NOT EXISTS sessions_device_idx ON sessions (device_id) WHERE device_id IS NOT NULL;
-- "Sign out everywhere" / admin revoke: every session of this subject signed in before this instant is dead.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS sessions_not_before timestamptz;
-- Admin kill-switch (all citizen + employee sessions) and other global settings.
CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS admin_actions (
  id       bigserial PRIMARY KEY,
  admin    text NOT NULL,
  action   text NOT NULL,
  detail   jsonb NOT NULL DEFAULT '{}',
  at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------- Phase 6: citizen keys on their own devices ----------------
-- A citizen may move their signing key to their device: the browser generates a non-extractable P-256
-- key (WebCrypto), Mithaq keeps ONLY the public key and deletes the server-held private key. Every use
-- of the device key is gated by a fresh passkey assertion (a "ceremony").
ALTER TABLE citizen_keys ALTER COLUMN private_enc DROP NOT NULL;
ALTER TABLE citizen_keys ADD COLUMN IF NOT EXISTS device_bound boolean NOT NULL DEFAULT false;
ALTER TABLE citizen_keys ADD COLUMN IF NOT EXISTS passkey_credential_id text;
ALTER TABLE citizen_keys ADD COLUMN IF NOT EXISTS enrolled_at timestamptz;
-- Retired public keys stay available so that older signatures and mandates remain verifiable.
CREATE TABLE IF NOT EXISTS citizen_key_history (
  kid         text PRIMARY KEY,
  subject     text NOT NULL,
  public_jwk  jsonb NOT NULL,
  device_bound boolean NOT NULL,
  retired_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE challenges ADD COLUMN IF NOT EXISTS payload jsonb;
ALTER TABLE challenges DROP CONSTRAINT IF EXISTS challenges_kind_check;
ALTER TABLE challenges ADD CONSTRAINT challenges_kind_check CHECK (kind IN ('webauthn-register','webauthn-login','otp','ceremony'));

-- ---------------- Admin sign-in codes by Telegram ----------------
-- second_factor: always 'telegram' now — every one-time code is sent by Telegram (codes.ts).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS second_factor text;
-- The automated-test staff account (TEST-0001): signs in only with a server-minted test ticket, and every
-- list that shows staff actions marks its rows as automated.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS automated boolean NOT NULL DEFAULT false;
-- Automated tests cannot read Telegram. An operator with shell access on the server can mint a short-lived
-- ticket (services/identity/src/test-ticket.ts); a request that presents it gets its code in the response
-- instead of a Telegram message. Only the hash is stored; tickets expire after 30 minutes.
CREATE TABLE IF NOT EXISTS staff_test_tickets (
  ticket_hash  text PRIMARY KEY,
  subject      text NOT NULL,
  uses_left    integer NOT NULL,
  expires_at   timestamptz NOT NULL
);

-- ---------------- Registration of new adult citizens by staff + first-time activation ----------------
CREATE TABLE IF NOT EXISTS staff_registrations (
  national_id    text PRIMARY KEY REFERENCES accounts(subject),
  staff_subject  text NOT NULL,
  employee_id    text NOT NULL,
  reason         text,
  at             timestamptz NOT NULL DEFAULT now()
);
-- One pending activation per citizen; deleted when the citizen sets a password.
CREATE TABLE IF NOT EXISTS activation_codes (
  subject           text PRIMARY KEY REFERENCES accounts(subject) ON DELETE CASCADE,
  code_hash         text NOT NULL,
  attempts          integer NOT NULL DEFAULT 0,
  expires_at        timestamptz NOT NULL,
  issued_by         text NOT NULL,          -- staff ID
  issued_at         timestamptz NOT NULL DEFAULT now(),
  token_hash        text,                   -- short-lived step-2 token after the code was verified
  token_expires_at  timestamptz
);

-- Inbox rows keep the bus correlation ID (e.g. the birth notification) so related messages can be found.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS correlation_id text;
CREATE INDEX IF NOT EXISTS notifications_correlation_idx ON notifications (correlation_id);

-- ---------------- Every one-time code by Telegram ----------------
-- Send limit: one code per key (kind + recipient, e.g. "login:1100000015") per 60 seconds.
CREATE TABLE IF NOT EXISTS code_sends (
  key      text PRIMARY KEY,
  sent_at  timestamptz NOT NULL
);
-- Removed: authenticator-app (TOTP) staff codes, the per-account send timestamp, and the demo phone.
ALTER TABLE accounts DROP COLUMN IF EXISTS totp_secret_enc;
ALTER TABLE accounts DROP COLUMN IF EXISTS totp_last_step;
ALTER TABLE accounts DROP COLUMN IF EXISTS code_sent_at;
ALTER TABLE staff_registrations DROP COLUMN IF EXISTS phone;
DROP TABLE IF EXISTS demo_phone_messages;

-- Government news feed to the operator's Telegram chat (feed.ts): queued, sent in order, retried — never dropped.
-- status 'mocked' = produced while an automated test was running: stored, never sent.
CREATE TABLE IF NOT EXISTS feed_outbox (
  id          bigserial PRIMARY KEY,
  event_id    text NOT NULL UNIQUE,
  type        text NOT NULL,
  text        text NOT NULL,
  status      text NOT NULL CHECK (status IN ('queued', 'sent', 'mocked')),
  attempts    int NOT NULL DEFAULT 0,
  next_at     timestamptz NOT NULL DEFAULT now(),
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX IF NOT EXISTS feed_outbox_queued_idx ON feed_outbox (id) WHERE status = 'queued';
ALTER TABLE feed_outbox ADD COLUMN IF NOT EXISTS payload jsonb;   -- the structured message the notifier turns into text

-- ---------------- Native apps: registered devices with rotating refresh tokens (apps.ts) ----------------
CREATE TABLE IF NOT EXISTS app_devices (
  id                 text PRIMARY KEY,
  subject            text NOT NULL REFERENCES accounts(subject) ON DELETE CASCADE,
  platform           text NOT NULL CHECK (platform IN ('ios','android','windows')),
  name               text NOT NULL,
  app_version        text,
  refresh_hash       text NOT NULL,          -- sha256 of the current refresh token (the token itself is never stored)
  previous_hash      text,                   -- the one before: seeing it again means the token was copied
  refresh_expires_at timestamptz NOT NULL,
  push_provider      text CHECK (push_provider IN ('apns','fcm','wns')),
  push_token         text,
  registered_sid     text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz,
  revoked_at         timestamptz,
  revoked_reason     text
);
CREATE INDEX IF NOT EXISTS app_devices_subject_idx ON app_devices (subject) WHERE revoked_at IS NULL;

-- Password sign-in brake per account (throttle.ts): slows down, never locks.
CREATE TABLE IF NOT EXISTS password_throttle (
  subject      text PRIMARY KEY,
  failures     int NOT NULL DEFAULT 0,
  last_failure timestamptz NOT NULL DEFAULT now(),
  next_slot    timestamptz NOT NULL DEFAULT now()
);
