// Jisr — the data exchange layer (inspired by Estonia's X-Road).
import { SignJWT, jwtVerify, decodeProtectedHeader, decodeJwt } from 'jose';
import { createService, start, httpError, S } from '#shared/http.ts';
import { createDb, tx } from '#shared/db.ts';
import { loadOwnKey, memberPublicKey, randomId, trustList } from '#shared/crypto.ts';
import { bodyHash, verifyResponseSignature } from '#shared/jisr.ts';
import { requireSession } from '#shared/session.ts';
import { PURPOSES } from '#shared/catalog.ts';
import { MEMBER_URLS, DELEGATED_PURPOSES, matchPath, methodAllowed } from './policy.ts';
import { RECORD_MINISTRIES, RECORD_PURPOSE, SEARCH_SUBJECT } from '#shared/records.ts';
import { verifyActToken, actorTag } from '#shared/delegation.ts';
import { bus, onEvents } from '#shared/events.ts';
import { EVENT_TYPES, STREAM, SUBJECT_ROOT, SUBSCRIPTIONS, subjectFor } from '#shared/event-policy.ts';
import { GENESIS, entryHash as chainEntryHash, verifyChain as verifyChainWith, type AuditEntry } from './chain.ts';
import { AckPolicy, DeliverPolicy, RetentionPolicy, StorageType, nanos } from 'nats';

