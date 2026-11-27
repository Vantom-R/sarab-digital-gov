import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { startRegistration } from '@simplewebauthn/browser';
import { api } from '../api.ts';
import { hasKey, useI18n, type Bi, type Key } from '../i18n.tsx';
import { ResultBadge } from '../listing.tsx';
import { ErrorSummary, type ErrorItem, Loading, PageTitle, TableRegion, useAnnounce } from '../a11y.tsx';
import { useErrorText, useSession } from '../session.tsx';
import { AssetsSection, EducationSection, EmploymentSection, HealthSection } from './MyData.tsx';
import { enrolDeviceKey, forgetDeviceKey, getDeviceKey, keyStatus, type KeyStatus } from '../wallet.ts';

interface CivilRecord {
  national_id: string; given_name: Bi; family_name: Bi; gender: string; birth_date: string; nationality: string;
  marital_status: string; address: { city: Bi; district: Bi; street: string };
  family: { national_id: string; relation: string; name: Bi }[];
}
interface Claim { name: string; label: Bi }
interface ConsentRow {
  id: string; status: 'active' | 'revoked'; client: { id: string; name: Bi }; purpose: { label: Bi };
  claims: Claim[]; granted_at: string; valid_until: string; revoked_at: string | null; use_count: number;
}
interface AccessRow {
  seq: number; ts: string; client: string; client_name?: Bi; target_name?: Bi; purpose_label?: Bi;
  on_behalf_of_name?: Bi; event_label?: Bi; decision: 'allow' | 'deny'; status: number | null; reason: string | null;
}
interface Passkey { credential_id: string; nickname: string; created_at: string; last_used_at: string | null }

