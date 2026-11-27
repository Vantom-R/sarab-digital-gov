// Audit & administration. Split into short pages (one per section) so a screen-reader user never has to
// read past hundreds of rows to reach a tool: /admin is an overview, /admin/<section> is one section.
// The two long lists (audit log, service-centre actions) have filters and 20 rows per page.
import { useEffect, useState } from 'react';
import { Link, NavLink, useParams } from 'react-router';
import { api } from '../api.ts';
import { hasKey, useI18n, type Bi, type Key } from '../i18n.tsx';
import { ErrorSummary, type ErrorItem, Loading, PageTitle, TableRegion, useAnnounce } from '../a11y.tsx';
import { useErrorText } from '../session.tsx';
import { AutomatedBadge, Filters, isAutomatedStaff, Pager, ResultBadge, useListing, type FilterField } from '../listing.tsx';
import { NotFound } from './NotFound.tsx';

interface Entry {
  seq: number; ts: string; client: string; target: string | null; path: string | null; purpose: string | null;
  subject: string | null; on_behalf_of: string | null; decision: string; status: number | null; reason: string | null; hash: string;
}
interface Rule { client: string; target: string; method: string; path_pattern: string; purposes: string[]; requires_consent: boolean; description: string; client_name: Bi; target_name: Bi }
interface Policy { sector: string; regulator: Bi; title: Bi; allowed_claims: { name: string; label: Bi }[] }
interface ReqRow { id: string; client_name: Bi; purpose: string; claims: string[]; status: string; reason: string | null; created_at: string }
interface Assisted { id: number; employee_id: string; citizen: string; action: string; detail: any; at: string; automated?: boolean }

const SECTIONS = [
  { id: 'audit', key: 'adminLog' },
  { id: 'counter-actions', key: 'adminAssisted' },
  { id: 'integrity', key: 'adminChain' },
  { id: 'sessions', key: 'adminSessions' },
  { id: 'consent', key: 'adminRequests' },
  { id: 'policy', key: 'adminRules' },
] as const satisfies readonly { id: string; key: Key }[];

export const COUNTER_ACTIONS = ['session.opened', 'record.viewed', 'assets.viewed', 'vehicle.renewed', 'delegation.recorded', 'session.ended', 'session.expired'];
export const actionKey = (a: string) => `act_${a.replace('.', '_')}`;

export function Admin() {
  const { t } = useI18n();
  const { section } = useParams();
  const [errors, setErrors] = useState<ErrorItem[]>([]);
  const current = SECTIONS.find((s) => s.id === section);
  if (section && !current) return <NotFound />;
  return (
    <>
      <nav aria-label={t('adminSectionsNav')} className="sub-nav">
        <ul>
          <li><NavLink to="/admin" end>{t('adminOverview')}</NavLink></li>
          {SECTIONS.map((s) => <li key={s.id}><NavLink to={`/admin/${s.id}`}>{t(s.key)}</NavLink></li>)}
        </ul>
      </nav>
      <PageTitle key={section ?? 'overview'} text={current ? t(current.key) : t('adminTitle')} />
      <ErrorSummary title={t('errorTitle')} messages={errors} />
      {!current && <Overview />}
      {section === 'audit' && <AuditLog setErrors={setErrors} />}
      {section === 'counter-actions' && <CounterActions setErrors={setErrors} />}
      {section === 'integrity' && <Integrity setErrors={setErrors} />}
      {section === 'sessions' && <Sessions setErrors={setErrors} />}
      {section === 'consent' && <ConsentRequests setErrors={setErrors} />}
      {section === 'policy' && <PolicyPage setErrors={setErrors} />}
    </>
  );
}

type SetErrors = (e: ErrorItem[]) => void;

