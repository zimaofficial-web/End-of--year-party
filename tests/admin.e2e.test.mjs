// End-to-end tests for the admin site (admin/site).
// Run: node --test tests/admin.e2e.test.mjs
// Same approach as e2e.test.mjs: real build, real admin/vercel.json headers,
// Supabase faked at the network level. The camera test feeds Chromium a fake
// video of a real ticket QR drawn by the public site.
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
const KEY = 'sb_publishable_testkey';
const TOKEN = '3f2b8c1e-9a4d-4e7b-8c2f-1a2b3c4d5e6f';

let dir, server, base, browser, rules;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

function serve(pub) {
  return createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const file = normalize(join(pub, p));
    if (!file.startsWith(pub) || !existsSync(file)) { res.writeHead(404); return res.end(); }
    const h = {};
    for (const r of rules) if (new RegExp('^' + r.source.replace('(.*)', '.*') + '$').test(p)) for (const x of r.headers) h[x.key] = x.value;
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', ...h });
    res.end(readFileSync(file));
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'miva-admin-'));
  for (const d of ['admin', 'scripts', 'site']) cpSync(join(ROOT, d), join(dir, d), { recursive: true });
  const vj = readFileSync(join(ROOT, 'admin', 'vercel.json'), 'utf8')
    .replace(/connect-src https:\/\/[a-z0-9-]+\.supabase\.co/, 'connect-src ' + SUPA);
  writeFileSync(join(dir, 'admin', 'vercel.json'), vj);
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'build.mjs'), 'admin/site', 'admin/vercel.json', 'admin/public'],
    { env: { PATH: process.env.PATH, SUPABASE_URL: SUPA, SUPABASE_ANON_KEY: KEY }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  rules = JSON.parse(vj).headers;
  server = serve(join(dir, 'admin', 'public'));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); rmSync(dir, { recursive: true, force: true }); });

