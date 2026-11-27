// Government news feed: every life event and registry change is also posted to the operator's Telegram chat
// (same notifier and chat as the one-time codes), in short Arabic messages that start with "📢 خبر حكومي" —
// codes start with "🔐 رمز تحقق", so the two are told apart at a glance.
//
// Each message says what happened, to whom (name + national ID), who did it (the citizen, or the employee
// ID) and when. Names are read from the Civil Registry through Jisr (purpose "news-feed", name only) — so
// those reads show in each citizen's "who accessed my data", like every other read.
//
// Delivery: messages are queued in feed_outbox (Mithaq's database) and sent one at a time, in order, as
// structured fields: the notifier builds the text itself (packages/shared/src/telegram-text.ts). The
// notifier paces everything it sends to the chat (Telegram's limits); when it answers "too fast" the message
// waits and is retried — nothing is dropped. Codes are never queued behind the feed: they go straight out.
//
// Tests never reach Telegram: while a test ticket is valid (make e2e / make a11y mint one, and expire it
// when they finish) or when a name carries a test-run tag, a message is stored as "mocked" and not sent.
// Tests read the mocked messages back through GET /api/identity/test/feed (with the ticket).
//
// New event types are covered automatically: an event without its own wording below gets a generic
// message built from its label in event-policy.ts. Only the types in NOT_IN_FEED are left out.
import { riyadhAr } from '#shared/time.ts';
import { FEED_HEADING, feedText as renderFeed, feedRequestProblem, type FeedRequest } from '#shared/telegram-text.ts';
import type { FastifyInstance } from 'fastify';
import type { Db } from '#shared/db.ts';
import { httpError } from '#shared/http.ts';
import { jisrCall } from '#shared/jisr.ts';
import { sha256hex } from '#shared/crypto.ts';
import { EVENT_TYPES } from '#shared/event-policy.ts';
import type { SarabEvent } from '#shared/events.ts';
import type { Bilingual } from '#shared/catalog.ts';
import { DELEGATION_SCOPES } from '#shared/catalog.ts';

export { FEED_HEADING };

/** Not news: a code is sent on its own; counter-session steps and session control are access, not life events. */
export const NOT_IN_FEED = new Set(['mithaq.activation.issued', 'mithaq.assisted.action', 'mithaq.admin.action']);

const TEST_TAG = /qa[0-9a-f]{6}/;
const date = (d: unknown) => String(d ?? '').slice(0, 10);
const utc = (d: string | Date) => riyadhAr(d);   // shown in Riyadh time
const sex = (g: string) => (g === 'F' ? 'أنثى' : 'ذكر');

// ---- Names (Civil Registry, through Jisr, name only; cached 10 minutes) ----
const names = new Map<string, { name: string | null; at: number }>();
async function nameOf(id: string): Promise<string | null> {
  const hit = names.get(id);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.name;
  let name: string | null = null;
  try {
    const r = await jisrCall<{ name: Bilingual }>({ target: 'civil-registry', method: 'GET', path: `/x/persons/${id}/name`, purpose: 'news-feed', subject: id, onBehalfOf: 'self' });
    name = r.name.ar;
  } catch { /* unknown person (e.g. removed) — the ID alone is shown */ }
  names.set(id, { name, at: Date.now() });
  if (names.size > 5000) names.delete(names.keys().next().value!);
  return name;
}

interface Draft { title: string; people: string[]; lines?: string[]; by: string | null }

function actorText(actor: unknown): string | null {
  const a = String(actor ?? '');
  if (a.startsWith('employee:')) return `الموظف ${a.slice(9)}`;
  return null;
}