export function Citizen() {
  const { t, b, fmtDate } = useI18n();
  const { session } = useSession();
  const errorText = useErrorText();
  const [record, setRecord] = useState<CivilRecord | null>(null);
  const [errors, setErrors] = useState<ErrorItem[]>([]);

  useEffect(() => {
    api<CivilRecord>('/api/identity/me/record').then(setRecord).catch((e) => setErrors([errorText(e)]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const tr = (prefix: string, v: string) => { const k = `${prefix}_${v}`; return hasKey(k) ? t(k) : v; };

  return (
    <>
      <PageTitle text={t('citizenWelcome', { name: session ? b(session.name) : '' })} />
      <ErrorSummary title={t('errorTitle')} messages={errors} />

      <nav aria-label={t('navCitizen')} className="toc">
        <ul>
          <li><a href="#record-h">{t('citizenRecord')}</a></li>
          <li><a href="#edu-h">{t('eduTitle')}</a></li>
          <li><a href="#work-h">{t('workTitle')}</a></li>
          <li><a href="#assets-h">{t('assetsTitle')}</a></li>
          <li><a href="#health-h">{t('healthTitle')}</a></li>
          <li><a href="#consents-h">{t('citizenConsents')}</a></li>
          <li><a href="#access-h">{t('citizenAccess')}</a></li>
          <li><a href="#assisted-h">{t('assistedHeading')}</a></li>
          <li><a href="#passkeys-h">{t('citizenPasskeys')}</a></li>
          <li><a href="#devkey-h">{t('devKeyHeading')}</a></li>
          <li><a href="#sessions-h">{t('sessionsHeading')}</a></li>
          <li><Link to="/citizen/sign">{t('citizenSignLink')}</Link></li>
        </ul>
      </nav>

      <section aria-labelledby="record-h" className="panel">
        <h2 id="record-h" tabIndex={-1}>{t('citizenRecord')}</h2>
        {!record ? <Loading /> : (
          <>
            <dl className="facts">
              <div><dt>{t('fieldName')}</dt><dd>{b(record.given_name)} {b(record.family_name)}</dd></div>
              <div><dt>{t('fieldNationalId')}</dt><dd dir="ltr">{record.national_id}</dd></div>
              <div><dt>{t('fieldBirthDate')}</dt><dd>{fmtDate(record.birth_date)}</dd></div>
              <div><dt>{t('fieldGender')}</dt><dd>{tr('gender', record.gender)}</dd></div>
              <div><dt>{t('fieldNationality')}</dt><dd>{tr('nationality', record.nationality)}</dd></div>
              <div><dt>{t('fieldMarital')}</dt><dd>{tr('marital', record.marital_status)}</dd></div>
              <div><dt>{t('fieldAddress')}</dt><dd>{record.address.street}، {b(record.address.district)}، {b(record.address.city)}</dd></div>
            </dl>
            <p className="note">{t('citizenRecordSource')}</p>
            <h3>{t('citizenFamily')}</h3>
            <ul className="plain-list">
              {record.family.map((f) => (
                <li key={f.national_id}>{tr('rel', f.relation)}: {b(f.name)} <span dir="ltr" className="muted">({f.national_id})</span></li>
              ))}
            </ul>
          </>
        )}
      </section>

      <EducationSection />
      <EmploymentSection />
      <AssetsSection />
      <HealthSection />
      <Consents setErrors={setErrors} />
      <AccessLog setErrors={setErrors} />
      <AssistedLog />
      <Passkeys setErrors={setErrors} />
      <DeviceKey setErrors={setErrors} />
      <Sessions setErrors={setErrors} />

      <section aria-labelledby="sign-h" className="panel">
        <h2 id="sign-h">{t('citizenKeyHeading')}</h2>
        <p>{t('citizenKeyHelp')}</p>
        <p><Link to="/citizen/sign" className="btn btn-secondary">{t('citizenSignLink')}</Link></p>
      </section>
    </>
  );
}

// ---------------- sub-sections ----------------

function Consents({ setErrors }: { setErrors: (m: string[]) => void }) {
  const { t, b, fmtDate } = useI18n();
  const errorText = useErrorText();
  const announce = useAnnounce();
  const [rows, setRows] = useState<ConsentRow[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  const load = useCallback(() => api<{ consents: ConsentRow[] }>('/api/consent/consents/mine').then((r) => setRows(r.consents)), []);
  useEffect(() => { load().catch((e) => setErrors([errorText(e)])); }, [load]);
  useEffect(() => { if (confirming) confirmRef.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, [confirming]);

  const revoke = async (c: ConsentRow) => {
    setBusy(true);
    try {
      await api(`/api/consent/consents/${c.id}/revoke`, { method: 'POST', body: {} });
      setConfirming(null);
      await load();
      announce(t('revokeDone'));
      document.getElementById('consents-h')?.focus();
    } catch (e) {
      setErrors([errorText(e)]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="consents-h" className="panel">
      <h2 id="consents-h" tabIndex={-1}>{t('citizenConsents')}</h2>
      {!rows ? <Loading /> : rows.length === 0 ? <p>{t('citizenNoConsents')}</p> : (
        <TableRegion caption={t('citizenConsents')} visuallyHiddenCaption>
          <thead>
            <tr>
              <th scope="col">{t('colOrg')}</th>
              <th scope="col">{t('colPurpose')}</th>
              <th scope="col">{t('colData')}</th>
              <th scope="col">{t('colGranted')}</th>
              <th scope="col">{t('colStatus')}</th>
              <th scope="col">{t('colAction')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <th scope="row">{b(c.client.name)}</th>
                <td>{b(c.purpose.label)}</td>
                <td><ul className="compact-list">{c.claims.map((cl) => <li key={cl.name}>{b(cl.label)}</li>)}</ul></td>
                <td>{fmtDate(c.granted_at)}<br /><span className="muted">{t('usedTimes', { n: c.use_count })}</span></td>
                <td><span className={`badge ${c.status === 'active' ? 'badge-ok' : 'badge-muted'}`}>{c.status === 'active' ? t('consentActive') : t('consentRevoked')}</span></td>
                <td>
                  {c.status === 'active' && confirming !== c.id && (
                    <button type="button" className="btn btn-danger btn-small" onClick={() => setConfirming(c.id)} aria-label={t('revokeFor', { org: b(c.client.name) })}>
                      {t('revoke')}
                    </button>
                  )}
                  {confirming === c.id && (
                    <div ref={confirmRef} className="confirm" role="group" aria-labelledby={`confirm-${c.id}`}>
                      <p id={`confirm-${c.id}`}>{t('revokeConfirm', { org: b(c.client.name) })}</p>
                      <button type="button" className="btn btn-danger btn-small" disabled={busy} onClick={() => revoke(c)}>{t('revokeYes')}</button>
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
  );
}

function AccessLog({ setErrors }: { setErrors: (m: string[]) => void }) {
  const { t, b, fmtDate } = useI18n();
  const errorText = useErrorText();
  const announce = useAnnounce();
  const [rows, setRows] = useState<AccessRow[] | null>(null);
  const load = useCallback(() => api<{ entries: AccessRow[] }>('/api/jisr/audit/mine?limit=100').then((r) => { setRows(r.entries); return r.entries; }), []);
  useEffect(() => { load().catch((e) => setErrors([errorText(e)])); }, [load]);
  return (
    <section aria-labelledby="access-h" className="panel">
      <h2 id="access-h">{t('citizenAccess')}</h2>
      <p>{t('citizenAccessHelp')}</p>
      <p>
        <button type="button" className="btn btn-secondary btn-small" onClick={async () => {
          const e = await load().catch(() => null);
          if (e) announce(`${t('citizenAccess')}: ${e.length}`);
        }}>{t('refresh')}</button>
      </p>
      {!rows ? <Loading /> : rows.length === 0 ? <p>{t('citizenAccessEmpty')}</p> : (
        <TableRegion caption={t('citizenAccessCaption')}>
          <thead>
            <tr>
              <th scope="col">{t('colWhen')}</th>
              <th scope="col">{t('colWho')}</th>
              <th scope="col">{t('colFrom')}</th>
              <th scope="col">{t('colOnBehalf')}</th>
              <th scope="col">{t('colPurpose')}</th>
              <th scope="col">{t('colResult')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.seq}>
                <td>{fmtDate(r.ts, true)}</td>
                <th scope="row">{b(r.client_name)}</th>
                <td>{b(r.target_name)}</td>
                <td>{b(r.on_behalf_of_name)}</td>
                <td>{b(r.purpose_label)}{r.event_label && <><br /><span className="muted">{t('eventLabel', { label: b(r.event_label) })}</span></>}</td>
                <td>
                  <ResultBadge decision={r.decision} status={r.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </TableRegion>
      )}
    </section>
  );
}

function AssistedLog() {
  const { t, b, fmtDate } = useI18n();
  const [rows, setRows] = useState<{ id: number; employee_id: string; centre: Bi; action: string; at: string; detail: any }[] | null>(null);
  useEffect(() => { api<{ actions: any[] }>('/api/identity/me/assisted-actions').then((r) => setRows(r.actions)).catch(() => setRows([])); }, []);
  return (
    <section aria-labelledby="assisted-h" className="panel">
      <h2 id="assisted-h">{t('assistedHeading')}</h2>
      <p>{t('assistedHelp')}</p>
      {!rows ? <Loading /> : rows.length === 0 ? <p>{t('assistedNone')}</p> : (
        <TableRegion caption={t('assistedHeading')} visuallyHiddenCaption>
          <thead><tr><th scope="col">{t('colWhen')}</th><th scope="col">{t('colEmployee')}</th><th scope="col">{t('colAction2')}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{fmtDate(r.at, true)}</td>
                <th scope="row"><span dir="ltr">{r.employee_id}</span> — {b(r.centre)}</th>
                <td>{hasKey(`act_${r.action.replace('.', '_')}`) ? t(`act_${r.action.replace('.', '_')}` as Key) : r.action}{r.detail?.plate ? ` — ${r.detail.plate}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </TableRegion>
      )}
    </section>
  );
}

function DeviceKey({ setErrors }: { setErrors: (m: string[]) => void }) {
  const { t, fmtDate } = useI18n();
  const errorText = useErrorText();
  const announce = useAnnounce();
  const { session } = useSession();
  const [st, setSt] = useState<KeyStatus | null>(null);
  const [here, setHere] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const k = await keyStatus();
    setSt(k);
    setHere(session ? !!(await getDeviceKey(session.sub).catch(() => undefined)) : false);
  }, [session]);
  useEffect(() => { load().catch((e) => setErrors([errorText(e)])); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await fn(); await load(); announce(done); document.getElementById('devkey-h')?.focus(); }
    catch (e) { setErrors([e instanceof Error && e.name === 'NotAllowedError' ? t('passkeyCancelled') : errorText(e)]); }
    finally { setBusy(false); }
  };
  return (
    <section aria-labelledby="devkey-h" className="panel">
      <h2 id="devkey-h" tabIndex={-1}>{t('devKeyHeading')}</h2>
      <p>{t('devKeyHelp')}</p>
      {!st ? <Loading /> : st.mode === 'cloud' ? (
        <>
          <p><strong>{t('devKeyCloud')}</strong></p>
          <button type="button" className="btn btn-primary" disabled={busy || !session} onClick={() => run(() => enrolDeviceKey(session!.sub), t('devKeyMoved'))}>{busy ? t('working') : t('devKeyMove')}</button>
          <p className="hint">{t('devKeyNeedsPasskey')}</p>
        </>
      ) : (
        <>
          <p className="check-ok">{t('devKeyDevice', { passkey: st.passkey?.nickname ?? '—', date: fmtDate(st.enrolled_at, true) })}</p>
          <p>{here ? t('devKeyHere') : t('devKeyElsewhere')}</p>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => run(async () => { await api('/api/identity/me/device-key', { method: 'DELETE' }); if (session) await forgetDeviceKey(session.sub); }, t('devKeyReturned'))}>{t('devKeyReturn')}</button>
        </>
      )}
    </section>
  );
}

function Sessions({ setErrors }: { setErrors: (m: string[]) => void }) {
  const { t, fmtDate } = useI18n();
  const errorText = useErrorText();
  const announce = useAnnounce();
  const { refresh } = useSession();
  const [rows, setRows] = useState<{ id: string; current: boolean; created_at: string; expires_at: string; user_agent: string; amr: string[] }[] | null>(null);
  const load = useCallback(() => api<{ sessions: any[] }>('/api/identity/me/sessions').then((r) => setRows(r.sessions)), []);
  useEffect(() => { load().catch((e) => setErrors([errorText(e)])); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  const device = (ua: string) => /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : t('sessionUnknownDevice');
  const browser = (ua: string) => /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return (
    <section aria-labelledby="sessions-h" className="panel">
      <h2 id="sessions-h" tabIndex={-1}>{t('sessionsHeading')}</h2>
      <p>{t('sessionsHelp')}</p>
      {!rows ? <Loading /> : (
        <ul className="plain-list">
          {rows.map((r, i) => (
            <li key={r.id} className="row-item">
              <span>
                <strong>{device(r.user_agent)} {browser(r.user_agent)}</strong>{r.current && <> — <span className="badge badge-ok">{t('sessionThis')}</span></>}
                <br /><span className="muted">{t('sessionSince', { date: fmtDate(r.created_at, true) })} · {r.amr.includes('hwk') ? t('sessionPasskey') : t('sessionPassword')}</span>
              </span>
              {!r.current && (
                <button type="button" className="btn btn-secondary btn-small" aria-label={t('sessionEndFor', { n: String(i + 1), device: `${device(r.user_agent)} ${browser(r.user_agent)}`, date: fmtDate(r.created_at, true) })}
                  onClick={async () => { try { await api(`/api/identity/me/sessions/${encodeURIComponent(r.id)}`, { method: 'DELETE' }); await load(); announce(t('sessionEnded')); document.getElementById('sessions-h')?.focus(); } catch (e) { setErrors([errorText(e)]); } }}>
                  {t('sessionEnd')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn btn-danger" onClick={async () => {
        try { await api('/api/identity/me/sessions/sign-out-everywhere', { body: {} }); announce(t('sessionAllEnded'), 'assertive'); await refresh(); } catch (e) { setErrors([errorText(e)]); }
      }}>{t('sessionSignOutEverywhere')}</button>
    </section>
  );
}

function Passkeys({ setErrors }: { setErrors: (m: string[]) => void }) {
  const { t, b, fmtDate } = useI18n();
  const errorText = useErrorText();
  const announce = useAnnounce();
  const [keys, setKeys] = useState<Passkey[] | null>(null);
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<{ passkeys: Passkey[] }>('/api/identity/me/passkeys').then((r) => setKeys(r.passkeys)), []);
  useEffect(() => { load().catch((e) => setErrors([errorText(e)])); }, [load]);

  const add = async () => {
    setBusy(true);
    try {
      const { challenge_id, options } = await api('/api/identity/me/passkeys/options', { method: 'POST', body: {} });
      const response = await startRegistration({ optionsJSON: options });
      await api('/api/identity/me/passkeys', { body: { challenge_id, response, nickname } });
      setNickname('');
      await load();
      announce(t('passkeyAdded'));
    } catch (e) {
      if (e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'InvalidStateError' || e.name === 'SecurityError')) {
        setErrors([t('passkeyCancelled')]);
      } else {
        setErrors([errorText(e)]);
      }
    } finally {
      setBusy(false);
    }
  };
  const remove = async (k: Passkey) => {
    try {
      await api(`/api/identity/me/passkeys/${encodeURIComponent(k.credential_id)}`, { method: 'DELETE' });
      await load();
      announce(t('passkeyRemoved'));
      document.getElementById('passkeys-h')?.focus();
    } catch (e) { setErrors([errorText(e)]); }
  };

  return (
    <section aria-labelledby="passkeys-h" className="panel">
      <h2 id="passkeys-h" tabIndex={-1}>{t('citizenPasskeys')}</h2>
      <p>{t('citizenPasskeysHelp')}</p>
      {!keys ? <Loading /> : keys.length === 0 ? <p>{t('citizenNoPasskeys')}</p> : (
        <ul className="plain-list">
          {keys.map((k) => (
            <li key={k.credential_id} className="row-item">
              <span><strong>{k.nickname}</strong> — {t('passkeyCreated', { date: fmtDate(k.created_at) })}</span>
              <button type="button" className="btn btn-secondary btn-small" onClick={() => remove(k)}>{t('passkeyRemove', { name: k.nickname })}</button>
            </li>
          ))}
        </ul>
      )}
      <div className="field inline-field">
        <label htmlFor="pk-nick">{t('passkeyNickname')}</label>
        <input id="pk-nick" value={nickname} maxLength={60} onChange={(e) => setNickname(e.target.value)} />
      </div>
      <button type="button" className="btn btn-primary" onClick={add} disabled={busy}>{busy ? t('working') : t('passkeyAdd')}</button>
    </section>
  );
}
