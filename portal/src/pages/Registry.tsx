// Civil Registry — register a new adult citizen (staff with the "registry.register" permission:
// service-centre employees and the administrator). Built for screen readers: every field has a visible
// label, hints and errors are tied to the field (aria-describedby), errors are summarised and focused,
// radio groups are fieldsets with legends, and focus moves to the result after registration.
import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError } from '../api.ts';
import { useI18n, type Bi, type Key, hasKey } from '../i18n.tsx';
import { ErrorSummary, fieldItems, type ErrorItem, Loading, PageTitle, TableRegion, useAnnounce } from '../a11y.tsx';
import { useErrorText } from '../session.tsx';

interface Options { cities: { index: number; name: Bi }[]; districts: { index: number; name: Bi }[] }
interface Person { national_id: string; given_name: Bi; family_name: Bi; birth_date: string; family: { national_id: string; relation: string; name: Bi }[] }
interface Activation { sent: boolean; expires_at?: string; error?: string }
interface Registration { national_id: string; employee_id: string; reason: string; at: string; activated: boolean; locked: boolean; code_expires_at: string | null }
interface StaffMe { employee_id: string; name: Bi; permissions: { permission: string }[] }

const EMPTY = {
  given_ar: '', given_en: '', family_ar: '', family_en: '', gender: '', birth_date: '', city: '', district: '', street: '', phone: '',
  father_id: '', mother_id: '', spouse_id: '', reason: '', reference: '',
};
type FormState = typeof EMPTY;
type FieldKey = keyof FormState;
// Server field names → form fields.
const SERVER_FIELD: Record<string, FieldKey> = { birth_date: 'birth_date', father_id: 'father_id', mother_id: 'mother_id', spouse_id: 'spouse_id' };

