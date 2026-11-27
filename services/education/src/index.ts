// Ministry of Education — qualifications and current enrolment. Reachable only through Jisr.
import { createService, start, httpError, S } from '#shared/http.ts';
import { createDb, migrate, tx } from '#shared/db.ts';
import { installJisrGuard, requireJisr } from '#shared/jisr.ts';
import { population } from '#shared/seed.ts';
import { educationFor } from '#shared/seed-ministries.ts';
import { initEvents, startOutboxPump } from '#shared/events.ts';
import { registerRecords } from './records.ts';

const db = createDb();
await migrate(db, new URL('./schema.sql', import.meta.url));
await initEvents(db);

const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM degrees');
if (n === 0) {
  await tx(db, async (c) => {
    for (const p of population()) {
      const { degrees, enrollment } = educationFor(p);
      for (const d of degrees) {
        await c.query(
          'INSERT INTO degrees (id, national_id, level, level_name, field, institution, graduation_year, grade) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [d.id, p.national_id, d.level, d.level_name, d.field, d.institution, d.graduation_year, d.grade],
        );
      }
      if (enrollment) {
        await c.query('INSERT INTO enrollments (national_id, institution, stage, since_year) VALUES ($1,$2,$3,$4)',
          [p.national_id, enrollment.institution, enrollment.stage, enrollment.since_year]);
      }
    }
  });
}

const app = await createService({
  prefix: 'education',
  title: 'Ministry of Education',
  description: 'Authoritative register of qualifications and current enrolment. Reachable ONLY through Jisr.',
});
await installJisrGuard(app);

app.get('/x/persons/:id/education', {
  schema: {
    tags: ['exchange (via Jisr only)'], summary: "A person's qualifications and current enrolment", security: [{ jisr: [] }],
    params: { type: 'object', properties: { id: { type: 'string', pattern: '^1\\d{9}$' } }, required: ['id'] },
    response: {
      200: {
        type: 'object',
        properties: {
          national_id: { type: 'string' },
          degrees: { type: 'array', items: { type: 'object', properties: {
            id: { type: 'string' }, level: { type: 'string' }, level_name: S.bilingual, field: S.bilingual,
            institution: S.bilingual, graduation_year: { type: 'integer' }, grade: S.bilingual, verified: { type: 'boolean' } } } },
          enrollment: { type: ['object', 'null'], properties: { institution: S.bilingual, stage: S.bilingual, since_year: { type: 'integer' } } },
        },
      },
    },
  },
}, async (req) => {
  const ctx = requireJisr(req);
  const { id } = req.params as { id: string };
  if (ctx.subject !== id) throw httpError(403, 'subject_mismatch', 'Declared subject does not match the requested person');
  const { rows: degrees } = await db.query('SELECT id, level, level_name, field, institution, graduation_year, grade, verified FROM degrees WHERE national_id = $1 ORDER BY graduation_year', [id]);
  const enrollment = (await db.query('SELECT institution, stage, since_year FROM enrollments WHERE national_id = $1', [id])).rows[0] ?? null;
  return { national_id: id, degrees, enrollment };
});

registerRecords(app, db);
startOutboxPump(db);

await start(app);
