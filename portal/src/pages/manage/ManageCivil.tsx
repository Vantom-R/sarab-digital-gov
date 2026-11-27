// Manage citizen — Civil Registry: address, marital status (marriage / divorce / correction), parents, children.
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { hasKey, useI18n, type Bi, type Key } from '../../i18n.tsx';
import { Loading, TableRegion } from '../../a11y.tsx';
import { Changes, ConfirmBox, FieldErrors, isIsoDate, isNid, ManageFrame, SelectField, Section, TextField, today, useConfirm, useOptions, usePersonName, useRecord, type Change } from './common.tsx';

interface Member { national_id: string; relation: string; name: Bi; gender: string; birth_date: string }
interface Civil {
  national_id: string; given_name: Bi; family_name: Bi; gender: string; birth_date: string; marital_status: string; status: string;
  address: { city: Bi; district: Bi; street: string; city_index: number; district_index: number }; phone: string | null; married_on: string | null;
  family: Member[]; changes: Change[];
}

export function ManageCivil() {
  const { id = '' } = useParams();
  const { t, b, fmtDate } = useI18n();
  const opts = useOptions();
  const r = useRecord<Civil>('civil', id);
  const confirm = useConfirm();
  const d = r.data;
  const name = usePersonName() ?? (d ? { ar: `${d.given_name.ar} ${d.family_name.ar}`, en: `${d.given_name.en} ${d.family_name.en}` } : null);

  // Address
  const [addr, setAddr] = useState({ city: '', district: '', street: '', phone: '' });
  // Marriage / divorce / correction
  const [spouse, setSpouse] = useState(''); const [marriedOn, setMarriedOn] = useState('');
  const [divorcedOn, setDivorcedOn] = useState('');
  const [marital, setMarital] = useState('');
  // Parents / children
  const [parents, setParents] = useState({ father: '', mother: '' });
  const [child, setChild] = useState('');
  useEffect(() => {
    if (!d) return;
    setAddr({ city: String(d.address.city_index), district: String(d.address.district_index), street: d.address.street, phone: d.phone ?? '' });
    setParents({ father: d.family.find((f) => f.relation === 'father')?.national_id ?? '', mother: d.family.find((f) => f.relation === 'mother')?.national_id ?? '' });
  }, [d]);

  const L = {
    'addr-city': t('reg_city'), 'addr-district': t('reg_district'), 'addr-street': t('reg_street'), 'addr-phone': t('reg_phone'),
    'mar-spouse': t('mg_spouse_id'), 'mar-date': t('mg_married_on'), 'div-date': t('mg_divorced_on'), 'mst-status': t('mg_marital_status'),
    'par-father': t('reg_father_id'), 'par-mother': t('reg_mother_id'), 'child-id': t('mg_child_id'),
  };
  const need = (fe: Record<string, string>, k: string, v: string) => { if (!v.trim()) fe[k] = t('errRequired'); };

  const saveAddress = (e: FormEvent) => {
    e.preventDefault();
    const fe: Record<string, string> = {};
    need(fe, 'addr-city', addr.city); need(fe, 'addr-district', addr.district); need(fe, 'addr-street', addr.street);
    if (addr.phone.trim() && !/^\+?[0-9 ]{7,20}$/.test(addr.phone.trim())) fe['addr-phone'] = t('reg_err_phone');
    if (Object.keys(fe).length) return r.invalid(fe, L);
    r.run({ method: 'PUT', path: '/address', section: 'address', success: t('mg_ok_address'), labels: L,
      fields: { city_index: 'addr-city', district_index: 'addr-district', street: 'addr-street', phone: 'addr-phone' },
      body: { city_index: Number(addr.city), district_index: Number(addr.district), street: addr.street.trim(), ...(addr.phone.trim() ? { phone: addr.phone.trim() } : {}) } });
  };

  const marry = async (e: FormEvent) => {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (!isNid(spouse)) fe['mar-spouse'] = t('mg_err_invalid_id'); else if (spouse.trim() === id) fe['mar-spouse'] = t('mg_err_same_person');
    if (!isIsoDate(marriedOn)) fe['mar-date'] = t('mg_err_invalid_date'); else if (marriedOn > today()) fe['mar-date'] = t('mg_err_in_future');
    if (Object.keys(fe).length) return r.invalid(fe, L);
    if (await r.run({ method: 'POST', path: '/marriage', section: 'marital', success: t('mg_ok_married'), labels: L, fields: { spouse_id: 'mar-spouse', married_on: 'mar-date' }, body: { spouse_id: spouse.trim(), married_on: marriedOn } })) {
      setSpouse(''); setMarriedOn('');
    }
  };
  const divorce = async (e: FormEvent) => {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (!isIsoDate(divorcedOn)) fe['div-date'] = t('mg_err_invalid_date'); else if (divorcedOn > today()) fe['div-date'] = t('mg_err_in_future');
    if (Object.keys(fe).length) return r.invalid(fe, L);
    if (await r.run({ method: 'POST', path: '/divorce', section: 'marital', success: t('mg_ok_divorced'), labels: L, fields: { divorced_on: 'div-date' }, body: { divorced_on: divorcedOn } })) setDivorcedOn('');
  };
  const correct = (e: FormEvent) => {
    e.preventDefault();
    if (!marital) return r.invalid({ 'mst-status': t('errRequired') }, L);
    r.run({ method: 'PUT', path: '/marital-status', section: 'marital', success: t('mg_ok_marital'), labels: L, fields: { marital_status: 'mst-status' }, body: { marital_status: marital } });
  };
  const saveParents = (e: FormEvent) => {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (parents.father.trim() && !isNid(parents.father)) fe['par-father'] = t('mg_err_invalid_id');
    if (parents.mother.trim() && !isNid(parents.mother)) fe['par-mother'] = t('mg_err_invalid_id');
    if (parents.father.trim() && parents.father.trim() === parents.mother.trim()) fe['par-mother'] = t('mg_err_same_parent');
    if (Object.keys(fe).length) return r.invalid(fe, L);
    r.run({ method: 'PUT', path: '/parents', section: 'parents', success: t('mg_ok_parents'), labels: L, fields: { father_id: 'par-father', mother_id: 'par-mother' },
      body: { father_id: parents.father.trim() || null, mother_id: parents.mother.trim() || null } });
  };
  const linkChild = async (e: FormEvent) => {
    e.preventDefault();
    if (!isNid(child)) return r.invalid({ 'child-id': t('mg_err_invalid_id') }, L);
    if (await r.run({ method: 'POST', path: '/children', section: 'children', success: t('mg_ok_child_linked'), labels: L, fields: { child_id: 'child-id' }, body: { child_id: child.trim() } })) setChild('');
  };

  const spouseM = d?.family.find((f) => f.relation === 'spouse');
  const children = d?.family.filter((f) => f.relation === 'child') ?? [];
  const relName = (rel: string) => d?.family.find((f) => f.relation === rel);

  return (
    <ManageFrame id={id} ministry="civil" name={name} errors={r.errors}>
      <FieldErrors errors={r.fieldErrors}>
        {!d || !opts ? (r.errors.length ? null : <Loading />) : (
          <>
            <Section id="person" title={t('mg_personal')} status={r.status}>
              <dl className="facts">
                <div><dt>{t('mg_col_name')}</dt><dd>{b(name)}</dd></div>
                <div><dt>{t('fieldBirthDate')}</dt><dd>{fmtDate(d.birth_date)}</dd></div>
                <div><dt>{t('mg_gender')}</dt><dd>{t(d.gender === 'F' ? 'reg_gender_F' : 'reg_gender_M')}</dd></div>
                <div><dt>{t('mg_marital_status')}</dt><dd>{hasKey(`mg_marital_${d.marital_status}`) ? t(`mg_marital_${d.marital_status}` as Key) : d.marital_status}</dd></div>
              </dl>
              <p className="hint">{t('mg_personal_hint')}</p>
            </Section>

            <Section id="address" title={t('reg_address')} status={r.status}>
              <p>{t('mg_current')}: {[b(d.address.city), b(d.address.district), d.address.street].join(t('mg_sep'))}</p>
              <form onSubmit={saveAddress} noValidate>
                <SelectField id="addr-city" label={L['addr-city']} value={addr.city} onChange={(v) => setAddr({ ...addr, city: v })} options={opts.cities.map((c) => ({ value: String(c.index), label: b(c.name) }))} hint={t('mg_city_hint')} />
                <SelectField id="addr-district" label={L['addr-district']} value={addr.district} onChange={(v) => setAddr({ ...addr, district: v })} options={opts.districts.map((c) => ({ value: String(c.index), label: b(c.name) }))} />
                <TextField id="addr-street" label={L['addr-street']} value={addr.street} onChange={(v) => setAddr({ ...addr, street: v })} />
                <TextField id="addr-phone" label={L['addr-phone']} value={addr.phone} onChange={(v) => setAddr({ ...addr, phone: v })} type="tel" inputMode="tel" maxLength={20} required={false} hint={t('reg_phone_hint')} />
                <button type="submit" className="btn btn-primary" disabled={r.busy}>{t('mg_save_address')}</button>
              </form>
            </Section>

            <Section id="marital" title={t('mg_marital_heading')} status={r.status}>
              {spouseM ? (
                <>
                  <p>{t('mg_married_to', { name: b(spouseM.name), id: spouseM.national_id })}{d.married_on ? ` ${t('mg_since', { date: fmtDate(d.married_on) })}` : ''}</p>
                  <h3>{t('mg_divorce_heading')}</h3>
                  <form onSubmit={divorce} noValidate>
                    <TextField id="div-date" label={L['div-date']} value={divorcedOn} onChange={setDivorcedOn} type="date" hint={t('mg_date_hint')} />
                    <button type="submit" className="btn btn-primary" disabled={r.busy}>{t('mg_register_divorce')}</button>
                  </form>
                </>
              ) : (
                <>
                  <h3>{t('mg_marriage_heading')}</h3>
                  <form onSubmit={marry} noValidate>
                    <TextField id="mar-spouse" label={L['mar-spouse']} value={spouse} onChange={setSpouse} inputMode="numeric" maxLength={10} hint={t('mg_spouse_hint')} />
                    <TextField id="mar-date" label={L['mar-date']} value={marriedOn} onChange={setMarriedOn} type="date" hint={t('mg_date_hint')} />
                    <button type="submit" className="btn btn-primary" disabled={r.busy}>{t('mg_register_marriage')}</button>
                  </form>
                  <h3>{t('mg_correct_marital')}</h3>
                  <form onSubmit={correct} noValidate>
                    <SelectField id="mst-status" label={L['mst-status']} value={marital} onChange={setMarital} hint={t('mg_correct_marital_hint')}
                      options={['single', 'divorced', 'widowed'].map((v) => ({ value: v, label: t(`mg_marital_${v}` as Key) }))} />
                    <button type="submit" className="btn btn-secondary" disabled={r.busy}>{t('mg_save_marital')}</button>
                  </form>
                </>
              )}
            </Section>

            <Section id="parents" title={t('mg_parents')} status={r.status}>
              <ul className="plain-list">
                {(['father', 'mother'] as const).map((rel) => {
                  const m = relName(rel);
                  return <li key={rel}>{t(`rel_${rel}` as Key)}: {m ? <>{b(m.name)} <span dir="ltr">({m.national_id})</span></> : t('mg_not_recorded')}</li>;
                })}
              </ul>
              <form onSubmit={saveParents} noValidate>
                <TextField id="par-father" label={L['par-father']} value={parents.father} onChange={(v) => setParents({ ...parents, father: v })} inputMode="numeric" maxLength={10} required={false} hint={t('mg_parent_hint')} />
                <TextField id="par-mother" label={L['par-mother']} value={parents.mother} onChange={(v) => setParents({ ...parents, mother: v })} inputMode="numeric" maxLength={10} required={false} hint={t('mg_parent_hint')} />
                <button type="submit" className="btn btn-primary" disabled={r.busy}>{t('mg_save_parents')}</button>
              </form>
            </Section>

            <Section id="children" title={t('mg_children')} status={r.status}>
              {children.length === 0 ? <p>{t('mg_no_children')}</p> : (
                <TableRegion caption={t('mg_children')} visuallyHiddenCaption>
                  <thead><tr><th scope="col">{t('mg_col_name')}</th><th scope="col">{t('fieldNationalId')}</th><th scope="col">{t('fieldBirthDate')}</th><th scope="col">{t('reg_col_action')}</th></tr></thead>
                  <tbody>
                    {children.map((c) => (
                      <tr key={c.national_id}>
                        <th scope="row"><Link to={`/manage/${c.national_id}`} state={{ name: c.name }}>{b(c.name)}</Link></th>
                        <td dir="ltr">{c.national_id}</td>
                        <td>{fmtDate(c.birth_date)}</td>
                        <td>
                          <button type="button" id={`unlink-${c.national_id}`} className="btn btn-secondary btn-small" disabled={r.busy}
                            aria-label={t('mg_unlink_child_named', { name: b(c.name) })}
                            onClick={() => confirm.ask(t('mg_unlink_child_q', { name: b(c.name) }), t('mg_unlink_child'),
                              () => r.run({ method: 'DELETE', path: `/children/${c.national_id}`, section: 'children', success: t('mg_ok_child_unlinked') }), `unlink-${c.national_id}`)}>
                            {t('mg_unlink_child')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </TableRegion>
              )}
              <ConfirmBox c={confirm} />
              <h3>{t('mg_link_child_heading')}</h3>
              <form onSubmit={linkChild} noValidate>
                <TextField id="child-id" label={L['child-id']} value={child} onChange={setChild} inputMode="numeric" maxLength={10} hint={t('mg_child_hint')} />
                <button type="submit" className="btn btn-primary" disabled={r.busy}>{t('mg_link_child')}</button>
              </form>
            </Section>

            <Changes changes={d.changes} status={r.status} />
          </>
        )}
      </FieldErrors>
    </ManageFrame>
  );
}
