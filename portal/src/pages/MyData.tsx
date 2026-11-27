// Citizen views of each ministry's data. Each section loads ON DEMAND, so a ministry is only
// queried (and an entry only appears in "Who accessed my data") when the citizen asks to see it.
import { useId, useRef, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import { hasKey, useI18n, type Bi, type Key } from '../i18n.tsx';
import { Loading, TableRegion, useAnnounce } from '../a11y.tsx';
import { useErrorText } from '../session.tsx';

/** A section with a "Show" toggle button (aria-expanded) that fetches its data the first time. */
function OnDemandSection<T>({ id, title, source, path, note, children }: {
  id: string; title: Key; source: Key; path: string; note?: Key; children: (data: T) => ReactNode;
}) {
  const { t } = useI18n();
  const announce = useAnnounce();
  const errorText = useErrorText();
  const regionId = useId();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(false);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !loaded.current) {
      loaded.current = true;
      try {
        setData(await api<T>(path));
        announce(t('sectionLoaded', { section: t(title) }));
      } catch (e) {
        loaded.current = false;
        setError(errorText(e));
      }
    }
  };

  return (
    <section aria-labelledby={id} className="panel">
      <h2 id={id}>{t(title)}</h2>
      {note && <p className="note">{t(note)}</p>}
      <button type="button" className="btn btn-secondary" aria-expanded={open} aria-controls={regionId} onClick={toggle}>
        {open ? t('hideSection', { section: t(title) }) : t('showSection', { section: t(title) })}
      </button>
      <div id={regionId} hidden={!open} className="section-body">
        {error && <p className="check-bad" role="alert">{error}</p>}
        {open && !data && !error && <Loading />}
        {data && (
          <>
            {children(data)}
            <p className="note">{t('sourceVia', { source: t(source) })}</p>
          </>
        )}
      </div>
    </section>
  );
}

// ---------------- Education ----------------
interface Education {
  degrees: { id: string; level_name: Bi; field: Bi; institution: Bi; graduation_year: number; grade: Bi }[];
  enrollment: { institution: Bi; stage: Bi; since_year: number } | null;
}
export function EducationSection() {
  const { t, b } = useI18n();
  return (
    <OnDemandSection<Education> id="edu-h" title="eduTitle" source="srcEducation" path="/api/identity/me/education">
      {(d) => (
        <>
          {d.enrollment && <p><strong>{t('eduEnrolled')}</strong> {b(d.enrollment.stage)} — {b(d.enrollment.institution)} ({d.enrollment.since_year})</p>}
          {d.degrees.length === 0 ? <p>{t('eduNone')}</p> : (
            <TableRegion caption={t('eduTitle')} visuallyHiddenCaption>
              <thead><tr><th scope="col">{t('colLevel')}</th><th scope="col">{t('colField')}</th><th scope="col">{t('colInstitution')}</th><th scope="col">{t('colYear')}</th><th scope="col">{t('colGrade')}</th></tr></thead>
              <tbody>
                {d.degrees.map((g) => (
                  <tr key={g.id}><th scope="row">{b(g.level_name)}</th><td>{b(g.field)}</td><td>{b(g.institution)}</td><td>{g.graduation_year}</td><td>{b(g.grade)}</td></tr>
                ))}
              </tbody>
            </TableRegion>
          )}
        </>
      )}
    </OnDemandSection>
  );
}

