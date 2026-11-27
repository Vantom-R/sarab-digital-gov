// A delegate acting for the person who authorised them (e.g. Omar renewing his father's car registration).
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { ErrorSummary, type ErrorItem, Loading, PageTitle, useAnnounce } from '../a11y.tsx';
import { useErrorText } from '../session.tsx';
import { VehiclesTable, type Assets, type Vehicle } from './MyData.tsx';
import type { Delegation } from './Delegations.tsx';

export function Acting() {
  const { id = '' } = useParams();
  const { t, b, fmtDate } = useI18n();
  const announce = useAnnounce();
  const errorText = useErrorText();
  const [data, setData] = useState<{ delegation: Delegation; assets: Assets } | null>(null);
  const [errors, setErrors] = useState<ErrorItem[]>([]);
  const [result, setResult] = useState<string | null>(null);

  const load = useCallback(() => api<{ delegation: Delegation; assets: Assets }>(`/api/identity/acting/${encodeURIComponent(id)}/assets`).then(setData), [id]);
  useEffect(() => { load().catch((e) => setErrors([errorText(e)])); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const renew = async (v: Vehicle) => {
    setErrors([]);
    try {
      const r = await api<{ new_expiry: string; fee: number }>(`/api/identity/acting/${encodeURIComponent(id)}/vehicles/${encodeURIComponent(v.plate)}/renew`, { method: 'POST', body: {} });
      const msg = t('renewDone', { vehicle: `${v.make} ${v.model}`, date: fmtDate(r.new_expiry), fee: `${r.fee} ${t('currency')}` });
      setResult(msg);
      announce(msg);
      await load();
    } catch (e) {
      setErrors([errorText(e)]);
    }
  };

  const name = data ? b(data.delegation.grantor_name) : '…';
  return (
    <>
      <PageTitle text={t('actingTitle', { name })} />
      <ErrorSummary title={t('errorTitle')} messages={errors} />
      <p><Link to="/citizen/delegations">{t('actingBack')}</Link></p>
      {!data ? (errors.length ? null : <Loading />) : (
        <>
          <p className="acting-banner" role="note">{t('actingBanner', { name, id: data.delegation.id })}</p>
          {result && <p className="check-ok">{result}</p>}
          <section aria-labelledby="act-veh-h" className="panel">
            <h2 id="act-veh-h">{t('vehicles')}</h2>
            <VehiclesTable vehicles={data.assets.vehicles} onRenew={data.delegation.scopes.some((s) => s.scope === 'vehicles.renew') ? renew : undefined} />
          </section>
        </>
      )}
    </>
  );
}
