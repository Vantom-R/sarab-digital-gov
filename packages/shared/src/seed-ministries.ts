// Deterministic FAKE ministry data. Each ministry calls only its own generator, keyed by
// national ID, so data stays consistent across services without any shared database.
// All institutions, employers, vehicle makes and plates are fictional.
import { createHash } from 'node:crypto';
import type { Bilingual } from './catalog.ts';
import { ageOn, population, PERSONAS, type SeedPerson } from './seed.ts';

/** PRNG seeded from (national ID, domain) — independent of population order. */
function rng(id: string, domain: string) {
  let seed = createHash('sha256').update(`${domain}:${id}`).digest().readUInt32BE(0);
  const next = () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (a: number, b: number) => a + Math.floor(next() * (b - a + 1)),
    pick: <T,>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)]!,
    chance: (p: number) => next() < p,
  };
}
/** Persona IDs are assigned while the population is generated, so make sure it ran. */
const personas = () => { population(); return PERSONAS; };
const bi = (ar: string, en: string): Bilingual => ({ ar, en });
const yearOf = (d: string) => Number(d.slice(0, 4));
const today = () => new Date();
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (n: number) => { const d = today(); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

// ---------------- Education ----------------

export interface Degree {
  id: string; level: 'secondary' | 'diploma' | 'bachelor' | 'master' | 'doctorate';
  level_name: Bilingual; field: Bilingual; institution: Bilingual; graduation_year: number; grade: Bilingual;
}
export interface Enrollment { institution: Bilingual; stage: Bilingual; since_year: number }

export const UNIS = [
  bi('جامعة سراب الوطنية', 'Sarab National University'),
  bi('جامعة رأس المرجان للعلوم والتقنية', 'Ras Al-Murjan University of Science & Technology'),
  bi('كلية الواحة', 'Al-Waha College'),
] as const;
export const INSTITUTES = [bi('معهد جبل السحاب التقني', 'Jabal Al-Sahab Technical Institute'), bi('المعهد الصحي بمدينة القمر', 'Madinat Al-Qamar Health Institute')] as const;
export const FIELDS = [
  bi('علوم الحاسب', 'Computer Science'), bi('الطب', 'Medicine'), bi('الهندسة المدنية', 'Civil Engineering'),
  bi('إدارة الأعمال', 'Business Administration'), bi('القانون', 'Law'), bi('التربية', 'Education'),
  bi('الأدب العربي', 'Arabic Literature'), bi('المحاسبة', 'Accounting'), bi('التمريض', 'Nursing'),
] as const;
export const GRADES = [bi('ممتاز', 'Excellent'), bi('جيد جدًا', 'Very good'), bi('جيد', 'Good')] as const;
export const LEVEL_NAMES: Record<Degree['level'], Bilingual> = {
  secondary: bi('الثانوية العامة', 'Secondary school certificate'),
  diploma: bi('دبلوم', 'Diploma'),
  bachelor: bi('بكالوريوس', "Bachelor's degree"),
  master: bi('ماجستير', "Master's degree"),
  doctorate: bi('دكتوراه', 'Doctorate'),
};

export function educationFor(p: SeedPerson): { degrees: Degree[]; enrollment: Enrollment | null } {
  const r = rng(p.national_id, 'education');
  const age = ageOn(p.birth_date);
  const by = yearOf(p.birth_date);
  const degrees: Degree[] = [];
  const add = (level: Degree['level'], year: number, institution: Bilingual, field: Bilingual) =>
    degrees.push({ id: `${p.national_id}-${level}`, level, level_name: LEVEL_NAMES[level], field, institution, graduation_year: year, grade: r.pick(GRADES) });

  if (age < 6) return { degrees, enrollment: null };
  if (age < 18) {
    const stage = age < 12 ? bi('المرحلة الابتدائية', 'Primary school') : age < 15 ? bi('المرحلة المتوسطة', 'Intermediate school') : bi('المرحلة الثانوية', 'Secondary school');
    return { degrees, enrollment: { institution: bi(`مدرسة ${p.address.district.ar}`, `${p.address.district.en} School`), stage, since_year: by + (age < 12 ? 6 : age < 15 ? 12 : 15) } };
  }
  const forced = p.national_id === personas().layla || p.national_id === personas().omar;
  if (!forced && by < 1955 && !r.chance(0.4)) return { degrees, enrollment: null }; // older generation: fewer formal records
  add('secondary', by + 18, bi(`ثانوية ${p.address.city.ar}`, `${p.address.city.en} Secondary School`), bi('عام', 'General'));
  if (forced || r.chance(0.65)) {
    const field = p.national_id === personas().layla ? FIELDS[0] : r.pick(FIELDS);
    if (r.chance(0.2) && !forced) add('diploma', by + 20, r.pick(INSTITUTES), field);
    else if (age >= 22) {
      const uni = r.pick(UNIS);
      add('bachelor', by + 22, uni, field);
      if ((p.national_id === personas().layla || r.chance(0.25)) && age >= 25) add('master', by + 25, r.pick(UNIS), field);
      if (r.chance(0.06) && age >= 30) add('doctorate', by + 29, UNIS[0], field);
    }
  }
  const enrollment = age < 23 && degrees.length === 1 ? { institution: r.pick(UNIS), stage: bi('طالب جامعي', 'University student'), since_year: by + 18 } : null;
  return { degrees, enrollment };
}

// ---------------- Health (minimal, fake) ----------------

export interface HealthSummary {
  blood_type: string;
  allergies: Bilingual[];
  chronic_conditions: Bilingual[];
  vaccinations: { name: Bilingual; date: string }[];
  primary_clinic: Bilingual;
  organ_donor: boolean;
}
export const ALLERGIES = [bi('البنسلين', 'Penicillin'), bi('الفول السوداني', 'Peanuts'), bi('غبار الطلع', 'Pollen'), bi('اللاكتوز', 'Lactose')] as const;
export const CONDITIONS = [bi('ارتفاع ضغط الدم', 'Hypertension'), bi('السكري من النوع الثاني', 'Type 2 diabetes'), bi('الربو', 'Asthma')] as const;

export function healthFor(p: SeedPerson): HealthSummary {
  const r = rng(p.national_id, 'health');
  const age = ageOn(p.birth_date);
  const by = yearOf(p.birth_date);
  const vacc: HealthSummary['vaccinations'] = [];
  if (by + 1 <= today().getUTCFullYear()) vacc.push({ name: bi('الحصبة والنكاف والحصبة الألمانية', 'MMR'), date: `${by + 1}-03-15` });
  if (age >= 12) vacc.push({ name: bi('الكزاز (جرعة منشطة)', 'Tetanus booster'), date: `${Math.min(by + 12 + r.int(0, 20), today().getUTCFullYear())}-09-01` });
  if (age >= 50 || r.chance(0.4)) vacc.push({ name: bi('الإنفلونزا الموسمية', 'Seasonal influenza'), date: `${today().getUTCFullYear() - (r.chance(0.5) ? 0 : 1)}-10-${String(r.int(1, 28)).padStart(2, '0')}` });
  return {
    blood_type: r.pick(['O+', 'A+', 'B+', 'AB+', 'O-', 'A-', 'B-']),
    allergies: r.chance(0.3) ? [r.pick(ALLERGIES)] : [],
    chronic_conditions: age >= 45 && r.chance(0.35) ? [r.pick(CONDITIONS)] : age < 45 && r.chance(0.07) ? [CONDITIONS[2]] : [],
    vaccinations: vacc,
    primary_clinic: bi(`مركز صحي ${p.address.district.ar} — ${p.address.city.ar}`, `${p.address.district.en} Health Centre — ${p.address.city.en}`),
    organ_donor: age >= 18 && r.chance(0.3),
  };
}

// ---------------- Labor & Social Insurance ----------------

export type EmploymentStatus = 'employed' | 'self_employed' | 'student' | 'retired' | 'job_seeking' | 'child';
export interface Employment {
  status: EmploymentStatus;
  status_name: Bilingual;
  employer: { name: Bilingual; sector: 'government' | 'private' } | null;
  job_title: Bilingual | null;
  since: string | null;
  monthly_income: number; // Sarabi dinars (SRD)
  income_source: Bilingual;
  social_insurance: { number: string; contribution_months: number; pension: number | null } | null;
}
export const STATUS_NAMES: Record<EmploymentStatus, Bilingual> = {
  employed: bi('موظف', 'Employed'), self_employed: bi('صاحب عمل حر', 'Self-employed'), student: bi('طالب', 'Student'),
  retired: bi('متقاعد', 'Retired'), job_seeking: bi('باحث عن عمل', 'Job-seeking'), child: bi('قاصر', 'Minor'),
};
export const EMPLOYERS: { name: Bilingual; sector: 'government' | 'private'; titles: Bilingual[] }[] = [
  { name: bi('شركة سراب للاتصالات', 'Sarab Telecom Company'), sector: 'private', titles: [bi('مهندس شبكات', 'Network engineer'), bi('مطوّر برمجيات', 'Software developer'), bi('مدير مشروع', 'Project manager')] },
  { name: bi('مستشفى واحة النخيل العام', 'Wahat Al-Nakheel General Hospital'), sector: 'government', titles: [bi('طبيب', 'Physician'), bi('ممرض', 'Nurse'), bi('صيدلي', 'Pharmacist')] },
  { name: bi('وزارة التعليم', 'Ministry of Education'), sector: 'government', titles: [bi('معلم', 'Teacher'), bi('مشرف تربوي', 'Education supervisor')] },
  { name: bi('شركة المرجان للطاقة', 'Al-Murjan Energy Company'), sector: 'private', titles: [bi('فني صيانة', 'Maintenance technician'), bi('محاسب', 'Accountant'), bi('مهندس', 'Engineer')] },
  { name: bi('مطاعم جبل السحاب', 'Jabal Al-Sahab Restaurants'), sector: 'private', titles: [bi('مدير فرع', 'Branch manager'), bi('طاهٍ', 'Chef')] },
  { name: bi('بلدية مدينة القمر', 'Madinat Al-Qamar Municipality'), sector: 'government', titles: [bi('مخطط عمراني', 'Urban planner'), bi('موظف إداري', 'Administrative officer')] },
];

export function employmentFor(p: SeedPerson): Employment {
  const r = rng(p.national_id, 'labor');
  const age = ageOn(p.birth_date);
  const insurance = (months: number, pension: number | null) => ({ number: `SI-${p.national_id.slice(2, 9)}`, contribution_months: months, pension });
  const base = { employer: null, job_title: null, since: null } as const;
  if (age < 16) return { ...base, status: 'child', status_name: STATUS_NAMES.child, monthly_income: 0, income_source: bi('لا يوجد', 'None'), social_insurance: null };
  if (age < 22 && p.national_id !== personas().layla) return { ...base, status: 'student', status_name: STATUS_NAMES.student, monthly_income: 0, income_source: bi('إعالة أسرية', 'Family support'), social_insurance: null };
  if (age >= 63) {
    const pension = r.int(5, 14) * 500;
    return { ...base, status: 'retired', status_name: STATUS_NAMES.retired, monthly_income: pension, income_source: bi('معاش تقاعدي', 'Retirement pension'), social_insurance: insurance(r.int(300, 460), pension) };
  }
  if (p.national_id === personas().layla) {
    const e = EMPLOYERS[0]!;
    return { status: 'employed', status_name: STATUS_NAMES.employed, employer: { name: e.name, sector: e.sector }, job_title: e.titles[1]!, since: '2016-02-01', monthly_income: 14_500, income_source: bi('راتب', 'Salary'), social_insurance: insurance(118, null) };
  }
  const roll = r.next();
  if (roll < 0.1) return { ...base, status: 'job_seeking', status_name: STATUS_NAMES.job_seeking, monthly_income: 0, income_source: bi('لا يوجد', 'None'), social_insurance: insurance(r.int(0, 60), null) };
  if (roll < 0.22) return { ...base, status: 'self_employed', status_name: STATUS_NAMES.self_employed, monthly_income: r.int(6, 40) * 500, income_source: bi('دخل عمل حر', 'Business income'), social_insurance: insurance(r.int(12, 240), null) };
  const e = r.pick(EMPLOYERS);
  const startYear = Math.max(yearOf(p.birth_date) + 22, today().getUTCFullYear() - r.int(1, 20));
  return {
    status: 'employed', status_name: STATUS_NAMES.employed, employer: { name: e.name, sector: e.sector }, job_title: r.pick(e.titles),
    since: `${startYear}-${String(r.int(1, 12)).padStart(2, '0')}-01`, monthly_income: r.int(8, 60) * 500,
    income_source: bi('راتب', 'Salary'), social_insurance: insurance((today().getUTCFullYear() - startYear) * 12, null),
  };
}

/** Coarse bracket — a proof instead of the exact salary. */
export function incomeBracket(monthly: number): Bilingual {
  if (monthly <= 0) return bi('لا يوجد دخل', 'No income');
  if (monthly < 5_000) return bi('أقل من 5,000 دينار', 'Under 5,000 SRD');
  if (monthly < 10_000) return bi('5,000 – 10,000 دينار', '5,000 – 10,000 SRD');
  if (monthly < 20_000) return bi('10,000 – 20,000 دينار', '10,000 – 20,000 SRD');
  return bi('أكثر من 20,000 دينار', 'Over 20,000 SRD');
}

// ---------------- Property & Vehicles ----------------

export interface Vehicle {
  plate: string; make: string; model: string; year: number; color: Bilingual;
  registration_expiry: string; status: 'valid' | 'expiring_soon' | 'expired';
}
export interface PropertyDeed { deed_no: string; type: Bilingual; city: Bilingual; district: Bilingual; area_m2: number; share_percent: number }

export const MAKES = [['Najm', ['Sahm', 'Rihla', 'Barq']], ['Falak', ['Madar', 'Kawkab']], ['Sahra Motors', ['Kathib', 'Wadi', 'Ghazal']]] as const;
export const COLORS = [bi('أبيض', 'White'), bi('فضي', 'Silver'), bi('أسود', 'Black'), bi('رملي', 'Sand'), bi('أزرق', 'Blue')] as const;
export const PLATE_LETTERS = ['س ر ب', 'ن خ ل', 'م ر ج', 'ق م ر', 'ر ي م'] as const;

function vehicleStatus(expiry: string): Vehicle['status'] {
  const days = (new Date(`${expiry}T00:00:00Z`).getTime() - Date.now()) / 86_400_000;
  return days < 0 ? 'expired' : days <= 30 ? 'expiring_soon' : 'valid';
}

export function assetsFor(p: SeedPerson): { vehicles: Vehicle[]; properties: PropertyDeed[] } {
  const r = rng(p.national_id, 'property');
  const age = ageOn(p.birth_date);
  const vehicles: Vehicle[] = [];
  const properties: PropertyDeed[] = [];
  if (age < 18) return { vehicles, properties };
  const nVehicles = p.national_id === personas().saleh ? 1 : r.chance(0.7) ? r.int(1, 2) : 0;
  for (let i = 0; i < nVehicles; i++) {
    const [make, models] = r.pick(MAKES);
    // Saleh's registration is about to expire — used for the phase 3 delegation demo.
    const expiry = p.national_id === personas().saleh ? addDays(12) : addDays(r.int(-40, 360));
    vehicles.push({
      plate: `${r.pick(PLATE_LETTERS)} ${r.int(1000, 9999)}`, make, model: r.pick(models), year: r.int(2008, 2026),
      color: r.pick(COLORS), registration_expiry: expiry, status: vehicleStatus(expiry),
    });
  }
  if (age >= 28 && (p.marital_status === 'married' || r.chance(0.3)) && r.chance(0.6)) {
    properties.push({
      deed_no: `DEED-${p.national_id.slice(4, 10)}-${r.int(10, 99)}`,
      type: r.pick([bi('شقة', 'Apartment'), bi('فيلا', 'Villa'), bi('أرض سكنية', 'Residential land')]),
      city: p.address.city, district: p.address.district, area_m2: r.int(9, 60) * 10, share_percent: p.marital_status === 'married' && r.chance(0.5) ? 50 : 100,
    });
  }
  return { vehicles, properties };
}

export const everyone = () => population();
