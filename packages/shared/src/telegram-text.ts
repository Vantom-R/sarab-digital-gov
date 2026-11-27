// The texts that reach the operator's Telegram from Mithaq: one-time codes and news-feed messages.
//
// Mithaq does NOT send text. It sends structured fields (which template, the code, the national ID, the
// employee ID …) and the NOTIFIER builds the message from the fixed templates below, after checking every
// field. So a compromised Mithaq can no longer post any text it likes to the operator's chat: a code
// message always looks like a code message, a feed message always starts with the feed heading, and
// neither can pretend to be an alert, a backup or a maintenance notice (red-team item H, 27 Nov 2026).
// Mithaq uses the same functions to show tests the exact text (test_message) without sending anything.
import { riyadhAr, riyadhEn } from './time.ts';

/** First line of every code message (news-feed messages start with FEED_HEADING instead). */
export const CODE_HEADING = '🔐 رمز تحقق';
export const FEED_HEADING = '📢 خبر حكومي';

// ---------------- one-time codes ----------------
export type CodeTemplate = 'login' | 'staff-login' | 'activation' | 'counter';
export interface CodeRequest {
  template: CodeTemplate;
  code: string;
  expires_at: string;
  /** login, activation, counter: the citizen */
  national_id?: string;
  /** staff-login: the staff username */
  username?: string;
  /** staff-login: the account's staff ID; activation, counter: the employee who asked */
  employee_id?: string;
  /** counter: the employee's service centre */
  centre?: { en: string; ar: string };
}

