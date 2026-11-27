// Real-browser checks of the main flows (Chromium via Playwright):
//  * axe-core audit (WCAG 2.0/2.1/2.2 A + AA rules) on every page, in Arabic (RTL) and English
//  * keyboard/focus behaviour: skip link first, focus moves to <h1> after navigation
//  * live-region announcements exist
//  * a real WebAuthn passkey registration + sign-in using Chrome's virtual authenticator
// Automated tools catch ~30–40% of accessibility issues; manual NVDA/VoiceOver testing is still needed.
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const BASE = process.env.BASE ?? 'http://localhost:18090';
// The demo citizens' password comes from .env (make a11y passes it), never from the page.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? '';
const DEMO_MODE = process.env.DEMO_MODE === 'true';
// Staff screens are driven by the automated-test account (TEST-0001), never by the administrator.
const TEST_STAFF_PASSWORD = process.env.TEST_STAFF_PASSWORD ?? '';
if (!DEMO_PASSWORD || TEST_STAFF_PASSWORD.length < 12) { console.error('DEMO_PASSWORD / TEST_STAFF_PASSWORD missing: run via make a11y'); process.exit(2); }
const PERSONA = { layla: '1100000049', omar: '1100000031', saleh: '1100000015', aminah: '1100000023', yousef: '1100000056' };
// Every one-time code goes to Telegram. With the server-minted test ticket (sent by every browser context
// below) the API also returns it as test_code — the UI never shows it. Without a ticket we refuse to run.
const TEST_TICKET = process.env.TEST_TICKET ?? '';
if (TEST_TICKET.length < 32) { console.error('TEST_TICKET missing: run via make a11y (otherwise every code would go to Telegram)'); process.exit(2); }
const CLERK_PASSWORD = process.env.CLERK_PASSWORD ?? '';
// Every name this run types ends with RUN ("qa" + 6 hex); scripts/test-cleanup.sh deletes it all afterwards.
const RUN = /^qa[0-9a-f]{6}$/.test(process.env.TEST_RUN ?? '') ? process.env.TEST_RUN : `qa${randomBytes(3).toString('hex')}`;
let passed = 0;
const failures = [];
const check = (name, cond, extra) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${extra ? `\n      ${String(extra).slice(0, 1500).replaceAll('\n', '\n      ')}` : ''}`); }
};

async function axe(page, label) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
  const serious = r.violations;
  const detail = serious.map((v) => `[${v.impact}] ${v.id}: ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`).join('\n');
  check(`axe: ${label} (${r.passes.length} rules passed)`, serious.length === 0, detail);
}

// Optional: save the accessibility tree (what a screen reader is given) of key screens as YAML.
const SNAP_DIR = process.env.SNAPSHOT_DIR;
if (SNAP_DIR) mkdirSync(SNAP_DIR, { recursive: true });
async function snapshot(page, name) {
  if (!SNAP_DIR) return;
  const tree = await page.locator('body').ariaSnapshot();
  writeFileSync(`${SNAP_DIR}/${name}.yml`, `# Accessibility tree of "${name}" as exposed to assistive technology (Playwright ariaSnapshot).\n# Fake demo data; regenerate with: make a11y-snapshots\n${tree}\n`);
}

/**
 * Tab through the page from the top: every stop must be visible, show a focus indicator
 * (outline or box-shadow), and focus must keep moving (no keyboard trap). WCAG 2.1.1, 2.1.2, 2.4.7.
 */
async function tabAudit(page, label, maxStops = 120) {
  // Start at the very first focusable element (the skip link); Chrome otherwise continues from the
  // last "sequential focus navigation starting point" (e.g. <main> after using the skip link).
  await page.locator('.skip-link').focus();
  const problems = [];
  let stops = 0, same = 0, last = '';
  for (let i = 0; i < maxStops; i++) {
    if (i > 0) await page.keyboard.press('Tab');
    const f = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        key: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40)}"`,
        indicator: (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2) || cs.boxShadow !== 'none',
        visible: r.width > 0 && r.height > 0,
        inView: r.bottom > 0 && r.top < window.innerHeight,
      };
    });
    if (!f) break; // focus left the document → full cycle done
    stops++;
    // (a date input has several stops — day, month, year — inside one element; 6+ in a row is a trap)
    if (f.key === last) { if (++same >= 5) { problems.push(`keyboard trap at ${f.key}`); break; } } else same = 0;
    last = f.key;
    if (!f.visible) problems.push(`invisible focus stop: ${f.key}`);
    else if (!f.indicator && i > 0) problems.push(`no visible focus indicator: ${f.key}`); // stop 0 was focused by script (no :focus-visible)
    else if (!f.inView) problems.push(`focused element scrolled out of view: ${f.key}`);
  }
  check(`keyboard: ${label} — ${stops} Tab stops, all visible with a focus indicator, no trap`, problems.length === 0 && stops > 0, problems.join('\n'));
}

async function reflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(`reflow at 320px: ${label} (no horizontal page scroll)`, !overflow);
}

const focusedInfo = (page) => page.evaluate(() => {
  const el = document.activeElement;
  return el ? `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''}:${(el.textContent ?? '').trim().slice(0, 60)}` : 'none';
});

/** The next response from `path` (POST), parsed. Codes reach tests only this way (test_code). */
const nextJson = (page, path) => page.waitForResponse((r) => r.url().endsWith(path) && r.request().method() === 'POST').then((r) => r.json());

async function loginWithPassword(page, username, password) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel(/رقم الهوية الوطنية|National ID number/).fill(username);
  await page.getByLabel(/^(كلمة المرور|Password)$/).fill(password);
  // The code goes to Telegram; with the test ticket the API also returns it (the UI never shows it).
  const resp = nextJson(page, '/api/identity/auth/password');
  await page.getByRole('button', { name: /متابعة|Continue/ }).click();
  const data = await resp;
  await page.getByLabel(/sent by Telegram|عبر تيليجرام/).waitFor();
  return data.test_code;
}

