# Architecture — Republic of Sarab

## Principles

1. **One identity, many data owners.** Mithaq knows *who you are* (credentials, keys). It does not own
   your civil data — the Civil Registry does. Each ministry is the single source of truth for its data and
   has its own PostgreSQL. There is no central database.
2. **Every exchange goes through Jisr.** Signed by the caller, checked against a published access policy,
   written to a tamper-evident log. Enforced twice: in code (targets reject requests without a Jisr
   assertion) and in the network (members share a Docker network only with Jisr).
3. **Proofs instead of data.** Private parties get selectively-disclosed, holder-bound SD-JWT
   presentations: "over 18: yes", never the birth date.
4. **Regulators set the outer limit, citizens decide within it.** A request outside the sector allow-list
   never reaches the citizen.
5. **Transparency.** Citizens see every access to their data, including by government bodies.

## Trust model and keys

`make init` acts as a tiny "central authority" (in X-Road terms, the central server):

* generates one **Ed25519** key pair per member (`secrets/keys/<member>.private.jwk.json`); each private
  key is mounted read-only into **only** that member's container;
* publishes the **trust list** `secrets/trust/members.json` (member id, class GOV/COM, sector, display
  names, public JWK), mounted into every container.

Citizens each get their own Ed25519 key pair inside Mithaq, encrypted at rest with AES-256-GCM under
`MASTER_KEY` (a stand-in for an HSM / remote-signing service). It is used for document signatures and
as the holder key that binds SD-JWT presentations. **Since Phase 6 a citizen can move it to their own
device** (see below), after which Mithaq holds only the public key.

## A Jisr exchange, step by step

```
caller (e.g. bank-alwaha)                    Jisr                                   target (idhn)
  │ JWT{iss, aud:"jisr", target, method,      │                                       │
  │     path, purpose, sub?, consent_id?,     │                                       │
  │     on_behalf_of?, body_sha256, jti}      │                                       │
  │  signed with the caller's own key ──────▶ │ 1 verify signature (trust list)       │
  │                                           │ 2 reject replayed jti (5 min window)  │
  │                                           │ 3 check body hash                     │
  │                                           │ 4 match access rule: client+target+   │
  │                                           │   method+path+purpose (+consent id)   │
  │                                           │ 5 deny → audit + 403                  │
  │                                           │ 6 allow → JWT{iss:"jisr", aud:target, │
  │                                           │   client, purpose, sub, request_id,   │
  │                                           │   method, path, body_sha256} ───────▶ │ verify Jisr sig, aud,
  │                                           │                                       │ method+path+body match
  │ ◀──────────── response ────────────────── │ 7 audit (status, duration) ◀───────── │
```

Access rules live in `services/jisr/src/policy.ts` and are visible at `/api/jisr/rules`.

### Audit hash chain

`hash_n = sha256(hash_{n-1} | canonical(entry_n))`, genesis = 64 zeros. Appends are serialised with a
Postgres advisory lock. The table is append-only twice over: Jisr runs as the database user `jisr_app`,
which may only `SELECT` and `INSERT` (no `UPDATE`, `DELETE` or `TRUNCATE`, and as a non-owner it cannot switch
triggers off), and a trigger refuses changes even from the owner. The schema, the access policy and the
`jisr_app` user are set up by the one-shot container `jisr-migrate` (`services/jisr/src/migrate.ts`), the only
part of Jisr that holds the owner password; Jisr refuses to start if it could change the log. `POST /api/jisr/audit/verify` recomputes the
chain and names the first broken entry. `GET /api/jisr/audit/head` returns a Jisr-signed checkpoint of the
current head that could be published elsewhere (anchoring), so even a database administrator who rewrites
the whole chain would be caught against an earlier published checkpoint.

## The bank flow (flagship)

