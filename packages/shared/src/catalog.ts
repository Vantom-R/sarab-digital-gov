// Single source of truth for names/labels shared by every service.
// Everything here is FICTIONAL (Republic of Sarab).

export type Bilingual = { ar: string; en: string };

export type MemberClass = 'GOV' | 'COM';

export interface MemberInfo {
  id: string;
  class: MemberClass;
  sector: string;
  name: Bilingual;
}

// Data Exchange (Jisr) members. Each one gets its own Ed25519 key pair.
export const MEMBERS: MemberInfo[] = [
  { id: 'jisr', class: 'GOV', sector: 'exchange', name: { ar: 'جسر — طبقة تبادل البيانات', en: 'Jisr — Data Exchange Layer' } },
  { id: 'mithaq', class: 'GOV', sector: 'identity', name: { ar: 'ميثاق — الهوية الرقمية', en: 'Mithaq — Digital Identity' } },
  { id: 'civil-registry', class: 'GOV', sector: 'civil', name: { ar: 'السجل المدني', en: 'Civil Registry' } },
  { id: 'idhn', class: 'GOV', sector: 'consent', name: { ar: 'إذن — خدمة الموافقات', en: 'Idhn — Consent Service' } },
  { id: 'bank-alwaha', class: 'COM', sector: 'banking', name: { ar: 'بنك الواحة', en: 'Bank Al-Waha' } },
  // Phase 2 ministries — each the single source of truth for its own data.
  { id: 'education', class: 'GOV', sector: 'education', name: { ar: 'وزارة التعليم', en: 'Ministry of Education' } },
  { id: 'health', class: 'GOV', sector: 'health', name: { ar: 'وزارة الصحة', en: 'Ministry of Health' } },
  { id: 'labor', class: 'GOV', sector: 'labor', name: { ar: 'وزارة العمل والتأمينات الاجتماعية', en: 'Ministry of Labor & Social Insurance' } },
  { id: 'property', class: 'GOV', sector: 'property', name: { ar: 'هيئة العقارات والمركبات', en: 'Property & Vehicles Authority' } },
];

export const memberById = (id: string): MemberInfo | undefined => MEMBERS.find((m) => m.id === id);

// Claims that can be shared about a person (through consent / credentials).
export interface ClaimInfo {
  name: string;
  label: Bilingual;
  description: Bilingual;
  /** true when the claim is a derived proof rather than raw data */
  derived?: boolean;
  /** which credential carries it — and therefore which authority attests it */
  credential: 'pid' | 'employment';
}

/** Credential types and the ONLY member trusted to issue each (verifiers enforce this). */
export const CREDENTIALS = {
  pid: { vct: 'urn:sarab:credential:pid:1', issuer: 'mithaq', name: { ar: 'بيانات الهوية الشخصية', en: 'Personal identification' } },
  employment: { vct: 'urn:sarab:credential:employment:1', issuer: 'labor', name: { ar: 'إثبات العمل والدخل', en: 'Employment & income attestation' } },
} as const;