const db = createDb();
// The schema and the access policy are written by the one-shot jisr-migrate container (migrate.ts), as the
// table owner. This service runs as jisr_app, which may only read and append the audit log (red-team B).
for (let attempt = 1; ; attempt++) {
  try { await db.query('SELECT 1 FROM audit_log LIMIT 0'); await db.query('SELECT 1 FROM access_rules LIMIT 0'); break; } catch (err) {
    if (attempt >= 60) throw err;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
{
  const { rows: [p] } = await db.query(`SELECT has_table_privilege(current_user, 'audit_log', 'UPDATE') AS upd, has_table_privilege(current_user, 'audit_log', 'DELETE') AS del,
    has_table_privilege(current_user, 'audit_log', 'TRUNCATE') AS trunc, (SELECT tableowner FROM pg_tables WHERE tablename = 'audit_log') = current_user AS owner`);
  if (p.upd || p.del || p.trunc || p.owner) throw new Error('Jisr must not be able to change its audit log: connect as jisr_app, not as the owner (see services/jisr/src/migrate.ts)');
}
const own = await loadOwnKey();

// ---------------- Hash-chained audit log ----------------

// The chain's hashing and verification live in chain.ts (the backup restore test reuses them).
const entryHash = chainEntryHash;

async function appendAudit(e: AuditEntry, durationMs: number | null): Promise<{ seq: number; hash: string }> {
  return tx(db, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(7243)'); // serialize appends so the chain is linear
    const prev = (await c.query('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1')).rows[0]?.hash ?? GENESIS;
    const hash = entryHash(prev, e);
    const { rows: [r] } = await c.query(
      `INSERT INTO audit_log (request_id, ts, client, target, method, path, purpose, subject, consent_id, on_behalf_of, decision, reason, status, duration_ms, prev_hash, hash, response_sha256)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING seq`,
      [e.request_id, e.ts, e.client, e.target, e.method, e.path, e.purpose, e.subject, e.consent_id, e.on_behalf_of, e.decision, e.reason, e.status, durationMs, prev, hash, e.response_sha256 ?? null],
    );
    return { seq: Number(r.seq), hash };
  });
}

const verifyChain = (q: { query: typeof db.query } = db) => verifyChainWith(q);

// ---------------- Service ----------------

const app = await createService({
  prefix: 'jisr',
  title: 'Jisr — Data Exchange Layer',
  description: 'Every service-to-service request in Sarab goes through Jisr: signed (EdDSA JWT), checked against the access policy, and written to a hash-chained audit log. `/x/exchange` is internal only; `/api/jisr/*` is the public transparency/audit API.',
});

const deny = async (reply: any, e: AuditEntry, status: number, reason: string) => {
  await appendAudit({ ...e, decision: 'deny', reason, status }, null);
  return reply.status(status).header('x-jisr-request-id', e.request_id).send({ error: 'jisr_denied', message: reason, request_id: e.request_id });
};

app.post('/x/exchange', { schema: { tags: ['exchange (internal)'], summary: 'Forward a signed member request to its target (internal network only)', security: [{ jisr: [] }] } }, async (req, reply) => {
  const requestId = randomId(12);
  const ts = new Date().toISOString();
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Jisr ') ? auth.slice(5) : '';
  const base: AuditEntry = { request_id: requestId, ts, client: 'unknown', target: null, method: null, path: null, purpose: null, subject: null, consent_id: null, on_behalf_of: null, decision: 'deny', reason: null, status: null };

  // 1. Who is calling? Verify the signature with the caller's key from the trust list.
  let claims: any;
  try {
    const unverifiedIss = decodeJwt(token).iss ?? '';
    base.client = unverifiedIss || 'unknown';
    if (!trustList()[unverifiedIss]) return deny(reply, base, 401, 'Caller is not a registered Jisr member');
    decodeProtectedHeader(token);
    ({ payload: claims } = await jwtVerify(token, await memberPublicKey(unverifiedIss), { audience: 'jisr', typ: 'jisr-req+jwt', maxTokenAge: '60s' }));
  } catch (e) {
    return deny(reply, base, 401, `Invalid request signature: ${(e as Error).message}`);
  }
  Object.assign(base, {
    client: claims.iss, target: claims.target ?? null, method: claims.method ?? null, path: claims.path ?? null,
    purpose: claims.purpose ?? null, subject: claims.sub ?? null, consent_id: claims.consent_id ?? null, on_behalf_of: claims.on_behalf_of ?? null,
  });

  // 2. Replay protection + body integrity.
  if (!claims.jti) return deny(reply, base, 401, 'Missing jti');
  const fresh = await db.query('INSERT INTO seen_jti (jti, expires_at) VALUES ($1, now() + interval \'5 minutes\') ON CONFLICT DO NOTHING', [`${claims.iss}:${claims.jti}`]);
  if (fresh.rowCount === 0) return deny(reply, base, 401, 'Replayed request (jti already used)');
  const raw = req.rawBody ?? '';
  if (claims.body_sha256 !== bodyHash(raw)) return deny(reply, base, 401, 'Body does not match signed hash');

  // 3. Access policy.
  const targetUrl = MEMBER_URLS[claims.target];
  if (!targetUrl) return deny(reply, base, 404, `Unknown target member "${claims.target}"`);
  const { rows: rules } = await db.query('SELECT * FROM access_rules WHERE client = $1 AND target = $2', [claims.iss, claims.target]);
  const rule = rules.find((r) => methodAllowed(r.method, claims.method) && matchPath(r.path_pattern, claims.path));
  if (!rule) return deny(reply, base, 403, `No access rule allows ${claims.iss} → ${claims.target} ${claims.method} ${claims.path.split('?')[0]}`);
  if (!rule.purposes.includes(claims.purpose)) return deny(reply, base, 403, `Purpose "${claims.purpose}" is not allowed for this rule (allowed: ${rule.purposes.join(', ')})`);
  if (rule.requires_consent && !claims.consent_id) return deny(reply, base, 403, 'This exchange requires a citizen consent id');
  if (DELEGATED_PURPOSES.includes(claims.purpose)) {
    // Acting for someone else: Jisr itself checks the Mithaq-signed mandate matches subject and delegate.
    try {
      const act = await verifyActToken(claims.act, { subject: claims.sub, audience: claims.target });
      if (claims.on_behalf_of !== actorTag(act.act)) throw new Error('on_behalf_of does not name the actor in the mandate');
      if ((claims.purpose === 'assisted-service') !== (act.act.kind === 'employee')) throw new Error('purpose does not match the kind of mandate');
    } catch (e) {
      return deny(reply, base, 403, `Delegation mandate rejected: ${(e as Error).message}`);
    }
  }

  if (claims.purpose === RECORD_PURPOSE) {
    // Ministry staff changing records: Jisr itself checks the Mithaq-signed staff token (employee, person, ministry).
    try {
      const scope = Object.values(RECORD_MINISTRIES).find((m) => m.target === claims.target)?.scope;
      if (!scope) throw new Error('not a record-keeping ministry');
      const act = await verifyActToken(claims.act, { subject: claims.sub ?? SEARCH_SUBJECT, audience: claims.target, scope });
      if (act.act.kind !== 'employee') throw new Error('only an employee may maintain records');
      if (claims.on_behalf_of !== actorTag(act.act)) throw new Error('on_behalf_of does not name the employee in the token');
    } catch (e) {
      return deny(reply, base, 403, `Staff token rejected: ${(e as Error).message}`);
    }
  }

  // 4. Forward with Jisr's own signed assertion.
  const assertion = await new SignJWT({
    client: claims.iss, purpose: claims.purpose, consent_id: claims.consent_id, on_behalf_of: claims.on_behalf_of,
    ...(claims.act ? { act: claims.act } : {}),
    request_id: requestId, method: claims.method, path: claims.path, body_sha256: claims.body_sha256,
    ...(claims.sub ? { sub: claims.sub } : {}),
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: own.kid, typ: 'jisr-fwd+jwt' })
    .setIssuer('jisr').setAudience(claims.target).setIssuedAt().setExpirationTime('30s')
    .sign(own.key);

  const started = Date.now();
  let status = 502;
  let body = JSON.stringify({ error: 'target_unreachable', message: `Target ${claims.target} unreachable` });
  let responseSig: string | null = null;
  let reached = false;
  try {
    const res = await fetch(targetUrl + claims.path, {
      method: claims.method,
      headers: { 'x-jisr-assertion': assertion, ...(raw ? { 'content-type': 'application/json' } : {}) },
      body: raw || undefined,
      signal: AbortSignal.timeout(12_000),
    });
    status = res.status;
    body = await res.text();
    responseSig = res.headers.get('x-jisr-response-signature');
    reached = true;
  } catch (e) {
    req.log.warn({ err: e }, 'target unreachable');
  }
  // Phase 6: the target must sign what it answered; Jisr checks before passing it on and logs the hash.
  let reason: string | null = status >= 400 ? `target responded ${status}` : null;
  if (reached) {
    try {
      if (!responseSig) throw new Error('missing response signature');
      await verifyResponseSignature(responseSig, { target: claims.target, requestId, status, body });
    } catch (e) {
      reason = `response rejected: ${(e as Error).message}`;
      status = 502;
      body = JSON.stringify({ error: 'response_signature_invalid', message: reason });
      responseSig = null;
    }
  }
  const responseSha = reached ? bodyHash(body) : null;
  const entry = await appendAudit({ ...base, decision: 'allow', reason, status, response_sha256: responseSha }, Date.now() - started);
  // Receipt: Jisr's signed statement that this exchange (and this response) is in the audit chain.
  const receipt = await new SignJWT({ request_id: requestId, seq: entry.seq, entry_hash: entry.hash, response_sha256: responseSha })
    .setProtectedHeader({ alg: 'EdDSA', kid: own.kid, typ: 'jisr-receipt+jwt' }).setIssuer('jisr').setAudience(claims.iss).setIssuedAt().sign(own.key);
  reply.status(status).header('x-jisr-request-id', requestId).header('x-jisr-receipt', receipt);
  if (responseSig) reply.header('x-jisr-response-signature', responseSig);
  return reply.type('application/json').send(body);
});

// ---------------- Public transparency / audit API ----------------

const auditEntrySchema = {
  type: 'object',
  properties: {
    seq: { type: 'integer' }, request_id: { type: 'string' }, ts: { type: 'string' }, client: { type: 'string' },
    client_name: S.bilingual, target: { type: ['string', 'null'] }, target_name: S.bilingual,
    method: { type: ['string', 'null'] }, path: { type: ['string', 'null'] }, purpose: { type: ['string', 'null'] },
    purpose_label: S.bilingual, subject: { type: ['string', 'null'] }, consent_id: { type: ['string', 'null'] },
    on_behalf_of: { type: ['string', 'null'] }, on_behalf_of_name: S.bilingual, decision: { type: 'string' },
    reason: { type: ['string', 'null'] }, status: { type: ['integer', 'null'] }, hash: { type: 'string' }, prev_hash: { type: 'string' },
    event_label: S.bilingual, response_sha256: { type: ['string', 'null'] },
  },
} as const;

const nameOf = (id: string | null) => {
  if (!id) return undefined;
  if (id === 'self') return { ar: 'أنت (عبر بوابة ميثاق)', en: 'You (via the Mithaq portal)' };
  if (id.startsWith('employee:')) return { ar: `موظف مركز خدمة (${id.slice(9)})`, en: `Service-centre employee ${id.slice(9)}` };
  if (id.startsWith('delegate:')) return { ar: `مفوَّض منك (هوية ${id.slice(9)})`, en: `Your delegate (ID ${id.slice(9)})` };
  if (id === 'bus') return { ar: 'ناقل الأحداث (للجهات المشتركة)', en: 'Event bus (to subscribed services)' };
  return trustList()[id]?.name ?? { ar: id, en: id };
};

const present = (r: any) => ({
  ...r,
  seq: Number(r.seq),
  client_name: nameOf(r.client),
  target_name: nameOf(r.target),
  purpose_label: r.purpose ? PURPOSES[r.purpose] ?? { ar: r.purpose, en: r.purpose } : undefined,
  on_behalf_of_name: nameOf(r.on_behalf_of),
  ...(r.method === 'EVENT' ? { event_label: EVENT_TYPES[r.path]?.label } : {}),
});

app.get('/api/jisr/audit/mine', {
  schema: {
    tags: ['audit'], summary: 'Who accessed my data — every exchange that involved the signed-in citizen', security: [{ session: [] }],
    querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 } } },
    response: { 200: { type: 'object', properties: { entries: { type: 'array', items: auditEntrySchema } } } },
  },
}, async (req) => {
  const s = await requireSession(req, ['citizen']);
  const { limit } = req.query as { limit: number };
  const { rows } = await db.query('SELECT * FROM audit_log WHERE subject = $1 ORDER BY seq DESC LIMIT $2', [s.sub, limit]);
  return { entries: rows.map(present) };
});

