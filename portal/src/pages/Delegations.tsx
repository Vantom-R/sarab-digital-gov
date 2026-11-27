// Delegation: authorise someone (mandate signed with your key), see/revoke, and act for people who authorised you.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../api.ts';
import { useI18n, hasKey, type Bi, type Key } from '../i18n.tsx';
import { ErrorSummary, type ErrorItem, Loading, PageTitle, TableRegion, useAnnounce } from '../a11y.tsx';
import { useErrorText, useSession } from '../session.tsx';
import { ceremony, keyStatus, NoDeviceKeyHere } from '../wallet.ts';

export interface Delegation {
  id: string; grantor: string; delegate: string; grantor_name: Bi; delegate_name: Bi;
  scopes: { scope: string; label: Bi }[]; valid_until: string; created_at: string; created_via: string; created_by: string | null;
  status: 'active' | 'revoked' | 'expired';
}
interface Scope { scope: string; label: Bi; description: Bi }

export function Delegations() {
  const { t, b, fmtDate } = useI18n();
  const announce = useAnnounce();
  const errorText = useErrorText();
  const { session } = useSession();
  const [data, setData] = useState<{ granted: Delegation[]; received: Delegation[] } | null>(null);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [errors, setErrors] = useState<ErrorItem[]>([]);
  const [delegateId, setDelegateId] = useState('');
  const [chosen, setChosen] = useState<string[]>(['vehicles.renew']);
  const [days, setDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const confirmRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => api<{ granted: Delegation[]; received: Delegation[] }>('/api/identity/me/delegations').then(setData), []);
  useEffect(() => {
    load().catch((e) => setErrors([errorText(e)]));
    api<{ scopes: Scope[] }>('/api/identity/delegation-scopes').then((r) => setScopes(r.scopes)).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (confirming) confirmRef.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, [confirming]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: ErrorItem[] = [];
    if (!/^\d{10}$/.test(delegateId.trim())) errs.push({ field: 'd-id', text: t('delegNeedId') });
    if (!chosen.length) errs.push({ field: `sc-${scopes[0]?.scope ?? ''}`, text: t('delegNeedScope') });
    setErrors(errs);
    setDone(null);
    if (errs.length) return;
    setBusy(true);
    try {
      const input = { delegate_id: delegateId.trim(), scopes: chosen, days };
      // Phase 6: with a device-held key the mandate is signed on this device after a passkey check.
      const d = (await keyStatus()).mode === 'device'
        ? await ceremony<Delegation>(session!.sub, 'mandate', input)
        : await api<Delegation>('/api/identity/me/delegations', { body: input });
      const msg = t('delegCreated', { name: b(d.delegate_name) });
      setDone(msg);
      announce(msg);
      setDelegateId('');
      await load();
    } catch (err) {
      setErrors([err instanceof NoDeviceKeyHere ? t('walletKeyElsewhere') : err instanceof Error && err.name === 'NotAllowedError' ? t('passkeyCancelled') : errorText(err)]);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (d: Delegation) => {
    try {
      await api(`/api/identity/me/delegations/${d.id}`, { method: 'DELETE' });
      setConfirming(null);
      await load();
      announce(t('delegRevoked'));
      document.getElementById('granted-h')?.focus();
    } catch (err) { setErrors([errorText(err)]); }
  };

  const statusBadge = (d: Delegation) => (
    <span className={`badge ${d.status === 'active' ? 'badge-ok' : 'badge-muted'}`}>{hasKey(`delegStatus_${d.status}`) ? t(`delegStatus_${d.status}` as Key) : d.status}</span>
  );

  return (
    <>
      <PageTitle text={t('delegTitle')} />
      <ErrorSummary title={t('errorTitle')} messages={errors} />
      <p className="lead">{t('delegIntro')}</p>

      <section aria-labelledby="grant-h" className="panel">
        <h2 id="grant-h">{t('delegGrantHeading')}</h2>
        <form onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="d-id">{t('delegDelegateId')}</label>
            <p id="d-id-hint" className="hint">{t('loginUsernameHint')}</p>
            <input id="d-id" inputMode="numeric" dir="ltr" autoComplete="off" maxLength={10} value={delegateId} aria-describedby="d-id-hint" onChange={(e) => setDelegateId(e.target.value)} />
          </div>
          <fieldset className="field">
            <legend>{t('delegScopes')}</legend>
            {scopes.map((s) => (
              <div key={s.scope} className="choice">
                <input type="checkbox" id={`sc-${s.scope}`} checked={chosen.includes(s.scope)} aria-describedby={`sc-${s.scope}-d`}
                  onChange={(e) => setChosen(e.target.checked ? [...chosen, s.scope] : chosen.filter((x) => x !== s.scope))} />
                <label htmlFor={`sc-${s.scope}`}>{b(s.label)}</label>
                <p id={`sc-${s.scope}-d`} className="hint">{b(s.description)}</p>
              </div>
            ))}
          </fieldset>
          <div className="field">
            <label htmlFor="d-days">{t('delegDays')}</label>
            <select id="d-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {[7, 30, 90, 365].map((n) => <option key={n} value={n}>{t('delegDaysN', { n })}</option>)}
            </select>
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('working') : t('delegSubmit')}</button>
          {done && <p className="check-ok">{done}</p>}
        </form>
      </section>

      <section aria-labelledby="granted-h" className="panel">
        <h2 id="granted-h" tabIndex={-1}>{t('delegGrantedHeading')}</h2>
        {!data ? <Loading /> : data.granted.length === 0 ? <p>{t('delegNoneGranted')}</p> : (
          <TableRegion caption={t('delegGrantedHeading')} visuallyHiddenCaption>
            <thead><tr><th scope="col">{t('colPerson')}</th><th scope="col">{t('colPermissions')}</th><th scope="col">{t('colUntil')}</th><th scope="col">{t('colStatus')}</th><th scope="col">{t('colAction')}</th></tr></thead>
            <tbody>
              {data.granted.map((d) => (
                <tr key={d.id}>
                  <th scope="row">{b(d.delegate_name)} <span className="muted" dir="ltr">({d.delegate})</span>
                    {d.created_via === 'service-centre' && <><br /><span className="muted">{t('delegViaCentre', { emp: d.created_by ?? '' })}</span></>}
                  </th>
                  <td><ul className="compact-list">{d.scopes.map((s) => <li key={s.scope}>{b(s.label)}</li>)}</ul></td>
                  <td>{fmtDate(d.valid_until)}</td>
                  <td>{statusBadge(d)}</td>
                  <td>
                    {d.status === 'active' && confirming !== d.id && (
                      <button type="button" className="btn btn-danger btn-small" aria-label={t('delegRevokeFor', { name: b(d.delegate_name) })} onClick={() => setConfirming(d.id)}>{t('delegRevoke')}</button>
                    )}
                    {confirming === d.id && (
                      <div ref={confirmRef} className="confirm" role="group" aria-labelledby={`dc-${d.id}`}>
                        <p id={`dc-${d.id}`}>{t('delegRevokeConfirm', { name: b(d.delegate_name) })}</p>
                        <button type="button" className="btn btn-danger btn-small" onClick={() => revoke(d)}>{t('delegRevokeYes')}</button>
                        <button type="button" className="btn btn-secondary btn-small" onClick={() => setConfirming(null)}>{t('cancel')}</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableRegion>
        )}
      </section>

      <section aria-labelledby="received-h" className="panel">
        <h2 id="received-h" tabIndex={-1}>{t('delegReceivedHeading')}</h2>
        {!data ? <Loading /> : data.received.length === 0 ? <p>{t('delegNoneReceived')}</p> : (
          <TableRegion caption={t('delegReceivedHeading')} visuallyHiddenCaption>
            <thead><tr><th scope="col">{t('colPerson')}</th><th scope="col">{t('colPermissions')}</th><th scope="col">{t('colUntil')}</th><th scope="col">{t('colStatus')}</th><th scope="col">{t('colAction')}</th></tr></thead>
            <tbody>
              {data.received.map((d) => (
                <tr key={d.id}>
                  <th scope="row">{b(d.grantor_name)}</th>
                  <td><ul className="compact-list">{d.scopes.map((s) => <li key={s.scope}>{b(s.label)}</li>)}</ul></td>
                  <td>{fmtDate(d.valid_until)}</td>
                  <td>{statusBadge(d)}</td>
                  <td>
                    {d.status === 'active' && (
                      <div className="actions">
                        <Link className="btn btn-primary btn-small" to={`/citizen/acting/${d.id}`}>{t('delegActFor', { name: b(d.grantor_name) })}</Link>
                        <button type="button" className="btn btn-secondary btn-small" aria-label={t('delegDeclineFor', { name: b(d.grantor_name) })}
                          onClick={async () => { try { await api(`/api/identity/me/delegations/${d.id}`, { method: 'DELETE' }); await load(); announce(t('delegRevoked')); document.getElementById('received-h')?.focus(); } catch (err) { setErrors([errorText(err)]); } }}>
                          {t('delegDecline')}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableRegion>
        )}
      </section>
    </>
  );
}
