// Life events. A birth: the hospital reports it (staff portal) → here the parents choose and confirm the
// baby's name → the Civil Registry registers the child and the other ministries react over the event bus.
//
// Accessibility (NVDA / VoiceOver): each waiting baby is an <article> with its own heading; its facts are a
// description list; the name form has visible labels, hints and per-field errors (aria-describedby,
// aria-invalid), Arabic / English inputs carry lang + dir; a failed action focuses the error summary; a
// successful one is announced (polite live region), shown as text and focus moves to the baby's heading;
// timeline steps are an ordered list with a text status, and newly completed steps are announced.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api.ts';
import { useI18n, type Bi } from '../i18n.tsx';
import { ErrorSummary, fieldItems, type ErrorItem, Loading, PageTitle, useAnnounce } from '../a11y.tsx';
import { useErrorText } from '../session.tsx';
import { useProblemText } from './manage/common.tsx';

interface Step { type: string; label: Bi; publisher: string; done: boolean; at: string | null }
interface LifeEvent { correlation_id: string; kind: string; created_at: string; data: { child_given_name?: Bi; child_national_id?: string; child_gender?: 'M' | 'F'; birth_date: string; hospital?: Bi }; steps: Step[]; complete: boolean }
interface Person { national_id: string; name: Bi | null }
interface Birth {
  notification_id: string; status: 'awaiting_name' | 'registered'; gender: 'M' | 'F'; birth_date: string; hospital: Bi; name_deadline: string; overdue: boolean;
  family_name: Bi | null; my_role: 'mother' | 'father'; other_parent: (Person & { has_account: boolean }) | null; sole_parent: boolean;
  proposal: { id: number; given_name: Bi; proposed_by: string; awaiting: string | null } | null;
  can_confirm: boolean; waiting_for_other: boolean; child: Person | null;
}

export function useMemberNames() {
  const [names, setNames] = useState<Record<string, Bi>>({});
  useEffect(() => {
    api<{ members: { id: string; name: Bi }[] }>('/api/jisr/members').then((r) => setNames(Object.fromEntries(r.members.map((m) => [m.id, m.name])))).catch(() => {});
  }, []);
  return names;
}