```
Browser          Bank Al-Waha            Jisr        Idhn (consent)           Mithaq              Civil Registry
  │ open account ─▶│ POST /x/requests ────▶│──────────▶│ regulator allow-list?   │                     │
  │                │                       │           │  ✗ → 422 rejected_by_policy                   │
  │ ◀ redirect /consent/{id} ◀──────────────────────── │  ✓ pending request                            │
  │ sign in (passkey / pwd+OTP) ──────────────────────────────────────────────────▶│                     │
  │ approve ───────────────────────────────────────────▶ consent{claims, 365 d}    │                     │
  │ ◀ redirect /bank/callback?consent=… ─────────────── │                          │                     │
  │ complete ─────▶│ GET /x/consents/{id}/presentation?nonce=N ───▶│ active? owner?│                     │
  │                │                       │           │ POST /x/presentations ──▶│ GET /x/persons/{id} ▶│
  │                │                       │           │                          │ issue SD-JWT (all claims
  │                │                       │           │                          │ as digests) → present only
  │                │                       │           │                          │ approved + KB-JWT(aud=bank,
  │                │ ◀──────────── presentation ───────│◀─────────────────────────│ nonce=N, citizen key)
  │                │ verify: Mithaq sig, each disclosure digest, KB-JWT (aud, nonce, sd_hash), age_over_18
  │ ◀ account ─────│ stores ONLY the received claims
```

Each hop is a separate audited Jisr exchange; the citizen's "Who accessed my data" shows the ones that
carry their national ID as subject, with `on_behalf_of = bank-alwaha`.

## Credentials: who may vouch for what (Phase 2)

Each ministry is not only the source of truth for its data, it is also the **issuer** of credentials
about it. The trust framework lives in `packages/shared/src/catalog.ts` (`CREDENTIALS`):

| Credential (`vct`) | Only trusted issuer | Claims |
|---|---|---|
| `urn:sarab:credential:pid:1` | Mithaq (data from the Civil Registry) | national ID, names, `age_over_18/21`, birth date, nationality, gender, marital status, city, full address |
| `urn:sarab:credential:employment:1` | Ministry of Labor | employment status, employer, `income_bracket`, exact monthly income |

Mithaq acts as the citizen's (cloud) wallet: it obtains each credential bound to the citizen's key, then
presents only the approved claims. The bank verifies every proof **and** checks that its issuer is the
authoritative one for that `vct`, and that all proofs are bound to the same holder key.

The banking regulator allows `income_bracket` but not `monthly_income` — the proof replaces the data.
Health data has no credential and no private-sector route at all; the Health service additionally refuses
anything but Mithaq + `citizen-self-service` + `on_behalf_of=self` (defense in depth).

## Life events over the event bus (Phase 3)

```
hospital staff (staff portal, births.report) ─▶ Mithaq: checks the parents (Civil Registry, via Jisr)
   ─Jisr─▶ Health: birth report BN-… (mother, father?, sex, date, hospital — NO name) ─┐ outbox
                                                                                        ▼
NATS JetStream stream SARAB_EVENTS ◀── health.birth.notified {report id, parent IDs, actor = employee}
   │
   ├─▶ registry-births (Civil Registry) ─Jisr GET /x/birth-notifications/BN-… (purpose birth-registration)
   │        → a birth "awaiting name", deadline 14 days ─▶ registry.birth.awaiting_name
   │
   │   parent A (citizen portal) ─▶ Mithaq ─Jisr POST /x/births/BN-…/proposal (purpose birth-naming)
   │        ─▶ registry.birth.name_proposed  (awaiting = parent B, or nobody if B can't be reached)
   │   parent B ─▶ Mithaq ─Jisr POST /x/births/BN-…/confirmation {proposal id}
   │        → national ID allocated, child added to the family ─▶ registry.birth.named + registry.person.born
   │   (deadline passed: an open proposal is registered as it stands; none → registry.birth.name_overdue, once)
   │
   ├─▶ health-newborns (Health) → health file + birth vaccinations ─▶ health.record.opened
   ├─▶ labor-child-benefit (Labor) ─Jisr GET /x/persons/<child> (benefit-eligibility) ─▶ labor.benefit.awarded
   ├─▶ mithaq-inbox (Mithaq) → citizen inbox + life-event timeline + Telegram news feed (queued)
   └─▶ jisr-audit (Jisr) → one audit-chain entry per person named in the event
```

* **Who names the baby.** One parent proposes; the other confirms, or proposes a different name (which the
  first then confirms). A confirmation names the proposal it confirms, so nobody confirms a name that changed
  meanwhile (`409 proposal_changed`). The proposer can never confirm their own proposal — unless they are the
  only parent who can be reached: no father in the hospital report, or Mithaq tells the Registry that the
  other parent has no activated account (recorded with the proposal). The Registry is the source of truth for
  proposals and the deadline (`births`, `birth_name_proposals`); Mithaq stores nothing about the birth.