// ------------------------------------------------------------- fake Supabase
function fakeDb(roleFor = { 'super@x.com': 'super_admin', 'admin@x.com': 'admin' }) {
  const db = {
    calls: [],
    rows: [
      { ticket_code: 'MF-0001', name: 'Ada Obi', email: 'ada@x.com', phone: '08011111111', attending: 'yes', bringing: 'Zobo', paid: false, paid_at: null, paid_by: null, checked_in_at: null, checked_in_by: null, created_at: '2026-11-17T10:00:00Z' },
      { ticket_code: 'MF-0002', name: '<img src=x onerror=alert(1)>', email: 'bad@x.com', phone: '08022222222', attending: 'yes', bringing: null, paid: true, paid_at: '2026-11-17T11:00:00Z', paid_by: 'admin@x.com', checked_in_at: null, checked_in_by: null, created_at: '2026-11-17T09:00:00Z' },
      { ticket_code: 'MF-0003', name: 'Not Coming', email: 'no@x.com', phone: '08033333333', attending: 'no', bringing: null, paid: false, paid_at: null, paid_by: null, checked_in_at: null, checked_in_by: null, created_at: '2026-11-17T08:00:00Z' }
    ],
    admins: [{ email: 'super@x.com', role: 'super_admin', receives_emails: true, created_at: '2026-11-17T00:00:00Z' },
             { email: 'admin@x.com', role: 'admin', receives_emails: false, created_at: '2026-11-17T00:00:00Z' }],
    gate: { [TOKEN]: { result: 'ok', ticket_code: 'MF-0002', name: 'Paid Person' } },
    expiresIn: 3600,
    async handle(route) {
      const req = route.request();
      const url = new URL(req.url());
      const body = req.postDataJSON?.() ?? null;
      const auth = req.headers().authorization || '';
      db.calls.push({ path: url.pathname + url.search, body, auth, apikey: req.headers().apikey });
      const json = (status, data) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
      if (url.pathname === '/auth/v1/token') {
        if (url.searchParams.get('grant_type') === 'refresh_token') {
          return json(200, { access_token: 'tok:' + body.refresh_token.slice(4), refresh_token: body.refresh_token, expires_in: 3600, user: { email: body.refresh_token.slice(4) } });
        }
        if (body.password !== 'right-password') return json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
        return json(200, { access_token: 'tok:' + body.email, refresh_token: 'ref:' + body.email, expires_in: db.expiresIn, user: { email: body.email } });
      }
      if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, body: '' });
      const who = auth.startsWith('Bearer tok:') ? auth.slice('Bearer tok:'.length) : null;
      const role = who ? roleFor[who] ?? null : null;
      const fn = url.pathname.replace('/rest/v1/rpc/', '');
      if (!who) return json(401, { code: 'PGRST301', message: 'JWT invalid' });
      if (fn === 'current_admin_role') return json(200, role);
      if (!role || (fn.startsWith('super_') && role !== 'super_admin')) return json(403, { code: '42501', message: 'not_authorized' });
      if (fn === 'admin_list_rsvps') return json(200, db.rows);
      if (fn === 'admin_set_paid') {
        const r = db.rows.find((x) => x.ticket_code === body.p_ticket_code);
        if (!r) return json(200, { result: 'not_found' });
        r.paid = body.p_paid; return json(200, { result: 'ok', ticket_code: r.ticket_code, paid: r.paid });
      }
      if (fn === 'gate_check_in') {
        if (body.p_token) return json(200, db.gate[body.p_token] || { result: 'not_found' });
        if (body.p_code === 'MF-0001') return json(200, { result: 'not_paid', ticket_code: 'MF-0001', name: 'Ada Obi' });
        if (body.p_code === 'MF-0002') return json(200, { result: 'already_used', ticket_code: 'MF-0002', name: 'Paid Person', checked_in_at: '2026-12-22T10:05:00Z', checked_in_by: 'admin@x.com' });
        return json(200, { result: 'not_found' });
      }
      if (fn === 'super_list_admins') return json(200, db.admins);
      if (fn === 'super_upsert_admin') {
        const a = db.admins.find((x) => x.email === body.p_email);
        if (a) Object.assign(a, { role: body.p_role, receives_emails: body.p_receives_emails });
        else db.admins.push({ email: body.p_email, role: body.p_role, receives_emails: body.p_receives_emails, created_at: '2026-11-18T00:00:00Z' });
        return json(200, { result: 'ok' });
      }
      if (fn === 'super_remove_admin') { db.admins = db.admins.filter((x) => x.email !== body.p_email); return json(200, { result: 'ok' }); }
      return json(404, { message: 'unknown' });
    }
  };
  return db;
}

async function open(db, opts = {}, b = browser) {
  const context = await b.newContext(opts);
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('dialog', (d) => d.accept());
  await page.route(`${SUPA}/**`, (r) => db.handle(r));
  await page.goto(base + '/');
  await page.waitForSelector('#view-login:not([hidden])');
  return { page, context, problems };
}
async function login(page, email) {
  await page.fill('#login-email', email);
  await page.fill('#login-password', 'right-password');
  await page.click('#login-btn');
}
const rpcCalls = (db, fn) => db.calls.filter((c) => c.path === '/rest/v1/rpc/' + fn);

// ===================================================================== tests
test('admin site: loads under its strict CSP, login shown, not indexed, no sign-up', async () => {
  const db = fakeDb();
  const { page, context, problems } = await open(db);
  assert.equal(await page.getAttribute('meta[name=robots]', 'content'), 'noindex, nofollow');
  assert.equal(await page.isHidden('#nav'), true);
  assert.doesNotMatch(await page.locator('body').innerText(), /sign up|create account|register/i);
  assert.deepEqual(problems, []);
  await context.close();
});