/** What to say about one event (null = not news). `db` is Mithaq's (delegations live here). */
async function draft(db: Db, e: SarabEvent): Promise<Draft | null> {
  if (NOT_IN_FEED.has(e.type)) return null;
  const d = e.data ?? {};
  const emp = actorText(d.actor);
  const citizen = (id: string) => `المواطن نفسه (${id})`;
  switch (e.type) {
    case 'registry.person.registered':
      return { title: '🆕 تسجيل مواطن جديد في السجل المدني', people: [d.national_id], by: emp };
    case 'mithaq.account.activated':
      return { title: '✅ تفعيل حساب في ميثاق', people: e.subjects.slice(0, 1), by: citizen(e.subjects[0]!) };
    case 'registry.marriage.registered':
      return { title: '💍 تسجيل زواج', people: d.spouses ?? e.subjects, lines: [`تاريخ الزواج: ${date(d.married_on)}`], by: emp };
    case 'registry.marriage.dissolved':
      return { title: '📄 تسجيل طلاق', people: d.spouses ?? e.subjects, lines: [`تاريخ الطلاق: ${date(d.divorced_on)}`], by: emp };
    case 'health.birth.notified':
      return { title: '🏥 إبلاغ المستشفى عن ولادة', people: [d.mother_id, d.father_id].filter(Boolean), lines: [`المولود: ${sex(d.child_gender)}، بتاريخ ${date(d.birth_date)}`, ...(d.hospital ? [`المستشفى: ${d.hospital.ar}`] : [])], by: emp };
    case 'registry.birth.awaiting_name':
      return { title: '⏳ السجل المدني بانتظار اسم المولود', people: [d.mother_id, d.father_id].filter(Boolean), lines: [`المهلة حتى ${date(d.name_deadline)}`], by: 'السجل المدني (تلقائيًا)' };
    case 'registry.birth.name_proposed':
      return { title: '✏️ اقتراح اسم للمولود', people: e.subjects, lines: [`الاسم المقترح: ${d.given_name?.ar ?? ''}`, d.awaiting ? `بانتظار تأكيد ${d.awaiting}` : 'يؤكده مقترِحه وحده'], by: citizen(d.proposed_by) };
    case 'registry.birth.named':
      return {
        title: '👶 اعتماد اسم المولود', people: e.subjects, lines: [`الاسم: ${d.given_name?.ar ?? ''} ${d.family_name?.ar ?? ''}`.trim()],
        by: d.how === 'deadline' ? 'السجل المدني (انتهت المهلة فاعتُمد الاسم المقترح)' : citizen(d.confirmed_by),
      };
    case 'registry.person.born':
      return { title: '📜 تسجيل مولود في السجل المدني', people: [d.national_id, d.mother_id, d.father_id].filter(Boolean), lines: ['صدر رقم الهوية الوطنية للمولود'], by: 'السجل المدني (تلقائيًا بعد اعتماد الاسم)' };
    case 'registry.birth.name_overdue':
      return { title: '⏰ انتهت مهلة تسمية مولود', people: e.subjects, lines: ['لم يُقترح اسم بعد — ما زال بإمكان الوالدين التسمية'], by: 'السجل المدني (تلقائيًا)' };
    case 'health.record.opened':
      return { title: '🩺 فتح ملف صحي للمولود', people: [d.national_id], lines: ['سُجّلت لقاحات الولادة'], by: 'وزارة الصحة (تلقائيًا)' };
    case 'labor.benefit.awarded':
      return { title: '💰 منح إعانة طفل', people: [d.payee_id, d.child_id].filter(Boolean), lines: [`${d.monthly_amount} دينار سرابي شهريًا، دون طلب`], by: 'التأمينات الاجتماعية (تلقائيًا)' };
    case 'registry.address.changed':
      return { title: '🏠 تغيير عنوان', people: [d.national_id ?? e.subjects[0]], lines: [`المدينة الجديدة: ${d.city?.ar ?? ''}`], by: emp };
    case 'registry.family.changed': {
      const what: Record<string, string> = { marital_status: 'تصحيح الحالة الاجتماعية', parents: 'تغيير الأب أو الأم المسجَّل', child_linked: 'ربط طفل بوالده/والدته', child_unlinked: 'إزالة ربط طفل' };
      return { title: '👪 تحديث روابط عائلية', people: e.subjects, lines: [what[d.change] ?? d.change], by: emp };
    }
    case 'education.record.changed': {
      const lv = d.level_name?.ar ? `${d.level_name.ar}${d.graduation_year ? ` (${d.graduation_year})` : ''}` : '';
      const what: Record<string, [string, string]> = {
        'degree.added': ['🎓 مؤهل جديد', lv], 'degree.updated': ['🎓 تصحيح مؤهل', lv], 'degree.removed': ['🎓 حذف مؤهل', lv],
        'enrollment.set': ['🎒 تسجيل دراسة حالية', ''], 'enrollment.ended': ['🎒 انتهاء دراسة حالية', ''],
      };
      const [title, line] = what[d.action] ?? ['🎓 تحديث السجل التعليمي', ''];
      return { title, people: e.subjects, lines: line ? [line] : [], by: emp };
    }
    case 'labor.employment.changed': {
      const job = [d.job_title?.ar, d.job_employer?.ar].filter(Boolean).join(' — ');
      const what: Record<string, string> = { 'job.added': '💼 وظيفة جديدة', 'job.ended': '📤 انتهاء وظيفة', 'job.updated': '💼 تعديل وظيفة', 'job.removed': '💼 حذف وظيفة', 'status.set': '💼 تغيير الوضع الوظيفي' };
      return { title: what[d.action] ?? '💼 تحديث سجل العمل', people: e.subjects, lines: [...(job ? [job] : []), ...(d.action === 'job.ended' && d.end_date ? [`آخر يوم: ${date(d.end_date)}`] : []), `جهة العمل الحالية: ${d.employer?.ar ?? 'لا يوجد'}`], by: emp };
    }
    case 'property.vehicle.registered':
      return { title: '🚗 تسجيل مركبة', people: e.subjects, lines: [`${d.make} ${d.model} ${d.year} — اللوحة ${d.plate}`], by: emp };
    case 'property.vehicle.transferred':
      return { title: '🔁 نقل ملكية مركبة', people: [d.from_id, d.to_id].filter(Boolean), lines: [`${d.make} ${d.model} — اللوحة ${d.plate}`, `من ${d.from_id} إلى ${d.to_id}`], by: emp };
    case 'property.vehicle.renewed': {
      const by = d.via === 'records' ? emp
        : String(d.on_behalf_of ?? '').startsWith('employee:') ? `الموظف ${d.renewed_by} (في مركز خدمة)`
          : d.on_behalf_of === 'self' ? citizen(d.renewed_by) : `المفوَّض ${d.renewed_by} نيابةً عن المالك`;
      return { title: '🔄 تجديد رخصة سير', people: e.subjects, lines: [`${d.make} ${d.model} — اللوحة ${d.plate}`, `سارية حتى ${date(d.new_expiry)}`], by };
    }
    case 'property.record.changed': {
      const what: Record<string, string> = { 'vehicle.deregistered': `🚫 إلغاء تسجيل مركبة (${d.plate ?? ''})`, 'property.added': `🏘️ تسجيل صك عقار ${d.deed_no ?? ''}`, 'property.updated': `🏘️ تصحيح صك عقار ${d.deed_no ?? ''}`, 'property.removed': `🏘️ حذف صك عقار ${d.deed_no ?? ''}` };
      return { title: what[d.action] ?? '🏘️ تحديث سجل العقارات والمركبات', people: e.subjects, by: emp };
    }
    case 'health.record.updated':
      return { title: d.action === 'clinic.reassigned' ? '🩺 تغيير المركز الصحي بعد تغيّر العنوان' : '🩺 تحديث ملف صحي', people: e.subjects, lines: d.action === 'clinic.reassigned' ? [d.clinic?.ar ?? ''] : ['(دون تفاصيل طبية)'], by: d.action === 'clinic.reassigned' ? 'وزارة الصحة (تلقائيًا)' : emp };
    case 'mithaq.delegation.granted':
    case 'mithaq.delegation.revoked': {
      const g = (await db.query('SELECT grantor, delegate, scopes, created_by, revoked_by FROM delegations WHERE id = $1', [d.delegation_id])).rows[0];
      if (!g) return null;
      const granted = e.type === 'mithaq.delegation.granted';
      const scopes = (g.scopes as string[]).map((s) => DELEGATION_SCOPES[s]?.label.ar ?? s).join('، ');
      const by = granted
        ? (g.created_by ? `الموظف ${g.created_by} (في مركز خدمة، بحضور المواطن)` : citizen(g.grantor))
        : (String(g.revoked_by ?? '').startsWith('employee:') ? actorText(g.revoked_by) : citizen(g.revoked_by ?? g.grantor));
      return { title: granted ? '🤝 منح تفويض' : '✋ إلغاء تفويض', people: [g.grantor, g.delegate], lines: [`الصلاحيات: ${scopes}`, `الموكِّل ${g.grantor} ← المفوَّض ${g.delegate}`], by };
    }
    default: {
      // Any event type added later: its label from the event policy.
      const label = EVENT_TYPES[e.type]?.label.ar ?? e.type;
      return { title: `🔔 ${label}`, people: e.subjects, by: emp };
    }
  }
}

