// Shared building blocks for the "Manage citizen" staff screens.
//
// Accessibility (NVDA / VoiceOver):
//  - every control has a visible <label>; hints and errors are tied to it with aria-describedby, and an
//    invalid control has aria-invalid="true";
//  - on a failed save the error summary (role=alert) appears, takes focus and lists every problem;
//  - on a successful save the result is announced (polite live region), shown as text under the section
//    heading, and focus moves to that heading so the reader continues from the updated list;
//  - "Remove" never acts at once: a confirmation group takes focus; Cancel puts focus back on the button;
//  - tables have captions and row headers, action buttons name the item they act on;
//  - groups of checkboxes are fieldsets with legends; the page has a breadcrumb and one h1.
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { api, ApiError } from '../../api.ts';
import { hasKey, useI18n, type Bi, type Key } from '../../i18n.tsx';
import { ErrorSummary, fieldItems, type ErrorItem, Loading, PageTitle, TableRegion, useAnnounce } from '../../a11y.tsx';
import { useErrorText } from '../../session.tsx';

export type Ministry = 'civil' | 'education' | 'labor' | 'property' | 'health';
export const MINISTRY_KEYS: Ministry[] = ['civil', 'education', 'labor', 'property', 'health'];

export interface Options {
  degree_levels: { value: string; name: Bi }[]; institutions: Bi[]; majors: Bi[]; grades: Bi[]; study_stages: Bi[];
  employers: { name: Bi; sector: string }[]; job_titles: Bi[]; non_job_statuses: { value: string; name: Bi }[];
  vehicle_makes: { make: string; models: string[] }[]; vehicle_colors: Bi[]; property_types: Bi[];
  blood_types: string[]; allergies: Bi[]; conditions: Bi[]; vaccines: Bi[]; clinics: Bi[];
  cities: { index: number; name: Bi }[]; districts: { index: number; name: Bi }[];
  ministries: { key: Ministry; name: Bi }[]; employee_id: string;
}
export interface Change { action: string; detail?: any; actor: string; at: string }

let optionsPromise: Promise<Options> | null = null;
export function useOptions(): Options | null {
  const [o, setO] = useState<Options | null>(null);
  useEffect(() => {
    optionsPromise ??= api<Options>('/api/identity/manage/options').catch((e) => { optionsPromise = null; throw e; });
    optionsPromise.then(setO).catch(() => {});
  }, []);
  return o;
}

/** Server problem code → readable message (falls back to the generic one). */
export function useProblemText() {
  const { t } = useI18n();
  return (code: string) => (hasKey(`mg_err_${code}`) ? t(`mg_err_${code}` as Key) : t('mg_err_generic', { code }));
}

// ---------------- Page state: errors, field errors, status, focus ----------------

const Ctx = createContext<Record<string, string>>({});
export const useFieldError = (id: string) => useContext(Ctx)[id];
/** Makes the page's field errors visible to every control below it (a stable component: no remounts). */
export function FieldErrors({ errors, children }: { errors: Record<string, string>; children: ReactNode }) {
  return <Ctx.Provider value={errors}>{children}</Ctx.Provider>;
}

/**
 * One ministry record: loads it, and runs changes against it. Field errors from the server are mapped to
 * form controls with `fields` (server field name → control id).
 */