* **Names** are checked by the Registry (and the portal, earlier): Arabic letters only for the Arabic name,
  Latin letters (space, hyphen, apostrophe) for the English one, 2–30 characters; the family name comes from
  the father, or the mother when no father is recorded.
* **Hospital checks** (Mithaq, before Health is called): valid national IDs, mother female and father male,
  both alive and at least 12 years older than the baby, date not in the future and within 60 days. Health
  refuses a second report for the same mother and day unless it says it is another baby (twins).

* **Policy as code** (`packages/shared/src/event-policy.ts`): which member is the only publisher of each
  event type, and which durable consumers exist. From it `make init` generates the NATS config: one user per
  member that may publish only to `sarab.events.<itself>.>` and pull/ack only its own consumers. Jisr is the
  bus operator (creates the stream and consumers) and the auditor.
* **Signed events**: each event is a JWT signed with the publisher's member key (`typ: sarab-event+jwt`);
  subscribers verify the signature *and* that the signer is the declared publisher of that type.
* **Notify, then pull**: events carry identifiers only. Anything a subscriber needs is fetched through Jisr,
  so the access policy and the audit chain still apply.
* **Reliability**: a transactional outbox per publisher (state change and event commit together), JetStream
  de-duplication by event id, explicit acks with redelivery, and an inbox table per consumer (idempotent).
* `make attack-demo` includes a compromised ministry trying to publish a fake birth, forge the Registry's
  signature, eavesdrop on all events, read another consumer, and act as a delegate — all blocked.

## Delegation (Phase 3)

* A citizen authorises an adult (checked against the Civil Registry) for named scopes
  (`assets.view`, `vehicles.renew`) and a period. Creating one needs a sign-in within 15 minutes; the
  **mandate is a JWS signed with the grantor's own key** (anyone can verify it with their public key).
* To act, the delegate calls Mithaq, which checks the delegation is active and in scope and mints a
  120-second **act-as token** (`sub` = grantor, `act.sub` = delegate, `scope`, `aud` = target; modelled on
  RFC 8693). The Jisr request uses purpose `delegated-service` and `on_behalf_of: delegate:<id>`.
* **Jisr** verifies the act-as token itself (Mithaq signature, subject, delegate) before forwarding;
  **the target** (Property) verifies it again, including the scope. Revocation is immediate (checked on every use).
* The grantor's "who accessed my data" names the delegate; both get inbox messages for every action.
* The service-centre employee channel (Phase 4) records delegations for citizens who come in person.

## Assisted channel: service-centre employees (Phase 4)

* Employees are staff accounts with their own password (never public). Their second factor — like every
  one-time code in Sarab — is sent by Telegram (see *One-time codes* below).
* **The citizen must be present**: starting a counter session sends a 6-digit code to the citizen (by
  Telegram, standing in for their phone; the employee only sees "sent"); only after the employee enters the code the citizen reads out does the
  20-minute session open — for that one citizen. Opening someone's file alone is impossible.
* Every action goes through Jisr with purpose `assisted-service` and `on_behalf_of: employee:EMP-1042`,
  with a Mithaq-signed act-as token (`act.kind = employee`) that **Jisr checks** (actor ↔ on_behalf_of,
  purpose ↔ token kind) and **the target checks** (scope).
* Three records of every action: the Jisr audit chain, Mithaq's `assisted_actions` table (employee ID,
  citizen, action), and an event to the citizen's inbox. Citizens see "What service-centre staff did for
  me"; the auditor sees all actions by employee ID.