/** One line of wording for the notifier: no control characters or newlines (the notifier refuses them). */
const clip = (v: unknown, max: number) => String(v ?? '').replace(/[\p{Cc}\p{Zl}\p{Zp}\u200e\u200f\u202a-\u202e\u2066-\u2069]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** The message (structured, for the notifier, which builds the text) and its text, with names looked up.
 *  Returns null when the event is not news. */
export async function feedText(db: Db, e: SarabEvent): Promise<{ text: string; payload: FeedRequest; test: boolean } | null> {
  const dr = await draft(db, e);
  if (!dr) return null;
  const people = [...new Set(dr.people.filter((x): x is string => typeof x === 'string' && /^1\d{9}$/.test(x)))].slice(0, 4);
  const named = await Promise.all(people.map(async (id) => ({ id, name: await nameOf(id) })));
  const payload: FeedRequest = {
    title: clip(dr.title, 120) || 'خبر',
    people: named.map((p) => ({ id: p.id, name: p.name ? clip(p.name, 80) || null : null })),
    lines: (dr.lines ?? []).map((l) => clip(l, 200)).filter(Boolean).slice(0, 8),
    by: dr.by ? clip(dr.by, 120) || null : null,
    at: new Date(e.at).toISOString(),
  };
  const problem = feedRequestProblem(payload);
  if (problem) throw new Error(`news feed: message for ${e.type} would be refused (${problem})`);
  const text = renderFeed(payload);
  return { text, payload, test: named.some((p) => TEST_TAG.test(p.name ?? '')) || TEST_TAG.test(text) };
}

/** Is an automated test running? (A test ticket is valid; make e2e / make a11y expire it when they finish.) */
async function testRunning(db: Db): Promise<boolean> {
  return !!(await db.query('SELECT 1 FROM staff_test_tickets WHERE expires_at > now() LIMIT 1')).rowCount;
}

/** Called by the bus consumer for every event (idempotent per event id). */
export async function enqueueFeed(db: Db, e: SarabEvent): Promise<void> {
  if ((await db.query('SELECT 1 FROM feed_outbox WHERE event_id = $1', [e.id])).rowCount) return;
  const m = await feedText(db, e);
  if (!m) return;
  const mocked = m.test || process.env.FEED_DISABLED === '1' || (await testRunning(db));
  await db.query(
    "INSERT INTO feed_outbox (event_id, type, text, payload, status) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (event_id) DO NOTHING",
    [e.id, e.type, m.text, JSON.stringify(m.payload), mocked ? 'mocked' : 'queued'],
  );
}

/** Sends queued messages one at a time, oldest first; waits and retries instead of dropping. */
export function startFeedPump(db: Db, log: { error: (o: object, m: string) => void; info: (o: object, m: string) => void }): void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (let n = 0; n < 5; n++) {
        const m = (await db.query("SELECT id, payload, attempts, next_at <= now() AS due FROM feed_outbox WHERE status = 'queued' ORDER BY id LIMIT 1")).rows[0];
        if (!m || !m.due) return; // keep the order: the oldest message goes first, even when it has to wait
        if (!m.payload) { await db.query("UPDATE feed_outbox SET status = 'mocked', last_error = 'queued before structured messages: not sent' WHERE id = $1", [m.id]); continue; }
        let status = 0, retryAfter = 0;
        try {
          const r = await fetch(`${process.env.NOTIFIER_URL}/feed`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-notifier-key': process.env.NOTIFIER_KEY ?? '' }, body: JSON.stringify(m.payload), signal: AbortSignal.timeout(20_000) });
          status = r.status;
          if (r.status === 429) retryAfter = Number((await r.json().catch(() => ({})))?.retry_after) || 5;
        } catch { status = 0; }
        if (status === 200) {
          await db.query("UPDATE feed_outbox SET status = 'sent', sent_at = now(), attempts = attempts + 1 WHERE id = $1", [m.id]);
          continue;
        }
        if (status === 429) {
          await db.query('UPDATE feed_outbox SET next_at = now() + make_interval(secs => $2) WHERE id = $1', [m.id, Math.min(retryAfter, 600)]);
        } else {
          const wait = Math.min(300, 5 * 2 ** Math.min(m.attempts, 6));
          await db.query('UPDATE feed_outbox SET attempts = attempts + 1, next_at = now() + make_interval(secs => $2), last_error = $3 WHERE id = $1', [m.id, wait, `HTTP ${status || 'unreachable'}`]);
          if (m.attempts % 5 === 0) log.error({ status, attempts: m.attempts + 1 }, 'news feed: Telegram delivery failed, will retry');
        }
        return;
      }
    } catch (err) {
      log.error({ err }, 'news feed pump failed');
    } finally { busy = false; }
  };
  setInterval(() => { void tick(); }, 1_000).unref();
  // Housekeeping: keep sent / mocked messages for 7 days.
  setInterval(() => { db.query("DELETE FROM feed_outbox WHERE status IN ('sent', 'mocked') AND created_at < now() - interval '7 days'").catch(() => {}); }, 3_600_000).unref();
}

