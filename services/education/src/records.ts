// Ministry of Education — record maintenance by Education staff ("Manage citizen"): degrees and
// certificates, and current studies. Through Jisr only, with a Mithaq-signed staff token; every change is
// logged here (record_changes), in Jisr's audit chain, and announced on the bus (education.record.changed).
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { Db } from '#shared/db.ts';
import { tx } from '#shared/db.ts';
import { httpError } from '#shared/http.ts';
import { requireJisr } from '#shared/jisr.ts';
import { randomId } from '#shared/crypto.ts';
import { emitEvent } from '#shared/events.ts';
import { LEVEL_NAMES } from '#shared/seed-ministries.ts';
import { DEGREE_GRADES, DEGREE_LEVELS, failIf, idx, INSTITUTIONS, MAJORS, recordParams, requireRecordStaff, STUDY_STAGES } from '#shared/records.ts';

const AUD = 'education';
const SCOPE = 'records.education';
const year = { type: 'integer', minimum: 1940, maximum: 2100 } as const;
const degreeBody = {
  type: 'object', additionalProperties: false, required: ['level', 'institution_index', 'major_index', 'graduation_year', 'grade_index'],
  properties: { level: { type: 'string', enum: DEGREE_LEVELS }, institution_index: idx(INSTITUTIONS), major_index: idx(MAJORS), graduation_year: year, grade_index: idx(DEGREE_GRADES) },
} as const;
const DEGREE_ID = { type: 'string', pattern: '^[A-Za-z0-9-]{1,60}$' } as const;

async function read(q: Db | PoolClient, id: string) {
  const { rows: degrees } = await q.query('SELECT id, level, level_name, field, institution, graduation_year, grade, verified FROM degrees WHERE national_id = $1 ORDER BY graduation_year, id', [id]);
  const enrollment = (await q.query('SELECT institution, stage, since_year FROM enrollments WHERE national_id = $1', [id])).rows[0] ?? null;
  const { rows: changes } = await q.query('SELECT action, detail, actor, at FROM record_changes WHERE national_id = $1 ORDER BY id DESC LIMIT 20', [id]);
  // Indices into the pick lists, so the edit form can be pre-filled (-1 = not in today's lists).
  const ix = (list: { en: string }[], v: any) => list.findIndex((x) => x.en === v?.en);
  return {
    national_id: id,
    degrees: degrees.map((d) => ({ ...d, institution_index: ix(INSTITUTIONS, d.institution), major_index: ix(MAJORS, d.field), grade_index: ix(DEGREE_GRADES, d.grade) })),
    enrollment: enrollment && { ...enrollment, institution_index: ix(INSTITUTIONS, enrollment.institution), stage_index: ix(STUDY_STAGES, enrollment.stage) },
    changes,
  };
}

function checkYears(b: { graduation_year?: number; since_year?: number }, field: 'graduation_year' | 'since_year'): void {
  const y = b[field]!;
  failIf(y > new Date().getUTCFullYear() ? [{ field, code: 'in_future' }] : []);
}

