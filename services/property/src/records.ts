// Property & Vehicles Authority — record maintenance by Authority staff ("Manage citizen"): register a
// vehicle, renew its registration, transfer it to a new owner, deregister it; add, correct or remove a
// property deed. Through Jisr only, with a Mithaq-signed staff token. Every change is logged here
// (record_changes), in Jisr's audit chain, and announced on the bus to everyone involved.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { Db } from '#shared/db.ts';
import { tx } from '#shared/db.ts';
import { httpError } from '#shared/http.ts';
import { jisrCall, requireJisr } from '#shared/jisr.ts';
import { randomId } from '#shared/crypto.ts';
import { emitEvent } from '#shared/events.ts';
import { ageOn, CITIES, DISTRICTS, isValidNationalId } from '#shared/seed.ts';
import { PLATE_LETTERS } from '#shared/seed-ministries.ts';
import { failIf, ID_SCHEMA, idx, PROPERTY_TYPES, recordParams, requireRecordStaff, VEHICLE_COLORS, VEHICLE_MAKES, type Problem } from '#shared/records.ts';

const AUD = 'property';
const SCOPE = 'records.property';
const PLATE = { type: 'string', minLength: 3, maxLength: 20, pattern: '^[\\p{L}\\p{N} ]+$' } as const;
const DEED = { type: 'string', pattern: '^DEED-[A-Za-z0-9-]{1,30}$' } as const;
const iso = (d: any) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
export const RENEWAL_FEE = 150;
export const RENEW_WINDOW_DAYS = 60;
const daysLeft = (expiry: string) => Math.floor((new Date(`${expiry}T00:00:00Z`).getTime() - Date.now()) / 86_400_000);
const vStatus = (expiry: string) => { const d = daysLeft(expiry); return { status: d < 0 ? 'expired' : d <= 30 ? 'expiring_soon' : 'valid', days_left: d }; };
const propertyBody = {
  type: 'object', additionalProperties: false, required: ['type_index', 'city_index', 'district_index', 'area_m2', 'share_percent'],
  properties: {
    type_index: idx(PROPERTY_TYPES), city_index: idx(CITIES), district_index: idx(DISTRICTS),
    area_m2: { type: 'integer', minimum: 10, maximum: 100_000 }, share_percent: { type: 'integer', minimum: 1, maximum: 100 },
  },
} as const;

async function read(q: Db | PoolClient, id: string) {
  const { rows: v } = await q.query('SELECT plate, make, model, year, color, registration_expiry FROM vehicles WHERE owner_id = $1 AND deregistered_at IS NULL ORDER BY year DESC, plate', [id]);
  const { rows: d } = await q.query('SELECT deed_no, type, city, district, area_m2, share_percent FROM properties WHERE owner_id = $1 ORDER BY deed_no', [id]);
  const { rows: changes } = await q.query('SELECT action, detail, actor, at FROM record_changes WHERE national_id = $1 ORDER BY id DESC LIMIT 20', [id]);
  const ix = (list: { en: string }[], x: any) => list.findIndex((y) => y.en === x?.en);
  return {
    national_id: id,
    vehicles: v.map((x) => ({ ...x, registration_expiry: iso(x.registration_expiry), ...vStatus(iso(x.registration_expiry)), renewable: daysLeft(iso(x.registration_expiry)) <= RENEW_WINDOW_DAYS })),
    properties: d.map((x) => ({ ...x, type_index: ix(PROPERTY_TYPES, x.type), city_index: ix(CITIES, x.city), district_index: ix(DISTRICTS, x.district) })),
    changes,
  };
}

