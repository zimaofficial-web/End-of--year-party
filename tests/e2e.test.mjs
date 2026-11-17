// End-to-end tests for the registration page.
// Run: node --test tests/
//
// * Builds the site exactly like Vercel does (scripts/build.mjs) into a temp dir.
// * Serves it with the REAL headers from vercel.json (CSP included), so any CSP
//   violation in the page fails the tests.
// * Intercepts the Supabase call at the network level (Playwright routing),
//   so no real database is touched. The database itself is tested by
//   supabase/tests/rsvps_test.sql.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUPA = 'https://testproject.supabase.co';
const RPC = `${SUPA}/rest/v1/rpc/register_rsvp`;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const ANON_JWT = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'anon', iss: 'supabase' })}.sig`;
const SERVICE_JWT = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'service_role', iss: 'supabase' })}.sig`;

// ---------------------------------------------------------------- build helpers
function makeProjectCopy({ cspUrl }) {
  const dir = mkdtempSync(join(tmpdir(), 'miva-build-'));
  cpSync(join(ROOT, 'site'), join(dir, 'site'), { recursive: true });
  cpSync(join(ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true });
  let vj = readFileSync(join(ROOT, 'vercel.json'), 'utf8');
  if (cspUrl) vj = vj.replace('https://YOUR-PROJECT-REF.supabase.co', cspUrl);
  writeFileSync(join(dir, 'vercel.json'), vj);
  return dir;
}
function runBuild(dir, env) {
  return spawnSync(process.execPath, [join(dir, 'scripts', 'build.mjs')], {
    env: { PATH: process.env.PATH, ...env }, encoding: 'utf8'
  });
}

// ------------------------------------------------------------ static server
let server, base, browser, buildDir, headerRules;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

function headersFor(path) {
  const out = {};
  for (const rule of headerRules) {
    const re = new RegExp('^' + rule.source.replace('(.*)', '.*') + '$');
    if (re.test(path)) for (const h of rule.headers) out[h.key] = h.value;
  }
  return out;
}

before(async () => {
  buildDir = makeProjectCopy({ cspUrl: SUPA });
  const r = runBuild(buildDir, { SUPABASE_URL: SUPA, SUPABASE_ANON_KEY: ANON_JWT });
  assert.equal(r.status, 0, r.stderr);
  headerRules = JSON.parse(readFileSync(join(buildDir, 'vercel.json'), 'utf8')).headers;
  const pub = join(buildDir, 'public');
  server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const file = normalize(join(pub, p));
    if (!file.startsWith(pub) || !existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', ...headersFor(p) });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
  if (buildDir) rmSync(buildDir, { recursive: true, force: true });
});

// A page with: CSP-violation capture, fonts stubbed, RPC mocked by `handler`.
async function openPage(handler, opts = {}) {
  const context = await browser.newContext(opts);
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  const calls = [];
  await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route(`${SUPA}/**`, async (route) => {
    calls.push({ url: route.request().url(), headers: route.request().headers(), body: route.request().postDataJSON() });
    if (handler) return handler(route);
    return route.fulfill({ status: 500, body: 'unexpected call' });
  });
  await page.goto(base + '/');
  return { page, context, calls, problems };
}
const okJson = (v) => (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(v) });

async function fillValid(page, attend = 'yes') {
  await page.fill('#name', 'Ada Obi');
  await page.fill('#email', 'Ada.Obi@Example.com');
  await page.fill('#phone', '+234 808-063-3426');
  await page.check(`input[name=attend][value=${attend}]`);
  await page.fill('#bring', 'Zobo');
  await page.check('#consent');
}
const resultText = (page) => page.locator('#result').innerText();

// ======================================================================= tests

test('build: refuses to run without env vars', () => {
  const dir = makeProjectCopy({ cspUrl: SUPA });
  const r = runBuild(dir, {});
  rmSync(dir, { recursive: true, force: true });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /SUPABASE_URL is not set/);
});

test('build: refuses a service_role key', () => {
  const dir = makeProjectCopy({ cspUrl: SUPA });
  const r = runBuild(dir, { SUPABASE_URL: SUPA, SUPABASE_ANON_KEY: SERVICE_JWT });
  rmSync(dir, { recursive: true, force: true });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /role "service_role"/);
});

test('build: refuses an sb_secret_ key', () => {
  const dir = makeProjectCopy({ cspUrl: SUPA });
  const r = runBuild(dir, { SUPABASE_URL: SUPA, SUPABASE_ANON_KEY: 'sb_secret_abc123' });
  rmSync(dir, { recursive: true, force: true });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /SECRET key/);
});

test('build: refuses while vercel.json CSP still has the placeholder project', () => {
  const dir = makeProjectCopy({ cspUrl: null });
  const r = runBuild(dir, { SUPABASE_URL: SUPA, SUPABASE_ANON_KEY: ANON_JWT });
  rmSync(dir, { recursive: true, force: true });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /connect-src does not include/);
});

