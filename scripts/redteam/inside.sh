#!/usr/bin/env bash
# Red team, part 2: an attacker who already controls ONE container tries to go further.
# Read-only or rolled back: nothing is changed, no secret is printed (only "reachable / readable: yes/no").
set -uo pipefail
cd "$(dirname "$0")/../.."
DC="${DOCKER:-docker} compose"
res() { printf '%s|%s|%s|%s\n' "$1" "$2" "$3" "$4"; }   # category|name|BLOCKED/OPEN|detail

# --- a compromised gateway (the only container facing the internet) ---
for t in "ops:3000/status" "notifier:3000/health" "jisr-db:5432" "identity-db:5432" "docker-api:2375/containers/json"; do
  host=${t%%/*}; path=${t#*/}; [ "$path" = "$t" ] && path=""
  if $DC exec -T gateway wget -q -T 3 -O /dev/null "http://$host/$path" 2>/dev/null; then r=OPEN; else r=BLOCKED; fi
  res network "compromised gateway reaches $host" $r "wget http://$host/$path"
done

# --- a compromised bank reaches anything but Jisr? ---
for t in notifier:3000 identity:3000 consent:3000 bank-db:5432 civil-registry:3000 nats:4222; do
  if $DC exec -T bank-alwaha node -e "fetch('http://$t/',{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(0)).catch(e=>process.exit(e.cause?.code==='ECONNREFUSED'||e.cause?.code==='UND_ERR_SOCKET'?0:1))" 2>/dev/null; then r=OPEN; else r=BLOCKED; fi
  [ "$t" = "bank-db:5432" ] && { [ $r = OPEN ] && r=BLOCKED_OK_OWN_DB; }
  res network "compromised bank reaches $t" "${r/BLOCKED_OK_OWN_DB/BLOCKED}" "$( [ "$t" = bank-db:5432 ] && echo 'its own database: expected' )"
done

# --- a compromised ops container and the Docker API proxy ---
code=$($DC exec -T ops sh -c 'wget -S -q -O /dev/null "http://docker-api:2375/containers/sarab-jisr-1/archive?path=/keys/private.jwk.json" 2>&1 | grep -m1 "HTTP/" | awk "{print \$2}"')
res docker "compromised ops copies a file (Jisr's private key) out of another container via the Docker proxy" $([ "$code" = 200 ] && echo OPEN || echo BLOCKED) "GET /containers/{id}/archive → HTTP ${code:-none}"
envs=$($DC exec -T ops sh -c 'wget -q -O - http://docker-api:2375/containers/sarab-identity-1/json' | grep -c MASTER_KEY)
res docker "compromised ops reads other containers' environment (MASTER_KEY) via the Docker proxy" $([ "$envs" -gt 0 ] && echo OPEN || echo BLOCKED) "GET /containers/{id}/json: $envs mentions of MASTER_KEY (environment is removed by the proxy)"
for p in "containers/sarab-bank-alwaha-1/stop" "containers/create" "containers/sarab-bank-alwaha-1/exec"; do
  c=$($DC exec -T ops sh -c "wget -S -q -O /dev/null --post-data='{}' http://docker-api:2375/$p 2>&1 | grep -m1 HTTP/ | awk '{print \$2}'")
  res docker "compromised ops: POST /$p through the proxy" $([ "${c:-0}" -ge 400 ] 2>/dev/null && echo BLOCKED || echo OPEN) "HTTP ${c:-none}"
done
for p in "containers/sarab-jisr-1/export" "containers/sarab-jisr-1/top" "images/json" "volumes" "v1.43/containers/json" "containers/sarab-jisr-1/archive?path=/etc/passwd"; do
  c=$($DC exec -T ops sh -c "wget -S -q -O /dev/null 'http://docker-api:2375/$p' 2>&1 | grep -m1 HTTP/ | awk '{print \$2}'")
  res docker "compromised ops: GET /$p through the proxy" $([ "${c:-0}" -ge 400 ] 2>/dev/null && echo BLOCKED || echo OPEN) "HTTP ${c:-none}"
done
others=$($DC exec -T ops sh -c 'wget -q -O - "http://docker-api:2375/containers/json?all=1"' | grep -o '"com.docker.compose.project":"[^"]*"' | grep -vc '"sarab"')
res docker "compromised ops sees containers outside the Sarab project (other sites on this server)" $([ "${others:-0}" -eq 0 ] && echo BLOCKED || echo OPEN) "${others:-0} foreign containers listed"