export function useRecord<T>(ministry: Ministry, id: string) {
  const { t } = useI18n();
  const announce = useAnnounce();
  const errorText = useErrorText();
  const problemText = useProblemText();
  const [data, setData] = useState<T | null>(null);
  const [errors, setErrors] = useState<ErrorItem[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ section: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/api/identity/manage/${ministry}/persons/${id}`;

  const load = useCallback(() => api<T>(base).then(setData).catch((e) => setErrors([errorText(e)])), [base]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  /** Client-side check failed: show the errors (summary + fields), no request. */
  const invalid = (fe: Record<string, string>, labels: Record<string, string>) => {
    setFieldErrors(fe);
    setErrors(fieldItems(fe, (k) => labels[k] ?? k));
    setStatus(null);
    return false;
  };

  const run = async (o: {
    method: 'POST' | 'PUT' | 'DELETE'; path?: string; body?: unknown;
    /** section whose heading gets focus + the success text */ section: string; success: string;
    fields?: Record<string, string>; labels?: Record<string, string>;
  }): Promise<boolean> => {
    setBusy(true); setErrors([]); setFieldErrors({}); setStatus(null);
    try {
      const r = await api<T>(`${base}${o.path ?? ''}`, { method: o.method, body: o.method === 'DELETE' ? undefined : (o.body ?? {}) });
      setData(r);
      setStatus({ section: o.section, text: o.success });
      announce(o.success);
      window.setTimeout(() => document.getElementById(`${o.section}-h`)?.focus(), 60);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'validation_failed') {
        const fe: Record<string, string> = {};
        const msgs: ErrorItem[] = [];
        for (const p of ((err.details as any)?.problems ?? []) as { field: string; code: string }[]) {
          const ctl = o.fields?.[p.field] ?? p.field;
          fe[ctl] = problemText(p.code);
          msgs.push({ field: ctl, text: `${o.labels?.[ctl] ?? t('mg_field')}: ${fe[ctl]}` });
        }
        setFieldErrors(fe);
        setErrors(msgs.length ? msgs : [errorText(err)]);
      } else {
        setErrors([errorText(err)]);
      }
      return false;
    } finally { setBusy(false); }
  };

  return { data, errors, fieldErrors, status, busy, run, invalid, reload: load, setErrors, setStatus };
}

// ---------------- Page frame ----------------

/** Name passed from the overview page (so a ministry page does not need to read the Civil Registry). */
export function usePersonName(): Bi | null {
  const loc = useLocation();
  return ((loc.state as any)?.name as Bi | undefined) ?? null;
}

export function ManageFrame({ id, ministry, name, errors, children }: { id: string; ministry: Ministry; name: Bi | null; errors: ErrorItem[]; children: ReactNode }) {
  const { t, b } = useI18n();
  const opts = useOptions();
  const mname = opts?.ministries.find((m) => m.key === ministry)?.name;
  const who = name ? b(name) : id;
  return (
    <>
      <nav aria-label={t('mg_breadcrumb')} className="breadcrumb">
        <ol>
          <li><Link to="/manage">{t('mg_title')}</Link></li>
          <li><span aria-hidden="true" className="sep">/</span><Link to={`/manage/${id}`} state={{ name }}>{who}</Link></li>
          <li><span aria-hidden="true" className="sep">/</span><span aria-current="page">{t(`mg_m_${ministry}` as Key)}</span></li>
        </ol>
      </nav>
      <PageTitle text={t('mg_ministry_title', { ministry: t(`mg_m_${ministry}` as Key), who })} />
      <p className="lead"><span dir="ltr">{t('fieldNationalId')}: {id}</span></p>
      <p className="note" role="note">{t('mg_acting_as', { ministry: mname ? b(mname) : t(`mg_m_${ministry}` as Key), id: opts?.employee_id ?? '' })}</p>
      <ErrorSummary title={t('errorTitle')} messages={errors} />
      {children}
    </>
  );
}

/** A section with a focusable heading (focus lands here after a change) and its success message. */
export function Section({ id, title, status, children }: { id: string; title: string; status: { section: string; text: string } | null; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-h`} className="panel">
      <h2 id={`${id}-h`} tabIndex={-1}>{title}</h2>
      {status?.section === id && <p className="check-ok">{status.text}</p>}
      {children}
    </section>
  );
}

// ---------------- Form controls ----------------

