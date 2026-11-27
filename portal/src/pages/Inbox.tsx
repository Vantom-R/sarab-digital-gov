import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api.ts';
import { useI18n, type Bi } from '../i18n.tsx';
import { ErrorSummary, type ErrorItem, Loading, PageTitle } from '../a11y.tsx';
import { useErrorText } from '../session.tsx';

interface Note { id: number; type: string; title: Bi; body: Bi; link: string | null; created_at: string; read_at: string | null }

export function Inbox() {
  const { t, b, fmtDate } = useI18n();
  const errorText = useErrorText();
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [errors, setErrors] = useState<ErrorItem[]>([]);
  useEffect(() => {
    // Show what was unread on arrival, then mark everything read.
    api<{ notifications: Note[] }>('/api/identity/me/notifications')
      .then((r) => { setNotes(r.notifications); return api('/api/identity/me/notifications/read', { body: {} }); })
      .catch((e) => setErrors([errorText(e)]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <PageTitle text={t('inboxTitle')} />
      <ErrorSummary title={t('errorTitle')} messages={errors} />
      <p>{t('inboxHelp')}</p>
      {!notes ? <Loading /> : notes.length === 0 ? <p>{t('inboxEmpty')}</p> : (
        <ol className="inbox" reversed>
          {notes.map((n) => (
            <li key={n.id} className={`inbox-item${n.read_at ? '' : ' inbox-unread'}`}>
              <h2 className="inbox-title">
                {!n.read_at && <span className="badge badge-info">{t('inboxNew')}</span>} {b(n.title)}
              </h2>
              <p>{b(n.body)}</p>
              <p className="muted">
                <time dateTime={n.created_at}>{fmtDate(n.created_at, true)}</time>
                {n.link && <> — <Link to={n.link}>{t('inboxOpen')}<span className="visually-hidden">: {b(n.title)}</span></Link></>}
              </p>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