/** A signed-in API client (Node fetch + cookie jar) for setting the scene, e.g. the hospital's report. */
async function apiUser(username, password) {
  const jar = new Map();
  const req = async (path, body) => {
    const headers = { accept: 'application/json', 'x-sarab-test-ticket': TEST_TICKET, ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(body ? { 'content-type': 'application/json' } : {}) };
    const r = await fetch(BASE + path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
    for (const c of r.headers.getSetCookie()) { const [pair] = c.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim()); }
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  const a = await req('/api/identity/auth/password', { username, password });
  await req('/api/identity/auth/otp', { otp_challenge_id: a.data?.otp_challenge_id, code: a.data?.test_code });
  return req;
}
const isoDay = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

const browser = await chromium.launch();
const newCtx = (opts) => browser.newContext({ ...opts, extraHTTPHeaders: { 'x-sarab-test-ticket': TEST_TICKET } });
const context = await newCtx({ locale: 'ar' });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

console.log(`\nBrowser checks against ${BASE}\n`);

// ---------- Home ----------
console.log('Home (Arabic, RTL)');
await page.goto(BASE + '/');
check('html lang="ar" dir="rtl"', (await page.getAttribute('html', 'lang')) === 'ar' && (await page.getAttribute('html', 'dir')) === 'rtl');
check('exactly one <h1>', (await page.locator('h1').count()) === 1);
check('landmarks: header, nav, main, footer', (await page.locator('header').count()) >= 1 && (await page.locator('nav').count()) >= 1 && (await page.locator('main').count()) === 1 && (await page.locator('footer').count()) === 1);
check('polite and assertive live regions present from the start', (await page.locator('[aria-live="polite"]').count()) >= 1 && (await page.locator('[aria-live="assertive"]').count()) >= 1);
await page.keyboard.press('Tab');
check('first Tab stop is the skip link', /skip-link/.test(await page.evaluate(() => document.activeElement?.className ?? '')), await focusedInfo(page));
await page.keyboard.press('Enter');
check('skip link moves focus to <main>', await page.evaluate(() => document.activeElement?.id === 'main'), await focusedInfo(page));
await axe(page, 'home (ar)');
await snapshot(page, '01-home-ar');
await tabAudit(page, 'home (ar)');

// ---------- 404 ----------
console.log('Page not found');
await page.goto(`${BASE}/no-such-page`);
await page.locator('h1').waitFor();
check('404: says what happened and links back home', /غير موجودة/.test((await page.locator('h1').textContent()) ?? '') && (await page.locator('main p.lead').count()) === 1 && (await page.locator('main a[href="/"]').count()) === 1);
await axe(page, '404 page (ar)');
await page.locator('main a[href="/"]').click();
await page.waitForURL((u) => u.pathname === '/');
check('404: the link goes to the home page', new URL(page.url()).pathname === '/');

// ---------- Login ----------
console.log('Login');
await page.getByRole('link', { name: 'تسجيل الدخول' }).click();
await page.waitForURL(/\/login/);
check('focus moves to the page <h1> after navigation', await page.evaluate(() => document.activeElement?.tagName === 'H1'), await focusedInfo(page));
await axe(page, 'login (ar)');
await snapshot(page, '02-login-ar');
await page.getByRole('button', { name: 'متابعة' }).click();
check('empty submit shows an error summary that receives focus', await page.evaluate(() => document.activeElement?.classList.contains('error-summary')), await focusedInfo(page));
check('invalid fields are marked aria-invalid', (await page.locator('#username[aria-invalid="true"]').count()) === 1);
const summaryLinks = await page.locator('.error-summary li a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
check('error summary: every item is a link to its field, in form order', JSON.stringify(summaryLinks) === JSON.stringify(['#username', '#password']), JSON.stringify(summaryLinks));
await page.locator('.error-summary li a').nth(1).click();
check('error summary: following a link moves focus to that field', await page.evaluate(() => document.activeElement?.id === 'password'), await focusedInfo(page));
await axe(page, 'login with errors');
if (!DEMO_MODE) {
  check('production: the sign-in page has no "Demo accounts" panel', (await page.locator('.demo-accounts').count()) === 0 && !/حسابات تجريبية|Demo accounts/.test((await page.locator('main').textContent()) ?? ''));
  check('production: the page never shows the demo password', !((await page.content()).includes(DEMO_PASSWORD)));
}

const layla = PERSONA.layla;
const code = await loginWithPassword(page, layla, DEMO_PASSWORD);
check('OTP step: focus moves to the code field', await page.evaluate(() => document.activeElement?.id === 'otp'), await focusedInfo(page));
await axe(page, 'login OTP step');
await page.getByLabel(/عبر تيليجرام/).fill(code);
await page.getByRole('button', { name: 'تحقق وادخل' }).click();
await page.waitForURL(/\/citizen$/);
await page.getByRole('heading', { level: 2, name: 'سجلي المدني' }).waitFor();
await page.locator('.facts').first().waitFor();
check('citizen page: focus on <h1> after login', await page.evaluate(() => document.activeElement?.tagName === 'H1'), await focusedInfo(page));
await page.waitForTimeout(800);
await axe(page, 'citizen dashboard (ar)');

console.log('Ministry sections (load on demand)');
for (const name of ['مؤهلاتي التعليمية', 'عملي والتأمينات الاجتماعية', 'مركباتي وعقاراتي', 'ملخصي الصحي']) {
  const btn = page.locator(`section:has(> h2:text-is("${name}")) > button[aria-expanded]`);
  check(`"${name}" starts collapsed (aria-expanded=false)`, (await btn.getAttribute('aria-expanded')) === 'false');
  await btn.click();
  await page.locator(`section:has(> h2:text-is("${name}")) .section-body .note`).last().waitFor();
  check(`"${name}" expands (aria-expanded=true) and loads`, (await btn.getAttribute('aria-expanded')) === 'true');
}
await page.waitForTimeout(400);
check('section load announced in the live region', /تم تحميل/.test((await page.locator('[aria-live="polite"]').textContent()) ?? ''));
await axe(page, 'citizen dashboard with all ministry sections open (ar)');
await snapshot(page, '03-citizen-dashboard-ar');
await tabAudit(page, 'citizen dashboard, all sections open (ar)', 250);

// ---------- Real passkey via virtual authenticator ----------
console.log('Passkey (Chrome virtual authenticator)');
const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});
await page.getByLabel('اسم المفتاح (اختياري)').fill('Test laptop');
await page.getByRole('button', { name: 'إضافة مفتاح مرور' }).click();
await page.getByText('Test laptop').first().waitFor({ timeout: 10000 }).catch(() => {});
check('passkey registered from the browser UI', (await page.getByText('Test laptop').count()) > 0, (await page.locator('.error-summary').textContent().catch(() => '')) ?? '');
await page.getByRole('button', { name: 'تسجيل الخروج', exact: true }).click();
await page.goto(`${BASE}/login`);
await page.getByRole('button', { name: 'الدخول بمفتاح المرور' }).click();
await page.waitForURL(/\/citizen$/, { timeout: 10000 }).catch(() => {});
check('signed in with the passkey (no password)', page.url().endsWith('/citizen'), page.url());
// clean up the test passkey
await page.getByRole('button', { name: /إزالة Test laptop/ }).click().catch(() => {});
await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });

