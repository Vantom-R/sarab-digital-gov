// Ministry of Health — a minimal, fake health summary. Reachable only through Jisr, and the
// Jisr policy lets ONLY Mithaq read it: for the citizen's own self-service view, or for Health staff
// maintaining the record (records.ts — needs a Mithaq-signed staff token for scope records.health).
import { createService, start, httpError, S } from '#shared/http.ts';
import { createDb, migrate, tx } from '#shared/db.ts';
import { randomId } from '#shared/crypto.ts';
import { initEvents, emitEvent, startOutboxPump, onEvents } from '#shared/events.ts';
import { installJisrGuard, requireJisr } from '#shared/jisr.ts';
import { population } from '#shared/seed.ts';
import { healthFor } from '#shared/seed-ministries.ts';
import { registerRecords } from './records.ts';
import { HOSPITALS } from '#shared/records.ts';

const db = createDb();
await migrate(db, new URL('./schema.sql', import.meta.url));
await initEvents(db);

const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM health_records');
if (n === 0) {
  await tx(db, async (c) => {
    for (const p of population()) {
      const h = healthFor(p);
      await c.query(
        'INSERT INTO health_records (national_id, blood_type, allergies, chronic_conditions, primary_clinic, organ_donor) VALUES ($1,$2,$3,$4,$5,$6)',
        [p.national_id, h.blood_type, JSON.stringify(h.allergies), JSON.stringify(h.chronic_conditions), h.primary_clinic, h.organ_donor],
      );
      for (const v of h.vaccinations) {
        await c.query('INSERT INTO vaccinations (national_id, name, given_on) VALUES ($1,$2,$3)', [p.national_id, v.name, v.date]);
      }
    }
  });
}

const app = await createService({
  prefix: 'health',
  title: 'Ministry of Health (minimal, fake)',
  description: 'Health summary. Reachable ONLY through Jisr; the access policy allows only the citizen’s own self-service view.',
});
await installJisrGuard(app);

app.get('/x/persons/:id/health', {
  schema: {
    tags: ['exchange (via Jisr only)'], summary: "A person's health summary", security: [{ jisr: [] }],
    params: { type: 'object', properties: { id: { type: 'string', pattern: '^1\\d{9}$' } }, required: ['id'] },
    response: {
      200: {
        type: 'object',
        properties: {
          national_id: { type: 'string' }, blood_type: { type: 'string' },
          allergies: { type: 'array', items: S.bilingual }, chronic_conditions: { type: 'array', items: S.bilingual },
          primary_clinic: S.bilingual, organ_donor: { type: 'boolean' },
          vaccinations: { type: 'array', items: { type: 'object', properties: { name: S.bilingual, given_on: { type: 'string', format: 'date' } } } },
        },
      },
    },
  },
}, async (req) => {
  const ctx = requireJisr(req);
  const { id } = req.params as { id: string };
  if (ctx.subject !== id) throw httpError(403, 'subject_mismatch', 'Declared subject does not match the requested person');
  // Defense in depth: even if a Jisr rule were mis-configured, health data is self-service only.
  if (ctx.client !== 'mithaq' || ctx.purpose !== 'citizen-self-service' || ctx.onBehalfOf !== 'self') {
    throw httpError(403, 'health_self_service_only', 'Health data is only released to the citizen themself');
  }
  const r = (await db.query('SELECT * FROM health_records WHERE national_id = $1', [id])).rows[0];
  if (!r) throw httpError(404, 'not_found', 'No health record');
  const { rows: vaccinations } = await db.query('SELECT name, given_on FROM vaccinations WHERE national_id = $1 ORDER BY given_on', [id]);
  return { national_id: id, blood_type: r.blood_type, allergies: r.allergies, chronic_conditions: r.chronic_conditions, primary_clinic: r.primary_clinic, organ_donor: r.organ_donor, vaccinations };
});

// ---------------- Phase 3: births ----------------

const HOSPITAL = { ar: 'مستشفى الواحة العام (افتراضي)', en: 'Al-Waha General Hospital (fictional)' }; // for births reported before hospitals were listed
const idPattern = '^1\\d{9}$';