export function registerRecords(app: FastifyInstance, db: Db): void {
  const tags = ['record maintenance (via Jisr only)'];
  const sec = [{ jisr: [] }];
  const staff = (req: any, id: string) => { const ctx = requireJisr(req); return requireRecordStaff(ctx, AUD, SCOPE, id).then((actor) => ({ actor, requestId: ctx.requestId })); };
  const log = (c: PoolClient, id: string, action: string, detail: unknown, actor: string, requestId: string) =>
    c.query('INSERT INTO record_changes (national_id, action, detail, actor, jisr_request_id) VALUES ($1,$2,$3,$4,$5)', [id, action, detail, actor, requestId]);
  const ownVehicle = async (c: PoolClient, id: string, plate: string) => {
    const v = (await c.query('SELECT * FROM vehicles WHERE plate = $1 AND owner_id = $2 AND deregistered_at IS NULL FOR UPDATE', [plate, id])).rows[0];
    if (!v) throw httpError(404, 'not_found', 'No such vehicle registered to this person');
    return v;
  };

  app.get('/x/records/persons/:id', { schema: { tags, security: sec, summary: 'Vehicles, property deeds and recent changes', params: recordParams() } }, async (req) => {
    const { id } = req.params as { id: string };
    await staff(req, id);
    return read(db, id);
  });

  // ---- Vehicles ----
  app.post('/x/records/persons/:id/vehicles', {
    schema: {
      tags, security: sec, summary: 'Register a vehicle to this person (a plate is allocated; valid for one year)', params: recordParams(),
      body: { type: 'object', additionalProperties: false, required: ['make_index', 'model_index', 'year', 'color_index'], properties: {
        make_index: idx(VEHICLE_MAKES), model_index: { type: 'integer', minimum: 0, maximum: 9 }, year: { type: 'integer', minimum: 1950, maximum: 2100 }, color_index: idx(VEHICLE_COLORS) } },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { actor, requestId } = await staff(req, id);
    const b = req.body as { make_index: number; model_index: number; year: number; color_index: number };
    const make = VEHICLE_MAKES[b.make_index]!;
    const problems: Problem[] = [];
    if (b.model_index >= make.models.length) problems.push({ field: 'model_index', code: 'not_this_make' });
    if (b.year > new Date().getUTCFullYear() + 1) problems.push({ field: 'year', code: 'in_future' });
    failIf(problems);
    const plate = await tx(db, async (c) => {
      let p = '';
      for (let i = 0; i < 20 && !p; i++) {
        const cand = `${PLATE_LETTERS[Math.floor(Math.random() * PLATE_LETTERS.length)]} ${1000 + Math.floor(Math.random() * 9000)}`;
        if (!(await c.query('SELECT 1 FROM vehicles WHERE plate = $1', [cand])).rowCount) p = cand;
      }
      if (!p) throw httpError(503, 'no_plate', 'No free plate number, try again');
      const { rows: [v] } = await c.query(
        `INSERT INTO vehicles (plate, owner_id, make, model, year, color, registration_expiry) VALUES ($1,$2,$3,$4,$5,$6,(current_date + interval '1 year')::date) RETURNING registration_expiry`,
        [p, id, make.make, make.models[b.model_index], b.year, VEHICLE_COLORS[b.color_index]]);
      const detail = { plate: p, make: make.make, model: make.models[b.model_index], year: b.year, registration_expiry: iso(v.registration_expiry) };
      await log(c, id, 'vehicle.registered', detail, actor, requestId);
      await emitEvent(c, 'property.vehicle.registered', { subjects: [id], correlationId: requestId, data: { actor, owner_id: id, ...detail } });
      return p;
    });
    reply.status(201);
    return { ...(await read(db, id)), plate };
  });

  app.post('/x/records/persons/:id/vehicles/:plate/renewal', {
    schema: { tags, security: sec, summary: `Renew a registration for one year (from ${RENEW_WINDOW_DAYS} days before expiry; fee simulated)`, params: recordParams({ plate: PLATE }) },
  }, async (req) => {
    const { id, plate } = req.params as { id: string; plate: string };
    const { actor, requestId } = await staff(req, id);
    await tx(db, async (c) => {
      const v = await ownVehicle(c, id, plate);
      const left = daysLeft(iso(v.registration_expiry));
      if (left > RENEW_WINDOW_DAYS) throw httpError(409, 'too_early', `Registrations can be renewed from ${RENEW_WINDOW_DAYS} days before expiry`, { days_left: left });
      const { rows: [u] } = await c.query(
        `UPDATE vehicles SET registration_expiry = (GREATEST(registration_expiry, current_date) + interval '1 year')::date WHERE plate = $1 RETURNING registration_expiry`, [plate]);
      const rid = `RN-${randomId(6)}`;
      await c.query('INSERT INTO renewals (id, plate, owner_id, renewed_by, on_behalf_of, delegation_id, old_expiry, new_expiry, fee) VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8)',
        [rid, plate, id, actor.replace('employee:', ''), actor, v.registration_expiry, u.registration_expiry, RENEWAL_FEE]);
      await log(c, id, 'vehicle.renewed', { plate, old_expiry: iso(v.registration_expiry), new_expiry: iso(u.registration_expiry) }, actor, requestId);
      await emitEvent(c, 'property.vehicle.renewed', { subjects: [id], correlationId: requestId, data: {
        plate, make: v.make, model: v.model, new_expiry: iso(u.registration_expiry), renewed_by: actor.replace('employee:', ''), on_behalf_of: actor, via: 'records', actor, fee: RENEWAL_FEE } });
    });
    return read(db, id);
  });

  app.post('/x/records/persons/:id/vehicles/:plate/transfer', {
    schema: {
      tags, security: sec, summary: 'Transfer a vehicle to a new owner (the Civil Registry confirms the new owner exists, is alive and is an adult)', params: recordParams({ plate: PLATE }),
      body: { type: 'object', additionalProperties: false, required: ['new_owner_id'], properties: { new_owner_id: ID_SCHEMA } },
    },
  }, async (req) => {
    const { id, plate } = req.params as { id: string; plate: string };
    const { actor, requestId } = await staff(req, id);
    const { new_owner_id } = req.body as { new_owner_id: string };
    failIf(!isValidNationalId(new_owner_id) ? [{ field: 'new_owner_id', code: 'invalid_id' }] : new_owner_id === id ? [{ field: 'new_owner_id', code: 'same_person' }] : []);
    // The new owner is checked at the source (audited in the new owner's "who accessed my data").
    let owner: any;
    try {
      owner = await jisrCall({ target: 'civil-registry', method: 'GET', path: `/x/persons/${new_owner_id}`, purpose: 'ownership-transfer', subject: new_owner_id, onBehalfOf: actor });
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.status === 404) failIf([{ field: 'new_owner_id', code: 'not_found' }]);
      throw e;
    }
    if (owner.status !== 'alive' || ageOn(owner.birth_date) < 18) failIf([{ field: 'new_owner_id', code: 'not_eligible' }], 'The new owner must be a living adult');
    await tx(db, async (c) => {
      const v = await ownVehicle(c, id, plate);
      await c.query('UPDATE vehicles SET owner_id = $2 WHERE plate = $1', [plate, new_owner_id]);
      await c.query('INSERT INTO transfers (plate, from_id, to_id, actor, jisr_request_id) VALUES ($1,$2,$3,$4,$5)', [plate, id, new_owner_id, actor, requestId]);
      const detail = { plate, make: v.make, model: v.model, from_id: id, to_id: new_owner_id };
      await log(c, id, 'vehicle.transferred_out', detail, actor, requestId);
      await log(c, new_owner_id, 'vehicle.transferred_in', detail, actor, requestId);
      await emitEvent(c, 'property.vehicle.transferred', { subjects: [id, new_owner_id], correlationId: requestId, data: { actor, ...detail } });
    });
    return read(db, id);
  });

  app.delete('/x/records/persons/:id/vehicles/:plate', {
    schema: { tags, security: sec, summary: 'Deregister a vehicle (scrapped or exported); its history is kept', params: recordParams({ plate: PLATE }) },
  }, async (req) => {
    const { id, plate } = req.params as { id: string; plate: string };
    const { actor, requestId } = await staff(req, id);
    await tx(db, async (c) => {
      const v = await ownVehicle(c, id, plate);
      await c.query('UPDATE vehicles SET deregistered_at = now() WHERE plate = $1', [plate]);
      await log(c, id, 'vehicle.deregistered', { plate, make: v.make, model: v.model }, actor, requestId);
      await emitEvent(c, 'property.record.changed', { subjects: [id], correlationId: requestId, data: { actor, action: 'vehicle.deregistered', plate, make: v.make, model: v.model } });
    });
    return read(db, id);
  });

  // ---- Property deeds ----
  const deedRow = (b: any) => [PROPERTY_TYPES[b.type_index], CITIES[b.city_index], DISTRICTS[b.district_index], b.area_m2, b.share_percent];
  const deedEvent = (c: PoolClient, id: string, action: string, deed: string, type: unknown, actor: string, requestId: string) =>
    emitEvent(c, 'property.record.changed', { subjects: [id], correlationId: requestId, data: { actor, action, deed_no: deed, type } });

  app.post('/x/records/persons/:id/properties', { schema: { tags, security: sec, summary: 'Record a property deed for this person', params: recordParams(), body: propertyBody } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { actor, requestId } = await staff(req, id);
    const b = req.body as any;
    const deed = `DEED-${randomId(6).replace(/[^A-Za-z0-9]/g, '')}`;
    await tx(db, async (c) => {
      await c.query('INSERT INTO properties (deed_no, owner_id, type, city, district, area_m2, share_percent) VALUES ($1,$2,$3,$4,$5,$6,$7)', [deed, id, ...deedRow(b)]);
      await log(c, id, 'property.added', { deed_no: deed, type: PROPERTY_TYPES[b.type_index], area_m2: b.area_m2, share_percent: b.share_percent }, actor, requestId);
      await deedEvent(c, id, 'property.added', deed, PROPERTY_TYPES[b.type_index], actor, requestId);
    });
    reply.status(201);
    return read(db, id);
  });

  app.put('/x/records/persons/:id/properties/:deed', { schema: { tags, security: sec, summary: 'Correct a property deed', params: recordParams({ deed: DEED }), body: propertyBody } }, async (req) => {
    const { id, deed } = req.params as { id: string; deed: string };
    const { actor, requestId } = await staff(req, id);
    const b = req.body as any;
    await tx(db, async (c) => {
      const old = (await c.query('SELECT type, area_m2, share_percent FROM properties WHERE deed_no = $1 AND owner_id = $2 FOR UPDATE', [deed, id])).rows[0];
      if (!old) throw httpError(404, 'not_found', 'No such deed for this person');
      await c.query('UPDATE properties SET type=$3, city=$4, district=$5, area_m2=$6, share_percent=$7 WHERE deed_no=$1 AND owner_id=$2', [deed, id, ...deedRow(b)]);
      await log(c, id, 'property.updated', { deed_no: deed, before: old, after: { type: PROPERTY_TYPES[b.type_index], area_m2: b.area_m2, share_percent: b.share_percent } }, actor, requestId);
      await deedEvent(c, id, 'property.updated', deed, PROPERTY_TYPES[b.type_index], actor, requestId);
    });
    return read(db, id);
  });

  app.delete('/x/records/persons/:id/properties/:deed', { schema: { tags, security: sec, summary: 'Remove a property deed (sold or recorded in error)', params: recordParams({ deed: DEED }) } }, async (req) => {
    const { id, deed } = req.params as { id: string; deed: string };
    const { actor, requestId } = await staff(req, id);
    await tx(db, async (c) => {
      const old = (await c.query('DELETE FROM properties WHERE deed_no = $1 AND owner_id = $2 RETURNING type', [deed, id])).rows[0];
      if (!old) throw httpError(404, 'not_found', 'No such deed for this person');
      await log(c, id, 'property.removed', { deed_no: deed, type: old.type }, actor, requestId);
      await deedEvent(c, id, 'property.removed', deed, old.type, actor, requestId);
    });
    return read(db, id);
  });
}