export function Registry() {
  const { t, b, fmtDate } = useI18n();
  const announce = useAnnounce();
  const errorText = useErrorText();
  const [opts, setOpts] = useState<Options | null>(null);
  const [me, setMe] = useState<StaffMe | null>(null);
  const [f, setF] = useState<FormState>(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [errors, setErrors] = useState<ErrorItem[]>([]);
  const [dupes, setDupes] = useState<string[] | null>(null);
  const [confirmDupe, setConfirmDupe] = useState(false);
  const [result, setResult] = useState<{ person: Person; activation: Activation } | null>(null);
  const [regs, setRegs] = useState<Registration[] | null>(null);
  const [reissued, setReissued] = useState<{ id: string; activation: Activation } | null>(null);
  const [busy, setBusy] = useState(false);

  const loadRegs = useCallback(() => api<{ registrations: Registration[] }>('/api/identity/registry/registrations').then((r) => setRegs(r.registrations)).catch(() => {}), []);
  useEffect(() => {
    api<Options>('/api/identity/registry/options').then(setOpts).catch((e) => setErrors([errorText(e)]));
    api<StaffMe>('/api/identity/staff/me').then(setMe).catch(() => {});
    loadRegs();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: FieldKey) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const label = (k: FieldKey) => t(`reg_${k}` as Key);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const fe: Partial<Record<FieldKey, string>> = {};
    for (const k of ['given_ar', 'given_en', 'family_ar', 'family_en', 'gender', 'birth_date', 'city', 'district', 'street', 'phone', 'reason'] as FieldKey[]) {
      if (!f[k].trim()) fe[k] = t('errRequired');
    }
    for (const k of ['father_id', 'mother_id', 'spouse_id'] as FieldKey[]) if (f[k].trim() && !/^\d{10}$/.test(f[k].trim())) fe[k] = t('reg_err_invalid_id');
    if (f.phone.trim() && !/^\+?[0-9 ]{7,20}$/.test(f.phone.trim())) fe.phone = t('reg_err_phone');
    if (f.father_id.trim() && f.father_id.trim() === f.mother_id.trim()) fe.mother_id = t('reg_err_same_parent');
    setFieldErrors(fe);
    if (Object.keys(fe).length) {
      setErrors(fieldItems(fe, (k) => label(k as FieldKey)));
      return;
    }
    setErrors([]); setBusy(true);
    try {
      const body = {
        given_name: { ar: f.given_ar.trim(), en: f.given_en.trim() }, family_name: { ar: f.family_ar.trim(), en: f.family_en.trim() },
        gender: f.gender, birth_date: f.birth_date, city_index: Number(f.city), district_index: Number(f.district), street: f.street.trim(), phone: f.phone.trim(),
        ...(f.father_id.trim() ? { father_id: f.father_id.trim() } : {}), ...(f.mother_id.trim() ? { mother_id: f.mother_id.trim() } : {}),
        ...(f.spouse_id.trim() ? { spouse_id: f.spouse_id.trim() } : {}),
        reason: f.reason, ...(f.reference.trim() ? { reference: f.reference.trim() } : {}),
        ...(dupes && confirmDupe ? { confirm_not_duplicate: true } : {}),
      };
      const r = await api<{ person: Person; activation: Activation }>('/api/identity/registry/persons', { body });
      setResult(r); setF(EMPTY); setDupes(null); setConfirmDupe(false);
      announce(t('reg_done_announce', { name: `${b(r.person.given_name)} ${b(r.person.family_name)}`, id: r.person.national_id.split('').join(' ') }));
      window.setTimeout(() => document.getElementById('reg-result-h')?.focus(), 50);
      loadRegs();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'possible_duplicate') {
        const ids = (err.details as any)?.national_ids ?? [];
        setDupes(ids);
        setErrors([t('reg_err_duplicate', { ids: ids.join('، ') })]);
      } else if (err instanceof ApiError && err.code === 'validation_failed') {
        const sfe: Partial<Record<FieldKey, string>> = {};
        for (const p of ((err.details as any)?.problems ?? []) as { field: string; code: string }[]) {
          const k = SERVER_FIELD[p.field];
          if (k) sfe[k] = hasKey(`reg_err_${p.code}`) ? t(`reg_err_${p.code}` as Key) : p.code;
        }
        setFieldErrors(sfe);
        setErrors(Object.keys(sfe).length ? fieldItems(sfe, (k) => label(k as FieldKey)) : [errorText(err)]);
      } else {
        setErrors([errorText(err)]);
      }
    } finally { setBusy(false); }
  };

  const reissue = async (id: string) => {
    setBusy(true); setErrors([]);
    try {
      const a = await api<Activation>(`/api/identity/registry/persons/${id}/activation-code`, { method: 'POST', body: {} });
      setReissued({ id, activation: a });
      announce(t('reg_reissued', { id: id.split('').join(' ') }));
      loadRegs();
    } catch (e) { setErrors([errorText(e)]); } finally { setBusy(false); }
  };

  const describedBy = (k: FieldKey, hint = false) => [hint ? `${k}-hint` : '', fieldErrors[k] ? `${k}-err` : ''].filter(Boolean).join(' ') || undefined;
  const text = (k: FieldKey, extra: { hint?: string; lang?: 'ar' | 'en'; type?: string; inputMode?: 'numeric' | 'tel'; maxLength?: number; autoComplete?: string; required?: boolean } = {}) => (
    <Field k={k} label={label(k)} hint={extra.hint} error={fieldErrors[k]} required={extra.required ?? true}>
      <input
        id={k} name={k} type={extra.type ?? 'text'} lang={extra.lang} dir={extra.lang === 'ar' ? 'rtl' : extra.lang === 'en' || extra.inputMode ? 'ltr' : undefined}
        inputMode={extra.inputMode} maxLength={extra.maxLength ?? 40} autoComplete={extra.autoComplete ?? 'off'}
        value={f[k]} onChange={(e) => set(k)(e.target.value)} aria-required={extra.required ?? true}
        aria-invalid={!!fieldErrors[k]} aria-describedby={describedBy(k, !!extra.hint)}
      />
    </Field>
  );
  const radios = (k: 'gender' | 'reason', values: string[]) => (
    <fieldset className="field" aria-describedby={fieldErrors[k] ? `${k}-err` : undefined}>
      <legend>{label(k)} <span className="required">{t('reg_required')}</span></legend>
      {fieldErrors[k] && <p id={`${k}-err`} className="field-error">{fieldErrors[k]}</p>}
      {values.map((v) => (
        <div key={v} className="choice">
          <input type="radio" id={`${k}-${v}`} name={k} value={v} checked={f[k] === v} onChange={() => set(k)(v)} />
          <label htmlFor={`${k}-${v}`}>{t(`reg_${k}_${v.replace('-', '_')}` as Key)}</label>
        </div>
      ))}
    </fieldset>
  );
  const select = (k: 'city' | 'district', items: { index: number; name: Bi }[]) => (
    <Field k={k} label={label(k)} error={fieldErrors[k]} required>
      <select id={k} value={f[k]} onChange={(e) => set(k)(e.target.value)} aria-required aria-invalid={!!fieldErrors[k]} aria-describedby={describedBy(k)}>
        <option value="">{t('reg_choose')}</option>
        {items.map((i) => <option key={i.index} value={String(i.index)}>{b(i.name)}</option>)}
      </select>
    </Field>
  );

  return (
    <>
      <PageTitle text={t('regTitle')} />
      {me && <p className="lead">{t('regWho', { name: b(me.name), id: me.employee_id })}</p>}
      <p className="note" role="note">{t('regRules')}</p>
      <ErrorSummary title={t('errorTitle')} messages={errors} />

      {result && (
        <section aria-labelledby="reg-result-h" className="panel">
          <h2 id="reg-result-h" tabIndex={-1}>{t('reg_done', { name: `${b(result.person.given_name)} ${b(result.person.family_name)}` })}</h2>
          <dl className="facts">
            <div><dt>{t('fieldNationalId')}</dt><dd dir="ltr" className="big-id">{result.person.national_id}</dd></div>
            <div><dt>{t('fieldBirthDate')}</dt><dd>{fmtDate(result.person.birth_date)}</dd></div>
          </dl>
          {result.person.family.length > 0 && (
            <>
              <h3>{t('citizenFamily')}</h3>
              <ul className="plain-list">{result.person.family.map((m) => <li key={m.national_id}>{hasKey(`rel_${m.relation}`) ? t(`rel_${m.relation}` as Key) : m.relation}: {b(m.name)} <span className="muted" dir="ltr">({m.national_id})</span></li>)}</ul>
            </>
          )}
          <ActivationBox activation={result.activation} />
          <p><button type="button" className="btn btn-secondary" onClick={() => { setResult(null); window.setTimeout(() => document.getElementById('given_ar')?.focus(), 50); }}>{t('reg_another')}</button></p>
        </section>
      )}

      {!result && (
        <section aria-labelledby="reg-form-h" className="panel">
          <h2 id="reg-form-h">{t('regFormHeading')}</h2>
          <p className="hint">{t('reg_required_note')}</p>
          {!opts ? (errors.length ? null : <Loading />) : (
            <form onSubmit={submit} noValidate>
              {radios('reason', ['naturalization', 'missing-record'])}
              {text('reference', { hint: t('reg_reference_hint'), maxLength: 60, required: false })}

              <fieldset className="field">
                <legend>{t('reg_names')}</legend>
                {text('given_ar', { lang: 'ar' })}
                {text('family_ar', { lang: 'ar' })}
                {text('given_en', { lang: 'en' })}
                {text('family_en', { lang: 'en' })}
              </fieldset>
              {radios('gender', ['F', 'M'])}
              {text('birth_date', { type: 'date', hint: t('reg_birth_hint'), maxLength: 10 })}

              <fieldset className="field">
                <legend>{t('reg_address')}</legend>
                {select('city', opts.cities)}
                {select('district', opts.districts)}
                {text('street', { maxLength: 60 })}
              </fieldset>
              {text('phone', { type: 'tel', inputMode: 'tel', hint: t('reg_phone_hint'), maxLength: 20 })}

              <fieldset className="field">
                <legend>{t('reg_family')}</legend>
                <p className="hint">{t('reg_family_hint')}</p>
                {text('father_id', { inputMode: 'numeric', maxLength: 10, required: false })}
                {text('mother_id', { inputMode: 'numeric', maxLength: 10, required: false })}
                {text('spouse_id', { inputMode: 'numeric', maxLength: 10, required: false, hint: t('reg_spouse_hint') })}
              </fieldset>

              {dupes && (
                <div className="choice warning-box">
                  <input type="checkbox" id="confirm-dupe" checked={confirmDupe} onChange={(e) => setConfirmDupe(e.target.checked)} />
                  <label htmlFor="confirm-dupe">{t('reg_confirm_dupe', { ids: dupes.join('، ') })}</label>
                </div>
              )}
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('working') : t('reg_submit')}</button>
            </form>
          )}
        </section>
      )}

      <section aria-labelledby="reg-list-h" className="panel">
        <h2 id="reg-list-h">{t('reg_list')}</h2>
        {reissued && (
          <div role="status">
            <p className="check-ok">{t('reg_reissued', { id: reissued.id })}</p>
            <ActivationBox activation={reissued.activation} />
          </div>
        )}
        {!regs ? <Loading /> : regs.length === 0 ? <p>{t('reg_none')}</p> : (
          <TableRegion caption={t('reg_list')} visuallyHiddenCaption>
            <thead><tr><th scope="col">{t('fieldNationalId')}</th><th scope="col">{t('reg_col_by')}</th><th scope="col">{t('reg_reason')}</th><th scope="col">{t('colWhen')}</th><th scope="col">{t('reg_col_status')}</th><th scope="col">{t('reg_col_action')}</th></tr></thead>
            <tbody>
              {regs.map((r) => (
                <tr key={r.national_id}>
                  <th scope="row" dir="ltr">{r.national_id}</th>
                  <td dir="ltr">{r.employee_id}</td>
                  <td>{hasKey(`reg_reason_${(r.reason ?? '').replace('-', '_')}`) ? t(`reg_reason_${r.reason.replace('-', '_')}` as Key) : r.reason}</td>
                  <td>{fmtDate(r.at, true)}</td>
                  <td>{r.activated ? t('reg_status_active') : r.locked ? t('reg_status_locked') : t('reg_status_waiting')}</td>
                  <td>{!r.activated && (
                    <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => reissue(r.national_id)}
                      aria-label={t('reg_reissue_for', { id: r.national_id })}>{t('reg_reissue')}</button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </TableRegion>
        )}
      </section>
    </>
  );
}

function Field({ k, label, hint, error, required, children }: { k: string; label: string; hint?: string; error?: string; required: boolean; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="field">
      <label htmlFor={k}>{label}{required ? <> <span className="required">{t('reg_required')}</span></> : <> <span className="muted">{t('reg_optional')}</span></>}</label>
      {hint && <p id={`${k}-hint`} className="hint">{hint}</p>}
      {error && <p id={`${k}-err`} className="field-error">{error}</p>}
      {children}
    </div>
  );
}

function ActivationBox({ activation }: { activation: Activation }) {
  const { t, fmtDate } = useI18n();
  const id = useId();
  return (
    <div className="code-sent" role="note" aria-labelledby={id}>
      <h3 id={id}>{t('reg_activation_heading')}</h3>
      {activation.sent ? (
        <>
          <p className="check-ok">{t('reg_activation_sent')}</p>
          <p>{t('reg_activation_expires', { date: fmtDate(activation.expires_at!, true) })}</p>
          <p>{t('reg_activation_how')}</p>
        </>
      ) : <p className="field-error">{t('reg_activation_not_sent')}</p>}
    </div>
  );
}
