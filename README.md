# Republic of Sarab — a fully digital government (learning prototype)

> **Fictional country, fake data only.** The Republic of Sarab (جمهورية سَراب), its ministries and its
> citizens are invented. Every person in the seed data is generated. Nothing here is affiliated with, or
> modelled on the branding of, any real government or company.

---

## What Sarab is

Sarab is a small, architecturally honest prototype of a digital state, built to learn how the pieces of
a real e-government fit together: digital identity, ministries that each own their data, a secure data
exchange layer, citizen consent, selective-disclosure proofs, a tamper-evident audit log, life events that
flow between ministries without forms, and delegation.

It is a **learning prototype**, not production software. It was built with **Claude Code** (Anthropic's
coding agent) under the author's direction, and it contains **fake data only**.

## The pieces

| Piece | Name | What it does |
|---|---|---|
| Digital identity | **Mithaq** (ميثاق) | Passkeys (WebAuthn), a password + one-time-code fallback, sessions, one key pair per citizen, document signatures, credential issuer |
| Data exchange layer | **Jisr** (جسر) | X-Road style: every service-to-service request is signed, checked against an access policy and written to a hash-chained audit log |
| Consent | **Idhn** (إذن) | A company asks for specific claims; the regulator's allow-list is enforced automatically; the citizen approves, denies or revokes |
| Ministries | Civil Registry, Education, Health, Labor & Social Insurance, Property & Vehicles | Each with its own database and no direct access to the others |
| Event bus | NATS JetStream | Life events ("a baby was born") reach every ministry that needs them; signed, least-privilege, audited |
| Demo company | **Bank Al-Waha** (بنك الواحة) | Opens an account with no forms: identity + consent + a selective-disclosure proof |
| Web portal | — | Arabic (right-to-left) first, and English; citizen, bank, service-centre and admin views |

## Architecture in brief

* **Jisr, the exchange layer.** Ministries cannot reach each other directly: each one sits on its own
  private network shared only with Jisr. A request is a signed token (EdDSA) naming the caller, the
  target, the purpose and the citizen. Jisr checks it against the access policy, forwards it, verifies the
  target's signed answer and records the exchange. Citizens see every access to their data under
  "Who accessed my data".
* **Idhn, consent.** A bank asks for claims such as "over 18" or "income bracket". Idhn shows the
  citizen exactly what is asked and refuses anything outside the regulator's allow-list. Consent can be
  revoked, after which no further proof is released.
* **Selective-disclosure proofs (SD-JWT).** The bank receives a signed proof that reveals only the
  approved claims; the rest are salted digests. A 16-year-old is refused without the bank ever seeing a
  birth date. Several issuers sign their own claims (for example Labor signs the employment claim), and
  the proof is bound to a key kept on the citizen's device.
* **Hash-chained audit log with anchors.** Every Jisr entry contains the hash of the previous one, so
  editing or deleting an entry breaks the chain at exactly that point. Jisr's database user may only read
  and append to the log, and an append-only trigger guards it as well. Every hour a separate operations
  container takes Jisr's signed chain head (an *anchor*), recomputes the whole chain, checks it against
  every earlier anchor and can post a copy outside the server. The admin page has a *tamper demo* that
  edits a copy of the log and shows the verifier catching it.
* **Life events.** When a hospital reports a birth, the parents name the baby, the Civil Registry issues
  an ID, Health opens a file and Social Insurance starts the child benefit. Nobody fills in a form. Each
  step is an event on the bus, and each citizen gets an inbox message.
