// Civil Registry — record maintenance by Civil Registry staff ("Manage citizen").
// Reached only through Jisr (purpose record-maintenance) with a Mithaq-signed staff token; every change is
// written to record_changes here, to Jisr's audit chain (the request, on_behalf_of = the employee), and
// announced on the event bus (data.actor = the employee) so the people involved are told.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { Db } from '#shared/db.ts';
import { tx } from '#shared/db.ts';
import { httpError, S } from '#shared/http.ts';
import { requireJisr } from '#shared/jisr.ts';
import { emitEvent } from '#shared/events.ts';
import { ageOn, CITIES, DISTRICTS, isValidNationalId } from '#shared/seed.ts';
import { failIf, ID_SCHEMA, isDate, recordParams, requireRecordStaff, SEARCH_SUBJECT, todayIso, type Problem } from '#shared/records.ts';

const AUD = 'civil-registry';
const SCOPE = 'records.civil';
const bi = (ar: string, en: string) => ({ ar, en });
const iso = (d: any) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
const fullName = (r: any) => bi(`${r.given_name_ar} ${r.family_name_ar}`, `${r.given_name_en} ${r.family_name_en}`);

async function readPerson(q: Db | PoolClient, id: string) {
  const p = (await q.query('SELECT * FROM persons WHERE national_id = $1', [id])).rows[0];
  if (!p) throw httpError(404, 'not_found', 'No such person');
  const { rows: rel } = await q.query(
    `SELECT *, CASE WHEN national_id = $2 THEN 'father' WHEN national_id = $3 THEN 'mother' WHEN national_id = $4 THEN 'spouse' ELSE 'child' END AS relation
       FROM persons WHERE national_id IN ($2, $3, $4) OR father_id = $1 OR mother_id = $1 ORDER BY birth_date`,
    [id, p.father_id, p.mother_id, p.spouse_id]);
  const marriage = p.spouse_id
    ? (await q.query('SELECT married_on FROM marriages WHERE dissolved_on IS NULL AND ((a = $1 AND b = $2) OR (a = $2 AND b = $1)) ORDER BY id DESC LIMIT 1', [id, p.spouse_id])).rows[0]
    : null;
  const { rows: changes } = await q.query('SELECT action, detail, actor, at FROM record_changes WHERE national_id = $1 ORDER BY id DESC LIMIT 20', [id]);
  return {
    national_id: p.national_id, given_name: bi(p.given_name_ar, p.given_name_en), family_name: bi(p.family_name_ar, p.family_name_en),
    gender: p.gender, birth_date: iso(p.birth_date), marital_status: p.marital_status, status: p.status,
    address: {
      city: bi(p.city_ar, p.city_en), district: bi(p.district_ar, p.district_en), street: p.street,
      city_index: CITIES.findIndex((c) => c.en === p.city_en), district_index: DISTRICTS.findIndex((d) => d.en === p.district_en),
    },
    phone: p.phone, married_on: marriage ? iso(marriage.married_on) : null,
    family: rel.map((r) => ({ national_id: r.national_id, relation: r.relation, name: fullName(r), gender: r.gender, birth_date: iso(r.birth_date) })),
    changes: changes.map((c) => ({ ...c, at: c.at instanceof Date ? c.at.toISOString() : c.at })),
  };
}

const log = (c: PoolClient, id: string, action: string, detail: unknown, actor: string, requestId: string) =>
  c.query('INSERT INTO record_changes (national_id, action, detail, actor, jisr_request_id) VALUES ($1,$2,$3,$4,$5)', [id, action, detail, actor, requestId]);

/** Lock and return several people (missing ones are null), in a fixed order to avoid deadlocks. */
async function lockPeople(c: PoolClient, ids: (string | null | undefined)[]) {
  const want = [...new Set(ids.filter((x): x is string => !!x))].sort();
  const { rows } = await c.query('SELECT * FROM persons WHERE national_id = ANY($1) ORDER BY national_id FOR UPDATE', [want]);
  const m = new Map(rows.map((r) => [r.national_id, r]));
  return (id?: string | null) => (id ? m.get(id) ?? null : null);
}

const sameParent = (a: any, b: any) => (a.father_id && a.father_id === b.father_id) || (a.mother_id && a.mother_id === b.mother_id);
const isParentOf = (parent: any, child: any) => child.father_id === parent.national_id || child.mother_id === parent.national_id;

