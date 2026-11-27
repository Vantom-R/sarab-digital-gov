// WCAG 2.2.1 (Timing Adjustable): warn before the session ends and let the user extend it.
// Two minutes before expiry an alert dialog appears and takes focus; "Stay signed in" extends the
// session on the server and returns focus to where the user was. If time runs out, the user is told.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useI18n } from './i18n.tsx';
import { useSession } from './session.tsx';
import { useAnnounce } from './a11y.tsx';

const WARN_SECONDS = 120;

export function SessionTimeout() {
  const { t } = useI18n();
  const { session, extend, signOut } = useSession();
  const announce = useAnnounce();
  const navigate = useNavigate();
  const [left, setLeft] = useState<number | null>(null);
  const [expired, setExpired] = useState(false);
  const stayRef = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const shown = left !== null && left <= WARN_SECONDS && left > 0;

  useEffect(() => {
    if (!session?.exp) { setLeft(null); return; }
    const tick = () => setLeft(Math.round(session.exp! - Date.now() / 1000));
    tick();
    const id = window.setInterval(tick, 5000);
    return () => window.clearInterval(id);
  }, [session?.exp]);

  useEffect(() => {
    if (shown && !returnTo.current) {
      returnTo.current = document.activeElement as HTMLElement | null;
      window.setTimeout(() => stayRef.current?.focus(), 30);
    }
  }, [shown]);

  useEffect(() => {
    if (left !== null && left <= 0 && session) {
      setExpired(true);
      void signOut();
      announce(t('sessionExpired'), 'assertive');
    }
  }, [left, session, signOut, announce, t]);

  if (expired) {
    return (
      <div className="session-dialog" role="alertdialog" aria-modal="false" aria-labelledby="st-exp-h">
        <h2 id="st-exp-h">{t('sessionExpired')}</h2>
        <button type="button" className="btn btn-primary" onClick={() => { setExpired(false); navigate('/login'); }}>{t('signIn')}</button>
      </div>
    );
  }
  if (!shown) return null;
  const minutes = Math.max(1, Math.ceil(left! / 60));
  return (
    <div className="session-dialog" role="alertdialog" aria-modal="false" aria-labelledby="st-h" aria-describedby="st-d">
      <h2 id="st-h">{t('sessionEnding')}</h2>
      <p id="st-d">{t('sessionEndingText', { n: minutes })}</p>
      <div className="actions">
        <button ref={stayRef} type="button" className="btn btn-primary" onClick={async () => {
          const s = await extend();
          announce(s ? t('sessionExtended') : t('sessionExpired'));
          returnTo.current?.focus?.();
          returnTo.current = null;
        }}>{t('sessionStay')}</button>
        <button type="button" className="btn btn-secondary" onClick={async () => { await signOut(); returnTo.current = null; navigate('/'); }}>{t('signOut')}</button>
      </div>
    </div>
  );
}
