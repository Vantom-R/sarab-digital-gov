import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api.ts';
import { hasKey, useI18n, type Bi, type Key } from '../i18n.tsx';
import { ErrorSummary, type ErrorItem, Loading, PageTitle, TableRegion } from '../a11y.tsx';
import { useErrorText } from '../session.tsx';

interface Result {
  status: 'opened' | 'already_customer' | 'refused' | 'declined';
  account?: { number: string; name: Bi; city: Bi | null };
  received_claims?: Record<string, unknown>;
  not_received?: string[];
  inspection?: {
    credential: string; issuer: string; vct: string;
    issuer_header: any; issuer_payload: any; key_binding_header: any; key_binding_payload: any;
    disclosures: { encoded: string; decoded: { salt: string; name: string; value: unknown } }[];
    undisclosed_digests: number;
  }[];
}

// Claim labels for display (kept in the portal so the bank page can render without another call).
const LABELS: Record<string, Bi> = {
  national_id: { ar: 'رقم الهوية الوطنية', en: 'National ID number' },
  full_name: { ar: 'الاسم الكامل', en: 'Full name' },
  given_name: { ar: 'الاسم الأول', en: 'Given name' },
  family_name: { ar: 'اسم العائلة', en: 'Family name' },
  age_over_18: { ar: 'عمره 18 سنة أو أكثر', en: 'Is 18 or older' },
  age_over_21: { ar: 'عمره 21 سنة أو أكثر', en: 'Is 21 or older' },
  birth_date: { ar: 'تاريخ الميلاد', en: 'Date of birth' },
  nationality: { ar: 'الجنسية', en: 'Nationality' },
  gender: { ar: 'الجنس', en: 'Gender' },
  marital_status: { ar: 'الحالة الاجتماعية', en: 'Marital status' },
  address_city: { ar: 'مدينة السكن', en: 'City of residence' },
  address_full: { ar: 'العنوان الكامل', en: 'Full address' },
  employment_status: { ar: 'الحالة الوظيفية', en: 'Employment status' },
  employer_name: { ar: 'جهة العمل', en: 'Employer' },
  income_bracket: { ar: 'فئة الدخل الشهري', en: 'Monthly income bracket' },
  monthly_income: { ar: 'الراتب الشهري الدقيق', en: 'Exact monthly income' },
};
const ISSUERS: Record<string, Bi> = {
  mithaq: { ar: 'ميثاق — الهوية الرقمية', en: 'Mithaq — Digital Identity' },
  labor: { ar: 'وزارة العمل والتأمينات الاجتماعية', en: 'Ministry of Labor & Social Insurance' },
};

export function BankCallback() {
  const { t, b } = useI18n();
  const errorText = useErrorText();
  const [params] = useSearchParams();
  const [result, setResult] = useState<Result | null>(null);
  const [errors, setErrors] = useState<ErrorItem[]>([]);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // run once even under React StrictMode
    started.current = true;
    const body = { request_id: params.get('request') ?? '', consent_id: params.get('consent') ?? undefined, error: params.get('error') ?? undefined };
    api<Result>('/api/bank/onboarding/complete', { body }).then(setResult).catch((e) => setErrors([errorText(e)]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const show = (v: unknown, k?: string): string => {
    if (typeof v === 'boolean') return v ? t('yes') : t('no');
    if (k === 'employment_status' && typeof v === 'string' && hasKey(`emp_${v}`)) return t(`emp_${v}` as Key);
    if (v && typeof v === 'object' && 'ar' in (v as any)) return b(v as Bi);
    return String(v);
  };

  const title = !result ? t('loading')
    : result.status === 'opened' ? t('bankOpenedTitle')
    : result.status === 'already_customer' ? t('bankAlreadyTitle')
    : result.status === 'refused' ? t('bankRefusedTitle')
    : t('bankDeclinedTitle');

  return (
    <div className="bank-theme">
      <p className="bank-notice" role="note">{t('bankDemoNotice')}</p>
      <p className="bank-logo" aria-hidden="true">{t('bankName')}</p>
      <PageTitle key={title} text={title} />
      <ErrorSummary title={t('errorTitle')} messages={errors} />
      {!result && !errors.length && <Loading />}

      {result?.status === 'declined' && <p className="lead">{t('bankDeclinedText')}</p>}
      {result?.status === 'refused' && <p className="lead">{t('bankRefusedText')}</p>}

      {result?.account && (
        <section aria-labelledby="acct-h" className="panel bank-panel">
          <h2 id="acct-h">{t('bankYourAccount')}</h2>
          <dl className="facts">
            <div><dt>{t('fieldName')}</dt><dd>{b(result.account.name)}</dd></div>
            <div><dt>{t('bankAccountNumber')}</dt><dd dir="ltr">{result.account.number}</dd></div>
          </dl>
        </section>
      )}

      {result?.received_claims && (
        <section aria-labelledby="rec-h" className="panel">
          <h2 id="rec-h">{t('bankReceived')}</h2>
          <TableRegion caption={t('bankReceived')} visuallyHiddenCaption>
            <thead><tr><th scope="col">{t('colClaim')}</th><th scope="col">{t('colValue')}</th></tr></thead>
            <tbody>
              {Object.entries(result.received_claims).map(([k, v]) => (
                <tr key={k}><th scope="row">{b(LABELS[k] ?? { ar: k, en: k })}</th><td>{show(v, k)}</td></tr>
              ))}
            </tbody>
          </TableRegion>

          <h2>{t('bankNotReceived')}</h2>
          <ul className="claim-list claim-list-negative">
            {result.not_received?.map((k) => <li key={k}>{b(LABELS[k] ?? { ar: k, en: k })}</li>)}
          </ul>
        </section>
      )}

      {result?.inspection && result.inspection.length > 0 && (
        <details className="panel tech-details">
          <summary>{t('bankProof')}</summary>
          <p>{t('bankProofHelp')}</p>
          {result.inspection.length > 1 && <p>{t('bankProofMulti')}</p>}
          {result.inspection.map((ins) => (
            <section key={ins.credential} aria-labelledby={`cred-${ins.credential}`}>
              <h3 id={`cred-${ins.credential}`}>{t('bankIssuer', { issuer: b(ISSUERS[ins.issuer] ?? { ar: ins.issuer, en: ins.issuer }) })} <code dir="ltr">{ins.vct}</code></h3>
              <p><strong>{t('bankProofHidden', { n: ins.undisclosed_digests })}</strong></p>
              <h4>{t('bankProofIssuer')}</h4>
              <pre dir="ltr" tabIndex={0}>{JSON.stringify({ header: ins.issuer_header, payload: ins.issuer_payload }, null, 2)}</pre>
              <h4>{t('bankProofDisclosures')}</h4>
              <pre dir="ltr" tabIndex={0}>{JSON.stringify(ins.disclosures.map((d) => d.decoded), null, 2)}</pre>
              <h4>{t('bankProofKb')}</h4>
              <pre dir="ltr" tabIndex={0}>{JSON.stringify({ header: ins.key_binding_header, payload: ins.key_binding_payload }, null, 2)}</pre>
            </section>
          ))}
        </details>
      )}

      <p><Link to="/bank">{t('bankBack')}</Link></p>
    </div>
  );
}