// Result classes, as people read them: a policy refusal ("denied") is not the same as a ministry that simply
// has no record for that person (an allowed call answered 404) or a call that failed for another reason.
export const RESULT_SQL: Record<string, string> = {
  allowed: "(decision = 'allow' AND coalesce(status, 0) < 400)",
  no_record: "(decision = 'allow' AND status = 404)",
  failed: "(decision = 'allow' AND status >= 400 AND status <> 404)",
  denied: "(decision = 'deny')",
};

app.get('/api/jisr/audit', {
  schema: {
    tags: ['audit'], summary: 'Full audit log, newest first, with filters and paging (admin)', security: [{ session: [] }],
    description: 'Dates are calendar days in Riyadh time (YYYY-MM-DD, inclusive). `employee` matches exchanges done on behalf of that employee ID. `total` counts every match.',
    querystring: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 }, offset: { type: 'integer', minimum: 0, default: 0 },
        subject: { type: 'string', maxLength: 40 }, client: { type: 'string', maxLength: 40 }, employee: { type: 'string', maxLength: 20 },
        result: { type: 'string', enum: Object.keys(RESULT_SQL) },
        from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' },
      },
    },
    response: { 200: { type: 'object', properties: { total: { type: 'integer' }, offset: { type: 'integer' }, limit: { type: 'integer' }, entries: { type: 'array', items: auditEntrySchema } } } },
  },
}, async (req) => {
  await requireSession(req, ['admin']);
  const q = req.query as { limit: number; offset: number; subject?: string; client?: string; employee?: string; result?: string; from?: string; to?: string };
  const where = `($1::text IS NULL OR subject = $1) AND ($2::text IS NULL OR client = $2)
    AND ($3::text IS NULL OR on_behalf_of = 'employee:' || $3)
    AND ($4::date IS NULL OR ts::timestamptz >= ($4::date)::timestamp AT TIME ZONE 'Asia/Riyadh')
    AND ($5::date IS NULL OR ts::timestamptz < ($5::date + 1)::timestamp AT TIME ZONE 'Asia/Riyadh')
    ${q.result ? `AND ${RESULT_SQL[q.result]}` : ''}`;
  const args = [q.subject?.trim() || null, q.client?.trim() || null, q.employee?.trim() || null, q.from ?? null, q.to ?? null];
  const [{ rows }, { rows: [{ n }] }] = await Promise.all([
    db.query(`SELECT * FROM audit_log WHERE ${where} ORDER BY seq DESC LIMIT $6 OFFSET $7`, [...args, q.limit, q.offset]),
    db.query(`SELECT count(*)::int AS n FROM audit_log WHERE ${where}`, args),
  ]);
  return { total: n, offset: q.offset, limit: q.limit, entries: rows.map(present) };
});

