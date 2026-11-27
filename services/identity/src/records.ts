// "Manage citizen": ministry staff maintain a person's records in each ministry.
//
// Mithaq holds no copy of these records. For every read or change it calls the ministry that owns the
// record THROUGH JISR (purpose "record-maintenance", on_behalf_of "employee:<staff ID>") with a short-lived
// act-as token it signs for exactly this employee, this person and this ministry (scope records.<ministry>).
// Jisr checks the token and writes the request to the hash-chained audit log — so every look-up and change
// shows in the citizen's "who accessed my data", naming the employee — and the ministry checks it again,
// validates the change, keeps its own change log and announces the life event on the bus.
//
// Permissions: records.civil, records.education, records.labor, records.property, records.health.
// The administrator has all of them (staff.ts); each request acts as an employee of ONE ministry.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '#shared/db.ts';
import { httpError } from '#shared/http.ts';
import { jisrCall } from '#shared/jisr.ts';
import { issueActToken } from '#shared/delegation.ts';
import { CITIES, DISTRICTS, isValidNationalId } from '#shared/seed.ts';
import { RECORD_MINISTRIES, RECORD_OPTIONS, RECORD_PURPOSE, SEARCH_SUBJECT, type RecordMinistry } from '#shared/records.ts';
import { requireSession } from '#shared/session.ts';
import { permissionsOf, requireStaff, type Permission, type Staff } from './staff.ts';

const MINISTRIES = Object.keys(RECORD_MINISTRIES) as RecordMinistry[];
const SEGMENT = /^[\p{L}\p{N} _-]{1,60}$/u;
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

async function staffToken(staff: Staff, ministry: RecordMinistry, subject: string): Promise<string> {
  const m = RECORD_MINISTRIES[ministry];
  return issueActToken({ grantor: subject, delegate: staff.employee_id, scopes: [m.scope], delegationId: `staff:${staff.employee_id}`, audience: m.target, kind: 'employee' });
}

/** One record-maintenance call to a ministry, through Jisr, as this employee. */
export async function recordCall<T = any>(staff: Staff, ministry: RecordMinistry, method: Method, id: string, rest = '', body?: unknown): Promise<T> {
  const m = RECORD_MINISTRIES[ministry];
  return jisrCall<T>({
    target: m.target, method, path: `/x/records/persons/${id}${rest}`, purpose: RECORD_PURPOSE, subject: id,
    onBehalfOf: staff.tag, act: await staffToken(staff, ministry, id), body,
  });
}

// Before any change Mithaq checks that the person exists and reads their birth date (to check dates
// against) from the Civil Registry — an audited read in the employee's name, cached for 10 minutes so a
// burst of edits does not read the record again and again.
const births = new Map<string, { birth_date: string; at: number }>();
async function birthDate(staff: Staff, id: string): Promise<string> {
  const hit = births.get(id);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.birth_date;
  let p: any;
  try {
    p = await recordCall(staff, 'civil', 'GET', id);
  } catch (e: any) {
    if (e?.statusCode === 404) throw httpError(404, 'person_not_found', 'There is no person with this national ID in the Civil Registry');
    throw e;
  }
  births.set(id, { birth_date: p.birth_date, at: Date.now() });
  if (births.size > 5000) births.delete(births.keys().next().value!);
  return p.birth_date;
}

/** Dates in a change must not be before the person was born (plus a plausible minimum age). */
function datesAfterBirth(ministry: RecordMinistry, rest: string, body: any, birth: string) {
  const by = Number(birth.slice(0, 4));
  const problems: { field: string; code: string }[] = [];
  const minYear = (field: string, years: number) => { if (typeof body?.[field] === 'number' && body[field] < by + years) problems.push({ field, code: years ? 'too_young' : 'before_birth' }); };
  const minDate = (field: string, years: number) => {
    const v = body?.[field];
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
    const limit = `${by + years}${birth.slice(4)}`;
    if (v < limit) problems.push({ field, code: years ? 'too_young' : 'before_birth' });
  };
  if (ministry === 'education' && /^\/degrees/.test(rest)) minYear('graduation_year', 14);
  if (ministry === 'education' && rest === '/enrollment') minYear('since_year', 4);
  if (ministry === 'labor' && /^\/jobs/.test(rest)) minDate('start_date', 15);
  if (ministry === 'health' && rest === '/vaccinations') minDate('given_on', 0);
  if (problems.length) throw httpError(422, 'validation_failed', 'A date is before the person could have done this', { problems });
}

