// Ministry of Health — record maintenance by Health staff ("Manage citizen"). Deliberately minimal and
// fake: blood type, allergies, chronic conditions, primary health centre, organ donor, vaccinations.
// Through Jisr only, with a Mithaq-signed staff token for scope records.health (no other client or purpose
// can read health data). Events say only THAT the record changed — never what is in it.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { Db } from '#shared/db.ts';
import { tx } from '#shared/db.ts';
import { httpError } from '#shared/http.ts';
import { jisrCall, requireJisr } from '#shared/jisr.ts';
import { emitEvent, onEvents } from '#shared/events.ts';
import { CITIES } from '#shared/seed.ts';
import { BLOOD_TYPES, CLINICS, failIf, HEALTH_ALLERGIES, HEALTH_CONDITIONS, idx, isDate, recordParams, requireRecordStaff, todayIso, VACCINES } from '#shared/records.ts';

const AUD = 'health';
const SCOPE = 'records.health';
const iso = (d: any) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
const indices = (list: readonly unknown[]) => ({ type: 'array', uniqueItems: true, maxItems: list.length, items: idx(list) }) as const;

async function read(q: Db | PoolClient, id: string) {
  const r = (await q.query('SELECT * FROM health_records WHERE national_id = $1', [id])).rows[0];
  const { rows: changes } = await q.query('SELECT action, actor, at FROM record_changes WHERE national_id = $1 ORDER BY id DESC LIMIT 20', [id]);
  if (!r) return { national_id: id, exists: false, vaccinations: [], changes };
  const { rows: vaccinations } = await q.query('SELECT id, name, given_on FROM vaccinations WHERE national_id = $1 ORDER BY given_on, id', [id]);
  const ix = (list: { en: string }[], x: any) => list.findIndex((y) => y.en === x?.en);
  return {
    national_id: id, exists: true, blood_type: r.blood_type, organ_donor: r.organ_donor,
    allergies: r.allergies, chronic_conditions: r.chronic_conditions, primary_clinic: r.primary_clinic,
    allergy_indices: (r.allergies as any[]).map((a) => ix(HEALTH_ALLERGIES, a)).filter((i) => i >= 0),
    condition_indices: (r.chronic_conditions as any[]).map((a) => ix(HEALTH_CONDITIONS, a)).filter((i) => i >= 0),
    clinic_index: ix(CLINICS, r.primary_clinic),
    vaccinations: vaccinations.map((v) => ({ id: Number(v.id), name: v.name, given_on: iso(v.given_on) })),
    changes,
  };
}