test('wrong password: friendly message, nothing else called', async () => {
  const db = fakeDb();
  const { page, context } = await open(db);
  await page.fill('#login-email', 'admin@x.com');
  await page.fill('#login-password', 'nope');
  await page.click('#login-btn');
  await page.waitForFunction(() => document.getElementById('login-msg').textContent.length > 0);
  assert.equal(await page.innerText('#login-msg'), 'Wrong email or password.');
  assert.equal(rpcCalls(db, 'current_admin_role').length, 0);
  await context.close();
});

test('valid login but not an admin: refused and logged out', async () => {
  const db = fakeDb();
  const { page, context } = await open(db);
  await login(page, 'student@x.com');
  await page.waitForFunction(() => /isn’t an admin/.test(document.getElementById('login-msg').textContent));
  assert.ok(db.calls.some((c) => c.path === '/auth/v1/logout'));
  assert.equal(await page.isHidden('#nav'), true);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('mivaAdminSession')), null);
  await context.close();
});

test('admin: sees registrations and stats; names shown as text; no Admins tab', async () => {
  const db = fakeDb();
  const { page, context, problems } = await open(db);
  await login(page, 'admin@x.com');
  await page.waitForSelector('#reg-list li');
  assert.equal(await page.locator('#reg-list li').count(), 3);
  assert.match(await page.innerText('#stats'), /Registered\s*3[\s\S]*Coming\s*2[\s\S]*Paid\s*1[\s\S]*Checked in\s*0/i);
  assert.equal(await page.locator('#reg-list img').count(), 0, 'HTML in a name is not rendered');
  assert.match(await page.innerText('#reg-list'), /<img src=x onerror=alert\(1\)>/);
  assert.equal(await page.isHidden('[data-super]'), true);
  const call = rpcCalls(db, 'admin_list_rsvps')[0];
  assert.equal(call.auth, 'Bearer tok:admin@x.com', 'uses the admin’s own token');
  assert.equal(call.apikey, KEY, 'only the publishable key');
  assert.deepEqual(problems, []);
  await context.close();
});

test('admin: search and filter', async () => {
  const db = fakeDb();
  const { page, context } = await open(db);
  await login(page, 'admin@x.com');
  await page.waitForSelector('#reg-list li');
  await page.fill('#search', 'mf-0001');
  assert.equal(await page.locator('#reg-list li').count(), 1);
  await page.fill('#search', '');
  await page.selectOption('#filter', 'unpaid');
  assert.equal(await page.locator('#reg-list li').count(), 1);
  assert.match(await page.innerText('#reg-list'), /Ada Obi/);
  await page.selectOption('#filter', 'no');
  assert.match(await page.innerText('#reg-list'), /Not Coming/);
  await context.close();
});

test('admin: Mark paid calls admin_set_paid for that ticket and refreshes', async () => {
  const db = fakeDb();
  const { page, context } = await open(db);
  await login(page, 'admin@x.com');
  await page.waitForSelector('#reg-list li');
  await page.click('button[aria-label="Mark paid: MF-0001 Ada Obi"]');
  await page.waitForFunction(() => /MF-0001 marked paid/.test(document.getElementById('flash').textContent));
  assert.deepEqual(rpcCalls(db, 'admin_set_paid')[0].body, { p_ticket_code: 'MF-0001', p_paid: true });
  assert.ok(rpcCalls(db, 'admin_list_rsvps').length >= 2, 'list reloaded');
  await context.close();
});

test('CSV export: all rows, formula-looking cells neutralised', async () => {
  const db = fakeDb();
  db.rows[0].bringing = '=HYPERLINK("http://evil")';
  const { page, context } = await open(db);
  await login(page, 'admin@x.com');
  await page.waitForSelector('#reg-list li');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
  assert.equal(dl.suggestedFilename(), 'miva-fest-registrations.csv');
  const csv = readFileSync(await dl.path(), 'utf8');
  assert.equal(csv.trim().split('\r\n').length, 4);
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/evil""\)"/);
  await context.close();
});

