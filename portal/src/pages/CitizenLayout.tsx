// Shared frame for every citizen page: a sub-navigation (with unread count) above the page content.
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { api } from '../api.ts';
import { useI18n } from '../i18n.tsx';

export function CitizenLayout() {
  const { t } = useI18n();
  const location = useLocation();
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    api<{ unread: number }>('/api/identity/me/notifications').then((r) => setUnread(r.unread)).catch(() => {});
  }, [location.pathname]);
  return (
    <>
      <nav aria-label={t('citizenNav')} className="sub-nav">
        <ul>
          <li><NavLink to="/citizen" end>{t('navMyData')}</NavLink></li>
          <li><NavLink to="/citizen/inbox">{unread ? t('navInboxUnread', { n: unread }) : t('navInbox')}</NavLink></li>
          <li><NavLink to="/citizen/life-events">{t('navLifeEvents')}</NavLink></li>
          <li><NavLink to="/citizen/delegations">{t('navDelegations')}</NavLink></li>
          <li><NavLink to="/citizen/sign">{t('navSign')}</NavLink></li>
        </ul>
      </nav>
      <Outlet />
    </>
  );
}
