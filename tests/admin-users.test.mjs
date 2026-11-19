// Tests for the admin-users Edge Function (super admin creates logins / sets passwords).
// Run: node --test tests/admin-users.test.mjs
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'https://p.supabase.co';
const SECRET = 'sb_secret_test';
let handle, calls, users, admins, failGrant;

before(async () => {
  globalThis.Deno = { serve: () => {}, env: { get: (k) => ({ SUPABASE_URL: BASE, SUPABASE_SERVICE_ROLE_KEY: SECRET })[k] } };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    const h = init.headers || {};
    calls.push({ path: u.pathname + u.search, method: init.method || 'GET', headers: h, body });
    const json = (s, d) => new Response(JSON.stringify(d), { status: s });
    const token = (h.Authorization || '').replace('Bearer ', '');
    if (u.pathname === '/rest/v1/rpc/current_admin_role') return json(200, { 'tok-super': 'super_admin', 'tok-admin': 'admin' }[token] ?? null);
    if (u.pathname === '/rest/v1/rpc/super_upsert_admin') {
      if (token !== 'tok-super') return json(403, { code: '42501' });
      if (failGrant) return json(200, { result: 'invalid' });
      admins.push(body.p_email); return json(200, { result: 'ok' });
    }
    if (u.pathname === '/rest/v1/rpc/super_list_admins') return json(200, admins.map((email) => ({ email })));
    if (u.pathname === '/auth/v1/admin/users' && init.method === 'POST') {
      if (h.apikey !== SECRET) return json(401, {});
      if (body.password === 'weakweakweak') return json(422, { error_code: 'weak_password', msg: 'Password is known to be weak' });
      if (users.some((x) => x.email === body.email)) return json(422, { error_code: 'email_exists', msg: 'A user with this email address has already been registered' });
      users.push({ id: 'id-' + users.length, email: body.email, password: body.password }); return json(200, { id: 'x' });
    }
    if (u.pathname === '/auth/v1/admin/users') return json(200, { users: users.map(({ id, email }) => ({ id, email })) });
    if (u.pathname.startsWith('/auth/v1/admin/users/') && init.method === 'PUT') {
      const x = users.find((v) => v.id === decodeURIComponent(u.pathname.split('/').pop()));
      if (!x) return json(404, {});
      if (body.password === 'weakweakweak') return json(422, { error_code: 'weak_password' });
      x.password = body.password; return json(200, { id: x.id });
    }
    return json(404, {});
  };
  ({ handle } = await import('../supabase/functions/admin-users/index.ts'));
});
beforeEach(() => {
  calls = []; failGrant = false;
  users = [{ id: 'id-super', email: 'zimaofficial001@gmail.com', password: 'mine' }, { id: 'id-l', email: 'louissainaboya@gmail.com', password: 'old' }];
  admins = ['zimaofficial001@gmail.com', 'louissainaboya@gmail.com'];
});

const post = (token, body) => handle(new Request('https://fn/admin-users', {
  method: 'POST', headers: { authorization: `Bearer ${token}`, apikey: 'sb_publishable_x', origin: 'https://miva-fest-admin.vercel.app' },
  body: JSON.stringify(body)
}));
const result = async (res) => (await res.json()).result;

test('only the super admin is allowed (admin and strangers get 403, nothing changes)', async () => {
  for (const t of ['tok-admin', 'tok-stranger', '']) {
    const res = await post(t, { action: 'set_password', email: 'louissainaboya@gmail.com', password: 'a long password' });
    assert.equal(res.status, 403);
    assert.equal(await result(res), 'not_authorized');
  }
  assert.ok(!calls.some((c) => c.path.startsWith('/auth/v1/admin')), 'secret-key API never called');
  assert.equal(users[1].password, 'old');
});

test('caller is checked with THEIR token, the secret key is only used for the Auth admin API', async () => {
  await post('tok-super', { action: 'set_password', email: 'louissainaboya@gmail.com', password: 'shared password 1' });
  const role = calls.find((c) => c.path === '/rest/v1/rpc/current_admin_role');
  assert.equal(role.headers.Authorization, 'Bearer tok-super');
  assert.equal(role.headers.apikey, 'sb_publishable_x');
  for (const c of calls.filter((x) => x.path.startsWith('/auth/v1/admin'))) {
    assert.equal(c.headers.apikey, SECRET);
    assert.equal(c.headers.Authorization, undefined, 'non-JWT secret key goes in apikey only');
  }
});

test('set_password: super admin sets an admin password', async () => {
  assert.equal(await result(await post('tok-super', { action: 'set_password', email: ' LouissaInaboya@gmail.com ', password: 'shared password 1' })), 'ok');
  assert.equal(users[1].password, 'shared password 1');
});

test('set_password: refuses people who are not admins, short passwords, bad emails', async () => {
  users.push({ id: 'id-s', email: 'student@x.com', password: 's' });
  assert.equal(await result(await post('tok-super', { action: 'set_password', email: 'student@x.com', password: 'a long password' })), 'not_admin');
  assert.equal(users[2].password, 's');
  assert.equal(await result(await post('tok-super', { action: 'set_password', email: 'louissainaboya@gmail.com', password: 'short' })), 'weak_password');
  assert.equal(await result(await post('tok-super', { action: 'set_password', email: 'nope', password: 'a long password' })), 'invalid_email');
  assert.equal(await result(await post('tok-super', { action: 'set_password', email: 'louissainaboya@gmail.com', password: 'weakweakweak' })), 'weak_password');
});

test('create: makes a confirmed login AND grants admin access through the database check', async () => {
  assert.equal(await result(await post('tok-super', { action: 'create', email: 'New@X.com', password: 'shared password 1', role: 'admin', receives_emails: true })), 'ok');
  const made = calls.find((c) => c.path === '/auth/v1/admin/users' && c.method === 'POST');
  assert.deepEqual(made.body, { email: 'new@x.com', password: 'shared password 1', email_confirm: true });
  const grant = calls.find((c) => c.path === '/rest/v1/rpc/super_upsert_admin');
  assert.deepEqual(grant.body, { p_email: 'new@x.com', p_role: 'admin', p_receives_emails: true });
  assert.equal(grant.headers.Authorization, 'Bearer tok-super', 'access granted as the super admin, not with the secret key');
  assert.ok(admins.includes('new@x.com'));
});

test('create for someone who already has a login: sets their password instead, and grants access', async () => {
  users.push({ id: 'id-e', email: 'helper@x.com', password: 'old' });
  assert.equal(await result(await post('tok-super', { action: 'create', email: 'helper@x.com', password: 'shared password 1', role: 'admin' })), 'ok');
  assert.equal(users.find((u) => u.email === 'helper@x.com').password, 'shared password 1');
  assert.ok(admins.includes('helper@x.com'));
});

test('create: unknown role refused; failure to grant access reports an error', async () => {
  assert.equal(await result(await post('tok-super', { action: 'create', email: 'a@x.com', password: 'shared password 1', role: 'owner' })), 'invalid_role');
  failGrant = true;
  const res = await post('tok-super', { action: 'create', email: 'b@x.com', password: 'shared password 1', role: 'admin' });
  assert.equal(res.status, 500);
  assert.equal(await result(res), 'error');
});

test('browser rules: preflight answered, only the admin site may call it', async () => {
  const res = await handle(new Request('https://fn/admin-users', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://miva-fest-admin.vercel.app');
  assert.match(res.headers.get('access-control-allow-headers'), /authorization/);
});
