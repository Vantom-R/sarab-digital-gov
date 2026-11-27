# Republic of Sarab — common commands. If your Docker needs root, run e.g.: make up DOCKER="$(DOCKER)"
DOCKER ?= docker
export DOCKER
DC := $(DOCKER) compose
# Compose project name (COMPOSE_PROJECT_NAME in .env, default sarab): also names the images, so two copies never share them.
PROJECT := $(or $(shell grep -s '^COMPOSE_PROJECT_NAME=' .env | cut -d= -f2-),sarab)
NODE := $(DOCKER) run --rm -u $(shell id -u):$(shell id -g) -v $(CURDIR):/app -w /app node:24-alpine

.PHONY: redteam redteam-inside send-report deploy monitor-status test-alert openapi openapi-bundle audit-verify anchors-reset backup backup-key restore-test help init up down restart reset logs ps stats e2e a11y citizens typecheck attack-demo demo-refresh a11y-snapshots test-cleanup

help:
	@echo "make init      - generate keys, trust list and .env (idempotent)"
	@echo "make up        - build and start everything"
	@echo "make down      - stop everything (data is kept)"
	@echo "make restart   - restart all containers"
	@echo "make reset     - DESTROY all data and start fresh (re-seeds the fake population)"
	@echo "make logs      - follow logs (S=service to filter, e.g. make logs S=jisr)"
	@echo "make ps        - container status"
	@echo "make stats     - RAM/CPU per container"
	@echo "make e2e       - run the end-to-end test against the running stack"
	@echo "make a11y      - browser tests: axe WCAG audit, keyboard/focus, real passkey (uses the public URL)"
	@echo "make a11y-snapshots - same, and save screen-reader accessibility trees to docs/accessibility/tree/"
	@echo "make test-cleanup - delete every person/account/baby that tests created (e2e and a11y do this themselves)"
	@echo "make citizens  - list the seeded citizens"
	@echo "               (staff passwords: ADMIN_PASSWORD / CLERK_PASSWORD in .env; every one-time code arrives by Telegram)"
	@echo "make attack-demo - a compromised bank and a compromised ministry try to bypass Jisr/the bus; every attempt must fail"
	@echo "make audit-verify - check the audit chain against the hourly anchors (TEXT=file: anchors pasted from Telegram)"
	@echo "make backup-key  - create the age key pair for backups (once; the private key goes to BACKUP_KEY, default ~/sarab-backup.key)"
	@echo "make backup      - take an encrypted backup now and send it to Telegram (it also runs nightly at 00:30 UTC)"
	@echo "make restore-test - restore the newest backup (or FILE=...) into a throwaway Postgres and check every table"
	@echo "make demo-refresh - put Saleh's car registration back to 'expires in 12 days' (re-arms the delegation demo)"

init:
	@umask 077 && mkdir -p secrets
	@touch .env && grep -q '^DOCKER_GID=' .env || echo "DOCKER_GID=$$(stat -c %g /var/run/docker.sock 2>/dev/null || echo 0)" >> .env
	$(NODE) node scripts/init-secrets.ts
	@chmod 700 secrets
	@echo "secrets ready (staff passwords are in .env; every one-time code is sent by Telegram)"

# Maintenance mode (services/ops/src/maintenance.ts): every rebuild / redeploy / restart below opens a
# window in which the monitor does not alert about containers going down or restarting, waits until every
# container is healthy, then closes it — which sends ONE "🔧 صيانة: تم تحديث …" message listing what changed.
# Always redeploy through these targets (never a bare `docker compose up`), so planned work never pages.
MAINT := $(DC) exec -T ops node services/ops/src/cli.ts maintenance
DC_UP := $(DC) up -d --build --wait --wait-timeout 240 $(if $(FORCE),--force-recreate)
define maintained
	@$(MAINT) start 2>/dev/null || echo "(ops not running: no maintenance window)"
	@rc=0; $(1) || rc=$$?; $(MAINT) end 2>/dev/null || echo "(ops not running: no maintenance message)"; exit $$rc
endef

up: init
	$(call maintained,$(DC_UP))
	@$(DC) ps --format 'table {{.Name}}\t{{.Status}}'

