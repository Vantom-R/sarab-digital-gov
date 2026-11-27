// Manage citizen — Ministry of Health (minimal, fake): health summary and vaccinations.
import { useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { useI18n, type Bi } from '../../i18n.tsx';
import { Loading, TableRegion } from '../../a11y.tsx';
import { Changes, Checkbox, CheckboxGroup, ConfirmBox, FieldErrors, isIsoDate, ManageFrame, SelectField, Section, TextField, today, useConfirm, useOptions, usePersonName, useRecord, type Change } from './common.tsx';

interface Health {
  exists: boolean; blood_type?: string; organ_donor?: boolean; allergies?: Bi[]; chronic_conditions?: Bi[]; primary_clinic?: Bi;
  allergy_indices?: number[]; condition_indices?: number[]; clinic_index?: number;
  vaccinations: { id: number; name: Bi; given_on: string }[]; changes: Change[];
}

export function ManageHealth() {
  const { id = '' } = useParams();
  const { t, b, fmtDate } = useI18n();
  const opts = useOptions();
  const name = usePersonName();
  const r = useRecord<Health>('health', id);
  const confirm = useConfirm();
  const [h, setH] = useState({ blood: '', allergies: [] as string[], conditions: [] as string[], clinic: '', donor: false });
  const [vx, setVx] = useState({ vaccine: '', date: '' });
  const d = r.data;
  useEffect(() => {
    if (d?.exists) setH({ blood: d.blood_type ?? '', allergies: (d.allergy_indices ?? []).map(String), conditions: (d.condition_indices ?? []).map(String), clinic: d.clinic_index != null && d.clinic_index >= 0 ? String(d.clinic_index) : '', donor: !!d.organ_donor });
  }, [d?.exists, d?.blood_type, d?.clinic_index]); // eslint-disable-line react-hooks/exhaustive-deps

  const L = { 'h-blood': t('mg_blood_type'), 'h-clinic': t('mg_clinic'), 'vx-vaccine': t('mg_vaccine'), 'vx-date': t('mg_vaccine_date') };

  const saveSummary = (e: FormEvent) => {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (!h.blood) fe['h-blood'] = t('errRequired');
    if (!h.clinic) fe['h-clinic'] = t('errRequired');
    if (Object.keys(fe).length) return r.invalid(fe, L);
    r.run({ method: 'PUT', section: 'summary', success: d?.exists ? t('mg_ok_health_updated') : t('mg_ok_health_created'), labels: L, fields: { blood_type: 'h-blood', clinic_index: 'h-clinic' },
      body: { blood_type: h.blood, allergy_indices: h.allergies.map(Number), condition_indices: h.conditions.map(Number), clinic_index: Number(h.clinic), organ_donor: h.donor } });
  };
  const addVaccination = async (e: FormEvent) => {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (!vx.vaccine) fe['vx-vaccine'] = t('errRequired');
    if (!isIsoDate(vx.date)) fe['vx-date'] = t('mg_err_invalid_date'); else if (vx.date > today()) fe['vx-date'] = t('mg_err_in_future');
    if (Object.keys(fe).length) return r.invalid(fe, L);
    if (await r.run({ method: 'POST', path: '/vaccinations', section: 'vaccinations', success: t('mg_ok_vaccination_added'), labels: L, fields: { vaccine_index: 'vx-vaccine', given_on: 'vx-date' },
      body: { vaccine_index: Number(vx.vaccine), given_on: vx.date } })) setVx({ vaccine: '', date: '' });
  };

  return (
    <ManageFrame id={id} ministry="health" name={name} errors={r.errors}>
      <FieldErrors errors={r.fieldErrors}>
        <p className="note" role="note">{t('mg_health_note')}</p>
        {!d || !opts ? (r.errors.length ? null : <Loading />) : (
          <>
            <Section id="summary" title={t('mg_health_summary')} status={r.status}>
              {!d.exists && <p>{t('mg_no_health')}</p>}
              <form onSubmit={saveSummary} noValidate>
                <SelectField id="h-blood" label={L['h-blood']} value={h.blood} onChange={(v) => setH({ ...h, blood: v })} options={opts.blood_types.map((x) => ({ value: x, label: x === 'unknown' ? t('mg_unknown') : x }))} />
                <CheckboxGroup id="h-allergies" legend={t('mg_allergies')} hint={t('mg_tick_all')} options={opts.allergies.map((x, i) => ({ value: String(i), label: b(x) }))} selected={h.allergies} onChange={(v) => setH({ ...h, allergies: v })} />
                <CheckboxGroup id="h-conditions" legend={t('mg_conditions')} hint={t('mg_tick_all')} options={opts.conditions.map((x, i) => ({ value: String(i), label: b(x) }))} selected={h.conditions} onChange={(v) => setH({ ...h, conditions: v })} />
                <SelectField id="h-clinic" label={L['h-clinic']} value={h.clinic} onChange={(v) => setH({ ...h, clinic: v })} options={opts.clinics.map((x, i) => ({ value: String(i), label: b(x) }))} hint={t('mg_clinic_hint')} />
                <Checkbox id="h-donor" label={t('mg_organ_donor')} checked={h.donor} onChange={(v) => setH({ ...h, donor: v })} />
                <button type="submit" className="btn btn-primary" disabled={r.busy}>{d.exists ? t('mg_save_health') : t('mg_create_health')}</button>
              </form>
            </Section>

            {d.exists && (
              <Section id="vaccinations" title={t('mg_vaccinations')} status={r.status}>
                {d.vaccinations.length === 0 ? <p>{t('mg_no_vaccinations')}</p> : (
                  <TableRegion caption={t('mg_vaccinations')} visuallyHiddenCaption>
                    <thead><tr><th scope="col">{t('mg_vaccine')}</th><th scope="col">{t('mg_vaccine_date')}</th><th scope="col">{t('reg_col_action')}</th></tr></thead>
                    <tbody>
                      {d.vaccinations.map((x) => {
                        const what = `${b(x.name)} (${fmtDate(x.given_on)})`;
                        return (
                          <tr key={x.id}>
                            <th scope="row">{b(x.name)}</th><td>{fmtDate(x.given_on)}</td>
                            <td><button type="button" id={`del-vx-${x.id}`} className="btn btn-secondary btn-small" disabled={r.busy} aria-label={t('mg_remove_named', { what })}
                              onClick={() => confirm.ask(t('mg_remove_q', { what }), t('mg_remove'), () => r.run({ method: 'DELETE', path: `/vaccinations/${x.id}`, section: 'vaccinations', success: t('mg_ok_vaccination_removed') }), `del-vx-${x.id}`)}>{t('mg_remove')}</button></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </TableRegion>
                )}
                <ConfirmBox c={confirm} />
                <h3>{t('mg_add_vaccination')}</h3>
                <form onSubmit={addVaccination} noValidate>
                  <SelectField id="vx-vaccine" label={L['vx-vaccine']} value={vx.vaccine} onChange={(v) => setVx({ ...vx, vaccine: v })} options={opts.vaccines.map((x, i) => ({ value: String(i), label: b(x) }))} />
                  <TextField id="vx-date" label={L['vx-date']} value={vx.date} onChange={(v) => setVx({ ...vx, date: v })} type="date" hint={t('mg_date_hint')} />
                  <button type="submit" className="btn btn-primary" disabled={r.busy}>{t('mg_add_vaccination')}</button>
                </form>
              </Section>
            )}

            <Changes changes={d.changes} status={r.status} />
          </>
        )}
      </FieldErrors>
    </ManageFrame>
  );
}