// ---------------- Health ----------------
interface Health {
  blood_type: string; allergies: Bi[]; chronic_conditions: Bi[]; primary_clinic: Bi; organ_donor: boolean;
  vaccinations: { name: Bi; given_on: string }[];
}
export function HealthSection() {
  const { t, b, fmtDate } = useI18n();
  const list = (items: Bi[]) => (items.length ? items.map(b).join('، ') : t('none'));
  return (
    <OnDemandSection<Health> id="health-h" title="healthTitle" source="srcHealth" path="/api/identity/me/health" note="healthPrivacy">
      {(h) => (
        <>
          <dl className="facts">
            <div><dt>{t('bloodType')}</dt><dd dir="ltr">{h.blood_type}</dd></div>
            <div><dt>{t('allergies')}</dt><dd>{list(h.allergies)}</dd></div>
            <div><dt>{t('conditions')}</dt><dd>{list(h.chronic_conditions)}</dd></div>
            <div><dt>{t('clinic')}</dt><dd>{b(h.primary_clinic)}</dd></div>
            <div><dt>{t('organDonor')}</dt><dd>{h.organ_donor ? t('yes') : t('no')}</dd></div>
          </dl>
          <h3>{t('vaccinations')}</h3>
          <ul className="plain-list">{h.vaccinations.map((v) => <li key={`${v.given_on}-${v.name.en}`}>{b(v.name)} — {fmtDate(v.given_on)}</li>)}</ul>
        </>
      )}
    </OnDemandSection>
  );
}

// ---------------- Labor & social insurance ----------------
interface Employment {
  status: string; status_name: Bi; employer: { name: Bi; sector: string } | null; job_title: Bi | null; since: string | null;
  monthly_income: number; income_bracket: Bi; income_source: Bi;
  social_insurance: { number: string; contribution_months: number; pension: number | null } | null;
  benefits?: { id: string; kind: string; monthly_amount: number; starts_on: string; reason: Bi }[];
}
export function EmploymentSection() {
  const { t, b, fmtDate, lang } = useI18n();
  const money = (n: number) => `${new Intl.NumberFormat(lang === 'ar' ? 'ar-u-nu-latn' : 'en').format(n)} ${t('currency')}`;
  return (
    <OnDemandSection<Employment> id="work-h" title="workTitle" source="srcLabor" path="/api/identity/me/employment">
      {(e) => (
        <dl className="facts">
          <div><dt>{t('empStatus')}</dt><dd>{b(e.status_name)}</dd></div>
          {e.employer && <div><dt>{t('employer')}</dt><dd>{b(e.employer.name)} ({e.employer.sector === 'government' ? t('sectorGov') : t('sectorPrivate')})</dd></div>}
          {e.job_title && <div><dt>{t('jobTitle')}</dt><dd>{b(e.job_title)}</dd></div>}
          {e.since && <div><dt>{t('since')}</dt><dd>{fmtDate(e.since)}</dd></div>}
          <div><dt>{t('monthlyIncome')}</dt><dd>{money(e.monthly_income)}</dd></div>
          <div><dt>{t('incomeBracket')}</dt><dd>{b(e.income_bracket)}</dd></div>
          <div><dt>{t('incomeSource')}</dt><dd>{b(e.income_source)}</dd></div>
          {e.social_insurance && (
            <>
              <div><dt>{t('siNumber')}</dt><dd dir="ltr">{e.social_insurance.number}</dd></div>
              <div><dt>{t('contribMonths')}</dt><dd>{e.social_insurance.contribution_months}</dd></div>
              {e.social_insurance.pension !== null && <div><dt>{t('pension')}</dt><dd>{money(e.social_insurance.pension)}</dd></div>}
            </>
          )}
          {e.benefits?.length ? (
            <div><dt>{t('benefitsHeading')}</dt><dd><ul className="compact-list">
              {e.benefits.map((x) => <li key={x.id}>{b(x.reason)} — {t('benefitMonthly', { amount: money(x.monthly_amount), date: fmtDate(x.starts_on) })}</li>)}
            </ul></dd></div>
          ) : null}
        </dl>
      )}
    </OnDemandSection>
  );
}

// ---------------- Property & vehicles ----------------
export interface Vehicle { plate: string; make: string; model: string; year: number; color: Bi; registration_expiry: string; status: 'valid' | 'expiring_soon' | 'expired'; days_left: number }
export interface Assets {
  vehicles: Vehicle[];
  properties: { deed_no: string; type: Bi; city: Bi; district: Bi; area_m2: number; share_percent: number }[];
}

