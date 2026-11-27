// Life events (births: hospital report → parents name the baby → registration) + the citizen inbox,
// fed by the event bus. The same consumer also queues each event for the operator's Telegram news feed.
import type { FastifyInstance } from 'fastify';
import type { Db } from '#shared/db.ts';
import { S } from '#shared/http.ts';
import { requireSession } from '#shared/session.ts';
import { onEvents, type SarabEvent } from '#shared/events.ts';
import { EVENT_TYPES } from '#shared/event-policy.ts';
import type { Bilingual } from '#shared/catalog.ts';
import { enqueueFeed } from './feed.ts';

/** The steps of a birth, in order, as the portal timeline shows them. */
export const BIRTH_STEPS = ['health.birth.notified', 'registry.birth.named', 'registry.person.born', 'health.record.opened', 'labor.benefit.awarded'] as const;
/** Events of a birth that are not steps of its own but belong to its timeline. */
const BIRTH_RELATED = ['registry.birth.awaiting_name', 'registry.birth.name_proposed', 'registry.birth.name_overdue'];

const fmtDate = (d: string) => d?.slice(0, 10);

/** Inbox message for one person about one event (null = nothing to tell this person). */
function message(e: SarabEvent, to: string, delegations: Map<string, any>): { title: Bilingual; body: Bilingual; link?: string } | null {
  const d = e.data ?? {};
  const staffId = String(d.actor ?? '').replace('employee:', '');
  const by: Bilingual = { ar: `نفّذ ذلك الموظف ${staffId}.`, en: `Done by employee ${staffId}.` };
  const wrong: Bilingual = { ar: 'إن كان هذا خطأ فراجع مركز خدمة.', en: 'If this is wrong, contact a service centre.' };
  switch (e.type) {
    case 'health.birth.notified':
      return null; // the parents hear about it with the deadline (registry.birth.awaiting_name)
    case 'registry.birth.awaiting_name': {
      const baby: Bilingual = d.child_gender === 'F' ? { ar: 'ابنتك', en: 'daughter' } : { ar: 'ابنك', en: 'son' };
      return {
        title: { ar: 'اختر اسم مولودك', en: 'Choose your baby’s name' },
        body: {
          ar: `أبلغ ${d.hospital?.ar ?? 'المستشفى'} عن ولادة ${baby.ar} بتاريخ ${fmtDate(d.birth_date)}. اختر الاسم وأكّده في «أحداث الحياة» قبل ${fmtDate(d.name_deadline)}.`,
          en: `${d.hospital?.en ?? 'The hospital'} reported the birth of your ${baby.en} on ${fmtDate(d.birth_date)}. Choose and confirm the name in Life events by ${fmtDate(d.name_deadline)}.`,
        },
        link: '/citizen/life-events',
      };
    }
    case 'registry.birth.name_proposed':
      if (to === d.proposed_by) {
        return d.awaiting
          ? { title: { ar: 'أرسلت الاسم المقترح', en: 'Name proposed' }, body: { ar: `اقترحت الاسم «${d.given_name.ar}». ننتظر تأكيد الوالد الآخر (${d.awaiting}).`, en: `You proposed the name “${d.given_name.en}”. Waiting for the other parent (${d.awaiting}) to confirm.` }, link: '/citizen/life-events' }
          : null;
      }
      return d.awaiting === to
        ? { title: { ar: 'يُرجى تأكيد اسم المولود', en: 'Please confirm the baby’s name' }, body: { ar: `اقترح الوالد الآخر (${d.proposed_by}) الاسم «${d.given_name.ar}». أكّده أو اقترح اسمًا آخر في «أحداث الحياة».`, en: `The other parent (${d.proposed_by}) proposed the name “${d.given_name.en}”. Confirm it or propose another in Life events.` }, link: '/citizen/life-events' }
        : { title: { ar: 'اقتُرح اسم للمولود', en: 'A name was proposed' }, body: { ar: `اقترح الوالد الآخر (${d.proposed_by}) الاسم «${d.given_name.ar}» وسيؤكده بنفسه لأنه لا يمكن الوصول إليك في ميثاق.`, en: `The other parent (${d.proposed_by}) proposed “${d.given_name.en}” and confirms it alone, because you could not be reached in Mithaq.` }, link: '/citizen/life-events' };
    case 'registry.birth.named':
      return {
        title: { ar: 'اعتُمد اسم مولودك', en: 'Your baby’s name is confirmed' },
        body: d.how === 'deadline'
          ? { ar: `انتهت المهلة فاعتمد السجل المدني الاسم المقترح: ${d.given_name.ar} ${d.family_name?.ar ?? ''}.`, en: `The deadline passed, so the Civil Registry used the proposed name: ${d.given_name.en} ${d.family_name?.en ?? ''}.` }
          : { ar: `الاسم: ${d.given_name.ar} ${d.family_name?.ar ?? ''}. يجري الآن تسجيل طفلك.`, en: `Name: ${d.given_name.en} ${d.family_name?.en ?? ''}. Your child is being registered now.` },
        link: '/citizen/life-events',
      };
    case 'registry.birth.name_overdue':
      return {
        title: { ar: 'انتهت مهلة تسمية مولودك', en: 'The deadline to name your baby has passed' },
        body: { ar: 'لم يُقترح اسم بعد. ما زال بإمكانك اقتراح الاسم وتأكيده في «أحداث الحياة»، أو مراجعة مركز خدمة.', en: 'No name has been proposed yet. You can still propose and confirm it in Life events, or visit a service centre.' },
        link: '/citizen/life-events',
      };
    case 'registry.person.born':
      if (to === d.national_id) return null;
      return {
        title: { ar: 'سُجّل طفلك في السجل المدني', en: 'Your child is registered' },
        body: { ar: `رقم الهوية الوطنية لطفلك: ${d.national_id}`, en: `Your child’s national ID number: ${d.national_id}` },
        link: '/citizen/life-events',
      };
    case 'health.record.opened':
      if (to === d.national_id) return null;
      return {
        title: { ar: 'فُتح ملف صحي لطفلك', en: 'Health file opened for your child' },
        body: { ar: 'سجّلت وزارة الصحة لقاحات الولادة وجدول التطعيمات.', en: 'The Ministry of Health recorded the birth vaccinations and the vaccination schedule.' },
        link: '/citizen/life-events',
      };
    case 'labor.benefit.awarded':
      if (to !== d.payee_id) return null;
      return {
        title: { ar: 'مُنحت لك إعانة الطفل', en: 'Child benefit awarded' },
        body: { ar: `${d.monthly_amount} دينار سرابي شهريًا، مُنحت تلقائيًا دون تقديم طلب.`, en: `${d.monthly_amount} SRD per month, awarded automatically — no application needed.` },
        link: '/citizen/life-events',
      };
    case 'property.vehicle.renewed': {
      const vehicle = `${d.make} ${d.model} (${d.plate})`;
      if (d.via === 'records') {
        return { title: { ar: 'جدّدت الهيئة رخصة السير', en: 'Registration renewed by the Authority' }, body: { ar: `${vehicle} — سارية حتى ${fmtDate(d.new_expiry)}. ${by.ar}`, en: `${vehicle} — valid until ${fmtDate(d.new_expiry)}. ${by.en}` } };
      }
      if (d.on_behalf_of === 'self') {
        return { title: { ar: 'جُدّدت رخصة السير', en: 'Vehicle registration renewed' }, body: { ar: `${vehicle} — سارية حتى ${fmtDate(d.new_expiry)}.`, en: `${vehicle} — valid until ${fmtDate(d.new_expiry)}.` } };
      }
      if (String(d.on_behalf_of).startsWith('employee:')) {
        return { title: { ar: 'جُدّدت رخصة السير في مركز الخدمة', en: 'Registration renewed at a service centre' }, body: { ar: `${vehicle} — سارية حتى ${fmtDate(d.new_expiry)}. نفّذها الموظف ${d.renewed_by} بحضورك.`, en: `${vehicle} — valid until ${fmtDate(d.new_expiry)}. Done by employee ${d.renewed_by} with you present.` } };
      }
      if (to === d.renewed_by) {
        return { title: { ar: 'جدّدت رخصة سير نيابةً عن غيرك', en: 'You renewed a registration for someone' }, body: { ar: `${vehicle} — سارية حتى ${fmtDate(d.new_expiry)}.`, en: `${vehicle} — valid until ${fmtDate(d.new_expiry)}.` }, link: '/citizen/delegations' };
      }
      return {
        title: { ar: 'جدّد مفوَّضك رخصة سير مركبتك', en: 'Your delegate renewed your vehicle registration' },
        body: { ar: `${vehicle} — سارية حتى ${fmtDate(d.new_expiry)}. قام بذلك صاحب الهوية ${d.renewed_by} بموجب تفويضك.`, en: `${vehicle} — valid until ${fmtDate(d.new_expiry)}. Done by ID ${d.renewed_by} under your delegation.` },
        link: '/citizen/delegations',
      };
    }
    case 'mithaq.delegation.granted':
    case 'mithaq.delegation.revoked': {
      const g = delegations.get(d.delegation_id);
      if (!g) return null;
      const granted = e.type === 'mithaq.delegation.granted';
      if (to === g.delegate) {
        return granted
          ? { title: { ar: 'تم تفويضك', en: 'You have been given a delegation' }, body: { ar: `فوّضك ${g.grantor_name.ar}. يمكنك الآن التصرف نيابةً عنه ضمن الصلاحيات الممنوحة.`, en: `${g.grantor_name.en} authorised you to act for them within the granted permissions.` }, link: '/citizen/delegations' }
          : { title: { ar: 'انتهى تفويض', en: 'A delegation ended' }, body: { ar: `لم يعد بإمكانك التصرف نيابةً عن ${g.grantor_name.ar}.`, en: `You can no longer act for ${g.grantor_name.en}.` }, link: '/citizen/delegations' };
      }
      return granted
        ? { title: { ar: 'أنشأت تفويضًا', en: 'You created a delegation' }, body: { ar: `فوّضت ${g.delegate_name.ar}. يمكنك إلغاؤه في أي وقت.`, en: `You authorised ${g.delegate_name.en}. You can revoke it at any time.` }, link: '/citizen/delegations' }
        : { title: { ar: 'أُلغي التفويض', en: 'Delegation revoked' }, body: { ar: `لم يعد ${g.delegate_name.ar} قادرًا على التصرف نيابةً عنك.`, en: `${g.delegate_name.en} can no longer act for you.` }, link: '/citizen/delegations' };
    }
    case 'mithaq.assisted.action': {
      const what: Record<string, Bilingual> = {
        'session.opened': { ar: 'فتح جلسة خدمة لك', en: 'opened a counter session for you' },
        'record.viewed': { ar: 'اطّلع على سجلك المدني', en: 'viewed your civil record' },
        'assets.viewed': { ar: 'اطّلع على مركباتك وعقاراتك', en: 'viewed your vehicles and properties' },
        'vehicle.renewed': { ar: 'جدّد رخصة سير مركبتك', en: 'renewed your vehicle registration' },
        'delegation.recorded': { ar: 'سجّل تفويضًا باسمك', en: 'recorded a delegation in your name' },
        'session.ended': { ar: 'أنهى جلسة الخدمة', en: 'ended the counter session' },
        'session.expired': { ar: 'لم يُنهِ جلسة الخدمة، فانتهت تلقائيًا بعد 20 دقيقة', en: 'did not end the counter session; it expired automatically after 20 minutes' },
      };
      const w = what[d.action] ?? { ar: d.action, en: d.action };
      return {
        title: { ar: 'إجراء في مركز الخدمة', en: 'Service-centre action' },
        body: { ar: `الموظف ${d.employee_id} (${d.centre?.ar ?? ''}) ${w.ar}.`, en: `Employee ${d.employee_id} (${d.centre?.en ?? ''}) ${w.en}.` },
      };
    }
    case 'registry.person.registered': {
      if (to === d.national_id) return null; // the new citizen hears about it when they activate
      const rel: Bilingual = to === d.spouse_id ? { ar: 'زوجًا/زوجة', en: 'your spouse' } : { ar: 'ابنًا/ابنة', en: 'your child' };
      return {
        title: { ar: 'تحديث في سجل عائلتك', en: 'Your family record was updated' },
        body: {
          ar: `أضاف السجل المدني الشخص صاحب الهوية ${d.national_id} إلى سجل عائلتك بصفته ${rel.ar}. نفّذ ذلك الموظف المختص ${String(d.actor).replace('employee:', '')}. إن كان هذا خطأ فراجع مركز خدمة.`,
          en: `The Civil Registry added national ID ${d.national_id} to your family record as ${rel.en}. Done by registrar ${String(d.actor).replace('employee:', '')}. If this is wrong, contact a service centre.`,
        },
      };
    }
    case 'mithaq.account.activated':
      return {
        title: { ar: 'مرحبًا بك في ميثاق', en: 'Welcome to Mithaq' },
        body: { ar: 'فُعّل حسابك. ننصحك بإضافة مفتاح مرور لتسجيل دخول أسرع وأكثر أمانًا.', en: 'Your account is active. We recommend adding a passkey for faster, safer sign-in.' },
        link: '/citizen',
      };
    case 'mithaq.admin.action':
      if (d.action !== 'revoke_sessions') return null;
      return {
        title: { ar: 'سُجّل خروجك من جميع الأجهزة', en: 'You were signed out everywhere' },
        body: { ar: `أنهى المسؤول ${String(d.actor).replace('employee:', '')} جميع جلساتك (مثلًا بسبب جهاز مفقود).`, en: `Administrator ${String(d.actor).replace('employee:', '')} ended all your sessions (for example, because of a lost device).` },
      };
    // ---- Record maintenance by ministry staff ("Manage citizen") ----
    case 'registry.address.changed':
      return { title: { ar: 'حُدّث عنوانك', en: 'Your address was updated' }, body: { ar: `حدّث السجل المدني عنوانك (المدينة: ${d.city?.ar ?? ''}). ${by.ar} ${wrong.ar}`, en: `The Civil Registry updated your address (city: ${d.city?.en ?? ''}). ${by.en} ${wrong.en}` }, link: '/citizen' };
    case 'registry.marriage.registered': {
      const other = (d.spouses ?? []).find((x: string) => x !== to);
      return { title: { ar: 'سُجّل زواجك', en: 'Your marriage was registered' }, body: { ar: `سُجّل زواجك من صاحب الهوية ${other} بتاريخ ${fmtDate(d.married_on)}. ${by.ar} ${wrong.ar}`, en: `Your marriage to national ID ${other} on ${fmtDate(d.married_on)} was registered. ${by.en} ${wrong.en}` }, link: '/citizen' };
    }
    case 'registry.marriage.dissolved': {
      const other = (d.spouses ?? []).find((x: string) => x !== to);
      return { title: { ar: 'سُجّل الطلاق', en: 'Your divorce was registered' }, body: { ar: `سُجّل الطلاق من صاحب الهوية ${other} بتاريخ ${fmtDate(d.divorced_on)}. ${by.ar} ${wrong.ar}`, en: `Your divorce from national ID ${other} on ${fmtDate(d.divorced_on)} was registered. ${by.en} ${wrong.en}` }, link: '/citizen' };
    }
    case 'registry.family.changed': {
      const what: Record<string, Bilingual> = {
        marital_status: { ar: 'صُحّحت حالتك الاجتماعية', en: 'your marital status was corrected' },
        parents: { ar: 'تغيّر الأب أو الأم المسجَّل', en: 'a recorded father or mother changed' },
        child_linked: { ar: 'رُبط طفل بأحد والديه', en: 'a child was linked to a parent' },
        child_unlinked: { ar: 'أُزيل ربط طفل بأحد والديه', en: 'a child was unlinked from a parent' },
      };
      const w = what[d.change] ?? { ar: d.change, en: d.change };
      return { title: { ar: 'تحديث في سجل عائلتك', en: 'Your family record was updated' }, body: { ar: `في السجل المدني: ${w.ar}. ${by.ar} ${wrong.ar}`, en: `In the Civil Registry, ${w.en}. ${by.en} ${wrong.en}` }, link: '/citizen' };
    }
    case 'education.record.changed': {
      const lv = d.level_name ? `${d.level_name.en}${d.graduation_year ? ` (${d.graduation_year})` : ''}` : '';
      const lvAr = d.level_name ? `${d.level_name.ar}${d.graduation_year ? ` (${d.graduation_year})` : ''}` : '';
      const what: Record<string, Bilingual> = {
        'degree.added': { ar: `أُضيف مؤهل: ${lvAr}`, en: `qualification added: ${lv}` },
        'degree.updated': { ar: `صُحّح مؤهل: ${lvAr}`, en: `qualification corrected: ${lv}` },
        'degree.removed': { ar: `أُزيل مؤهل: ${lvAr}`, en: `qualification removed: ${lv}` },
        'enrollment.set': { ar: 'سُجّلت دراستك الحالية', en: 'your current studies were recorded' },
        'enrollment.ended': { ar: 'انتهى تسجيل دراستك الحالية', en: 'your current studies were ended' },
      };
      const w = what[d.action] ?? { ar: d.action, en: d.action };
      return { title: { ar: 'حُدّث سجلك التعليمي', en: 'Your education record was updated' }, body: { ar: `وزارة التعليم: ${w.ar}. ${by.ar} ${wrong.ar}`, en: `Ministry of Education: ${w.en}. ${by.en} ${wrong.en}` }, link: '/citizen' };
    }
    case 'labor.employment.changed': {
      const emp = d.employer ? { ar: `جهة العمل الحالية: ${d.employer.ar}.`, en: `Current employer: ${d.employer.en}.` } : { ar: 'لا توجد جهة عمل حالية.', en: 'No current employer.' };
      const share = d.income_changed ? { ar: 'من تشاركهم إثبات العمل والدخل (كالبنك) سيرون البيانات الجديدة في المرة القادمة.', en: 'Anyone you share your employment & income proof with (such as a bank) will see the new details next time.' } : { ar: '', en: '' };
      return { title: { ar: 'حُدّث سجل عملك', en: 'Your employment record was updated' }, body: { ar: `وزارة العمل: ${emp.ar} ${share.ar} ${by.ar}`, en: `Ministry of Labor: ${emp.en} ${share.en} ${by.en}` }, link: '/citizen' };
    }
    case 'property.vehicle.registered':
      return { title: { ar: 'سُجّلت مركبة باسمك', en: 'A vehicle was registered to you' }, body: { ar: `${d.make} ${d.model} ${d.year} — اللوحة ${d.plate}، سارية حتى ${fmtDate(d.registration_expiry)}. ${by.ar}`, en: `${d.make} ${d.model} ${d.year} — plate ${d.plate}, valid until ${fmtDate(d.registration_expiry)}. ${by.en}` }, link: '/citizen' };
    case 'property.vehicle.transferred': {
      const vehicle = `${d.make} ${d.model} (${d.plate})`;
      return to === d.to_id
        ? { title: { ar: 'نُقلت إليك ملكية مركبة', en: 'A vehicle was transferred to you' }, body: { ar: `${vehicle} من صاحب الهوية ${d.from_id}. ${by.ar} ${wrong.ar}`, en: `${vehicle}, from national ID ${d.from_id}. ${by.en} ${wrong.en}` }, link: '/citizen' }
        : { title: { ar: 'نُقلت ملكية مركبتك', en: 'Your vehicle was transferred' }, body: { ar: `${vehicle} إلى صاحب الهوية ${d.to_id}. ${by.ar} ${wrong.ar}`, en: `${vehicle}, to national ID ${d.to_id}. ${by.en} ${wrong.en}` }, link: '/citizen' };
    }
    case 'property.record.changed': {
      const what: Record<string, Bilingual> = {
        'vehicle.deregistered': { ar: `أُلغي تسجيل المركبة ${d.make ?? ''} ${d.model ?? ''} (${d.plate ?? ''})`, en: `vehicle ${d.make ?? ''} ${d.model ?? ''} (${d.plate ?? ''}) was deregistered` },
        'property.added': { ar: `سُجّل صك عقار (${d.type?.ar ?? ''}) رقم ${d.deed_no}`, en: `a property deed (${d.type?.en ?? ''}) was recorded, no. ${d.deed_no}` },
        'property.updated': { ar: `صُحّح صك العقار ${d.deed_no}`, en: `property deed ${d.deed_no} was corrected` },
        'property.removed': { ar: `أُزيل صك العقار ${d.deed_no}`, en: `property deed ${d.deed_no} was removed` },
      };
      const w = what[d.action] ?? { ar: d.action, en: d.action };
      return { title: { ar: 'حُدّث سجل المركبات والعقارات', en: 'Your vehicles and property record was updated' }, body: { ar: `هيئة العقارات والمركبات: ${w.ar}. ${by.ar} ${wrong.ar}`, en: `Property & Vehicles Authority: ${w.en}. ${by.en} ${wrong.en}` }, link: '/citizen' };
    }
    case 'health.record.updated':
      if (d.action === 'clinic.reassigned') {
        return { title: { ar: 'تغيّر مركزك الصحي', en: 'Your health centre changed' }, body: { ar: `بعد تغيّر عنوانك أصبح مركزك الصحي: ${d.clinic?.ar ?? ''}.`, en: `After your address changed, your health centre is now: ${d.clinic?.en ?? ''}.` }, link: '/citizen' };
      }
      return { title: { ar: 'حُدّث ملفك الصحي', en: 'Your health record was updated' }, body: { ar: `حدّثت وزارة الصحة ملفك الصحي. ${by.ar} ${wrong.ar}`, en: `The Ministry of Health updated your health record. ${by.en} ${wrong.en}` }, link: '/citizen' };
    default:
      return null;
  }
}

