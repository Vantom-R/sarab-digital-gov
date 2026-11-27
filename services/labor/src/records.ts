// Ministry of Labor & Social Insurance — record maintenance by Labor staff ("Manage citizen").
//
// Staff keep a person's JOB HISTORY (employer, job title, salary, start / end date). The current
// employment row — status, employer, monthly income, income source — is recomputed from it after every
// change. That row is what the employment credential (and so the bank's income check) is built from, so
// a new job is what a bank sees the next time the citizen shares their employment proof.
// When nobody employs the person today, staff choose what they are (job-seeking, self-employed, student,
// retired) and, for self-employed / retired, the monthly income.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { Db } from '#shared/db.ts';
import { tx } from '#shared/db.ts';
import { httpError } from '#shared/http.ts';
import { requireJisr } from '#shared/jisr.ts';
import { randomId } from '#shared/crypto.ts';
import { emitEvent } from '#shared/events.ts';
import { incomeBracket } from '#shared/seed-ministries.ts';
import { failIf, idx, isDate, JOB_EMPLOYERS, JOB_TITLES, NON_JOB_INCOME, NON_JOB_STATUSES, recordParams, requireRecordStaff, STATUS_NAMES, todayIso, type Problem } from '#shared/records.ts';

const AUD = 'labor';
const SCOPE = 'records.labor';
const JOB_ID = { type: 'string', pattern: '^JOB-[A-Za-z0-9-]{1,40}$' } as const;
const DATE = { type: 'string', format: 'date' } as const;
const jobBody = {
  type: 'object', additionalProperties: false, required: ['employer_index', 'job_title_index', 'monthly_salary', 'start_date'],
  properties: {
    employer_index: idx(JOB_EMPLOYERS), job_title_index: idx(JOB_TITLES), monthly_salary: { type: 'integer', minimum: 1, maximum: 1_000_000 },
    start_date: DATE, end_date: { anyOf: [DATE, { type: 'null' }] },
  },
} as const;
const iso = (d: any) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
const SALARY = { ar: 'راتب', en: 'Salary' };

async function read(q: Db | PoolClient, id: string) {
  const e = (await q.query('SELECT * FROM employment WHERE national_id = $1', [id])).rows[0] ?? null;
  const si = (await q.query('SELECT number, contribution_months, pension FROM social_insurance WHERE national_id = $1', [id])).rows[0] ?? null;
  const { rows: jobs } = await q.query('SELECT * FROM jobs WHERE national_id = $1 ORDER BY start_date DESC', [id]);
  const { rows: benefits } = await q.query('SELECT id, kind, child_id, monthly_amount, starts_on, status, reason FROM benefits WHERE national_id = $1 ORDER BY created_at', [id]);
  const { rows: changes } = await q.query('SELECT action, detail, actor, at FROM record_changes WHERE national_id = $1 ORDER BY id DESC LIMIT 20', [id]);
  const ix = (list: { en: string }[], v: any) => list.findIndex((x) => x.en === v?.en);
  return {
    national_id: id,
    current: e && {
      status: e.status, status_name: e.status_name, employer: e.employer_name ? { name: e.employer_name, sector: e.employer_sector } : null,
      job_title: e.job_title, since: iso(e.since), monthly_income: e.monthly_income, income_bracket: incomeBracket(e.monthly_income), income_source: e.income_source,
    },
    base_status: e?.base_status ?? null, base_income: e?.base_income ?? 0,
    jobs: jobs.map((j) => ({
      id: j.id, employer: j.employer, sector: j.sector, job_title: j.job_title, monthly_salary: j.monthly_salary, start_date: iso(j.start_date), end_date: iso(j.end_date),
      current: iso(j.start_date) <= todayIso() && (!j.end_date || iso(j.end_date) >= todayIso()),
      employer_index: ix(JOB_EMPLOYERS.map((x) => x.name), j.employer), job_title_index: ix(JOB_TITLES, j.job_title),
    })),
    social_insurance: si, benefits, changes,
  };
}