app.post('/api/jisr/audit/verify', {
  schema: { tags: ['audit'], summary: 'Recompute the whole hash chain and report the first broken link (admin)', security: [{ session: [] }] },
}, async (req) => {
  await requireSession(req, ['admin']);
  return verifyChain();
});

app.post('/api/jisr/audit/tamper-demo', {
  schema: {
    tags: ['audit'], security: [{ session: [] }],
    summary: 'Simulate an insider editing or deleting one audit entry and show that verification catches it (admin)',
    description: 'The edit is made on an exact copy of the whole chain (Jisr itself may only read and append the real log), then the same verification runs on the copy. The real log is never changed.',
    body: { type: 'object', properties: { kind: { type: 'string', enum: ['modify', 'delete'], default: 'modify' }, seq: { type: 'integer', minimum: 1 } } },
  },
}, async (req) => {
  await requireSession(req, ['admin']);
  const { kind = 'modify', seq } = (req.body ?? {}) as { kind?: 'modify' | 'delete'; seq?: number };
  // Jisr can no longer change its own log (it runs as jisr_app: read and append only). So the insider's edit
  // is made on an exact copy of the whole chain, read in one consistent snapshot, and the SAME verification
  // runs over the copy. The real log is never touched.
  const client = await db.connect();
  let rows: any[];
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    rows = (await client.query('SELECT * FROM audit_log ORDER BY seq')).rows;
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  const pool = [...rows].reverse();
  const target = seq ? rows.find((r) => Number(r.seq) === seq)
    // a recent entry that the edit would really change (not already "self-service / self")
    : pool.filter((r) => r.subject !== null && r.method !== 'EVENT' && (r.purpose !== 'citizen-self-service' || r.on_behalf_of !== 'self'))[3];
  if (!target) throw httpError(404, 'not_found', 'No such audit entry');
  let copy: any[];
  let change: Record<string, unknown>;
  if (kind === 'delete') {
    copy = rows.filter((r) => r !== target);
    change = { action: 'deleted', seq: Number(target.seq), entry: { client: target.client, target: target.target, purpose: target.purpose, subject: target.subject } };
  } else {
    // An insider tries to hide why a record was read.
    copy = rows.map((r) => (r === target ? { ...r, purpose: 'citizen-self-service', on_behalf_of: 'self' } : r));
    change = { action: 'modified', seq: Number(target.seq), field: 'purpose / on_behalf_of', from: `${target.purpose} / ${target.on_behalf_of}`, to: 'citizen-self-service / self' };
  }
  // The verifier pages through "SELECT * FROM audit_log WHERE seq > $1 ORDER BY seq LIMIT 1000": answer it from the copy.
  const onCopy = { query: async (_sql: string, params?: unknown[]) => ({ rows: copy.filter((r) => Number(r.seq) > Number(params?.[0] ?? 0)).slice(0, 1000) }) };
  const during = await verifyChainWith(onCopy);
  const after = await verifyChain();
  return { tamper: change, verification_while_tampered: during, on_copy: true, rolled_back: true, verification_after_rollback: after };
});

