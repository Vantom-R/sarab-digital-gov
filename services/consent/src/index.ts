// Idhn — consent service. Private-sector members ask for specific claims; the regulator's
// allow-list is enforced automatically; the citizen approves/denies; consents can be revoked.
import { createService, start, httpError, HttpError, S } from '#shared/http.ts';
import { createDb, migrate, tx } from '#shared/db.ts';
import { randomId, trustList } from '#shared/crypto.ts';
import { installJisrGuard, requireJisr, jisrCall } from '#shared/jisr.ts';
import { requireSession } from '#shared/session.ts';
import { CLAIMS, PURPOSES, SECTOR_POLICIES, claimByName } from '#shared/catalog.ts';

const db = createDb();
await migrate(db, new URL('./schema.sql', import.meta.url));

// Regulator policies are defined in code (catalog.ts) in this prototype and synced on start-up.
for (const p of SECTOR_POLICIES) {
  await db.query(
    `INSERT INTO sector_policies (sector, regulator_ar, regulator_en, title_ar, title_en, allowed_claims, allowed_purposes)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (sector) DO UPDATE SET regulator_ar = EXCLUDED.regulator_ar, regulator_en = EXCLUDED.regulator_en,
       title_ar = EXCLUDED.title_ar, title_en = EXCLUDED.title_en, allowed_claims = EXCLUDED.allowed_claims,
       allowed_purposes = EXCLUDED.allowed_purposes, updated_at = now()`,
    [p.sector, p.regulator.ar, p.regulator.en, p.title.ar, p.title.en, p.allowed_claims, p.allowed_purposes],
  );
}

// Where each private-sector member may send the citizen back to (prevents open redirects).
const RETURN_PREFIX: Record<string, string> = { 'bank-alwaha': '/bank/' };

const app = await createService({
  prefix: 'consent',
  title: 'Idhn — Consent Service',
  description: 'Citizens approve, deny and revoke data-sharing requests. Requests are checked against the sector regulator allow-list before the citizen ever sees them.',
});
await installJisrGuard(app);

const memberName = (id: string) => trustList()[id]?.name ?? { ar: id, en: id };
const claimView = (n: string) => {
  const c = claimByName(n);
  return { name: n, label: c?.label ?? { ar: n, en: n }, description: c?.description ?? { ar: '', en: '' }, derived: !!c?.derived };
};
const policyView = (p: any) => ({
  sector: p.sector,
  regulator: { ar: p.regulator_ar, en: p.regulator_en },
  title: { ar: p.title_ar, en: p.title_en },
  allowed_claims: p.allowed_claims.map(claimView),
  allowed_purposes: p.allowed_purposes,
});

// ---------------- Exchange API (via Jisr) ----------------