/** The administrator holds every staff permission; this lists them with links to the staff tools. */
function Overview() {
  const { t, b } = useI18n();
  const [me, setMe] = useState<{ employee_id: string; permissions: { permission: string; label: { ar: string; en: string } }[] } | null>(null);
  useEffect(() => { api<typeof me>('/api/identity/staff/me').then(setMe).catch(() => {}); }, []);
  return (
    <>
      <section aria-labelledby="sections-h" className="panel">
        <h2 id="sections-h">{t('adminSectionsNav')}</h2>
        <p>{t('adminSectionsHelp')}</p>
        <ul className="plain-list">{SECTIONS.map((s) => <li key={s.id}><Link to={`/admin/${s.id}`}>{t(s.key)}</Link></li>)}</ul>
      </section>
      {me && (
        <section aria-labelledby="tools-h" className="panel">
          <h2 id="tools-h">{t('adminToolsHeading')}</h2>
          <p>{t('adminToolsHelp', { id: me.employee_id })}</p>
          <ul className="plain-list">{me.permissions.map((p) => <li key={p.permission}>{b(p.label)}</li>)}</ul>
          <p><Link to="/counter">{t('navCounter')}</Link> · <Link to="/registry">{t('navRegistry')}</Link> · <Link to="/manage">{t('navManage')}</Link> · <Link to="/births/report">{t('navBirthReport')}</Link></p>
        </section>
      )}
    </>
  );
}

function AuditLog({ setErrors }: { setErrors: SetErrors }) {
  const { t, fmtDate } = useI18n();
  const errorText = useErrorText();
  const list = useListing<Entry>('/api/jisr/audit', 'entries');
  useEffect(() => { if (list.error) setErrors([errorText(list.error)]); }, [list.error]); // eslint-disable-line react-hooks/exhaustive-deps
  const fields: FilterField[] = [
    { key: 'from', label: t('filterFrom'), type: 'date', hint: t('filterDateHint') },
    { key: 'to', label: t('filterTo'), type: 'date' },
    { key: 'employee', label: t('filterEmployee'), type: 'text', hint: t('filterEmployeeHint') },
    { key: 'subject', label: t('filterCitizen'), type: 'text', numeric: true },
    { key: 'result', label: t('filterResult'), type: 'select', options: [
      { value: 'allowed', label: t('resultAllowed') }, { value: 'no_record', label: t('resultNoRecord') },
      { value: 'failed', label: t('resultFailed') }, { value: 'denied', label: t('resultDenied') }] },
  ];
  return (
    <section aria-labelledby="log-h" className="panel">
      <h2 id="log-h" className="visually-hidden">{t('adminLog')}</h2>
      <p>{t('adminLogHelp')}</p>
      <Filters fields={fields} value={list.filters} onApply={list.apply} />
      {!list.data ? <Loading /> : (
        <>
          <Pager page={list.page} total={list.data.total} onPage={list.setPage} label={t('adminLog')} />
          {list.data.items.length === 0 ? <p>{t('listEmpty')}</p> : (
            <TableRegion caption={t('adminLog')} visuallyHiddenCaption>
              <thead>
                <tr>
                  <th scope="col">{t('colSeq')}</th><th scope="col">{t('colWhen')}</th><th scope="col">{t('colWho')}</th>
                  <th scope="col">{t('colTarget')}</th><th scope="col">{t('colPath')}</th><th scope="col">{t('colPurpose')}</th>
                  <th scope="col">{t('colSubject')}</th><th scope="col">{t('colOnBehalf')}</th><th scope="col">{t('colResult')}</th><th scope="col">{t('colHash')}</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((e) => (
                  <tr key={e.seq}>
                    <th scope="row" dir="ltr">{e.seq}</th>
                    <td>{fmtDate(e.ts, true)}</td>
                    <td dir="ltr">{e.client}</td>
                    <td dir="ltr">{e.target}</td>
                    <td dir="ltr" className="mono">{e.path?.split('?')[0]}</td>
                    <td dir="ltr">{e.purpose}</td>
                    <td dir="ltr">{e.subject ?? '—'}</td>
                    <td><span dir="ltr">{e.on_behalf_of ?? '—'}</span>{isAutomatedStaff(e.on_behalf_of) && <AutomatedBadge />}</td>
                    <td><ResultBadge decision={e.decision} status={e.status} reason={e.reason} showCode /></td>
                    <td dir="ltr" className="mono" title={e.hash}>{e.hash.slice(0, 12)}…</td>
                  </tr>
                ))}
              </tbody>
            </TableRegion>
          )}
          {list.data.items.length > 0 && <Pager page={list.page} total={list.data.total} onPage={list.setPage} label={t('adminLog')} below />}
        </>
      )}
    </section>
  );
}