test('build: output contains only the page files + anon config, no docs/SQL/scripts', () => {
  const pub = join(buildDir, 'public');
  for (const f of ['index.html', 'styles.css', 'app.js', 'config.js']) assert.ok(existsSync(join(pub, f)), f);
  for (const f of ['supabase', 'scripts', 'docs', 'vercel.json']) assert.ok(!existsSync(join(pub, f)), f);
  const cfg = readFileSync(join(pub, 'config.js'), 'utf8');
  assert.match(cfg, /testproject\.supabase\.co/);
  assert.doesNotMatch(cfg, /service_role|sb_secret_/);
});

test('page loads under the strict CSP with zero violations; consent is unticked', async () => {
  const { page, context, problems } = await openPage(null);
  assert.equal(await page.isChecked('#consent'), false);
  assert.equal(await page.locator('h1').count(), 1);
  await page.waitForFunction(() => window.MIVA_CONFIG && document.readyState === 'complete');
  assert.deepEqual(problems, []);
  await context.close();
});

test('invalid submit: errors, aria-invalid, focus on first error, nothing sent', async () => {
  const { page, context, calls, problems } = await openPage(okJson('created'));
  await page.fill('#email', 'not-an-email');
  await page.click('#send');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'name');
  assert.equal(await page.getAttribute('#name', 'aria-invalid'), 'true');
  assert.equal(await page.getAttribute('#email', 'aria-invalid'), 'true');
  assert.equal(await page.getAttribute('#phone', 'aria-invalid'), 'true');
  assert.equal(await page.getAttribute('#consent', 'aria-invalid'), 'true');
  assert.match(await page.innerText('#name-err'), /Enter your name/);
  assert.match(await page.innerText('#email-err'), /valid email/);
  assert.match(await page.innerText('#attend-err'), /yes or no/);
  assert.match(await page.innerText('#consent-err'), /Tick the box/);
  // error text is wired to its field
  assert.equal(await page.getAttribute('#email', 'aria-describedby'), 'email-err');
  assert.match(await page.getAttribute('#consent', 'aria-describedby'), /consent-note/);
  assert.equal(calls.length, 0);
  assert.deepEqual(problems, []);
  await context.close();
});

test('valid "yes" submit: button disabled while sending, correct payload, success + payment placeholder', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { page, context, calls, problems } = await openPage(async (route) => { await gate; return okJson('created')(route); });
  await fillValid(page, 'yes');
  await page.click('#send');
  await page.waitForFunction(() => document.getElementById('send').disabled === true);
  assert.equal(await page.innerText('#send'), 'SENDING…');
  release();
  await page.waitForFunction(() => !document.getElementById('result').hidden);
  assert.equal(await page.isDisabled('#send'), false);
  const text = await resultText(page);
  assert.match(text, /Registration received/);
  assert.match(text, /\[PAYMENT INSTRUCTIONS TO BE ADDED\]/);
  assert.equal(await page.getAttribute('#result', 'role'), 'status');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, RPC);
  assert.deepEqual(calls[0].body, {
    p_name: 'Ada Obi', p_email: 'ada.obi@example.com', p_phone: '+2348080633426',
    p_attending: 'yes', p_bringing: 'Zobo', p_consent: true, p_site: ''
  });
  assert.equal(calls[0].headers.apikey, ANON_JWT);
  assert.equal(await page.inputValue('#name'), '', 'form reset after success');
  assert.deepEqual(problems, []);
  await context.close();
});

test('valid "no" submit: friendly message, no payment instructions', async () => {
  const { page, context } = await openPage(okJson('created'));
  await fillValid(page, 'no');
  await page.click('#send');
  await page.waitForFunction(() => !document.getElementById('result').hidden);
  const text = await resultText(page);
  assert.match(text, /Thanks for letting us know/);
  assert.match(text, /We’ll miss you/);
  assert.doesNotMatch(text, /PAYMENT/);
  await context.close();
});

test('duplicate email: clear message with contact, form kept', async () => {
  const { page, context } = await openPage(okJson('duplicate'));
  await fillValid(page);
  await page.click('#send');
  await page.waitForFunction(() => !document.getElementById('result').hidden);
  const text = await resultText(page);
  assert.match(text, /already registered/);
  assert.match(text, /zimaofficial001@gmail\.com/);
  assert.equal(await page.inputValue('#name'), 'Ada Obi');
  await context.close();
});

test('rate limited: friendly wait message', async () => {
  const { page, context } = await openPage(okJson('rate_limited'));
  await fillValid(page);
  await page.click('#send');
  await page.waitForFunction(() => !document.getElementById('result').hidden);
  assert.match(await resultText(page), /Too many attempts/);
  await context.close();
});

test('server error: raw server text is never shown', async () => {
  const secret = 'relation "public.rsvps" violates check constraint rsvps_email_check';
  const { page, context } = await openPage((route) =>
    route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: secret, code: '23514' }) }));
  await fillValid(page);
  await page.click('#send');
  await page.waitForFunction(() => !document.getElementById('result').hidden);
  const text = await resultText(page);
  assert.match(text, /Something went wrong/);
  assert.doesNotMatch(text, /rsvps|constraint|23514/);
  assert.equal(await page.isDisabled('#send'), false, 'button re-enabled so they can retry');
  await context.close();
});

