// Property & Vehicles Authority — vehicle registrations and property deeds. Reachable only through Jisr.
import { createService, start, httpError, S } from '#shared/http.ts';
import { createDb, migrate, tx } from '#shared/db.ts';
import { installJisrGuard, requireJisr, type JisrContext } from '#shared/jisr.ts';
import { randomId } from '#shared/crypto.ts';
import { verifyActToken, actorTag } from '#shared/delegation.ts';
import { initEvents, emitEvent, startOutboxPump } from '#shared/events.ts';
import { population } from '#shared/seed.ts';
import { assetsFor } from '#shared/seed-ministries.ts';
import { registerRecords } from './records.ts';

const db = createDb();
await migrate(db, new URL('./schema.sql', import.meta.url));
await initEvents(db);

const { rows: [{ n }] } = await db.query('SELECT (SELECT count(*) FROM vehicles) + (SELECT count(*) FROM properties) AS n');
if (Number(n) === 0) {
  await tx(db, async (c) => {
    for (const p of population()) {
      const { vehicles, properties } = assetsFor(p);
      for (const v of vehicles) {
        await c.query('INSERT INTO vehicles (plate, owner_id, make, model, year, color, registration_expiry) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
          [v.plate, p.national_id, v.make, v.model, v.year, v.color, v.registration_expiry]);
      }
      for (const d of properties) {
        await c.query('INSERT INTO properties (deed_no, owner_id, type, city, district, area_m2, share_percent) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
          [d.deed_no, p.national_id, d.type, d.city, d.district, d.area_m2, d.share_percent]);
      }
    }
  });
}

const app = await createService({
  prefix: 'property',
  title: 'Property & Vehicles Authority',
  description: 'Vehicle registrations and property deeds. Reachable ONLY through Jisr.',
});
await installJisrGuard(app);

const status = (expiry: string) => {
  const days = Math.floor((new Date(`${expiry}T00:00:00Z`).getTime() - Date.now()) / 86_400_000);
  return { status: days < 0 ? 'expired' : days <= 30 ? 'expiring_soon' : 'valid', days_left: days };
};

app.get('/x/persons/:id/assets', {
  schema: {
    tags: ['exchange (via Jisr only)'], summary: 'Vehicles and properties registered to a person', security: [{ jisr: [] }],
    params: { type: 'object', properties: { id: { type: 'string', pattern: '^1\\d{9}$' } }, required: ['id'] },
    response: {
      200: {
        type: 'object',
        properties: {
          national_id: { type: 'string' },
          vehicles: { type: 'array', items: { type: 'object', properties: {
            plate: { type: 'string' }, make: { type: 'string' }, model: { type: 'string' }, year: { type: 'integer' }, color: S.bilingual,
            registration_expiry: { type: 'string', format: 'date' }, status: { type: 'string', enum: ['valid', 'expiring_soon', 'expired'] }, days_left: { type: 'integer' } } } },
          properties: { type: 'array', items: { type: 'object', properties: {
            deed_no: { type: 'string' }, type: S.bilingual, city: S.bilingual, district: S.bilingual, area_m2: { type: 'integer' }, share_percent: { type: 'integer' } } } },
        },
      },
    },
  },
}, async (req) => {
  const ctx = requireJisr(req);
  const { id } = req.params as { id: string };
  if (ctx.subject !== id) throw httpError(403, 'subject_mismatch', 'Declared subject does not match the requested person');
  if (ctx.purpose === 'delegated-service' || ctx.purpose === 'assisted-service') {
    const act = await verifyActToken(ctx.act, { subject: id, audience: 'property' });
    if (!act.scope.includes('assets.view') && !act.scope.includes('vehicles.renew')) throw httpError(403, 'mandate_scope', 'The mandate does not cover viewing assets');
    if (!act.scope.includes('assets.view')) {
      // vehicles.renew only: show vehicles, not property deeds.
      const { rows: v } = await db.query('SELECT plate, make, model, year, color, registration_expiry FROM vehicles WHERE owner_id = $1 AND deregistered_at IS NULL ORDER BY year DESC', [id]);
      return { national_id: id, vehicles: v.map((x) => ({ ...x, ...status(x.registration_expiry) })), properties: [] };
    }
  }
  const { rows: v } = await db.query('SELECT plate, make, model, year, color, registration_expiry FROM vehicles WHERE owner_id = $1 AND deregistered_at IS NULL ORDER BY year DESC', [id]);
  const { rows: d } = await db.query('SELECT deed_no, type, city, district, area_m2, share_percent FROM properties WHERE owner_id = $1', [id]);
  return { national_id: id, vehicles: v.map((x) => ({ ...x, ...status(x.registration_expiry) })), properties: d };
});

