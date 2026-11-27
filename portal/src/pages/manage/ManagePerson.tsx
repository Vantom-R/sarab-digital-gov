// Manage citizen — step 2: one person across the ministries. Each summary below is read from that
// ministry through Jisr in the employee's name, so each read shows in the citizen's "who accessed my data".
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../../api.ts';
import { hasKey, useI18n, type Bi, type Key } from '../../i18n.tsx';
import { ErrorSummary, type ErrorItem, Loading, PageTitle } from '../../a11y.tsx';
import { useErrorText } from '../../session.tsx';
import type { Ministry } from './common.tsx';

interface Overview {
  national_id: string;
  person: { given_name: Bi; family_name: Bi; birth_date: string; gender: string; status: string } | null;
  ministries: { key: Ministry; name: Bi; ok: boolean; error?: string; summary?: any; last_change?: { action: string; actor: string; at: string } | null }[];
}

export function ManagePerson() {
  const { id = '' } = useParams();
  const { t, b, fmtDate } = useI18n();
  const errorText = useErrorText();
  const [o, setO] = useState<Overview | null>(null);
  const [errors, setErrors] = useState<ErrorItem[]>([]);
  useEffect(() => { setO(null); api<Overview>(`/api/identity/manage/persons/${id}/overview`).then(setO).catch((e) => setErrors([errorText(e)])); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const name: Bi | null = o?.person ? { ar: `${o.person.given_name.ar} ${o.person.family_name.ar}`, en: `${o.person.given_name.en} ${o.person.family_name.en}` } : null;
  const summary = (m: Overview['ministries'][number]): string => {
    const s = m.summary ?? {};
    switch (m.key) {
      case 'civil': return t('mg_sum_civil', { status: hasKey(`mg_marital_${s.marital_status}`) ? t(`mg_marital_${s.marital_status}` as Key) : s.marital_status, n: String(s.family), city: b(s.city) });
      case 'education': return t('mg_sum_education', { n: String(s.degrees) }) + (s.studying ? ` ${t('mg_sum_studying')}` : '');
      case 'labor': return s.status_name ? `${b(s.status_name)}${s.employer ? ` — ${b(s.employer)}` : ''}. ${t('mg_sum_jobs', { n: String(s.jobs) })}` : t('mg_sum_labor_none');
      case 'property': return t('mg_sum_property', { v: String(s.vehicles), p: String(s.properties) });
      case 'health': return s.exists ? t('mg_sum_health_yes') : t('mg_sum_health_no');
    }
  };

  return (
    <>
      <nav aria-label={t('mg_breadcrumb')} className="breadcrumb">
        <ol>
          <li><Link to="/manage">{t('mg_title')}</Link></li>
          <li><span aria-hidden="true" className="sep">/</span><span aria-current="page">{name ? b(name) : id}</span></li>
        </ol>
      </nav>
      <PageTitle text={name ? t('mg_person_title', { who: b(name) }) : t('mg_title')} />
      <ErrorSummary title={t('errorTitle')} messages={errors} />
      {!o ? (errors.length ? null : <Loading />) : (
        <>
          <dl className="facts">
            <div><dt>{t('fieldNationalId')}</dt><dd dir="ltr">{o.national_id}</dd></div>
            {o.person && <div><dt>{t('fieldBirthDate')}</dt><dd>{fmtDate(o.person.birth_date)}</dd></div>}
          </dl>
          <p className="note" role="note">{t('mg_overview_audit')}</p>
          <h2>{t('mg_ministries')}</h2>
          <ul className="card-list">
            {o.ministries.map((m) => (
              <li key={m.key} className="card">
                <h3 id={`mg-card-${m.key}`}>{b(m.name)}</h3>
                {m.ok ? <p>{summary(m)}</p> : <p className="field-error">{t('mg_card_error')}</p>}
                {m.last_change && <p className="hint">{t('mg_last_change', { when: fmtDate(m.last_change.at, true), by: m.last_change.actor.replace(/^employee:/, '') })}</p>}
                <p><Link to={`/manage/${id}/${m.key}`} state={{ name }} className="btn btn-secondary">{t(`mg_open_${m.key}` as Key)}</Link></p>
              </li>
            ))}
          </ul>
          <p><Link to="/manage">{t('mg_search_again')}</Link></p>
        </>
      )}
    </>
  );
}