/** Recompute the current-employment row from the job history (and the chosen non-job status). */
async function recompute(c: PoolClient, id: string): Promise<{ status: string; employer: unknown; monthly_income: number }> {
  const cur = (await c.query(
    `SELECT * FROM jobs WHERE national_id = $1 AND start_date <= current_date AND (end_date IS NULL OR end_date >= current_date) ORDER BY start_date DESC LIMIT 1`, [id])).rows[0];
  const e = (await c.query('SELECT * FROM employment WHERE national_id = $1 FOR UPDATE', [id])).rows[0];
  let row: any;
  if (cur) {
    row = { status: 'employed', employer_name: cur.employer, employer_sector: cur.sector, job_title: cur.job_title, since: iso(cur.start_date), monthly_income: cur.monthly_salary, income_source: SALARY };
  } else {
    const base = (e?.base_status ?? (e && e.status !== 'employed' ? e.status : 'job_seeking')) as (typeof NON_JOB_STATUSES)[number] | 'child';
    const income = base === 'self_employed' || base === 'retired' ? (e?.base_income ?? e?.monthly_income ?? 0) : 0;
    row = { status: base, employer_name: null, employer_sector: null, job_title: null, since: null, monthly_income: income, income_source: base === 'child' ? { ar: 'لا يوجد', en: 'None' } : NON_JOB_INCOME[base] };
  }
  await c.query(
    `INSERT INTO employment (national_id, status, status_name, employer_name, employer_sector, job_title, since, monthly_income, income_source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (national_id) DO UPDATE SET status=$2, status_name=$3, employer_name=$4, employer_sector=$5, job_title=$6, since=$7, monthly_income=$8, income_source=$9`,
    [id, row.status, STATUS_NAMES[row.status as keyof typeof STATUS_NAMES], row.employer_name, row.employer_sector, row.job_title, row.since, row.monthly_income, row.income_source]);
  // Social insurance: everyone who has worked has a number; contribution months grow with the job history.
  const { rows: [{ months }] } = await c.query(
    `SELECT coalesce(sum(greatest(0, (extract(year FROM age(least(coalesce(end_date, current_date), current_date), start_date)) * 12
                                     + extract(month FROM age(least(coalesce(end_date, current_date), current_date), start_date)))::int)), 0)::int AS months
       FROM jobs WHERE national_id = $1 AND start_date <= current_date`, [id]);
  const hasJobs = (await c.query('SELECT 1 FROM jobs WHERE national_id = $1', [id])).rowCount;
  if (hasJobs) {
    await c.query(`INSERT INTO social_insurance (national_id, number, contribution_months, pension) VALUES ($1, $2, $3, NULL)
                   ON CONFLICT (national_id) DO UPDATE SET contribution_months = greatest(social_insurance.contribution_months, $3)`,
      [id, `SI-${id.slice(2, 9)}`, months]);
  }
  return { status: row.status, employer: row.employer_name, monthly_income: row.monthly_income };
}

async function checkJob(c: PoolClient, id: string, b: any, exceptJobId: string | null): Promise<void> {
  const problems: Problem[] = [];
  if (!isDate(b.start_date)) problems.push({ field: 'start_date', code: 'invalid_date' });
  else if (b.start_date > todayIso()) problems.push({ field: 'start_date', code: 'in_future' });
  if (b.end_date != null) {
    if (!isDate(b.end_date)) problems.push({ field: 'end_date', code: 'invalid_date' });
    else if (isDate(b.start_date) && b.end_date < b.start_date) problems.push({ field: 'end_date', code: 'before_start' });
  }
  failIf(problems);
  // One job at a time in this register: periods may not overlap.
  const overlap = await c.query(
    `SELECT 1 FROM jobs WHERE national_id = $1 AND id IS DISTINCT FROM $2
       AND daterange(start_date, coalesce(end_date, 'infinity'::date), '[]') && daterange($3::date, coalesce($4::date, 'infinity'::date), '[]')`,
    [id, exceptJobId, b.start_date, b.end_date ?? null]);
  if (overlap.rowCount) failIf([{ field: 'start_date', code: 'overlaps' }], 'This job overlaps another job in the record');
}