app.get('/api/jisr/audit/head', {
  schema: { tags: ['audit'], summary: 'Signed checkpoint of the current chain head (can be published/anchored elsewhere)' },
}, async () => {
  const r = (await db.query('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1')).rows[0];
  const head = { seq: r ? Number(r.seq) : 0, hash: r?.hash ?? GENESIS, at: new Date().toISOString() };
  const signed = await new SignJWT(head).setProtectedHeader({ alg: 'EdDSA', kid: own.kid, typ: 'jisr-checkpoint+jwt' }).setIssuer('jisr').sign(own.key);
  return { ...head, signed };
});

app.get('/api/jisr/members', {
  schema: { tags: ['transparency'], summary: 'Registered Jisr members and their public keys' },
}, async () => ({ members: Object.values(trustList()) }));

app.get('/api/jisr/rules', {
  schema: { tags: ['transparency'], summary: 'The access policy: who may ask whom for what, and why' },
}, async () => {
  const { rows } = await db.query('SELECT client, target, method, path_pattern, purposes, requires_consent, description FROM access_rules ORDER BY id');
  return { rules: rows.map((r) => ({ ...r, client_name: nameOf(r.client), target_name: nameOf(r.target) })) };
});

app.get('/api/jisr/events', {
  schema: { tags: ['transparency'], summary: 'Event-bus policy: which member publishes each life event, and who is subscribed' },
}, async () => ({
  event_types: Object.entries(EVENT_TYPES).map(([type, e]) => ({ type, subject: subjectFor(type), publisher: e.publisher, publisher_name: nameOf(e.publisher), label: e.label })),
  subscriptions: SUBSCRIPTIONS.map((s) => ({ ...s, member_name: nameOf(s.member) })),
}));

