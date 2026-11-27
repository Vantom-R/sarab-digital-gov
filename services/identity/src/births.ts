// Births in Mithaq: the hospital's report (staff portal) and the parents naming their baby (citizen portal).
//
// Mithaq keeps none of this. The report goes to Health, and the name to the Civil Registry, both through
// Jisr; Mithaq only checks the parents first and tells the Registry whether the other parent can be reached
// (has an activated Mithaq account) — if not, the parent who is signed in confirms the name alone.
import type { FastifyInstance } from 'fastify';
import type { Db } from '#shared/db.ts';
import { httpError } from '#shared/http.ts';
import { jisrCall } from '#shared/jisr.ts';
import { requireSession } from '#shared/session.ts';
import { ageOn, isValidNationalId } from '#shared/seed.ts';
import { HOSPITALS, NAME_DEADLINE_DAYS, failIf, isDate, nameProblems, todayIso, type Problem } from '#shared/records.ts';
import type { Bilingual } from '#shared/catalog.ts';
import { readCivilRecord, fullName, type CivilRecord } from './citizen.ts';
import { requireStaff } from './staff.ts';

const tags = ['life events'];
const BN = { type: 'string', pattern: '^BN-[A-Za-z0-9_-]{4,20}$' } as const;

async function activated(db: Db, subject: string | null): Promise<boolean> {
  if (!subject) return false;
  return !!(await db.query("SELECT 1 FROM accounts WHERE subject = $1 AND kind = 'citizen' AND password_hash IS NOT NULL", [subject])).rowCount;
}

