import { Link } from 'react-router';
import { useI18n } from '../i18n.tsx';
import { PageTitle } from '../a11y.tsx';

export function Home() {
  const { t } = useI18n();
  return (
    <>
      <PageTitle text={t('homeTitle')} />
      <p className="lead">{t('homeIntro')}</p>

      <section aria-labelledby="views-h">
        <h2 id="views-h">{t('homeViews')}</h2>
        <ul className="card-list">
          <li className="card">
            <h3><Link to="/citizen">{t('navCitizen')}</Link></h3>
            <p>{t('homeCitizen')}</p>
          </li>
          <li className="card card-highlight">
            <h3><Link to="/bank">{t('navBank')}</Link></h3>
            <p>{t('homeBank')}</p>
          </li>
          <li className="card">
            <h3><Link to="/citizen/life-events">{t('navLifeEvents')}</Link></h3>
            <p>{t('homeLife')}</p>
          </li>
          <li className="card">
            <h3><Link to="/citizen/delegations">{t('navDelegations')}</Link></h3>
            <p>{t('homeDeleg')}</p>
          </li>
          <li className="card">
            <h3><Link to="/counter">{t('navCounter')}</Link></h3>
            <p>{t('homeCounter')}</p>
          </li>
          <li className="card">
            <h3><Link to="/registry">{t('navRegistry')}</Link></h3>
            <p>{t('homeRegistry')}</p>
          </li>
          <li className="card">
            <h3><Link to="/activate">{t('actTitle')}</Link></h3>
            <p>{t('homeActivate')}</p>
          </li>
          <li className="card">
            <h3><Link to="/admin">{t('navAdmin')}</Link></h3>
            <p>{t('homeAdmin')}</p>
          </li>
        </ul>
      </section>

      <section aria-labelledby="how-h">
        <h2 id="how-h">{t('homeHow')}</h2>
        <ul className="plain-list">
          <li>{t('homeHow1')}</li>
          <li>{t('homeHow2')}</li>
          <li>{t('homeHow3')}</li>
          <li>{t('homeHow4')}</li>
          <li>{t('homeHow5')}</li>
        </ul>
      </section>
    </>
  );
}