function Described({ id, label, hint, required, children }: { id: string; label: string; hint?: string; required?: boolean; children: (aria: { 'aria-invalid': boolean; 'aria-describedby'?: string }) => ReactNode }) {
  const { t } = useI18n();
  const error = useFieldError(id);
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-err` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}{required ? <> <span className="required">{t('reg_required')}</span></> : <> <span className="muted">{t('reg_optional')}</span></>}</label>
      {hint && <p id={`${id}-hint`} className="hint">{hint}</p>}
      {error && <p id={`${id}-err`} className="field-error">{error}</p>}
      {children({ 'aria-invalid': !!error, 'aria-describedby': describedBy })}
    </div>
  );
}

export function TextField({ id, label, value, onChange, hint, required = true, type = 'text', inputMode, maxLength = 60, dir }: {
  id: string; label: string; value: string; onChange: (v: string) => void; hint?: string; required?: boolean;
  type?: 'text' | 'date' | 'tel'; inputMode?: 'numeric' | 'tel'; maxLength?: number; dir?: 'ltr' | 'rtl';
}) {
  return (
    <Described id={id} label={label} hint={hint} required={required}>
      {(aria) => (
        <input id={id} name={id} type={type} inputMode={inputMode} maxLength={maxLength} dir={dir ?? (inputMode || type !== 'text' ? 'ltr' : undefined)} autoComplete="off"
          value={value} onChange={(e) => onChange(e.target.value)} aria-required={required} {...aria} />
      )}
    </Described>
  );
}

export function SelectField({ id, label, value, onChange, options, hint, required = true }: {
  id: string; label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; hint?: string; required?: boolean;
}) {
  const { t } = useI18n();
  return (
    <Described id={id} label={label} hint={hint} required={required}>
      {(aria) => (
        <select id={id} name={id} value={value} onChange={(e) => onChange(e.target.value)} aria-required={required} {...aria}>
          <option value="">{t('reg_choose')}</option>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
    </Described>
  );
}

export function CheckboxGroup({ id, legend, hint, options, selected, onChange }: { id: string; legend: string; hint?: string; options: { value: string; label: string }[]; selected: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="field" aria-describedby={hint ? `${id}-hint` : undefined}>
      <legend>{legend}</legend>
      {hint && <p id={`${id}-hint`} className="hint">{hint}</p>}
      {options.map((o) => (
        <div key={o.value} className="choice">
          <input type="checkbox" id={`${id}-${o.value}`} checked={selected.includes(o.value)}
            onChange={(e) => onChange(e.target.checked ? [...selected, o.value] : selected.filter((x) => x !== o.value))} />
          <label htmlFor={`${id}-${o.value}`}>{o.label}</label>
        </div>
      ))}
    </fieldset>
  );
}

export function Checkbox({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="choice field">
      <input type="checkbox" id={id} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id}>{label}</label>
    </div>
  );
}

// ---------------- Client-side checks (the ministry checks again) ----------------

export const isNid = (s: string) => /^1\d{9}$/.test(s.trim());
export const isIsoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
export const today = () => new Date().toISOString().slice(0, 10);
export const isYear = (s: string) => /^\d{4}$/.test(s.trim());

// ---------------- Confirmation before removing something ----------------

export interface Pending { question: string; confirm: string; action: () => Promise<unknown>; back: string }

/**
 * Two-step removal: `ask(...)` opens a confirmation group that takes focus; Cancel returns focus to the
 * button that opened it (`back` = its id). Render <ConfirmBox> once per page.
 */
export function useConfirm() {
  const [pending, setPending] = useState<Pending | null>(null);
  const ask = (question: string, confirm: string, action: () => Promise<unknown>, back: string) => setPending({ question, confirm, action, back });
  return { pending, ask, close: () => setPending(null) };
}

export function ConfirmBox({ c }: { c: ReturnType<typeof useConfirm> }) {
  const { t } = useI18n();
  const hid = useId();
  const ref = useRef<HTMLHeadingElement>(null);
  const p = c.pending;
  useEffect(() => { if (p) ref.current?.focus(); }, [p]);
  if (!p) return null;
  const cancel = () => { c.close(); window.setTimeout(() => document.getElementById(p.back)?.focus(), 30); };
  return (
    <div className="warning-box" role="group" aria-labelledby={hid}>
      <h3 id={hid} ref={ref} tabIndex={-1}>{p.question}</h3>
      <p>{t('mg_confirm_note')}</p>
      <div className="actions">
        <button type="button" className="btn btn-danger" onClick={async () => { c.close(); await p.action(); }}>{p.confirm}</button>
        <button type="button" className="btn btn-secondary" onClick={cancel}>{t('mg_cancel')}</button>
      </div>
    </div>
  );
}

// ---------------- Recent changes (the ministry's own log) ----------------

export function Changes({ changes, status }: { changes: Change[] | undefined; status: { section: string; text: string } | null }) {
  const { t, fmtDate } = useI18n();
  return (
    <Section id="changes" title={t('mg_changes')} status={status}>
      <p className="hint">{t('mg_changes_hint')}</p>
      {!changes ? <Loading /> : changes.length === 0 ? <p>{t('mg_changes_none')}</p> : (
        <TableRegion caption={t('mg_changes')} visuallyHiddenCaption>
          <thead><tr><th scope="col">{t('colWhen')}</th><th scope="col">{t('mg_col_change')}</th><th scope="col">{t('mg_col_by')}</th></tr></thead>
          <tbody>
            {changes.map((c, i) => (
              <tr key={i}>
                <th scope="row">{fmtDate(c.at, true)}</th>
                <td>{hasKey(`mg_act_${c.action.replace(/\./g, '_')}`) ? t(`mg_act_${c.action.replace(/\./g, '_')}` as Key) : c.action}</td>
                <td dir="ltr">{c.actor.replace(/^employee:/, '')}</td>
              </tr>
            ))}
          </tbody>
        </TableRegion>
      )}
    </Section>
  );
}

export const spell = (id: string) => id.split('').join(' ');