export function registerBirths(app: FastifyInstance, db: Db): void {
  // ---------------- Hospital (staff portal, permission births.report) ----------------
  app.get('/api/identity/staff/births/options', { schema: { tags, security: [{ session: [] }], summary: 'Hospitals a birth can be reported from' } }, async (req) => {
    const staff = await requireStaff(db, req, 'births.report');
    return { hospitals: HOSPITALS, name_deadline_days: NAME_DEADLINE_DAYS, employee_id: staff.employee_id };
  });

  app.post('/api/identity/staff/births', {
    schema: {
      tags, security: [{ session: [] }],
      summary: 'Hospital staff report a birth: mother, father (if declared), sex, date, hospital. No name — the parents choose it.',
      body: {
        type: 'object', required: ['mother_id', 'child_gender', 'birth_date', 'hospital_index'], additionalProperties: false,
        properties: {
          mother_id: { type: 'string', maxLength: 10 }, father_id: { type: ['string', 'null'], maxLength: 10 },
          child_gender: { type: 'string', enum: ['M', 'F'] }, birth_date: { type: 'string', maxLength: 10 },
          hospital_index: { type: 'integer', minimum: 0, maximum: HOSPITALS.length - 1 },
          record_no: { type: ['string', 'null'], maxLength: 40 }, another_baby: { type: 'boolean', default: false },
        },
      },
    },
  }, async (req) => {
    const staff = await requireStaff(db, req, 'births.report');
    const b = req.body as { mother_id: string; father_id?: string | null; child_gender: 'M' | 'F'; birth_date: string; hospital_index: number; record_no?: string | null; another_baby?: boolean };
    const father_id = b.father_id?.trim() || null;
    const problems: Problem[] = [];
    if (!isValidNationalId(b.mother_id)) problems.push({ field: 'mother_id', code: 'invalid_id' });
    if (father_id && !isValidNationalId(father_id)) problems.push({ field: 'father_id', code: 'invalid_id' });
    if (father_id && father_id === b.mother_id) problems.push({ field: 'father_id', code: 'same_person' });
    if (!isDate(b.birth_date)) problems.push({ field: 'birth_date', code: 'invalid_date' });
    else if (b.birth_date > todayIso()) problems.push({ field: 'birth_date', code: 'in_future' });
    else if (Date.parse(`${b.birth_date}T00:00:00Z`) < Date.now() - 60 * 86_400_000) problems.push({ field: 'birth_date', code: 'too_late' });
    if (b.record_no && !/^[A-Za-z0-9 _-]{1,40}$/.test(b.record_no.trim())) problems.push({ field: 'record_no', code: 'invalid_record_no' });
    failIf(problems);

    // Check the parents in the Civil Registry (audited reads, in the employee's name).
    const read = async (id: string, field: string): Promise<CivilRecord | null> => {
      try { return await readCivilRecord(id, 'birth-notification', { onBehalfOf: staff.tag }); } catch (e: any) {
        if (e?.statusCode === 404) { problems.push({ field, code: 'not_found' }); return null; }
        throw e;
      }
    };
    const [mother, father] = await Promise.all([read(b.mother_id, 'mother_id'), father_id ? read(father_id, 'father_id') : null]);
    const gap = (p: CivilRecord) => ageOn(p.birth_date) - ageOn(b.birth_date);
    if (mother) {
      if (mother.gender !== 'F') problems.push({ field: 'mother_id', code: 'wrong_gender' });
      else if (mother.status !== 'alive') problems.push({ field: 'mother_id', code: 'not_alive' });
      else if (gap(mother) < 12) problems.push({ field: 'mother_id', code: 'not_plausible' });
    }
    if (father) {
      if (father.gender !== 'M') problems.push({ field: 'father_id', code: 'wrong_gender' });
      else if (gap(father) < 12) problems.push({ field: 'father_id', code: 'not_plausible' });
    }
    failIf(problems);

    const r = await jisrCall<{ notification_id: string; hospital: Bilingual }>({
      target: 'health', method: 'POST', path: '/x/birth-notifications', purpose: 'birth-notification', subject: b.mother_id, onBehalfOf: staff.tag,
      body: { mother_id: b.mother_id, father_id, child_gender: b.child_gender, birth_date: b.birth_date, hospital_index: b.hospital_index, record_no: b.record_no?.trim() || null, another_baby: !!b.another_baby },
    });
    return {
      notification_id: r.notification_id, hospital: r.hospital, employee_id: staff.employee_id,
      mother: { national_id: b.mother_id, name: fullName(mother!), has_account: await activated(db, b.mother_id) },
      father: father ? { national_id: father_id, name: fullName(father), has_account: await activated(db, father_id) } : null,
    };
  });

  // ---------------- Parents (citizen portal) ----------------
  const births = async (me: string) => (await jisrCall<{ births: any[] }>({
    target: 'civil-registry', method: 'GET', path: `/x/births?parent=${me}`, purpose: 'birth-naming', subject: me, onBehalfOf: 'self',
  })).births;

  /** Adds what THIS parent can do. */
  const forParent = async (b: any, me: string) => {
    const iAmMother = b.mother.national_id === me;
    const other = iAmMother ? b.father : b.mother;
    const otherReachable = await activated(db, other?.national_id ?? null);
    const p = b.proposal;
    return {
      ...b,
      my_role: iAmMother ? 'mother' : 'father',
      other_parent: other ? { ...other, has_account: otherReachable } : null,
      sole_parent: !otherReachable,
      can_confirm: b.status === 'awaiting_name' && !!p && (p.awaiting ? p.awaiting === me : p.proposed_by === me),
      waiting_for_other: b.status === 'awaiting_name' && !!p && !!p.awaiting && p.awaiting !== me,
    };
  };

  app.get('/api/identity/me/births', {
    schema: { tags, security: [{ session: [] }], summary: 'Births of my children: waiting for a name (propose / confirm), or recently registered' },
  }, async (req) => {
    const s = await requireSession(req, ['citizen']);
    const list = await births(s.sub);
    return { births: await Promise.all(list.map((b) => forParent(b, s.sub))), name_deadline_days: NAME_DEADLINE_DAYS };
  });

  app.post('/api/identity/me/births/:nid/name', {
    schema: {
      tags, security: [{ session: [] }], summary: 'Propose the baby’s name (or a different one than the other parent proposed)',
      params: { type: 'object', required: ['nid'], properties: { nid: BN } },
      body: { type: 'object', required: ['given_name'], additionalProperties: false, properties: { given_name: { type: 'object', required: ['ar', 'en'], additionalProperties: false, properties: { ar: { type: 'string', maxLength: 40 }, en: { type: 'string', maxLength: 40 } } } } },
    },
  }, async (req) => {
    const s = await requireSession(req, ['citizen']);
    const { nid } = req.params as { nid: string };
    const { given_name } = req.body as { given_name: Bilingual };
    failIf(nameProblems(given_name));
    const b = (await births(s.sub)).find((x) => x.notification_id === nid);
    if (!b) throw httpError(404, 'not_found', 'No birth for you with this number');
    const other = b.mother.national_id === s.sub ? b.father : b.mother;
    const updated = await jisrCall<any>({
      target: 'civil-registry', method: 'POST', path: `/x/births/${nid}/proposal`, purpose: 'birth-naming', subject: s.sub, onBehalfOf: 'self',
      body: { parent_id: s.sub, given_name, other_parent_unreachable: !!other && !(await activated(db, other.national_id)) },
    });
    return forParent(updated, s.sub);
  });

  app.post('/api/identity/me/births/:nid/confirm', {
    schema: {
      tags, security: [{ session: [] }], summary: 'Confirm the proposed name — the Civil Registry registers the child',
      params: { type: 'object', required: ['nid'], properties: { nid: BN } },
      body: { type: 'object', required: ['proposal_id'], additionalProperties: false, properties: { proposal_id: { type: 'integer', minimum: 1 } } },
    },
  }, async (req) => {
    const s = await requireSession(req, ['citizen']);
    const { nid } = req.params as { nid: string };
    const { proposal_id } = req.body as { proposal_id: number };
    const updated = await jisrCall<any>({
      target: 'civil-registry', method: 'POST', path: `/x/births/${nid}/confirmation`, purpose: 'birth-naming', subject: s.sub, onBehalfOf: 'self',
      body: { parent_id: s.sub, proposal_id },
    });
    return forParent(updated, s.sub);
  });
}
