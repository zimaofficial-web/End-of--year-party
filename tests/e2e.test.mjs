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
  // Point connect-src at the test project (or the placeholder, to test the guard).
  vj = vj.replace(/connect-src https:\/\/[a-z0-9-]+\.supabase\.co/, 'connect-src ' + (cspUrl || 'https://YOUR-PROJECT-REF.supabase.co'));
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
  const { mailFails, ...ctxOpts } = opts;
  opts = { mailFails };
  const context = await browser.newContext(ctxOpts);
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
  const mails = [];
  await page.route('https://formsubmit.co/**', (route) => {
    mails.push({ url: route.request().url(), headers: route.request().headers(), body: route.request().postDataJSON() });
    if (opts.mailFails) return route.abort('failed');
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":"true"}' });
  });
  return { page, context, calls, problems, mails };
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
  for (const f of ['index.html', 'styles.css', 'app.js', 'config.js', 'vendor/qrcode.js']) assert.ok(existsSync(join(pub, f)), f);
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
  assert.match(text, /Pay the ₦3,000 gate fee by bank transfer/);
  assert.doesNotMatch(text, /PAYMENT INSTRUCTIONS TO BE ADDED/);
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

const waitMails = (mails, n) => new Promise((ok, fail) => {
  const t0 = Date.now();
  (function poll() { if (mails.length >= n) return ok(); if (Date.now() - t0 > 5000) return fail(new Error('no email copy')); setImmediate(poll); })();
});

test('email copy: after a saved "yes" registration, FormSubmit gets the details (no QR token)', async () => {
  const { page, context, mails, problems } = await openPage(okJson({ status: 'created', ticket_code: 'MF-0042', ticket_token: TOKEN }));
  await fillValid(page, 'yes');
  await page.click('#send');
  await page.waitForSelector('#result canvas');
  await waitMails(mails, 1);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].url, 'https://formsubmit.co/ajax/zimaofficial001%40gmail.com');
  const b = mails[0].body;
  assert.equal(b._subject, 'Miva Wrap Party RSVP: Ada Obi (Yes) - MF-0042');
  assert.doesNotMatch(b._subject, /\p{Extended_Pictographic}/u);
  assert.equal(b['Full name'], 'Ada Obi');
  assert.equal(b['Email address'], 'ada.obi@example.com');
  assert.equal(b['Phone / WhatsApp'], '+2348080633426');
  assert.equal(b['Bringing'], 'Zobo');
  assert.equal(b._template, 'table');
  assert.ok(!JSON.stringify(b).includes(TOKEN), 'QR token never emailed');
  assert.deepEqual(problems, [], 'allowed by the CSP');
  await context.close();
});

test('email copy: not sent for duplicate, invalid, rate-limited, error or honeypot', async () => {
  for (const reply of [{ status: 'duplicate' }, { status: 'invalid' }, { status: 'rate_limited' }, { status: 'rejected' }]) {
    const { page, context, mails } = await openPage(okJson(reply));
    await fillValid(page);
    await page.click('#send');
    await page.waitForFunction(() => !document.getElementById('result').hidden);
    assert.equal(mails.length, 0, reply.status);
    await context.close();
  }
  const { page, context, mails } = await openPage(okJson({ status: 'created', ticket_code: 'MF-0042', ticket_token: TOKEN }));
  await fillValid(page);
  await page.evaluate(() => { document.getElementById('site').value = 'bot'; });
  await page.click('#send');
  await page.waitForFunction(() => !document.getElementById('result').hidden);
  assert.equal(mails.length, 0, 'honeypot');
  await context.close();
});

test('email copy failing does not affect the registration', async () => {
  const { page, context, mails } = await openPage(okJson({ status: 'created', ticket_code: 'MF-0042', ticket_token: TOKEN }), { mailFails: true });
  await fillValid(page, 'yes');
  await page.click('#send');
  await page.waitForSelector('#result canvas');
  assert.match(await resultText(page), /Registration received/);
  await waitMails(mails, 1);
  await context.close();
});

test('privacy note: short version (no FormSubmit line, delete contact kept)', async () => {
  const { page, context } = await openPage(null);
  const note = await page.innerText('#consent-note');
  assert.doesNotMatch(note, /FormSubmit|To see or/);
  assert.match(note, /To delete your details, email zimaofficial001@gmail\.com or WhatsApp \+234 808 063 3426\./);
  await context.close();
});

