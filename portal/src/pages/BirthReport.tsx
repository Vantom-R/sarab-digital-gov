// Hospital staff report a birth (permission births.report — the administrator has it). No name: the
// parents choose it in Mithaq; the Civil Registry then registers the child.
//
// Accessibility: every control has a visible label with hint/error tied by aria-describedby; the sex is a
// fieldset of radio buttons with a legend; a failed send focuses the error summary; a successful send
// focuses the result heading and is announced; "Report another birth" returns focus to the first field.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api.ts';
import { useI18n, type Bi } from '../i18n.tsx';
import { ErrorSummary, fieldItems, type ErrorItem, Loading, PageTitle, useAnnounce } from '../a11y.tsx';
import { useErrorText } from '../session.tsx';
import { FieldErrors, isIsoDate, isNid, SelectField, TextField, today, useFieldError, useProblemText } from './manage/common.tsx';

interface Opts { hospitals: Bi[]; name_deadline_days: number; employee_id: string }
interface Parent { national_id: string; name: Bi; has_account: boolean }
interface Done { notification_id: string; hospital: Bi; mother: Parent; father: Parent | null }
const EMPTY = { mother: '', father: '', sex: '', date: '', hospital: '', record: '', another: false };
const FIELD: Record<string, string> = { mother_id: 'br-mother', father_id: 'br-father', birth_date: 'br-date', hospital_index: 'br-hospital', record_no: 'br-record', child_gender: 'br-sex' };

function SexField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useI18n();
  const error = useFieldError('br-sex');
  return (
    <fieldset className="field" id="br-sex" tabIndex={-1} aria-describedby={error ? 'br-sex-err' : undefined}>
      <legend>{t('br_sex')} <span className="required">{t('reg_required')}</span></legend>
      {error && <p id="br-sex-err" className="field-error">{error}</p>}
      {(['F', 'M'] as const).map((g) => (
        <div key={g} className="choice">
          <input type="radio" id={`br-sex-${g}`} name="br-sex" value={g} checked={value === g} onChange={() => onChange(g)} aria-invalid={!!error} />
          <label htmlFor={`br-sex-${g}`}>{t(`gender_${g}`)}</label>
        </div>
      ))}
    </fieldset>
  );
}