// ---------- Bank flow ----------
console.log('Bank Al-Waha flow');
await page.getByRole('link', { name: 'بنك الواحة (تجريبي)' }).click();
await page.waitForURL(/\/bank$/);
await page.waitForTimeout(500);
await axe(page, 'bank landing');
await page.getByRole('button', { name: 'جرّب طلبًا مخالفًا' }).click();
await page.getByRole('heading', { name: 'رُفض الطلب تلقائيًا' }).waitFor();
check('regulator rejection: focus moves to the result heading', await page.evaluate(() => document.activeElement?.textContent?.includes('رُفض الطلب')), await focusedInfo(page));
await axe(page, 'bank: regulator rejection');
await page.getByRole('button', { name: 'افتح حسابًا عبر ميثاق' }).click();
await page.waitForURL(/\/consent\//);
await page.getByRole('button', { name: 'أوافق وأشارك' }).waitFor();
check('consent page: focus on <h1>', await page.evaluate(() => document.activeElement?.tagName === 'H1'), await focusedInfo(page));
await axe(page, 'consent screen');
await snapshot(page, '04-consent-ar');
await tabAudit(page, 'consent screen (ar)');
await page.getByRole('button', { name: 'أوافق وأشارك' }).click();
await page.waitForURL(/\/bank\/callback/);
await page.getByRole('heading', { level: 2, name: 'ما حصلنا عليه' }).waitFor();
check('callback: result heading focused', await page.evaluate(() => document.activeElement?.tagName === 'H1'), await focusedInfo(page));
await page.locator('details.tech-details summary').click();
check('callback shows two proofs (Mithaq + Ministry of Labor)', (await page.locator('details.tech-details section').count()) === 2);
await axe(page, 'bank callback with technical details open');
await snapshot(page, '05-bank-result-ar');

// ---------- Revoke from citizen page ----------
console.log('Revoke consent');
await page.goto(`${BASE}/citizen`);
await page.getByRole('heading', { level: 2, name: 'موافقات مشاركة البيانات' }).waitFor();
const revokeBtn = page.getByRole('button', { name: /سحب موافقة بنك الواحة/ }).first();
await revokeBtn.waitFor();
await revokeBtn.click();
check('revoke confirmation: focus moves into the confirmation', await page.evaluate(() => document.activeElement?.textContent?.includes('نعم، اسحب')), await focusedInfo(page));
await axe(page, 'revoke confirmation');
await page.getByRole('button', { name: 'نعم، اسحب الموافقة' }).click();
await page.waitForTimeout(800);
const politeText = await page.locator('[aria-live="polite"]').textContent();
check('revocation announced in the live region', politeText?.includes('تم سحب الموافقة'), politeText);

// ---------- Sign ----------
console.log('Document signing');
await page.goto(`${BASE}/citizen/sign`);
await page.getByRole('button', { name: 'وقّع المستند' }).click();
await page.getByLabel('التوقيع (JWS)').first().waitFor();
await page.getByRole('button', { name: 'تحقق' }).click();
await page.locator('.check-ok').waitFor();
await axe(page, 'sign + verify');

// ---------- Phase 3: inbox, life events, delegation ----------
console.log('Citizen sub-navigation and inbox');
const subnav = page.getByRole('navigation', { name: 'خدمات ميثاق' });
check('citizen sub-navigation is a labelled <nav>', (await subnav.count()) === 1);
check('current page marked with aria-current', (await subnav.locator('[aria-current="page"]').count()) === 1);
await subnav.getByRole('link', { name: /^الإشعارات/ }).click();
await page.waitForURL(/\/citizen\/inbox$/);
check('inbox: focus on <h1> after navigation', await page.evaluate(() => document.activeElement?.tagName === 'H1'), await focusedInfo(page));
await page.waitForTimeout(500);
await axe(page, 'inbox (ar)');
await snapshot(page, '08-inbox-ar');

console.log('Life events: naming a newborn after the hospital’s report (Arabic)');
const hospitalApi = await apiUser('test', TEST_STAFF_PASSWORD);
const omarId = PERSONA.omar;
const hr = await hospitalApi('/api/identity/staff/births', { mother_id: layla, father_id: omarId, child_gender: 'F', birth_date: isoDay(0), hospital_index: 2, record_no: `A11Y-${RUN}`, another_baby: true });
check('scene: the hospital (admin API) reports a birth for Layla and Omar', hr.status === 200, JSON.stringify(hr.data));
await subnav.getByRole('link', { name: 'أحداث الحياة' }).click();
await page.waitForURL(/\/citizen\/life-events$/);
const baby = page.locator(`article.baby:has(#nm-h-${hr.data?.notification_id})`);
await baby.waitFor();
check('the waiting baby is an article named by its heading', (await baby.getAttribute('aria-labelledby')) === `nm-h-${hr.data?.notification_id}`);
check('its details are a description list (hospital, deadline, other parent, family name, status)', (await baby.locator('dl.facts dt').count()) >= 5);
const sendBtn = baby.getByRole('button', { name: /^إرسال الاسم إلى / });
await sendBtn.click();
check('empty name: the error summary receives focus', await page.evaluate(() => document.activeElement?.classList.contains('error-summary')), await focusedInfo(page));
const arIn = baby.getByLabel(/^الاسم الأول بالعربية/);
const enIn = baby.getByLabel(/^الاسم الأول بالإنجليزية/);
check('both name fields are marked invalid and described by their error', (await arIn.getAttribute('aria-invalid')) === 'true' && (await enIn.getAttribute('aria-invalid')) === 'true' && /-err/.test((await arIn.getAttribute('aria-describedby')) ?? ''));
check('the name inputs carry their language and direction', (await arIn.getAttribute('lang')) === 'ar' && (await arIn.getAttribute('dir')) === 'rtl' && (await enIn.getAttribute('lang')) === 'en' && (await enIn.getAttribute('dir')) === 'ltr');
await arIn.fill('Reem');
await enIn.fill('Reem');
await sendBtn.click();
await page.waitForTimeout(200);
check('Latin letters in the Arabic name: only that field is invalid, with a clear message', (await arIn.getAttribute('aria-invalid')) === 'true' && (await enIn.getAttribute('aria-invalid')) === 'false' && /بحروف عربية/.test((await page.locator('.error-summary').textContent()) ?? ''));
await axe(page, 'naming a baby, with errors (ar)');
await arIn.fill('ريم');
await sendBtn.click();
await baby.locator('.check-ok').waitFor();
await page.waitForTimeout(300);
check('after sending, focus moves to the baby’s heading', await page.evaluate((id) => document.activeElement?.id === `nm-h-${id}`, hr.data?.notification_id), await focusedInfo(page));
check('the result is announced politely', /أُرسل الاسم/.test((await page.locator('[aria-live="polite"]').first().textContent()) ?? ''));
check('the status says who must confirm', /بانتظار تأكيد/.test((await baby.locator('dl.facts').textContent()) ?? ''));
await axe(page, 'naming a baby: waiting for the other parent (ar)');
await snapshot(page, '06-life-events-naming-ar');
await tabAudit(page, 'life events with a baby to name (ar)');
// The father confirms (his own session, over the API), then the registry and the other ministries act.
const omarApi = await apiUser(omarId, DEMO_PASSWORD);
const ob = (await omarApi('/api/identity/me/births')).data?.births?.find((x) => x.notification_id === hr.data?.notification_id);
const oc = await omarApi(`/api/identity/me/births/${hr.data?.notification_id}/confirm`, { proposal_id: ob?.proposal?.id });
check('scene: Omar confirms the name (API)', oc.data?.status === 'registered', JSON.stringify(oc.data));
const timeline = page.locator(`section[aria-labelledby="life-list-h"] article:has(#le-${hr.data?.notification_id})`);
for (let i = 0; i < 60; i++) {
  await page.reload();
  await timeline.waitFor().catch(() => {});
  if ((await timeline.locator('.check-ok').count()) > 0) break;
  await page.waitForTimeout(500);
}
check('steps are an ordered list with a text status (not colour only), all five done', (await timeline.locator('ol.steps li').count()) === 5 && (await timeline.locator('ol.steps').getByText('تم', { exact: true }).count()) === 5);
check('the timeline is titled with the confirmed name', /ريم/.test((await timeline.locator('h3').textContent()) ?? ''));
await axe(page, 'life events after the birth is registered (ar)');
await snapshot(page, '06-life-events-ar');
// Only one parent: the mother proposes, checks the full name, then confirms it herself.
const hr2 = await hospitalApi('/api/identity/staff/births', { mother_id: layla, child_gender: 'M', birth_date: isoDay(1), hospital_index: 0, record_no: `A11Y2-${RUN}`, another_baby: true });
check('scene: a second report, no father declared', hr2.status === 200, JSON.stringify(hr2.data));
await page.reload();
const baby2 = page.locator(`article.baby:has(#nm-h-${hr2.data?.notification_id})`);
await baby2.waitFor();
check('the only parent is told she confirms the name herself', /تؤكد الاسم بنفسك/.test((await baby2.locator('dl.facts').textContent()) ?? ''));
await baby2.getByLabel(/^الاسم الأول بالعربية/).fill('زياد');
await baby2.getByLabel(/^الاسم الأول بالإنجليزية/).fill('Ziyad');
await baby2.getByRole('button', { name: 'متابعة للتحقق من الاسم' }).click();
await baby2.locator('.check-ok').waitFor();
check('check step: the full name is shown before confirming', /الاسم الكامل سيكون: زياد /.test((await baby2.locator('dl.facts').textContent()) ?? ''));
const confirmBtn = baby2.getByRole('button', { name: 'تأكيد الاسم «زياد» وتسجيل المولود' });
check('the confirm button names the name it confirms', (await confirmBtn.count()) === 1);
await axe(page, 'naming a baby: check before confirming (ar)');
await confirmBtn.click();
await baby2.locator('.check-ok', { hasText: 'رقم هويته' }).waitFor();
await page.waitForTimeout(300);
check('after confirming, focus is on the baby’s heading and the new national ID is shown', await page.evaluate((id) => document.activeElement?.id === `nm-h-${id}`, hr2.data?.notification_id) && /1\d{9}/.test((await baby2.textContent()) ?? ''), await focusedInfo(page));
check('…and announced', /سُجّل المولود/.test((await page.locator('[aria-live="polite"]').first().textContent()) ?? ''));

console.log('Delegation');
await subnav.getByRole('link', { name: 'التفويض' }).click();
await page.waitForURL(/\/citizen\/delegations$/);
await page.waitForTimeout(400);
await axe(page, 'delegations (ar)');
await tabAudit(page, 'delegations (ar)');
const omar = PERSONA.omar;
await page.getByLabel('رقم الهوية الوطنية للمفوَّض').fill(omar);
await page.getByRole('button', { name: 'توقيع التفويض' }).click();
await page.locator('form .check-ok').waitFor();
check('delegation created and confirmed on screen', (await page.locator('form .check-ok').textContent())?.includes('عمر'));
const revokeDeleg = page.getByRole('button', { name: /إلغاء تفويض عمر/ }).first();
await revokeDeleg.waitFor();
// Omar, in his own browser, acts for Layla.
const ctx2 = await newCtx({ locale: 'ar' });
const p2 = await ctx2.newPage();
const ocode = await loginWithPassword(p2, omar, DEMO_PASSWORD);
await p2.getByLabel(/عبر تيليجرام/).fill(ocode);
await p2.getByRole('button', { name: 'تحقق وادخل' }).click();
await p2.waitForURL(/\/citizen$/);
await p2.goto(`${BASE}/citizen/delegations`);
await p2.getByRole('link', { name: /التصرف نيابةً عن ليلى/ }).first().click();
await p2.waitForURL(/\/citizen\/acting\//);
await p2.locator('.acting-banner').waitFor();
check('acting page: "acting for" banner is shown', (await p2.locator('.acting-banner').textContent())?.includes('ليلى'));
await axe(p2, 'acting for someone (ar)');
await snapshot(p2, '07-acting-for-ar');
await ctx2.close();
await revokeDeleg.click();
check('revoke delegation: focus moves into the confirmation', await page.evaluate(() => document.activeElement?.textContent?.includes('نعم')), await focusedInfo(page));
await page.getByRole('button', { name: 'نعم، ألغِ التفويض' }).click();
await page.waitForTimeout(800);
check('delegation revocation announced', ((await page.locator('[aria-live="polite"]').textContent()) ?? '').includes('أُلغي التفويض'));

// ---------- Phase 6: key on the citizen's device (real WebCrypto + virtual passkey) ----------
console.log('Device-held key (Aminah)');
const ctx4 = await newCtx({ locale: 'ar' });
const p4 = await ctx4.newPage();
p4.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
const cdp4 = await ctx4.newCDPSession(p4);
await cdp4.send('WebAuthn.enable');
const { authenticatorId: auth4 } = await cdp4.send('WebAuthn.addVirtualAuthenticator', {
  options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});
const acodeA = await loginWithPassword(p4, '1100000023', DEMO_PASSWORD);
await p4.getByLabel(/عبر تيليجرام/).fill(acodeA);
await p4.getByRole('button', { name: 'تحقق وادخل' }).click();
await p4.waitForURL(/\/citizen$/);
await p4.evaluate(async () => {
  await fetch('/api/identity/me/device-key', { method: 'DELETE' });
  const r = await (await fetch('/api/identity/me/passkeys')).json();
  for (const k of r.passkeys) await fetch(`/api/identity/me/passkeys/${encodeURIComponent(k.credential_id)}`, { method: 'DELETE' });
});
await p4.reload();
await p4.getByLabel('اسم المفتاح (اختياري)').fill('Aminah test phone');
await p4.getByRole('button', { name: 'إضافة مفتاح مرور' }).click();
await p4.getByText('Aminah test phone').first().waitFor({ timeout: 10000 });
await p4.getByRole('button', { name: 'نقل مفتاحي إلى هذا الجهاز' }).click();
await p4.locator('#devkey-h ~ .check-ok').waitFor({ timeout: 10000 });
check('key moved to this device (browser WebCrypto + passkey)', (await p4.locator('#devkey-h ~ .check-ok').count()) === 1, (await p4.locator('.error-summary').textContent().catch(() => '')) ?? '');
check('page says the key is in this browser', (await p4.getByText('المفتاح موجود في هذا المتصفح.').count()) === 1);
await axe(p4, 'citizen dashboard with a device-held key (ar)');
await p4.goto(`${BASE}/citizen/sign`);
await p4.getByRole('button', { name: 'وقّع المستند' }).click();
let devJws = '';
for (let i = 0; i < 40 && !devJws; i++) { await p4.waitForTimeout(250); devJws = await p4.getByLabel('التوقيع (JWS)').first().inputValue().catch(() => ''); }
let devAlg = '';
try { devAlg = JSON.parse(Buffer.from(devJws.split('.')[0], 'base64url').toString()).alg; } catch { /* not signed */ }
check('document signed in the browser with the device key (ES256)', devAlg === 'ES256', (await p4.locator('.error-summary').textContent().catch(() => '')) || devJws.slice(0, 80));
await p4.goto(`${BASE}/bank`);
await p4.getByRole('button', { name: 'افتح حسابًا عبر ميثاق' }).click();
await p4.waitForURL(/\/consent\//);
await p4.getByRole('button', { name: 'أوافق وأشارك' }).click();
await p4.waitForURL(/\/bank\/callback/, { timeout: 15000 });
await p4.locator('h1').first().waitFor();
await p4.waitForTimeout(800);
const cbText = (await p4.locator('main').textContent()) ?? '';
check('bank account opened from a proof built and signed in the browser', !/تعذّر|error/i.test(await p4.locator('.error-summary').count().then((n) => (n ? 'error' : ''))) && /SRB\d\d WAHA/.test(cbText), cbText.slice(0, 300));
await p4.goto(`${BASE}/citizen`);
await p4.getByRole('button', { name: 'تجريبي: إعادة المفتاح إلى الخادم' }).click();
await p4.getByText('الآن: يحفظه ميثاق على الخادم (محفظة سحابية).').waitFor();
await p4.evaluate(async () => { // clean up: remove the test passkeys
  const r = await (await fetch('/api/identity/me/passkeys')).json();
  for (const k of r.passkeys) await fetch(`/api/identity/me/passkeys/${encodeURIComponent(k.credential_id)}`, { method: 'DELETE' });
});
await cdp4.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: auth4 });
await ctx4.close();

// ---------- English / LTR ----------
console.log('English (LTR)');
await page.goto(`${BASE}/citizen`);
await page.getByRole('button', { name: 'Switch to English' }).click();
check('html lang="en" dir="ltr" after switching', (await page.getAttribute('html', 'lang')) === 'en' && (await page.getAttribute('html', 'dir')) === 'ltr');
await page.getByRole('heading', { level: 2, name: 'My civil record' }).waitFor();
for (const name of ['My education', 'My work & social insurance', 'My vehicles & property', 'My health summary']) {
  await page.getByRole('button', { name: `Show ${name}` }).click();
}
await page.waitForTimeout(1200);
await axe(page, 'citizen dashboard, all sections open (en)');
await page.goto(`${BASE}/citizen/life-events`);
await page.getByRole('heading', { level: 2, name: 'Your life events' }).waitFor();
await page.waitForTimeout(500);
await axe(page, 'life events (en)');
await page.goto(`${BASE}/citizen/delegations`);
await page.waitForTimeout(600);
await axe(page, 'delegations (en)');
await page.goto(`${BASE}/bank`);
await page.waitForTimeout(500);
await axe(page, 'bank landing (en)');

// ---------- Admin ----------
console.log('Admin');
await page.getByRole('button', { name: 'Sign out', exact: true }).click();
const acode = await loginWithPassword(page, 'test', TEST_STAFF_PASSWORD);
check('admin sign-in shows no code on screen (Telegram)', !/\b\d{6}\b/.test((await page.locator('main').textContent()) ?? ''));
await axe(page, 'admin Telegram-code step (en)');
await page.getByLabel(/6-digit code sent by Telegram/).fill(acode);
await page.getByRole('button', { name: 'Verify and sign in' }).click();
await page.waitForURL(/\/admin$/);
const adminNav = page.getByRole('navigation', { name: 'Audit and admin sections' });
check('admin: a labelled section navigation, the overview is a short page', (await adminNav.count()) === 1 && (await page.locator('main table').count()) === 0);
await axe(page, 'admin overview (en)');
await adminNav.getByRole('link', { name: 'Audit log', exact: true }).click();
await page.waitForURL(/\/admin\/audit$/);
await page.locator('.pager-status').first().waitFor();
await page.waitForTimeout(300);
check('audit log: focus on the section <h1>', await page.evaluate(() => document.activeElement?.tagName === 'H1' && /Audit log/.test(document.activeElement.textContent)), await focusedInfo(page));
check('audit log: 20 rows per page, with a pager', (await page.locator('main tbody tr').count()) === 20 && /Showing 1–20 of \d+/.test((await page.locator('.pager-status').first().textContent()) ?? ''));
check('audit log: filters for date, employee, citizen and result', (await page.getByLabel('From date').count()) === 1 && (await page.getByLabel('Employee ID').count()) === 1 && (await page.getByLabel('Citizen national ID').count()) === 1 && (await page.getByLabel('Result').count()) === 1);
await page.getByRole('button', { name: 'Next page' }).first().click();
await page.waitForTimeout(500);
check('audit log: next page shows entries 21–40', /Showing 21–40/.test((await page.locator('.pager-status').first().textContent()) ?? ''));
await page.getByLabel('Result').selectOption('no_record');
await page.getByRole('button', { name: 'Apply filter' }).click();
await page.waitForTimeout(600);
const nr = await page.locator('main tbody td:nth-child(9) .badge').allTextContents();
check('audit log: filtering by "No record" shows only No record (never "Denied 404")', nr.length > 0 && nr.every((x) => /^No record/.test(x)), nr.slice(0, 5).join(' | '));
await axe(page, 'admin audit log, filtered (en)');
await page.getByRole('button', { name: 'Clear filter' }).click();
await adminNav.getByRole('link', { name: 'Service-centre actions (by employee)' }).click();
await page.waitForURL(/\/admin\/counter-actions$/);
await page.locator('.pager-status').first().waitFor();
await page.waitForTimeout(300);
check('service-centre actions: paged (at most 20 rows) with filters', (await page.locator('main tbody tr').count()) <= 20 && (await page.getByLabel('Action', { exact: true }).count()) === 1);
check('service-centre actions: automated test actions are labelled', (await page.locator('main tbody th:has-text("TEST-0001") .badge:text("Automated test")').count()) > 0 || (await page.locator('main tbody th:has-text("TEST-0001")').count()) === 0);
await axe(page, 'admin service-centre actions (en)');
await adminNav.getByRole('link', { name: 'Audit log integrity' }).click();
await page.waitForURL(/\/admin\/integrity$/);
await page.getByRole('button', { name: 'Verify the hash chain' }).click();
await page.locator('.check-ok').waitFor();
await page.waitForTimeout(300);
await axe(page, 'admin / audit (en)');
await page.getByRole('button', { name: 'Edit an entry (hide why data was read)' }).click();
await page.locator('.tamper-result').waitFor();
check('tamper demo result is shown and says the break was found', /broken at #\d+/.test((await page.locator('.tamper-result').textContent()) ?? ''));
await page.waitForTimeout(300);
check('tamper result announced assertively', /broken at/.test((await page.locator('[aria-live="assertive"]').textContent()) ?? ''));
await axe(page, 'admin tamper demo (en)');
await snapshot(page, '10-admin-en');
await page.getByRole('link', { name: 'Overview' }).click();
await page.waitForURL(/\/admin$/);

// ---------- Admin uses the staff tools: counter + civil registration ----------
console.log('Admin: staff tools (counter, civil registration form)');
await page.getByRole('heading', { name: 'Staff tools' }).waitFor({ timeout: 5000 }).catch(() => {});
check('admin page lists the staff tools / permissions', (await page.getByRole('heading', { name: 'Staff tools' }).count()) === 1);
await page.getByRole('link', { name: 'Service centre (staff)' }).first().click();
await page.waitForURL(/\/counter$/);
await page.locator('.lead').waitFor();
check('admin can open the counter page (as TEST-0001)', /TEST-0001/.test((await page.locator('.lead').textContent()) ?? ''));
await page.getByRole('link', { name: 'Civil Registry (staff)' }).first().click();
await page.waitForURL(/\/registry$/);
await page.locator('#reason-naturalization').waitFor();
await page.waitForTimeout(300);
check('registry page: focus on <h1> after navigation', await page.evaluate(() => document.activeElement?.tagName === 'H1'), await focusedInfo(page));
await axe(page, 'civil registry form (en)');
await tabAudit(page, 'civil registry form (en)');
// Submit empty: summary appears, takes focus, and each field is marked invalid + described by its error.
await page.getByRole('button', { name: 'Register and issue national ID' }).click();
await page.locator('.error-summary').waitFor();
await page.waitForTimeout(200);
check('empty submit: error summary is focused (announced as alert)', await page.evaluate(() => document.activeElement?.classList.contains('error-summary')), await focusedInfo(page));
const givenAr = page.getByLabel(/^Given name in Arabic/);
check('a field with an error is aria-invalid and described by its message',
  (await givenAr.getAttribute('aria-invalid')) === 'true' && /given_ar-err/.test((await givenAr.getAttribute('aria-describedby')) ?? ''));
await axe(page, 'civil registry form with errors (en)');
// Fill it in through the accessible names (proves every control is labelled).
const rtag = RUN;
await page.getByRole('radio', { name: 'Naturalisation' }).check();
await page.getByLabel(/^Reference number/).fill(`DEC-${rtag}`);
await givenAr.fill(`ريم ${rtag}`);
await page.getByLabel(/^Family name in Arabic/).fill('الجديدة');
await page.getByLabel(/^Given name in English/).fill(`Reem${rtag}`);
await page.getByLabel(/^Family name in English/).fill('Al-Jadida');
await page.getByRole('radio', { name: 'Female' }).check();
await page.getByLabel(/^Date of birth/).fill('1985-04-12');
await page.getByLabel(/^City/).selectOption({ index: 2 });
await page.getByLabel(/^District/).selectOption({ index: 1 });
await page.getByLabel(/^Street and building number/).fill('9 Coral St');
await page.getByLabel(/^Mobile number/).fill('+999 50 777 1234');
const regResp = nextJson(page, '/api/identity/registry/persons');
await page.getByRole('button', { name: 'Register and issue national ID' }).click();
const regData = await regResp;
const actCode = regData.activation?.test_code ?? '';
const actLink = (regData.activation?.test_message ?? '').match(/https?:\/\/\S+(\/activate\?nid=\d{10})/)?.[1] ?? '';
await page.locator('#reg-result-h').waitFor();
await page.waitForTimeout(300);
check('after registering, focus moves to the result heading', await page.evaluate(() => document.activeElement?.id === 'reg-result-h'), await focusedInfo(page));
check('the new national ID is announced', /National ID/.test((await page.locator('[aria-live="polite"]').textContent()) ?? ''));
const newId = (await page.locator('.big-id').textContent()).trim();
const sentText = (await page.locator('#reg-result-h ~ .code-sent').textContent()) ?? '';
check('the registrar sees the new national ID and “code sent by Telegram” — not the code', /^1\d{9}$/.test(newId) && /sent to the citizen by Telegram/.test(sentText) && /^\d{4} \d{4}$/.test(actCode) && !(((await page.locator('main').textContent()) ?? '').replace(/\s/g, '').includes(actCode.replace(' ', ''))), { newId, sentText });
await axe(page, 'civil registry: registered (en)');
await snapshot(page, '12-registry-registered-en');
await page.getByRole('button', { name: 'Sign out', exact: true }).click();

// ---------- The new citizen activates her account (Arabic, real passkey) ----------
console.log('New citizen: activation (ar) with a real passkey');
const actCtx = await newCtx({ locale: 'ar' });
const actPage = await actCtx.newPage();
await actPage.goto(`${BASE}/login`);
check('sign-in page: a “New citizen?” heading with an “Activate your account” link', (await actPage.getByRole('heading', { name: 'مواطن جديد؟' }).count()) === 1 && (await actPage.getByRole('link', { name: 'فعّل حسابك', exact: true }).count()) === 1);
await actPage.getByRole('link', { name: 'فعّل حسابك', exact: true }).click();
await actPage.waitForURL(/\/activate$/);
await actPage.locator('#act-nid').waitFor();
await actPage.waitForTimeout(200);
check('activation: focus moves to the page heading after following the link', await actPage.evaluate(() => document.activeElement?.tagName === 'H1'), await focusedInfo(actPage));
check('activation: step list marks the current step', (await actPage.locator('[aria-current="step"]').count()) === 1);
check('activation: the ID field is empty without a link', (await actPage.locator('#act-nid').inputValue()) === '');
await axe(actPage, 'activation step 1 (ar)');
// The link in the Telegram message: the national ID is filled in and the field says so.
check('the activation message contains a direct link with the national ID', actLink === `/activate?nid=${newId}`, actLink);
await actPage.goto(`${BASE}${actLink}`);
await actPage.locator('#act-nid').waitFor();
const nidDesc = await actPage.evaluate(() => { const i = document.getElementById('act-nid'); return (i?.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' '); });
check('from the message link: the national ID is pre-filled and its description says it came from the link', (await actPage.locator('#act-nid').inputValue()) === newId && /الرابط/.test(nidDesc), nidDesc);
await axe(actPage, 'activation step 1 from the message link (ar)');
await actPage.getByLabel('رمز التفعيل', { exact: true }).fill('11112222');
await actPage.getByRole('button', { name: 'متابعة' }).click();
await actPage.locator('.error-summary').waitFor();
check('a wrong code shows a focused error summary', await actPage.evaluate(() => document.activeElement?.classList.contains('error-summary')));
check('…and the code field is marked invalid with the error in its description', (await actPage.locator('#act-code').getAttribute('aria-invalid')) === 'true' && /code-err/.test((await actPage.locator('#act-code').getAttribute('aria-describedby')) ?? ''));
// From here on any console error counts (the 401 above was the deliberate wrong code).
actPage.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
await actPage.getByLabel('رمز التفعيل', { exact: true }).fill(actCode);
await actPage.getByRole('button', { name: 'متابعة' }).click();
await actPage.locator('#act-pw').waitFor();
await actPage.waitForTimeout(200);
check('step 2: focus moves to the step heading', await actPage.evaluate(() => document.activeElement?.id === 'act-h'));
await axe(actPage, 'activation step 2: password (ar)');
await actPage.getByLabel('كلمة المرور الجديدة').fill('short');
await actPage.getByLabel('أعد كتابة كلمة المرور').fill('different');
await actPage.getByRole('button', { name: 'تفعيل الحساب' }).click();
await actPage.waitForTimeout(200);
check('password errors are tied to their fields', (await actPage.locator('#act-pw').getAttribute('aria-invalid')) === 'true' && (await actPage.locator('#act-pw2').getAttribute('aria-invalid')) === 'true');
await actPage.getByLabel('كلمة المرور الجديدة').fill(`Reem-${rtag}-2026!`);
await actPage.getByLabel('أعد كتابة كلمة المرور').fill(`Reem-${rtag}-2026!`);
await actPage.getByRole('button', { name: 'تفعيل الحساب' }).click();
await actPage.getByRole('button', { name: 'إضافة مفتاح مرور' }).waitFor();
await actPage.waitForTimeout(200);
check('step 3: account active, focus on the passkey step heading', await actPage.evaluate(() => document.activeElement?.id === 'act-h'));
await axe(actPage, 'activation step 3: passkey (ar)');
const actCdp = await actCtx.newCDPSession(actPage);
await actCdp.send('WebAuthn.enable');
await actCdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
await actPage.getByRole('button', { name: 'إضافة مفتاح مرور' }).click();
await actPage.locator('[role="status"].check-ok').waitFor({ timeout: 10000 }).catch(() => {});
check('the new citizen adds a passkey from the browser', (await actPage.locator('[role="status"].check-ok').count()) === 1, (await actPage.locator('.error-summary').textContent().catch(() => '')) ?? '');
await actPage.getByRole('button', { name: 'الذهاب إلى صفحتي في ميثاق' }).click();
await actPage.waitForURL(/\/citizen$/);
await actPage.getByText(newId).first().waitFor({ timeout: 10000 }).catch(() => {});
check('she lands on her Mithaq page showing her new national ID', (await actPage.getByText(newId).count()) > 0);
await actPage.getByRole('button', { name: 'تسجيل الخروج', exact: true }).click();
await actPage.goto(`${BASE}/login`);
await actPage.getByRole('button', { name: 'الدخول بمفتاح المرور' }).click();
await actPage.waitForURL(/\/citizen$/, { timeout: 10000 }).catch(() => {});
check('…and signs in again with that passkey', /\/citizen$/.test(actPage.url()));
await actCtx.close();

// Back to the admin page for the next section's sign-out.
await loginWithPassword(page, 'test', TEST_STAFF_PASSWORD).then(async (c) => {
  await page.getByLabel(/6-digit code sent by Telegram/).fill(c);
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await page.waitForURL(/\/admin$/);
});

// ---------- Hospital: report a birth (admin acting as hospital staff, English) ----------
console.log('Hospital: report a birth');
await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Hospital: report a birth' }).click();
await page.waitForURL(/\/births\/report$/);
await page.locator('#br-mother').waitFor();
await page.waitForTimeout(200);
check('birth report: focus on <h1> after navigation', await page.evaluate(() => document.activeElement?.tagName === 'H1'), await focusedInfo(page));
check('birth report: says it acts as hospital staff TEST-0001, and asks for no name', /TEST-0001/.test((await page.locator('.note').first().textContent()) ?? '') && (await page.getByLabel(/name/i).count()) === 0);
check('birth report: the sex is a fieldset of radio buttons with a legend', (await page.locator('fieldset:has(legend:text("Baby’s sex")) input[type=radio]').count()) === 2);
await axe(page, 'birth report form (en)');
await tabAudit(page, 'birth report form (en)');
await page.getByRole('button', { name: 'Send the report' }).click();
check('birth report, empty: the error summary receives focus', await page.evaluate(() => document.activeElement?.classList.contains('error-summary')), await focusedInfo(page));
check('…the mother field is invalid and described by its error', (await page.locator('#br-mother[aria-invalid="true"]').count()) === 1 && /br-mother-err/.test((await page.locator('#br-mother').getAttribute('aria-describedby')) ?? ''));
check('…the sex group shows its error', (await page.locator('#br-sex-err').count()) === 1);
await axe(page, 'birth report with errors (en)');
await page.locator('#br-mother').fill(layla);
await page.getByLabel('Female').check();
await page.locator('#br-date').fill(isoDay(2));
await page.locator('#br-hospital').selectOption({ index: 1 });
await page.locator('#br-record').fill(`A11Y3-${RUN}`);
await page.getByRole('button', { name: 'Send the report' }).click();
await page.locator('#br-done-h').waitFor();
await page.waitForTimeout(300);
check('birth reported: focus moves to the result heading', await page.evaluate(() => document.activeElement?.id === 'br-done-h'), await focusedInfo(page));
check('…announced, with the report number and whether each parent has an account', /Birth reported/.test((await page.locator('[aria-live="polite"]').first().textContent()) ?? '') && /BN-/.test((await page.locator('main').textContent()) ?? '') && /active Mithaq account/.test((await page.locator('main').textContent()) ?? ''));
await axe(page, 'birth reported (en)');
await page.getByRole('button', { name: 'Report another birth' }).click();
await page.waitForTimeout(200);
check('"Report another birth" returns focus to the first field', await page.evaluate(() => document.activeElement?.id === 'br-mother'), await focusedInfo(page));

// ---------- Manage citizen: ministry staff screens (admin, English; one page in Arabic) ----------
console.log('Manage citizen (admin acting as an employee of each ministry)');
const focusId = () => page.evaluate(() => document.activeElement?.id ?? '');
const announced = () => page.locator('[aria-live="polite"]').first().textContent();
await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Manage citizen' }).click();
await page.waitForURL(/\/manage$/);
await page.waitForTimeout(200);
check('manage: focus moves to the page heading', await page.evaluate(() => document.activeElement?.tagName === 'H1'), await focusedInfo(page));
check('manage: the search form is a search landmark with a labelled field', (await page.getByRole('search').count()) === 1 && (await page.getByLabel('National ID or name').count()) === 1);
await axe(page, 'manage: search (en)');
await page.getByRole('button', { name: 'Search', exact: true }).click();
await page.locator('.error-summary').waitFor();
check('manage: an empty search shows a focused error summary and marks the field invalid', await page.evaluate(() => document.activeElement?.classList.contains('error-summary')) && (await page.locator('#mg-q').getAttribute('aria-invalid')) === 'true' && /mg-q-err/.test((await page.locator('#mg-q').getAttribute('aria-describedby')) ?? ''));
await page.getByLabel('National ID or name').fill(newId);
await page.getByRole('button', { name: 'Search', exact: true }).click();
await page.locator('#mg-results-h').waitFor();
await page.waitForTimeout(200);
check('manage: focus moves to the results heading, which gives the count', (await focusId()) === 'mg-results-h' && /Search results: 1/.test((await page.locator('#mg-results-h').textContent()) ?? ''), await focusedInfo(page));
await axe(page, 'manage: search results (en)');
await page.getByRole('link', { name: /^Open the records of / }).click();
await page.waitForURL(new RegExp(`/manage/${newId}$`));
await page.getByRole('heading', { level: 3, name: 'Ministry of Health' }).waitFor();
check('manage overview: five ministries, each a heading with an “Open … record” link', (await page.locator('.card-list > li h3').count()) === 5 && (await page.getByRole('link', { name: /^Open the .* record$/ }).count()) === 5);
check('manage overview: a breadcrumb navigation marks the current page', (await page.getByRole('navigation', { name: 'Breadcrumb' }).locator('[aria-current="page"]').count()) === 1);
await axe(page, 'manage: overview (en)');
await snapshot(page, '20-manage-overview-en');

// Civil Registry
await page.getByRole('link', { name: 'Open the Civil Registry record' }).click();
await page.locator('#addr-street').waitFor();
await page.waitForTimeout(200);
check('civil: focus on the page heading, which names the ministry and the person', await page.evaluate(() => document.activeElement?.tagName === 'H1' && /^Civil Registry: /.test(document.activeElement.textContent ?? '')), await focusedInfo(page));
await axe(page, 'manage civil: form (en)');
await page.getByLabel(/^City/).selectOption({ index: 3 });
await page.getByLabel(/^Street and building number/).fill('12 Moon Rd');
await page.getByRole('button', { name: 'Save address' }).click();
await page.locator('#address-h + .check-ok').waitFor();
await page.waitForTimeout(250);
check('civil: after saving, focus moves to the section heading and the result is shown and announced', (await focusId()) === 'address-h' && /Address saved/.test((await announced()) ?? ''), await focusedInfo(page));
await page.getByLabel('Spouse’s national ID').fill('123');
await page.getByRole('button', { name: 'Register the marriage' }).click();
await page.locator('.error-summary').waitFor();
check('civil: a wrong spouse ID and a missing date are listed in a focused error summary, tied to their fields',
  await page.evaluate(() => document.activeElement?.classList.contains('error-summary')) &&
  (await page.locator('#mar-spouse').getAttribute('aria-invalid')) === 'true' && (await page.locator('#mar-date').getAttribute('aria-invalid')) === 'true' &&
  /mar-spouse-err/.test((await page.locator('#mar-spouse').getAttribute('aria-describedby')) ?? ''));
await axe(page, 'manage civil: with errors (en)');
await tabAudit(page, 'manage civil (en)');

// Education: server-side validation mapped to the field; add / edit / cancel / remove with focus management
await page.goto(`${BASE}/manage/${newId}/education`);
await page.locator('#deg-level').waitFor();
await page.getByLabel(/^Level/).selectOption('bachelor');
await page.locator('#deg-institution').selectOption({ index: 1 });
await page.getByLabel(/^Major/).selectOption({ index: 2 });
await page.getByLabel(/^Year of graduation/).fill('1990'); // before she was 14 → refused by the server
const consoleBefore = consoleErrors.length; // the browser logs that deliberate 422; it is not a page error
await page.getByLabel(/^Grade/).selectOption({ index: 1 });
await page.getByRole('button', { name: 'Add a degree or certificate' }).click();
await page.locator('.error-summary').waitFor();
check('education: a year before the person was 14 is refused, and the error is on the year field', (await page.locator('#deg-year').getAttribute('aria-invalid')) === 'true' && /too young/.test((await page.locator('.error-summary').textContent()) ?? ''), (await page.locator('.error-summary').textContent()));
consoleErrors.splice(consoleBefore);
await page.getByLabel(/^Year of graduation/).fill('2020');
await page.getByRole('button', { name: 'Add a degree or certificate' }).click();
await page.locator('#degrees-h + .check-ok').waitFor();
await page.waitForTimeout(250);
check('education: degree added — focus on the list heading, the table shows it', (await focusId()) === 'degrees-h' && (await page.locator('#degrees-h ~ .table-region tbody tr').count()) === 1, await focusedInfo(page));
const editBtn = page.getByRole('button', { name: /^Edit: Bachelor/ });
check('education: row buttons name the item they act on', (await editBtn.count()) === 1 && (await page.getByRole('button', { name: /^Remove: Bachelor/ }).count()) === 1);
await editBtn.click();
await page.waitForTimeout(150);
check('education: Edit moves focus to the form heading, which names the degree', (await focusId()) === 'degform-h' && /^Edit: Bachelor/.test((await page.locator('#degform-h').textContent()) ?? ''), await focusedInfo(page));
await page.getByRole('button', { name: 'Cancel' }).click();
await page.waitForTimeout(150);
check('education: Cancel returns focus to the Edit button', /^edit-/.test(await focusId()), await focusedInfo(page));
await page.getByRole('button', { name: /^Remove: Bachelor/ }).click();
await page.waitForTimeout(150);
check('education: Remove asks first — the confirmation group takes focus', await page.evaluate(() => !!document.activeElement?.closest('[role="group"].warning-box')), await focusedInfo(page));
await axe(page, 'manage education: confirm removal (en)');
await page.locator('.warning-box').getByRole('button', { name: 'Cancel' }).click();
await page.waitForTimeout(150);
check('education: Cancel returns focus to the Remove button', /^del-/.test(await focusId()), await focusedInfo(page));
await page.getByRole('button', { name: /^Remove: Bachelor/ }).click();
await page.locator('.warning-box').getByRole('button', { name: 'Remove', exact: true }).click();
await page.locator('#degrees-h + .check-ok', { hasText: 'Degree removed' }).waitFor();
await page.waitForTimeout(250);
check('education: removed — the table is gone and the result is announced', (await page.locator('#degrees-h ~ .table-region').count()) === 0 && /Degree removed/.test((await announced()) ?? ''));
await axe(page, 'manage education (en)');

// Labor: a job → current situation and income source
await page.goto(`${BASE}/manage/${newId}/labor`);
await page.locator('#job-employer').waitFor();
await page.getByLabel(/^Employer/).selectOption({ index: 1 });
await page.getByLabel(/^Job title/).selectOption({ index: 2 });
await page.getByLabel(/^Monthly salary/).fill('15000');
await page.getByLabel(/^Start date/).fill('2023-04-01');
await page.getByRole('button', { name: 'Add a job' }).click();
await page.locator('#jobs-h + .check-ok').waitFor();
check('labor: the job is added and the current situation shows the employer and the salary as income', /Sarab Telecom Company/.test((await page.locator('#current-h ~ dl').textContent()) ?? '') && /15,000 SRD/.test((await page.locator('#current-h ~ dl').textContent()) ?? ''));
await axe(page, 'manage labor (en)');

// Property: register a vehicle; transfer form takes focus
await page.goto(`${BASE}/manage/${newId}/property`);
await page.locator('#veh-make').waitFor();
await page.getByLabel(/^Make/).selectOption({ index: 1 });
await page.locator('#veh-model').selectOption({ index: 1 });
await page.getByLabel(/^Model year/).fill('2024');
await page.getByLabel(/^Colour/).selectOption({ index: 1 });
await page.getByRole('button', { name: 'Register a vehicle' }).click();
await page.locator('#vehicles-h + .check-ok').waitFor();
check('property: vehicle registered (one row, renewal not yet open)', (await page.locator('#vehicles-h ~ .table-region tbody tr').count()) === 1 && /Renewal opens 60 days before expiry/.test((await page.locator('#vehicles-h ~ .table-region').textContent()) ?? ''));
await page.getByRole('button', { name: /^Transfer Najm/ }).click();
await page.waitForTimeout(150);
check('property: Transfer opens a form whose heading takes focus', (await focusId()) === 'transfer-h', await focusedInfo(page));
await axe(page, 'manage property: transfer (en)');
await page.locator('#transfer-h ~ form').getByRole('button', { name: 'Cancel' }).click();

// Health in Arabic: create the record (checkbox groups are fieldsets with legends)
await page.getByRole('button', { name: 'التبديل إلى العربية' }).click();
await page.goto(`${BASE}/manage/${newId}/health`);
await page.locator('#h-blood').waitFor();
check('health (ar): page in Arabic, right-to-left', (await page.getAttribute('html', 'lang')) === 'ar' && (await page.getAttribute('html', 'dir')) === 'rtl');
check('health (ar): allergies are a fieldset with a legend', (await page.getByRole('group', { name: 'الحساسية' }).count()) === 1);
await page.getByLabel(/^فصيلة الدم/).selectOption('O+');
await page.getByLabel(/^المركز الصحي/).selectOption({ index: 1 });
await page.getByRole('checkbox', { name: 'غبار الطلع' }).check();
await page.getByRole('button', { name: 'إنشاء الملف الصحي' }).click();
await page.locator('#summary-h + .check-ok').waitFor();
check('health (ar): record created — the vaccinations section appears', (await page.locator('#vaccinations-h').count()) === 1);
await axe(page, 'manage health (ar)');
await tabAudit(page, 'manage health (ar)');
await page.getByRole('button', { name: 'Switch to English' }).click();

// ---------- Service-centre counter (employee) ----------
console.log('Service-centre counter (employee)');
await page.getByRole('button', { name: 'Sign out', exact: true }).click();
const ccode = await loginWithPassword(page, 'clerk', CLERK_PASSWORD);
await page.getByLabel(/6-digit code sent by Telegram/).fill(ccode);
await page.getByRole('button', { name: 'Verify and sign in' }).click();
await page.waitForURL(/\/counter$/);
await page.locator('h1').waitFor();
await page.waitForTimeout(300);
check('employee lands on the counter page, focus on <h1>', await page.evaluate(() => document.activeElement?.tagName === 'H1'), await focusedInfo(page));
await page.waitForTimeout(500);
await axe(page, 'counter start (en)');
const saleh = PERSONA.saleh;
await page.getByLabel('Citizen’s national ID number').fill(saleh);
const csResp = nextJson(page, '/api/identity/counter/sessions');
await page.getByRole('button', { name: 'Send a confirmation code to the citizen' }).click();
const csCode = (await csResp).test_code;
await page.locator('#cs-code').waitFor();
check('counter: the employee sees “code sent by Telegram”, not the code', /sent to the citizen by Telegram/.test((await page.locator('main').textContent()) ?? '') && !((await page.locator('main').textContent()) ?? '').includes(csCode));
await page.waitForTimeout(200);
check('focus moves to the code field', await page.evaluate(() => document.activeElement?.id === 'cs-code'), await focusedInfo(page));
await axe(page, 'counter: waiting for the citizen’s code (en)');
await page.getByLabel('Code read out by the citizen').fill(csCode);
await page.getByRole('button', { name: 'Confirm and open the file' }).click();
await page.locator('#serving-h').waitFor();
await page.waitForTimeout(200);
check('focus moves to "Now serving" heading', await page.evaluate(() => document.activeElement?.id === 'serving-h'), await focusedInfo(page));
await page.getByRole('button', { name: 'Show vehicles' }).click();
await page.locator('#serving-h ~ .table-region').first().waitFor();
await axe(page, 'counter: serving a citizen (en)');
await snapshot(page, '09-counter-serving-en');
await tabAudit(page, 'counter while serving (en)');
await page.getByRole('button', { name: 'Finish serving' }).click();
await page.locator('#start-h').waitFor();
await page.waitForTimeout(300);
check('after finishing, focus returns to "Start serving"', await page.evaluate(() => document.activeElement?.id === 'start-h'), await focusedInfo(page));

// ---------- Narrow screen / zoom (WCAG 1.4.10 reflow: 320 CSS px = 400% zoom of 1280px) ----------
console.log('Reflow at 320px, forced colours, session timeout');
await page.getByRole('button', { name: 'Sign out', exact: true }).click();
await page.setViewportSize({ width: 320, height: 720 });
await page.goto(`${BASE}/`);
await reflow(page, 'home');
await axe(page, 'home at 320px');
await page.goto(`${BASE}/bank`);
await page.waitForTimeout(400);
await reflow(page, 'bank landing');
await page.goto(`${BASE}/login`);
await reflow(page, 'login');

// A citizen session with a fake clock: reflow of the signed-in pages, then the timeout warning.
const ctx3 = await newCtx({ locale: 'ar', viewport: { width: 320, height: 720 } });
const p3 = await ctx3.newPage();
p3.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
await p3.clock.install();
const ncode = await loginWithPassword(p3, omar, DEMO_PASSWORD);
await p3.getByLabel(/عبر تيليجرام/).fill(ncode);
await p3.getByRole('button', { name: 'تحقق وادخل' }).click();
await p3.waitForURL(/\/citizen$/);
await p3.locator('.facts').first().waitFor();
await reflow(p3, 'citizen dashboard');
for (const [path, label] of [['/citizen/life-events', 'life events'], ['/citizen/delegations', 'delegations'], ['/citizen/inbox', 'inbox']]) {
  await p3.goto(BASE + path);
  await p3.waitForTimeout(600);
  await reflow(p3, label);
}
await axe(p3, 'delegations at 320px');

// Forced colours (Windows High Contrast): focus indicators must survive.
await p3.setViewportSize({ width: 1280, height: 900 });
await p3.emulateMedia({ forcedColors: 'active' });
await p3.goto(`${BASE}/citizen`);
await p3.locator('.facts').first().waitFor();
await tabAudit(p3, 'citizen dashboard in forced-colours mode', 250);
await axe(p3, 'citizen dashboard, forced colours');
await p3.emulateMedia({ forcedColors: 'none' });

// Session timeout warning (WCAG 2.2.1): jump to 1 min 50 s before expiry.
const sess = await p3.evaluate(async () => (await (await fetch('/api/identity/whoami')).json()).session);
await p3.clock.fastForward(Math.max(0, (sess.exp - 110) * 1000 - Date.now()));
await p3.clock.runFor(6000);
const dlg = p3.getByRole('alertdialog', { name: 'ستنتهي جلستك قريبًا' });
await dlg.waitFor({ timeout: 5000 }).catch(() => {});
check('session-timeout warning appears before expiry (role=alertdialog)', (await dlg.count()) === 1);
check('focus moves to "Stay signed in"', await p3.evaluate(() => document.activeElement?.textContent === 'البقاء مسجّلًا'), await focusedInfo(p3));
await axe(p3, 'session-timeout warning (ar)');
await snapshot(p3, '11-session-timeout-warning-ar');
await Promise.all([p3.waitForResponse(/\/api\/identity\/session\/refresh/), p3.getByRole('button', { name: 'البقاء مسجّلًا' }).click()]);
await p3.clock.runFor(1000);
const sess2 = await p3.evaluate(async () => (await (await fetch('/api/identity/whoami')).json()).session);
check('"Stay signed in" extends the session on the server (same sign-in time)', sess2?.exp > sess.exp && sess2.auth_time === sess.auth_time, JSON.stringify({ before: sess?.exp, after: sess2?.exp }));
check('extension is announced', ((await p3.locator('[aria-live="polite"]').textContent()) ?? '').includes('مُدّدت'));
await ctx3.close();

check('no browser console errors', consoleErrors.length === 0, consoleErrors.join('\n'));
await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED:\n - ' + failures.join('\n - ')); process.exit(1); }
