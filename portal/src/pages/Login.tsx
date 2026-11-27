import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { api } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { ErrorSummary, fieldItems, type ErrorItem, PageTitle, useAnnounce } from '../a11y.tsx';
import { useErrorText, useSession, type Session } from '../session.tsx';

interface DemoAccount { username: string; name: { ar: string; en: string }; note: { ar: string; en: string } }

export function Login() {
  const { t, b } = useI18n();
  const announce = useAnnounce();
  const errorText = useErrorText();
  const { refresh } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [step, setStep] = useState<'password' | 'otp'>('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [challenge, setChallenge] = useState('');
  const [errors, setErrors] = useState<ErrorItem[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState<{ password: string; accounts: DemoAccount[] } | null>(null);
  const otpRef = useRef<HTMLInputElement>(null);

  // Only a local demo (DEMO_MODE=true) lists the demo accounts; production has no such endpoint at all.
  useEffect(() => { api<{ demo_mode: boolean }>('/api/identity/portal-config').then((c) => (c.demo_mode ? api('/api/identity/demo-accounts').then(setDemo) : null)).catch(() => {}); }, []);
  useEffect(() => { if (step === 'otp') otpRef.current?.focus(); }, [step]);

  const finish = async (session: Session) => {
    await refresh();
    announce(t('loginSuccess'));
    const next = params.get('next');
    navigate(next && next.startsWith('/') && !next.startsWith('//') ? next : session.role === 'admin' ? '/admin' : session.role === 'employee' ? '/counter' : '/citizen', { replace: true });
  };

  const onPasskey = async () => {
    setErrors([]);
    setBusy(true);
    try {
      const { challenge_id, options } = await api('/api/identity/auth/passkey/options', { method: 'POST', body: {} });
      const response = await startAuthentication({ optionsJSON: options });
      const r = await api<{ session: Session }>('/api/identity/auth/passkey/verify', { body: { challenge_id, response } });
      await finish(r.session);
    } catch (e) {
      setErrors([e instanceof Error && e.name === 'NotAllowedError' ? t('loginPasskeyNone') : errorText(e)]);
    } finally {
      setBusy(false);
    }
  };

  const onPassword = async (e: FormEvent) => {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (!username.trim()) fe.username = t('errRequired');
    if (!password) fe.password = t('errRequired');
    setFieldErrors(fe);
    const msgs = fieldItems(fe, (k) => t(k === 'username' ? 'loginUsername' : 'loginPassword'));
    if (msgs.length) { setErrors(msgs); return; }
    setErrors([]);
    setBusy(true);
    try {
      const r = await api<{ otp_challenge_id: string }>('/api/identity/auth/password', { body: { username: username.trim(), password } });
      setChallenge(r.otp_challenge_id);
      setStep('otp');
      announce(t('loginTelegramHelp'));
    } catch (err) {
      setErrors([errorText(err)]);
    } finally {
      setBusy(false);
    }
  };

  const onOtp = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(otp)) { setFieldErrors({ otp: t('errOtpFormat') }); setErrors([{ field: 'otp', text: `${t('loginTelegram')}: ${t('errOtpFormat')}` }]); return; }
    setFieldErrors({});
    setErrors([]);
    setBusy(true);
    try {
      const r = await api<{ session: Session }>('/api/identity/auth/otp', { body: { otp_challenge_id: challenge, code: otp } });
      await finish(r.session);
    } catch (err) {
      setErrors([errorText(err)]);
    } finally {
      setBusy(false);
    }
  };

  const startOver = () => { setStep('password'); setOtp(''); setErrors([]); setFieldErrors({}); };

  return (
    <>
      <PageTitle text={t('loginTitle')} />
      <ErrorSummary title={t('errorTitle')} messages={errors} />

      <div className="two-col">
        <section aria-labelledby="pk-h" className="panel">
          <h2 id="pk-h">{t('loginPasskeyHeading')}</h2>
          <p>{t('loginPasskeyHelp')}</p>
          {browserSupportsWebAuthn() ? (
            <button type="button" className="btn btn-primary" onClick={onPasskey} disabled={busy}>
              {t('loginPasskeyButton')}
            </button>
          ) : (
            <p className="note">{t('loginPasskeyUnsupported')}</p>
          )}
        </section>

        <section aria-labelledby="pw-h" className="panel">
          <h2 id="pw-h">{step === 'password' ? t('loginFallbackHeading') : t('loginOtpHeading')}</h2>
          {step === 'password' ? (
            <form onSubmit={onPassword} noValidate>
              <div className="field">
                <label htmlFor="username">{t('loginUsername')}</label>
                <p id="username-hint" className="hint">{t('loginUsernameHint')}</p>
                {fieldErrors.username && <p id="username-err" className="field-error">{fieldErrors.username}</p>}
                <input
                  id="username" name="username" autoComplete="username" dir="ltr" required
                  value={username} onChange={(e) => setUsername(e.target.value)}
                  aria-invalid={!!fieldErrors.username}
                  aria-describedby={`username-hint${fieldErrors.username ? ' username-err' : ''}`}
                />
              </div>
              <div className="field">
                <label htmlFor="password">{t('loginPassword')}</label>
                {fieldErrors.password && <p id="password-err" className="field-error">{fieldErrors.password}</p>}
                <input
                  id="password" name="password" type="password" autoComplete="current-password" dir="ltr" required
                  value={password} onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={!!fieldErrors.password}
                  aria-describedby={fieldErrors.password ? 'password-err' : undefined}
                />
              </div>
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('working') : t('loginContinue')}</button>
            </form>
          ) : (
            <form onSubmit={onOtp} noValidate>
              <p>{t('loginTelegramHelp')}</p>
              <div className="field">
                <label htmlFor="otp">{t('loginTelegram')}</label>
                {fieldErrors.otp && <p id="otp-err" className="field-error">{fieldErrors.otp}</p>}
                <input
                  ref={otpRef} id="otp" name="otp" inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={6} required
                  value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                  aria-invalid={!!fieldErrors.otp} aria-describedby={fieldErrors.otp ? 'otp-err' : undefined}
                />
              </div>
              <div className="actions">
                <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('working') : t('loginVerify')}</button>
                <button type="button" className="btn btn-secondary" onClick={startOver}>{t('loginStartOver')}</button>
              </div>
            </form>
          )}
        </section>
      </div>

      <section aria-labelledby="new-h" className="panel activate-panel">
        <h2 id="new-h">{t('loginNewHeading')}</h2>
        <p>{t('loginNewHelp')}</p>
        <Link to="/activate" className="btn btn-primary">{t('loginActivateLink')}</Link>
      </section>

      {demo && (
        <details className="demo-accounts">
          <summary>{t('loginDemoAccounts')}</summary>
          <p>{t('loginDemoPassword')} <code dir="ltr">{demo.password}</code></p>
          <ul>
            {demo.accounts.map((a) => (
              <li key={a.username}>
                <code dir="ltr">{a.username}</code> — {b(a.name)}: {b(a.note)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