// ---------------- Phase 3: renew a vehicle registration ----------------

const RENEWAL_FEE = 150;

/** Who is acting, and whether they may: the owner themself, or a delegate with a valid mandate. */
async function actor(ctx: JisrContext, ownerId: string): Promise<{ by: string; onBehalfOf: string; delegationId: string | null }> {
  if (ctx.client !== 'mithaq') throw httpError(403, 'mithaq_only', 'Renewals must come through Mithaq');
  if (ctx.purpose === 'citizen-self-service' && ctx.onBehalfOf === 'self') return { by: ownerId, onBehalfOf: 'self', delegationId: null };
  if (ctx.purpose === 'delegated-service' || ctx.purpose === 'assisted-service') {
    const act = await verifyActToken(ctx.act, { subject: ownerId, audience: 'property', scope: 'vehicles.renew' });
    return { by: act.act.sub, onBehalfOf: actorTag(act.act), delegationId: act.delegation_id };
  }
  throw httpError(403, 'not_allowed', 'Only the owner or their delegate may renew');
}

app.post('/x/vehicles/:plate/renewals', {
  schema: {
    tags: ['exchange (via Jisr only)'], security: [{ jisr: [] }],
    summary: 'Renew a vehicle registration for one year (fee simulated)',
    params: { type: 'object', properties: { plate: { type: 'string', maxLength: 20 } }, required: ['plate'] },
  },
}, async (req) => {
  const ctx = requireJisr(req);
  const { plate } = req.params as { plate: string };
  const v = (await db.query('SELECT * FROM vehicles WHERE plate = $1 AND deregistered_at IS NULL', [plate])).rows[0];
  if (!v || v.owner_id !== ctx.subject) throw httpError(404, 'not_found', 'No such vehicle for this owner');
  const who = await actor(ctx, v.owner_id);
  const st = status(v.registration_expiry);
  if (st.days_left > 60) throw httpError(409, 'too_early', 'Registrations can be renewed from 60 days before expiry', { days_left: st.days_left });
  const id = `RN-${randomId(6)}`;
  const result = await tx(db, async (c) => {
    const { rows: [u] } = await c.query(
      `UPDATE vehicles SET registration_expiry = (GREATEST(registration_expiry, current_date) + interval '1 year')::date
       WHERE plate = $1 RETURNING registration_expiry`, [plate]);
    await c.query(
      'INSERT INTO renewals (id, plate, owner_id, renewed_by, on_behalf_of, delegation_id, old_expiry, new_expiry, fee) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, plate, v.owner_id, who.by, who.onBehalfOf, who.delegationId, v.registration_expiry, u.registration_expiry, RENEWAL_FEE]);
    await emitEvent(c, 'property.vehicle.renewed', {
      subjects: [...new Set([v.owner_id, ...(who.onBehalfOf.startsWith('delegate:') ? [who.by] : [])])], correlationId: id,
      data: { plate, make: v.make, model: v.model, new_expiry: u.registration_expiry, renewed_by: who.by, on_behalf_of: who.onBehalfOf, fee: RENEWAL_FEE },
    });
    return { renewal_id: id, plate, old_expiry: v.registration_expiry, new_expiry: u.registration_expiry, fee: RENEWAL_FEE, ...status(u.registration_expiry) };
  });
  return result;
});
registerRecords(app, db);
startOutboxPump(db);

await start(app);
