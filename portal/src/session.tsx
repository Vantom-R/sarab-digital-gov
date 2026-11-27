import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from './api.ts';
import { hasKey, useI18n, type Bi } from './i18n.tsx';

export interface Session { sub: string; role: 'citizen' | 'employee' | 'admin'; name: Bi; amr: string[]; auth_time: number; exp?: number }

interface SessionCtx {
  session: Session | null;
  ready: boolean;
  refresh: () => Promise<Session | null>;
  /** "Stay signed in": extends the session on the server */
  extend: () => Promise<Session | null>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const r = await api<{ session: Session | null }>('/api/identity/whoami');
      setSession(r.session);
      return r.session;
    } catch {
      setSession(null);
      return null;
    } finally {
      setReady(true);
    }
  }, []);
  const extend = useCallback(async () => {
    try {
      const r = await api<{ session: Session }>('/api/identity/session/refresh', { body: {} });
      setSession(r.session);
      return r.session;
    } catch {
      setSession(null);
      return null;
    }
  }, []);
  const signOut = useCallback(async () => {
    await api('/api/identity/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    setSession(null);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const onRevoked = () => setSession(null);
    window.addEventListener('sarab:session-revoked', onRevoked);
    return () => window.removeEventListener('sarab:session-revoked', onRevoked);
  }, []);
  return <Ctx.Provider value={{ session, ready, refresh, extend, signOut }}>{children}</Ctx.Provider>;
}

export function useSession(): SessionCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('SessionProvider missing');
  return v;
}

/** Translate an API error into a user-facing message. */
export function useErrorText() {
  const { t } = useI18n();
  return (e: unknown) => {
    if (e instanceof ApiError) {
      const key = `err_${e.code}`;
      if (hasKey(key)) return t(key);
      return `${t('errorGeneric')} (${e.message})`;
    }
    return t('errorGeneric');
  };
}
