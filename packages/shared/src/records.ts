// Record maintenance by ministry staff ("Manage citizen").
//
// Each ministry stays the single source of truth for its own records. A staff member (an employee, or the
// administrator, who holds every staff permission) edits them through Mithaq, which calls the ministry
// THROUGH JISR with purpose "record-maintenance" and on_behalf_of "employee:<staff ID>". Every such request
// also carries a short-lived act-as token signed by Mithaq:
//     sub = the citizen, act = { kind: 'employee', sub: <staff ID> }, scope = ['records.<ministry>'], aud = <ministry>
// Jisr checks it before forwarding, and the ministry checks it again (defense in depth), so a ministry
// never acts on an unsigned "an employee asked for this".
//
// The pick lists below are shared so that Mithaq (form options) and each ministry (validation) agree.
import type { Bilingual } from './catalog.ts';
import { httpError } from './http.ts';
import { verifyActToken, actorTag } from './delegation.ts';
import type { JisrContext } from './jisr.ts';
import { CITIES } from './seed.ts';
import { ALLERGIES, COLORS, CONDITIONS, EMPLOYERS, FIELDS, GRADES, INSTITUTES, LEVEL_NAMES, MAKES, STATUS_NAMES, UNIS } from './seed-ministries.ts';

export const RECORD_PURPOSE = 'record-maintenance';

/** The ministries a staff member can maintain records in: Mithaq route name → Jisr member + permission. */
export const RECORD_MINISTRIES = {
  civil: { target: 'civil-registry', scope: 'records.civil', name: { ar: 'السجل المدني', en: 'Civil Registry' } },
  education: { target: 'education', scope: 'records.education', name: { ar: 'وزارة التعليم', en: 'Ministry of Education' } },
  labor: { target: 'labor', scope: 'records.labor', name: { ar: 'وزارة العمل والتأمينات الاجتماعية', en: 'Ministry of Labor & Social Insurance' } },
  property: { target: 'property', scope: 'records.property', name: { ar: 'هيئة العقارات والمركبات', en: 'Property & Vehicles Authority' } },
  health: { target: 'health', scope: 'records.health', name: { ar: 'وزارة الصحة', en: 'Ministry of Health' } },
} as const;
export type RecordMinistry = keyof typeof RECORD_MINISTRIES;

/** Subject used in the act-as token for a search that is not about one person yet. */
export const SEARCH_SUBJECT = '*';

/**
 * Target side: the request must be record maintenance by an employee, with a valid Mithaq act-as token
 * for this person, this ministry and this scope. Returns the actor tag ("employee:ADM-0001").
 */
export async function requireRecordStaff(ctx: JisrContext, audience: string, scope: string, subject: string): Promise<string> {
  if (ctx.client !== 'mithaq' || ctx.purpose !== RECORD_PURPOSE) throw httpError(403, 'record_maintenance_only', 'Only ministry staff (through Mithaq) may change records');
  if (ctx.subject !== subject) throw httpError(403, 'subject_mismatch', 'Declared subject does not match the requested person');
  const act = await verifyActToken(ctx.act, { subject, audience, scope });
  if (act.act.kind !== 'employee') throw httpError(403, 'employee_required', 'Only an employee may maintain records');
  const tag = actorTag(act.act);
  if (ctx.onBehalfOf !== tag) throw httpError(403, 'actor_mismatch', 'on_behalf_of does not name the employee in the token');
  return tag;
}

// ---------------- Pick lists (indices are what the API takes) ----------------

const bi = (ar: string, en: string): Bilingual => ({ ar, en });

export const DEGREE_LEVELS = Object.keys(LEVEL_NAMES) as (keyof typeof LEVEL_NAMES)[];
export const INSTITUTIONS: Bilingual[] = [...UNIS, ...INSTITUTES, ...CITIES.map((c) => bi(`ثانوية ${c.ar}`, `${c.en} Secondary School`))];
export const MAJORS: Bilingual[] = [bi('عام', 'General'), ...FIELDS, bi('الرياضيات', 'Mathematics'), bi('الفيزياء', 'Physics')];
export const DEGREE_GRADES: Bilingual[] = [...GRADES, bi('مقبول', 'Pass')];
export const STUDY_STAGES: Bilingual[] = [bi('طالب جامعي', 'University student'), bi('طالب دراسات عليا', 'Postgraduate student'), bi('طالب دبلوم', 'Diploma student')];

export const JOB_EMPLOYERS = EMPLOYERS.map((e) => ({ name: e.name, sector: e.sector }));
export const JOB_TITLES: Bilingual[] = [...new Map(EMPLOYERS.flatMap((e) => e.titles).map((t) => [t.en, t])).values()];
/** What a person is when they have no current job (set by Labor staff). */
export const NON_JOB_STATUSES = ['job_seeking', 'self_employed', 'student', 'retired'] as const;
export const NON_JOB_INCOME: Record<(typeof NON_JOB_STATUSES)[number], Bilingual> = {
  job_seeking: bi('لا يوجد', 'None'), self_employed: bi('دخل عمل حر', 'Business income'),
  student: bi('إعالة أسرية', 'Family support'), retired: bi('معاش تقاعدي', 'Retirement pension'),
};
export { STATUS_NAMES };