// ---------------- Event bus operator ----------------
// Jisr creates the stream and every durable consumer from event-policy.ts, then audits every event.
(async () => {
  const nc = await bus();
  for (;;) {
    try {
      const jsm = await nc.jetstreamManager();
      const stream = { name: STREAM, subjects: [`${SUBJECT_ROOT}.>`], storage: StorageType.File, retention: RetentionPolicy.Limits, max_age: nanos(30 * 86_400_000), duplicate_window: nanos(10 * 60_000) };
      try { await jsm.streams.info(STREAM); await jsm.streams.update(STREAM, stream); } catch { await jsm.streams.add(stream); }
      for (const s of SUBSCRIPTIONS) {
        const config = { durable_name: s.consumer, ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All, max_deliver: 20, ack_wait: nanos(30_000), filter_subjects: s.events.map(subjectFor) };
        try { await jsm.consumers.info(STREAM, s.consumer); await jsm.consumers.update(STREAM, s.consumer, config); } catch { await jsm.consumers.add(STREAM, config); }
      }
      app.log.info(`event bus ready: stream ${STREAM}, ${SUBSCRIPTIONS.length} consumers`);
      break;
    } catch (e) {
      app.log.warn(`event bus setup failed (${(e as Error).message}); retrying`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const actorOf = (d: any) => (typeof d?.actor === 'string' && /^(employee|delegate):[\w.-]{1,40}$/.test(d.actor) ? d.actor : null);
  onEvents('jisr-audit', {
    '*': async (e) => {
      // One audit entry per person involved, so it shows in each person's "who accessed my data".
      const people = e.subjects.length ? e.subjects : [null];
      for (const [i, subject] of people.entries()) {
        const request_id = `evt:${e.id}:${i}`;
        const exists = await db.query('SELECT 1 FROM audit_log WHERE request_id = $1', [request_id]);
        if (exists.rowCount) continue;
        await appendAudit({
          request_id, ts: e.at, client: e.publisher, target: 'bus', method: 'EVENT', path: e.type, purpose: 'life-event',
          // Events caused by a staff member name them (e.g. "employee:ADM-0001"), like exchange requests do.
          subject, consent_id: null, on_behalf_of: actorOf(e.data), decision: 'allow', reason: null, status: null,
        }, null);
      }
    },
  });
})();

// Housekeeping: drop expired replay-protection ids.
setInterval(() => { db.query('DELETE FROM seen_jti WHERE expires_at < now()').catch(() => {}); }, 60_000).unref();

await start(app);