export function BirthReport() {
  const { t, b, fmtDate } = useI18n();
  const announce = useAnnounce();
  const errorText = useErrorText();
  const problemText = useProblemText();
  const [opts, setOpts] = useState<Opts | null>(null);
  const [f, setF] = useState(EMPTY);
  const [errors, setErrors] = useState<ErrorItem[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const doneRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => { api<Opts>('/api/identity/staff/births/options').then(setOpts).catch((e) => setErrors([errorText(e)])); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (done) doneRef.current?.focus(); }, [done]);

  const L: Record<string, string> = { 'br-mother': t('br_mother'), 'br-father': t('br_father'), 'br-sex': t('br_sex'), 'br-date': t('br_date'), 'br-hospital': t('br_hospital'), 'br-record': t('br_record_no') };
  const show = (fe: Record<string, string>) => { setFieldErrors(fe); setErrors(fieldItems(fe, (k) => L[k] ?? t('mg_field'))); };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (!isNid(f.mother)) fe['br-mother'] = t('mg_err_invalid_id');
    if (f.father.trim() && !isNid(f.father)) fe['br-father'] = t('mg_err_invalid_id');
    else if (f.father.trim() && f.father.trim() === f.mother.trim()) fe['br-father'] = t('mg_err_same_person');
    if (!f.sex) fe['br-sex'] = t('br_choose_sex');
    if (!isIsoDate(f.date)) fe['br-date'] = t('mg_err_invalid_date'); else if (f.date > today()) fe['br-date'] = t('mg_err_in_future');
    if (!f.hospital) fe['br-hospital'] = t('errRequired');
    if (f.record.trim() && !/^[A-Za-z0-9 _-]{1,40}$/.test(f.record.trim())) fe['br-record'] = t('mg_err_invalid_record_no');
    if (Object.keys(fe).length) return show(fe);
    setBusy(true); setErrors([]); setFieldErrors({});
    try {
      const r = await api<Done>('/api/identity/staff/births', {
        body: { mother_id: f.mother.trim(), father_id: f.father.trim() || null, child_gender: f.sex, birth_date: f.date, hospital_index: Number(f.hospital), record_no: f.record.trim() || null, another_baby: f.another },
      });
      setDone(r);
      announce(t('br_sent_announce'));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'validation_failed') {
        const fe2: Record<string, string> = {};
        for (const p of ((err.details as any)?.problems ?? []) as { field: string; code: string }[]) fe2[FIELD[p.field] ?? p.field] = problemText(p.code);
        show(fe2);
      } else if (err instanceof ApiError && err.code === 'possible_duplicate') {
        setFieldErrors({ 'br-another': t('err_possible_duplicate_birth') });
        setErrors([{ field: 'br-another', text: t('err_possible_duplicate_birth') }]);
      } else setErrors([errorText(err)]);
    } finally { setBusy(false); }
  };

  const again = () => { setDone(null); setF(EMPTY); window.setTimeout(() => document.getElementById('br-mother')?.focus(), 50); };
  const parentLine = (role: 'mother' | 'father', p: Parent) => (
    <li>{t('br_parent_line', { role: t(`role_${role}`), name: b(p.name), id: p.national_id })} — {p.has_account ? t('br_has_account') : t('br_no_account')}</li>
  );

  return (
    <>
      <PageTitle text={t('br_title')} />
      <p className="lead">{t('br_intro', { days: String(opts?.name_deadline_days ?? 14) })}</p>
      {opts && <p className="note" role="note">{t('br_acting', { id: opts.employee_id })}</p>}
      <ErrorSummary title={t('errorTitle')} messages={errors} />
      {!opts ? (errors.length ? null : <Loading />) : done ? (
        <section aria-labelledby="br-done-h" className="panel">
          <h2 id="br-done-h" ref={doneRef} tabIndex={-1}>{t('br_done_h')}</h2>
          <p className="check-ok">{t('br_done', { id: done.notification_id, days: String(opts.name_deadline_days) })}</p>
          <ul className="plain-list">
            {parentLine('mother', done.mother)}
            {done.father && parentLine('father', done.father)}
            <li>{t('br_hospital')}: {b(done.hospital)} — {fmtDate(f.date)}</li>
          </ul>
          <button type="button" className="btn btn-primary" onClick={again}>{t('br_another_report')}</button>
        </section>
      ) : (
        <section aria-labelledby="br-form-h" className="panel">
          <h2 id="br-form-h">{t('br_form')}</h2>
          <FieldErrors errors={fieldErrors}>
            <form onSubmit={submit} noValidate>
              <TextField id="br-mother" label={L['br-mother']!} value={f.mother} onChange={(v) => setF({ ...f, mother: v })} inputMode="numeric" maxLength={10} hint={t('br_id_hint')} />
              <TextField id="br-father" label={L['br-father']!} value={f.father} onChange={(v) => setF({ ...f, father: v })} inputMode="numeric" maxLength={10} required={false} hint={t('br_father_hint')} />
              <SexField value={f.sex} onChange={(v) => setF({ ...f, sex: v })} />
              <TextField id="br-date" label={L['br-date']!} value={f.date} onChange={(v) => setF({ ...f, date: v })} type="date" hint={t('br_date_hint')} />
              <SelectField id="br-hospital" label={L['br-hospital']!} value={f.hospital} onChange={(v) => setF({ ...f, hospital: v })} options={opts.hospitals.map((h, i) => ({ value: String(i), label: b(h) }))} />
              <TextField id="br-record" label={L['br-record']!} value={f.record} onChange={(v) => setF({ ...f, record: v })} required={false} maxLength={40} dir="ltr" hint={t('br_record_hint')} />
              <AnotherBaby checked={f.another} onChange={(v) => setF({ ...f, another: v })} />
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('working') : t('br_submit')}</button>
            </form>
          </FieldErrors>
        </section>
      )}
    </>
  );
}

function AnotherBaby({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const { t } = useI18n();
  const error = useFieldError('br-another');
  return (
    <div className="field">
      <p id="br-another-hint" className="hint">{t('br_another_hint')}</p>
      {error && <p id="br-another-err" className="field-error">{error}</p>}
      <div className="choice">
        <input type="checkbox" id="br-another" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-describedby={`br-another-hint${error ? ' br-another-err' : ''}`} aria-invalid={!!error} />
        <label htmlFor="br-another">{t('br_another')}</label>
      </div>
    </div>
  );
}

