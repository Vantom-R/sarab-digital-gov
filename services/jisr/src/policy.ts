// Jisr routing table and access policy (seeded into jisr_db on start-up).
// A request is allowed only if a rule matches: client + target + method + path + purpose,
// and — when requires_consent — the request carries a consent id.
// `method` may list several methods ("GET|POST"); a path ending in "/**" also matches deeper paths.
import { RECORD_MINISTRIES, RECORD_PURPOSE } from '#shared/records.ts';

export const MEMBER_URLS: Record<string, string> = {
  'mithaq': 'http://identity:3000',
  'civil-registry': 'http://civil-registry:3000',
  'idhn': 'http://consent:3000',
  'bank-alwaha': 'http://bank-alwaha:3000',
  'education': 'http://education:3000',
  'health': 'http://health:3000',
  'labor': 'http://labor:3000',
  'property': 'http://property:3000',
};

export interface RuleSeed {
  client: string;
  target: string;
  method: string;
  path_pattern: string;
  purposes: string[];
  requires_consent?: boolean;
  description: string;
}

export const RULES: RuleSeed[] = [
  {
    client: 'mithaq', target: 'civil-registry', method: 'GET', path_pattern: '/x/persons/:id',
    purposes: ['authentication', 'citizen-self-service', 'credential-issuance', 'delegation-check', 'birth-notification', 'assisted-service'],
    description: 'Mithaq reads the civil record to sign citizens in, show them their data, issue credentials, check a proposed delegate is an adult, and check the parents a hospital names in a birth report',
  },
  {
    client: 'idhn', target: 'mithaq', method: 'POST', path_pattern: '/x/presentations',
    purposes: ['consent-fulfilment'], requires_consent: true,
    description: 'The consent service asks Mithaq for a selective-disclosure presentation of approved claims only',
  },
  {
    client: 'bank-alwaha', target: 'idhn', method: 'POST', path_pattern: '/x/requests',
    purposes: ['account-opening', 'kyc-refresh'],
    description: 'Bank Al-Waha asks a citizen for consent (checked against the regulator allow-list)',
  },
  {
    client: 'bank-alwaha', target: 'idhn', method: 'GET', path_pattern: '/x/consents/:id/presentation',
    purposes: ['account-opening', 'kyc-refresh'], requires_consent: true,
    description: 'Bank Al-Waha fetches the proof the citizen approved',
  },
  // ---- Phase 2 ministries: Mithaq shows citizens their own data ----
  {
    client: 'mithaq', target: 'education', method: 'GET', path_pattern: '/x/persons/:id/education',
    purposes: ['citizen-self-service'],
    description: 'Mithaq shows a citizen their own qualifications',
  },
  {
    client: 'mithaq', target: 'health', method: 'GET', path_pattern: '/x/persons/:id/health',
    purposes: ['citizen-self-service'],
    description: 'Mithaq shows a citizen their own health summary (no other client or purpose may read health data)',
  },
  {
    client: 'mithaq', target: 'labor', method: 'GET', path_pattern: '/x/persons/:id/employment',
    purposes: ['citizen-self-service'],
    description: 'Mithaq shows a citizen their own employment and social-insurance record',
  },
  {
    client: 'mithaq', target: 'labor', method: 'POST', path_pattern: '/x/credentials/employment',
    purposes: ['credential-issuance'], requires_consent: true,
    description: 'Mithaq (as the citizen’s wallet) obtains a Labor-signed employment credential to fulfil a consent',
  },
  {
    client: 'mithaq', target: 'property', method: 'GET', path_pattern: '/x/persons/:id/assets',
    purposes: ['citizen-self-service', 'delegated-service', 'assisted-service'],
    description: 'Mithaq shows a citizen their own vehicles and properties — or a delegate / a service-centre employee serving them',
  },
  // ---- Phase 3: life events and delegation ----
  {
    client: 'mithaq', target: 'property', method: 'POST', path_pattern: '/x/vehicles/:plate/renewals',
    purposes: ['citizen-self-service', 'delegated-service', 'assisted-service'],
    description: 'Renew a vehicle registration — by the owner, a delegate holding a Mithaq-signed mandate, or a service-centre employee in a confirmed counter session',
  },
  {
    client: 'mithaq', target: 'health', method: 'POST', path_pattern: '/x/birth-notifications',
    purposes: ['birth-notification'],
    description: 'A hospital reports a birth (hospital staff, named in on_behalf_of, use the staff portal) — mother, father, sex, date; no name yet',
  },
  {
    client: 'civil-registry', target: 'health', method: 'GET', path_pattern: '/x/birth-notifications/:id',
    purposes: ['birth-registration'],
    description: 'After a birth event, the Civil Registry pulls the notification details it needs to register the child',
  },
  {
    client: 'labor', target: 'civil-registry', method: 'GET', path_pattern: '/x/persons/:id',
    purposes: ['benefit-eligibility'],
    description: 'After a newborn is registered, Social Insurance reads the child’s record (parents) to award child benefit automatically',
  },
  {
    client: 'mithaq', target: 'civil-registry', method: 'GET|POST', path_pattern: '/x/births/**',
    purposes: ['birth-naming'],
    description: 'A parent (signed in to Mithaq) sees the births waiting for a name, proposes a name, or confirms the name the other parent proposed',
  },
  {
    client: 'mithaq', target: 'civil-registry', method: 'GET', path_pattern: '/x/persons/:id/name',
    purposes: ['news-feed'],
    description: 'Mithaq reads ONLY the name of each person an event is about, to post it to the operator’s Telegram news feed',
  },
  // ---- Civil registration by staff (naturalisation, a person missing from the registry) ----
  {
    client: 'mithaq', target: 'civil-registry', method: 'POST', path_pattern: '/x/persons',
    purposes: ['civil-registration'],
    description: 'A registrar (service-centre employee or administrator, named in on_behalf_of) enters a new adult citizen; the Civil Registry allocates the national ID',
  },
  // ---- Record maintenance by ministry staff ("Manage citizen"); each call also needs a Mithaq staff token ----
  ...Object.values(RECORD_MINISTRIES).map((m): RuleSeed => ({
    client: 'mithaq', target: m.target, method: 'GET|POST|PUT|DELETE', path_pattern: '/x/records/persons/:id/**',
    purposes: [RECORD_PURPOSE],
    description: `A ${m.name.en} employee (named in on_behalf_of, with a Mithaq-signed staff token for scope ${m.scope}) reads or changes a person's ${m.name.en} records`,
  })),
  {
    client: 'mithaq', target: 'civil-registry', method: 'GET', path_pattern: '/x/records/search',
    purposes: [RECORD_PURPOSE],
    description: 'A Civil Registry employee looks a person up by name (at most 20 results; the search itself is audited)',
  },
  {
    client: 'health', target: 'civil-registry', method: 'GET', path_pattern: '/x/persons/:id',
    purposes: ['care-assignment'],
    description: 'After an address change, Health reads the new address to assign the nearest health centre',
  },
  {
    client: 'property', target: 'civil-registry', method: 'GET', path_pattern: '/x/persons/:id',
    purposes: ['ownership-transfer'],
    description: 'Before a vehicle changes hands, the Property Authority checks that the new owner exists, is alive and is an adult',
  },
];

/** Purposes that need a Mithaq-signed act-as token (the delegation mandate) — checked by Jisr itself. */
export const DELEGATED_PURPOSES = ['delegated-service', 'assisted-service'];

export function matchPath(pattern: string, path: string): boolean {
  const pathname = path.split('?')[0]!;
  if (pathname.split('/').some((seg) => seg === '..' || seg === '.')) return false;
  const deep = pattern.endsWith('/**');
  const base = deep ? pattern.slice(0, -3) : pattern;
  const re = new RegExp('^' + base.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/') + (deep ? '(?:/[^/]+)*' : '') + '$');
  return re.test(pathname);
}

/** Does a rule's method field ("GET" or "GET|POST|…") allow this method? */
export const methodAllowed = (ruleMethod: string, method: string) => ruleMethod.split('|').includes(method);