test('gate: typed codes show NOT PAID / ALREADY USED / NOT FOUND clearly', async () => {
  const db = fakeDb();
  const { page, context } = await open(db);
  await login(page, 'admin@x.com');
  await page.click('a[data-view=gate]');
  const check = async (code) => {
    await page.fill('#code-input', code);
    await page.click('#code-form button');
    await page.waitForFunction(() => !document.getElementById('gate-result').hidden);
    const t = await page.innerText('#gate-result');
    await page.evaluate(() => { document.getElementById('gate-result').hidden = true; });
    return t;
  };
  assert.match(await check('mf-0001'), /NOT PAID[\s\S]*MF-0001 · Ada Obi/);
  assert.match(await check('MF-0002'), /ALREADY USED[\s\S]*First used .* by admin@x\.com/);
  assert.match(await check('MF-9999'), /NOT FOUND/);
  assert.match(await check('hello'), /NOT FOUND/);
  assert.equal(rpcCalls(db, 'gate_check_in').length, 3, 'invalid format not sent');
  await context.close();
});

test('super admin: Admins tab, add admin, switch emails, remove', async () => {
  const db = fakeDb();
  const { page, context, problems } = await open(db);
  await login(page, 'super@x.com');
  await page.waitForSelector('#reg-list li');
  assert.equal(await page.isHidden('[data-super]'), false);
  await page.click('a[data-view=admins]');
  await page.waitForSelector('#admin-list li');
  assert.match(await page.innerText('#admin-list'), /super@x\.com \(you\)/);
  await page.fill('#admin-email', 'New@X.com');
  await page.check('#admin-emails');
  await page.click('#admin-form button');
  await page.waitForFunction(() => document.querySelectorAll('#admin-list li').length === 3);
  assert.deepEqual(rpcCalls(db, 'super_upsert_admin')[0].body, { p_email: 'new@x.com', p_role: 'admin', p_receives_emails: true });
  await page.check('input[id="em-admin@x.com"]');
  await page.waitForFunction(() => document.getElementById('flash').textContent === 'Saved.');
  assert.deepEqual(rpcCalls(db, 'super_upsert_admin')[1].body, { p_email: 'admin@x.com', p_role: 'admin', p_receives_emails: true });
  await page.click('button[aria-label="Remove new@x.com"]');
  await page.waitForFunction(() => document.querySelectorAll('#admin-list li').length === 2);
  assert.deepEqual(problems, []);
  await context.close();
});

test('regular admin typing #admins is sent back to registrations', async () => {
  const db = fakeDb();
  const { page, context } = await open(db);
  await login(page, 'admin@x.com');
  await page.waitForSelector('#reg-list li');
  await page.evaluate(() => { location.hash = '#admins'; });
  await page.waitForFunction(() => location.hash === '#registrations');
  assert.equal(await page.isHidden('#view-admins'), true);
  assert.equal(rpcCalls(db, 'super_list_admins').length, 0);
  await context.close();
});

test('expired session is refreshed automatically', async () => {
  const db = fakeDb();
  db.expiresIn = 30; // < 60 s, so the next call refreshes first
  const { page, context } = await open(db);
  await login(page, 'admin@x.com');
  await page.waitForSelector('#reg-list li');
  assert.ok(db.calls.some((c) => c.path === '/auth/v1/token?grant_type=refresh_token'));
  await context.close();
});

test('server says 401 (token revoked): back to login with a message', async () => {
  const db = fakeDb();
  const { page, context } = await open(db);
  await login(page, 'admin@x.com');
  await page.waitForSelector('#reg-list li');
  await page.route(`${SUPA}/rest/v1/rpc/admin_list_rsvps`, (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
  await page.click('#refresh');
  await page.waitForSelector('#view-login:not([hidden])');
  assert.match(await page.innerText('#flash'), /logged out/);
  await context.close();
});

test('logout clears the session', async () => {
  const db = fakeDb();
  const { page, context } = await open(db);
  await login(page, 'admin@x.com');
  await page.waitForSelector('#reg-list li');
  await page.click('#logout');
  await page.waitForSelector('#view-login:not([hidden])');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('mivaAdminSession')), null);
  await context.close();
});

