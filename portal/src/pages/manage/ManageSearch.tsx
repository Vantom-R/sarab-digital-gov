// Manage citizen — step 1: find the person (national ID or name). The search is a Civil Registry
// look-up through Jisr in the employee's name; a search by ID shows in that citizen's "who accessed my data".
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, ApiError } from '../../api.ts';
import { useI18n, type Bi } from '../../i18n.tsx';
import { ErrorSummary, type ErrorItem, PageTitle, TableRegion, useAnnounce } from '../../a11y.tsx';
import { useErrorText } from '../../session.tsx';
import { useProblemText } from './common.tsx';

interface Result { national_id: string; name: Bi; birth_date: string; gender: string; status: string }

export function ManageSearch() {
  const { t, b, fmtDate } = useI18n();
  const announce = useAnnounce();
  const errorText = useErrorText();
  const problemText = useProblemText();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [results, setResults] = useState<Result[] | null>(null);
  const [errors, setErrors] = useState<ErrorItem[]>([]);
  const [fieldError, setFieldError] = useState('');
  const [busy, setBusy] = useState(false);
  const resultsH = useRef<HTMLHeadingElement>(null);

  const search = async (query: string, focus = true) => {
    setErrors([]); setFieldError('');
    const v = query.trim();
    const msg = !v ? t('errRequired') : /^\d+$/.test(v) && v.length !== 10 ? t('mg_err_invalid_id') : !/^\d+$/.test(v) && v.length < 2 ? t('mg_err_too_short') : '';
    if (msg) { setFieldError(msg); setErrors([{ field: 'mg-q', text: `${t('mg_search_label')}: ${msg}` }]); return; }
    setBusy(true);
    try {
      const r = await api<{ results: Result[] }>(`/api/identity/manage/search?q=${encodeURIComponent(v)}`);
      setResults(r.results);
      setParams({ q: v }, { replace: true });
      announce(t('mg_results_count', { n: String(r.results.length) }));
      if (focus) window.setTimeout(() => resultsH.current?.focus(), 60);
    } catch (e) {
      const code = e instanceof ApiError ? (e.details as any)?.problems?.[0]?.code : null;
      if (code) { setFieldError(problemText(code)); setErrors([{ field: 'mg-q', text: `${t('mg_search_label')}: ${problemText(code)}` }]); } else setErrors([errorText(e)]);
    } finally { setBusy(false); }
  };
  useEffect(() => { if (params.get('q')) search(params.get('q')!, false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onSubmit = (e: FormEvent) => { e.preventDefault(); search(q); };

  return (
    <>
      <PageTitle text={t('mg_title')} />
      <p className="lead">{t('mg_intro')}</p>
      <p className="note" role="note">{t('mg_rules')}</p>
      <ErrorSummary title={t('errorTitle')} messages={errors} />
      <section aria-labelledby="mg-search-h" className="panel">
        <h2 id="mg-search-h">{t('mg_search_heading')}</h2>
        <form onSubmit={onSubmit} noValidate role="search" aria-labelledby="mg-search-h">
          <div className="field">
            <label htmlFor="mg-q">{t('mg_search_label')}</label>
            <p id="mg-q-hint" className="hint">{t('mg_search_hint')}</p>
            {fieldError && <p id="mg-q-err" className="field-error">{fieldError}</p>}
            <input id="mg-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} maxLength={40} autoComplete="off"
              aria-invalid={!!fieldError} aria-describedby={`mg-q-hint${fieldError ? ' mg-q-err' : ''}`} />
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('working') : t('mg_search_button')}</button>
        </form>
      </section>
      {results && (
        <section aria-labelledby="mg-results-h" className="panel">
          <h2 id="mg-results-h" ref={resultsH} tabIndex={-1}>{t('mg_results_count', { n: String(results.length) })}</h2>
          {results.length === 0 ? <p>{t('mg_no_results')}</p> : (
            <TableRegion caption={t('mg_results')} visuallyHiddenCaption>
              <thead><tr><th scope="col">{t('mg_col_name')}</th><th scope="col">{t('fieldNationalId')}</th><th scope="col">{t('fieldBirthDate')}</th><th scope="col">{t('reg_col_action')}</th></tr></thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.national_id}>
                    <th scope="row">{b(r.name)}</th>
                    <td dir="ltr">{r.national_id}</td>
                    <td>{fmtDate(r.birth_date)}</td>
                    <td><Link to={`/manage/${r.national_id}`} state={{ name: r.name }} aria-label={t('mg_open_person', { name: b(r.name) })}>{t('mg_open')}</Link></td>
                  </tr>
                ))}
              </tbody>
            </TableRegion>
          )}
        </section>
      )}
    </>
  );
}
