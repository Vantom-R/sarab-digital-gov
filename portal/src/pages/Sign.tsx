import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../api.ts';
import { useI18n, type Bi } from '../i18n.tsx';
import { ErrorSummary, type ErrorItem, PageTitle, TableRegion, useAnnounce } from '../a11y.tsx';
import { useErrorText, useSession } from '../session.tsx';
import { ceremony, keyStatus, NoDeviceKeyHere } from '../wallet.ts';

interface Signed { id: string; title: string; doc_sha256: string; jws: string; created_at: string }
interface VerifyResult { valid: boolean; reason: string | null; payload?: { signer: string; signer_name: Bi; signed_at: string; title: string } }

export function Sign() {
  const { t, b, fmtDate } = useI18n();
  const announce = useAnnounce();
  const errorText = useErrorText();
  const { session } = useSession();
  const [title, setTitle] = useState(() => t('signDefaultTitle'));
  const [content, setContent] = useState(() => t('signDefaultText'));
  const [jws, setJws] = useState('');
  const [verifyJws, setVerifyJws] = useState('');
  const [verifyContent, setVerifyContent] = useState('');
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [mine, setMine] = useState<Signed[]>([]);
  const [errors, setErrors] = useState<ErrorItem[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api<{ signatures: Signed[] }>('/api/identity/me/signatures').then((r) => setMine(r.signatures)), []);
  useEffect(() => { load().catch(() => {}); }, [load]);

  const onSign = async (e: FormEvent) => {
    e.preventDefault();
    setErrors([]);
    if (!title.trim() || !content.trim()) { setErrors([...(!title.trim() ? [{ field: 'doc-title', text: `${t('signDocTitle')}: ${t('errRequired')}` }] : []), ...(!content.trim() ? [{ field: 'doc-content', text: `${t('signDocContent')}: ${t('errRequired')}` }] : [])]); return; }
    setBusy(true);
    try {
      // Phase 6: sign on this device when the citizen's key lives here; otherwise Mithaq's cloud key signs.
      const r = (await keyStatus()).mode === 'device'
        ? await ceremony<{ jws: string }>(session!.sub, 'document', { title, content })
        : await api<{ jws: string }>('/api/identity/me/signatures', { body: { title, content } });
      setJws(r.jws);
      setVerifyJws(r.jws);
      setVerifyContent(content);
      await load();
      announce(t('signDone'));
    } catch (err) {
      setErrors([err instanceof NoDeviceKeyHere ? t('walletKeyElsewhere') : err instanceof Error && err.name === 'NotAllowedError' ? t('passkeyCancelled') : errorText(err)]);
    } finally {
      setBusy(false);
    }
  };

  const onVerify = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await api<VerifyResult>('/api/identity/signatures/verify', { body: { jws: verifyJws.trim(), content: verifyContent || undefined } });
      setVerifyResult(r);
      announce(r.valid && r.payload
        ? t('signValid', { name: b(r.payload.signer_name), id: r.payload.signer, date: fmtDate(r.payload.signed_at, true) })
        : t('signInvalid', { reason: r.reason ?? '' }), r.valid ? 'polite' : 'assertive');
    } catch (err) {
      setErrors([errorText(err)]);
    }
  };

  return (
    <>
      <PageTitle text={t('signTitle')} />
      <p>{t('signHelp')}</p>
      <ErrorSummary title={t('errorTitle')} messages={errors} />

      <section aria-labelledby="sign-h" className="panel">
        <h2 id="sign-h">{t('signButton')}</h2>
        <form onSubmit={onSign} noValidate>
          <div className="field">
            <label htmlFor="doc-title">{t('signDocTitle')}</label>
            <input id="doc-title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
          </div>
          <div className="field">
            <label htmlFor="doc-content">{t('signDocContent')}</label>
            <textarea id="doc-content" rows={5} value={content} onChange={(e) => setContent(e.target.value)} required />
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('working') : t('signButton')}</button>
        </form>
        {jws && (
          <div className="field">
            <label htmlFor="jws-out">{t('signResult')}</label>
            <textarea id="jws-out" rows={4} readOnly value={jws} dir="ltr" className="mono" />
          </div>
        )}
      </section>

      <section aria-labelledby="verify-h" className="panel">
        <h2 id="verify-h">{t('signVerifyHeading')}</h2>
        <form onSubmit={onVerify} noValidate>
          <div className="field">
            <label htmlFor="v-jws">{t('signResult')}</label>
            <textarea id="v-jws" rows={3} dir="ltr" className="mono" value={verifyJws} onChange={(e) => setVerifyJws(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="v-content">{t('signDocContent')}</label>
            <textarea id="v-content" rows={3} value={verifyContent} onChange={(e) => setVerifyContent(e.target.value)} />
          </div>
          <button type="submit" className="btn btn-secondary">{t('signVerifyButton')}</button>
        </form>
        {verifyResult && (
          <p className={verifyResult.valid ? 'check-ok' : 'check-bad'}>
            {verifyResult.valid && verifyResult.payload
              ? t('signValid', { name: b(verifyResult.payload.signer_name), id: verifyResult.payload.signer, date: fmtDate(verifyResult.payload.signed_at, true) })
              : t('signInvalid', { reason: verifyResult.reason ?? '' })}
          </p>
        )}
      </section>

      <section aria-labelledby="mine-h" className="panel">
        <h2 id="mine-h">{t('signMine')}</h2>
        {mine.length === 0 ? <p>{t('signNone')}</p> : (
          <TableRegion caption={t('signMine')} visuallyHiddenCaption>
            <thead><tr><th scope="col">{t('signDocTitle')}</th><th scope="col">{t('colWhen')}</th><th scope="col">SHA-256</th></tr></thead>
            <tbody>
              {mine.map((s) => (
                <tr key={s.id}><th scope="row">{s.title}</th><td>{fmtDate(s.created_at, true)}</td><td dir="ltr" className="mono">{s.doc_sha256.slice(0, 16)}…</td></tr>
              ))}
            </tbody>
          </TableRegion>
        )}
      </section>
      <p><Link to="/citizen">{t('navCitizen')}</Link></p>
    </>
  );
}