export function registerLifeEvents(app: FastifyInstance, db: Db): void {
  // ---- Bus consumer: inbox + life-event timeline ----
  onEvents('mithaq-inbox', {
    '*': async (e) => {
      // A birth's timeline starts with the hospital's report; every later step joins it.
      if (e.type === 'health.birth.notified') {
        const d = e.data;
        await db.query(
          'INSERT INTO life_events (correlation_id, kind, parties, reported_by, data) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
          [e.correlation_id, 'birth', [d.mother_id, ...(d.father_id ? [d.father_id] : [])], String(d.actor ?? 'hospital'), { child_gender: d.child_gender, birth_date: d.birth_date, hospital: d.hospital }],
        );
      }
      if ((BIRTH_STEPS as readonly string[]).includes(e.type) || BIRTH_RELATED.includes(e.type)) {
        if ((await db.query('SELECT 1 FROM life_events WHERE correlation_id = $1', [e.correlation_id])).rowCount) {
          await db.query(
            'INSERT INTO life_event_steps (correlation_id, type, publisher, at, data) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
            [e.correlation_id, e.type, e.publisher, e.at, e.data ?? {}],
          );
        }
      }
      // A newborn's national ID joins the life event (so both parents see it).
      if (e.type === 'registry.person.born') {
        await db.query('UPDATE life_events SET data = data || $2 WHERE correlation_id = $1', [e.correlation_id, { child_national_id: e.data.national_id }]);
      }
      if (e.type === 'registry.birth.named') {
        await db.query('UPDATE life_events SET data = data || $2 WHERE correlation_id = $1', [e.correlation_id, { child_given_name: e.data.given_name }]);
      }
      const delegations = new Map<string, any>();
      if (e.data?.delegation_id) {
        const r = (await db.query('SELECT * FROM delegations WHERE id = $1', [e.data.delegation_id])).rows[0];
        if (r) delegations.set(r.id, r);
      }
      for (const to of e.subjects) {
        const known = await db.query('SELECT 1 FROM accounts WHERE subject = $1', [to]);
        if (!known.rowCount) continue; // e.g. a newborn has no account
        const m = message(e, to, delegations);
        if (!m) continue;
        await db.query(
          'INSERT INTO notifications (subject, event_id, type, title, body, link, correlation_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
          [to, e.id, e.type, m.title, m.body, m.link ?? null, e.correlation_id],
        );
      }
      // The operator's Telegram news feed (queued; sent by the feed pump, or mocked during tests).
      await enqueueFeed(db, e);
    },
  }, db);

  app.get('/api/identity/me/life-events', {
    schema: { tags: ['life events'], security: [{ session: [] }], summary: 'My life events and how far each one has got' },
  }, async (req) => {
    const s = await requireSession(req, ['citizen']);
    const { rows } = await db.query('SELECT * FROM life_events WHERE $1 = ANY(parties) ORDER BY created_at DESC LIMIT 20', [s.sub]);
    const out = [];
    for (const le of rows) {
      const { rows: steps } = await db.query('SELECT type, publisher, at FROM life_event_steps WHERE correlation_id = $1', [le.correlation_id]);
      const done = new Map(steps.map((x) => [x.type, x]));
      out.push({
        correlation_id: le.correlation_id, kind: le.kind, created_at: le.created_at, data: le.data,
        steps: BIRTH_STEPS.map((type) => ({ type, label: EVENT_TYPES[type]!.label, publisher: EVENT_TYPES[type]!.publisher, done: done.has(type), at: done.get(type)?.at ?? null })),
        complete: BIRTH_STEPS.every((t) => done.has(t)),
      });
    }
    return { life_events: out };
  });

  // ---- Inbox ----
  app.get('/api/identity/me/notifications', {
    schema: { tags: ['inbox'], security: [{ session: [] }], summary: 'My notifications (from life events, delegations, renewals…)' },
  }, async (req) => {
    const s = await requireSession(req, ['citizen']);
    const { rows } = await db.query('SELECT id, type, title, body, link, created_at, read_at FROM notifications WHERE subject = $1 ORDER BY id DESC LIMIT 50', [s.sub]);
    return { notifications: rows.map((r) => ({ ...r, id: Number(r.id) })), unread: rows.filter((r) => !r.read_at).length };
  });

  app.post('/api/identity/me/notifications/read', {
    schema: { tags: ['inbox'], security: [{ session: [] }], summary: 'Mark all my notifications as read', response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } }, 401: S.error } },
  }, async (req) => {
    const s = await requireSession(req, ['citizen']);
    await db.query('UPDATE notifications SET read_at = now() WHERE subject = $1 AND read_at IS NULL', [s.sub]);
    return { ok: true };
  });
}