test('unexpected 200 body is treated as an error, not shown', async () => {
  const { page, context } = await openPage(okJson('<img src=x onerror=alert(1)>'));
  await fillValid(page);
  await page.click('#send');
  await page.waitForFunction(() => !document.getElementById('result').hidden);
  assert.match(await resultText(page), /Something went wrong/);
  assert.equal(await page.locator('#result img').count(), 0);
  await context.close();
});

test('network failure: friendly message', async () => {
  const { page, context } = await openPage((route) => route.abort('internetdisconnected'));
  await fillValid(page);
  await page.click('#send');
  await page.waitForFunction(() => !document.getElementById('result').hidden);
  assert.match(await resultText(page), /not saved/);
  await context.close();
});

test('honeypot filled: nothing is sent, bot sees fake success', async () => {
  const { page, context, calls } = await openPage(okJson('created'));
  await fillValid(page);
  await page.evaluate(() => { document.getElementById('site').value = 'http://spam.example'; });
  await page.click('#send');
  await page.waitForFunction(() => !document.getElementById('result').hidden);
  assert.match(await resultText(page), /Registration received/);
  assert.equal(calls.length, 0);
  await context.close();
});

test('names with HTML are shown as text, not markup', async () => {
  const { page, context } = await openPage(okJson('created'));
  await fillValid(page);
  await page.fill('#name', '<b>Bold</b>');
  await page.click('#send');
  await page.waitForFunction(() => !document.getElementById('result').hidden);
  assert.match(await resultText(page), /<b>Bold<\/b>/);
  assert.equal(await page.locator('#result b').count(), 0);
  await context.close();
});

test('motion allowed: every section is fully visible once scrolled into view', async () => {
  const { page, context } = await openPage(null, { reducedMotion: 'no-preference', viewport: { width: 375, height: 740 } });
  // hero text finishes rising in
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((a) => !(a.timeline instanceof (window.ViewTimeline || function () {})))
    .filter((a) => a.effect && a.effect.getComputedTiming().iterations !== Infinity)
    .map((a) => a.finished)));
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.hero h1')).opacity), '1');
  const n = await page.locator('.reveal .wrap').count();
  for (let i = 0; i < n; i++) {
    const el = page.locator('.reveal .wrap').nth(i);
    await el.evaluate((e) => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const op = Number(await el.evaluate((e) => getComputedStyle(e).opacity));
    assert.ok(op > 0.95, `section ${i} opacity ${op} after scrolling to it`);
  }
  await context.close();
});

test('mobile (375px): no horizontal scroll, form fits, tap targets >= 44px', async () => {
  const { page, context, problems } = await openPage(null, { viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const dims = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  assert.ok(dims.sw <= dims.w, `page is ${dims.sw}px wide in a ${dims.w}px viewport`);
  const form = await page.locator('#rsvp').boundingBox();
  assert.ok(form.x >= 0 && form.x + form.width <= 375, 'form inside viewport');
  for (const sel of ['#send', '#name', '.radios label >> nth=0', '.cta']) {
    const b = await page.locator(sel).boundingBox();
    assert.ok(b.height >= 44, `${sel} is ${b.height}px tall`);
  }
  await page.screenshot({ path: join(ROOT, 'tests', 'screenshots', 'mobile-375.png'), fullPage: true });
  assert.deepEqual(problems, []);
  await context.close();
});

test('reduced motion: animations are switched off', async () => {
  const { page, context } = await openPage(null, { reducedMotion: 'reduce' });
  const anim = await page.evaluate(() => [
    getComputedStyle(document.querySelector('h1')).animationName,
    getComputedStyle(document.querySelector('.r1')).animationName
  ]);
  assert.deepEqual(anim, ['none', 'none']);
  await context.close();
});

test('motion allowed: hero animations are active', async () => {
  const { page, context } = await openPage(null, { reducedMotion: 'no-preference' });
  const anim = await page.evaluate(() => getComputedStyle(document.querySelector('.r1')).animationName);
  assert.equal(anim, 'pulse');
  await context.close();
});

test('keyboard: skip link is the first Tab stop and jumps to the form', async () => {
  const { page, context } = await openPage(null);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'skip');
  await context.close();
});

test('missing config: tells the user registration is not open, sends nothing', async () => {
  const { page, context, calls } = await openPage(okJson('created'));
  await page.evaluate(() => { Object.defineProperty(window, 'MIVA_CONFIG', { value: undefined }); });
  await fillValid(page);
  await page.click('#send');
  await page.waitForFunction(() => !document.getElementById('result').hidden);
  assert.match(await resultText(page), /isn’t open yet/);
  assert.equal(calls.length, 0);
  await context.close();
});
