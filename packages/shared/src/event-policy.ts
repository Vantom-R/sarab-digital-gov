// Event-bus policy (the "who may publish / who may listen" counterpart of the Jisr access rules).
//
// Design: events are NOTIFICATIONS, not data. An event says "birth notification #42 exists" and names
// the people involved; a subscriber that needs details pulls them through Jisr (signed, policy-checked,
// audited). So the bus never becomes a side channel around the exchange layer.
//
// This file drives three things:
//   1. the NATS server's per-member permissions (scripts/init-secrets.ts writes secrets/nats.conf),
//   2. the JetStream stream + durable consumers that Jisr (the bus operator) creates,
//   3. the subscribers' own check that an event really came from its declared publisher.
import type { Bilingual } from './catalog.ts';

export const STREAM = 'SARAB_EVENTS';
export const SUBJECT_ROOT = 'sarab.events';

export interface EventType {
  /** The ONLY member allowed to publish it (enforced by NATS permissions AND by signature check). */
  publisher: string;
  label: Bilingual;
}

export const EVENT_TYPES: Record<string, EventType> = {
  'health.birth.notified': { publisher: 'health', label: { ar: 'أبلغ المستشفى عن ولادة', en: 'A hospital notified a birth' } },
  'health.record.opened': { publisher: 'health', label: { ar: 'فُتح ملف صحي للمولود', en: 'A health file was opened for the newborn' } },
  'registry.person.born': { publisher: 'civil-registry', label: { ar: 'سُجّل مولود جديد في السجل المدني', en: 'A newborn was entered in the Civil Registry' } },
  'labor.benefit.awarded': { publisher: 'labor', label: { ar: 'مُنحت إعانة الطفل', en: 'Child benefit was awarded' } },
  'property.vehicle.renewed': { publisher: 'property', label: { ar: 'جُدّدت رخصة سير مركبة', en: 'A vehicle registration was renewed' } },
  'mithaq.delegation.granted': { publisher: 'mithaq', label: { ar: 'مُنح تفويض', en: 'A delegation was granted' } },
  'mithaq.delegation.revoked': { publisher: 'mithaq', label: { ar: 'أُلغي تفويض', en: 'A delegation was revoked' } },
  'mithaq.assisted.action': { publisher: 'mithaq', label: { ar: 'إجراء في مركز خدمة بحضورك', en: 'An action at a service centre, in person' } },
  'registry.person.registered': { publisher: 'civil-registry', label: { ar: 'أضاف موظف مختص شخصًا إلى السجل المدني', en: 'A registrar added a person to the Civil Registry' } },
  'mithaq.activation.issued': { publisher: 'mithaq', label: { ar: 'صدر رمز تفعيل حساب', en: 'An account activation code was issued' } },
  'mithaq.account.activated': { publisher: 'mithaq', label: { ar: 'فُعّل حساب مواطن', en: 'A citizen account was activated' } },
  'mithaq.admin.action': { publisher: 'mithaq', label: { ar: 'إجراء إداري على الجلسات', en: 'An administrative action on sessions' } },
  // Record maintenance by ministry staff ("Manage citizen"). data.actor = "employee:<staff ID>".
  'registry.address.changed': { publisher: 'civil-registry', label: { ar: 'تغيّر العنوان في السجل المدني', en: 'An address changed in the Civil Registry' } },
  'registry.marriage.registered': { publisher: 'civil-registry', label: { ar: 'سُجّل زواج', en: 'A marriage was registered' } },
  'registry.marriage.dissolved': { publisher: 'civil-registry', label: { ar: 'سُجّل طلاق', en: 'A divorce was registered' } },
  'registry.family.changed': { publisher: 'civil-registry', label: { ar: 'تغيّرت روابط عائلية أو الحالة الاجتماعية', en: 'Family links or marital status changed' } },
  'education.record.changed': { publisher: 'education', label: { ar: 'تغيّر سجل المؤهلات أو الدراسة', en: 'Qualifications or studies changed' } },
  'labor.employment.changed': { publisher: 'labor', label: { ar: 'تغيّر العمل أو مصدر الدخل', en: 'Employment or income source changed' } },
  'property.vehicle.registered': { publisher: 'property', label: { ar: 'سُجّلت مركبة', en: 'A vehicle was registered' } },
  'property.vehicle.transferred': { publisher: 'property', label: { ar: 'نُقلت ملكية مركبة', en: 'A vehicle changed owner' } },
  'property.record.changed': { publisher: 'property', label: { ar: 'تغيّر سجل المركبات أو العقارات', en: 'Vehicle or property records changed' } },
  'health.record.updated': { publisher: 'health', label: { ar: 'حُدّث الملف الصحي', en: 'A health record was updated' } },
  // Naming a newborn: the hospital reports the birth, the parents choose and confirm the name, then the
  // Civil Registry registers the child (registry.person.born).
  'registry.birth.awaiting_name': { publisher: 'civil-registry', label: { ar: 'السجل المدني بانتظار اسم المولود', en: 'The Civil Registry is waiting for the baby’s name' } },
  'registry.birth.name_proposed': { publisher: 'civil-registry', label: { ar: 'اقترح أحد الوالدين اسمًا للمولود', en: 'A parent proposed a name for the baby' } },
  'registry.birth.named': { publisher: 'civil-registry', label: { ar: 'اعتُمد اسم المولود', en: 'The baby’s name was confirmed' } },
  'registry.birth.name_overdue': { publisher: 'civil-registry', label: { ar: 'انتهت مهلة اختيار اسم المولود', en: 'The deadline to name the baby has passed' } },
};

