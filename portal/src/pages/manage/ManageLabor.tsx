// Manage citizen — Ministry of Labor & Social Insurance: job history (employer, job title, salary, start /
// end date) and what the person is when no job is current. The current employment — what the employment &
// income proof (e.g. for a bank) is built from — is recomputed by the ministry after every change.
import { useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { useI18n, type Bi } from '../../i18n.tsx';
import { Loading, TableRegion } from '../../a11y.tsx';
import { Changes, ConfirmBox, FieldErrors, isIsoDate, ManageFrame, SelectField, Section, TextField, today, useConfirm, useOptions, usePersonName, useRecord, type Change } from './common.tsx';

interface Job { id: string; employer: Bi; sector: string; job_title: Bi; monthly_salary: number; start_date: string; end_date: string | null; current: boolean; employer_index: number; job_title_index: number }
interface Labor {
  current: { status: string; status_name: Bi; employer: { name: Bi; sector: string } | null; job_title: Bi | null; since: string | null; monthly_income: number; income_bracket: Bi; income_source: Bi } | null;
  base_status: string | null; base_income: number; jobs: Job[];
  social_insurance: { number: string; contribution_months: number; pension: number | null } | null;
  benefits: { id: string; kind: string; monthly_amount: number; starts_on: string; status: string; reason: Bi }[];
  changes: Change[];
}
const EMPTY = { employer: '', title: '', salary: '', start: '', end: '' };

export function ManageLabor() {
  const { id = '' } = useParams();
  const { t, b, fmtDate } = useI18n();
  const opts = useOptions();
  const name = usePersonName();
  const r = useRecord<Labor>('labor', id);
  const confirm = useConfirm();
  const [f, setF] = useState(EMPTY);
  const [editing, setEditing] = useState<Job | null>(null);
  const [st, setSt] = useState({ status: '', income: '' });
  const d = r.data;
  useEffect(() => { if (d && !st.status) setSt({ status: d.base_status ?? '', income: d.base_status ? String(d.base_income) : '' }); }, [d]); // eslint-disable-line react-hooks/exhaustive-deps

  const money = (n: number) => t('mg_srd', { n: n.toLocaleString('en') });
  const L = { 'job-employer': t('mg_employer'), 'job-title': t('mg_job_title'), 'job-salary': t('mg_salary'), 'job-start': t('mg_start_date'), 'job-end': t('mg_end_date'),
    'st-status': t('mg_non_job_status'), 'st-income': t('mg_monthly_income') };
  const jobLabel = (j: Job) => `${b(j.job_title)} — ${b(j.employer)} (${fmtDate(j.start_date)})`;

  const startEdit = (j: Job) => {
    setEditing(j);
    setF({ employer: j.employer_index >= 0 ? String(j.employer_index) : '', title: j.job_title_index >= 0 ? String(j.job_title_index) : '', salary: String(j.monthly_salary), start: j.start_date, end: j.end_date ?? '' });
    window.setTimeout(() => document.getElementById('jobform-h')?.focus(), 50);
  };
  const stopEdit = (focus = true) => { const back = editing ? `edit-${editing.id}` : null; setEditing(null); setF(EMPTY); if (focus && back) window.setTimeout(() => document.getElementById(back)?.focus(), 50); };

  const saveJob = async (e: FormEvent) => {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (!f.employer) fe['job-employer'] = t('errRequired');
    if (!f.title) fe['job-title'] = t('errRequired');
    if (!/^\d{1,7}$/.test(f.salary.trim()) || Number(f.salary) < 1) fe['job-salary'] = t('mg_err_salary');
    if (!isIsoDate(f.start)) fe['job-start'] = t('mg_err_invalid_date'); else if (f.start > today()) fe['job-start'] = t('mg_err_in_future');
    if (f.end && !isIsoDate(f.end)) fe['job-end'] = t('mg_err_invalid_date'); else if (f.end && isIsoDate(f.start) && f.end < f.start) fe['job-end'] = t('mg_err_before_start');
    if (Object.keys(fe).length) return r.invalid(fe, L);
    const body = { employer_index: Number(f.employer), job_title_index: Number(f.title), monthly_salary: Number(f.salary), start_date: f.start, end_date: f.end || null };
    const ok = await r.run({
      method: editing ? 'PUT' : 'POST', path: editing ? `/jobs/${editing.id}` : '/jobs', body, section: 'jobs', labels: L,
      success: editing ? t('mg_ok_job_updated') : t('mg_ok_job_added'),
      fields: { employer_index: 'job-employer', job_title_index: 'job-title', monthly_salary: 'job-salary', start_date: 'job-start', end_date: 'job-end' },
    });
    if (ok) stopEdit(false);
  };
  const saveStatus = (e: FormEvent) => {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (!st.status) fe['st-status'] = t('errRequired');
    const income = st.income.trim() === '' ? 0 : Number(st.income);
    if (st.income.trim() && !/^\d{1,7}$/.test(st.income.trim())) fe['st-income'] = t('mg_err_salary');
    else if ((st.status === 'self_employed' || st.status === 'retired') && income < 1) fe['st-income'] = t('mg_err_required_positive');
    else if ((st.status === 'job_seeking' || st.status === 'student') && income !== 0) fe['st-income'] = t('mg_err_must_be_zero');
    if (Object.keys(fe).length) return r.invalid(fe, L);
    r.run({ method: 'PUT', path: '/status', section: 'nojob', success: t('mg_ok_status'), labels: L, fields: { status: 'st-status', monthly_income: 'st-income' }, body: { status: st.status, monthly_income: income } });
  };

  const c = d?.current;
  return (
    <ManageFrame id={id} ministry="labor" name={name} errors={r.errors}>
      <FieldErrors errors={r.fieldErrors}>
        {!d || !opts ? (r.errors.length ? null : <Loading />) : (
          <>
            <Section id="current" title={t('mg_current_employment')} status={r.status}>
              <p className="hint">{t('mg_current_employment_hint')}</p>
              {!c ? <p>{t('mg_no_employment')}</p> : (
                <dl className="facts">
                  <div><dt>{t('mg_status')}</dt><dd>{b(c.status_name)}</dd></div>
                  <div><dt>{t('mg_employer')}</dt><dd>{c.employer ? b(c.employer.name) : t('mg_none')}</dd></div>
                  <div><dt>{t('mg_job_title')}</dt><dd>{c.job_title ? b(c.job_title) : t('mg_none')}</dd></div>
                  <div><dt>{t('mg_since_label')}</dt><dd>{c.since ? fmtDate(c.since) : t('mg_none')}</dd></div>
                  <div><dt>{t('mg_monthly_income')}</dt><dd>{money(c.monthly_income)}</dd></div>
                  <div><dt>{t('mg_income_source')}</dt><dd>{b(c.income_source)}</dd></div>
                  <div><dt>{t('mg_income_bracket')}</dt><dd>{b(c.income_bracket)}</dd></div>
                </dl>
              )}
            </Section>

            <Section id="jobs" title={t('mg_jobs')} status={r.status}>
              {d.jobs.length === 0 ? <p>{t('mg_no_jobs')}</p> : (
                <TableRegion caption={t('mg_jobs')} visuallyHiddenCaption>
                  <thead><tr><th scope="col">{t('mg_job_title')}</th><th scope="col">{t('mg_employer')}</th><th scope="col">{t('mg_salary')}</th><th scope="col">{t('mg_start_date')}</th><th scope="col">{t('mg_end_date')}</th><th scope="col">{t('reg_col_action')}</th></tr></thead>
                  <tbody>
                    {d.jobs.map((j) => (
                      <tr key={j.id}>
                        <th scope="row">{b(j.job_title)}</th><td>{b(j.employer)}</td><td>{money(j.monthly_salary)}</td><td>{fmtDate(j.start_date)}</td>
                        <td>{j.end_date ? fmtDate(j.end_date) : t('mg_current_job')}</td>
                        <td className="row-actions">
                          <button type="button" id={`edit-${j.id}`} className="btn btn-secondary btn-small" aria-label={t('mg_edit_named', { what: jobLabel(j) })} onClick={() => startEdit(j)} disabled={r.busy}>{t('mg_edit')}</button>
                          <button type="button" id={`del-${j.id}`} className="btn btn-secondary btn-small" aria-label={t('mg_remove_named', { what: jobLabel(j) })} disabled={r.busy}
                            onClick={() => confirm.ask(t('mg_remove_q', { what: jobLabel(j) }), t('mg_remove'), () => r.run({ method: 'DELETE', path: `/jobs/${j.id}`, section: 'jobs', success: t('mg_ok_job_removed') }), `del-${j.id}`)}>{t('mg_remove')}</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </TableRegion>
              )}
              <ConfirmBox c={confirm} />
            </Section>

            <section aria-labelledby="jobform-h" className="panel">
              <h2 id="jobform-h" tabIndex={-1}>{editing ? t('mg_edit_job', { what: jobLabel(editing) }) : t('mg_add_job')}</h2>
              <form onSubmit={saveJob} noValidate>
                <SelectField id="job-employer" label={L['job-employer']} value={f.employer} onChange={(v) => setF({ ...f, employer: v })} options={opts.employers.map((x, i) => ({ value: String(i), label: b(x.name) }))} />
                <SelectField id="job-title" label={L['job-title']} value={f.title} onChange={(v) => setF({ ...f, title: v })} options={opts.job_titles.map((x, i) => ({ value: String(i), label: b(x) }))} />
                <TextField id="job-salary" label={L['job-salary']} value={f.salary} onChange={(v) => setF({ ...f, salary: v })} inputMode="numeric" maxLength={7} hint={t('mg_salary_hint')} />
                <TextField id="job-start" label={L['job-start']} value={f.start} onChange={(v) => setF({ ...f, start: v })} type="date" hint={t('mg_date_hint')} />
                <TextField id="job-end" label={L['job-end']} value={f.end} onChange={(v) => setF({ ...f, end: v })} type="date" required={false} hint={t('mg_end_date_hint')} />
                <div className="actions">
                  <button type="submit" className="btn btn-primary" disabled={r.busy}>{editing ? t('mg_save_changes') : t('mg_add_job')}</button>
                  {editing && <button type="button" className="btn btn-secondary" onClick={() => stopEdit()}>{t('mg_cancel')}</button>}
                </div>
              </form>
            </section>

            <Section id="nojob" title={t('mg_nojob_heading')} status={r.status}>
              <p className="hint">{t('mg_nojob_hint')}</p>
              <form onSubmit={saveStatus} noValidate>
                <SelectField id="st-status" label={L['st-status']} value={st.status} onChange={(v) => setSt({ ...st, status: v })} options={opts.non_job_statuses.map((x) => ({ value: x.value, label: b(x.name) }))} />
                <TextField id="st-income" label={L['st-income']} value={st.income} onChange={(v) => setSt({ ...st, income: v })} inputMode="numeric" maxLength={7} required={false} hint={t('mg_income_hint')} />
                <button type="submit" className="btn btn-primary" disabled={r.busy}>{t('mg_save_status')}</button>
              </form>
            </Section>

            <Section id="insurance" title={t('mg_insurance')} status={r.status}>
              {d.social_insurance ? (
                <dl className="facts">
                  <div><dt>{t('mg_si_number')}</dt><dd dir="ltr">{d.social_insurance.number}</dd></div>
                  <div><dt>{t('mg_si_months')}</dt><dd>{d.social_insurance.contribution_months}</dd></div>
                </dl>
              ) : <p>{t('mg_no_insurance')}</p>}
              <h3>{t('mg_benefits')}</h3>
              <p className="hint">{t('mg_benefits_hint')}</p>
              {d.benefits.length === 0 ? <p>{t('mg_no_benefits')}</p> : (
                <ul className="plain-list">{d.benefits.map((x) => <li key={x.id}>{b(x.reason)} — {money(x.monthly_amount)}</li>)}</ul>
              )}
            </Section>

            <Changes changes={d.changes} status={r.status} />
          </>
        )}
      </FieldErrors>
    </ManageFrame>
  );
}