export const CLAIMS: ClaimInfo[] = [
  { name: 'national_id', label: { ar: 'رقم الهوية الوطنية', en: 'National ID number' }, description: { ar: 'رقم هويتك المكوّن من 10 أرقام.', en: 'Your 10-digit national ID number.' } , credential: 'pid' },
  { name: 'full_name', label: { ar: 'الاسم الكامل', en: 'Full name' }, description: { ar: 'اسمك كما هو مسجل في السجل المدني.', en: 'Your name as recorded in the Civil Registry.' } , credential: 'pid' },
  { name: 'given_name', label: { ar: 'الاسم الأول', en: 'Given name' }, description: { ar: 'اسمك الأول فقط.', en: 'Your first name only.' } , credential: 'pid' },
  { name: 'family_name', label: { ar: 'اسم العائلة', en: 'Family name' }, description: { ar: 'اسم عائلتك فقط.', en: 'Your family name only.' } , credential: 'pid' },
  { name: 'age_over_18', label: { ar: 'هل عمرك 18 سنة أو أكثر؟', en: 'Are you 18 or older?' }, description: { ar: 'إجابة "نعم" أو "لا" فقط. لن يُشارك تاريخ ميلادك.', en: 'Only a "yes" or "no" answer. Your birth date is NOT shared.' }, derived: true , credential: 'pid' },
  { name: 'age_over_21', label: { ar: 'هل عمرك 21 سنة أو أكثر؟', en: 'Are you 21 or older?' }, description: { ar: 'إجابة "نعم" أو "لا" فقط. لن يُشارك تاريخ ميلادك.', en: 'Only a "yes" or "no" answer. Your birth date is NOT shared.' }, derived: true , credential: 'pid' },
  { name: 'birth_date', label: { ar: 'تاريخ الميلاد', en: 'Date of birth' }, description: { ar: 'تاريخ ميلادك الكامل.', en: 'Your full date of birth.' } , credential: 'pid' },
  { name: 'nationality', label: { ar: 'الجنسية', en: 'Nationality' }, description: { ar: 'جنسيتك.', en: 'Your nationality.' } , credential: 'pid' },
  { name: 'gender', label: { ar: 'الجنس', en: 'Gender' }, description: { ar: 'جنسك كما هو مسجل.', en: 'Your recorded gender.' } , credential: 'pid' },
  { name: 'marital_status', label: { ar: 'الحالة الاجتماعية', en: 'Marital status' }, description: { ar: 'حالتك الاجتماعية (أعزب، متزوج...).', en: 'Your marital status (single, married…).' } , credential: 'pid' },
  { name: 'address_city', label: { ar: 'مدينة السكن', en: 'City of residence' }, description: { ar: 'اسم المدينة فقط، دون العنوان الكامل.', en: 'The city only, not your full address.' } , credential: 'pid' },
  { name: 'address_full', label: { ar: 'العنوان الكامل', en: 'Full address' }, description: { ar: 'المدينة والحي والشارع.', en: 'City, district and street.' } , credential: 'pid' },
  // Attested by the Ministry of Labor (its own credential, its own signature).
  { name: 'employment_status', label: { ar: 'الحالة الوظيفية', en: 'Employment status' }, description: { ar: 'موظف، صاحب عمل حر، طالب، متقاعد، أو باحث عن عمل.', en: 'Employed, self-employed, student, retired, or job-seeking.' }, credential: 'employment' },
  { name: 'employer_name', label: { ar: 'جهة العمل', en: 'Employer' }, description: { ar: 'اسم جهة عملك الحالية.', en: 'The name of your current employer.' }, credential: 'employment' },
  { name: 'income_bracket', label: { ar: 'فئة الدخل الشهري', en: 'Monthly income bracket' }, description: { ar: 'نطاق فقط (مثل 10–20 ألف). لن يُشارك راتبك الفعلي.', en: 'A range only (e.g. 10–20k). Your actual salary is NOT shared.' }, derived: true, credential: 'employment' },
  { name: 'monthly_income', label: { ar: 'الراتب الشهري الدقيق', en: 'Exact monthly income' }, description: { ar: 'مبلغ راتبك الشهري بالضبط.', en: 'Your exact monthly salary.' }, credential: 'employment' },
];

export const claimByName = (n: string) => CLAIMS.find((c) => c.name === n);