export function registerRecords(app: FastifyInstance, db: Db): void {
  const tags = ['record maintenance (via Jisr only)'];
  const sec = [{ jisr: [] }];
  const staff = (req: any, id: string) => { const ctx = requireJisr(req); return requireRecordStaff(ctx, AUD, SCOPE, id).then((actor) => ({ actor, requestId: ctx.requestId })); };
  const change = async (c: PoolClient, id: string, action: string, detail: Record<string, unknown>, actor: string, requestId: string) => {
    const before = (await c.query('SELECT status, employer_name, monthly_income FROM employment WHERE national_id = $1', [id])).rows[0] ?? null;
    const after = await recompute(c, id);
    await c.query('INSERT INTO record_changes (national_id, action, detail, actor, jisr_request_id) VALUES ($1,$2,$3,$4,$5)', [id, action, { ...detail, before, after }, actor, requestId]);
    await emitEvent(c, 'labor.employment.changed', {
      subjects: [id], correlationId: requestId,
      data: { actor, action, job_employer: detail.employer ?? null, job_title: detail.job_title ?? null, end_date: detail.end_date ?? null, status: after.status, employer: after.employer, income_changed: before?.monthly_income !== after.monthly_income || JSON.stringify(before?.employer_name) !== JSON.stringify(after.employer) },
    });
  };
  const jobRow = (b: any) => { const e = JOB_EMPLOYERS[b.employer_index]!; return [e.name, e.sector, JOB_TITLES[b.job_title_index], b.monthly_salary, b.start_date, b.end_date ?? null]; };

  app.get('/x/records/persons/:id', { schema: { tags, security: sec, summary: 'Current employment, job history, social insurance, benefits and recent changes', params: recordParams() } }, async (req) => {
    const { id } = req.params as { id: string };
    await staff(req, id);
    return read(db, id);
  });

  app.post('/x/records/persons/:id/jobs', { schema: { tags, security: sec, summary: 'Add a job (current or past)', params: recordParams(), body: jobBody } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { actor, requestId } = await staff(req, id);
    const b = req.body as any;
    await tx(db, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`jobs:${id}`]);
      await checkJob(c, id, b, null);
      const jobId = `JOB-${randomId(8)}`.replace(/[^A-Za-z0-9-]/g, '');
      await c.query('INSERT INTO jobs (id, national_id, employer, sector, job_title, monthly_salary, start_date, end_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [jobId, id, ...jobRow(b)]);
      await change(c, id, 'job.added', { job_id: jobId, employer: JOB_EMPLOYERS[b.employer_index]!.name, job_title: JOB_TITLES[b.job_title_index], end_date: b.end_date ?? null }, actor, requestId);
    });
    reply.status(201);
    return read(db, id);
  });

  app.put('/x/records/persons/:id/jobs/:jobId', { schema: { tags, security: sec, summary: 'Correct a job, or record that it ended', params: recordParams({ jobId: JOB_ID }), body: jobBody } }, async (req) => {
    const { id, jobId } = req.params as { id: string; jobId: string };
    const { actor, requestId } = await staff(req, id);
    const b = req.body as any;
    await tx(db, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`jobs:${id}`]);
      const old = (await c.query('SELECT end_date FROM jobs WHERE id = $1 AND national_id = $2', [jobId, id])).rows[0];
      if (!old) throw httpError(404, 'not_found', 'No such job for this person');
      await checkJob(c, id, b, jobId);
      await c.query('UPDATE jobs SET employer=$3, sector=$4, job_title=$5, monthly_salary=$6, start_date=$7, end_date=$8 WHERE id=$1 AND national_id=$2', [jobId, id, ...jobRow(b)]);
      await change(c, id, b.end_date && !old.end_date ? 'job.ended' : 'job.updated', { job_id: jobId, employer: JOB_EMPLOYERS[b.employer_index]!.name, job_title: JOB_TITLES[b.job_title_index], end_date: b.end_date ?? null }, actor, requestId);
    });
    return read(db, id);
  });

  app.delete('/x/records/persons/:id/jobs/:jobId', { schema: { tags, security: sec, summary: 'Remove a job recorded in error', params: recordParams({ jobId: JOB_ID }) } }, async (req) => {
    const { id, jobId } = req.params as { id: string; jobId: string };
    const { actor, requestId } = await staff(req, id);
    await tx(db, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`jobs:${id}`]);
      const old = (await c.query('DELETE FROM jobs WHERE id = $1 AND national_id = $2 RETURNING employer', [jobId, id])).rows[0];
      if (!old) throw httpError(404, 'not_found', 'No such job for this person');
      await change(c, id, 'job.removed', { job_id: jobId, employer: old.employer }, actor, requestId);
    });
    return read(db, id);
  });

  app.put('/x/records/persons/:id/status', {
    schema: {
      tags, security: sec, summary: 'What the person is when no job is current (job-seeking, self-employed, student, retired)', params: recordParams(),
      body: { type: 'object', additionalProperties: false, required: ['status', 'monthly_income'], properties: {
        status: { type: 'string', enum: NON_JOB_STATUSES }, monthly_income: { type: 'integer', minimum: 0, maximum: 1_000_000 } } },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const { actor, requestId } = await staff(req, id);
    const b = req.body as { status: (typeof NON_JOB_STATUSES)[number]; monthly_income: number };
    const problems: Problem[] = [];
    if ((b.status === 'job_seeking' || b.status === 'student') && b.monthly_income !== 0) problems.push({ field: 'monthly_income', code: 'must_be_zero' });
    if ((b.status === 'self_employed' || b.status === 'retired') && b.monthly_income < 1) problems.push({ field: 'monthly_income', code: 'required_positive' });
    failIf(problems);
    await tx(db, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`jobs:${id}`]);
      await c.query(`INSERT INTO employment (national_id, status, status_name, monthly_income, income_source, base_status, base_income) VALUES ($1,$2,$3,$4,$5,$2,$4)
                     ON CONFLICT (national_id) DO UPDATE SET base_status = $2, base_income = $4`, [id, b.status, STATUS_NAMES[b.status], b.monthly_income, NON_JOB_INCOME[b.status]]);
      await change(c, id, 'status.set', { status: b.status, monthly_income: b.monthly_income }, actor, requestId);
    });
    return read(db, id);
  });
}

/** One-time: give seeded employed people a job-history entry matching their current job. */
export async function backfillJobs(db: Db): Promise<void> {
  await db.query(
    `INSERT INTO jobs (id, national_id, employer, sector, job_title, monthly_salary, start_date, end_date)
     SELECT 'JOB-' || e.national_id, e.national_id, e.employer_name, e.employer_sector, e.job_title, e.monthly_income, e.since, NULL
       FROM employment e
      WHERE e.status = 'employed' AND e.since IS NOT NULL AND e.employer_name IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.national_id = e.national_id)
        AND NOT EXISTS (SELECT 1 FROM record_changes r WHERE r.national_id = e.national_id)
     ON CONFLICT DO NOTHING`);
}
