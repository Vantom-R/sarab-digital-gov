#!/usr/bin/env bash
# Deletes the people, accounts and babies that automated tests created, in every database.
#
#   scripts/test-cleanup.sh run qa1a2b3c     one test run (make e2e / make a11y call this when they finish, pass or fail)
#   scripts/test-cleanup.sh stale            every tagged test person older than one hour (left by an interrupted run)
#   scripts/test-cleanup.sh all              every tagged test person, whatever its age
#   scripts/test-cleanup.sh ids 1100000858 … these national IDs (one-off clean-ups)
#
# Tests mark everything they create: each name they type ends with the run tag "qa" + 6 hex digits
# (e.g. "Sama qa1a2b3c"); a hospital birth report carries it in its hospital file number. Babies are found
# through their birth notification (Ministry of Health) as well as the registry, so a birth that failed
# halfway — or was never named — is removed too.
#
# "run" also ends the test window: the run's test tickets expire, so the Telegram news feed (which only
# stores messages as "mocked" while a ticket is valid) goes live again; the mocked messages are deleted.
#
# Removed: the person (registry), their birth / registration record, health record and vaccinations,
# employment row, job history and child benefit (labor), anything in education / property / consent / bank
# (including each ministry's record_changes log, marriages, vehicle transfers), the
# Mithaq account with its passkeys, keys, sessions, inbox and activation codes,
# the parents' life event and the inbox messages it produced.
# Kept on purpose: Jisr's audit log. It is hash-chained, so deleting entries would break the chain;
# the entries keep the (now retired) national IDs, and retired IDs are never given to anyone else.
set -euo pipefail
cd "$(dirname "$0")/.."
DC=${DC:-${DOCKER:-docker} compose}
q() { local db=$1; shift; $DC exec -T "$db-db" psql -U "$db" -d "$db" -v ON_ERROR_STOP=1 -qAt "$@"; }

mode=${1:-}; shift || true
case "$mode" in
  run)   [[ ${1:-} =~ ^qa[0-9a-f]{6}$ ]] || { echo "usage: $0 run qa<6 hex>" >&2; exit 2; }
         pat="$1\$"; age="true"
         sleep 5     # let bus consumers finish with the run's last events (their feed messages are still mocked)
         q identity <<<"UPDATE staff_test_tickets SET expires_at = now() WHERE expires_at > now(); DELETE FROM feed_outbox WHERE status = 'mocked';" ;;
  stale) pat='qa[0-9a-f]{6}$'; age="created_at < now() - interval '1 hour'" ;;
  all)   pat='qa[0-9a-f]{6}$'; age="true" ;;
  ids)   [ $# -gt 0 ] || { echo "usage: $0 ids <national id>…" >&2; exit 2; }
         for i in "$@"; do [[ $i =~ ^[0-9]{10}$ ]] || { echo "not a national ID: $i" >&2; exit 2; }; done
         pat=""; age="true" ;;
  *) sed -n '2,8p' "$0" >&2; exit 2 ;;
esac