* What an employee can do: view the civil record, view vehicles/properties, renew a registration, record
  a delegation (for citizens who don't use the portal). Health data has no assisted-service rule at all.

## Staff permissions and civil registration

* `services/identity/src/staff.ts` defines permissions per staff role. The employee has `counter` and
  `registry.register`; the **administrator has the union of every role's permissions** plus `audit` and
  `sessions.admin`. Every staff endpoint calls `requireStaff(permission)`.
* Every staff action reaches Jisr's hash-chained audit log with the actor's staff ID:
  * exchange requests carry `on_behalf_of: employee:<staff ID>`;
  * events caused by staff carry `data.actor` with that tag, which Jisr's audit consumer copies into the
    entry's `on_behalf_of` (counter actions, registrations, activation codes, admin session revocations).
* **Registering an adult** (naturalisation / missing record): Mithaq → Jisr → Civil Registry
  `POST /x/persons` (purpose `civil-registration`; the Registry refuses requests without an
  `employee:` actor). The Registry validates the data (18+, plausible parents, spouse not already
  married), flags possible duplicates (same name + birth date) for the registrar to confirm, allocates the
  national ID with the same lock and Luhn scheme as births, links the family (the spouse's record too),
  stores who registered whom (`registrations`, with the Jisr request ID) and emits
  `registry.person.registered` (subjects: the person and each linked family member).
* Mithaq then creates a sign-in account **without a password** and issues an 8-digit activation code
  (hash only; 7 days; single use; 5 wrong attempts lock it; re-issuing replaces it; event
  `mithaq.activation.issued`). The code is **sent by Telegram**, never returned to the registrar (the API
  answers only `{ sent: true, sent_via: "telegram", expires_at }`). If it cannot be sent, the registration
  still stands and the registrar uses *Issue a new code*. The message carries a link to
  `/activate?nid=<national ID>` (the ID is pre-filled; the code is never put in a URL). Activation: code → 15-minute step token → password (10+ chars, not
  containing the ID) → signed in (`amr: activation, pwd`) → passkey. Event `mithaq.account.activated`.
* Newborns stay passwordless and account-less (they are children); adults enter through this path.

## Record maintenance by ministry staff ("Manage citizen")

A staff member with a `records.<ministry>` permission (the administrator has all five) maintains a person's
records **in the ministry that owns them**:

```
portal → Mithaq /api/identity/manage/<ministry>/persons/<id>/…   (permission check)
       → Jisr  purpose "record-maintenance", on_behalf_of "employee:<staff ID>",
               act = Mithaq-signed token { sub: <id>, act: { kind: employee, sub: <staff ID> },
                                           scope: ["records.<ministry>"], aud: <ministry>, 120 s }
       → ministry /x/records/persons/<id>/…  (checks the token again, validates, writes,
                                              logs record_changes, emits the life event)
```

* **Policy**: one rule per ministry (`GET|POST|PUT|DELETE /x/records/persons/:id/**`, Mithaq only) plus a
  name search at the Civil Registry. Jisr rejects a request whose staff token is missing, for another
  person / ministry / scope, not an employee, or whose `on_behalf_of` does not name the token's employee.
* **Validation**: the ministry owns its rules (Civil Registry: family links exist, parents 12+ years older and
  of the right sex, no close relatives marrying, both spouses free and adult, divorce after marriage; Labor:
  no overlapping jobs, end after start; Property: model belongs to the make, new owner is a living adult —
  asked of the Civil Registry through Jisr, purpose `ownership-transfer`; Health: no duplicates). Mithaq adds
  "not before the person could have done it" (degree year ≥ birth + 14, job start ≥ birth + 15, vaccination ≥
  birth) from one audited Civil Registry read, cached 10 minutes.
* **Life events** (`registry.address.changed`, `registry.marriage.registered/dissolved`,
  `registry.family.changed`, `education.record.changed`, `labor.employment.changed`,
  `property.vehicle.registered/transferred`, `property.record.changed`, `health.record.updated`) name the
  employee in `data.actor`; Jisr's audit consumer writes one entry per person involved, Mithaq's inbox
  consumer tells each person. Health subscribes to `registry.address.changed` and pulls the new address
  through Jisr (purpose `care-assignment`) to assign the new city's health centre. Education joined the bus
  for this (its own NATS user, publish-only).
* **Labor** keeps a job history; the current-employment row (status, employer, income, income source) is
  recomputed from it after every change. The employment credential is built from that row, so a bank sees a
  new job the next time the citizen shares their employment proof — nothing is pushed to the bank.
* **Health** events and change logs record who and when, never what.
* Jisr target guard now runs in `preValidation` (before body validation), so even an input error answered to
  a Jisr request is signed by the ministry.

## Tamper demo (Phase 4)

The admin page can simulate an insider who edits (hides why data was read) or deletes an audit entry.
Jisr itself may not change the real log (it runs as `jisr_app`), so the demo reads the whole chain in one
consistent snapshot, makes the edit on that **exact copy in memory**, and runs the same verifier over the
copy: it reports the exact broken entry (*content does not match its hash* / *prev_hash does not link*).
The real log is never touched, and the response also confirms the real chain is intact.
An insider with full database rights could rewrite the whole chain from the broken point onwards; the
defence is the **signed checkpoint** (`/api/jisr/audit/head`) published or anchored elsewhere —
see Phase 6.

## Phase 6 hardening

### Citizen keys on their own devices (passkey-bound)
* **Enrolment** (`My Mithaq → Where my signing key is kept`): after a passkey assertion with user
  verification, the browser creates a **non-extractable P-256 key** with WebCrypto and stores it in
  IndexedDB. Only the public JWK is sent. Mithaq stores it with the passkey it is bound to, moves the old
  public key to `citizen_key_history` (old signatures stay verifiable) and **deletes the server-held private
  key** (`private_enc = NULL`; the API then reports `server_holds_private_key: false`).
* **Ceremonies**: every use goes `POST /me/ceremonies` (Mithaq validates and fixes the exact bytes to sign,
  stored verbatim) → passkey assertion **restricted to the bound passkey** → device ES256 signature →
  `POST /me/ceremonies/:id/complete` (Mithaq verifies both, then acts). Used for document signatures,
  delegation mandates, and unlocking the wallet.
* **Bank sharing with a device key**: the bank now fixes its nonce when it asks (stored with the consent
  request). After the citizen approves, the wallet ceremony returns SD-JWT credentials bound to the device
  key (PID from Mithaq, employment from Labor). The **browser** keeps only the approved disclosures, signs the
  key-binding JWT (aud = bank, nonce, sd_hash) and hands the presentations to Idhn, which releases them once,
  for that nonce. Mithaq never sees the key binding. A later KYC refresh returns
  `citizen_presence_required` — a device-held key means a fresh proof needs the citizen, as with any real wallet.
* At a service centre (citizen present, device not), a delegation for a device-key citizen is **attested
  by Mithaq** (marked as such) rather than signed with their key.
* Limits: a WebCrypto key is non-extractable but usable by scripts on the origin (an XSS could ask it to sign
  while the page is open) — the passkey gate and strict CSP reduce this; a native wallet app or a
  hardware-backed key would be the next step. Passkeys may sync across a user's devices; the device key does not.

### Early session revocation
* Mithaq records every session (`sessions` table: sid, subject, role, sign-in methods, user agent,
  expiry). Sign-out revokes the sid server-side; "sign out everywhere" and admin revoke set
  `accounts.sessions_not_before`; the admin **kill-switch** sets a global not-before for all citizen and
  employee sessions (admins stay in).
* The gateway runs nginx `auth_request` against Mithaq's internal `/internal/session-check` for every API
  call (sign-in endpoints excepted), so a revoked token is refused **by every service at once** with
  `401 session_revoked` and the cookie is cleared. Mithaq's own routes check too (defence in depth).
* Citizens see their sessions (device, browser, sign-in method) and can end any of them.

### Signed Jisr responses
* Every member signs its answer to a Jisr-forwarded request: `typ: jisr-resp+jwt` with request id, status,
  method, path and SHA-256 of the exact body, in `X-Jisr-Response-Signature`.
* Jisr verifies it against the target's key before passing anything on (a bad or missing signature becomes a
  `502 response_signature_invalid`), records `response_sha256` in the hash-chained audit entry, and returns a
  **receipt** (`X-Jisr-Receipt`, signed by Jisr: request id, audit sequence number, entry hash).
* The caller re-verifies the target's signature itself, so **not even Jisr can alter what a ministry said**
  (`make attack-demo` includes altering a signed answer in transit).

## Sessions and authentication

* Fallback: national ID (or staff username) + password (scrypt) → 6-digit one-time code by Telegram
  (hashed, 5 min, 5 attempts, single use, one per 60 s).
* Password attempts slow down per account, never lock (`services/identity/src/throttle.ts`): after 5 wrong
  passwords, each further attempt waits 1, 2, 3, 4, then at most 5 s before any answer, from any address, and
  attempts for one account queue one behind the other; a queue longer than 30 s is answered
  `429 too_many_attempts` without checking the password. The brake ends 15 minutes after the last wrong
  password, and the right password clears it. Unknown usernames are treated the same way.
* Demo citizens share one password (`DEMO_PASSWORD`, random, generated by `make init`). With `DEMO_MODE=true`
  (local use) the sign-in page lists them and shows it; with `DEMO_MODE=false` no page or endpoint does.

## One-time codes

Every verification / one-time code — sign-in (citizens and staff), service-centre confirmation, account
activation, and any code added later — is delivered by `deliverCode()` (`services/identity/src/codes.ts`):

* It runs **inside the transaction that stores the code's hash**: if the per-recipient limit applies
  (one code per purpose + recipient per 60 s, table `code_sends`) or Telegram cannot be reached, it throws and
  the stored code is rolled back — a code exists only if it was delivered.
* The message (English + Arabic) names the site, the purpose, the account or national ID, the code and the
  expiry (Riyadh time + "in N minutes/days").
* Mithaq sends the `notifier` container (private `notify` network) **no text**, only structured fields: the
  template (sign-in, staff sign-in, activation, service centre), the code, the expiry, the national ID or
  username, the employee ID and centre. The notifier checks every field (format, length, no line breaks or
  links) and builds the message from fixed templates (`packages/shared/src/telegram-text.ts`), so a
  compromised Mithaq cannot post arbitrary text. Each caller has its own key: Mithaq's opens only `/send`
  and `/feed`; alerts, anchors, notices and backups need the ops key. Only the notifier has outbound
  internet and the bot token, and it can message only the configured chat (or, with no bot configured,
  prints every message to its log: console mode). Codes are never queued behind the news feed (below); the
  notifier caps codes at 60 per hour as a backstop, staff sign-in codes in a lane of their own.
* Codes are stored only as hashes; checks count the attempt atomically before comparing (max 5) and consume
  the code atomically (single use).
* Tests: a request carrying a valid server-minted test ticket gets `test_code` in the response and nothing
  is sent; it still counts as "sent" for the 60-second limit, which lets the tests prove the limit without
  sending anything.
* Passkeys: discoverable credentials, `attestation: none`, RP ID = your host (`RP_ID`, `localhost` by default), origin-checked
  (a phishing origin fails — tested in `make e2e`).
* Session = 30-minute EdDSA JWT signed by Mithaq, in an `HttpOnly; Secure; SameSite=Strict` cookie.
  Every service verifies it locally with Mithaq's public key. Document signing requires a sign-in within
  the last 15 minutes.

## Government news feed (Telegram)

`services/identity/src/feed.ts`. The `mithaq-inbox` consumer, which already sees every event, also writes one
Arabic message per event to `feed_outbox` (unique per event id). Format: `📢 خبر حكومي | <emoji> <what>`, one
`👤 name (national ID)` line per person, details, `✍️ بواسطة: …` (the citizen, `الموظف <ID>`, or the ministry
acting automatically) and `🕒 <Riyadh time>`. Codes start with `🔐 رمز تحقق` instead. As with codes, Mithaq
queues and sends structured fields (title, people, lines, author, time) and the notifier builds the text;
a field cannot contain a line break, so it cannot fake a second heading.

* **Names** are read from the Civil Registry through Jisr (`GET /x/persons/:id/name`, purpose `news-feed`,
  name only; cached 10 minutes) — so each read is audited and shows in that citizen's access log.
* **Coverage**: every event type gets a message; types without their own wording get a generic one from their
  label in the event policy, so events added later are covered without code changes. Left out on purpose:
  `mithaq.activation.issued` (the code goes out on its own), `mithaq.assisted.action`, `mithaq.admin.action`.
* **Rate limits, no drops**: a pump sends the oldest queued message first, one at a time. The notifier puts
  every Telegram message — code or news — through one pacing queue (≥ 1.1 s apart) and lets news use at most
  15 a minute, so codes always get through. When it answers 429 (its own limit, or Telegram's `retry_after`),
  the message waits that long and is retried; other failures back off up to 5 minutes. Nothing is dropped;
  sent messages are kept 7 days.
* **Tests never send**: while a test ticket is valid (`make e2e` / `make a11y` mint one; `test-cleanup.sh run`
  expires it when the run ends) — or when a name carries a test-run tag — the message is stored as `mocked`.
  The tests read them back through `GET /api/identity/test/feed` (ticket required) and check that none was
  sent. Side effect: a real event during a test run is mocked too.

## Public API for apps (v1)

* `/api/v1/<service>/…` is rewritten by the gateway to `/api/<service>/…`; services add `API-Version: 1`.
* Response documentation: Fastify `response` schemas also drive serialization (unlisted fields are dropped),
  so instead each service can run with `OPENAPI_CAPTURE=1`, infer a JSON Schema from every JSON response it
  sends (keys/types only; objects keyed by data become `additionalProperties`), and `make openapi` commits
  the result per service. At start-up `@fastify/swagger`'s `transform` adds those schemas to the spec for
  routes without hand-written ones — documentation only. `scripts/openapi-bundle.mjs` merges the public
  routes into `gateway/openapi/sarab-v1.json`, served by the gateway with a Swagger UI at `/api/v1/docs`.
* App devices (`apps.ts`, table `app_devices`): refresh tokens are 256-bit random, stored as SHA-256, rotated
  on every use with the previous hash kept for reuse detection (reuse → device and all its sessions
  revoked). Sessions opened by a device carry `device_id`, so removing the device ends them. Refreshed sessions
  have `amr: ["refresh"]`; `isStrongRecentSignIn()` refuses them for signing and delegations.
* Passkeys: `EXPECTED_ORIGINS` = the site origin + `android:apk-key-hash:<sha256 of each signing cert>`.

## Operations: backups (ops container)

`services/ops`, its own image (backend + Postgres 16 tools + age). No published port, no internet: it talks
to Telegram only through the notifier, which adds a fixed heading to everything ops sends
(`💾` backups, `🚨` alerts, `✅` resolved). It runs as the owner of `secrets/` and `.env` (mounted read-only)
and sits on every `db-*` network.

* **Consistency**: each database is dumped with `pg_dump --snapshot` from a REPEATABLE READ transaction that
  also counts every table, so the manifest's counts describe exactly what is in the dump.
* **Encryption**: `age` to a public recipient (`BACKUP_AGE_RECIPIENT`). The private key never enters a
  long-running container; only the throwaway restore-test container mounts it.
* **Off-server copy**: Telegram `sendDocument`, streamed through the notifier (never held in memory),
  45 MB parts, paced in the same queue as every other message.
* **Restore test** (`make restore-test`): checksum → decrypt → manifest → restore into a fresh Postgres →
  row counts per table → full audit-chain recomputation (shared code: `services/jisr/src/chain.ts`).

## Operations: audit anchors

Every hour (`services/ops/src/anchor.ts`): fetch Jisr's signed checkpoint `/api/jisr/audit/head` over
`ex-jisr` and verify its EdDSA signature against the trust list → open a REPEATABLE READ transaction on
Jisr's database and recompute the entire chain with the same code Jisr uses (`chain.ts`) → check that every
stored anchor's entry still has the anchored hash and that the new head is in the chain → append it to
`backups/.anchors.jsonl` and post it (seq, hash, the signed JWT) to Telegram: **silently** every hour
(`disable_notification`: no sound, no phone notification), and once a day at 09:00 Riyadh time as a normal
message with a one-line summary. A failed check is never anchored and alerts at once.

What it catches: an insider who edits, deletes or reorders entries, even one who recomputes every later
hash, because the hash at each anchored position changes. Telegram holds the copies the insider cannot
edit; `make audit-verify TEXT=…` checks pasted Telegram anchors and trusts only Jisr's public key. Limit:
entries written after the most recent anchor (up to one hour) are protected only by the chain itself, so an
insider who could also rewrite the server's anchor file can hide at most the last hour.

## Operations: monitoring

`services/ops/src/monitor.ts`, one tick a minute. Container facts come from `docker-api`
(`services/docker-api`, Sarab's own minimal proxy; the Docker socket is mounted only there, read-only, and
only ops shares its internal network). It allows `GET` only, answers only about the project's own
containers, and serves only the container list, state and health (no environment variables, mounts or
command line), stats and logs. Copying files out (`archive`, `export`), exec, start, stop, create, images,
volumes and every other path answer 403. Host RAM comes from `/proc/meminfo` (not namespaced), disk from `statfs` on the `./backups` bind
mount. Inside uptime goes ops → gateway over `ex-jisr`; outside uptime and the TLS expiry come from the
notifier's fixed `GET /probe` (the only container with internet; it can probe `PUBLIC_ORIGIN` and nothing
else). Error counts parse Docker's multiplexed log stream: pino `level ≥ 50` and gateway `5xx`.

Alert state (first seen, count, notified) is persisted, so a restart of ops neither repeats nor loses an
alert. Restarts are detected as "same container, new StartedAt" (a deploy creates new containers), grouped
into one message per check. Dead-man switch: ops POSTs `/heartbeat` every minute; the notifier alerts after
10 silent minutes. Maintenance windows (`maintenance.ts`, state in the ops state file, opened and closed by
the Makefile around `docker compose up --wait`, auto-closed after 30 minutes) silence container/uptime alerts
and end with one `🔧` notice listing the containers whose id or start time changed. Error lines are matched
against their Docker timestamps: lines written during a window, or up to 90 s after it, never count, even
when the 5-minute error check runs after the window has closed. Test runs are not maintenance: a bug a test
hits does alert. The one-shot `jisr-migrate` container counts as healthy once it has exited with code 0. Single point of failure: if the notifier or Telegram is down, nothing can be sent — an
external uptime monitor would cover that.

## Known limitations (deliberate, for a prototype)

* The project's own red-team suites (`make redteam`, `make redteam-inside`) found issues that were fixed
  (see the sections above). Two low-severity design trade-offs remain open on purpose.
* The `ops` container holds every database password and reads `secrets/` and `.env`, because it takes the
  backups; a compromised ops container would therefore expose them. The Docker proxy no longer adds to that.

* The trust list is a static file; real systems need key rotation and certificate revocation.
* Device-held keys are opt-in per citizen (the shared demo accounts default to server-held keys, and a demo
  button returns a key to the server so other visitors can keep using the account).
* The audit chain is anchored hourly, on the server and (silently) to one Telegram chat; a public,
  independent timestamping service (or several witnesses) would be stronger. The last hour before an anchor
  is protected only by the chain.
* Targets don't keep their own replay cache (they rely on Jisr's jti check + 30 s assertion lifetime).
* The bus uses plain NATS passwords from `.env` (NATS warns about this); NKEYs/JWT accounts would be the next step.
* Births are reported by the admin acting as hospital staff (there is no separate hospital account); each report adds a fake child once it is named.
* The news feed posts real names (of fictional people) to one Telegram chat; a real system would never broadcast personal life events.
* With `DEMO_MODE=true` the sign-in page lists the demo citizens and their shared password (staff are
  excluded). Any public deployment must set `DEMO_MODE=false`.
