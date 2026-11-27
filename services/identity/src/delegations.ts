// Delegations: a citizen authorises another adult to do specific things for them (e.g. Saleh lets his
// son Omar renew his car registration). The mandate is signed with the GRANTOR'S own key; every use
// mints a short-lived act-as token that Jisr and the target service both verify.
import { CompactSign } from 'jose';
import type { FastifyInstance } from 'fastify';
import type { Db } from '#shared/db.ts';
import { tx } from '#shared/db.ts';
import { httpError } from '#shared/http.ts';
import { jisrCall } from '#shared/jisr.ts';
import { randomId, loadOwnKey } from '#shared/crypto.ts';
import { requireSession, type Session } from '#shared/session.ts';
import { issueActToken, delegateTag } from '#shared/delegation.ts';
import { emitEvent } from '#shared/events.ts';
import { DELEGATION_SCOPES, type Bilingual } from '#shared/catalog.ts';
import { isValidNationalId, ageOn } from '#shared/seed.ts';
import { citizenKey, fullName, isDeviceBound, readCivilRecord, type CivilRecord } from './citizen.ts';
import { isStrongRecentSignIn } from './apps.ts';

const RECENT_AUTH_SECONDS = 15 * 60;
const MAX_ACTIVE = 10;

const statusOf = (d: any) => (d.revoked_at ? 'revoked' : new Date(d.valid_until).getTime() < Date.now() ? 'expired' : 'active');

const view = (d: any) => ({
  id: d.id, grantor: d.grantor, delegate: d.delegate, grantor_name: d.grantor_name, delegate_name: d.delegate_name,
  scopes: d.scopes.map((sc: string) => ({ scope: sc, label: DELEGATION_SCOPES[sc]?.label ?? { ar: sc, en: sc } })),
  valid_until: d.valid_until, created_at: d.created_at, created_via: d.created_via, created_by: d.created_by,
  revoked_at: d.revoked_at, revoked_by: d.revoked_by, status: statusOf(d), mandate_jws: d.mandate_jws,
});

/** Display name of the delegate as the grantor may see it: full name for family, otherwise masked. */
function delegateDisplay(grantor: CivilRecord, delegate: CivilRecord): Bilingual {
  if (grantor.family.some((f) => f.national_id === delegate.national_id)) return fullName(delegate);
  return { ar: `${delegate.given_name.ar} ${delegate.family_name.ar.slice(0, 2)}…`, en: `${delegate.given_name.en} ${delegate.family_name.en.slice(0, 4)}…` };
}

export interface GrantInput { grantor: string; grantorName: Bilingual; delegate: string; scopes: string[]; days: number; via: 'portal' | 'service-centre'; employee?: string }

export interface PreparedDelegation { id: string; mandate: Record<string, unknown>; delegateName: Bilingual; validUntil: string }

/** Validates a delegation request and builds the mandate to be signed (nothing is stored yet). */
export async function prepareDelegation(db: Db, g: GrantInput): Promise<PreparedDelegation> {
  if (!isValidNationalId(g.delegate)) throw httpError(400, 'bad_national_id', 'That is not a valid national ID number');
  if (g.delegate === g.grantor) throw httpError(400, 'self_delegation', 'You cannot delegate to yourself');
  const unknown = g.scopes.filter((s) => !DELEGATION_SCOPES[s]);
  if (!g.scopes.length || unknown.length) throw httpError(400, 'bad_scopes', 'Choose at least one valid permission');
  if (!(await db.query("SELECT 1 FROM accounts WHERE subject = $1 AND kind = 'citizen'", [g.delegate])).rowCount) {
    throw httpError(404, 'delegate_not_found', 'No citizen account with that national ID');
  }
  const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM delegations WHERE grantor = $1 AND revoked_at IS NULL AND valid_until > now()', [g.grantor]);
  if (n >= MAX_ACTIVE) throw httpError(409, 'too_many', `At most ${MAX_ACTIVE} active delegations`);

  // Eligibility from the authoritative register (each read audited for the person concerned).
  const delegateRec = await readCivilRecord(g.delegate, 'delegation-check');
  if (delegateRec.status !== 'alive' || ageOn(delegateRec.birth_date) < 18) throw httpError(422, 'delegate_not_eligible', 'A delegate must be a living adult (18 or older)');
  const grantorRec = await readCivilRecord(g.grantor, 'delegation-check');
  const delegateName = delegateDisplay(grantorRec, delegateRec);

  const id = `DG-${randomId(6)}`;
  const validUntil = new Date(Date.now() + g.days * 86_400_000).toISOString();
  const mandate = {
    typ: 'sarab-delegation-mandate', id, grantor: g.grantor, grantor_name: g.grantorName, delegate: g.delegate, delegate_name: delegateName,
    scopes: g.scopes, valid_until: validUntil, signed_at: new Date().toISOString(), via: g.via, ...(g.employee ? { recorded_by_employee: g.employee } : {}),
  };
  return { id, mandate, delegateName, validUntil };
}