* **Delegation.** A citizen can grant a signed mandate with limited scopes (for example, a son renewing
  his elderly father's car registration). The mandate is checked on every request and can be revoked at
  any time.
* **Assisted channel.** A service-centre employee can serve a citizen only after the citizen confirms with
  a one-time code. Every action is recorded with the employee's ID and reported to the citizen.
* **Operations.** A monitor (containers, health, errors, disk, memory), encrypted backups with a restore
  test, a maintenance mode for planned redeploys, and alerts. Everything runs in Docker Compose, and the
  databases have no published ports.

More detail: [docs/architecture.md](docs/architecture.md).

## Run it locally

You need Docker with Compose v2, `make`, and about 2 GB of free RAM. Linux is tested; on macOS or Windows
use Docker Desktop.

```sh
git clone https://github.com/Vantom-R/sarab-digital-gov.git
cd sarab-digital-gov
make init      # creates keys, the trust list and .env with random passwords (DEMO_MODE=true)
make up        # builds and starts every container, then waits until all are healthy
```

Then open **http://localhost:18090**.

* **Demo citizens.** With `DEMO_MODE=true` the sign-in page lists the demo citizens and their shared
  password. The password is generated by `make init` and stored in `.env`:
  * Layla Al-Murjani `1100000049`: the bank demo.
  * Yousef Al-Nakhli `1100000056`: aged 16, so the bank refuses him without seeing his birth date.
  * Omar Al-Nakhli `1100000031`: acts for his father Saleh as a delegate.
  * Saleh Al-Nakhli `1100000015`: elderly father; delegation and service-centre demos.
  * The rest of the generated population: run `make citizens` to list them.
* **One-time codes.** Every code (sign-in, activation, service-centre) normally goes to a Telegram chat,
  standing in for SMS. Without a bot configured, the notifier runs in **console mode** and prints every
  message: `docker compose logs -f notifier`. To use Telegram, put your own bot token and chat ID in `.env`.
* **Staff.** `admin` (password `ADMIN_PASSWORD` in `.env`) and the service-centre employee `clerk`
  (`CLERK_PASSWORD`), each followed by a one-time code.
* **Tests.** `make e2e` (end-to-end API tests), `make a11y` (browser accessibility tests), `make redteam`
  and `make redteam-inside` (attacks). Tests use a dedicated automated-test staff account and a short-lived
  test ticket, so they never send codes.
* If your Docker needs root: `make up DOCKER="sudo docker"`. `make help` lists every command.
* Port 18090 taken, or a second copy on the same machine? Before `make init`, create `.env` with, for
  example, `GATEWAY_PORT=18190` and `COMPOSE_PROJECT_NAME=sarab2`. The portal is then at
  http://localhost:18190, and the containers, volumes and images are all named `sarab2`, so the two copies
  share nothing.
* `all predefined address pools have been fully subnetted`: Sarab uses 22 small Docker networks (one per
  member and per database, for isolation), and Docker's default pools run out after about 30 networks on a
  machine. Remove unused networks (`docker network prune`), or give Docker more pools with
  `default-address-pools` in `/etc/docker/daemon.json`.

For a public deployment, set `DEMO_MODE=false`, your own `PUBLIC_ORIGIN` and `RP_ID`, and put a TLS
reverse proxy in front of the gateway (it listens on 127.0.0.1 only).

## Accessibility first

The portal was built for screen-reader users from the start, in Arabic and English:

* It aims at WCAG 2.2 AA and is built for **NVDA** (Windows) and **VoiceOver** (macOS and iOS); automated checks run with axe, and a manual NVDA / VoiceOver test script is included.
* Semantic HTML, one `h1` per page with focus moved to it on navigation, live-region announcements,
  error summaries whose items link to their fields in form order, and tables with captions.
* Right-to-left layout with logical CSS properties, forced-colours support, 320 px reflow, and a
  session-timeout warning (WCAG 2.2.1).
* Long lists have paging (20 per page) and filters, so a screen reader is not flooded.
* `make a11y` runs axe, keyboard and focus tests in both languages. [docs/accessibility.md](docs/accessibility.md)
  has the manual NVDA and VoiceOver test script.

## Security testing (red team)

The project includes its own attack suites, run from the machine itself:

* `make redteam`: about 70 attacks through the gateway. They cover sign-in and one-time-code brute force and races, forged
  and altered session tokens, privilege escalation, other citizens' data (IDOR), consent and proof abuse,
  injection, path traversal, SSRF, XSS, CORS and CSRF.
* `make redteam-inside`: an attacker who already controls one container (the gateway, the bank, the
  operations container, Jisr or Mithaq) tries to go further. It also includes a "perfect" audit-log rewrite on a copy
  restored from a backup.

Fixes made after these runs include:
* consent bound to its own request;
* an atomic consent decision (a race condition);
* timing-safe sign-in;
* a separate code budget for staff;
* a per-account sign-in slowdown that never locks anyone out;
* an audit log that the exchange layer itself cannot change;
* a minimal read-only Docker proxy for the monitor;
* message templates built by the notifier itself, so a compromised identity service cannot send arbitrary text;
* hourly off-server anchors.

In the most recent run, 68 of 70 gateway attacks and 37 of 37 inside-container attacks were blocked. The
remaining two are low-severity design trade-offs and are not described here.

## Honest notes

* A learning prototype built with Claude Code. Not audited, not for real people or real data.
* All data is fake: the seed generator (`packages/shared/src/seed.ts`) creates the citizens, families,
  records and ministries' data from scratch on first start.
* No database dumps, backups or audit-log exports are included. `.env`, keys and secrets are created on
  your machine by `make init` and are never committed.

## License

[MIT](LICENSE).