# Rebuild and redeploy only some services: make deploy S="identity gateway"
# (jisr always brings its one-shot jisr-migrate along: schema, access policy and the jisr_app user)
deploy:
	@test -n "$(S)" || { echo 'usage: make deploy S="service …"'; exit 2; }
	$(call maintained,$(DC_UP) --no-deps $(sort $(S) $(if $(filter jisr,$(S)),jisr-migrate)))

down:
	$(DC) down

restart:
	$(call maintained,$(DC) restart && $(DC) up -d --wait --wait-timeout 240)

reset:
	@$(MAINT) start 2>/dev/null || true
	$(DC) down -v
	$(MAKE) up
	$(MAKE) anchors-reset

logs:
	$(DC) logs -f --tail=100 $(S)

ps:
	$(DC) ps

stats:
	@$(DOCKER) stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' $$($(DC) ps -q)

# Tests sign in as the automated-test staff account "test" (TEST-0001), never as the administrator, and read
# the demo citizens' password from .env (DEMO_PASSWORD), never from the page.
# Each test run tags every name it types with TEST_RUN; scripts/test-cleanup.sh deletes that run's people,
# accounts and babies afterwards — pass or fail. Leftovers of an interrupted run (older than 1 h) go first.
TEST_RUN := qa$(shell od -An -N3 -tx1 /dev/urandom | tr -d ' \n')
CLEANUP_AFTER = ./scripts/test-cleanup.sh run $(TEST_RUN) || echo "test clean-up failed: run make test-cleanup"

e2e: demo-refresh
	@./scripts/test-cleanup.sh stale
	@. ./.env && rc=0; $(DOCKER) run --rm --network host -v $(CURDIR)/scripts:/scripts:ro \
	  -e BASE=http://127.0.0.1:$${GATEWAY_PORT:-18090} \
	  -e DEMO_PASSWORD="$$DEMO_PASSWORD" -e TEST_STAFF_PASSWORD="$$TEST_STAFF_PASSWORD" -e DEMO_MODE="$$DEMO_MODE" -e TEST_TICKET="$(TEST_TICKET)" -e CLERK_PASSWORD="$$CLERK_PASSWORD" \
	  -e TEST_RUN=$(TEST_RUN) node:24-alpine node /scripts/e2e.mjs || rc=$$?; \
	  $(DC) exec -T identity node services/identity/src/counter-expiry-check.ts || rc=1; $(CLEANUP_AFTER); exit $$rc

# Re-arms the delegation demo after someone renewed Saleh's car (demo state only; nothing is deleted).
demo-refresh:
	@$(DC) exec -T property-db psql -U property -d property -qc "UPDATE vehicles SET registration_expiry = current_date + 12 WHERE owner_id = '1100000015'" && echo "demo: Saleh's car registration expires in 12 days again"

# A compromised bank tries to bypass Jisr from inside its own container. Every attempt must fail.
attack-demo:
	@$(DC) exec -T bank-alwaha node services/bank-alwaha/src/attack-demo.ts
	@$(DC) exec -T labor node services/labor/src/attack-demo.ts

# Tests cannot read Telegram: mint a 30-minute ticket that returns codes in the API response instead
# (one use per code; nothing is sent to Telegram during tests).
TEST_TICKET = $$($(DOCKER) compose exec -T identity node services/identity/src/test-ticket.ts 400)

a11y:
	@./scripts/test-cleanup.sh stale
	@. ./.env && rc=0; $(DOCKER) run --rm --ipc=host --network host -u $(shell id -u):$(shell id -g) -e HOME=/tmp -e npm_config_cache=/tmp/.npm \
	  -v $(CURDIR)/scripts/a11y:/t -w /t -e BASE="$$PUBLIC_ORIGIN" \
	  -e DEMO_PASSWORD="$$DEMO_PASSWORD" -e TEST_STAFF_PASSWORD="$$TEST_STAFF_PASSWORD" -e DEMO_MODE="$$DEMO_MODE" -e TEST_TICKET="$(TEST_TICKET)" -e CLERK_PASSWORD="$$CLERK_PASSWORD" \
	  -e TEST_RUN=$(TEST_RUN) mcr.microsoft.com/playwright:v1.52.0-noble sh -c 'npm install --no-audit --no-fund >/dev/null 2>&1; node a11y.mjs' || rc=$$?; $(CLEANUP_AFTER); exit $$rc

