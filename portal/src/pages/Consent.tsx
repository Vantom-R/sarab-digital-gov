import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api } from '../api.ts';
import { useI18n, type Bi } from '../i18n.tsx';
import { ErrorSummary, type ErrorItem, Loading, PageTitle, useAnnounce } from '../a11y.tsx';
import { useErrorText, useSession } from '../session.tsx';
import { keyStatus, shareFromDevice, NoDeviceKeyHere } from '../wallet.ts';

interface ClaimView { name: string; label: Bi; description: Bi; derived: boolean }
interface RequestView {
  id: string; status: string; client: { id: string; name: Bi; sector: string }; purpose: { label: Bi };
  claims: ClaimView[]; not_requested: ClaimView[]; validity_days: number; regulator: Bi | null;
  audience?: string; nonce?: string | null;
}

export function Consent() {
  const { id } = useParams();
  const { t, b } = useI18n();
  const announce = useAnnounce();
  const errorText = useErrorText();
  const { session } = useSession();
  const navigate = useNavigate();
  const [req, setReq] = useState<RequestView | null>(null);
  const [errors, setErrors] = useState<ErrorItem[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<RequestView>(`/api/consent/requests/${encodeURIComponent(id ?? '')}`).then(setReq).catch((e) => setErrors([errorText(e)]));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const decide = async (approve: boolean) => {
    if (!req) return;
    setBusy(true);
    setErrors([]);
    try {
      const r = await api<{ redirect: string; consent_id?: string }>(`/api/consent/requests/${req.id}/${approve ? 'approve' : 'deny'}`, { method: 'POST', body: {} });
      // Phase 6: if my key lives on my device, my device builds and signs the proof now (after a passkey check).
      if (approve && r.consent_id && session && (await keyStatus()).mode === 'device') {
        announce(t('walletBuilding'));
        await shareFromDevice(session.sub, r.consent_id, req.claims.map((c) => c.name), req.audience ?? req.client.id, req.nonce ?? '');
      }
      announce(t(approve ? 'consentApproved' : 'consentDenied', { org: b(req.client.name) }));
      navigate(r.redirect);
    } catch (e) {
      setErrors([e instanceof NoDeviceKeyHere ? t('walletKeyElsewhere') : e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'AbortError') ? t('passkeyCancelled') : errorText(e)]);
      setBusy(false);
    }
  };

  if (!req) {
    return (
      <>
        <PageTitle text={t('loading')} />
        <ErrorSummary title={t('errorTitle')} messages={errors} />
        {!errors.length && <Loading />}
      </>
    );
  }

  const org = b(req.client.name);
  return (
    <>
      <PageTitle text={t('consentTitle', { org })} />
      <ErrorSummary title={t('errorTitle')} messages={errors} />

      {req.status !== 'pending' ? (
        <p className="notice">{t('consentNotPending', { status: req.status })}</p>
      ) : (
        <div className="consent-card">
          <p className="lead"><strong>{t('consentPurpose')}</strong> {b(req.purpose.label)}</p>

          <section aria-labelledby="will-h">
            <h2 id="will-h">{t('consentWillGet')}</h2>
            <ul className="claim-list">
              {req.claims.map((c) => (
                <li key={c.name}>
                  <strong>{b(c.label)}</strong>
                  {c.derived && <span className="badge badge-info">{t('consentProofOnly')}</span>}
                  <br /><span>{b(c.description)}</span>
                </li>
              ))}
            </ul>
          </section>

          {req.not_requested.length > 0 && (
            <section aria-labelledby="wont-h">
              <h2 id="wont-h">{t('consentWontGet')}</h2>
              <ul className="claim-list claim-list-negative">
                {req.not_requested.map((c) => <li key={c.name}>{b(c.label)}</li>)}
              </ul>
            </section>
          )}

          {req.regulator && <p className="check-ok">{t('consentRegulatorOk', { reg: b(req.regulator) })}</p>}
          <p>{t('consentValidity', { n: req.validity_days })}</p>

          <div className="actions" role="group" aria-label={t('consentDecisionLegend')}>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => decide(true)}>{t('consentApprove')}</button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => decide(false)}>{t('consentDeny')}</button>
          </div>
        </div>
      )}
    </>
  );
}
