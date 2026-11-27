import type { ReactNode } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { useI18n } from './i18n.tsx';
import { useSession, type Session } from './session.tsx';
import { Loading, PageTitle, useAnnounce } from './a11y.tsx';
import { Home } from './pages/Home.tsx';
import { NotFound } from './pages/NotFound.tsx';
import { Login } from './pages/Login.tsx';
import { Citizen } from './pages/Citizen.tsx';
import { Consent } from './pages/Consent.tsx';
import { Bank } from './pages/Bank.tsx';
import { BankCallback } from './pages/BankCallback.tsx';
import { Admin } from './pages/Admin.tsx';
import { Sign } from './pages/Sign.tsx';
import { CitizenLayout } from './pages/CitizenLayout.tsx';
import { Inbox } from './pages/Inbox.tsx';
import { LifeEvents } from './pages/LifeEvents.tsx';
import { Delegations } from './pages/Delegations.tsx';
import { Acting } from './pages/Acting.tsx';
import { Counter } from './pages/Counter.tsx';
import { Registry } from './pages/Registry.tsx';
import { BirthReport } from './pages/BirthReport.tsx';
import { Activate } from './pages/Activate.tsx';
import { ManageSearch } from './pages/manage/ManageSearch.tsx';
import { ManagePerson } from './pages/manage/ManagePerson.tsx';
import { ManageCivil } from './pages/manage/ManageCivil.tsx';
import { ManageEducation } from './pages/manage/ManageEducation.tsx';
import { ManageLabor } from './pages/manage/ManageLabor.tsx';
import { ManageProperty } from './pages/manage/ManageProperty.tsx';
import { ManageHealth } from './pages/manage/ManageHealth.tsx';
import { SessionTimeout } from './SessionTimeout.tsx';

/** Redirects to /login?next=… when there is no session with one of the given roles. */
export function RequireRole({ roles, children }: { roles: Session['role'][]; children: ReactNode }) {
  const { session, ready } = useSession();
  const location = useLocation();
  if (!ready) return <Loading />;
  if (!session || !roles.includes(session.role)) {
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  }
  return <>{children}</>;
}

function Header() {
  const { t, lang, setLang, b } = useI18n();
  const { session, signOut } = useSession();
  const announce = useAnnounce();
  const navigate = useNavigate();
  return (
    <header className="site-header">
      <div className="header-inner">
        <Link to="/" className="brand">
          <span className="brand-emblem" aria-hidden="true" />
          <span>
            <span className="brand-country">{t('country')}</span>
            <span className="brand-sub">{t('portalName')}</span>
          </span>
        </Link>
        <div className="header-tools">
          <button
            type="button"
            className="btn btn-ghost"
            lang={lang === 'ar' ? 'en' : 'ar'}
            aria-label={t('switchLangLabel')}
            onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}
          >
            {t('switchLang')}
          </button>
          {session ? (
            <>
              <span className="session-name">
                <span className="visually-hidden">{t('signedInAs')} </span>
                {b(session.name)}
              </span>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={async () => { await signOut(); announce(t('signedOut')); navigate('/'); }}
              >
                {t('signOut')}
              </button>
            </>
          ) : (
            <NavLink to="/login" className="btn btn-ghost">{t('signIn')}</NavLink>
          )}
        </div>
      </div>
      <nav aria-label={t('mainNav')} className="main-nav">
        <ul>
          <li><NavLink to="/" end>{t('navHome')}</NavLink></li>
          <li><NavLink to="/citizen">{t('navCitizen')}</NavLink></li>
          <li><NavLink to="/bank">{t('navBank')}</NavLink></li>
          <li><NavLink to="/counter">{t('navCounter')}</NavLink></li>
          <li><NavLink to="/registry">{t('navRegistry')}</NavLink></li>
          <li><NavLink to="/manage">{t('navManage')}</NavLink></li>
          <li><NavLink to="/births/report">{t('navBirthReport')}</NavLink></li>
          <li><NavLink to="/admin">{t('navAdmin')}</NavLink></li>
        </ul>
      </nav>
      <p className="demo-banner">{t('demoNotice')}</p>
    </header>
  );
}

export function App() {
  const { t } = useI18n();
  return (
    <>
      <a className="skip-link" href="#main">{t('skipToContent')}</a>
      <Header />
      <SessionTimeout />
      <main id="main" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/citizen" element={<RequireRole roles={['citizen']}><CitizenLayout /></RequireRole>}>
            <Route index element={<Citizen />} />
            <Route path="sign" element={<Sign />} />
            <Route path="inbox" element={<Inbox />} />
            <Route path="life-events" element={<LifeEvents />} />
            <Route path="delegations" element={<Delegations />} />
            <Route path="acting/:id" element={<Acting />} />
          </Route>
          <Route path="/consent/:id" element={<RequireRole roles={['citizen']}><Consent /></RequireRole>} />
          <Route path="/bank" element={<Bank />} />
          <Route path="/bank/callback" element={<BankCallback />} />
          {/* Staff tools: employees, and the administrator (who has every staff permission). */}
          <Route path="/counter" element={<RequireRole roles={['employee', 'admin']}><Counter /></RequireRole>} />
          <Route path="/registry" element={<RequireRole roles={['employee', 'admin']}><Registry /></RequireRole>} />
          <Route path="/births/report" element={<RequireRole roles={['employee', 'admin']}><BirthReport /></RequireRole>} />
          <Route path="/manage" element={<RequireRole roles={['employee', 'admin']}><ManageSearch /></RequireRole>} />
          <Route path="/manage/:id" element={<RequireRole roles={['employee', 'admin']}><ManagePerson /></RequireRole>} />
          <Route path="/manage/:id/civil" element={<RequireRole roles={['employee', 'admin']}><ManageCivil /></RequireRole>} />
          <Route path="/manage/:id/education" element={<RequireRole roles={['employee', 'admin']}><ManageEducation /></RequireRole>} />
          <Route path="/manage/:id/labor" element={<RequireRole roles={['employee', 'admin']}><ManageLabor /></RequireRole>} />
          <Route path="/manage/:id/property" element={<RequireRole roles={['employee', 'admin']}><ManageProperty /></RequireRole>} />
          <Route path="/manage/:id/health" element={<RequireRole roles={['employee', 'admin']}><ManageHealth /></RequireRole>} />
          <Route path="/activate" element={<Activate />} />
          <Route path="/admin" element={<RequireRole roles={['admin']}><Admin /></RequireRole>} />
          <Route path="/admin/:section" element={<RequireRole roles={['admin']}><Admin /></RequireRole>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <footer className="site-footer">
        <p>{t('footer')}</p>
        <p>
          {t('apiDocs')}:{' '}
          <a href="/api/identity/docs" lang="en">Mithaq</a>{' · '}
          <a href="/api/consent/docs" lang="en">Idhn</a>{' · '}
          <a href="/api/jisr/docs" lang="en">Jisr</a>{' · '}
          <a href="/api/registry/docs" lang="en">Civil Registry</a>{' · '}
          <a href="/api/bank/docs" lang="en">Bank Al-Waha</a>{' · '}
          <a href="/api/jisr/events" lang="en">Event-bus policy (JSON)</a>
        </p>
      </footer>
    </>
  );
}
