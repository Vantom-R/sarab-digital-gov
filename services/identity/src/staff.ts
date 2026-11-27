// Staff permissions. Each staff role has a list of permissions; the administrator has EVERY permission
// any staff role has (computed, so a permission added to a role is automatically the admin's too).
// Whoever acts, their own staff ID goes into the audit chain: Jisr requests carry
// on_behalf_of "employee:<staff ID>", and events carry data.actor with the same tag.
import type { FastifyRequest } from 'fastify';
import type { Db } from '#shared/db.ts';
import type { Bilingual } from '#shared/catalog.ts';
import { httpError } from '#shared/http.ts';
import { requireSession } from '#shared/session.ts';
import { employeeTag } from '#shared/delegation.ts';

export const PERMISSIONS = {
  'counter': { ar: 'خدمة المواطن الحاضر في مركز الخدمة', en: 'Serve a citizen in person at a service centre' },
  'registry.register': { ar: 'تسجيل مواطن بالغ جديد في السجل المدني وإصدار رمز التفعيل', en: 'Register a new adult citizen and issue activation codes' },
  'audit': { ar: 'سجل التدقيق والتحقق من السلسلة', en: 'Audit log and chain verification' },
  'sessions.admin': { ar: 'إدارة الجلسات (إنهاء جلسات شخص، الإيقاف الطارئ)', en: 'Session control (sign a person out, emergency switch)' },
  // "Manage citizen": maintain records as an employee of that ministry (each ministry stays the source of truth).
  'records.civil': { ar: 'السجل المدني: العنوان والحالة الاجتماعية والروابط العائلية', en: 'Civil Registry: address, marital status, family links' },
  'records.education': { ar: 'التعليم: المؤهلات والشهادات والدراسة الحالية', en: 'Education: degrees, certificates, current studies' },
  'records.labor': { ar: 'العمل والتأمينات: الوظائف والرواتب ومصدر الدخل', en: 'Labor & Social Insurance: jobs, salaries, income source' },
  'records.property': { ar: 'العقارات والمركبات: تسجيل وتجديد ونقل ملكية', en: 'Property & Vehicles: register, renew, transfer' },
  'records.health': { ar: 'الصحة: الملف الصحي الأساسي والتطعيمات', en: 'Health: basic health record and vaccinations' },
  'births.report': { ar: 'المستشفى: الإبلاغ عن ولادة', en: 'Hospital: report a birth' },
} satisfies Record<string, Bilingual>;
export type Permission = keyof typeof PERMISSIONS;

const ROLE_PERMISSIONS: Record<'employee', Permission[]> = {
  // Service-centre employee: counter service + civil registration (as many real service centres do).
  employee: ['counter', 'registry.register'],
};
const ALL = Object.keys(PERMISSIONS) as Permission[];
export const permissionsOf = (role: string): Permission[] =>
  role === 'admin' ? [...new Set([...ALL, ...Object.values(ROLE_PERMISSIONS).flat()])] : role === 'employee' ? ROLE_PERMISSIONS.employee : [];

export interface Staff { subject: string; role: string; employee_id: string; centre: Bilingual; name: Bilingual; tag: string; permissions: Permission[] }

/** The signed-in staff member, or 403 if they lack the permission. */
export async function requireStaff(db: Db, req: FastifyRequest, permission: Permission): Promise<Staff> {
  const s = await requireSession(req, ['employee', 'admin']);
  const permissions = permissionsOf(s.role);
  if (!permissions.includes(permission)) throw httpError(403, 'forbidden', `This needs the "${permission}" permission`);
  const a = (await db.query('SELECT subject, role, employee_id, centre, staff_name_ar, staff_name_en FROM accounts WHERE subject = $1', [s.sub])).rows[0];
  if (!a?.employee_id) throw httpError(403, 'forbidden', 'Not a staff member');
  return {
    subject: a.subject, role: a.role, employee_id: a.employee_id, centre: a.centre, name: { ar: a.staff_name_ar, en: a.staff_name_en },
    tag: employeeTag(a.employee_id), permissions,
  };
}