if [ -n "$pat" ]; then
  # App devices the tests registered for seeded citizens (named with the run tag).
  q identity -v pat="$pat" <<<"DELETE FROM app_devices WHERE name ~ :'pat' AND $age" >/dev/null
  # Unregistered or registered babies, through their birth notification.
  notifs=$(q health -v pat="$pat" <<<"SELECT string_agg(id, ',') FROM birth_notifications WHERE (child_given_name->>'en' ~ :'pat' OR child_given_name->>'ar' ~ :'pat' OR record_no ~ :'pat') AND $age")
  ids=$(q registry -v pat="$pat" -v notifs="{${notifs}}" <<<"SELECT string_agg(national_id, ',') FROM persons
          WHERE ((given_name_en ~ :'pat' OR given_name_ar ~ :'pat') AND $age)
             OR national_id IN (SELECT national_id FROM births WHERE notification_id = ANY(:'notifs'::text[]))")
else
  ids=$(IFS=,; echo "$*")
  notifs=""
fi
# Never a seeded person: only people who came in through a birth or a registration can be removed.
ids=$(q registry -v ids="{${ids}}" <<<"SELECT string_agg(national_id, ',') FROM (SELECT national_id FROM births UNION SELECT national_id FROM registrations) x
          WHERE national_id = ANY(:'ids'::text[])")
if [ -z "$ids" ] && [ -z "$notifs" ]; then echo "test clean-up: nothing to remove"; exit 0; fi

# Correlation IDs of everything the bus carried about these people (births, registrations).
corr=$(q registry -v ids="{${ids}}" -v notifs="{${notifs}}" <<<"SELECT string_agg(c, ',') FROM (
          SELECT unnest(:'notifs'::text[]) AS c
          UNION SELECT notification_id FROM births WHERE national_id = ANY(:'ids'::text[])
          UNION SELECT jisr_request_id FROM registrations WHERE national_id = ANY(:'ids'::text[])) x")
notifs=$(q health -v ids="{${ids}}" -v corr="{${corr}}" <<<"SELECT string_agg(id, ',') FROM birth_notifications WHERE id = ANY(:'corr'::text[]) OR child_national_id = ANY(:'ids'::text[])")
A=(-v ids="{${ids}}" -v corr="{${corr}}" -v notifs="{${notifs}}")

q identity "${A[@]}" <<'SQL'
BEGIN;
DELETE FROM notifications WHERE subject = ANY(:'ids'::text[]) OR correlation_id = ANY(:'corr'::text[]);
DELETE FROM life_events WHERE correlation_id = ANY(:'corr'::text[]);           -- steps cascade
DELETE FROM code_sends WHERE key IN (SELECT k || ':' || i FROM unnest(:'ids'::text[]) AS i, unnest(ARRAY['login','counter','activation']) AS k);
DELETE FROM activation_codes WHERE subject = ANY(:'ids'::text[]);
DELETE FROM staff_registrations WHERE national_id = ANY(:'ids'::text[]);
DELETE FROM sessions WHERE subject = ANY(:'ids'::text[]);
DELETE FROM assisted_actions WHERE citizen = ANY(:'ids'::text[]);
DELETE FROM assisted_sessions WHERE citizen = ANY(:'ids'::text[]);
DELETE FROM delegations WHERE grantor = ANY(:'ids'::text[]) OR delegate = ANY(:'ids'::text[]);
DELETE FROM citizen_key_history WHERE subject = ANY(:'ids'::text[]);
DELETE FROM challenges WHERE subject = ANY(:'ids'::text[]);
DELETE FROM accounts WHERE subject = ANY(:'ids'::text[]) AND kind = 'citizen';  -- passkeys, keys, signatures cascade
COMMIT;
SQL
q health "${A[@]}" <<'SQL'
BEGIN;
DELETE FROM record_changes WHERE national_id = ANY(:'ids'::text[]);
DELETE FROM vaccinations WHERE national_id = ANY(:'ids'::text[]);
DELETE FROM health_records WHERE national_id = ANY(:'ids'::text[]);
DELETE FROM birth_notifications WHERE id = ANY(:'notifs'::text[]);
COMMIT;
SQL
q labor "${A[@]}" <<'SQL'
BEGIN;
DELETE FROM benefits WHERE national_id = ANY(:'ids'::text[]) OR child_id = ANY(:'ids'::text[]);
DELETE FROM issued_credentials WHERE national_id = ANY(:'ids'::text[]);
DELETE FROM record_changes WHERE national_id = ANY(:'ids'::text[]);
DELETE FROM jobs WHERE national_id = ANY(:'ids'::text[]);
DELETE FROM social_insurance WHERE national_id = ANY(:'ids'::text[]);
DELETE FROM employment WHERE national_id = ANY(:'ids'::text[]);
COMMIT;
SQL
q education "${A[@]}" <<<"DELETE FROM record_changes WHERE national_id = ANY(:'ids'::text[]); DELETE FROM enrollments WHERE national_id = ANY(:'ids'::text[]); DELETE FROM degrees WHERE national_id = ANY(:'ids'::text[]);"
q property "${A[@]}" <<'SQL'
BEGIN;
DELETE FROM record_changes WHERE national_id = ANY(:'ids'::text[]);
DELETE FROM transfers WHERE plate IN (SELECT plate FROM vehicles WHERE owner_id = ANY(:'ids'::text[])) OR from_id = ANY(:'ids'::text[]) OR to_id = ANY(:'ids'::text[]);
DELETE FROM renewals WHERE owner_id = ANY(:'ids'::text[]) OR plate IN (SELECT plate FROM vehicles WHERE owner_id = ANY(:'ids'::text[]));
DELETE FROM vehicles WHERE owner_id = ANY(:'ids'::text[]);
DELETE FROM properties WHERE owner_id = ANY(:'ids'::text[]);
COMMIT;
SQL
q consent "${A[@]}" <<<"DELETE FROM consents WHERE subject = ANY(:'ids'::text[]); DELETE FROM consent_requests WHERE subject = ANY(:'ids'::text[]);"
q bank "${A[@]}" <<<"DELETE FROM customers WHERE national_id = ANY(:'ids'::text[]);"
n=$(q registry "${A[@]}" <<'SQL'
BEGIN;
-- Retire the IDs first: they are never allocated again (old audit entries must not point at someone new).
INSERT INTO retired_national_ids (national_id) SELECT unnest(:'ids'::text[]) ON CONFLICT DO NOTHING;
-- A surviving person who was linked to a deleted one loses only that link.
UPDATE persons SET spouse_id = NULL, marital_status = 'single', updated_at = now()
 WHERE spouse_id = ANY(:'ids'::text[]) AND NOT national_id = ANY(:'ids'::text[]);
UPDATE persons SET father_id = NULL WHERE father_id = ANY(:'ids'::text[]) AND NOT national_id = ANY(:'ids'::text[]);
UPDATE persons SET mother_id = NULL WHERE mother_id = ANY(:'ids'::text[]) AND NOT national_id = ANY(:'ids'::text[]);
DELETE FROM births WHERE national_id = ANY(:'ids'::text[]) OR notification_id = ANY(:'notifs'::text[]);  -- name proposals cascade
DELETE FROM record_changes WHERE national_id = ANY(:'ids'::text[]);
DELETE FROM marriages WHERE a = ANY(:'ids'::text[]) OR b = ANY(:'ids'::text[]);
DELETE FROM registrations WHERE national_id = ANY(:'ids'::text[]);
WITH d AS (DELETE FROM persons WHERE national_id = ANY(:'ids'::text[]) RETURNING 1) SELECT count(*) FROM d;
COMMIT;
SQL
)
echo "test clean-up: removed $n test people${notifs:+ and $(awk -F, '{print NF}' <<<"$notifs") birth notifications}"