export function registerRecords(app: FastifyInstance, db: Db): void {
  const tags = ['record maintenance (via Jisr only)'];
  const sec = [{ jisr: [] }];
  const staff = (req: any, id: string) => { const ctx = requireJisr(req); return requireRecordStaff(ctx, AUD, SCOPE, id).then((actor) => ({ actor, requestId: ctx.requestId })); };

  app.get('/x/records/search', {
    schema: {
      tags, security: sec, summary: 'Find people by name (any part, Arabic or English); at most 20 results',
      querystring: { type: 'object', required: ['q'], properties: { q: { type: 'string', minLength: 2, maxLength: 40 } } },
      response: { 200: { type: 'object', properties: { results: { type: 'array', items: { type: 'object', properties: {
        national_id: { type: 'string' }, name: S.bilingual, birth_date: { type: 'string' }, gender: { type: 'string' }, status: { type: 'string' } } } } } } },
    },
  }, async (req) => {
    await staff(req, SEARCH_SUBJECT);
    const words = (req.query as { q: string }).q.trim().split(/\s+/).filter(Boolean).slice(0, 4).map((w) => `%${w.replace(/[\\%_]/g, (x) => `\\${x}`)}%`);
    if (!words.length) return { results: [] };
    // Every word must appear in the Arabic or the English full name.
    const where = words.map((_, i) => `((given_name_en || ' ' || family_name_en) ILIKE $${i + 1} OR (given_name_ar || ' ' || family_name_ar) ILIKE $${i + 1})`).join(' AND ');
    const { rows } = await db.query(`SELECT national_id, given_name_ar, given_name_en, family_name_ar, family_name_en, birth_date, gender, status FROM persons WHERE ${where} ORDER BY family_name_en, given_name_en LIMIT 20`, words);
    return { results: rows.map((r) => ({ national_id: r.national_id, name: fullName(r), birth_date: iso(r.birth_date), gender: r.gender, status: r.status })) };
  });

  app.get('/x/records/persons/:id', { schema: { tags, security: sec, summary: 'A person’s civil record, family and recent changes', params: recordParams() } }, async (req) => {
    const { id } = req.params as { id: string };
    await staff(req, id);
    return readPerson(db, id);
  });

  // ---- Address ----
  app.put('/x/records/persons/:id/address', {
    schema: {
      tags, security: sec, summary: 'Change the address (and optionally the phone number)', params: recordParams(),
      body: { type: 'object', additionalProperties: false, required: ['city_index', 'district_index', 'street'], properties: {
        city_index: { type: 'integer', minimum: 0, maximum: CITIES.length - 1 }, district_index: { type: 'integer', minimum: 0, maximum: DISTRICTS.length - 1 },
        street: { type: 'string', minLength: 1, maxLength: 60, pattern: '^[^<>{}]*\\S[^<>{}]*$' }, phone: { type: 'string', pattern: '^\\+?[0-9 ]{7,20}$' } } },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const { actor, requestId } = await staff(req, id);
    const b = req.body as { city_index: number; district_index: number; street: string; phone?: string };
    const city = CITIES[b.city_index]!, district = DISTRICTS[b.district_index]!;
    await tx(db, async (c) => {
      const get = await lockPeople(c, [id]);
      const p = get(id);
      if (!p) throw httpError(404, 'not_found', 'No such person');
      const before = { city: p.city_en, district: p.district_en, street: p.street, phone: p.phone };
      const after = { city: city.en, district: district.en, street: b.street.trim(), phone: b.phone?.trim() ?? p.phone };
      if (JSON.stringify(before) === JSON.stringify(after)) throw httpError(409, 'no_change', 'The address is already exactly this');
      await c.query('UPDATE persons SET city_ar=$2, city_en=$3, district_ar=$4, district_en=$5, street=$6, phone=$7, updated_at=now() WHERE national_id=$1',
        [id, city.ar, city.en, district.ar, district.en, after.street, after.phone]);
      await log(c, id, 'address.changed', { before, after }, actor, requestId);
      await emitEvent(c, 'registry.address.changed', { subjects: [id], correlationId: requestId, data: { national_id: id, actor, city } });
    });
    return readPerson(db, id);
  });

  // ---- Marriage ----
  app.post('/x/records/persons/:id/marriage', {
    schema: {
      tags, security: sec, summary: 'Register a marriage (both records are updated)', params: recordParams(),
      body: { type: 'object', additionalProperties: false, required: ['spouse_id', 'married_on'], properties: { spouse_id: ID_SCHEMA, married_on: { type: 'string', format: 'date' } } },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const { actor, requestId } = await staff(req, id);
    const b = req.body as { spouse_id: string; married_on: string };
    const pre: Problem[] = [];
    if (!isValidNationalId(b.spouse_id)) pre.push({ field: 'spouse_id', code: 'invalid_id' });
    if (b.spouse_id === id) pre.push({ field: 'spouse_id', code: 'same_person' });
    if (!isDate(b.married_on)) pre.push({ field: 'married_on', code: 'invalid_date' });
    else if (b.married_on > todayIso()) pre.push({ field: 'married_on', code: 'in_future' });
    failIf(pre);
    await tx(db, async (c) => {
      const get = await lockPeople(c, [id, b.spouse_id]);
      const p = get(id), s = get(b.spouse_id);
      if (!p) throw httpError(404, 'not_found', 'No such person');
      const problems: Problem[] = [];
      if (p.spouse_id) problems.push({ field: 'spouse_id', code: 'already_married' });
      if (p.status !== 'alive' || ageOn(iso(p.birth_date)) < 18) problems.push({ field: 'spouse_id', code: 'person_not_eligible' });
      if (!s) problems.push({ field: 'spouse_id', code: 'not_found' });
      else {
        if (s.spouse_id || s.status !== 'alive' || ageOn(iso(s.birth_date)) < 18) problems.push({ field: 'spouse_id', code: 'not_available' });
        else if (isParentOf(p, s) || isParentOf(s, p) || sameParent(p, s)) problems.push({ field: 'spouse_id', code: 'close_relative' });
        const adultSince = [p, s].map((x) => `${Number(iso(x.birth_date).slice(0, 4)) + 18}${iso(x.birth_date).slice(4)}`).sort().pop()!;
        if (isDate(b.married_on) && b.married_on < adultSince) problems.push({ field: 'married_on', code: 'before_adult' });
      }
      failIf(problems, 'The marriage cannot be registered');
      await c.query("UPDATE persons SET spouse_id = $2, marital_status = 'married', updated_at = now() WHERE national_id = $1", [id, s.national_id]);
      await c.query("UPDATE persons SET spouse_id = $2, marital_status = 'married', updated_at = now() WHERE national_id = $1", [s.national_id, id]);
      await c.query('INSERT INTO marriages (a, b, married_on, registered_by, jisr_request_id) VALUES ($1,$2,$3,$4,$5)', [id, s.national_id, b.married_on, actor, requestId]);
      for (const [who, other] of [[id, s.national_id], [s.national_id, id]]) await log(c, who!, 'marriage.registered', { spouse_id: other, married_on: b.married_on }, actor, requestId);
      await emitEvent(c, 'registry.marriage.registered', { subjects: [id, s.national_id], correlationId: requestId, data: { actor, spouses: [id, s.national_id], married_on: b.married_on } });
    });
    return readPerson(db, id);
  });

  app.post('/x/records/persons/:id/divorce', {
    schema: {
      tags, security: sec, summary: 'Register a divorce (both records are updated)', params: recordParams(),
      body: { type: 'object', additionalProperties: false, required: ['divorced_on'], properties: { divorced_on: { type: 'string', format: 'date' } } },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const { actor, requestId } = await staff(req, id);
    const b = req.body as { divorced_on: string };
    failIf(!isDate(b.divorced_on) ? [{ field: 'divorced_on', code: 'invalid_date' }] : b.divorced_on > todayIso() ? [{ field: 'divorced_on', code: 'in_future' }] : []);
    await tx(db, async (c) => {
      const spouseId = (await c.query('SELECT spouse_id FROM persons WHERE national_id = $1', [id])).rows[0]?.spouse_id;
      const get = await lockPeople(c, [id, spouseId]);
      const p = get(id);
      if (!p) throw httpError(404, 'not_found', 'No such person');
      if (!p.spouse_id) failIf([{ field: 'divorced_on', code: 'not_married' }], 'There is no marriage to dissolve');
      const m = (await c.query('SELECT id, married_on FROM marriages WHERE dissolved_on IS NULL AND ((a = $1 AND b = $2) OR (a = $2 AND b = $1)) ORDER BY id DESC LIMIT 1', [id, p.spouse_id])).rows[0];
      if (m && b.divorced_on < iso(m.married_on)) failIf([{ field: 'divorced_on', code: 'before_marriage' }]);
      await c.query("UPDATE persons SET spouse_id = NULL, marital_status = 'divorced', updated_at = now() WHERE national_id = ANY($1)", [[id, p.spouse_id]]);
      if (m) await c.query('UPDATE marriages SET dissolved_on = $2 WHERE id = $1', [m.id, b.divorced_on]);
      for (const [who, other] of [[id, p.spouse_id], [p.spouse_id, id]]) await log(c, who, 'marriage.dissolved', { spouse_id: other, divorced_on: b.divorced_on }, actor, requestId);
      await emitEvent(c, 'registry.marriage.dissolved', { subjects: [id, p.spouse_id], correlationId: requestId, data: { actor, spouses: [id, p.spouse_id], divorced_on: b.divorced_on } });
    });
    return readPerson(db, id);
  });

  app.put('/x/records/persons/:id/marital-status', {
    schema: {
      tags, security: sec, summary: 'Correct the marital status of someone with no spouse linked (single / divorced / widowed)', params: recordParams(),
      body: { type: 'object', additionalProperties: false, required: ['marital_status'], properties: { marital_status: { type: 'string', enum: ['single', 'divorced', 'widowed'] } } },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const { actor, requestId } = await staff(req, id);
    const { marital_status } = req.body as { marital_status: string };
    await tx(db, async (c) => {
      const p = (await lockPeople(c, [id]))(id);
      if (!p) throw httpError(404, 'not_found', 'No such person');
      if (p.spouse_id) failIf([{ field: 'marital_status', code: 'has_spouse' }], 'Register a divorce instead');
      if (p.marital_status === marital_status) throw httpError(409, 'no_change', 'The marital status is already this');
      await c.query('UPDATE persons SET marital_status = $2, updated_at = now() WHERE national_id = $1', [id, marital_status]);
      await log(c, id, 'marital_status.changed', { before: p.marital_status, after: marital_status }, actor, requestId);
      await emitEvent(c, 'registry.family.changed', { subjects: [id], correlationId: requestId, data: { actor, national_id: id, change: 'marital_status', marital_status } });
    });
    return readPerson(db, id);
  });

  // ---- Parents ----
  app.put('/x/records/persons/:id/parents', {
    schema: {
      tags, security: sec, summary: 'Set or clear the father and mother links', params: recordParams(),
      body: { type: 'object', additionalProperties: false, required: ['father_id', 'mother_id'], properties: {
        father_id: { anyOf: [ID_SCHEMA, { type: 'null' }] }, mother_id: { anyOf: [ID_SCHEMA, { type: 'null' }] } } },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const { actor, requestId } = await staff(req, id);
    const b = req.body as { father_id: string | null; mother_id: string | null };
    const pre: Problem[] = [];
    for (const f of ['father_id', 'mother_id'] as const) {
      if (b[f] && !isValidNationalId(b[f]!)) pre.push({ field: f, code: 'invalid_id' });
      else if (b[f] === id) pre.push({ field: f, code: 'same_person' });
    }
    if (b.father_id && b.father_id === b.mother_id) pre.push({ field: 'mother_id', code: 'same_parent' });
    failIf(pre);
    await tx(db, async (c) => {
      const old = (await c.query('SELECT father_id, mother_id FROM persons WHERE national_id = $1', [id])).rows[0];
      const get = await lockPeople(c, [id, b.father_id, b.mother_id, old?.father_id, old?.mother_id]);
      const p = get(id);
      if (!p) throw httpError(404, 'not_found', 'No such person');
      if (p.father_id === b.father_id && p.mother_id === b.mother_id) throw httpError(409, 'no_change', 'The parents are already exactly these');
      const problems: Problem[] = [];
      for (const [f, gender] of [['father_id', 'M'], ['mother_id', 'F']] as const) {
        if (!b[f] || b[f] === p[f]) continue; // unchanged or cleared
        const par = get(b[f]);
        if (!par) { problems.push({ field: f, code: 'not_found' }); continue; }
        if (par.gender !== gender) problems.push({ field: f, code: 'wrong_gender' });
        else if (ageOn(iso(par.birth_date)) - ageOn(iso(p.birth_date)) < 12) problems.push({ field: f, code: 'not_plausible' });
        else if (isParentOf(p, par) || p.spouse_id === par.national_id) problems.push({ field: f, code: 'close_relative' });
      }
      failIf(problems, 'A family link is not possible');
      await c.query('UPDATE persons SET father_id = $2, mother_id = $3, updated_at = now() WHERE national_id = $1', [id, b.father_id, b.mother_id]);
      const before = { father_id: p.father_id, mother_id: p.mother_id };
      await log(c, id, 'parents.changed', { before, after: b }, actor, requestId);
      const involved = [...new Set([id, p.father_id, p.mother_id, b.father_id, b.mother_id].filter((x): x is string => !!x))];
      await emitEvent(c, 'registry.family.changed', { subjects: involved, correlationId: requestId, data: { actor, national_id: id, change: 'parents', before, after: b } });
    });
    return readPerson(db, id);
  });

  // ---- Children (a child is linked by setting the child's father or mother to this person) ----
  app.post('/x/records/persons/:id/children', {
    schema: {
      tags, security: sec, summary: 'Link a child to this person (as father or mother, from the person’s sex)', params: recordParams(),
      body: { type: 'object', additionalProperties: false, required: ['child_id'], properties: { child_id: ID_SCHEMA } },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const { actor, requestId } = await staff(req, id);
    const { child_id } = req.body as { child_id: string };
    failIf(!isValidNationalId(child_id) ? [{ field: 'child_id', code: 'invalid_id' }] : child_id === id ? [{ field: 'child_id', code: 'same_person' }] : []);
    await tx(db, async (c) => {
      const get = await lockPeople(c, [id, child_id]);
      const p = get(id), ch = get(child_id);
      if (!p) throw httpError(404, 'not_found', 'No such person');
      if (!ch) failIf([{ field: 'child_id', code: 'not_found' }]);
      const slot = p.gender === 'M' ? 'father_id' : 'mother_id';
      if (ch[slot] === id) throw httpError(409, 'no_change', 'This child is already linked to this person');
      const problems: Problem[] = [];
      if (ch[slot]) problems.push({ field: 'child_id', code: p.gender === 'M' ? 'has_father' : 'has_mother' });
      else if (ageOn(iso(p.birth_date)) - ageOn(iso(ch.birth_date)) < 12) problems.push({ field: 'child_id', code: 'not_plausible' });
      else if (isParentOf(ch, p) || p.spouse_id === child_id) problems.push({ field: 'child_id', code: 'close_relative' });
      failIf(problems, 'The child cannot be linked');
      await c.query(`UPDATE persons SET ${slot} = $2, updated_at = now() WHERE national_id = $1`, [child_id, id]);
      await log(c, id, 'child.linked', { child_id }, actor, requestId);
      await log(c, child_id, 'parents.changed', { [slot]: id }, actor, requestId);
      await emitEvent(c, 'registry.family.changed', { subjects: [id, child_id], correlationId: requestId, data: { actor, national_id: id, change: 'child_linked', child_id } });
    });
    return readPerson(db, id);
  });

  app.delete('/x/records/persons/:id/children/:childId', {
    schema: { tags, security: sec, summary: 'Remove the link between this person and a child', params: recordParams({ childId: ID_SCHEMA }) },
  }, async (req) => {
    const { id, childId } = req.params as { id: string; childId: string };
    const { actor, requestId } = await staff(req, id);
    await tx(db, async (c) => {
      const get = await lockPeople(c, [id, childId]);
      const p = get(id), ch = get(childId);
      if (!p) throw httpError(404, 'not_found', 'No such person');
      const slot = ch?.father_id === id ? 'father_id' : ch?.mother_id === id ? 'mother_id' : null;
      if (!slot) throw httpError(404, 'not_linked', 'That person is not linked as this person’s child');
      await c.query(`UPDATE persons SET ${slot} = NULL, updated_at = now() WHERE national_id = $1`, [childId]);
      await log(c, id, 'child.unlinked', { child_id: childId }, actor, requestId);
      await log(c, childId, 'parents.changed', { [slot]: null }, actor, requestId);
      await emitEvent(c, 'registry.family.changed', { subjects: [id, childId], correlationId: requestId, data: { actor, national_id: id, change: 'child_unlinked', child_id: childId } });
    });
    return readPerson(db, id);
  });
}