# Same browser run, also saving the accessibility tree of key screens to docs/accessibility/tree/.
a11y-snapshots:
	@mkdir -p docs/accessibility/tree
	@./scripts/test-cleanup.sh stale
	@. ./.env && rc=0; $(DOCKER) run --rm --ipc=host --network host -u $(shell id -u):$(shell id -g) -e HOME=/tmp -e npm_config_cache=/tmp/.npm \
	  -v $(CURDIR)/scripts/a11y:/t -w /t -e BASE="$$PUBLIC_ORIGIN" -e SNAPSHOT_DIR=/snap -v $(CURDIR)/docs/accessibility/tree:/snap \
	  -e DEMO_PASSWORD="$$DEMO_PASSWORD" -e TEST_STAFF_PASSWORD="$$TEST_STAFF_PASSWORD" -e DEMO_MODE="$$DEMO_MODE" -e TEST_TICKET="$(TEST_TICKET)" -e CLERK_PASSWORD="$$CLERK_PASSWORD" \
	  -e TEST_RUN=$(TEST_RUN) mcr.microsoft.com/playwright:v1.52.0-noble sh -c 'npm install --no-audit --no-fund >/dev/null 2>&1; node a11y.mjs' || rc=$$?; $(CLEANUP_AFTER); exit $$rc

citizens:
	@$(DC) exec -T registry-db psql -U registry -d registry -c \
	  "SELECT national_id, given_name_en || ' ' || family_name_en AS name, given_name_ar || ' ' || family_name_ar AS name_ar, birth_date, city_en FROM persons ORDER BY national_id"

test-cleanup:
	@./scripts/test-cleanup.sh all

typecheck:
	$(NODE) npx tsc --noEmit -p tsconfig.json

# ---------------- Backups ----------------
# The private key decrypts every backup. It lives OUTSIDE the project (never in Telegram, never inside a
# container that runs all the time); copy it somewhere safe off this server.
BACKUP_KEY ?= $(HOME)/sarab-backup.key

backup-key:
	@if [ -f "$(BACKUP_KEY)" ]; then echo "backup key already exists: $(BACKUP_KEY)"; else \
	  $(DOCKER) run --rm -u $(shell id -u):$(shell id -g) -v $(dir $(BACKUP_KEY)):/out $(PROJECT)/ops:latest age-keygen -o /out/$(notdir $(BACKUP_KEY)) 2>/dev/null && chmod 600 "$(BACKUP_KEY)" && \
	  echo "private key written to $(BACKUP_KEY) - copy it somewhere safe"; fi
	@pub=$$(grep -o 'age1[0-9a-z]*' "$(BACKUP_KEY)" | head -1); \
	  if grep -q '^BACKUP_AGE_RECIPIENT=' .env; then sed -i "s/^BACKUP_AGE_RECIPIENT=.*/BACKUP_AGE_RECIPIENT=$$pub/" .env; else echo "BACKUP_AGE_RECIPIENT=$$pub" >> .env; fi; \
	  echo "public key set in .env (BACKUP_AGE_RECIPIENT); run: make up"

backup:
	$(DC) exec -T ops node services/ops/src/cli.ts backup

restore-test:
	@test -f "$(BACKUP_KEY)" || { echo "private key not found: $(BACKUP_KEY) (set BACKUP_KEY=/path)"; exit 1; }
	@$(DOCKER) run --rm --network none -u 0 -v $(CURDIR)/backups:/backups:ro -v "$(BACKUP_KEY)":/key:ro $(PROJECT)/ops:latest node services/ops/src/restore-test.ts $(FILE)

# ---------------- Audit anchors ----------------
# Checks the audit chain against every hourly anchor; TEXT=file checks anchors pasted from Telegram instead.
audit-verify:
	@if [ -n "$(TEXT)" ]; then $(DOCKER) compose cp "$(TEXT)" ops:/tmp/anchors.txt >/dev/null 2>&1 && $(DC) exec -T ops node services/ops/src/cli.ts verify-anchors /tmp/anchors.txt; \
	  else $(DC) exec -T ops node services/ops/src/cli.ts verify-anchors; fi

