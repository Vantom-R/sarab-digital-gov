// Deterministic FAKE population for the Republic of Sarab.
// Every ministry derives its own slice from this same generator, so national IDs line up
// across services WITHOUT any central database. All names/places are fictional.

import type { Bilingual } from './catalog.ts';

export interface SeedPerson {
  national_id: string;
  given_name: Bilingual;
  family_name: Bilingual;
  gender: 'M' | 'F';
  birth_date: string; // YYYY-MM-DD
  nationality: 'SRB';
  marital_status: 'single' | 'married' | 'widowed';
  address: { city: Bilingual; district: Bilingual; street: string };
  father_id: string | null;
  mother_id: string | null;
  spouse_id: string | null;
  status: 'alive' | 'deceased';
  phone: string;
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Luhn check digit so national IDs are self-validating. */
export function luhnDigit(base: string): string {
  let sum = 0;
  for (let i = 0; i < base.length; i++) {
    let d = Number(base[base.length - 1 - i]);
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
}
export const isValidNationalId = (id: string) => /^1\d{9}$/.test(id) && luhnDigit(id.slice(0, 9)) === id[9];

const MALE: Bilingual[] = [
  ['محمد', 'Mohammed'], ['أحمد', 'Ahmed'], ['خالد', 'Khalid'], ['سالم', 'Salem'], ['فهد', 'Fahad'],
  ['ناصر', 'Nasser'], ['علي', 'Ali'], ['حسن', 'Hassan'], ['إبراهيم', 'Ibrahim'], ['سعيد', 'Saeed'],
  ['طارق', 'Tariq'], ['ماجد', 'Majed'], ['بدر', 'Badr'], ['زياد', 'Ziyad'], ['فيصل', 'Faisal'],
  ['هاني', 'Hani'], ['رائد', 'Raed'], ['كريم', 'Kareem'], ['مازن', 'Mazen'], ['أنس', 'Anas'],
].map(([ar, en]) => ({ ar: ar!, en: en! }));

const FEMALE: Bilingual[] = [
  ['فاطمة', 'Fatima'], ['مريم', 'Maryam'], ['سارة', 'Sara'], ['نورة', 'Noura'], ['هند', 'Hind'],
  ['ريم', 'Reem'], ['أمل', 'Amal'], ['دانة', 'Dana'], ['لمى', 'Lama'], ['جود', 'Jood'],
  ['رهف', 'Rahaf'], ['سلمى', 'Salma'], ['هيا', 'Haya'], ['منى', 'Mona'], ['عائشة', 'Aisha'],
  ['خديجة', 'Khadija'], ['رنا', 'Rana'], ['شهد', 'Shahad'], ['غادة', 'Ghada'], ['بسمة', 'Basma'],
].map(([ar, en]) => ({ ar: ar!, en: en! }));

const FAMILIES: Bilingual[] = [
  ['السحابي', 'Al-Sahabi'], ['القمري', 'Al-Qamari'], ['الريمي', 'Al-Rimi'], ['الساري', 'Al-Sari'],
  ['البحري', 'Al-Bahri'], ['الغيمي', 'Al-Ghaimi'], ['الجبلي', 'Al-Jabali'], ['النسيمي', 'Al-Nasimi'],
  ['الفناري', 'Al-Fanari'], ['اللؤلؤي', "Al-Lu'lu'i"], ['الكثيبي', 'Al-Kathibi'], ['الياسميني', 'Al-Yasmini'],
  ['الواحي', 'Al-Wahi'], ['الشراعي', "Al-Shira'i"],
].map(([ar, en]) => ({ ar: ar!, en: en! }));

export const CITIES: Bilingual[] = [
  ['واحة النخيل', 'Wahat Al-Nakheel'], ['رأس المرجان', 'Ras Al-Murjan'], ['جبل السحاب', 'Jabal Al-Sahab'],
  ['مدينة القمر', 'Madinat Al-Qamar'], ['وادي الريم', 'Wadi Al-Reem'],
].map(([ar, en]) => ({ ar: ar!, en: en! }));

export const DISTRICTS: Bilingual[] = [
  ['الروضة', 'Al-Rawdah'], ['الشاطئ', 'Al-Shati'], ['النور', 'Al-Noor'], ['السلام', 'Al-Salam'],
  ['الزهور', 'Al-Zuhoor'], ['المنارة', 'Al-Manarah'],
].map(([ar, en]) => ({ ar: ar!, en: en! }));

/** Named demo personas (fixed IDs, documented in the README). */
export const PERSONAS = {
  layla: '', omar: '', saleh: '', aminah: '', yousef: '', noor: '',
} as Record<'layla' | 'omar' | 'saleh' | 'aminah' | 'yousef' | 'noor', string>;

let cache: SeedPerson[] | null = null;

export function population(): SeedPerson[] {
  if (cache) return cache;
  const rnd = mulberry32(20261121);
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]!;
  const int = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));
  const date = (yFrom: number, yTo: number) =>
    `${int(yFrom, yTo)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`;

  let seq = 10000001;
  const nextId = () => { const base = `1${seq++}`; return base + luhnDigit(base); };
  const people: SeedPerson[] = [];

  const address = () => ({ city: pick(CITIES), district: pick(DISTRICTS), street: `${int(1, 120)} ${pick(['St', 'Rd', 'Ave'])}` });
  const phone = () => `+999 5${int(0, 9)} ${int(100, 999)} ${int(1000, 9999)}`; // +999 is not a real country code

  const person = (p: Partial<SeedPerson> & Pick<SeedPerson, 'given_name' | 'family_name' | 'gender' | 'birth_date'>): SeedPerson => {
    const full: SeedPerson = {
      national_id: nextId(), nationality: 'SRB', marital_status: 'single', address: address(),
      father_id: null, mother_id: null, spouse_id: null, status: 'alive', phone: phone(), ...p,
    };
    people.push(full);
    return full;
  };
  const marry = (a: SeedPerson, b: SeedPerson) => {
    a.spouse_id = b.national_id; b.spouse_id = a.national_id;
    a.marital_status = b.marital_status = 'married';
    b.address = a.address;
  };

  // ---- Family 1: the documented demo personas ----
  const nakhli = { ar: 'النخلي', en: 'Al-Nakhli' };
  const murjani = { ar: 'المرجاني', en: 'Al-Murjani' };
  const home = { city: CITIES[0]!, district: DISTRICTS[0]!, street: '14 Palm St' };
  const saleh = person({ given_name: { ar: 'صالح', en: 'Saleh' }, family_name: nakhli, gender: 'M', birth_date: '1947-03-09', address: home });
  const aminah = person({ given_name: { ar: 'آمنة', en: 'Aminah' }, family_name: nakhli, gender: 'F', birth_date: '1951-11-22', address: home });
  marry(saleh, aminah);
  const omar = person({ given_name: { ar: 'عمر', en: 'Omar' }, family_name: nakhli, gender: 'M', birth_date: '1980-06-15', father_id: saleh.national_id, mother_id: aminah.national_id, address: { city: CITIES[0]!, district: DISTRICTS[3]!, street: '7 Oasis Rd' } });
  const layla = person({ given_name: { ar: 'ليلى', en: 'Layla' }, family_name: murjani, gender: 'F', birth_date: '1990-01-27' });
  marry(omar, layla);
  const yousef = person({ given_name: { ar: 'يوسف', en: 'Yousef' }, family_name: nakhli, gender: 'M', birth_date: '2010-09-04', father_id: omar.national_id, mother_id: layla.national_id, address: omar.address });
  const noor = person({ given_name: { ar: 'نور', en: 'Noor' }, family_name: nakhli, gender: 'F', birth_date: '2019-04-18', father_id: omar.national_id, mother_id: layla.national_id, address: omar.address });
  Object.assign(PERSONAS, { saleh: saleh.national_id, aminah: aminah.national_id, omar: omar.national_id, layla: layla.national_id, yousef: yousef.national_id, noor: noor.national_id });

  // ---- Generated families until we have 50 people ----
  let f = 0;
  while (people.length < 50) {
    const family = FAMILIES[f++ % FAMILIES.length]!;
    const husband = person({ given_name: pick(MALE), family_name: family, gender: 'M', birth_date: date(1958, 1996) });
    if (rnd() < 0.15 || people.length > 47) continue; // a single adult
    const wife = person({ given_name: pick(FEMALE), family_name: pick(FAMILIES), gender: 'F', birth_date: date(1962, 1999) });
    marry(husband, wife);
    const youngest = Math.max(Number(husband.birth_date.slice(0, 4)), Number(wife.birth_date.slice(0, 4)));
    const kids = Math.min(int(0, 4), 50 - people.length);
    for (let k = 0; k < kids; k++) {
      const male = rnd() < 0.5;
      person({
        given_name: pick(male ? MALE : FEMALE), family_name: family, gender: male ? 'M' : 'F',
        birth_date: date(Math.min(youngest + 22, 2024), Math.min(youngest + 34, 2025)),
        father_id: husband.national_id, mother_id: wife.national_id, address: husband.address,
      });
    }
  }
  cache = people;
  return people;
}

export const personById = (id: string) => population().find((p) => p.national_id === id);

export function ageOn(birthDate: string, on = new Date()): number {
  const b = new Date(`${birthDate}T00:00:00Z`);
  let age = on.getUTCFullYear() - b.getUTCFullYear();
  const m = on.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && on.getUTCDate() < b.getUTCDate())) age--;
  return age;
}
