// Civil Registry — single source of truth for persons, families and addresses.
// It has NO public data API: everything is served via Jisr (/x/*), so every read is audited.
import { createService, start, httpError, S } from '#shared/http.ts';
import { createDb, migrate, tx } from '#shared/db.ts';
import { installJisrGuard, requireJisr, jisrCall } from '#shared/jisr.ts';
import { population, luhnDigit, ageOn, isValidNationalId, CITIES, DISTRICTS } from '#shared/seed.ts';
import { initEvents, emitEvent, startOutboxPump, onEvents } from '#shared/events.ts';
import { registerRecords } from './records.ts';
import { registerBirths } from './births.ts';

const db = createDb();
await migrate(db, new URL('./schema.sql', import.meta.url));
await initEvents(db);

// Seed the fictional population once.
const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM persons');
if (n === 0) {
  await tx(db, async (c) => {
    for (const p of population()) {
      await c.query(
        `INSERT INTO persons (national_id, given_name_ar, given_name_en, family_name_ar, family_name_en, gender, birth_date, nationality,
           marital_status, city_ar, city_en, district_ar, district_en, street, phone, father_id, mother_id, spouse_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [p.national_id, p.given_name.ar, p.given_name.en, p.family_name.ar, p.family_name.en, p.gender, p.birth_date, p.nationality,
          p.marital_status, p.address.city.ar, p.address.city.en, p.address.district.ar, p.address.district.en, p.address.street,
          p.phone, p.father_id, p.mother_id, p.spouse_id, p.status],
      );
    }
  });
}

const app = await createService({
  prefix: 'registry',
  title: 'Civil Registry',
  description: 'Authoritative register of persons, families and addresses. Reachable ONLY through Jisr (`/x/*` routes need a Jisr assertion).',
});
await installJisrGuard(app);

const bi = (ar: string, en: string) => ({ ar, en });
const toPerson = (r: any) => ({
  national_id: r.national_id,
  given_name: bi(r.given_name_ar, r.given_name_en),
  family_name: bi(r.family_name_ar, r.family_name_en),
  gender: r.gender,
  birth_date: r.birth_date instanceof Date ? r.birth_date.toISOString().slice(0, 10) : r.birth_date,
  nationality: r.nationality,
  marital_status: r.marital_status,
  address: { city: bi(r.city_ar, r.city_en), district: bi(r.district_ar, r.district_en), street: r.street },
  phone: r.phone,
  status: r.status,
});
const brief = (r: any, relation: string) => ({
  national_id: r.national_id, relation,
  name: bi(`${r.given_name_ar} ${r.family_name_ar}`, `${r.given_name_en} ${r.family_name_en}`),
});

const personSchema = {
  type: 'object',
  properties: {
    national_id: { type: 'string' }, given_name: S.bilingual, family_name: S.bilingual, gender: { type: 'string' },
    birth_date: { type: 'string', format: 'date' }, nationality: { type: 'string' }, marital_status: { type: 'string' },
    address: { type: 'object', properties: { city: S.bilingual, district: S.bilingual, street: { type: 'string' } } },
    phone: { type: 'string' }, status: { type: 'string' },
    family: { type: 'array', items: { type: 'object', properties: { national_id: { type: 'string' }, relation: { type: 'string' }, name: S.bilingual } } },
  },
} as const;

app.get('/x/persons/:id', {
  schema: {
    tags: ['exchange (via Jisr only)'], summary: 'Read a person record with immediate family', security: [{ jisr: [] }],
    params: { type: 'object', properties: { id: { type: 'string', pattern: '^1\\d{9}$' } }, required: ['id'] },
    response: { 200: personSchema, 404: S.error },
  },
}, async (req) => {
  const ctx = requireJisr(req);
  const { id } = req.params as { id: string };
  // Defense in depth: the declared subject must be the person being read.
  if (ctx.subject !== id) throw httpError(403, 'subject_mismatch', 'Declared subject does not match the requested person');
  const { rows } = await db.query('SELECT * FROM persons WHERE national_id = $1', [id]);
  if (!rows[0]) throw httpError(404, 'not_found', 'No such person');
  const p = rows[0];
  const { rows: rel } = await db.query(
    `SELECT *, CASE
        WHEN national_id = $2 THEN 'father' WHEN national_id = $3 THEN 'mother' WHEN national_id = $4 THEN 'spouse'
        ELSE 'child' END AS relation
     FROM persons WHERE national_id IN ($2, $3, $4) OR father_id = $1 OR mother_id = $1
     ORDER BY birth_date`,
    [id, p.father_id, p.mother_id, p.spouse_id],
  );
  return { ...toPerson(p), family: rel.map((r) => brief(r, r.relation)) };
});

// ---------------- Births: hospital report → parents name the baby → registration (births.ts) ----------------
registerBirths(app, db, nextNationalId);
startOutboxPump(db);

// ---------------- Registration of an adult by a registrar ----------------
// Naturalisation, or a citizen who is missing from the registry. Only Mithaq may call it (Jisr rule), and
// only for a request that names the registrar ("employee:<staff ID>") — recorded here, in the Jisr audit
// chain, and (via the event) in each family member's "who accessed my data".

const NAME = { type: 'string', minLength: 1, maxLength: 40, pattern: '^[^<>{}]+$' } as const;
const biName = { type: 'object', required: ['ar', 'en'], additionalProperties: false, properties: { ar: NAME, en: NAME } } as const;
const ID = { type: 'string', pattern: '^1\\d{9}$' } as const;

/** Allocates the next national ID (caller holds the allocation lock), for births and registrations alike.
 *  IDs of removed (test) records are retired and never handed out again: audit entries still name them. */
async function nextNationalId(c: import('pg').PoolClient): Promise<string> {
  const { rows: [{ base }] } = await c.query(
    `SELECT greatest((SELECT max(substr(national_id, 1, 9))::bigint FROM persons),
                     (SELECT max(substr(national_id, 1, 9))::bigint FROM retired_national_ids)) + 1 AS base`);
  return `${base}${luhnDigit(String(base))}`;
}

app.post('/x/persons', {
  schema: {
    tags: ['exchange (via Jisr only)'], summary: 'Register a new adult citizen (registrar only); allocates the national ID', security: [{ jisr: [] }],
    body: {
      type: 'object', additionalProperties: false,
      required: ['given_name', 'family_name', 'gender', 'birth_date', 'city_index', 'district_index', 'street', 'phone', 'reason'],
      properties: {
        given_name: biName, family_name: biName,
        gender: { type: 'string', enum: ['M', 'F'] },
        birth_date: { type: 'string', format: 'date' },
        city_index: { type: 'integer', minimum: 0, maximum: CITIES.length - 1 },
        district_index: { type: 'integer', minimum: 0, maximum: DISTRICTS.length - 1 },
        street: { type: 'string', minLength: 1, maxLength: 60, pattern: '^[^<>{}]+$' },
        phone: { type: 'string', pattern: '^\\+?[0-9 ]{7,20}$' },
        father_id: ID, mother_id: ID, spouse_id: ID,
        reason: { type: 'string', enum: ['naturalization', 'missing-record'] },
        reference: { type: 'string', maxLength: 60, pattern: '^[^<>{}]*$' },
        confirm_not_duplicate: { type: 'boolean' },
      },
    },
    response: { 201: personSchema, 409: S.error, 422: S.error },
  },
}, async (req, reply) => {
  const ctx = requireJisr(req);
  if (ctx.purpose !== 'civil-registration' || !/^employee:[\w.-]+$/.test(ctx.onBehalfOf ?? '')) {
    throw httpError(403, 'registrar_required', 'Only a registrar (named in on_behalf_of) can register a person');
  }
  const b = req.body as any;
  const problems: { field: string; code: string }[] = [];
  if (b.birth_date > new Date().toISOString().slice(0, 10) || ageOn(b.birth_date) < 18) problems.push({ field: 'birth_date', code: 'not_adult' });
  if (ageOn(b.birth_date) > 120) problems.push({ field: 'birth_date', code: 'implausible' });
  for (const f of ['father_id', 'mother_id', 'spouse_id']) if (b[f] && !isValidNationalId(b[f])) problems.push({ field: f, code: 'invalid_id' });
  if (problems.length) throw httpError(422, 'validation_failed', 'Some details are not valid', { problems });

  const person = await tx(db, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(4711)'); // serialise ID allocation (shared with births)
    // Family links must point at real, plausible people.
    const get = async (id?: string) => (id ? (await c.query('SELECT * FROM persons WHERE national_id = $1 FOR UPDATE', [id])).rows[0] ?? null : null);
    const [father, mother, spouse] = [await get(b.father_id), await get(b.mother_id), await get(b.spouse_id)];
    const linkProblems: { field: string; code: string }[] = [];
    const ageGap = (parent: any) => ageOn(parent.birth_date) - ageOn(b.birth_date); // dates are 'YYYY-MM-DD' strings
    if (b.father_id && !father) linkProblems.push({ field: 'father_id', code: 'not_found' });
    if (father && (father.gender !== 'M' || ageGap(father) < 12)) linkProblems.push({ field: 'father_id', code: 'not_plausible' });
    if (b.mother_id && !mother) linkProblems.push({ field: 'mother_id', code: 'not_found' });
    if (mother && (mother.gender !== 'F' || ageGap(mother) < 12)) linkProblems.push({ field: 'mother_id', code: 'not_plausible' });
    if (b.spouse_id && !spouse) linkProblems.push({ field: 'spouse_id', code: 'not_found' });
    if (spouse && (spouse.spouse_id || spouse.status !== 'alive' || ageOn(spouse.birth_date) < 18)) linkProblems.push({ field: 'spouse_id', code: 'not_available' });
    if (linkProblems.length) throw httpError(422, 'validation_failed', 'A family link is not possible', { problems: linkProblems });

    // Possible duplicate: same names (either language) and birth date. The registrar must confirm.
    const dupes = (await c.query(
      `SELECT national_id FROM persons WHERE birth_date = $1 AND ((lower(given_name_en) = lower($2) AND lower(family_name_en) = lower($3)) OR (given_name_ar = $4 AND family_name_ar = $5))`,
      [b.birth_date, b.given_name.en.trim(), b.family_name.en.trim(), b.given_name.ar.trim(), b.family_name.ar.trim()],
    )).rows.map((r) => r.national_id);
    if (dupes.length && !b.confirm_not_duplicate) throw httpError(409, 'possible_duplicate', 'A person with the same name and birth date is already registered', { national_ids: dupes });

    const nationalId = await nextNationalId(c);
    const city = CITIES[b.city_index]!, district = DISTRICTS[b.district_index]!;
    await c.query(
      `INSERT INTO persons (national_id, given_name_ar, given_name_en, family_name_ar, family_name_en, gender, birth_date, nationality,
         marital_status, city_ar, city_en, district_ar, district_en, street, phone, father_id, mother_id, spouse_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'SRB',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'alive')`,
      [nationalId, b.given_name.ar.trim(), b.given_name.en.trim(), b.family_name.ar.trim(), b.family_name.en.trim(), b.gender, b.birth_date,
        spouse ? 'married' : 'single', city.ar, city.en, district.ar, district.en, b.street.trim(), b.phone.trim(),
        father?.national_id ?? null, mother?.national_id ?? null, spouse?.national_id ?? null],
    );
    if (spouse) await c.query("UPDATE persons SET spouse_id = $1, marital_status = 'married', updated_at = now() WHERE national_id = $2", [nationalId, spouse.national_id]);
    await c.query('INSERT INTO registrations (national_id, reason, reference, registered_by, jisr_request_id) VALUES ($1,$2,$3,$4,$5)',
      [nationalId, b.reason, b.reference?.trim() || null, ctx.onBehalfOf, ctx.requestId]);
    const links = { father_id: father?.national_id ?? null, mother_id: mother?.national_id ?? null, spouse_id: spouse?.national_id ?? null };
    await emitEvent(c, 'registry.person.registered', {
      subjects: [nationalId, ...Object.values(links).filter((x): x is string => !!x)],
      correlationId: ctx.requestId,
      data: { national_id: nationalId, reason: b.reason, actor: ctx.onBehalfOf, ...links },
    });
    return nationalId;
  });

  const { rows: [p] } = await db.query('SELECT * FROM persons WHERE national_id = $1', [person]);
  const { rows: rel } = await db.query(
    `SELECT *, CASE WHEN national_id = $1 THEN 'father' WHEN national_id = $2 THEN 'mother' ELSE 'spouse' END AS relation
     FROM persons WHERE national_id IN ($1, $2, $3)`, [p.father_id, p.mother_id, p.spouse_id]);
  reply.status(201);
  return { ...toPerson(p), family: rel.map((r) => brief(r, r.relation)) };
});

registerRecords(app, db);

await start(app);