const NID = /^1\d{9}$/;
const USERNAME = /^[a-z][a-z0-9._-]{1,30}$/;
const EMPLOYEE = /^[A-Z]{2,5}-\d{4}$/;
// Names of places: letters, digits, spaces and a little punctuation. No newline, no link, no emoji.
const PLAIN = /^[\p{L}\p{M}\p{N} .,'’()\-–]{1,80}$/u;
const CODE_FORMAT: Record<CodeTemplate, RegExp> = { login: /^\d{6}$/, 'staff-login': /^\d{6}$/, counter: /^\d{6}$/, activation: /^\d{4} \d{4}$/ };
const MAX_LIFETIME_MS: Record<CodeTemplate, number> = { login: 15 * 60_000, 'staff-login': 15 * 60_000, counter: 15 * 60_000, activation: 8 * 86_400_000 };

/** Checks a code request field by field. Returns the reason it is refused, or null when it is fine. */
export function codeRequestProblem(x: unknown): string | null {
  if (!x || typeof x !== 'object') return 'not an object';
  const r = x as Record<string, unknown>;
  const allowed = new Set(['template', 'code', 'expires_at', 'national_id', 'username', 'employee_id', 'centre', 'lane']);
  for (const k of Object.keys(r)) if (!allowed.has(k)) return `unknown field ${k}`;
  const t = r.template as CodeTemplate;
  if (!(t in CODE_FORMAT)) return 'unknown template';
  if (typeof r.code !== 'string' || !CODE_FORMAT[t].test(r.code)) return 'bad code';
  const exp = typeof r.expires_at === 'string' ? Date.parse(r.expires_at) : NaN;
  if (Number.isNaN(exp) || exp < Date.now() - 60_000 || exp > Date.now() + MAX_LIFETIME_MS[t]) return 'bad expiry';
  const need = (k: string, re: RegExp) => (typeof r[k] === 'string' && re.test(r[k] as string) ? null : `bad ${k}`);
  const none = (...ks: string[]) => ks.find((k) => r[k] !== undefined) ? `field not allowed for ${t}` : null;
  switch (t) {
    case 'login': return need('national_id', NID) ?? none('username', 'employee_id', 'centre');
    case 'staff-login': return need('username', USERNAME) ?? need('employee_id', EMPLOYEE) ?? none('national_id', 'centre');
    case 'activation': return need('national_id', NID) ?? need('employee_id', EMPLOYEE) ?? none('username', 'centre');
    case 'counter': {
      const c = r.centre as { en?: unknown; ar?: unknown } | undefined;
      if (!c || typeof c !== 'object' || Object.keys(c).some((k) => k !== 'en' && k !== 'ar') || typeof c.en !== 'string' || typeof c.ar !== 'string' || !PLAIN.test(c.en) || !PLAIN.test(c.ar)) return 'bad centre';
      return need('national_id', NID) ?? need('employee_id', EMPLOYEE) ?? none('username');
    }
  }
  return 'unknown template';
}

function inWords(d: Date): { en: string; ar: string } {
  const min = Math.max(1, Math.round((d.getTime() - Date.now()) / 60_000));
  if (min < 120) return { en: `in ${min} minute${min === 1 ? '' : 's'}`, ar: `خلال ${min} دقيقة` };
  const days = Math.round(min / 1440);
  if (days >= 1) return { en: `in ${days} day${days === 1 ? '' : 's'}`, ar: `خلال ${days} يوم` };
  return { en: `in ${Math.round(min / 60)} hours`, ar: `خلال ${Math.round(min / 60)} ساعة` };
}

/** The code message, from the fixed templates. `origin` is the public site (PUBLIC_ORIGIN). */
export function codeText(r: CodeRequest, origin: string): string {
  const site = new URL(origin || 'http://localhost').host;
  const nid = r.national_id ?? '';
  const emp = r.employee_id ?? '';
  const t = {
    login: {
      account: { en: `citizen, national ID ${nid}`, ar: `مواطن، رقم الهوية ${nid}` },
      purpose: { en: 'Sign-in code', ar: 'رمز تسجيل الدخول' },
      note: { en: 'If you did not just sign in, change the password.', ar: 'إن لم تكن أنت من يسجّل الدخول الآن فغيّر كلمة المرور.' },
    },
    'staff-login': {
      account: { en: `staff account "${r.username}" (${emp})`, ar: `حساب الموظف «${r.username}» (${emp})` },
      purpose: { en: 'Staff sign-in code', ar: 'رمز دخول الموظف' },
      note: { en: 'If you did not just sign in, change the password.', ar: 'إن لم تكن أنت من يسجّل الدخول الآن فغيّر كلمة المرور.' },
    },
    activation: {
      account: { en: `new citizen, national ID ${nid}`, ar: `مواطن جديد، رقم الهوية ${nid}` },
      purpose: { en: 'Account activation code', ar: 'رمز تفعيل الحساب' },
      note: {
        en: `Registered by ${emp}. Use it on the "Activate your account" page. Never give it to anyone, not even an employee.`,
        ar: `سجّله الموظف ${emp}. استخدمه في صفحة «تفعيل حسابك». لا تعطه لأحد، ولا حتى لموظف.`,
      },
      // The link carries only the national ID (pre-filled); the code is never put in a URL.
      link: { url: `${origin}/activate?nid=${nid}`, en: 'Activate here (your ID is filled in, type only the code)', ar: 'فعّل حسابك من هنا (رقم هويتك مُعبّأ، اكتب الرمز فقط)' },
    },
    counter: {
      account: { en: `citizen, national ID ${nid}`, ar: `مواطن، رقم الهوية ${nid}` },
      purpose: { en: 'Service-centre confirmation code', ar: 'رمز تأكيد مركز الخدمة' },
      note: {
        en: `Employee ${emp} at ${r.centre?.en ?? 'a service centre'} asks to serve you. Tell them this code only if you are at the counter.`,
        ar: `الموظف ${emp} في ${r.centre?.ar ?? 'مركز خدمة'} يطلب خدمتك. أعطه هذا الرمز فقط إن كنت أمامه عند الشباك.`,
      },
    },
  }[r.template] as { account: { en: string; ar: string }; purpose: { en: string; ar: string }; note: { en: string; ar: string }; link?: { url: string; en: string; ar: string } };
  const exp = new Date(r.expires_at);
  const w = inWords(exp);
  return [
    `${CODE_HEADING} | ${t.purpose.ar}`,
    '',
    `${site} — ${t.purpose.en}`,
    `For: ${t.account.en}`,
    `Code: ${r.code}`,
    `Expires: ${riyadhEn(exp)} (${w.en}). Works once.`,
    t.note.en,
    ...(t.link ? [`${t.link.en}: ${t.link.url}`] : []),
    '',
    `${site} — ${t.purpose.ar}`,
    `لـ: ${t.account.ar}`,
    `الرمز: ${r.code}`,
    `ينتهي: ${riyadhAr(exp)} (${w.ar}). يُستخدم مرة واحدة.`,
    t.note.ar,
    ...(t.link ? [`${t.link.ar}: ${t.link.url}`] : []),
  ].join('\n');
}

// ---------------- news feed ----------------
export interface FeedRequest {
  title: string;
  people: { id: string; name: string | null }[];
  lines: string[];
  by: string | null;
  at: string;
}

// One line of free wording: no newline or other control character, so it cannot fake a second heading.
const LINE = (max: number) => (v: unknown) => typeof v === 'string' && v.length >= 1 && v.length <= max && !/[\p{Cc}\p{Zl}\p{Zp}‎‏‪-‮⁦-⁩]/u.test(v);

export function feedRequestProblem(x: unknown): string | null {
  if (!x || typeof x !== 'object') return 'not an object';
  const r = x as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!['title', 'people', 'lines', 'by', 'at'].includes(k)) return `unknown field ${k}`;
  if (!LINE(120)(r.title)) return 'bad title';
  if (!Array.isArray(r.people) || r.people.length > 4) return 'bad people';
  for (const p of r.people as any[]) {
    if (!p || typeof p !== 'object' || Object.keys(p).some((k) => k !== 'id' && k !== 'name') || typeof p.id !== 'string' || !NID.test(p.id) || (p.name !== null && !LINE(80)(p.name))) return 'bad person';
  }
  if (!Array.isArray(r.lines) || r.lines.length > 8 || !(r.lines as unknown[]).every(LINE(200))) return 'bad lines';
  if (r.by !== null && !LINE(120)(r.by)) return 'bad by';
  if (typeof r.at !== 'string' || Number.isNaN(Date.parse(r.at))) return 'bad at';
  return null;
}

export function feedText(r: FeedRequest): string {
  return [
    `${FEED_HEADING} | ${r.title}`,
    ...r.people.map((p) => `👤 ${p.name ?? 'غير معروف'} (${p.id})`),
    ...r.lines.map((l) => `ℹ️ ${l}`),
    `✍️ بواسطة: ${r.by ?? 'جهة حكومية (تلقائيًا)'}`,
    `🕒 ${riyadhAr(r.at)}`,
  ].join('\n').slice(0, 1500);
}
