// "Page not found": says what happened and offers the way back home.
import { Link } from 'react-router';
import { useI18n } from '../i18n.tsx';
import { PageTitle } from '../a11y.tsx';

export function NotFound() {
  const { t } = useI18n();
  return (
    <>
      <PageTitle text={t('notFoundTitle')} />
      <p className="lead">{t('notFoundHelp')}</p>
      <p><Link to="/" className="btn btn-primary">{t('notFoundHome')}</Link></p>
    </>
  );
}