* All one-time codes go to one Telegram chat (the operator's), standing in for each person's own phone; a real system sends each code to that person only.

## Phase plan

| Phase | Scope | Status |
|---|---|---|
| 1 | Identity (Mithaq), Civil Registry, Jisr, consent (Idhn), Bank Al-Waha, portal, signing | **done** |
| 2 | Education, Health, Labor/Social Insurance, Property/Vehicles (each own DB, Jisr rules); multi-issuer bank KYC (employment status + income bracket, Labor-signed) | **done** |
| 3 | NATS JetStream event bus: "baby born" → birth record → family registry → health file → child benefit, no forms; citizen inbox; delegation with signed mandates (son renews elderly father's vehicle registration) | **done** |
| 4 | Service-centre employee role (assisted channel: citizen confirms with a code, every action logged with employee ID and reported to the citizen); admin tamper demo | **done** |
| 5 | Accessibility pass: session-timeout warning (WCAG 2.2.1), date-field focus ring, Tab-through/reflow/forced-colours tests, accessibility-tree snapshots, manual NVDA/VoiceOver test script ([accessibility.md](accessibility.md)); home-page polish | **done** (manual screen-reader run still to do) |
| 6 | Hardening: **citizen keys on their own devices** (passkey-bound: signing keys generated and kept on the device / in a wallet app, the server stores only public keys; signing and SD-JWT key binding happen client-side after a passkey check), **early session revocation** (server-side session table + revocation list checked by every service, "sign out everywhere", admin kill-switch), **signed Jisr responses** (target signs status + body hash + request id; Jisr verifies and logs the response hash; callers verify too) | **done** |

## Automated tests clean up after themselves

`make e2e` and `make a11y` give each run a tag (`qa` + 6 hex digits) and every name the tests type ends
with it (e.g. the baby "Sama qa1a2b3c"). When the run ends — passed or failed — `scripts/test-cleanup.sh run
<tag>` deletes that run's people from every database: registry record, birth / registration record, health
record, labor rows and child benefit, the Mithaq account (passkeys, keys, sessions, inbox, activation
codes), the parents' life event and the inbox messages it caused (found through the bus
correlation ID now stored with each inbox message). Leftovers of an interrupted run are removed by the next
run (anything tagged and older than an hour) or by `make test-cleanup`. Only people who entered through a
birth or a registration can be deleted, never the seeded population. Jisr's audit log is **kept** (deleting
from a hash chain would break it); the removed national IDs are retired (`retired_national_ids`) so they are
never given to a new person whose access log would then show test entries.
