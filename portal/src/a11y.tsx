// Accessibility building blocks shared by every page.
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useI18n } from './i18n.tsx';

// ---------- Live-region announcer ----------
// Two regions exist from the first render (screen readers ignore regions inserted later).
type Politeness = 'polite' | 'assertive';
const AnnounceCtx = createContext<(msg: string, p?: Politeness) => void>(() => {});

export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');
  const announce = useCallback((msg: string, p: Politeness = 'polite') => {
    const set = p === 'assertive' ? setAssertive : setPolite;
    set('');
    // Clearing first makes repeated identical messages announce again.
    window.setTimeout(() => set(msg), 60);
  }, []);
  return (
    <AnnounceCtx.Provider value={announce}>
      {children}
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{polite}</div>
      <div className="visually-hidden" role="alert" aria-live="assertive" aria-atomic="true">{assertive}</div>
    </AnnounceCtx.Provider>
  );
}

export const useAnnounce = () => useContext(AnnounceCtx);

// ---------- Page title + focus management on navigation ----------
let firstPage = true;

/** Renders the page <h1>, sets document.title, and moves focus to it after client-side navigation. */
export function PageTitle({ children, text }: { children?: ReactNode; text: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  const { t } = useI18n();
  useEffect(() => {
    document.title = `${text} — ${t('country')}`;
  }, [text, t]);
  useEffect(() => {
    if (firstPage) { firstPage = false; return; }
    ref.current?.focus();
  }, []);
  return <h1 ref={ref} tabIndex={-1} className="page-title">{children ?? text}</h1>;
}

// ---------- Error summary (focused and announced when it appears) ----------
/** A summary item: plain text (a problem with the whole form), or a problem with one field (a link to it). */
export type ErrorItem = string | { field: string; text: string };

/** Field errors {control id → message} as summary items "Label: message" (the summary sorts them into form order). */
export const fieldItems = (fe: Record<string, string | undefined>, label: (k: string) => string, idOf: (k: string) => string = (k) => k): ErrorItem[] =>
  Object.entries(fe).filter(([, m]) => m).map(([k, m]) => ({ field: idOf(k), text: `${label(k)}: ${m}` }));

/** The control for a field id: the element itself, the first control inside it (fieldset), or the first control named so (radio groups). */
function fieldElement(id: string): HTMLElement | null {
  const el = document.getElementById(id);
  const focusable = 'input:not([type=hidden]), select, textarea, button';
  if (el && el.matches(focusable)) return el;
  return (el?.querySelector<HTMLElement>(focusable)) ?? document.querySelector<HTMLElement>(`[name="${CSS.escape(id)}"]`) ?? el;
}

export function focusField(id: string) {
  const el = fieldElement(id);
  if (!el) return;
  el.focus();
  el.scrollIntoView?.({ block: 'center' });
}

export function ErrorSummary({ title, messages }: { title: string; messages: ErrorItem[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const key = messages.map((m) => (typeof m === 'string' ? m : `${m.field}:${m.text}`)).join('|');
  useEffect(() => { if (messages.length) ref.current?.focus(); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!messages.length) return null;
  // Whole-form problems first, then field problems in the order the fields appear in the form.
  const general = messages.filter((m): m is string => typeof m === 'string');
  const pos = (f: string) => fieldElement(f);
  const fields = messages.filter((m): m is { field: string; text: string } => typeof m !== 'string').sort((a, b) => {
    const ea = pos(a.field); const eb = pos(b.field);
    if (!ea || !eb) return ea ? -1 : eb ? 1 : 0;
    return ea === eb ? 0 : ea.compareDocumentPosition(eb) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
  return (
    <div ref={ref} className="error-summary" role="alert" tabIndex={-1}>
      <h2 className="error-summary-title">{title}</h2>
      <ul>
        {general.map((m) => <li key={m}>{m}</li>)}
        {fields.map((m) => (
          <li key={`${m.field}:${m.text}`}>
            <a href={`#${m.field}`} onClick={(e) => { e.preventDefault(); focusField(m.field); }}>{m.text}</a>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- Scrollable table wrapper (keyboard-scrollable, labelled by its caption) ----------
// role=group (not region) so it doesn't duplicate the enclosing section's landmark.
export function TableRegion({ caption, children, visuallyHiddenCaption = false }: { caption: string; children: ReactNode; visuallyHiddenCaption?: boolean }) {
  const id = useId();
  return (
    <div className="table-region" role="group" aria-labelledby={id} tabIndex={0}>
      <table>
        <caption id={id} className={visuallyHiddenCaption ? 'visually-hidden' : undefined}>{caption}</caption>
        {children}
      </table>
    </div>
  );
}

/** Loading indicator that is announced once. */
export function Loading() {
  const { t } = useI18n();
  return <p className="loading" role="status">{t('loading')}</p>;
}