/** Vehicles with an optional "Renew" action per row (renewal opens 60 days before expiry). */
export function VehiclesTable({ vehicles, onRenew }: { vehicles: Vehicle[]; onRenew?: (v: Vehicle) => Promise<unknown> }) {
  const { t, b, fmtDate } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  const badge = (s: string) => (s === 'valid' ? 'badge-ok' : s === 'expiring_soon' ? 'badge-info' : 'badge-bad');
  if (vehicles.length === 0) return <p>{t('noVehicles')}</p>;
  return (
    <TableRegion caption={t('vehicles')} visuallyHiddenCaption>
      <thead><tr><th scope="col">{t('plate')}</th><th scope="col">{t('vehicle')}</th><th scope="col">{t('regExpiry')}</th><th scope="col">{t('colStatus')}</th>{onRenew && <th scope="col">{t('colAction2')}</th>}</tr></thead>
      <tbody>
        {vehicles.map((v) => (
          <tr key={v.plate}>
            <th scope="row"><span dir="rtl" lang="ar">{v.plate}</span></th>
            <td><span lang="en" dir="ltr">{v.make} {v.model}</span> {v.year} — {b(v.color)}</td>
            <td>{fmtDate(v.registration_expiry)}</td>
            <td><span className={`badge ${badge(v.status)}`}>{hasKey(`vstatus_${v.status}`) ? t(`vstatus_${v.status}` as Key, { n: v.days_left }) : v.status}</span></td>
            {onRenew && (
              <td>
                {v.days_left <= 60 ? (
                  <button type="button" className="btn btn-primary btn-small" disabled={busy === v.plate} aria-label={t('renewFor', { vehicle: `${v.make} ${v.model} ${v.plate}` })}
                    onClick={async () => { setBusy(v.plate); try { await onRenew(v); } finally { setBusy(null); } }}>
                    {busy === v.plate ? t('working') : t('renew')}
                  </button>
                ) : <span className="muted">{t('renewNotYet')}</span>}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </TableRegion>
  );
}

export function AssetsSection() {
  const { t, b, fmtDate } = useI18n();
  const announce = useAnnounce();
  const errorText = useErrorText();
  const [override, setOverride] = useState<Vehicle[] | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <OnDemandSection<Assets> id="assets-h" title="assetsTitle" source="srcProperty" path="/api/identity/me/assets">
      {(a) => (
        <>
          <h3>{t('vehicles')}</h3>
          {msg && <p className={msg.ok ? 'check-ok' : 'check-bad'}>{msg.text}</p>}
          <VehiclesTable vehicles={override ?? a.vehicles} onRenew={async (v) => {
            try {
              const r = await api<Vehicle & { new_expiry: string; fee: number }>(`/api/identity/me/vehicles/${encodeURIComponent(v.plate)}/renew`, { method: 'POST', body: {} });
              const text = t('renewDone', { vehicle: `${v.make} ${v.model}`, date: fmtDate(r.new_expiry), fee: `${r.fee} ${t('currency')}` });
              setOverride((override ?? a.vehicles).map((x) => (x.plate === v.plate ? { ...x, registration_expiry: r.new_expiry, status: r.status, days_left: r.days_left } : x)));
              setMsg({ ok: true, text });
              announce(text);
            } catch (e) {
              const text = errorText(e);
              setMsg({ ok: false, text });
              announce(text, 'assertive');
            }
          }} />
          <h3>{t('properties')}</h3>
          {a.properties.length === 0 ? <p>{t('noProperties')}</p> : (
            <ul className="plain-list">
              {a.properties.map((d) => (
                <li key={d.deed_no}>{b(d.type)} — {b(d.district)}، {b(d.city)} — {t('areaShare', { area: d.area_m2, share: d.share_percent })} <span className="muted" dir="ltr">({d.deed_no})</span></li>
              ))}
            </ul>
          )}
        </>
      )}
    </OnDemandSection>
  );
}
