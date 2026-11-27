// Manage citizen — Ministry of Education: degrees and certificates (add / correct / remove) and current studies.
import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { useI18n, type Bi } from '../../i18n.tsx';
import { Loading, TableRegion } from '../../a11y.tsx';
import { Changes, ConfirmBox, FieldErrors, isYear, ManageFrame, SelectField, Section, TextField, useConfirm, useOptions, usePersonName, useRecord, type Change } from './common.tsx';

interface Degree { id: string; level: string; level_name: Bi; field: Bi; institution: Bi; graduation_year: number; grade: Bi; institution_index: number; major_index: number; grade_index: number }
interface Edu { degrees: Degree[]; enrollment: { institution: Bi; stage: Bi; since_year: number; institution_index: number; stage_index: number } | null; changes: Change[] }

const EMPTY = { level: '', institution: '', major: '', year: '', grade: '' };

export function ManageEducation() {
  const { id = '' } = useParams();
  const { t, b } = useI18n();
  const opts = useOptions();
  const name = usePersonName();
  const r = useRecord<Edu>('education', id);
  const confirm = useConfirm();
  const confirmStudies = useConfirm();
  const [f, setF] = useState(EMPTY);
  const [editing, setEditing] = useState<Degree | null>(null);
  const [en, setEn] = useState({ institution: '', stage: '', since: '' });
  const d = r.data;
  const thisYear = new Date().getUTCFullYear();

  const L = { 'deg-level': t('mg_level'), 'deg-institution': t('mg_institution'), 'deg-major': t('mg_major'), 'deg-year': t('mg_grad_year'), 'deg-grade': t('mg_grade'),
    'enr-institution': t('mg_institution'), 'enr-stage': t('mg_stage'), 'enr-since': t('mg_since_year') };
  const degreeLabel = (x: Degree) => `${b(x.level_name)} — ${b(x.field)} (${x.graduation_year})`;

  const startEdit = (x: Degree) => {
    setEditing(x);
    setF({ level: x.level, institution: x.institution_index >= 0 ? String(x.institution_index) : '', major: x.major_index >= 0 ? String(x.major_index) : '', year: String(x.graduation_year), grade: x.grade_index >= 0 ? String(x.grade_index) : '' });
    window.setTimeout(() => document.getElementById('degform-h')?.focus(), 50);
  };
  const stopEdit = (focusBack?: string) => { const back = editing ? `edit-${editing.id}` : null; setEditing(null); setF(EMPTY); if (focusBack !== 'none' && back) window.setTimeout(() => document.getElementById(back)?.focus(), 50); };

  const saveDegree = async (e: FormEvent) => {
    e.preventDefault();
    const fe: Record<string, string> = {};
    for (const [k, v] of [['deg-level', f.level], ['deg-institution', f.institution], ['deg-major', f.major], ['deg-grade', f.grade]] as const) if (!v) fe[k] = t('errRequired');
    if (!isYear(f.year)) fe['deg-year'] = t('mg_err_year'); else if (Number(f.year) > thisYear) fe['deg-year'] = t('mg_err_in_future');
    if (Object.keys(fe).length) return r.invalid(fe, L);
    const body = { level: f.level, institution_index: Number(f.institution), major_index: Number(f.major), graduation_year: Number(f.year), grade_index: Number(f.grade) };
    const ok = await r.run({
      method: editing ? 'PUT' : 'POST', path: editing ? `/degrees/${editing.id}` : '/degrees', body, section: 'degrees', labels: L,
      success: editing ? t('mg_ok_degree_updated') : t('mg_ok_degree_added'),
      fields: { level: 'deg-level', institution_index: 'deg-institution', major_index: 'deg-major', graduation_year: 'deg-year', grade_index: 'deg-grade' },
    });
    if (ok) stopEdit('none');
  };
  const saveEnrollment = (e: FormEvent) => {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (!en.institution) fe['enr-institution'] = t('errRequired');
    if (!en.stage) fe['enr-stage'] = t('errRequired');
    if (!isYear(en.since)) fe['enr-since'] = t('mg_err_year'); else if (Number(en.since) > thisYear) fe['enr-since'] = t('mg_err_in_future');
    if (Object.keys(fe).length) return r.invalid(fe, L);
    r.run({ method: 'PUT', path: '/enrollment', section: 'studies', success: t('mg_ok_enrollment'), labels: L,
      fields: { institution_index: 'enr-institution', stage_index: 'enr-stage', since_year: 'enr-since' },
      body: { institution_index: Number(en.institution), stage_index: Number(en.stage), since_year: Number(en.since) } });
  };

  return (
    <ManageFrame id={id} ministry="education" name={name} errors={r.errors}>
      <FieldErrors errors={r.fieldErrors}>
        {!d || !opts ? (r.errors.length ? null : <Loading />) : (
          <>
            <Section id="degrees" title={t('mg_degrees')} status={r.status}>
              {d.degrees.length === 0 ? <p>{t('mg_no_degrees')}</p> : (
                <TableRegion caption={t('mg_degrees')} visuallyHiddenCaption>
                  <thead><tr><th scope="col">{t('mg_level')}</th><th scope="col">{t('mg_major')}</th><th scope="col">{t('mg_institution')}</th><th scope="col">{t('mg_grad_year')}</th><th scope="col">{t('mg_grade')}</th><th scope="col">{t('reg_col_action')}</th></tr></thead>
                  <tbody>
                    {d.degrees.map((x) => (
                      <tr key={x.id}>
                        <th scope="row">{b(x.level_name)}</th><td>{b(x.field)}</td><td>{b(x.institution)}</td><td>{x.graduation_year}</td><td>{b(x.grade)}</td>
                        <td className="row-actions">
                          <button type="button" id={`edit-${x.id}`} className="btn btn-secondary btn-small" aria-label={t('mg_edit_named', { what: degreeLabel(x) })} onClick={() => startEdit(x)} disabled={r.busy}>{t('mg_edit')}</button>
                          <button type="button" id={`del-${x.id}`} className="btn btn-secondary btn-small" aria-label={t('mg_remove_named', { what: degreeLabel(x) })} disabled={r.busy}
                            onClick={() => confirm.ask(t('mg_remove_q', { what: degreeLabel(x) }), t('mg_remove'), () => r.run({ method: 'DELETE', path: `/degrees/${x.id}`, section: 'degrees', success: t('mg_ok_degree_removed') }), `del-${x.id}`)}>{t('mg_remove')}</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </TableRegion>
              )}
              <ConfirmBox c={confirm} />
            </Section>

            <section aria-labelledby="degform-h" className="panel">
              <h2 id="degform-h" tabIndex={-1}>{editing ? t('mg_edit_degree', { what: degreeLabel(editing) }) : t('mg_add_degree')}</h2>
              <form onSubmit={saveDegree} noValidate>
                <SelectField id="deg-level" label={L['deg-level']} value={f.level} onChange={(v) => setF({ ...f, level: v })} options={opts.degree_levels.map((l) => ({ value: l.value, label: b(l.name) }))} />
                <SelectField id="deg-institution" label={L['deg-institution']} value={f.institution} onChange={(v) => setF({ ...f, institution: v })} options={opts.institutions.map((x, i) => ({ value: String(i), label: b(x) }))} />
                <SelectField id="deg-major" label={L['deg-major']} value={f.major} onChange={(v) => setF({ ...f, major: v })} options={opts.majors.map((x, i) => ({ value: String(i), label: b(x) }))} />
                <TextField id="deg-year" label={L['deg-year']} value={f.year} onChange={(v) => setF({ ...f, year: v })} inputMode="numeric" maxLength={4} hint={t('mg_year_hint')} />
                <SelectField id="deg-grade" label={L['deg-grade']} value={f.grade} onChange={(v) => setF({ ...f, grade: v })} options={opts.grades.map((x, i) => ({ value: String(i), label: b(x) }))} />
                <div className="actions">
                  <button type="submit" className="btn btn-primary" disabled={r.busy}>{editing ? t('mg_save_changes') : t('mg_add_degree')}</button>
                  {editing && <button type="button" className="btn btn-secondary" onClick={() => stopEdit()}>{t('mg_cancel')}</button>}
                </div>
              </form>
            </section>

            <Section id="studies" title={t('mg_studies')} status={r.status}>
              {d.enrollment ? (
                <>
                  <p>{b(d.enrollment.stage)} — {b(d.enrollment.institution)} ({t('mg_since', { date: String(d.enrollment.since_year) })})</p>
                  <p><button type="button" id="end-studies" className="btn btn-secondary" disabled={r.busy}
                    onClick={() => confirmStudies.ask(t('mg_end_studies_q'), t('mg_end_studies'), () => r.run({ method: 'DELETE', path: '/enrollment', section: 'studies', success: t('mg_ok_enrollment_ended') }), 'end-studies')}>{t('mg_end_studies')}</button></p>
                </>
              ) : <p>{t('mg_no_studies')}</p>}
              <ConfirmBox c={confirmStudies} />
              <h3>{d.enrollment ? t('mg_change_studies') : t('mg_record_studies')}</h3>
              <form onSubmit={saveEnrollment} noValidate>
                <SelectField id="enr-institution" label={L['enr-institution']} value={en.institution} onChange={(v) => setEn({ ...en, institution: v })} options={opts.institutions.map((x, i) => ({ value: String(i), label: b(x) }))} />
                <SelectField id="enr-stage" label={L['enr-stage']} value={en.stage} onChange={(v) => setEn({ ...en, stage: v })} options={opts.study_stages.map((x, i) => ({ value: String(i), label: b(x) }))} />
                <TextField id="enr-since" label={L['enr-since']} value={en.since} onChange={(v) => setEn({ ...en, since: v })} inputMode="numeric" maxLength={4} hint={t('mg_year_hint')} />
                <button type="submit" className="btn btn-primary" disabled={r.busy}>{t('mg_save_studies')}</button>
              </form>
            </Section>

            <Changes changes={d.changes} status={r.status} />
          </>
        )}
      </FieldErrors>
    </ManageFrame>
  );
}