app.post('/x/requests', {
  schema: {
    tags: ['exchange (via Jisr only)'], security: [{ jisr: [] }],
    summary: 'A private-sector member asks a citizen for specific claims (regulator allow-list enforced)',
    body: {
      type: 'object', required: ['claims', 'return_url'],
      properties: {
        claims: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
        return_url: { type: 'string', maxLength: 300 },
        validity_days: { type: 'integer', minimum: 1, maximum: 730, default: 365 },
        nonce: { type: 'string', minLength: 16, maxLength: 100, description: 'Phase 6: the nonce the requester will later present, so device-held keys can sign at approval time' },
      },
    },
  },
}, async (req, reply) => {
  const ctx = requireJisr(req);
  const { claims, return_url, validity_days, nonce: reqNonce } = req.body as { claims: string[]; return_url: string; validity_days: number; nonce?: string };
  const member = trustList()[ctx.client];
  if (!member || member.class !== 'COM') throw httpError(403, 'not_private_sector', 'Only private-sector members request consent');
  const prefix = RETURN_PREFIX[ctx.client];
  if (!prefix || !return_url.startsWith(prefix)) throw httpError(400, 'bad_return_url', `return_url must start with ${prefix}`);

  const id = randomId(12);
  const uniqueClaims = [...new Set(claims)];
  const policy = (await db.query('SELECT * FROM sector_policies WHERE sector = $1', [member.sector])).rows[0];
  const insert = (status: string, rejected: string[], reason: string | null) => db.query(
    `INSERT INTO consent_requests (id, client, sector, purpose, claims, return_url, validity_days, status, rejected_claims, reason, nonce, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() + interval '15 minutes')`,
    [id, ctx.client, member.sector, ctx.purpose, uniqueClaims, return_url, validity_days, status, rejected, reason, reqNonce ?? null],
  );

  // Automatic regulator check — before the citizen is involved at all.
  if (!policy) {
    await insert('rejected_by_policy', uniqueClaims, 'No regulator policy for this sector');
    throw httpError(422, 'rejected_by_policy', 'No regulator policy exists for this sector', { request_id: id });
  }
  const notAllowed = uniqueClaims.filter((c) => !policy.allowed_claims.includes(c));
  const purposeOk = policy.allowed_purposes.includes(ctx.purpose);
  if (notAllowed.length || !purposeOk) {
    const reason = notAllowed.length
      ? `Not on the ${policy.regulator_en} allow-list: ${notAllowed.join(', ')}`
      : `Purpose "${ctx.purpose}" is not allowed for sector ${member.sector}`;
    await insert('rejected_by_policy', notAllowed, reason);
    throw httpError(422, 'rejected_by_policy', reason, {
      request_id: id,
      regulator: { ar: policy.regulator_ar, en: policy.regulator_en },
      rejected_claims: notAllowed.map(claimView),
      allowed_claims: policy.allowed_claims,
    });
  }
  await insert('pending', [], null);
  return reply.status(201).send({ request_id: id, consent_url: `/consent/${id}` });
});

app.get('/x/consents/:id/presentation', {
  schema: {
    tags: ['exchange (via Jisr only)'], security: [{ jisr: [] }],
    summary: 'Fetch fresh selective-disclosure proofs (one per issuing authority) for an active consent',
    querystring: { type: 'object', required: ['nonce'], properties: { nonce: { type: 'string', minLength: 8, maxLength: 100 }, request_id: { type: 'string', maxLength: 40, description: 'When given, the consent must answer this request (else nothing is released)' } } },
  },
}, async (req) => {
  const ctx = requireJisr(req);
  const { id } = req.params as { id: string };
  const { nonce, request_id } = req.query as { nonce: string; request_id?: string };
  if (ctx.consentId !== id) throw httpError(403, 'consent_mismatch', 'Declared consent does not match');
  const c = (await db.query('SELECT * FROM consents WHERE id = $1', [id])).rows[0];
  if (!c || c.client !== ctx.client) throw httpError(404, 'consent_not_found', 'No such consent for this client');
  if (request_id && c.request_id !== request_id) throw httpError(403, 'consent_mismatch', 'This consent was given for a different request');
  if (c.status === 'revoked') throw httpError(403, 'consent_revoked', 'The citizen revoked this consent');
  if (new Date(c.valid_until) < new Date()) throw httpError(403, 'consent_expired', 'This consent has expired');

  // request_id lets the requester check the consent answers ITS request (no mixing consents between flows).
  const meta = { id: c.id, request_id: c.request_id, claims: c.claims, granted_at: c.granted_at, valid_until: c.valid_until };
  // Phase 6: presentations built and key-bound on the citizen's DEVICE at approval time. Released once,
  // only for the nonce the requester fixed when it asked.
  if (c.held_presentations) {
    const r = (await db.query('SELECT nonce FROM consent_requests WHERE id = $1', [c.request_id])).rows[0];
    if (!r?.nonce || r.nonce !== nonce) throw httpError(409, 'nonce_mismatch', 'The proof was bound to a different nonce');
    await db.query('UPDATE consents SET held_presentations = NULL, last_used_at = now(), use_count = use_count + 1 WHERE id = $1', [id]);
    return { presentations: c.held_presentations, format: 'dc+sd-jwt', consent: meta, holder: 'device' };
  }
  let out;
  try {
    out = await jisrCall<{ presentations: { credential: string; vct: string; issuer: string; presentation: string }[]; format: string }>({
      target: 'mithaq', method: 'POST', path: '/x/presentations', purpose: 'consent-fulfilment',
      subject: c.subject, consentId: c.id, onBehalfOf: c.client,
      body: { national_id: c.subject, claims: c.claims, audience: c.client, nonce },
    });
  } catch (e) {
    // The citizen's key is on their device: a new proof needs the citizen (like any real wallet).
    if (e instanceof HttpError && e.code === 'device_key') throw httpError(409, 'citizen_presence_required', 'The citizen keeps their key on their device; ask them to confirm again in Mithaq');
    throw e;
  }
  await db.query('UPDATE consents SET last_used_at = now(), use_count = use_count + 1 WHERE id = $1', [id]);
  return { presentations: out.presentations, format: out.format, consent: meta, holder: 'cloud' };
});