export function registerRecords(app: FastifyInstance, db: Db): void {
  const tags = ['record maintenance (via Jisr only)'];
  const sec = [{ jisr: [] }];
  const staff = (req: any, id: string) => { const ctx = requireJisr(req); return requireRecordStaff(ctx, AUD, SCOPE, id).then((actor) => ({ actor, requestId: ctx.requestId })); };
  const change = async (c: PoolClient, id: string, action: string, detail: Record<string, unknown>, actor: string, requestId: string) => {
    await c.query('INSERT INTO record_changes (national_id, action, detail, actor, jisr_request_id) VALUES ($1,$2,$3,$4,$5)', [id, action, detail, actor, requestId]);
    await emitEvent(c, 'education.record.changed', { subjects: [id], correlationId: requestId, data: { actor, action, ...detail } });
  };
  const degreeRow = (b: any) => [b.level, LEVEL_NAMES[b.level as keyof typeof LEVEL_NAMES], MAJORS[b.major_index], INSTITUTIONS[b.institution_index], b.graduation_year, DEGREE_GRADES[b.grade_index]];

  app.get('/x/records/persons/:id', { schema: { tags, security: sec, summary: 'Degrees, certificates, current studies and recent changes', params: recordParams() } }, async (req) => {
    const { id } = req.params as { id: string };
    await staff(req, id);
    return read(db, id);
  });

  app.post('/x/records/persons/:id/degrees', { schema: { tags, security: sec, summary: 'Record a degree or certificate', params: recordParams(), body: degreeBody } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { actor, requestId } = await staff(req, id);
    const b = req.body as any;
    checkYears(b, 'graduation_year');
    await tx(db, async (c) => {
      const dupe = await c.query("SELECT 1 FROM degrees WHERE national_id = $1 AND level = $2 AND field->>'en' = $3 AND institution->>'en' = $4 AND graduation_year = $5",
        [id, b.level, MAJORS[b.major_index]!.en, INSTITUTIONS[b.institution_index]!.en, b.graduation_year]);
      if (dupe.rowCount) throw httpError(409, 'duplicate_degree', 'This degree is already recorded');
      const degreeId = `${id}-${b.level}-${randomId(4)}`.replace(/[^A-Za-z0-9-]/g, '');
      await c.query('INSERT INTO degrees (id, national_id, level, level_name, field, institution, graduation_year, grade, verified) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)',
        [degreeId, id, ...degreeRow(b)]);
      await change(c, id, 'degree.added', { degree_id: degreeId, level: b.level, level_name: LEVEL_NAMES[b.level as keyof typeof LEVEL_NAMES], graduation_year: b.graduation_year }, actor, requestId);
    });
    reply.status(201);
    return read(db, id);
  });

  app.put('/x/records/persons/:id/degrees/:degreeId', { schema: { tags, security: sec, summary: 'Correct a degree or certificate', params: recordParams({ degreeId: DEGREE_ID }), body: degreeBody } }, async (req) => {
    const { id, degreeId } = req.params as { id: string; degreeId: string };
    const { actor, requestId } = await staff(req, id);
    const b = req.body as any;
    checkYears(b, 'graduation_year');
    await tx(db, async (c) => {
      const old = (await c.query('SELECT level, graduation_year FROM degrees WHERE id = $1 AND national_id = $2 FOR UPDATE', [degreeId, id])).rows[0];
      if (!old) throw httpError(404, 'not_found', 'No such degree for this person');
      await c.query('UPDATE degrees SET level=$3, level_name=$4, field=$5, institution=$6, graduation_year=$7, grade=$8, verified=true WHERE id=$1 AND national_id=$2', [degreeId, id, ...degreeRow(b)]);
      await change(c, id, 'degree.updated', { degree_id: degreeId, level: b.level, level_name: LEVEL_NAMES[b.level as keyof typeof LEVEL_NAMES], graduation_year: b.graduation_year, before: old }, actor, requestId);
    });
    return read(db, id);
  });

  app.delete('/x/records/persons/:id/degrees/:degreeId', { schema: { tags, security: sec, summary: 'Remove a degree or certificate recorded in error', params: recordParams({ degreeId: DEGREE_ID }) } }, async (req) => {
    const { id, degreeId } = req.params as { id: string; degreeId: string };
    const { actor, requestId } = await staff(req, id);
    await tx(db, async (c) => {
      const old = (await c.query('DELETE FROM degrees WHERE id = $1 AND national_id = $2 RETURNING level, level_name, graduation_year', [degreeId, id])).rows[0];
      if (!old) throw httpError(404, 'not_found', 'No such degree for this person');
      await change(c, id, 'degree.removed', { degree_id: degreeId, level: old.level, level_name: old.level_name, graduation_year: old.graduation_year }, actor, requestId);
    });
    return read(db, id);
  });

  app.put('/x/records/persons/:id/enrollment', {
    schema: {
      tags, security: sec, summary: 'Set current studies', params: recordParams(),
      body: { type: 'object', additionalProperties: false, required: ['institution_index', 'stage_index', 'since_year'], properties: { institution_index: idx(INSTITUTIONS), stage_index: idx(STUDY_STAGES), since_year: year } },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const { actor, requestId } = await staff(req, id);
    const b = req.body as { institution_index: number; stage_index: number; since_year: number };
    checkYears(b, 'since_year');
    await tx(db, async (c) => {
      await c.query(`INSERT INTO enrollments (national_id, institution, stage, since_year) VALUES ($1,$2,$3,$4)
                     ON CONFLICT (national_id) DO UPDATE SET institution = $2, stage = $3, since_year = $4`, [id, INSTITUTIONS[b.institution_index], STUDY_STAGES[b.stage_index], b.since_year]);
      await change(c, id, 'enrollment.set', { stage: STUDY_STAGES[b.stage_index], since_year: b.since_year }, actor, requestId);
    });
    return read(db, id);
  });

  app.delete('/x/records/persons/:id/enrollment', { schema: { tags, security: sec, summary: 'End current studies', params: recordParams() } }, async (req) => {
    const { id } = req.params as { id: string };
    const { actor, requestId } = await staff(req, id);
    await tx(db, async (c) => {
      if (!(await c.query('DELETE FROM enrollments WHERE national_id = $1', [id])).rowCount) throw httpError(404, 'not_found', 'No current studies recorded');
      await change(c, id, 'enrollment.ended', {}, actor, requestId);
    });
    return read(db, id);
  });
}
