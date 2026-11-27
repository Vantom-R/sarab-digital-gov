// Manage citizen — Property & Vehicles Authority: register a vehicle, renew, transfer ownership, deregister;
// add / correct / remove property deeds.
import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { useI18n, type Bi } from '../../i18n.tsx';
import { Loading, TableRegion } from '../../a11y.tsx';
import { Changes, ConfirmBox, FieldErrors, isNid, ManageFrame, SelectField, Section, TextField, useConfirm, useOptions, usePersonName, useRecord, type Change } from './common.tsx';

interface Vehicle { plate: string; make: string; model: string; year: number; color: Bi; registration_expiry: string; status: 'valid' | 'expiring_soon' | 'expired'; days_left: number; renewable: boolean }
interface Deed { deed_no: string; type: Bi; city: Bi; district: Bi; area_m2: number; share_percent: number; type_index: number; city_index: number; district_index: number }
interface Prop { vehicles: Vehicle[]; properties: Deed[]; changes: Change[] }
const EMPTY_V = { make: '', model: '', year: '', color: '' };
const EMPTY_D = { type: '', city: '', district: '', area: '', share: '100' };

export function ManageProperty() {
  const { id = '' } = useParams();
  const { t, b, fmtDate } = useI18n();
  const opts = useOptions();
  const name = usePersonName();
  const r = useRecord<Prop>('property', id);
  const confirmV = useConfirm();
  const confirmD = useConfirm();
  const [v, setV] = useState(EMPTY_V);
  const [transfer, setTransfer] = useState<Vehicle | null>(null);
  const [newOwner, setNewOwner] = useState('');
  const [dd, setDd] = useState(EMPTY_D);
  const [editing, setEditing] = useState<Deed | null>(null);
  const d = r.data;
  const thisYear = new Date().getUTCFullYear();

  const L = { 'veh-make': t('mg_make'), 'veh-model': t('mg_model'), 'veh-year': t('mg_model_year'), 'veh-color': t('mg_color'), 'tr-owner': t('mg_new_owner'),
    'deed-type': t('mg_property_type'), 'deed-city': t('reg_city'), 'deed-district': t('reg_district'), 'deed-area': t('mg_area'), 'deed-share': t('mg_share') };
  const vLabel = (x: Vehicle) => `${x.make} ${x.model} ${x.year} (${x.plate})`;
  const dLabel = (x: Deed) => `${b(x.type)} ${x.deed_no}`;
  const statusText = (x: Vehicle) => x.status === 'expired' ? t('mg_veh_expired') : x.status === 'expiring_soon' ? t('mg_veh_expiring', { n: String(x.days_left) }) : t('mg_veh_valid');
  const enc = (p: string) => encodeURIComponent(p);
  const pid = (p: string) => p.replace(/\s+/g, '_'); // HTML ids may not contain spaces

  const register = async (e: FormEvent) => {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (!v.make) fe['veh-make'] = t('errRequired');
    if (!v.model) fe['veh-model'] = t('errRequired');
    if (!v.color) fe['veh-color'] = t('errRequired');
    if (!/^\d{4}$/.test(v.year.trim()) || Number(v.year) < 1950) fe['veh-year'] = t('mg_err_year');
    else if (Number(v.year) > thisYear + 1) fe['veh-year'] = t('mg_err_in_future');
    if (Object.keys(fe).length) return r.invalid(fe, L);
    if (await r.run({ method: 'POST', path: '/vehicles', section: 'vehicles', success: t('mg_ok_vehicle_registered'), labels: L,
      fields: { make_index: 'veh-make', model_index: 'veh-model', year: 'veh-year', color_index: 'veh-color' },
      body: { make_index: Number(v.make), model_index: Number(v.model), year: Number(v.year), color_index: Number(v.color) } })) setV(EMPTY_V);
  };
  const openTransfer = (x: Vehicle) => { setTransfer(x); setNewOwner(''); window.setTimeout(() => document.getElementById('transfer-h')?.focus(), 50); };
  const doTransfer = async (e: FormEvent) => {
    e.preventDefault();
    if (!transfer) return;
    if (!isNid(newOwner)) return r.invalid({ 'tr-owner': t('mg_err_invalid_id') }, L);
    if (newOwner.trim() === id) return r.invalid({ 'tr-owner': t('mg_err_same_person') }, L);
    if (await r.run({ method: 'POST', path: `/vehicles/${enc(transfer.plate)}/transfer`, section: 'vehicles', success: t('mg_ok_transferred', { plate: transfer.plate, id: newOwner.trim() }), labels: L,
      fields: { new_owner_id: 'tr-owner' }, body: { new_owner_id: newOwner.trim() } })) { setTransfer(null); setNewOwner(''); }
  };
  const saveDeed = async (e: FormEvent) => {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (!dd.type) fe['deed-type'] = t('errRequired');
    if (!dd.city) fe['deed-city'] = t('errRequired');
    if (!dd.district) fe['deed-district'] = t('errRequired');
    if (!/^\d{1,6}$/.test(dd.area.trim()) || Number(dd.area) < 10 || Number(dd.area) > 100000) fe['deed-area'] = t('mg_err_area');
    if (!/^\d{1,3}$/.test(dd.share.trim()) || Number(dd.share) < 1 || Number(dd.share) > 100) fe['deed-share'] = t('mg_err_share');
    if (Object.keys(fe).length) return r.invalid(fe, L);
    const body = { type_index: Number(dd.type), city_index: Number(dd.city), district_index: Number(dd.district), area_m2: Number(dd.area), share_percent: Number(dd.share) };
    const ok = await r.run({ method: editing ? 'PUT' : 'POST', path: editing ? `/properties/${editing.deed_no}` : '/properties', body, section: 'deeds', labels: L,
      success: editing ? t('mg_ok_deed_updated') : t('mg_ok_deed_added'),
      fields: { type_index: 'deed-type', city_index: 'deed-city', district_index: 'deed-district', area_m2: 'deed-area', share_percent: 'deed-share' } });
    if (ok) { setEditing(null); setDd(EMPTY_D); }
  };
  const editDeed = (x: Deed) => {
    setEditing(x);
    setDd({ type: x.type_index >= 0 ? String(x.type_index) : '', city: x.city_index >= 0 ? String(x.city_index) : '', district: x.district_index >= 0 ? String(x.district_index) : '', area: String(x.area_m2), share: String(x.share_percent) });
    window.setTimeout(() => document.getElementById('deedform-h')?.focus(), 50);
  };
  const cancelDeed = () => { const back = editing ? `edit-${editing.deed_no}` : null; setEditing(null); setDd(EMPTY_D); if (back) window.setTimeout(() => document.getElementById(back)?.focus(), 50); };

  const models = v.make ? opts?.vehicle_makes[Number(v.make)]?.models ?? [] : [];

  return (
    <ManageFrame id={id} ministry="property" name={name} errors={r.errors}>
      <FieldErrors errors={r.fieldErrors}>
        {!d || !opts ? (r.errors.length ? null : <Loading />) : (
          <>
            <Section id="vehicles" title={t('mg_vehicles')} status={r.status}>
              {d.vehicles.length === 0 ? <p>{t('mg_no_vehicles')}</p> : (
                <TableRegion caption={t('mg_vehicles')} visuallyHiddenCaption>
                  <thead><tr><th scope="col">{t('mg_plate')}</th><th scope="col">{t('mg_vehicle')}</th><th scope="col">{t('mg_color')}</th><th scope="col">{t('mg_valid_until')}</th><th scope="col">{t('reg_col_action')}</th></tr></thead>
                  <tbody>
                    {d.vehicles.map((x) => (
                      <tr key={x.plate}>
                        <th scope="row">{x.plate}</th><td><span lang="en" dir="ltr">{x.make} {x.model}</span> {x.year}</td><td>{b(x.color)}</td>
                        <td>{fmtDate(x.registration_expiry)} — {statusText(x)}</td>
                        <td className="row-actions">
                          {x.renewable
                            ? <button type="button" className="btn btn-secondary btn-small" disabled={r.busy} aria-label={t('mg_renew_named', { what: vLabel(x) })}
                                onClick={() => r.run({ method: 'POST', path: `/vehicles/${enc(x.plate)}/renewal`, section: 'vehicles', success: t('mg_ok_renewed', { plate: x.plate }) })}>{t('mg_renew')}</button>
                            : <span className="hint">{t('mg_renew_later')}</span>}
                          <button type="button" id={`tr-${pid(x.plate)}`} className="btn btn-secondary btn-small" disabled={r.busy} aria-label={t('mg_transfer_named', { what: vLabel(x) })} onClick={() => openTransfer(x)}>{t('mg_transfer')}</button>
                          <button type="button" id={`dereg-${pid(x.plate)}`} className="btn btn-secondary btn-small" disabled={r.busy} aria-label={t('mg_deregister_named', { what: vLabel(x) })}
                            onClick={() => confirmV.ask(t('mg_deregister_q', { what: vLabel(x) }), t('mg_deregister'), () => r.run({ method: 'DELETE', path: `/vehicles/${enc(x.plate)}`, section: 'vehicles', success: t('mg_ok_deregistered', { plate: x.plate }) }), `dereg-${pid(x.plate)}`)}>{t('mg_deregister')}</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </TableRegion>
              )}
              <ConfirmBox c={confirmV} />
              {transfer && (
                <div className="sub-form" role="group" aria-labelledby="transfer-h">
                  <h3 id="transfer-h" tabIndex={-1}>{t('mg_transfer_heading', { what: vLabel(transfer) })}</h3>
                  <p className="hint">{t('mg_transfer_hint')}</p>
                  <form onSubmit={doTransfer} noValidate>
                    <TextField id="tr-owner" label={L['tr-owner']} value={newOwner} onChange={setNewOwner} inputMode="numeric" maxLength={10} />
                    <div className="actions">
                      <button type="submit" className="btn btn-primary" disabled={r.busy}>{t('mg_transfer_confirm')}</button>
                      <button type="button" className="btn btn-secondary" onClick={() => { const p = transfer.plate; setTransfer(null); window.setTimeout(() => document.getElementById(`tr-${pid(p)}`)?.focus(), 50); }}>{t('mg_cancel')}</button>
                    </div>
                  </form>
                </div>
              )}
              <h3>{t('mg_register_vehicle')}</h3>
              <form onSubmit={register} noValidate>
                <SelectField id="veh-make" label={L['veh-make']} value={v.make} onChange={(x) => setV({ ...v, make: x, model: '' })} options={opts.vehicle_makes.map((m, i) => ({ value: String(i), label: m.make }))} />
                <SelectField id="veh-model" label={L['veh-model']} value={v.model} onChange={(x) => setV({ ...v, model: x })} options={models.map((m, i) => ({ value: String(i), label: m }))} hint={t('mg_model_hint')} />
                <TextField id="veh-year" label={L['veh-year']} value={v.year} onChange={(x) => setV({ ...v, year: x })} inputMode="numeric" maxLength={4} hint={t('mg_year_hint')} />
                <SelectField id="veh-color" label={L['veh-color']} value={v.color} onChange={(x) => setV({ ...v, color: x })} options={opts.vehicle_colors.map((c, i) => ({ value: String(i), label: b(c) }))} />
                <button type="submit" className="btn btn-primary" disabled={r.busy}>{t('mg_register_vehicle')}</button>
              </form>
            </Section>

            <Section id="deeds" title={t('mg_deeds')} status={r.status}>
              {d.properties.length === 0 ? <p>{t('mg_no_deeds')}</p> : (
                <TableRegion caption={t('mg_deeds')} visuallyHiddenCaption>
                  <thead><tr><th scope="col">{t('mg_deed_no')}</th><th scope="col">{t('mg_property_type')}</th><th scope="col">{t('mg_location')}</th><th scope="col">{t('mg_area')}</th><th scope="col">{t('mg_share')}</th><th scope="col">{t('reg_col_action')}</th></tr></thead>
                  <tbody>
                    {d.properties.map((x) => (
                      <tr key={x.deed_no}>
                        <th scope="row" dir="ltr">{x.deed_no}</th><td>{b(x.type)}</td><td>{[b(x.city), b(x.district)].join(t('mg_sep'))}</td><td>{t('mg_m2', { n: String(x.area_m2) })}</td><td>{x.share_percent}%</td>
                        <td className="row-actions">
                          <button type="button" id={`edit-${x.deed_no}`} className="btn btn-secondary btn-small" disabled={r.busy} aria-label={t('mg_edit_named', { what: dLabel(x) })} onClick={() => editDeed(x)}>{t('mg_edit')}</button>
                          <button type="button" id={`del-${x.deed_no}`} className="btn btn-secondary btn-small" disabled={r.busy} aria-label={t('mg_remove_named', { what: dLabel(x) })}
                            onClick={() => confirmD.ask(t('mg_remove_q', { what: dLabel(x) }), t('mg_remove'), () => r.run({ method: 'DELETE', path: `/properties/${x.deed_no}`, section: 'deeds', success: t('mg_ok_deed_removed') }), `del-${x.deed_no}`)}>{t('mg_remove')}</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </TableRegion>
              )}
              <ConfirmBox c={confirmD} />
              <h3 id="deedform-h" tabIndex={-1}>{editing ? t('mg_edit_deed', { what: dLabel(editing) }) : t('mg_add_deed')}</h3>
              <form onSubmit={saveDeed} noValidate>
                <SelectField id="deed-type" label={L['deed-type']} value={dd.type} onChange={(x) => setDd({ ...dd, type: x })} options={opts.property_types.map((p, i) => ({ value: String(i), label: b(p) }))} />
                <SelectField id="deed-city" label={L['deed-city']} value={dd.city} onChange={(x) => setDd({ ...dd, city: x })} options={opts.cities.map((c) => ({ value: String(c.index), label: b(c.name) }))} />
                <SelectField id="deed-district" label={L['deed-district']} value={dd.district} onChange={(x) => setDd({ ...dd, district: x })} options={opts.districts.map((c) => ({ value: String(c.index), label: b(c.name) }))} />
                <TextField id="deed-area" label={L['deed-area']} value={dd.area} onChange={(x) => setDd({ ...dd, area: x })} inputMode="numeric" maxLength={6} hint={t('mg_area_hint')} />
                <TextField id="deed-share" label={L['deed-share']} value={dd.share} onChange={(x) => setDd({ ...dd, share: x })} inputMode="numeric" maxLength={3} hint={t('mg_share_hint')} />
                <div className="actions">
                  <button type="submit" className="btn btn-primary" disabled={r.busy}>{editing ? t('mg_save_changes') : t('mg_add_deed')}</button>
                  {editing && <button type="button" className="btn btn-secondary" onClick={cancelDeed}>{t('mg_cancel')}</button>}
                </div>
              </form>
            </Section>

            <Changes changes={d.changes} status={r.status} />
          </>
        )}
      </FieldErrors>
    </ManageFrame>
  );
}