// ---------------- Citizen API ----------------

app.get('/api/consent/requests/:id', {
  schema: { tags: ['citizen'], summary: 'What is being requested, by whom and why', security: [{ session: [] }] },
}, async (req) => {
  await requireSession(req, ['citizen']);
  const { id } = req.params as { id: string };
  const r = (await db.query('SELECT *, expires_at < now() AS expired FROM consent_requests WHERE id = $1', [id])).rows[0];
  if (!r) throw httpError(404, 'not_found', 'This request does not exist');
  const policy = (await db.query('SELECT * FROM sector_policies WHERE sector = $1', [r.sector])).rows[0];
  return {
    id: r.id,
    status: r.expired && r.status === 'pending' ? 'expired' : r.status,
    client: { id: r.client, name: memberName(r.client), sector: r.sector },
    purpose: { id: r.purpose, label: PURPOSES[r.purpose] ?? { ar: r.purpose, en: r.purpose } },
    claims: r.claims.map(claimView),
    // Highlight the sensitive items this requester will NOT get (e.g. birth date, exact salary).
    not_requested: CLAIMS.filter((c) => !r.claims.includes(c.name) && ['birth_date', 'address_full', 'marital_status', 'monthly_income'].includes(c.name)).map((c) => claimView(c.name)),
    validity_days: r.validity_days,
    // Phase 6: what a device-held key must bind its presentation to.
    audience: r.client, nonce: r.nonce,
    regulator: policy ? { ar: policy.regulator_ar, en: policy.regulator_en } : null,
    expires_at: r.expires_at,
  };
});

async function decide(req: any, approve: boolean) {
  const s = await requireSession(req, ['citizen']);
  const { id } = req.params as { id: string };
  const consentId = randomId(12);
  // One atomic step claims the pending request: of two decisions arriving at the same moment (even from two
  // different citizens), exactly one wins; the other gets 409 and no consent is created for it.
  return tx(db, async (c) => {
    const r = (await c.query(
      `UPDATE consent_requests SET status = $3, subject = $2, consent_id = $4, decided_at = now()
       WHERE id = $1 AND status = 'pending' AND expires_at > now() RETURNING *`,
      [id, s.sub, approve ? 'approved' : 'denied', approve ? consentId : null])).rows[0];
    if (!r) throw httpError(409, 'not_pending', 'This request is no longer waiting for a decision');
    const sep = r.return_url.includes('?') ? '&' : '?';
    if (!approve) return { status: 'denied', redirect: `${r.return_url}${sep}request=${id}&error=denied` };
    await c.query(
      `INSERT INTO consents (id, request_id, subject, client, purpose, claims, status, valid_until)
       VALUES ($1,$2,$3,$4,$5,$6,'active', now() + make_interval(days => $7))`,
      [consentId, id, s.sub, r.client, r.purpose, r.claims, r.validity_days],
    );
    return { status: 'approved', consent_id: consentId, redirect: `${r.return_url}${sep}request=${id}&consent=${consentId}` };
  });
}