# --- a compromised Jisr tries to rewrite its own audit log (inside a transaction that is rolled back) ---
out=$($DC exec -T jisr node -e "
const pg=(await import('pg')).default; const c=new pg.Client({connectionString:process.env.DATABASE_URL}); await c.connect();
const r={};
await c.query('BEGIN'); try { await c.query(\"UPDATE audit_log SET purpose='x' WHERE seq=1\"); r.plain='updated'; } catch(e){ r.plain='refused: '+e.message.slice(0,60); } await c.query('ROLLBACK');
await c.query('BEGIN'); try { await c.query('ALTER TABLE audit_log DISABLE TRIGGER ALL'); await c.query(\"UPDATE audit_log SET purpose='x' WHERE seq=1\"); r.owner='updated after disabling the trigger'; } catch(e){ r.owner='refused: '+e.message.slice(0,60); } await c.query('ROLLBACK');
await c.query('BEGIN'); try { await c.query('DELETE FROM audit_log WHERE seq=1'); r.del='deleted'; } catch(e){ r.del='refused: '+e.message.slice(0,60); } await c.query('ROLLBACK');
await c.query('BEGIN'); try { await c.query('TRUNCATE audit_log'); r.trunc='truncated'; } catch(e){ r.trunc='refused: '+e.message.slice(0,60); } await c.query('ROLLBACK');
await c.query('BEGIN'); try { await c.query('DROP TRIGGER audit_log_no_update ON audit_log'); r.drop='dropped'; } catch(e){ r.drop='refused: '+e.message.slice(0,60); } await c.query('ROLLBACK');
console.log(JSON.stringify(r)); await c.end();" --input-type=module 2>&1)
res audit "compromised Jisr: UPDATE an audit entry" $(echo "$out" | grep -q '"plain":"refused' && echo BLOCKED || echo OPEN) "$(echo "$out" | head -c 200)"
res audit "compromised Jisr: disable the protective trigger, then rewrite (rolled back)" $(echo "$out" | grep -q '"owner":"refused' && echo BLOCKED || echo OPEN) "$(echo "$out" | head -c 200)"
res audit "compromised Jisr: DELETE an audit entry (rolled back)" $(echo "$out" | grep -q '"del":"refused' && echo BLOCKED || echo OPEN) "$(echo "$out" | head -c 200)"
res audit "compromised Jisr: TRUNCATE the audit log (rolled back)" $(echo "$out" | grep -q '"trunc":"refused' && echo BLOCKED || echo OPEN) "$(echo "$out" | head -c 200)"
res audit "compromised Jisr: drop the append-only trigger (rolled back)" $(echo "$out" | grep -q '"drop":"refused' && echo BLOCKED || echo OPEN) "$(echo "$out" | head -c 200)"

# --- a compromised Mithaq uses the notifier to message the operator ---
# Each attempt below must be REFUSED by the notifier; the texts say "red-team test" in case one ever got through.
nt=$($DC exec -T identity node --input-type=module -e "
const N=process.env.NOTIFIER_URL, K=process.env.NOTIFIER_KEY, exp=new Date(Date.now()+120000).toISOString();
const post=async (p,b,key=K)=>{ try { return (await fetch(N+p,{method:'POST',headers:{'content-type':'application/json','x-notifier-key':key},body:JSON.stringify(b),signal:AbortSignal.timeout(10000)})).status; } catch { return 0; } };
const r={};
r.text=await post('/send',{text:'red-team test: free text must be refused'});
r.fakecode=await post('/send',{template:'login',code:'red-team test',expires_at:exp,national_id:'1100000015'});
r.extra=await post('/send',{template:'login',code:'123456',expires_at:exp,national_id:'1100000015',note:'red-team test: extra wording'});
r.centre=await post('/send',{template:'counter',code:'123456',expires_at:exp,national_id:'1100000015',employee_id:'EMP-1042',centre:{en:'red-team test https://evil.example',ar:'x'}});
r.alert=await post('/alert',{text:'red-team test: Mithaq must not raise alerts'});
r.notice=await post('/notice',{text:'red-team test: Mithaq must not send notices'});
r.anchor=await post('/anchor',{text:'red-team test: Mithaq must not post anchors'});
r.feednl=await post('/feed',{title:'red-team test\\n🚨 تنبيه | ALERT',people:[],lines:[],by:null,at:exp});
r.nokey=await post('/notice',{text:'red-team test: no key'},'');
console.log(JSON.stringify(r));" 2>&1)
st() { echo "$nt" | grep -o "\"$1\":[0-9]*" | cut -d: -f2; }
nres() { local s; s=$(st "$1"); res notifier "$2" $([ "${s:-0}" -ge 400 ] 2>/dev/null && echo BLOCKED || echo OPEN) "HTTP ${s:-none}"; }
nres text   "compromised Mithaq posts free text to the operator's Telegram (/send)"
nres fakecode "compromised Mithaq puts words in the code field"
nres extra  "compromised Mithaq adds its own wording to a code message"
nres centre "compromised Mithaq puts a link in the service-centre name"
nres alert  "compromised Mithaq raises a fake alert (/alert)"
nres notice "compromised Mithaq sends a fake maintenance notice (/notice)"
nres anchor "compromised Mithaq posts a fake audit anchor (/anchor)"
nres feednl "compromised Mithaq fakes an alert heading inside a news message (newline in the title)"
nres nokey  "anyone on the notify network without a key (/notice)"