test('hero: event name shown, and title text never overlaps the corner circles (phone to wide screen)', async () => {
  for (const width of [320, 390, 768, 1024, 1280, 1920]) {
    const { page, context } = await openPage(null, { viewport: { width, height: 800 }, reducedMotion: 'reduce' });
    assert.match(await page.innerText('h1'), /MIVA\s+WRAP\s*PARTY/i);
    assert.equal(await page.innerText('.hero .sub'), '2026');
    const hit = await page.evaluate(() => {
      // rectangles of the actual text (letters), not of the block boxes around them
      const lines = [];
      for (const sel of ['.hero .eyebrow', '.hero h1', '.hero .sub', '.hero .tag', '.hero .organised', '.hero .cta']) {
        const walk = document.createTreeWalker(document.querySelector(sel), NodeFilter.SHOW_TEXT);
        while (walk.nextNode()) {
          if (!walk.currentNode.textContent.trim()) continue;
          const rg = document.createRange(); rg.selectNodeContents(walk.currentNode); lines.push(...rg.getClientRects());
        }
      }
      const r = document.querySelector('.r1').getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2, rad = r.width / 2;
      return lines.some((l) => Math.hypot(Math.max(l.left, Math.min(cx, l.right)) - cx, Math.max(l.top, Math.min(cy, l.bottom)) - cy) < rad);
    });
    assert.equal(hit, false, `overlap at ${width}px`);
    await context.close();
  }
});

test('sponsors card with WhatsApp link', async () => {
  const { page, context } = await openPage(null);
  const card = page.locator('.card', { hasText: 'Sponsors welcome' });
  assert.equal(await card.count(), 1);
  assert.equal(await card.locator('a').getAttribute('href'), 'https://wa.me/2348080633426');
  assert.equal(await card.locator('a').getAttribute('rel'), 'noopener noreferrer');
  await context.close();
});

test('the gate fee shown is ₦3,000 (the old ₦1,000 line is gone)', async () => {
  const { page, context } = await openPage(null);
  const text = await page.locator('body').innerText();
  assert.doesNotMatch(text, /1,000/);
  assert.match(text, /Gate fee is ₦3,000 per person\. No refunds\./i);
  assert.match(await page.innerText('.ticket .stub'), /Gate fee/i);
  assert.doesNotMatch(text, /Admit one/i);
  await context.close();
});

const TOKEN = '3f2b8c1e-9a4d-4e7b-8c2f-1a2b3c4d5e6f';
test('"yes" ticket: code + QR shown; QR decodes to MIVAFEST1:<token> with the gate scanner library', async () => {
  const { page, context, problems } = await openPage(okJson({ status: 'created', ticket_code: 'MF-0042', ticket_token: TOKEN }));
  await fillValid(page, 'yes');
  await page.click('#send');
  await page.waitForSelector('#result canvas');
  const text = await resultText(page);
  assert.match(text, /Registration received/);
  assert.match(text, /Your ticket code is MF-0042/);
  assert.doesNotMatch(text, /PAYMENT INSTRUCTIONS TO BE ADDED/);
  assert.equal(await page.getAttribute('#result canvas', 'aria-label'), 'Ticket QR code for MF-0042');
  // Read the pixels and decode with the same jsQR file the gate page uses.
  const img = await page.evaluate(() => {
    const c = document.querySelector('#result canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    return { w: d.width, h: d.height, data: Array.from(d.data) };
  });
  const jsQR = require(join(ROOT, 'admin', 'site', 'vendor', 'jsQR.js'));
  const decoded = jsQR(Uint8ClampedArray.from(img.data), img.w, img.h);
  assert.ok(decoded, 'QR could not be decoded');
  assert.equal(decoded.data, 'MIVAFEST1:' + TOKEN);
  assert.doesNotMatch(decoded.data, /Ada|example\.com|0808/, 'QR holds no personal data');
  assert.deepEqual(problems, []);
  await context.close();
});

test('payment: OPay bank details with the ticket code as narration; Copy buttons copy the right values', async () => {
  const { page, context, problems } = await openPage(okJson({ status: 'created', ticket_code: 'MF-0042', ticket_token: TOKEN }));
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await fillValid(page, 'yes');
  await page.click('#send');
  await page.waitForSelector('#result .pay-box');
  const box = await page.innerText('#result .pay-box');
  for (const part of [/Pay ₦3,000 gate fee/, /Bank\s+OPay/, /Account number\s+7044916819/, /Account name\s+Obirai Ozioma/, /Amount\s+₦3,000/, /Narration\s+MF-0042/, /Use your ticket code MF-0042 as the transfer narration/, /No refunds/])
    assert.match(box, part);
  await page.click('button[aria-label="Copy account number"]');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '7044916819');
  await page.waitForFunction(() => document.querySelector('button[aria-label="Copy account number"]').textContent === 'Copied');
  await page.click('button[aria-label="Copy ticket code"]');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'MF-0042');
  // payment details come before the QR ticket
  const order = await page.evaluate(() => {
    const kids = [...document.getElementById('result').children].map((n) => n.className);
    return kids.indexOf('pay-box') < kids.indexOf('ticket-out');
  });
  assert.ok(order);
  assert.deepEqual(problems, []);
  await context.close();
});