app.post('/api/consent/requests/:id/approve', { schema: { tags: ['citizen'], summary: 'Approve a request', security: [{ session: [] }] } }, (req) => decide(req, true));
app.post('/api/consent/requests/:id/deny', { schema: { tags: ['citizen'], summary: 'Deny a request', security: [{ session: [] }] } }, (req) => decide(req, false));

app.post('/api/consent/consents/:id/presentations', {
  schema: {
    tags: ['citizen'], security: [{ session: [] }],
    summary: 'Phase 6: hand over the presentations my device built (selective disclosure + key binding) for this consent',
    body: {
      type: 'object', required: ['presentations'],
      properties: { presentations: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', required: ['credential', 'vct', 'issuer', 'presentation'],
        properties: { credential: { type: 'string' }, vct: { type: 'string' }, issuer: { type: 'string' }, presentation: { type: 'string', maxLength: 20_000 } } } } },
    },
  },
}, async (req) => {
  const s = await requireSession(req, ['citizen']);
  const { id } = req.params as { id: string };
  const { presentations } = req.body as { presentations: unknown[] };
  const r = await db.query("UPDATE consents SET held_presentations = $3, held_at = now() WHERE id = $1 AND subject = $2 AND status = 'active' RETURNING id", [id, s.sub, JSON.stringify(presentations)]);
  if (!r.rowCount) throw httpError(404, 'not_found', 'No such active consent');
  return { ok: true };
});

app.get('/api/consent/consents/mine', { schema: { tags: ['citizen'], summary: 'My consents (active and revoked)', security: [{ session: [] }] } }, async (req) => {
  const s = await requireSession(req, ['citizen']);
  const { rows } = await db.query('SELECT * FROM consents WHERE subject = $1 ORDER BY granted_at DESC', [s.sub]);
  return {
    consents: rows.map((c) => ({
      id: c.id, status: c.status, client: { id: c.client, name: memberName(c.client) },
      purpose: { id: c.purpose, label: PURPOSES[c.purpose] ?? { ar: c.purpose, en: c.purpose } },
      claims: c.claims.map(claimView), granted_at: c.granted_at, valid_until: c.valid_until,
      revoked_at: c.revoked_at, last_used_at: c.last_used_at, use_count: c.use_count,
    })),
  };
});

app.post('/api/consent/consents/:id/revoke', { schema: { tags: ['citizen'], summary: 'Revoke a consent — future access is refused immediately', security: [{ session: [] }] } }, async (req) => {
  const s = await requireSession(req, ['citizen']);
  const { id } = req.params as { id: string };
  const r = await db.query("UPDATE consents SET status = 'revoked', revoked_at = now() WHERE id = $1 AND subject = $2 AND status = 'active'", [id, s.sub]);
  if (!r.rowCount) throw httpError(404, 'not_found', 'No active consent with this id');
  return { ok: true };
});

// ---------------- Transparency / admin ----------------

app.get('/api/consent/policies', { schema: { tags: ['regulator'], summary: 'Sector allow-lists defined by regulators (public)' } }, async () => {
  const { rows } = await db.query('SELECT * FROM sector_policies ORDER BY sector');
  return { policies: rows.map(policyView) };
});

app.get('/api/consent/requests', {
  schema: { tags: ['regulator'], summary: 'All consent requests, including ones rejected by policy (admin)', security: [{ session: [] }] },
}, async (req) => {
  await requireSession(req, ['admin']);
  const { rows } = await db.query('SELECT id, client, sector, purpose, claims, status, rejected_claims, reason, created_at, decided_at FROM consent_requests ORDER BY created_at DESC LIMIT 200');
  return { requests: rows.map((r) => ({ ...r, client_name: memberName(r.client) })) };
});

await start(app);