# Only after `make reset` (a new, empty audit log): archive the old anchors so they stop raising alerts.
anchors-reset:
	$(DC) exec -T ops node services/ops/src/cli.ts anchors-reset

# ---------------- Red team ----------------
# Attacks the platform from the server itself (gateway on 127.0.0.1, and from inside containers). Nothing
# is sent to Telegram (the attacker's own sign-in codes come back through a test ticket).
redteam:
	@. ./.env && $(DOCKER) run --rm --network host -v $(CURDIR)/scripts:/scripts:ro \
	  -e DEMO_PASSWORD="$$DEMO_PASSWORD" -e TEST_STAFF_PASSWORD="$$TEST_STAFF_PASSWORD" -e DEMO_MODE="$$DEMO_MODE" -e CLERK_PASSWORD="$$CLERK_PASSWORD" -e TEST_TICKET="$(TEST_TICKET)" \
	  node:24-alpine node /scripts/redteam/attack.mjs; rc=$$?; ./scripts/test-cleanup.sh run qa000000 >/dev/null 2>&1; exit $$rc

redteam-inside:
	@./scripts/redteam/inside.sh
	@$(DOCKER) run --rm --network none -u 0 -v $(CURDIR)/backups:/backups:ro -v "$(BACKUP_KEY)":/key:ro -v $(CURDIR)/scripts/redteam:/app/redteam:ro $(PROJECT)/ops:latest node redteam/tamper-copy.ts

# Sends a plain-text report file to the operator's Telegram (heading 🛡️): make send-report F=reports/x.txt C="caption"
send-report:
	@test -f "$(F)" || { echo 'usage: make send-report F=file C="caption"'; exit 2; }
	@$(DC) cp "$(F)" ops:/tmp/report.txt >/dev/null 2>&1 && $(DC) exec -T ops node services/ops/src/cli.ts send-report /tmp/report.txt "$(C)"

# ---------------- Monitoring ----------------
# What the monitor sees right now (the same text as the daily Telegram report).
monitor-status:
	@$(DC) exec -T ops node services/ops/src/cli.ts status

# Sends one clearly marked TEST alert and its "resolved" message, to check the alert channel.
test-alert:
	@$(DC) exec -T ops node services/ops/src/cli.ts test-alert

# ---------------- API documentation ----------------
API_SERVICES := jisr identity civil-registry education health labor property consent bank-alwaha
# Regenerates the observed response schemas of every route (services/*/openapi-responses.json) by running
# the test suites against services in capture mode, then rebuilds the combined public spec. A11Y=1 also
# runs the browser tests (more routes covered, slower).
openapi:
	@$(MAINT) start 2>/dev/null || true
	$(DC) -f docker-compose.yml -f docker-compose.capture.yml up -d --wait --wait-timeout 240 $(API_SERVICES)
	-$(MAKE) e2e
	@if [ "$(A11Y)" = "1" ]; then $(MAKE) a11y || true; fi
	@sleep 3
	@for s in $(API_SERVICES); do $(DC) cp $$s:/tmp/openapi-capture.json services/$$s/openapi-responses.json >/dev/null 2>&1 && { [ -O services/$$s/openapi-responses.json ] || sudo chown $(shell id -u):$(shell id -g) services/$$s/openapi-responses.json; } && echo "captured $$s" || echo "nothing captured for $$s"; done
	$(MAKE) up
	$(MAKE) openapi-bundle ARGS=--normalize

# Rebuilds gateway/openapi/sarab-v1.json from the running services and reports documentation coverage.
openapi-bundle:
	@. ./.env && $(DOCKER) run --rm --network host -u $(shell id -u):$(shell id -g) -v $(CURDIR):/app -w /app -e BASE=http://127.0.0.1:$${GATEWAY_PORT:-18090} -e PUBLIC_ORIGIN="$$PUBLIC_ORIGIN" node:24-alpine node scripts/openapi-bundle.mjs $(ARGS)
	$(call maintained,$(DC_UP) gateway)