test('payment box is not shown for "no", duplicates, or the honeypot', async () => {
  for (const [reply, attend, bot] of [[{ status: 'created', ticket_code: 'MF-0043' }, 'no', false], [{ status: 'duplicate' }, 'yes', false], [{ status: 'created', ticket_code: 'MF-0044', ticket_token: TOKEN }, 'yes', true]]) {
    const { page, context } = await openPage(okJson(reply));
    await fillValid(page, attend);
    if (bot) await page.evaluate(() => { document.getElementById('site').value = 'bot'; });
    await page.click('#send');
    await page.waitForFunction(() => !document.getElementById('result').hidden);
    assert.equal(await page.locator('#result .pay-box').count(), 0, JSON.stringify(reply));
    assert.doesNotMatch(await resultText(page), /7044916819/);
    await context.close();
  }
});

test('"Save ticket" downloads a PNG named after the ticket code', async () => {
  const { page, context, problems } = await openPage(okJson({ status: 'created', ticket_code: 'MF-0042', ticket_token: TOKEN }));
  await fillValid(page, 'yes');
  await page.click('#send');
  await page.waitForSelector('#result .save-ticket');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#result .save-ticket')]);
  assert.equal(download.suggestedFilename(), 'miva-wrap-party-ticket-MF-0042.png');
  const path = await download.path();
  const head = readFileSync(path).subarray(0, 8).toString('hex');
  assert.equal(head, '89504e470d0a1a0a', 'file is a PNG');
  assert.deepEqual(problems, [], 'download works under the strict CSP');
  await context.close();
});

test('"no" answer with a code gets no QR ticket', async () => {
  const { page, context } = await openPage(okJson({ status: 'created', ticket_code: 'MF-0043' }));
  await fillValid(page, 'no');
  await page.click('#send');
  await page.waitForFunction(() => !document.getElementById('result').hidden);
  assert.equal(await page.locator('#result canvas').count(), 0);
  assert.match(await resultText(page), /We’ll miss you/);
  await context.close();
});

test('malformed ticket data from the server is ignored, not drawn', async () => {
  const { page, context } = await openPage(okJson({ status: 'created', ticket_code: '<b>x</b>', ticket_token: 'not-a-uuid' }));
  await fillValid(page, 'yes');
  await page.click('#send');
  await page.waitForFunction(() => !document.getElementById('result').hidden);
  assert.match(await resultText(page), /Registration received/);
  assert.doesNotMatch(await resultText(page), /<b>|ticket code is/);
  assert.equal(await page.locator('#result canvas').count(), 0);
  await context.close();
});

test('duplicate answer (new object format) shows the duplicate message', async () => {
  const { page, context } = await openPage(okJson({ status: 'duplicate' }));
  await fillValid(page);
  await page.click('#send');
  await page.waitForFunction(() => !document.getElementById('result').hidden);
  assert.match(await resultText(page), /already registered/);
  assert.equal(await page.locator('#result canvas').count(), 0);
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
  // after the title animation, every word sits in place, fully shown
  const end = await page.evaluate(() => ['.t-miva', '.t-wrap', '.t-party', '.hero .sub'].map((sel) => {
    const cs = getComputedStyle(document.querySelector(sel));
    const t = cs.transform === 'matrix(1, 0, 0, 1, 0, 0)' ? 'none' : cs.transform;   // identity = in place
    return [cs.opacity, t];
  }));
  assert.deepEqual(end, [['1', 'none'], ['1', 'none'], ['1', 'none'], ['1', 'none']]);
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
    getComputedStyle(document.querySelector('.t-miva')).animationName,
    getComputedStyle(document.querySelector('.t-wrap')).animationName,
    getComputedStyle(document.querySelector('.t-party')).animationName,
    getComputedStyle(document.querySelector('.hero .sub')).animationName,
    getComputedStyle(document.querySelector('.r1')).animationName
  ]);
  assert.deepEqual(anim, ['none', 'none', 'none', 'none', 'none']);
  await context.close();
});

test('title animation order: MIVA, then WRAP comes out of it, then PARTY, then 2026', async () => {
  const { page, context } = await openPage(null, { reducedMotion: 'no-preference' });
  const a = await page.evaluate(() => ['.t-miva', '.t-wrap', '.t-party', '.hero .sub'].map((sel) => {
    const cs = getComputedStyle(document.querySelector(sel));
    return { name: cs.animationName, delay: parseFloat(cs.animationDelay) };
  }));
  assert.deepEqual(a.map((x) => x.name), ['rise', 'wrap-out', 'party-out', 'year-pop']);
  assert.ok(a[0].delay < a[1].delay && a[1].delay < a[2].delay && a[2].delay < a[3].delay, JSON.stringify(a));
  // screen readers still get the plain name
  assert.equal((await page.locator('h1').textContent()).replace(/\s+/g, ' ').trim(), 'Miva Wrap Party');
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