const AR = /^[ء-يٱ-ۓ ]{2,30}$/u;
const EN = /^[A-Za-z][A-Za-z' -]{1,29}$/;

/** One baby waiting for a name: propose, change, or confirm. */
function NameBaby({ birth, onDone, setErrors }: { birth: Birth; onDone: (b: Birth, msg: string) => void; setErrors: (m: ErrorItem[]) => void }) {
  const { t, b, fmtDate } = useI18n();
  const errorText = useErrorText();
  const problemText = useProblemText();
  const id = birth.notification_id;
  const p = birth.proposal;
  const [editing, setEditing] = useState(!p);
  const [ar, setAr] = useState('');
  const [en, setEn] = useState('');
  const [fe, setFe] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { setEditing(!birth.proposal); }, [birth.proposal?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const other = birth.other_parent;
  const otherName = other?.name ? b(other.name) : other?.national_id ?? '';
  const family = birth.family_name ? b(birth.family_name) : '';
  const daysLeft = Math.max(0, Math.ceil((new Date(birth.name_deadline).getTime() - Date.now()) / 86_400_000));
  const L = { ar: t('nm_name_ar'), en: t('nm_name_en') };

  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.code === 'validation_failed') {
      const f: Record<string, string> = {};
      for (const x of ((err.details as any)?.problems ?? []) as { field: string; code: string }[]) f[x.field.endsWith('.ar') ? 'ar' : 'en'] = problemText(x.code);
      setFe(f);
      setErrors(fieldItems(f, (k) => L[k as 'ar' | 'en'], (k) => `nm-${k}-${id}`));
    } else setErrors([errorText(err)]);
  };

  const propose = async (e: FormEvent) => {
    e.preventDefault();
    const f: Record<string, string> = {};
    if (!ar.trim()) f.ar = t('errRequired'); else if (!AR.test(ar.trim())) f.ar = t('mg_err_name_not_arabic');
    if (!en.trim()) f.en = t('errRequired'); else if (!EN.test(en.trim())) f.en = t('mg_err_name_not_latin');
    setFe(f);
    if (Object.keys(f).length) { setErrors(fieldItems(f, (k) => L[k as 'ar' | 'en'], (k) => `nm-${k}-${id}`)); return; }
    setBusy(true); setErrors([]);
    try {
      const r = await api<Birth>(`/api/identity/me/births/${id}/name`, { body: { given_name: { ar: ar.trim(), en: en.trim() } } });
      setAr(''); setEn('');
      onDone(r, r.can_confirm ? t('nm_ok_check') : t('nm_ok_sent'));
    } catch (err) { fail(err); } finally { setBusy(false); }
  };

  const confirm = async () => {
    if (!p) return;
    setBusy(true); setErrors([]);
    try {
      const r = await api<Birth>(`/api/identity/me/births/${id}/confirm`, { body: { proposal_id: p.id } });
      onDone(r, t('nm_ok_registered', { id: r.child?.national_id ?? '' }));
    } catch (err) {
      fail(err);
      if (err instanceof ApiError && err.code === 'proposal_changed') onDone(birth, '');
    } finally { setBusy(false); }
  };

  const describe = (k: 'ar' | 'en') => [`nm-${k}-${id}-hint`, fe[k] ? `nm-${k}-${id}-err` : ''].filter(Boolean).join(' ');
  const theirs = !!p && p.proposed_by === other?.national_id;
  const state = !p ? t('nm_state_none')
    : theirs ? (birth.can_confirm ? t('nm_state_to_confirm', { name: b(p.given_name), other: otherName }) : t('nm_state_theirs_sole', { name: b(p.given_name), other: otherName }))
      : birth.waiting_for_other ? t('nm_state_waiting', { name: b(p.given_name), other: otherName })
        : t('nm_state_check', { full: `${b(p.given_name)} ${family}`.trim() });

  return (
    <>
      <dl className="facts">
        <div><dt>{t('nm_hospital')}</dt><dd>{b(birth.hospital)}</dd></div>
        <div><dt>{t('nm_deadline')}</dt><dd>{birth.overdue ? t('nm_overdue', { date: fmtDate(birth.name_deadline) }) : t('nm_days_left', { date: fmtDate(birth.name_deadline), n: String(daysLeft) })}</dd></div>
        <div><dt>{t('nm_other_parent')}</dt><dd>{!other ? t('nm_other_none') : other.has_account ? `${otherName} (${other.national_id})` : t('nm_other_no_account', { name: otherName, id: other.national_id })}</dd></div>
        <div><dt>{t('nm_family_name')}</dt><dd>{family}</dd></div>
        {p && <div><dt>{t('nm_proposed_name')}</dt><dd><span lang="ar" dir="rtl">{p.given_name.ar}</span> / <span lang="en" dir="ltr">{p.given_name.en}</span></dd></div>}
        <div><dt>{t('nm_state')}</dt><dd>{state}</dd></div>
      </dl>
      {p && !editing && (
        <div className="actions">
          {birth.can_confirm && <button type="button" className="btn btn-primary" disabled={busy} onClick={confirm}>{t('nm_confirm', { name: b(p.given_name) })}</button>}
          <button type="button" id={`nm-change-${id}`} className="btn btn-secondary" disabled={busy}
            onClick={() => { setEditing(true); window.setTimeout(() => document.getElementById(`nm-form-${id}`)?.focus(), 50); }}>
            {theirs ? t('nm_propose_other') : t('nm_change')}
          </button>
        </div>
      )}
      {editing && (
        <form onSubmit={propose} noValidate aria-labelledby={`nm-form-${id}`}>
          <h4 id={`nm-form-${id}`} tabIndex={-1}>{p ? t('nm_change_form') : t('nm_propose_form')}</h4>
          <p className="hint">{t('nm_family_hint', { family })}</p>
          {(['ar', 'en'] as const).map((k) => (
            <div className="field" key={k}>
              <label htmlFor={`nm-${k}-${id}`}>{L[k]} <span className="required">{t('reg_required')}</span></label>
              <p id={`nm-${k}-${id}-hint`} className="hint">{t(k === 'ar' ? 'nm_name_ar_hint' : 'nm_name_en_hint')}</p>
              {fe[k] && <p id={`nm-${k}-${id}-err`} className="field-error">{fe[k]}</p>}
              <input id={`nm-${k}-${id}`} lang={k} dir={k === 'ar' ? 'rtl' : 'ltr'} maxLength={30} autoComplete="off" value={k === 'ar' ? ar : en}
                onChange={(e) => (k === 'ar' ? setAr : setEn)(e.target.value)} aria-required="true" aria-invalid={!!fe[k]} aria-describedby={describe(k)} />
            </div>
          ))}
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('working') : birth.sole_parent ? t('nm_continue_check') : t('nm_send_other', { other: otherName })}</button>
            {p && <button type="button" className="btn btn-secondary" onClick={() => { setEditing(false); setFe({}); window.setTimeout(() => document.getElementById(`nm-change-${id}`)?.focus(), 50); }}>{t('nm_cancel')}</button>}
          </div>
        </form>
      )}
    </>
  );
}

