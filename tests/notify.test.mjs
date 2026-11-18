// Tests for the notify-rsvp Edge Function.
// Run: node --test tests/notify.test.mjs   (Node 22.18+ runs the .ts files directly)
// The real index.ts is loaded with a tiny stand-in for Deno.serve / Deno.env and
// a fake fetch, so the whole request flow is exercised without any network.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEmail, escapeHtml, oneLine, safeEqual, isValidRecord } from '../supabase/functions/notify-rsvp/email.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'test-webhook-secret-0123456789';
const record = {
  id: '11111111-2222-3333-4444-555555555555', ticket_code: 'MF-0042', name: 'Ada <b>Obi</b>',
  email: 'ada@example.com', phone: '+2348012345678', attending: 'yes', bringing: 'Zobo & chin-chin',
  consent: true, consent_at: '2026-11-18T19:35:00Z', policy_version: 'v1-2026-11-17',
  created_at: '2026-11-18T19:35:00Z', ticket_token: '9f9f9f9f-aaaa-4bbb-8ccc-dddddddddddd', notified: false
};

// ------------------------------------------------------------ pure helpers
test('subject: no emoji, name + Yes/No + ticket code', () => {
  const { subject } = buildEmail(record);
  assert.equal(subject, 'Miva IRL RSVP: Ada <b>Obi</b> (Yes) - MF-0042');
  assert.doesNotMatch(subject, /\p{Extended_Pictographic}/u);
});
test('subject cannot be broken onto new header lines', () => {
  const { subject } = buildEmail({ ...record, name: 'Eve\r\nBcc: victim@example.com' });
  assert.doesNotMatch(subject, /[\r\n]/);
});
test('HTML body escapes everything the person typed', () => {
  const { html } = buildEmail(record);
  assert.match(html, /Ada &lt;b&gt;Obi&lt;\/b&gt;/);
  assert.match(html, /Zobo &amp; chin-chin/);
  assert.doesNotMatch(html, /<b>Obi<\/b>/);
});
test('email never contains the secret QR token', () => {
  const { html, text, subject } = buildEmail(record);
  for (const s of [html, text, subject]) assert.ok(!s.includes(record.ticket_token));
});
test('body has the fields and Lagos time', () => {
  const { text } = buildEmail(record);
  for (const k of ['Ticket code: MF-0042', 'Email address: ada@example.com', 'Phone number: +2348012345678', 'Coming: Yes', 'Bringing: Zobo & chin-chin'])
    assert.ok(text.includes(k), k);
  assert.match(text, /Submitted at .*8:35.*pm.*\(WAT\)/i);
});
test('helpers: escapeHtml, oneLine, safeEqual, isValidRecord', () => {
  assert.equal(escapeHtml(`<"'&>`), '&lt;&quot;&#39;&amp;&gt;');
  assert.equal(oneLine('a\n\tb'), 'a b');
  assert.equal(oneLine('x'.repeat(100)).length, 80);
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abd'));
  assert.ok(!safeEqual('', ''));
  assert.ok(isValidRecord(record));
  assert.ok(!isValidRecord({ ...record, attending: 'maybe' }));
});

// ------------------------------------------------------- whole handler
let handler;
const secrets = { WEBHOOK_SECRET: SECRET, RESEND_API_KEY: 're_test', SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test' };
let calls = [];
let recipients = [{ email: 'zimaofficial001@gmail.com' }];
let resendStatus = 200;

before(async () => {
  globalThis.Deno = { serve: (h) => { handler = h; }, env: { get: (k) => secrets[k] } };
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/rest/v1/admins')) return new Response(JSON.stringify(recipients), { status: 200 });
    if (String(url).startsWith('https://api.resend.com/')) return new Response('{}', { status: resendStatus });
    if (String(url).includes('/rest/v1/rsvps')) return new Response(null, { status: 204 });
    return new Response('?', { status: 404 });
  };
  await import('../supabase/functions/notify-rsvp/index.ts');
  assert.equal(typeof handler, 'function');
});

const post = (body, headers = { 'x-webhook-secret': SECRET }) =>
  handler(new Request('https://fn/notify-rsvp', { method: 'POST', headers, body: JSON.stringify(body) }));
const insert = { type: 'INSERT', table: 'rsvps', schema: 'public', record, old_record: null };

test('handler: wrong or missing secret -> 401, nothing sent', async () => {
  calls = [];
  assert.equal((await post(insert, { 'x-webhook-secret': 'nope' })).status, 401);
  assert.equal((await post(insert, {})).status, 401);
  assert.equal(calls.length, 0);
});
test('handler: valid insert -> looks up recipients, sends one email, marks notified', async () => {
  calls = [];
  const res = await post(insert);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { sent: 1 });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://p.supabase.co/rest/v1/admins?select=email&receives_emails=eq.true');
  assert.equal(calls[0].init.headers.apikey, 'sb_secret_test');
  assert.equal(calls[0].init.headers.Authorization, undefined, 'non-JWT secret key goes in apikey only');
  const mail = JSON.parse(calls[1].init.body);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer re_test');
  assert.deepEqual(mail.to, ['zimaofficial001@gmail.com']);
  assert.equal(mail.from, 'Miva IRL <onboarding@resend.dev>');
  assert.equal(mail.subject, 'Miva IRL RSVP: Ada <b>Obi</b> (Yes) - MF-0042');
  assert.equal(calls[2].init.method, 'PATCH');
  assert.equal(calls[2].url, `https://p.supabase.co/rest/v1/rsvps?id=eq.${record.id}`);
  assert.deepEqual(JSON.parse(calls[2].init.body), { notified: true });
});
test('handler: no admin has emails on -> nothing sent, not an error', async () => {
  calls = []; recipients = [];
  const res = await post(insert);
  assert.deepEqual(await res.json(), { sent: 0, reason: 'no recipients' });
  assert.equal(calls.length, 1);
  recipients = [{ email: 'zimaofficial001@gmail.com' }];
});
test('handler: email provider fails -> 500 and row NOT marked notified', async () => {
  calls = []; resendStatus = 403;
  const res = await post(insert);
  assert.equal(res.status, 500);
  assert.ok(!calls.some((c) => c.init.method === 'PATCH'));
  resendStatus = 200;
});
test('handler: other tables/events are ignored; bad records rejected', async () => {
  calls = [];
  assert.deepEqual(await (await post({ ...insert, type: 'UPDATE' })).json(), { skipped: true });
  assert.deepEqual(await (await post({ ...insert, table: 'admins' })).json(), { skipped: true });
  assert.equal((await post({ ...insert, record: { id: 1 } })).status, 400);
  assert.equal(calls.length, 0);
});

test('paste-into-dashboard.ts is up to date with index.ts + email.ts', () => {
  const dir = join(ROOT, 'supabase', 'functions', 'notify-rsvp');
  const want = readFileSync(join(dir, 'paste-into-dashboard.ts'), 'utf8');
  const email = readFileSync(join(dir, 'email.ts'), 'utf8');
  const index = readFileSync(join(dir, 'index.ts'), 'utf8');
  assert.ok(want.includes(email.replace(/^export /gm, '')), 'contains email.ts');
  assert.ok(want.includes(index.replace(/^import .* from '\.\/email\.ts';\n/m, '')), 'contains index.ts');
});