test('mobile 375px: no sideways scroll on registrations and gate', async () => {
  const db = fakeDb();
  const { page, context } = await open(db, { viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true });
  await login(page, 'admin@x.com');
  await page.waitForSelector('#reg-list li');
  for (const v of ['registrations', 'gate']) {
    await page.evaluate((h) => { location.hash = '#' + h; }, v);
    await page.waitForSelector(`#view-${v}:not([hidden])`);
    const d = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    assert.ok(d[0] <= d[1], `${v}: ${d[0]}px wide in ${d[1]}px`);
  }
  await context.close();
});

// ---------------------------------------------------- camera: real QR → ADMIT
// Draw a real ticket with the PUBLIC site's code, turn it into a fake webcam
// video (Y4M), and check the gate reads it and admits the ticket.
async function ticketVideo() {
  const page = await browser.newPage();
  await page.setContent('<canvas id=c></canvas>');
  await page.addScriptTag({ path: join(ROOT, 'site', 'vendor', 'qrcode.js') });
  const { w, h, data } = await page.evaluate((token) => {
    const qr = window.qrcode(0, 'M'); qr.addData('MIVAFEST1:' + token); qr.make();
    const n = qr.getModuleCount(), W = 640, H = 480, cell = Math.floor(400 / (n + 8));
    const c = document.getElementById('c'); c.width = W; c.height = H;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.fillStyle = '#000';
    const x0 = (W - cell * (n + 8)) / 2 + 4 * cell, y0 = (H - cell * (n + 8)) / 2 + 4 * cell;
    for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (qr.isDark(r, k)) g.fillRect(x0 + k * cell, y0 + r * cell, cell, cell);
    const d = g.getImageData(0, 0, W, H);
    return { w: W, h: H, data: Array.from(d.data) };
  }, TOKEN);
  await page.close();
  // RGBA -> Y4M (4:2:0). Black/white only, so a straight luma conversion is exact enough.
  const Y = Buffer.alloc(w * h), U = Buffer.alloc((w / 2) * (h / 2), 128), V = Buffer.alloc((w / 2) * (h / 2), 128);
  for (let i = 0; i < w * h; i++) Y[i] = Math.round(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), Y, U, V]);
  const file = join(dir, 'ticket.y4m');
  writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${w} H${h} F10:1 Ip A1:1 C420jpeg\n`), frame, frame, frame]));
  return file;
}

test('gate camera: scanning a real ticket QR sends its token and shows ADMIT', async () => {
  const video = await ticketVideo();
  const camBrowser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`]
  });
  try {
    const db = fakeDb();
    const { page, context, problems } = await open(db, { permissions: ['camera'] }, camBrowser);
    await login(page, 'admin@x.com');
    await page.waitForSelector('#reg-list li');
    await page.click('a[data-view=gate]');
    await page.click('#cam-start');
    await page.waitForFunction(() => !document.getElementById('gate-result').hidden, null, { timeout: 15000 });
    assert.match(await page.innerText('#gate-result'), /ADMIT[\s\S]*MF-0002 · Paid Person/);
    assert.deepEqual(rpcCalls(db, 'gate_check_in')[0].body, { p_token: TOKEN, p_code: null });
    assert.equal(rpcCalls(db, 'gate_check_in').length, 1, 'scanner pauses after a read (no double check-in)');
    assert.equal(await page.isVisible('#scan-next'), true);
    assert.deepEqual(problems, [], 'camera works under the admin CSP');
    // leaving the gate view turns the camera off
    await page.click('a[data-view=registrations]');
    await page.waitForFunction(() => document.getElementById('cam').srcObject === null);
    await context.close();
  } finally {
    await camBrowser.close();
  }
});