/** Filter fields for a list of counter actions (also used by the counter's "My recent actions"). */
export function useActionFilters(withEmployee: boolean): FilterField[] {
  const { t } = useI18n();
  return [
    { key: 'from', label: t('filterFrom'), type: 'date', hint: t('filterDateHint') },
    { key: 'to', label: t('filterTo'), type: 'date' },
    ...(withEmployee ? [{ key: 'employee', label: t('filterEmployee'), type: 'text', hint: t('filterEmployeeHint') } as FilterField] : []),
    { key: 'citizen', label: t('filterCitizen'), type: 'text', numeric: true },
    { key: 'action', label: t('filterAction'), type: 'select', options: COUNTER_ACTIONS.map((a) => ({ value: a, label: hasKey(actionKey(a)) ? t(actionKey(a) as Key) : a })) },
  ];
}

function CounterActions({ setErrors }: { setErrors: SetErrors }) {
  const { t, fmtDate } = useI18n();
  const errorText = useErrorText();
  const list = useListing<Assisted>('/api/identity/admin/assisted-actions', 'actions');
  const fields = useActionFilters(true);
  useEffect(() => { if (list.error) setErrors([errorText(list.error)]); }, [list.error]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section aria-labelledby="assist-h" className="panel">
      <h2 id="assist-h" className="visually-hidden">{t('adminAssisted')}</h2>
      <p>{t('adminAssistedHelp')}</p>
      <Filters fields={fields} value={list.filters} onApply={list.apply} />
      {!list.data ? <Loading /> : (
        <>
          <Pager page={list.page} total={list.data.total} onPage={list.setPage} label={t('adminAssisted')} />
          {list.data.items.length === 0 ? <p>{t('listEmpty')}</p> : (
            <TableRegion caption={t('adminAssisted')} visuallyHiddenCaption>
              <thead><tr><th scope="col">{t('colWhen')}</th><th scope="col">{t('colEmployee')}</th><th scope="col">{t('colSubject')}</th><th scope="col">{t('colAction2')}</th></tr></thead>
              <tbody>
                {list.data.items.map((a) => (
                  <tr key={a.id}>
                    <td>{fmtDate(a.at, true)}</td>
                    <th scope="row"><span dir="ltr">{a.employee_id}</span>{(a.automated || isAutomatedStaff(a.employee_id)) && <AutomatedBadge />}</th>
                    <td dir="ltr">{a.citizen}</td>
                    <td>{hasKey(actionKey(a.action)) ? t(actionKey(a.action) as Key) : a.action}{a.detail?.plate ? ` — ${a.detail.plate}` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </TableRegion>
          )}
          {list.data.items.length > 0 && <Pager page={list.page} total={list.data.total} onPage={list.setPage} label={t('adminAssisted')} below />}
        </>
      )}
    </section>
  );
}

function Integrity({ setErrors }: { setErrors: SetErrors }) {
  const { t } = useI18n();
  const announce = useAnnounce();
  const errorText = useErrorText();
  const [head, setHead] = useState<{ seq: number; hash: string; signed: string } | null>(null);
  const [verify, setVerify] = useState<{ ok: boolean; entries: number; broken_at?: number; problem?: string } | null>(null);
  const [tamper, setTamper] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('/api/jisr/audit/head').then(setHead).catch((e) => setErrors([errorText(e)])); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const runVerify = async () => {
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; entries: number; broken_at?: number; problem?: string }>('/api/jisr/audit/verify', { method: 'POST', body: {} });
      setVerify(r);
      announce(r.ok ? t('adminChainOk', { n: r.entries }) : t('adminChainBroken', { seq: r.broken_at ?? '?', problem: r.problem ?? '' }), r.ok ? 'polite' : 'assertive');
    } catch (e) { setErrors([errorText(e)]); } finally { setBusy(false); }
  };

  const runTamper = async (kind: 'modify' | 'delete') => {
    setBusy(true);
    try {
      const r = await api<any>('/api/jisr/audit/tamper-demo', { body: { kind } });
      const d = r.verification_while_tampered;
      const what = r.tamper.action === 'deleted' ? t('adminTamperDelete') : `${r.tamper.from} → ${r.tamper.to}`;
      const text = t('adminTamperResult', {
        seq: r.tamper.seq, what,
        verdict: d.ok ? t('adminTamperMissed') : t('adminTamperCaught', { seq: d.broken_at, problem: d.problem }),
        after: r.verification_after_rollback.ok ? t('adminTamperIntact') : t('adminTamperMissed'),
      });
      setTamper(text);
      announce(text, 'assertive');
    } catch (e) { setErrors([errorText(e)]); } finally { setBusy(false); }
  };

  return (
    <>
      <section aria-labelledby="chain-h" className="panel">
        <h2 id="chain-h" className="visually-hidden">{t('adminChain')}</h2>
        <p>{t('adminChainHelp')}</p>
        <button type="button" className="btn btn-primary" onClick={runVerify} disabled={busy}>{busy ? t('working') : t('adminVerify')}</button>
        {verify && (
          <p className={verify.ok ? 'check-ok' : 'check-bad'}>
            {verify.ok ? t('adminChainOk', { n: verify.entries }) : t('adminChainBroken', { seq: verify.broken_at ?? '?', problem: verify.problem ?? '' })}
          </p>
        )}
        {head && (
          <>
            <h3>{t('adminHead')}</h3>
            <p dir="ltr" className="mono">#{head.seq} · {head.hash}</p>
          </>
        )}
      </section>
      <section aria-labelledby="tamper-h" className="panel">
        <h2 id="tamper-h">{t('adminTamper')}</h2>
        <p>{t('adminTamperHelp')}</p>
        <div className="actions">
          <button type="button" className="btn btn-danger" onClick={() => runTamper('modify')} disabled={busy}>{t('adminTamperModify')}</button>
          <button type="button" className="btn btn-danger" onClick={() => runTamper('delete')} disabled={busy}>{t('adminTamperDelete')}</button>
        </div>
        {tamper && <p className="check-bad tamper-result">{tamper}</p>}
      </section>
    </>
  );
}

function Sessions({ setErrors }: { setErrors: SetErrors }) {
  const { t, fmtDate } = useI18n();
  const announce = useAnnounce();
  const errorText = useErrorText();
  const [sess, setSess] = useState<{ active_by_role: { role: string; n: number }[]; kill_switch_not_before: string | null } | null>(null);
  const [revokeId, setRevokeId] = useState('');
  const [sessMsg, setSessMsg] = useState<string | null>(null);
  const [killConfirm, setKillConfirm] = useState(false);
  const loadSess = () => api<any>('/api/identity/admin/sessions').then(setSess);
  useEffect(() => { loadSess().catch((e) => setErrors([errorText(e)])); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section aria-labelledby="sess-h" className="panel">
      <h2 id="sess-h" className="visually-hidden">{t('adminSessions')}</h2>
      {!sess ? <Loading /> : (
        <>
          <p>{t('adminSessionsActive')}: {sess.active_by_role.map((r) => `${r.role} ${r.n}`).join(' · ') || '0'}</p>
          {sess.kill_switch_not_before && <p className="muted">{t('adminKillLast', { date: fmtDate(sess.kill_switch_not_before, true) })}</p>}
        </>
      )}
      <form className="inline-form" onSubmit={async (e) => {
        e.preventDefault();
        if (!/^\d{10}$/.test(revokeId.trim()) && !/^staff:/.test(revokeId.trim())) { setErrors([{ field: 'rv-id', text: `${t('adminRevokeLabel')}: ${t('delegNeedId')}` }]); return; }
        try { await api(`/api/identity/admin/subjects/${encodeURIComponent(revokeId.trim())}/revoke-sessions`, { body: {} }); const m = t('adminRevokedFor', { id: revokeId.trim() }); setSessMsg(m); announce(m); setRevokeId(''); setErrors([]); await loadSess(); } catch (err) { setErrors([errorText(err)]); }
      }}>
        <div className="field">
          <label htmlFor="rv-id">{t('adminRevokeLabel')}</label>
          <input id="rv-id" dir="ltr" autoComplete="off" value={revokeId} onChange={(e) => setRevokeId(e.target.value)} />
        </div>
        <button type="submit" className="btn btn-secondary">{t('adminRevokeSubmit')}</button>
      </form>
      <h3>{t('adminKill')}</h3>
      <p>{t('adminKillHelp')}</p>
      {!killConfirm ? <button type="button" className="btn btn-danger" onClick={() => { setKillConfirm(true); window.setTimeout(() => document.getElementById('kill-yes')?.focus(), 30); }}>{t('adminKill')}</button> : (
        <div className="confirm" role="group" aria-labelledby="kill-q">
          <p id="kill-q">{t('adminKillConfirm')}</p>
          <button id="kill-yes" type="button" className="btn btn-danger btn-small" onClick={async () => {
            try { await api('/api/identity/admin/kill-switch', { body: {} }); const m = t('adminKillDone'); setSessMsg(m); announce(m, 'assertive'); setKillConfirm(false); await loadSess(); } catch (err) { setErrors([errorText(err)]); }
          }}>{t('adminKillYes')}</button>
          <button type="button" className="btn btn-secondary btn-small" onClick={() => setKillConfirm(false)}>{t('cancel')}</button>
        </div>
      )}
      {sessMsg && <p className="check-ok">{sessMsg}</p>}
    </section>
  );
}

function ConsentRequests({ setErrors }: { setErrors: SetErrors }) {
  const { t, b, fmtDate } = useI18n();
  const errorText = useErrorText();
  const [requests, setRequests] = useState<ReqRow[] | null>(null);
  useEffect(() => { api<{ requests: ReqRow[] }>('/api/consent/requests').then((r) => setRequests(r.requests)).catch((e) => setErrors([errorText(e)])); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section aria-labelledby="req-h" className="panel">
      <h2 id="req-h" className="visually-hidden">{t('adminRequests')}</h2>
      {!requests ? <Loading /> : (
        <TableRegion caption={t('adminRequests')} visuallyHiddenCaption>
          <thead><tr><th scope="col">{t('colWhen')}</th><th scope="col">{t('colOrg')}</th><th scope="col">{t('colData')}</th><th scope="col">{t('colStatus')}</th><th scope="col">{t('colReason')}</th></tr></thead>
          <tbody>
            {requests.map((r) => (
              <tr key={r.id}>
                <td>{fmtDate(r.created_at, true)}</td>
                <th scope="row">{b(r.client_name)}</th>
                <td dir="ltr">{r.claims.join(', ')}</td>
                <td dir="ltr"><span className={`badge ${r.status === 'rejected_by_policy' || r.status === 'denied' ? 'badge-bad' : 'badge-ok'}`}>{r.status}</span></td>
                <td dir="ltr">{r.reason ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </TableRegion>
      )}
    </section>
  );
}

function PolicyPage({ setErrors }: { setErrors: SetErrors }) {
  const { t, b } = useI18n();
  const errorText = useErrorText();
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [policies, setPolicies] = useState<Policy[] | null>(null);
  useEffect(() => {
    const fail = (e: unknown) => setErrors([errorText(e)]);
    api<{ rules: Rule[] }>('/api/jisr/rules').then((r) => setRules(r.rules)).catch(fail);
    api<{ policies: Policy[] }>('/api/consent/policies').then((r) => setPolicies(r.policies)).catch(fail);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <section aria-labelledby="rules-h" className="panel">
        <h2 id="rules-h" className="visually-hidden">{t('adminRules')}</h2>
        {!rules ? <Loading /> : (
          <TableRegion caption={t('adminRules')} visuallyHiddenCaption>
            <thead><tr><th scope="col">{t('colWho')}</th><th scope="col">{t('colTarget')}</th><th scope="col">{t('colPath')}</th><th scope="col">{t('colPurpose')}</th><th scope="col">{t('colConsentRequired')}</th><th scope="col">{t('colDescription')}</th></tr></thead>
            <tbody>
              {rules.map((r) => (
                <tr key={`${r.client}-${r.target}-${r.method}-${r.path_pattern}`}>
                  <th scope="row">{b(r.client_name)}</th>
                  <td>{b(r.target_name)}</td>
                  <td dir="ltr" className="mono">{r.method} {r.path_pattern}</td>
                  <td dir="ltr">{r.purposes.join(', ')}</td>
                  <td>{r.requires_consent ? t('yes') : t('no')}</td>
                  <td lang="en" dir="ltr">{r.description}</td>
                </tr>
              ))}
            </tbody>
          </TableRegion>
        )}
      </section>
      <section aria-labelledby="pol-h" className="panel">
        <h2 id="pol-h">{t('adminPolicies')}</h2>
        {!policies ? <Loading /> : policies.map((p) => (
          <div key={p.sector} className="policy">
            <h3>{b(p.regulator)} — {b(p.title)}</h3>
            <ul className="compact-list">{p.allowed_claims.map((c) => <li key={c.name}>{b(c.label)}</li>)}</ul>
          </div>
        ))}
      </section>
    </>
  );
}