/** Stores a delegation whose mandate has been signed (by the grantor's key — cloud or device — or attested by Mithaq). */
export async function storeDelegation(db: Db, p: PreparedDelegation, g: GrantInput, jws: string) {
  return tx(db, async (c) => {
    const { rows: [row] } = await c.query(
      `INSERT INTO delegations (id, grantor, delegate, grantor_name, delegate_name, scopes, valid_until, mandate_jws, created_via, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [p.id, g.grantor, g.delegate, g.grantorName, p.delegateName, g.scopes, p.validUntil, jws, g.via, g.employee ?? null],
    );
    await emitEvent(c, 'mithaq.delegation.granted', { subjects: [g.grantor, g.delegate], correlationId: p.id, data: { delegation_id: p.id, via: g.via } });
    return view(row);
  });
}

/** Creates a delegation signed server-side (cloud key), or attested by Mithaq for a device-key citizen at a service centre. */
export async function createDelegation(db: Db, g: GrantInput) {
  const p = await prepareDelegation(db, g);
  let jws: string;
  if (await isDeviceBound(db, g.grantor)) {
    if (g.via !== 'service-centre') throw httpError(409, 'device_signature_required', 'Your key is on your device: sign the mandate there');
    // The citizen confirmed in person; their private key is not available, so Mithaq attests instead.
    const own = await loadOwnKey();
    jws = await new CompactSign(new TextEncoder().encode(JSON.stringify({ ...p.mandate, attested_by: 'mithaq', attestation: 'grantor confirmed in person at a service centre (device-held key not present)' })))
      .setProtectedHeader({ alg: 'EdDSA', kid: own.kid }).sign(own.key);
  } else {
    const key = await citizenKey(db, g.grantor);
    jws = await new CompactSign(new TextEncoder().encode(JSON.stringify(p.mandate))).setProtectedHeader({ alg: 'EdDSA', kid: key.kid }).sign(key.privateKey);
  }
  return storeDelegation(db, p, g, jws);
}

export async function revokeDelegation(db: Db, id: string, by: string, allowed: (d: any) => boolean) {
  return tx(db, async (c) => {
    const d = (await c.query('SELECT * FROM delegations WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!d || !allowed(d)) throw httpError(404, 'not_found', 'No such delegation');
    if (d.revoked_at) return view(d);
    const { rows: [row] } = await c.query('UPDATE delegations SET revoked_at = now(), revoked_by = $2 WHERE id = $1 RETURNING *', [id, by]);
    await emitEvent(c, 'mithaq.delegation.revoked', { subjects: [d.grantor, d.delegate], correlationId: id, data: { delegation_id: id } });
    return view(row);
  });
}

/** The active delegation the signed-in delegate wants to use, checked for scope. */
async function useDelegation(db: Db, s: Session, id: string, scope: string | string[]) {
  const d = (await db.query('SELECT * FROM delegations WHERE id = $1 AND delegate = $2', [id, s.sub])).rows[0];
  if (!d) throw httpError(404, 'not_found', 'No such delegation');
  if (statusOf(d) !== 'active') throw httpError(403, 'delegation_inactive', `This delegation is ${statusOf(d)}`);
  const need = Array.isArray(scope) ? scope : [scope];
  const granted = need.filter((x) => d.scopes.includes(x));
  if (!granted.length) throw httpError(403, 'scope_missing', 'This delegation does not cover that');
  return d;
}

const delegationBody = {
  type: 'object', required: ['delegate_id', 'scopes', 'days'],
  properties: {
    delegate_id: { type: 'string', maxLength: 10 },
    scopes: { type: 'array', items: { type: 'string', enum: Object.keys(DELEGATION_SCOPES) }, minItems: 1, uniqueItems: true },
    days: { type: 'integer', minimum: 1, maximum: 365 },
  },
} as const;

export function registerDelegations(app: FastifyInstance, db: Db): void {
  app.get('/api/identity/delegation-scopes', { schema: { tags: ['delegation'], summary: 'What can be delegated' } }, async () => ({
    scopes: Object.entries(DELEGATION_SCOPES).map(([scope, v]) => ({ scope, ...v })),
  }));

  app.get('/api/identity/me/delegations', {
    schema: { tags: ['delegation'], security: [{ session: [] }], summary: 'Delegations I granted and delegations I hold' },
  }, async (req) => {
    const s = await requireSession(req, ['citizen']);
    const { rows: granted } = await db.query('SELECT * FROM delegations WHERE grantor = $1 ORDER BY created_at DESC', [s.sub]);
    const { rows: received } = await db.query('SELECT * FROM delegations WHERE delegate = $1 ORDER BY created_at DESC', [s.sub]);
    return { granted: granted.map(view), received: received.map(view) };
  });

  app.post('/api/identity/me/delegations', {
    schema: { tags: ['delegation'], security: [{ session: [] }], summary: 'Authorise another adult to act for me (needs a sign-in within 15 minutes; the mandate is signed with my key)', body: delegationBody },
  }, async (req) => {
    const s = await requireSession(req, ['citizen']);
    if (!isStrongRecentSignIn(s, RECENT_AUTH_SECONDS)) throw httpError(401, 'reauth_required', 'For your security, sign in again before creating a delegation');
    const b = req.body as { delegate_id: string; scopes: string[]; days: number };
    return createDelegation(db, { grantor: s.sub, grantorName: s.name, delegate: b.delegate_id.trim(), scopes: b.scopes, days: b.days, via: 'portal' });
  });

  app.delete('/api/identity/me/delegations/:id', {
    schema: { tags: ['delegation'], security: [{ session: [] }], summary: 'Revoke a delegation I granted, or decline one I hold — effective immediately' },
  }, async (req) => {
    const s = await requireSession(req, ['citizen']);
    const { id } = req.params as { id: string };
    return revokeDelegation(db, id, s.sub, (d) => d.grantor === s.sub || d.delegate === s.sub);
  });

  // ---- Acting for someone ----

  app.get('/api/identity/acting/:id/assets', {
    schema: { tags: ['delegation'], security: [{ session: [] }], summary: 'As a delegate: the vehicles (and, with assets.view, properties) of the person I represent' },
  }, async (req) => {
    const s = await requireSession(req, ['citizen']);
    const d = await useDelegation(db, s, (req.params as { id: string }).id, ['assets.view', 'vehicles.renew']);
    const act = await issueActToken({ grantor: d.grantor, delegate: s.sub, scopes: d.scopes, delegationId: d.id, audience: 'property' });
    const assets = await jisrCall({ target: 'property', method: 'GET', path: `/x/persons/${d.grantor}/assets`, purpose: 'delegated-service', subject: d.grantor, onBehalfOf: delegateTag(s.sub), act });
    return { delegation: view(d), assets };
  });

  app.post('/api/identity/acting/:id/vehicles/:plate/renew', {
    schema: { tags: ['delegation'], security: [{ session: [] }], summary: 'As a delegate: renew a vehicle registration for the person I represent' },
  }, async (req) => {
    const s = await requireSession(req, ['citizen']);
    const { id, plate } = req.params as { id: string; plate: string };
    const d = await useDelegation(db, s, id, 'vehicles.renew');
    const act = await issueActToken({ grantor: d.grantor, delegate: s.sub, scopes: d.scopes, delegationId: d.id, audience: 'property' });
    return jisrCall({ target: 'property', method: 'POST', path: `/x/vehicles/${encodeURIComponent(plate)}/renewals`, purpose: 'delegated-service', subject: d.grantor, onBehalfOf: delegateTag(s.sub), act });
  });

  // The owner renewing their own vehicle.
  app.post('/api/identity/me/vehicles/:plate/renew', {
    schema: { tags: ['citizen'], security: [{ session: [] }], summary: 'Renew my own vehicle registration' },
  }, async (req) => {
    const s = await requireSession(req, ['citizen']);
    const { plate } = req.params as { plate: string };
    return jisrCall({ target: 'property', method: 'POST', path: `/x/vehicles/${encodeURIComponent(plate)}/renewals`, purpose: 'citizen-self-service', subject: s.sub, onBehalfOf: 'self' });
  });
}