export function registerFeed(app: FastifyInstance, db: Db): void {
  // Tests read back the messages they caused (mocked — never sent). Needs a valid test ticket (not consumed).
  app.get('/api/identity/test/feed', {
    schema: {
      tags: ['testing'], summary: 'Mocked news-feed messages of the last hour (automated tests only; needs header x-sarab-test-ticket)',
      querystring: { type: 'object', properties: { after: { type: 'integer', minimum: 0, default: 0 } } },
    },
  }, async (req) => {
    const t = req.headers['x-sarab-test-ticket'];
    if (typeof t !== 'string' || t.length < 32 || !(await db.query('SELECT 1 FROM staff_test_tickets WHERE ticket_hash = $1 AND expires_at > now()', [sha256hex(t)])).rowCount) {
      throw httpError(403, 'test_ticket_required', 'Only for automated tests');
    }
    const { after } = req.query as { after: number };
    const { rows } = await db.query("SELECT id, type, text, status, created_at FROM feed_outbox WHERE id > $1 AND created_at > now() - interval '1 hour' ORDER BY id LIMIT 500", [after]);
    const sentDuringTest = (await db.query("SELECT count(*)::int AS n FROM feed_outbox WHERE id > $1 AND status <> 'mocked' AND created_at > now() - interval '1 hour'", [after])).rows[0].n;
    return { messages: rows.map((r) => ({ ...r, id: Number(r.id) })), not_mocked: sentDuringTest };
  });
}