export function registerRecords(app: FastifyInstance, db: Db): void {
  const tags = ['record maintenance (via Jisr only)'];
  const sec = [{ jisr: [] }];
  const staff = (req: any, id: string) => { const ctx = requireJisr(req); return requireRecordStaff(ctx, AUD, SCOPE, id).then((actor) => ({ actor, requestId: ctx.requestId })); };
  const change = async (c: PoolClient, id: string, action: string, actor: string, requestId: string) => {
    await c.query('INSERT INTO record_changes (national_id, action, actor, jisr_request_id) VALUES ($1,$2,$3,$4)', [id, action, actor, requestId]);
    await emitEvent(c, 'health.record.updated', { subjects: [id], correlationId: requestId, data: { actor, action } });
  };

  app.get('/x/records/persons/:id', { schema: { tags, security: sec, summary: 'The health summary and recent changes (who and when, not what)', params: recordParams() } }, async (req) => {
    const { id } = req.params as { id: string };
    await staff(req, id);
    return read(db, id);
  });

  app.put('/x/records/persons/:id', {
    schema: {
      tags, security: sec, summary: 'Create or correct the health summary', params: recordParams(),
      body: { type: 'object', additionalProperties: false, required: ['blood_type', 'allergy_indices', 'condition_indices', 'clinic_index', 'organ_donor'], properties: {
        blood_type: { type: 'string', enum: BLOOD_TYPES }, allergy_indices: indices(HEALTH_ALLERGIES), condition_indices: indices(HEALTH_CONDITIONS),
        clinic_index: idx(CLINICS), organ_donor: { type: 'boolean' } } },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const { actor, requestId } = await staff(req, id);
    const b = req.body as { blood_type: string; allergy_indices: number[]; condition_indices: number[]; clinic_index: number; organ_donor: boolean };
    await tx(db, async (c) => {
      const ins = await c.query(
        `INSERT INTO health_records (national_id, blood_type, allergies, chronic_conditions, primary_clinic, organ_donor) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (national_id) DO UPDATE SET blood_type=$2, allergies=$3, chronic_conditions=$4, primary_clinic=$5, organ_donor=$6 RETURNING (xmax = 0) AS created`,
        [id, b.blood_type, JSON.stringify(b.allergy_indices.map((i) => HEALTH_ALLERGIES[i])), JSON.stringify(b.condition_indices.map((i) => HEALTH_CONDITIONS[i])), CLINICS[b.clinic_index], b.organ_donor]);
      await change(c, id, ins.rows[0].created ? 'record.created' : 'record.updated', actor, requestId);
    });
    return read(db, id);
  });

  app.post('/x/records/persons/:id/vaccinations', {
    schema: {
      tags, security: sec, summary: 'Record a vaccination', params: recordParams(),
      body: { type: 'object', additionalProperties: false, required: ['vaccine_index', 'given_on'], properties: { vaccine_index: idx(VACCINES), given_on: { type: 'string', format: 'date' } } },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { actor, requestId } = await staff(req, id);
    const b = req.body as { vaccine_index: number; given_on: string };
    failIf(!isDate(b.given_on) ? [{ field: 'given_on', code: 'invalid_date' }] : b.given_on > todayIso() ? [{ field: 'given_on', code: 'in_future' }] : []);
    await tx(db, async (c) => {
      if (!(await c.query('SELECT 1 FROM health_records WHERE national_id = $1', [id])).rowCount) throw httpError(409, 'no_health_record', 'Create the health summary first');
      if ((await c.query("SELECT 1 FROM vaccinations WHERE national_id = $1 AND name->>'en' = $2 AND given_on = $3", [id, VACCINES[b.vaccine_index]!.en, b.given_on])).rowCount) {
        throw httpError(409, 'duplicate_vaccination', 'This vaccination is already recorded for that date');
      }
      await c.query('INSERT INTO vaccinations (national_id, name, given_on) VALUES ($1,$2,$3)', [id, VACCINES[b.vaccine_index], b.given_on]);
      await change(c, id, 'vaccination.added', actor, requestId);
    });
    reply.status(201);
    return read(db, id);
  });

  app.delete('/x/records/persons/:id/vaccinations/:vid', {
    schema: { tags, security: sec, summary: 'Remove a vaccination recorded in error', params: recordParams({ vid: { type: 'integer', minimum: 1 } }) },
  }, async (req) => {
    const { id, vid } = req.params as { id: string; vid: number };
    const { actor, requestId } = await staff(req, id);
    await tx(db, async (c) => {
      if (!(await c.query('DELETE FROM vaccinations WHERE id = $1 AND national_id = $2', [vid, id])).rowCount) throw httpError(404, 'not_found', 'No such vaccination for this person');
      await change(c, id, 'vaccination.removed', actor, requestId);
    });
    return read(db, id);
  });

  // A new address → the main health centre of the new city (the address is pulled through Jisr, audited).
  onEvents('health-address', {
    'registry.address.changed': async (e) => {
      const id = e.data?.national_id as string;
      const r = (await db.query('SELECT primary_clinic FROM health_records WHERE national_id = $1', [id])).rows[0];
      if (!r) return;
      const p = await jisrCall<any>({ target: 'civil-registry', method: 'GET', path: `/x/persons/${id}`, purpose: 'care-assignment', subject: id });
      const ci = CITIES.findIndex((c) => c.en === p?.address?.city?.en);
      if (ci < 0 || r.primary_clinic?.en === CLINICS[ci]!.en) return;
      await tx(db, async (c) => {
        await c.query('UPDATE health_records SET primary_clinic = $2 WHERE national_id = $1', [id, CLINICS[ci]]);
        await c.query('INSERT INTO record_changes (national_id, action, actor, jisr_request_id) VALUES ($1,$2,$3,$4)', [id, 'clinic.reassigned', 'system:address-change', e.correlation_id]);
        await emitEvent(c, 'health.record.updated', { subjects: [id], correlationId: e.correlation_id, data: { action: 'clinic.reassigned', clinic: CLINICS[ci] } });
      });
    },
  }, db);
}