export const VEHICLE_MAKES = MAKES.map(([make, models]) => ({ make, models: [...models] }));
export const VEHICLE_COLORS: Bilingual[] = [...COLORS];
export const PROPERTY_TYPES: Bilingual[] = [bi('شقة', 'Apartment'), bi('فيلا', 'Villa'), bi('أرض سكنية', 'Residential land'), bi('محل تجاري', 'Shop')];

export const BLOOD_TYPES = ['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'unknown'] as const;
export const HEALTH_ALLERGIES: Bilingual[] = [...ALLERGIES];
export const HEALTH_CONDITIONS: Bilingual[] = [...CONDITIONS];
export const VACCINES: Bilingual[] = [
  bi('الحصبة والنكاف والحصبة الألمانية', 'MMR'), bi('الكزاز (جرعة منشطة)', 'Tetanus booster'), bi('الإنفلونزا الموسمية', 'Seasonal influenza'),
  bi('التهاب الكبد ب', 'Hepatitis B'), bi('لقاح السل (BCG)', 'BCG (tuberculosis)'),
];
export const CLINICS: Bilingual[] = CITIES.map((c) => bi(`المركز الصحي الرئيسي — ${c.ar}`, `Main Health Centre — ${c.en}`));

// Births: hospitals that report them (Health), and the rules for the name the parents choose (Civil Registry).
export const HOSPITALS: Bilingual[] = CITIES.map((c) => bi(`مستشفى ${c.ar} العام`, `${c.en} General Hospital`));
/** Days the parents have, from the hospital's report, to choose and confirm the baby's name. */
export const NAME_DEADLINE_DAYS = 14;
/** A given name: Arabic letters (and spaces) in Arabic, Latin letters (spaces, hyphen, apostrophe) in English. */
export const NAME_AR = /^[\u0621-\u064A\u0671-\u06D3 ]{2,30}$/u;
export const NAME_EN = /^[A-Za-z][A-Za-z' -]{1,29}$/;
export function nameProblems(n: { ar?: unknown; en?: unknown } | undefined, field = 'given_name'): Problem[] {
  const out: Problem[] = [];
  const ar = typeof n?.ar === 'string' ? n.ar.trim() : '';
  const en = typeof n?.en === 'string' ? n.en.trim() : '';
  if (!ar) out.push({ field: `${field}.ar`, code: 'required' }); else if (!NAME_AR.test(ar) || /  /.test(ar)) out.push({ field: `${field}.ar`, code: 'name_not_arabic' });
  if (!en) out.push({ field: `${field}.en`, code: 'required' }); else if (!NAME_EN.test(en) || /  /.test(en)) out.push({ field: `${field}.en`, code: 'name_not_latin' });
  return out;
}

export const MARITAL_STATUSES = ['single', 'married', 'divorced', 'widowed'] as const;

/** Everything the "Manage citizen" forms offer, in one object (served by Mithaq). */
export const RECORD_OPTIONS = {
  degree_levels: DEGREE_LEVELS.map((l) => ({ value: l, name: LEVEL_NAMES[l] })),
  institutions: INSTITUTIONS, majors: MAJORS, grades: DEGREE_GRADES, study_stages: STUDY_STAGES,
  employers: JOB_EMPLOYERS, job_titles: JOB_TITLES,
  non_job_statuses: NON_JOB_STATUSES.map((s) => ({ value: s, name: STATUS_NAMES[s] })),
  vehicle_makes: VEHICLE_MAKES, vehicle_colors: VEHICLE_COLORS, property_types: PROPERTY_TYPES,
  blood_types: BLOOD_TYPES, allergies: HEALTH_ALLERGIES, conditions: HEALTH_CONDITIONS, vaccines: VACCINES, clinics: CLINICS, hospitals: HOSPITALS,
};

// ---------------- Shared validation helpers ----------------

export interface Problem { field: string; code: string }
export const todayIso = () => new Date().toISOString().slice(0, 10);
/** A real calendar date "YYYY-MM-DD" (JSON-schema "format: date" also checks this; kept for clarity). */
export const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
export function failIf(problems: Problem[], message = 'Some details are not valid'): void {
  if (problems.length) throw httpError(422, 'validation_failed', message, { problems });
}
/** JSON-schema snippets. */
export const ID_SCHEMA = { type: 'string', pattern: '^1\\d{9}$' } as const;
export const idx = (list: readonly unknown[]) => ({ type: 'integer', minimum: 0, maximum: list.length - 1 }) as const;
export const recordParams = (extra: Record<string, unknown> = {}) => ({
  type: 'object', required: ['id', ...Object.keys(extra)], properties: { id: ID_SCHEMA, ...extra },
}) as const;