export function registerRecords(app: FastifyInstance, db: Db): void {
  const tags = ['manage citizen (staff)'];
  const security = [{ session: [] }];
  /** Staff holding at least one records.* permission. */
  const anyRecords = async (req: FastifyRequest) => {
    const s = await requireSession(req, ['employee', 'admin']);
    const first = MINISTRIES.map((m) => RECORD_MINISTRIES[m].scope as Permission).find((p) => permissionsOf(s.role).includes(p));
    if (!first) throw httpError(403, 'forbidden', 'This needs a records permission of at least one ministry');
    return requireStaff(db, req, first);
  };

  app.get('/api/identity/manage/options', { schema: { tags, security, summary: 'Pick lists for the record forms, and the ministries this staff member may manage' } }, async (req) => {
    const staff = await anyRecords(req);
    return {
      ...RECORD_OPTIONS,
      cities: CITIES.map((name, index) => ({ index, name })), districts: DISTRICTS.map((name, index) => ({ index, name })),
      ministries: MINISTRIES.filter((m) => staff.permissions.includes(RECORD_MINISTRIES[m].scope as Permission)).map((m) => ({ key: m, name: RECORD_MINISTRIES[m].name })),
      employee_id: staff.employee_id,
    };
  });

  app.get('/api/identity/manage/search', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      tags, security, summary: 'Find a person by national ID or by name (Civil Registry, through Jisr)',
      querystring: { type: 'object', required: ['q'], properties: { q: { type: 'string', maxLength: 40 } } },
    },
  }, async (req) => {
    const staff = await requireStaff(db, req, 'records.civil');
    const q = (req.query as { q: string }).q.trim();
    if (/^\d+$/.test(q)) {
      if (!isValidNationalId(q)) throw httpError(422, 'validation_failed', 'Not a valid national ID', { problems: [{ field: 'q', code: 'invalid_id' }] });
      try {
        const p = await recordCall(staff, 'civil', 'GET', q);
        return { results: [{ national_id: p.national_id, name: { ar: `${p.given_name.ar} ${p.family_name.ar}`, en: `${p.given_name.en} ${p.family_name.en}` }, birth_date: p.birth_date, gender: p.gender, status: p.status }] };
      } catch (e: any) {
        if (e?.statusCode === 404) return { results: [] };
        throw e;
      }
    }
    if (q.length < 2) throw httpError(422, 'validation_failed', 'Type at least 2 letters of the name, or a national ID', { problems: [{ field: 'q', code: 'too_short' }] });
    const act = await staffToken(staff, 'civil', SEARCH_SUBJECT);
    return jisrCall({
      target: 'civil-registry', method: 'GET', path: `/x/records/search?q=${encodeURIComponent(q)}`, purpose: RECORD_PURPOSE,
      subject: SEARCH_SUBJECT, onBehalfOf: staff.tag, act,
    });
  });

  app.get('/api/identity/manage/persons/:id/overview', {
    schema: { tags, security, summary: 'One person across every ministry this staff member may manage (each read goes through Jisr and is audited)' },
  }, async (req) => {
    const staff = await anyRecords(req);
    const { id } = req.params as { id: string };
    if (!isValidNationalId(id)) throw httpError(422, 'validation_failed', 'Not a valid national ID', { problems: [{ field: 'id', code: 'invalid_id' }] });
    const allowed = MINISTRIES.filter((m) => staff.permissions.includes(RECORD_MINISTRIES[m].scope as Permission));
    const results = await Promise.all(allowed.map((m) => recordCall(staff, m, 'GET', id).then((data) => ({ m, data })).catch((e) => ({ m, error: { code: e?.code ?? 'error', status: e?.statusCode ?? 500 } }))));
    const civil = results.find((r) => r.m === 'civil');
    if (civil && 'error' in civil && civil.error.status === 404) throw httpError(404, 'person_not_found', 'There is no person with this national ID in the Civil Registry');
    const summary = (m: RecordMinistry, d: any) => {
      switch (m) {
        case 'civil': return { marital_status: d.marital_status, family: d.family.length, city: d.address.city };
        case 'education': return { degrees: d.degrees.length, studying: !!d.enrollment };
        case 'labor': return { status: d.current?.status ?? null, status_name: d.current?.status_name ?? null, employer: d.current?.employer?.name ?? null, jobs: d.jobs.length };
        case 'property': return { vehicles: d.vehicles.length, properties: d.properties.length };
        case 'health': return { exists: d.exists }; // no medical details on the overview
      }
    };
    const person = civil && 'data' in civil ? civil.data : null;
    return {
      national_id: id,
      person: person && { national_id: id, given_name: person.given_name, family_name: person.family_name, birth_date: person.birth_date, gender: person.gender, status: person.status },
      ministries: results.map((r) => ({
        key: r.m, name: RECORD_MINISTRIES[r.m].name,
        ...('data' in r ? { ok: true, summary: summary(r.m, r.data), last_change: r.data.changes?.[0] ?? null } : { ok: false, error: r.error.code }),
      })),
    };
  });

  // ---- Generic forwarder: /api/identity/manage/<ministry>/persons/<id>[/<what>[/<item>[/<action>]]] ----
  const handler = async (req: FastifyRequest) => {
    const { ministry, id } = req.params as { ministry: string; id: string; '*'?: string };
    if (!MINISTRIES.includes(ministry as RecordMinistry)) throw httpError(404, 'not_found', 'No such ministry');
    const m = ministry as RecordMinistry;
    const staff = await requireStaff(db, req, RECORD_MINISTRIES[m].scope as Permission);
    if (!isValidNationalId(id)) throw httpError(422, 'validation_failed', 'Not a valid national ID', { problems: [{ field: 'id', code: 'invalid_id' }] });
    const segs = ((req.params as any)['*'] ?? '').split('/').filter(Boolean);
    if (segs.length > 3 || segs.some((s: string) => !SEGMENT.test(s))) throw httpError(404, 'not_found', 'No such record path');
    const rest = segs.map((s: string) => `/${encodeURIComponent(s)}`).join('');
    const method = req.method as Method;
    if (method !== 'GET') {
      // The person must exist in the Civil Registry, and dates must make sense for their age.
      const birth = await birthDate(staff, id);
      datesAfterBirth(m, segs.length ? `/${segs[0]}` : '', req.body, birth);
    }
    return recordCall(staff, m, method, id, rest, method === 'POST' || method === 'PUT' ? (req.body ?? {}) : undefined);
  };
  const opts = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } }, schema: { tags, security, summary: 'Read or change a record in one ministry (forwarded through Jisr as this employee)' } };
  for (const url of ['/api/identity/manage/:ministry/persons/:id', '/api/identity/manage/:ministry/persons/:id/*']) {
    app.route({ method: ['GET', 'POST', 'PUT', 'DELETE'], url, ...opts, handler });
  }
}