// The hospital reports a birth: who the mother (and, if declared, the father) is, the baby's sex, the date
// and the hospital. NO name — the parents choose it afterwards, in Mithaq, and the Civil Registry records it.
// Only hospital staff reach this (via Mithaq's staff portal; the employee is named in on_behalf_of).
app.post('/x/birth-notifications', {
  schema: {
    tags: ['exchange (via Jisr only)'], security: [{ jisr: [] }],
    summary: 'A hospital reports a birth (no name yet) and publishes health.birth.notified',
    body: {
      type: 'object', required: ['mother_id', 'child_gender', 'birth_date', 'hospital_index'], additionalProperties: false,
      properties: {
        mother_id: { type: 'string', pattern: idPattern }, father_id: { type: ['string', 'null'], pattern: idPattern },
        child_gender: { type: 'string', enum: ['M', 'F'] }, birth_date: { type: 'string', format: 'date' },
        hospital_index: { type: 'integer', minimum: 0, maximum: HOSPITALS.length - 1 },
        record_no: { type: ['string', 'null'], maxLength: 40, pattern: '^[A-Za-z0-9 _-]*$' },
        another_baby: { type: 'boolean', default: false },
      },
    },
  },
}, async (req) => {
  const ctx = requireJisr(req);
  const b = req.body as any;
  if (ctx.subject !== b.mother_id) throw httpError(403, 'subject_mismatch', 'Declared subject must be the mother');
  if (!String(ctx.onBehalfOf ?? '').startsWith('employee:')) throw httpError(403, 'hospital_staff_only', 'Only hospital staff report births');
  const born = new Date(`${b.birth_date}T00:00:00Z`).getTime();
  const problems: { field: string; code: string }[] = [];
  if (born > Date.now()) problems.push({ field: 'birth_date', code: 'in_future' });
  else if (born < Date.now() - 60 * 86_400_000) problems.push({ field: 'birth_date', code: 'too_late' });
  if (problems.length) throw httpError(422, 'validation_failed', 'Some details are not valid', { problems });
  const hospital = HOSPITALS[b.hospital_index]!;
  const id = `BN-${randomId(6)}`;
  await tx(db, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [b.mother_id]);
    // Twins etc.: a second report for the same mother and date must say it is another baby.
    const dupe = (await c.query('SELECT id FROM birth_notifications WHERE mother_id = $1 AND birth_date = $2', [b.mother_id, b.birth_date])).rows;
    if (dupe.length && !b.another_baby) throw httpError(409, 'possible_duplicate', 'A birth for this mother on this date was already reported. If this is another baby (twins), say so.', { notification_ids: dupe.map((r) => r.id) });
    await c.query(
      `INSERT INTO birth_notifications (id, mother_id, father_id, child_given_name, child_gender, birth_date, hospital, hospital_index, record_no, reported_via, reported_by)
       VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,'hospital',$9)`,
      [id, b.mother_id, b.father_id ?? null, b.child_gender, b.birth_date, hospital, b.hospital_index, b.record_no?.trim() || null, ctx.onBehalfOf],
    );
    // The event carries NO details — only the notification id, the parents and who reported it.
    await emitEvent(c, 'health.birth.notified', {
      subjects: [b.mother_id, ...(b.father_id ? [b.father_id] : [])], correlationId: id,
      data: { notification_id: id, mother_id: b.mother_id, father_id: b.father_id ?? null, actor: ctx.onBehalfOf, hospital, child_gender: b.child_gender, birth_date: b.birth_date },
    });
  });
  return { notification_id: id, hospital };
});

app.get('/x/birth-notifications/:id', {
  schema: { tags: ['exchange (via Jisr only)'], security: [{ jisr: [] }], summary: 'Birth notification details (Civil Registry only)' },
}, async (req) => {
  const ctx = requireJisr(req);
  if (ctx.client !== 'civil-registry') throw httpError(403, 'registry_only', 'Only the Civil Registry may read birth notifications');
  const { id } = req.params as { id: string };
  const r = (await db.query('SELECT * FROM birth_notifications WHERE id = $1', [id])).rows[0];
  if (!r) throw httpError(404, 'not_found', 'No such birth notification');
  if (ctx.subject !== r.mother_id) throw httpError(403, 'subject_mismatch', 'Declared subject must be the mother');
  return { id: r.id, mother_id: r.mother_id, father_id: r.father_id, child_gender: r.child_gender, birth_date: r.birth_date, hospital: r.hospital, reported_at: r.created_at };
});

// A newborn was registered → open a health file with the birth vaccinations (idempotent).
onEvents('health-newborns', {
  'registry.person.born': async (e) => {
    const { national_id, mother_id, birth_date, notification_id } = e.data;
    await tx(db, async (c) => {
      const mother = (await c.query('SELECT primary_clinic FROM health_records WHERE national_id = $1', [mother_id])).rows[0];
      const ins = await c.query(
        `INSERT INTO health_records (national_id, blood_type, allergies, chronic_conditions, primary_clinic, organ_donor)
         VALUES ($1, 'unknown', '[]', '[]', $2, false) ON CONFLICT DO NOTHING`,
        [national_id, mother?.primary_clinic ?? HOSPITAL],
      );
      if (!ins.rowCount) return;
      for (const name of [{ ar: 'لقاح السل (BCG)', en: 'BCG (tuberculosis)' }, { ar: 'التهاب الكبد ب — الجرعة الأولى', en: 'Hepatitis B — dose 1' }]) {
        await c.query('INSERT INTO vaccinations (national_id, name, given_on) VALUES ($1,$2,$3)', [national_id, name, birth_date]);
      }
      if (notification_id) await c.query('UPDATE birth_notifications SET child_national_id = $2 WHERE id = $1', [notification_id, national_id]);
      await emitEvent(c, 'health.record.opened', { subjects: [national_id, mother_id], correlationId: e.correlation_id, data: { national_id } });
    });
  },
}, db);
registerRecords(app, db);
startOutboxPump(db);

await start(app);
