// First-time activation for a citizen registered by a registrar:
//   1. national ID + one-time activation code  2. choose a password (→ signed in)  3. add a passkey.
// A visible step list (aria-current="step") tells screen-reader users where they are; focus moves to
// each step's heading; errors are summarised, focused and tied to their fields.
// The link in the activation message opens /activate?nid=<national ID>: the ID is pre-filled (and the field
// says so), so the citizen types only the code. The code itself is never put in a URL.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import { api } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { ErrorSummary, fieldItems, type ErrorItem, PageTitle, useAnnounce } from '../a11y.tsx';
import { useErrorText, useSession } from '../session.tsx';

type Step = 'code' | 'password' | 'passkey';
const STEPS: Step[] = ['code', 'password', 'passkey'];

export function Activate() {
  const { t } = useI18n();
  const announce = useAnnounce();
  const errorText = useErrorText();
  const { refresh } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const linkNid = /^\d{10}$/.test(params.get('nid') ?? '') ? params.get('nid')! : '';
  const [step, setStep] = useState<Step>('code');
  const [nid, setNid] = useState(linkNid);
  const [code, setCode] = useState('');
  const [token, setToken] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [nickname, setNickname] = useState('');
  const [errors, setErrors] = useState<ErrorItem[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [passkeyAdded, setPasskeyAdded] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);

  useEffect(() => { if (first.current) { first.current = false; return; } heading.current?.focus(); }, [step]);

  const fail = (fe: Record<string, string>, labels: Record<string, string>) => {
    setFieldErrors(fe);
    setErrors(fieldItems(fe, (k) => labels[k] ?? k, (k) => `act-${k}`));
  };

  const onCode = async (e: FormEvent) => {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (!/^\d{10}$/.test(nid.trim())) fe.nid = t('actErrNid');
    if (code.replace(/\D/g, '').length !== 8) fe.code = t('actErrCode');
    if (Object.keys(fe).length) return fail(fe, { nid: t('actNid'), code: t('actCode') });
    setFieldErrors({}); setErrors([]); setBusy(true);
    try {
      const r = await api<{ activation_token: string }>('/api/identity/auth/activation/verify', { body: { national_id: nid.trim(), code } });
      setToken(r.activation_token); setStep('password');
      announce(t('actCodeOk'));
    } catch (err) {
      // A refused code is also marked on the code field, so screen readers say "invalid" there.
      const c = (err as any)?.code as string | undefined;
      if (c?.startsWith('activation_')) { setFieldErrors({ code: errorText(err) }); setErrors([{ field: 'act-code', text: `${t('actCode')}: ${errorText(err)}` }]); }
      else setErrors([errorText(err)]);
    } finally { setBusy(false); }
  };

  const onPassword = async (e: FormEvent) => {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (pw.length < 10) fe.pw = t('err_password_too_short');
    else if (pw.includes(nid.trim())) fe.pw = t('err_password_contains_id');
    if (pw2 !== pw) fe.pw2 = t('actErrMismatch');
    if (Object.keys(fe).length) return fail(fe, { pw: t('actPassword'), pw2: t('actPassword2') });
    setFieldErrors({}); setErrors([]); setBusy(true);
    try {
      await api('/api/identity/auth/activation/complete', { body: { activation_token: token, password: pw } });
      await refresh();
      setPw(''); setPw2(''); setStep('passkey');
      announce(t('actActivated'));
    } catch (err) {
      setErrors([errorText(err)]);
      if (err && (err as any).code === 'activation_expired') setStep('code');
    } finally { setBusy(false); }
  };

  const onPasskey = async () => {
    setErrors([]); setBusy(true);
    try {
      const { challenge_id, options } = await api('/api/identity/me/passkeys/options', { method: 'POST', body: {} });
      const response = await startRegistration({ optionsJSON: options });
      await api('/api/identity/me/passkeys', { body: { challenge_id, response, nickname: nickname.trim() || undefined } });
      setPasskeyAdded(true);
      announce(t('passkeyAdded'));
    } catch (e) {
      if (e instanceof Error && ['NotAllowedError', 'InvalidStateError', 'SecurityError'].includes(e.name)) setErrors([t('passkeyCancelled')]);
      else setErrors([errorText(e)]);
    } finally { setBusy(false); }
  };

  const desc = (k: string, hint?: string) => [hint, fieldErrors[k] ? `${k}-err` : ''].filter(Boolean).join(' ') || undefined;
  const stepNo = STEPS.indexOf(step) + 1;

  return (
    <>
      <PageTitle text={t('actTitle')} />
      <p className="lead">{t('actIntro')}</p>
      <ol className="activate-steps" aria-label={t('actProgress')}>
        {STEPS.map((s, i) => (
          <li key={s} aria-current={s === step ? 'step' : undefined}>
            {t(`actStep_${s}` as 'actStep_code')}{i + 1 < stepNo ? ` — ${t('actStepDone')}` : ''}
          </li>
        ))}
      </ol>
      <ErrorSummary title={t('errorTitle')} messages={errors} />

      <section className="panel" aria-labelledby="act-h">
        <h2 id="act-h" ref={heading} tabIndex={-1}>{t('actStepOf', { n: String(stepNo), total: String(STEPS.length) })} {t(`actStep_${step}` as 'actStep_code')}</h2>

        {step === 'code' && (
          <form onSubmit={onCode} noValidate>
            <div className="field">
              <label htmlFor="act-nid">{t('actNid')}</label>
              <p id="act-nid-hint" className="hint">{linkNid && nid === linkNid ? t('actNidFromLink') : t('actNidHint')}</p>
              {fieldErrors.nid && <p id="nid-err" className="field-error">{fieldErrors.nid}</p>}
              <input id="act-nid" inputMode="numeric" autoComplete="username" dir="ltr" maxLength={10} value={nid} onChange={(e) => setNid(e.target.value)}
                aria-invalid={!!fieldErrors.nid} aria-describedby={desc('nid', 'act-nid-hint')} />
            </div>
            <div className="field">
              <label htmlFor="act-code">{t('actCode')}</label>
              <p id="act-code-hint" className="hint">{t('actCodeHint')}</p>
              {fieldErrors.code && <p id="code-err" className="field-error">{fieldErrors.code}</p>}
              <input id="act-code" inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={9} value={code} onChange={(e) => setCode(e.target.value)}
                aria-invalid={!!fieldErrors.code} aria-describedby={desc('code', 'act-code-hint')} />
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('working') : t('actContinue')}</button>
          </form>
        )}

        {step === 'password' && (
          <form onSubmit={onPassword} noValidate>
            {/* Hidden username so password managers save the right account. */}
            <input type="text" name="username" autoComplete="username" value={nid} readOnly hidden />
            <div className="field">
              <label htmlFor="act-pw">{t('actPassword')}</label>
              <p id="act-pw-hint" className="hint">{t('actPasswordHint')}</p>
              {fieldErrors.pw && <p id="pw-err" className="field-error">{fieldErrors.pw}</p>}
              <input id="act-pw" type="password" autoComplete="new-password" dir="ltr" value={pw} onChange={(e) => setPw(e.target.value)}
                aria-invalid={!!fieldErrors.pw} aria-describedby={desc('pw', 'act-pw-hint')} />
            </div>
            <div className="field">
              <label htmlFor="act-pw2">{t('actPassword2')}</label>
              {fieldErrors.pw2 && <p id="pw2-err" className="field-error">{fieldErrors.pw2}</p>}
              <input id="act-pw2" type="password" autoComplete="new-password" dir="ltr" value={pw2} onChange={(e) => setPw2(e.target.value)}
                aria-invalid={!!fieldErrors.pw2} aria-describedby={desc('pw2')} />
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('working') : t('actActivate')}</button>
          </form>
        )}

        {step === 'passkey' && (
          <>
            <p className="check-ok">{t('actActivated')}</p>
            <p>{t('actPasskeyHelp')}</p>
            {passkeyAdded ? (
              <p className="check-ok" role="status">{t('actPasskeyDone')}</p>
            ) : browserSupportsWebAuthn() ? (
              <>
                <div className="field">
                  <label htmlFor="act-nick">{t('passkeyNickname')}</label>
                  <input id="act-nick" maxLength={60} value={nickname} onChange={(e) => setNickname(e.target.value)} />
                </div>
                <button type="button" className="btn btn-primary" onClick={onPasskey} disabled={busy}>{t('actAddPasskey')}</button>
              </>
            ) : <p className="note">{t('loginPasskeyUnsupported')}</p>}
            <p><button type="button" className={passkeyAdded ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => navigate('/citizen')}>{passkeyAdded ? t('actGoToMithaq') : t('actLater')}</button></p>
          </>
        )}
      </section>
      {step === 'code' && <p><Link to="/login">{t('actHaveAccount')}</Link></p>}
    </>
  );
}
