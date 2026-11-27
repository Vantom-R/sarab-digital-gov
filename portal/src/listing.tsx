// Long staff lists (audit log, service-centre actions): filters, 20 rows per page, and plain result labels.
// Built for screen readers: one short form, a status line saying what is shown, and a pager whose buttons
// never vanish under the keyboard focus (aria-disabled instead of disabled).
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { api } from './api.ts';
import { useI18n } from './i18n.tsx';
import { useAnnounce } from './a11y.tsx';

export const PAGE_SIZE = 20;

export interface FilterField {
  key: string; label: string; type: 'date' | 'text' | 'select';
  options?: { value: string; label: string }[]; hint?: string; numeric?: boolean;
}

/** Loads one page of `url` with the applied filters. The response carries `total` and the rows under `itemsKey`. */
export function useListing<T>(url: string, itemsKey: string) {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: T[]; total: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    const q = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) });
    for (const [k, v] of Object.entries(filters)) if (v.trim()) q.set(k, v.trim());
    const r = await api<Record<string, unknown>>(`${url}?${q}`);
    setData({ items: (r[itemsKey] as T[]) ?? [], total: Number(r.total ?? 0) });
    setError(null);
  }, [url, itemsKey, filters, page]);
  useEffect(() => { load().catch(setError); }, [load]);
  return { data, error, page, setPage, filters, apply: (f: Record<string, string>) => { setFilters(f); setPage(1); }, reload: load };
}

/** The filter form. Applying it goes back to page 1; "Clear" removes every filter. */
export function Filters({ fields, value, onApply }: { fields: FilterField[]; value: Record<string, string>; onApply: (f: Record<string, string>) => void }) {
  const { t } = useI18n();
  const id = useId();
  const [draft, setDraft] = useState<Record<string, string>>(value);
  useEffect(() => { setDraft(value); }, [value]);
  const submit = (e: FormEvent) => { e.preventDefault(); onApply(draft); };
  const active = Object.values(value).filter((v) => v.trim()).length;
  return (
    <form className="filters" onSubmit={submit} noValidate aria-labelledby={`${id}-legend`}>
      <fieldset>
        <legend id={`${id}-legend`}>{t('filterLegend')}{active ? ` (${t('filterActive', { n: String(active) })})` : ''}</legend>
        <div className="filter-fields">
          {fields.map((f) => {
            const fid = `${id}-${f.key}`;
            return (
              <div className="field" key={f.key}>
                <label htmlFor={fid}>{f.label}</label>
                {f.hint && <p id={`${fid}-hint`} className="hint">{f.hint}</p>}
                {f.type === 'select' ? (
                  <select id={fid} value={draft[f.key] ?? ''} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}>
                    <option value="">{t('filterAny')}</option>
                    {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : (
                  <input id={fid} type={f.type} dir="ltr" autoComplete="off" inputMode={f.numeric ? 'numeric' : undefined} maxLength={f.type === 'text' ? 20 : undefined}
                    value={draft[f.key] ?? ''} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} aria-describedby={f.hint ? `${fid}-hint` : undefined} />
                )}
              </div>
            );
          })}
        </div>
        <div className="actions">
          <button type="submit" className="btn btn-primary btn-small">{t('filterApply')}</button>
          <button type="button" className="btn btn-secondary btn-small" onClick={() => { setDraft({}); onApply({}); }}>{t('filterClear')}</button>
        </div>
      </fieldset>
    </form>
  );
}

/** "Showing 21–40 of 134" plus Previous / Next. Announces the new range after a page change. */
export function Pager({ page, total, onPage, label, below = false }: { page: number; total: number; onPage: (p: number) => void; label: string; below?: boolean }) {
  const { t } = useI18n();
  const announce = useAnnounce();
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const to = Math.min(total, page * PAGE_SIZE);
  const go = (p: number) => {
    if (p < 1 || p > pages) return;
    onPage(p);
    announce(t('pagerShowing', { from: String((p - 1) * PAGE_SIZE + 1), to: String(Math.min(total, p * PAGE_SIZE)), total: String(total) }));
  };
  return (
    <nav className="pager" aria-label={`${t(below ? 'pagerLabelBelow' : 'pagerLabel')}: ${label}`}>
      <p className="pager-status">{t('pagerShowing', { from: String(from), to: String(to), total: String(total) })} · {t('pagerPage', { page: String(page), pages: String(pages) })}</p>
      {pages > 1 && (
        <div className="actions">
          <button type="button" className="btn btn-secondary btn-small" aria-disabled={page <= 1} onClick={() => go(page - 1)}>{t('pagerPrev')}</button>
          <button type="button" className="btn btn-secondary btn-small" aria-disabled={page >= pages} onClick={() => go(page + 1)}>{t('pagerNext')}</button>
        </div>
      )}
    </nav>
  );
}

/** How an exchange ended, in words people use. "Denied" is kept for real policy refusals. */
export type ResultClass = 'allowed' | 'no_record' | 'failed' | 'denied';
export const resultClass = (decision: string, status: number | null): ResultClass =>
  decision !== 'allow' ? 'denied' : (status ?? 0) < 400 ? 'allowed' : status === 404 ? 'no_record' : 'failed';

export function ResultBadge({ decision, status, reason, showCode = false }: { decision: string; status: number | null; reason?: string | null; showCode?: boolean }) {
  const { t } = useI18n();
  const c = resultClass(decision, status);
  const cls = { allowed: 'badge-ok', no_record: 'badge-muted', failed: 'badge-info', denied: 'badge-bad' }[c];
  const text = { allowed: t('resultAllowed'), no_record: t('resultNoRecord'), failed: t('resultFailed'), denied: t('resultDenied') }[c];
  return (
    <>
      <span className={`badge ${cls}`} title={reason ?? undefined}>{text}{showCode && status ? ` ${status}` : ''}</span>
      {c === 'no_record' && <span className="visually-hidden">: {t('resultNoRecordHelp')}</span>}
      {reason && <span className="visually-hidden">: {reason}</span>}
    </>
  );
}

/** Staff IDs that belong to the automated tests, not to a person. */
export const isAutomatedStaff = (id: string | null | undefined) => !!id && /(^|:)TEST-\d+$/.test(id);

export function AutomatedBadge() {
  const { t } = useI18n();
  return <span className="badge badge-info">{t('automatedBadge')}</span>;
}
