// Service-centre counter (employee role): serve a citizen who is present, after they confirm with a code.
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api.ts';
import { useI18n, type Bi, type Key, hasKey } from '../i18n.tsx';
import { ErrorSummary, type ErrorItem, Loading, PageTitle, TableRegion, useAnnounce } from '../a11y.tsx';
import { useErrorText } from '../session.tsx';
import { VehiclesTable, type Assets, type Vehicle } from './MyData.tsx';
import { Filters, Pager, useListing } from '../listing.tsx';
import { useActionFilters } from './Admin.tsx';

/** A problem with one field: shown in the error summary as a link to it. */
class FieldError extends Error { constructor(readonly field: string, message: string) { super(message); } }

interface Me { employee: { employee_id: string; centre: Bi; name: Bi }; open_sessions: { id: string; citizen: string; status: string; expires_at: string }[] }
interface Rec { national_id: string; given_name: Bi; family_name: Bi; birth_date: string; address: { city: Bi }; family: { national_id: string; relation: string; name: Bi }[] }
interface Action { id: number; citizen: string; action: string; detail: any; at: string }
interface Scope { scope: string; label: Bi }

export function Counter() {
  const { t, b, fmtDate } = useI18n();
  const announce = useAnnounce();
  const errorText = useErrorText();
  const [me, setMe] = useState<Me | null>(null);
  const [errors, setErrors] = useState<ErrorItem[]>([]);
  const [nid, setNid] = useState('');
  const [pending, setPending] = useState<{ id: string } | null>(null);
  const [code, setCode] = useState('');
  const [active, setActive] = useState<{ id: string; expires_at: string; record: Rec } | null>(null);
  const [assets, setAssets] = useState<Assets | null>(null);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [delegate, setDelegate] = useState('');
  const [chosen, setChosen] = useState<string[]>(['vehicles.renew']);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const list = useListing<Action>('/api/identity/counter/actions', 'actions');
  const actionFields = useActionFilters(false);
  const loadActions = () => { list.reload().catch(() => {}); };
  useEffect(() => {
    api<Me>('/api/identity/counter/me').then(setMe).catch((e) => setErrors([errorText(e)]));
    api<{ scopes: Scope[] }>('/api/identity/delegation-scopes').then((r) => setScopes(r.scopes)).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErrors([]);
    try { await fn(); } catch (e) { setErrors([e instanceof FieldError ? { field: e.field, text: e.message } : e instanceof Error && !(e instanceof ApiError) ? e.message : errorText(e)]); } finally { setBusy(false); loadActions(); }
  };

  const start = (e: FormEvent) => { e.preventDefault(); void run(async () => {
    if (!/^\d{10}$/.test(nid.trim())) throw new FieldError('cs-nid', `${t('counterCitizenId')}: ${t('delegNeedId')}`);
    const r = await api<{ id: string }>('/api/identity/counter/sessions', { body: { national_id: nid.trim() } });
    setPending({ id: r.id });
    announce(t('counterCodeSent'));
    window.setTimeout(() => document.getElementById('cs-code')?.focus(), 50);
  }); };

  const confirm = (e: FormEvent) => { e.preventDefault(); void run(async () => {
    await api(`/api/identity/counter/sessions/${pending!.id}/confirm`, { body: { code: code.trim() } });
    const r = await api<{ session: { id: string; expires_at: string }; record: Rec }>(`/api/identity/counter/sessions/${pending!.id}/record`);
    setActive({ id: r.session.id, expires_at: r.session.expires_at, record: r.record });
    setPending(null); setCode(''); setAssets(null); setMsg(null);
    announce(t('counterServing', { name: `${b(r.record.given_name)} ${b(r.record.family_name)}` }));
    window.setTimeout(() => document.getElementById('serving-h')?.focus(), 50);
  }); };

  const end = () => void run(async () => {
    await api(`/api/identity/counter/sessions/${active!.id}/end`, { body: {} });
    setActive(null); setAssets(null); setNid('');
    announce(t('counterEnded'));
    window.setTimeout(() => document.getElementById('start-h')?.focus(), 50);
  });

  const renew = async (v: Vehicle) => {
    try {
      const r = await api<{ new_expiry: string; fee: number }>(`/api/identity/counter/sessions/${active!.id}/vehicles/${encodeURIComponent(v.plate)}/renew`, { method: 'POST', body: {} });
      const text = t('renewDone', { vehicle: `${v.make} ${v.model}`, date: fmtDate(r.new_expiry), fee: `${r.fee} ${t('currency')}` });
      setMsg(text); announce(text);
      setAssets(await api<Assets>(`/api/identity/counter/sessions/${active!.id}/assets`));
    } catch (e) { setErrors([errorText(e)]); } finally { loadActions(); }
  };

  const recordDelegation = (e: FormEvent) => { e.preventDefault(); void run(async () => {
    if (!/^\d{10}$/.test(delegate.trim())) throw new Error(t('delegNeedId'));
    if (!chosen.length) throw new Error(t('delegNeedScope'));
    const d = await api<{ delegate_name: Bi }>(`/api/identity/counter/sessions/${active!.id}/delegations`, { body: { delegate_id: delegate.trim(), scopes: chosen, days: 365 } });
    const text = t('counterDelegRecorded', { name: b(d.delegate_name) });
    setMsg(text); announce(text); setDelegate('');
  }); };

  const actionLabel = (a: string) => (hasKey(`act_${a.replace('.', '_')}`) ? t(`act_${a.replace('.', '_')}` as Key) : a);
  const fullName = (r: Rec) => `${b(r.given_name)} ${b(r.family_name)}`;

  return (
    <>
      <PageTitle text={t('counterTitle')} />
      <ErrorSummary title={t('errorTitle')} messages={errors} />
      {!me ? (errors.length ? null : <Loading />) : (
        <p className="lead">{t('counterWho', { name: b(me.employee.name), id: me.employee.employee_id, centre: b(me.employee.centre) })}</p>
      )}
      <p className="note" role="note">{t('counterRules')}</p>

      {!active && (
        <section aria-labelledby="start-h" className="panel">
          <h2 id="start-h" tabIndex={-1}>{t('counterStart')}</h2>
          <form onSubmit={start} noValidate>
            <div className="field">
              <label htmlFor="cs-nid">{t('counterCitizenId')}</label>
              <input id="cs-nid" inputMode="numeric" dir="ltr" autoComplete="off" maxLength={10} value={nid} onChange={(e) => setNid(e.target.value)} />
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy}>{t('counterSendCode')}</button>
          </form>
          {pending && (
            <form onSubmit={confirm} noValidate className="sub-form">
              <p className="check-ok" role="note">{t('counterCodeSent')}</p>
              <div className="field">
                <label htmlFor="cs-code">{t('counterCode')}</label>
                <input id="cs-code" inputMode="numeric" dir="ltr" autoComplete="off" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} />
              </div>
              <button type="submit" className="btn btn-primary" disabled={busy}>{t('counterConfirm')}</button>
            </form>
          )}
        </section>
      )}

      {active && (
        <section aria-labelledby="serving-h" className="panel">
          <h2 id="serving-h" tabIndex={-1}>{t('counterServing', { name: fullName(active.record) })}</h2>
          <p className="acting-banner" role="note">{t('counterBanner', { id: active.record.national_id, time: fmtDate(active.expires_at, true) })}</p>
          {msg && <p className="check-ok">{msg}</p>}
          <dl className="facts">
            <div><dt>{t('fieldNationalId')}</dt><dd dir="ltr">{active.record.national_id}</dd></div>
            <div><dt>{t('fieldBirthDate')}</dt><dd>{fmtDate(active.record.birth_date)}</dd></div>
            <div><dt>{t('fieldAddress')}</dt><dd>{b(active.record.address.city)}</dd></div>
          </dl>
          <h3>{t('citizenFamily')}</h3>
          <ul className="plain-list">{active.record.family.map((f) => <li key={f.national_id}>{hasKey(`rel_${f.relation}`) ? t(`rel_${f.relation}` as Key) : f.relation}: {b(f.name)} <span className="muted" dir="ltr">({f.national_id})</span></li>)}</ul>

          <h3>{t('vehicles')}</h3>
          {!assets ? (
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => run(async () => setAssets(await api<Assets>(`/api/identity/counter/sessions/${active.id}/assets`)))}>{t('counterShowVehicles')}</button>
          ) : <VehiclesTable vehicles={assets.vehicles} onRenew={renew} />}

          <h3 id="cd-h">{t('counterDelegHeading')}</h3>
          <form onSubmit={recordDelegation} noValidate aria-labelledby="cd-h">
            <div className="field">
              <label htmlFor="cd-id">{t('delegDelegateId')}</label>
              <input id="cd-id" inputMode="numeric" dir="ltr" autoComplete="off" maxLength={10} value={delegate} onChange={(e) => setDelegate(e.target.value)} />
            </div>
            <fieldset className="field">
              <legend>{t('delegScopes')}</legend>
              {scopes.map((s) => (
                <div key={s.scope} className="choice">
                  <input type="checkbox" id={`cs-${s.scope}`} checked={chosen.includes(s.scope)} onChange={(e) => setChosen(e.target.checked ? [...chosen, s.scope] : chosen.filter((x) => x !== s.scope))} />
                  <label htmlFor={`cs-${s.scope}`}>{b(s.label)}</label>
                </div>
              ))}
            </fieldset>
            <button type="submit" className="btn btn-primary" disabled={busy}>{t('counterDelegSubmit')}</button>
          </form>

          <p><button type="button" className="btn btn-danger" onClick={end} disabled={busy}>{t('counterEnd')}</button></p>
        </section>
      )}

      <section aria-labelledby="myact-h" className="panel">
        <h2 id="myact-h">{t('counterMyActions')}</h2>
        <p>{t('counterMyActionsHelp')}</p>
        <Filters fields={actionFields} value={list.filters} onApply={list.apply} />
        {!list.data ? <Loading /> : (
          <>
            <Pager page={list.page} total={list.data.total} onPage={list.setPage} label={t('counterMyActions')} />
            {list.data.items.length === 0 ? <p>{Object.keys(list.filters).length ? t('listEmpty') : t('counterNoActions')}</p> : (
              <TableRegion caption={t('counterMyActions')} visuallyHiddenCaption>
                <thead><tr><th scope="col">{t('colWhen')}</th><th scope="col">{t('colSubject')}</th><th scope="col">{t('colAction2')}</th></tr></thead>
                <tbody>
                  {list.data.items.map((a) => (
                    <tr key={a.id}><td>{fmtDate(a.at, true)}</td><th scope="row" dir="ltr">{a.citizen}</th><td>{actionLabel(a.action)}{a.detail?.plate ? ` — ${a.detail.plate}` : ''}</td></tr>
                  ))}
                </tbody>
              </TableRegion>
            )}
            {list.data.items.length > 0 && <Pager page={list.page} total={list.data.total} onPage={list.setPage} label={t('counterMyActions')} below />}
          </>
        )}
      </section>
    </>
  );
}