export const subjectFor = (type: string) => `${SUBJECT_ROOT}.${EVENT_TYPES[type]!.publisher}.${type}`;

export interface Subscription {
  /** JetStream durable consumer name (also used in NATS permissions) */
  consumer: string;
  member: string;
  events: string[];
  description: string;
}

export const SUBSCRIPTIONS: Subscription[] = [
  { consumer: 'registry-births', member: 'civil-registry', events: ['health.birth.notified'], description: 'The Civil Registry registers every birth a hospital notifies' },
  { consumer: 'health-newborns', member: 'health', events: ['registry.person.born'], description: 'Health opens a health file (and vaccination schedule) for every registered newborn' },
  { consumer: 'labor-child-benefit', member: 'labor', events: ['registry.person.born'], description: 'Social Insurance awards child benefit — no application needed' },
  { consumer: 'health-address', member: 'health', events: ['registry.address.changed'], description: 'Health moves a person to the main health centre of their new city (pulling the new address through Jisr)' },
  { consumer: 'mithaq-inbox', member: 'mithaq', events: Object.keys(EVENT_TYPES), description: 'Mithaq tells the people involved what happened (citizen inbox, life-event timeline)' },
  { consumer: 'jisr-audit', member: 'jisr', events: Object.keys(EVENT_TYPES), description: 'Jisr writes every event into the hash-chained audit log' },
];

/** Members that connect to the bus at all. */
export const BUS_MEMBERS = [...new Set([...SUBSCRIPTIONS.map((s) => s.member), ...Object.values(EVENT_TYPES).map((e) => e.publisher)])];

/** NATS permissions for one member — least privilege, generated from the policy above. */
export function natsPermissions(member: string) {
  if (member === 'jisr') {
    // Jisr operates the bus: it creates the stream and consumers (JetStream API) and reads everything for the audit log.
    return { publish: { allow: ['$JS.API.>', '$JS.ACK.>'] }, subscribe: { allow: ['_INBOX.jisr.>'] } };
  }
  const publishes = [...new Set(Object.values(EVENT_TYPES).filter((e) => e.publisher === member).map(() => `${SUBJECT_ROOT}.${member}.>`))];
  const consumers = SUBSCRIPTIONS.filter((s) => s.member === member).map((s) => s.consumer);
  return {
    publish: {
      allow: [
        ...publishes,
        ...consumers.flatMap((c) => [`$JS.API.CONSUMER.INFO.${STREAM}.${c}`, `$JS.API.CONSUMER.MSG.NEXT.${STREAM}.${c}`, `$JS.ACK.${STREAM}.${c}.>`]),
      ],
    },
    subscribe: { allow: [`_INBOX.${member}.>`] },
  };
}
