import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api.ts';
import { hasKey, useI18n, type Bi, type Key } from '../i18n.tsx';
import { ErrorSummary, type ErrorItem, PageTitle, useAnnounce } from '../a11y.tsx';
import { useErrorText } from '../session.tsx';

interface Customer { account_number: string; full_name: Bi; city: Bi | null; employment_status: string | null; income_bracket: Bi | null; opened_at: string; last_kyc_at: string; kyc_status: string }
interface Rejection { message: string; details?: { regulator?: Bi; rejected_claims?: { name: string; label: Bi }[] } }

export function Bank() {
  const { t, b, fmtDate } = useI18n();
  const announce = useAnnounce();
  const errorText = useErrorText();
  const navigate = useNavigate();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [errors, setErrors] = useState<ErrorItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [rejection, setRejection] = useState<Rejection | null>(null);
  const [kycMsg, setKycMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const rejRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(() => api<{ customer: Customer | null }>('/api/bank/me').then((r) => setCustomer(r.customer)), []);
  useEffect(() => { load().catch(() => {}); }, [load]);
  useEffect(() => { if (rejection) rejRef.current?.focus(); }, [rejection]);

  const start = async (scenario: 'standard' | 'overreach') => {
    setBusy(true);
    setErrors([]);
    setRejection(null);
    try {
      const r = await api<{ status: string; redirect?: string; message?: string; details?: any }>('/api/bank/onboarding/start', { body: { scenario } });
      if (r.status === 'redirect' && r.redirect) {
        navigate(r.redirect);
        return;
      }
      setRejection({ message: r.message ?? '', details: r.details });
      announce(t('bankRejectedTitle'), 'assertive');
    } catch (e) {
      setErrors([errorText(e)]);
    } finally {
      setBusy(false);
    }
  };

  const kycRefresh = async () => {
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; reason?: string }>('/api/bank/me/kyc-refresh', { method: 'POST', body: {} });
      const msg = { ok: r.ok, text: r.ok ? t('bankKycOk') : r.reason === 'citizen_presence_required' ? t('bankKycNeedsCitizen') : t('bankKycRevoked') };
      setKycMsg(msg);
      announce(msg.text, r.ok ? 'polite' : 'assertive');
      await load();
    } catch (e) {
      setErrors([errorText(e)]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bank-theme">
      <p className="bank-notice" role="note">{t('bankDemoNotice')}</p>
      <p className="bank-logo" aria-hidden="true">{t('bankName')}</p>
      <PageTitle text={t('bankTitle')} />
      <ErrorSummary title={t('errorTitle')} messages={errors} />

      {customer && (
        <section aria-labelledby="acct-h" className="panel bank-panel">
          <h2 id="acct-h">{t('bankYourAccount')}</h2>
          <dl className="facts">
            <div><dt>{t('fieldName')}</dt><dd>{b(customer.full_name)}</dd></div>
            <div><dt>{t('bankAccountNumber')}</dt><dd dir="ltr">{customer.account_number}</dd></div>
            {customer.employment_status && <div><dt>{t('empStatus')}</dt><dd>{hasKey(`emp_${customer.employment_status}`) ? t(`emp_${customer.employment_status}` as Key) : customer.employment_status}</dd></div>}
            {customer.income_bracket && <div><dt>{t('incomeBracket')}</dt><dd>{b(customer.income_bracket)}</dd></div>}
            <div><dt>{t('bankKycStatus')}</dt><dd>{customer.kyc_status === 'verified' ? t('bankKyc_verified') : t('bankKyc_consent_revoked')}</dd></div>
            <div><dt>{t('bankLastKyc')}</dt><dd>{fmtDate(customer.last_kyc_at, true)}</dd></div>
          </dl>
          {kycMsg && <p className={kycMsg.ok ? 'check-ok' : 'check-bad'}>{kycMsg.text}</p>}
          <div className="actions">
            <button type="button" className="btn bank-btn" onClick={kycRefresh} disabled={busy}>{t('bankKycRefresh')}</button>
            <button type="button" className="btn btn-secondary" onClick={async () => { await api('/api/bank/me/forget', { method: 'POST', body: {} }); setCustomer(null); setKycMsg(null); }}>{t('bankForget')}</button>
          </div>
        </section>
      )}

      <section aria-labelledby="open-h" className="panel bank-panel">
        <h2 id="open-h" className="visually-hidden">{t('bankOpen')}</h2>
        <p className="lead">{t('bankIntro')}</p>
        <button type="button" className="btn bank-btn btn-large" onClick={() => start('standard')} disabled={busy}>
          {busy ? t('working') : t('bankOpen')}
        </button>
      </section>

      <section aria-labelledby="reg-h" className="panel">
        <h2 id="reg-h">{t('bankRegulatorHeading')}</h2>
        <p>{t('bankRegulatorHelp')}</p>
        <button type="button" className="btn btn-secondary" onClick={() => start('overreach')} disabled={busy}>{t('bankOverreach')}</button>
        {rejection && (
          <div className="result-bad">
            <h3 ref={rejRef} tabIndex={-1}>{t('bankRejectedTitle')}</h3>
            <p>{t('bankRejectedText', { reg: b(rejection.details?.regulator) })}</p>
            <ul>{rejection.details?.rejected_claims?.map((c) => <li key={c.name}>{b(c.label)}</li>)}</ul>
            <p className="muted" lang="en" dir="ltr">{rejection.message}</p>
          </div>
        )}
      </section>
    </div>
  );
}
