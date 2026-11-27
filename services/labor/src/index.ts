// Ministry of Labor & Social Insurance. Source of truth for employment and income — and the
// ISSUER of the employment credential (signed with Labor's own key, not Mithaq's).
import type { JWK } from 'jose';
import { createService, start, httpError, S } from '#shared/http.ts';
import { createDb, migrate, tx } from '#shared/db.ts';
import { installJisrGuard, requireJisr, jisrCall } from '#shared/jisr.ts';
import { loadOwnKey, randomId } from '#shared/crypto.ts';
import { initEvents, emitEvent, startOutboxPump, onEvents } from '#shared/events.ts';
import { issueSdJwt } from '#shared/sdjwt.ts';
import { CREDENTIALS } from '#shared/catalog.ts';
import { population } from '#shared/seed.ts';
import { employmentFor, incomeBracket } from '#shared/seed-ministries.ts';
import { backfillJobs, registerRecords } from './records.ts';

const db = createDb();
await migrate(db, new URL('./schema.sql', import.meta.url));
await initEvents(db);
const own = await loadOwnKey();

const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM employment');
if (n === 0) {
  await tx(db, async (c) => {
    for (const p of population()) {
      const e = employmentFor(p);
      await c.query(
        `INSERT INTO employment (national_id, status, status_name, employer_name, employer_sector, job_title, since, monthly_income, income_source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [p.national_id, e.status, e.status_name, e.employer?.name ?? null, e.employer?.sector ?? null, e.job_title, e.since, e.monthly_income, e.income_source],
      );
      if (e.social_insurance) {
        await c.query('INSERT INTO social_insurance (national_id, number, contribution_months, pension) VALUES ($1,$2,$3,$4)',
          [p.national_id, e.social_insurance.number, e.social_insurance.contribution_months, e.social_insurance.pension]);
      }
    }
  });
}

await backfillJobs(db);

const app = await createService({
  prefix: 'labor',
  title: 'Ministry of Labor & Social Insurance',
  description: 'Employment, income source and social-insurance record; issuer of the employment & income credential (SD-JWT). Reachable ONLY through Jisr.',
});
await installJisrGuard(app);

const idParam = { type: 'object', properties: { id: { type: 'string', pattern: '^1\\d{9}$' } }, required: ['id'] } as const;

async function load(id: string) {
  const e = (await db.query('SELECT * FROM employment WHERE national_id = $1', [id])).rows[0];
  if (!e) throw httpError(404, 'not_found', 'No employment record');
  const si = (await db.query('SELECT number, contribution_months, pension FROM social_insurance WHERE national_id = $1', [id])).rows[0] ?? null;
  return { e, si };
}

app.get('/x/persons/:id/employment', {
  schema: {
    tags: ['exchange (via Jisr only)'], summary: "A person's employment, income and social-insurance record", security: [{ jisr: [] }],
    params: idParam,
    response: {
      200: {
        type: 'object',
        properties: {
          national_id: { type: 'string' }, status: { type: 'string' }, status_name: S.bilingual,
          employer: { type: ['object', 'null'], properties: { name: S.bilingual, sector: { type: 'string' } } },
          job_title: { anyOf: [S.bilingual, { type: 'null' }] }, since: { type: ['string', 'null'] },
          monthly_income: { type: 'integer' }, income_bracket: S.bilingual, income_source: S.bilingual,
          social_insurance: { type: ['object', 'null'], properties: { number: { type: 'string' }, contribution_months: { type: 'integer' }, pension: { type: ['integer', 'null'] } } },
          benefits: { type: 'array', items: { type: 'object', properties: {
            id: { type: 'string' }, kind: { type: 'string' }, child_id: { type: ['string', 'null'] }, monthly_amount: { type: 'integer' },
            starts_on: { type: 'string', format: 'date' }, status: { type: 'string' }, reason: S.bilingual } } },
        },
      },
    },
  },
}, async (req) => {
  const ctx = requireJisr(req);
  const { id } = req.params as { id: string };
  if (ctx.subject !== id) throw httpError(403, 'subject_mismatch', 'Declared subject does not match the requested person');
  const { e, si } = await load(id);
  return {
    national_id: id, status: e.status, status_name: e.status_name,
    employer: e.employer_name ? { name: e.employer_name, sector: e.employer_sector } : null,
    job_title: e.job_title, since: e.since, monthly_income: e.monthly_income, income_bracket: incomeBracket(e.monthly_income),
    income_source: e.income_source, social_insurance: si,
    benefits: (await db.query('SELECT id, kind, child_id, monthly_amount, starts_on, status, reason FROM benefits WHERE national_id = $1 ORDER BY created_at', [id])).rows,
  };
});

app.post('/x/credentials/employment', {
  schema: {
    tags: ['exchange (via Jisr only)'], security: [{ jisr: [] }],
    summary: "Issue a holder-bound SD-JWT employment credential (every claim selectively disclosable), signed by Labor",
    body: {
      type: 'object', required: ['national_id', 'holder_jwk'],
      properties: { national_id: { type: 'string' }, holder_jwk: { type: 'object', additionalProperties: true } },
    },
  },
}, async (req) => {
  const ctx = requireJisr(req);
  const { national_id, holder_jwk } = req.body as { national_id: string; holder_jwk: JWK };
  if (ctx.subject !== national_id) throw httpError(403, 'subject_mismatch', 'Declared subject does not match');
  const okp = holder_jwk.kty === 'OKP' && holder_jwk.crv === 'Ed25519' && !!holder_jwk.x;            // cloud-wallet key
  const ec = holder_jwk.kty === 'EC' && holder_jwk.crv === 'P-256' && !!holder_jwk.x && !!holder_jwk.y; // device key (Phase 6)
  if (!(okp || ec) || 'd' in holder_jwk) throw httpError(400, 'bad_holder_key', 'holder_jwk must be a public Ed25519 or P-256 key');
  const { e } = await load(national_id);
  const credential = await issueSdJwt({
    issuer: 'labor', issuerKid: own.kid, issuerKey: own.key, holderPublicJwk: holder_jwk, vct: CREDENTIALS.employment.vct, ttlSeconds: 600,
    claims: {
      employment_status: e.status,
      employer_name: e.employer_name,
      income_bracket: incomeBracket(e.monthly_income),
      monthly_income: e.monthly_income,
    },
  });
  await db.query('INSERT INTO issued_credentials (national_id, consent_id, requested_by) VALUES ($1,$2,$3)', [national_id, ctx.consentId ?? null, ctx.onBehalfOf ?? ctx.client]);
  return { credential, format: 'dc+sd-jwt', vct: CREDENTIALS.employment.vct };
});

// ---------------- Phase 3: child benefit, awarded automatically when a child is registered ----------------

const CHILD_BENEFIT_SRD = 400;

onEvents('labor-child-benefit', {
  'registry.person.born': async (e) => {
    const { national_id } = e.data as { national_id: string };
    if ((await db.query("SELECT 1 FROM benefits WHERE kind = 'child_benefit' AND child_id = $1", [national_id])).rowCount) return;
    // Eligibility comes from the authoritative record (parents), pulled through Jisr — not from the event.
    const child = await jisrCall<any>({ target: 'civil-registry', method: 'GET', path: `/x/persons/${national_id}`, purpose: 'benefit-eligibility', subject: national_id });
    const payee = child.family.find((f: any) => f.relation === 'mother') ?? child.family.find((f: any) => f.relation === 'father');
    if (!payee) return;
    const id = `CB-${randomId(6)}`;
    await tx(db, async (c) => {
      const ins = await c.query(
        `INSERT INTO benefits (id, national_id, kind, child_id, monthly_amount, starts_on, reason) VALUES ($1,$2,'child_benefit',$3,$4,date_trunc('month', $5::date)::date,$6)
         ON CONFLICT (kind, child_id) DO NOTHING`,
        [id, payee.national_id, national_id, CHILD_BENEFIT_SRD, child.birth_date,
          { ar: `إعانة طفل عن ${child.given_name.ar} — مُنحت تلقائيًا عند تسجيل الولادة`, en: `Child benefit for ${child.given_name.en} — awarded automatically when the birth was registered` }],
      );
      if (!ins.rowCount) return;
      await c.query(
        `INSERT INTO employment (national_id, status, status_name, income_source) VALUES ($1, 'child', $2, $3) ON CONFLICT DO NOTHING`,
        [national_id, { ar: 'طفل', en: 'Child' }, { ar: 'لا يوجد', en: 'None' }],
      );
      await emitEvent(c, 'labor.benefit.awarded', {
        subjects: [payee.national_id, national_id], correlationId: e.correlation_id,
        data: { benefit_id: id, kind: 'child_benefit', child_id: national_id, payee_id: payee.national_id, monthly_amount: CHILD_BENEFIT_SRD },
      });
    });
  },
}, db);
registerRecords(app, db);
startOutboxPump(db);

await start(app);