// Purposes that a Jisr request may declare. Shown to citizens in "who accessed my data".
export const PURPOSES: Record<string, Bilingual> = {
  'authentication': { ar: 'تسجيل دخولك إلى ميثاق', en: 'Signing you in to Mithaq' },
  'citizen-self-service': { ar: 'عرض بياناتك لك بناءً على طلبك', en: 'Showing your own data to you' },
  'credential-issuance': { ar: 'إصدار إثبات رقمي (بيانات اعتماد) باسمك', en: 'Issuing a digital credential in your name' },
  'consent-fulfilment': { ar: 'تنفيذ موافقة منحتها', en: 'Fulfilling a consent you granted' },
  'account-opening': { ar: 'فتح حساب بنكي', en: 'Opening a bank account' },
  'kyc-refresh': { ar: 'تحديث بيانات "اعرف عميلك" لدى البنك', en: 'Bank KYC refresh' },
  'consent-request': { ar: 'طلب موافقتك على مشاركة بيانات', en: 'Requesting your consent to share data' },
  'employment-attestation': { ar: 'إصدار إثبات عمل ودخل باسمك', en: 'Issuing an employment & income attestation in your name' },
  // Phase 3 — life events and delegation
  'birth-notification': { ar: 'إبلاغ المستشفى عن ولادة', en: 'A hospital reporting a birth' },
  'birth-naming': { ar: 'اختيارك اسم مولودك وتأكيده', en: 'Choosing and confirming your baby’s name' },
  'news-feed': { ar: 'نشر خبر الحدث في القناة الحكومية (الاسم فقط)', en: 'Posting the event to the government news feed (name only)' },
  'birth-registration': { ar: 'تسجيل مولود في السجل المدني', en: 'Registering a newborn in the Civil Registry' },
  'benefit-eligibility': { ar: 'التحقق من استحقاق إعانة دون طلب منك', en: 'Checking benefit eligibility (no application needed)' },
  'delegation-check': { ar: 'التحقق من أهليتك لتكون مفوَّضًا', en: 'Checking you can be appointed as a delegate' },
  'delegated-service': { ar: 'شخص فوّضته يتصرف نيابةً عنك', en: 'Someone you authorised acting on your behalf' },
  'assisted-service': { ar: 'موظف مركز خدمة يخدمك بحضورك', en: 'A service-centre employee serving you in person' },
  'civil-registration': { ar: 'تسجيل شخص في السجل المدني بواسطة موظف مختص', en: 'A registrar entering a person in the Civil Registry' },
  'life-event': { ar: 'إخطار الجهات الحكومية بحدث في حياتك', en: 'Notifying government services about a life event' },
  'record-maintenance': { ar: 'موظف في الجهة المختصة يطّلع على سجلك أو يحدّثه', en: 'A ministry employee viewing or updating your record' },
  'ownership-transfer': { ar: 'التحقق من المالك الجديد قبل نقل ملكية مركبة', en: 'Checking the new owner before a vehicle changes hands' },
  'care-assignment': { ar: 'تحديث مركزك الصحي بعد تغيّر عنوانك', en: 'Updating your health centre after your address changed' },
};

/** What a citizen can authorise someone else to do for them (Mithaq delegations). */
export const DELEGATION_SCOPES: Record<string, { label: Bilingual; description: Bilingual }> = {
  'assets.view': {
    label: { ar: 'عرض المركبات والعقارات', en: 'View vehicles and properties' },
    description: { ar: 'يرى المفوَّض مركباتك وعقاراتك المسجلة.', en: 'The delegate can see your registered vehicles and properties.' },
  },
  'vehicles.renew': {
    label: { ar: 'تجديد رخص سير المركبات', en: 'Renew vehicle registrations' },
    description: { ar: 'يجدد المفوَّض رخص سير مركباتك نيابةً عنك (يشمل عرض المركبات).', en: 'The delegate can renew your vehicle registrations for you (includes seeing your vehicles).' },
  },
};

// Regulator-defined allow-lists per private sector (seeded into the consent service).
export interface SectorPolicySeed {
  sector: string;
  regulator: Bilingual;
  title: Bilingual;
  allowed_claims: string[];
  allowed_purposes: string[];
}

export const SECTOR_POLICIES: SectorPolicySeed[] = [
  {
    sector: 'banking',
    regulator: { ar: 'سلطة النقد السرابية', en: 'Sarab Monetary Authority' },
    title: { ar: 'قائمة بيانات "اعرف عميلك" المسموح للبنوك بطلبها', en: 'Data banks may request for KYC' },
    // Income only as a bracket — the exact salary (monthly_income) is deliberately NOT allowed.
    allowed_claims: ['national_id', 'full_name', 'given_name', 'family_name', 'age_over_18', 'nationality', 'address_city', 'employment_status', 'employer_name', 'income_bracket'],
    allowed_purposes: ['account-opening', 'kyc-refresh'],
  },
  {
    sector: 'telecom',
    regulator: { ar: 'هيئة الاتصالات السرابية', en: 'Sarab Communications Authority' },
    title: { ar: 'البيانات المسموح لشركات الاتصالات بطلبها', en: 'Data telecom operators may request' },
    allowed_claims: ['national_id', 'full_name', 'age_over_18'],
    allowed_purposes: ['account-opening'],
  },
];

export const COUNTRY: Bilingual = { ar: 'جمهورية سَراب', en: 'Republic of Sarab' };