export function LifeEvents() {
  const { t, b, fmtDate } = useI18n();
  const announce = useAnnounce();
  const errorText = useErrorText();
  const members = useMemberNames();
  const [events, setEvents] = useState<LifeEvent[] | null>(null);
  const [births, setBirths] = useState<Birth[] | null>(null);
  const [status, setStatus] = useState<{ id: string; text: string } | null>(null);
  const [errors, setErrors] = useState<ErrorItem[]>([]);
  const seen = useRef<Set<string> | null>(null);
  const poll = useRef<number | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ life_events: LifeEvent[] }>('/api/identity/me/life-events');
    // Announce steps that completed since the last load (not on the first load).
    const done = new Set(r.life_events.flatMap((e) => e.steps.filter((s) => s.done).map((s) => `${e.correlation_id}|${s.type}`)));
    if (seen.current) {
      for (const e of r.life_events) {
        for (const s of e.steps) if (s.done && !seen.current.has(`${e.correlation_id}|${s.type}`)) announce(t('stepAnnounce', { step: b(s.label) }));
        if (e.complete && e.steps.some((s) => !seen.current!.has(`${e.correlation_id}|${s.type}`))) announce(t('lifeComplete'));
      }
    }
    seen.current = done;
    setEvents(r.life_events);
    return r.life_events;
  }, [announce, t, b]);
  const loadBirths = useCallback(() => api<{ births: Birth[] }>('/api/identity/me/births').then((r) => setBirths(r.births)), []);

  useEffect(() => {
    load().catch((e) => setErrors([errorText(e)]));
    loadBirths().catch((e) => setErrors([errorText(e)]));
    return () => { if (poll.current) window.clearInterval(poll.current); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const startPolling = () => {
    let n = 0;
    if (poll.current) window.clearInterval(poll.current);
    poll.current = window.setInterval(async () => {
      n++;
      const list = await load().catch(() => null);
      if (n > 40 || (list && list.every((e) => e.complete))) { window.clearInterval(poll.current!); poll.current = null; }
    }, 750);
  };

  const onDone = (birth: Birth, msg: string) => {
    if (!msg) { loadBirths().catch(() => {}); return; } // the proposal changed meanwhile: show the new one
    setBirths((list) => (list ?? []).map((x) => (x.notification_id === birth.notification_id ? birth : x)));
    setStatus({ id: birth.notification_id, text: msg });
    announce(msg);
    window.setTimeout(() => document.getElementById(`nm-h-${birth.notification_id}`)?.focus(), 60);
    // Let the confirmation be read first; the steps that follow are announced after it.
    if (birth.status === 'registered') window.setTimeout(() => { load().catch(() => {}); startPolling(); }, 2500);
  };

  const waiting = births?.filter((x) => x.status === 'awaiting_name' || x.notification_id === status?.id) ?? null;
  const title = (e: LifeEvent) => e.data.child_given_name
    ? t('lifeBirthOf', { name: b(e.data.child_given_name) })
    : t(e.data.child_gender === 'F' ? 'lifeBirthUnnamed_F' : 'lifeBirthUnnamed_M', { date: fmtDate(e.data.birth_date) });

  return (
    <>
      <PageTitle text={t('lifeTitle')} />
      <ErrorSummary title={t('errorTitle')} messages={errors} />
      <p className="lead">{t('lifeIntro')}</p>

      <section aria-labelledby="births-h" className="panel">
        <h2 id="births-h">{t('nm_heading')}</h2>
        <p className="hint">{t('nm_intro')}</p>
        {!waiting ? <Loading /> : waiting.length === 0 ? <p>{t('nm_none')}</p> : waiting.map((x) => (
          <article key={x.notification_id} className="life-event baby" aria-labelledby={`nm-h-${x.notification_id}`}>
            <h3 id={`nm-h-${x.notification_id}`} tabIndex={-1}>{t(x.gender === 'F' ? 'nm_baby_F' : 'nm_baby_M', { date: fmtDate(x.birth_date) })}</h3>
            {status?.id === x.notification_id && <p className="check-ok">{status.text}</p>}
            {x.status === 'registered'
              ? x.child && <p>{t('lifeChildId')}: <strong dir="ltr">{x.child.national_id}</strong> — {x.child.name ? b(x.child.name) : ''}</p>
              : <NameBaby birth={x} onDone={onDone} setErrors={setErrors} />}
          </article>
        ))}
      </section>

      <section aria-labelledby="life-list-h" className="panel">
        <h2 id="life-list-h" tabIndex={-1}>{t('lifeListHeading')}</h2>
        {!events ? <Loading /> : events.length === 0 ? <p>{t('lifeNone')}</p> : events.map((e) => {
          const done = e.steps.filter((s) => s.done).length;
          return (
            <article key={e.correlation_id} className="life-event" aria-labelledby={`le-${e.correlation_id}`}>
              <h3 id={`le-${e.correlation_id}`}>{title(e)} — {fmtDate(e.data.birth_date)}</h3>
              {e.data.child_national_id && <p>{t('lifeChildId')}: <strong dir="ltr">{e.data.child_national_id}</strong></p>}
              <p className="muted">{t('lifeProgress', { done, total: e.steps.length })}</p>
              <ol className="steps">
                {e.steps.map((s) => (
                  <li key={s.type} className={s.done ? 'step-done' : 'step-pending'}>
                    <span className={`badge ${s.done ? 'badge-ok' : 'badge-muted'}`}>{s.done ? t('stepDone') : t('stepPending')}</span>{' '}
                    {b(s.label)}
                    <span className="muted"> — {t('stepBy', { who: b(members[s.publisher]) || s.publisher })}{s.at ? ` · ${fmtDate(s.at, true)}` : ''}</span>
                  </li>
                ))}
              </ol>
              {e.complete && <p className="check-ok">{t('lifeComplete')}</p>}
            </article>
          );
        })}
      </section>
    </>
  );
}
