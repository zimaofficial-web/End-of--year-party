// Supabase Edge Function: let the SUPER ADMIN create admin logins and set
// admin passwords from the admin site, without the Supabase dashboard.
//
// Why a function: creating logins / setting other people's passwords needs
// the secret service-role key. That key must never be in a website, so it
// stays here, on Supabase's side.
//
// Deploy: Supabase > Edge Functions > Deploy a new function > Via Editor,
// name it  admin-users , paste this whole file, Deploy.
// Keep "Verify JWT" ON (only logged-in users can even reach it).
// Secrets used (provided automatically by Supabase): SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY. Nothing to add.
//
// Every request is checked: the caller's own login token is used to ask the
// database "what is my admin role?" (public.current_admin_role). Anything but
// super_admin is refused. Admin access itself is still granted by the
// database function public.super_upsert_admin, called with the caller's token.
//
// Request (POST JSON):
//   { "action": "create",       "email", "password", "role", "receives_emails" }
//   { "action": "set_password", "email", "password" }
// "create" for someone who already has a login sets their password instead.
// Response: { "result": "ok" | "not_authorized" | "invalid_email" | "invalid_role"
//             | "weak_password" | "not_found" | "not_admin" | "error" }

const ALLOWED_ORIGIN = 'https://miva-fest-admin.vercel.app';
const TIMEOUT_MS = 10000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Browsers may call this only from the admin site.
function cors(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin'
  };
}

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing secret ${name}`);
  return v;
}

async function call(url: string, init: RequestInit): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT_MS);
  try { return await fetch(url, { ...init, signal: c.signal }); } finally { clearTimeout(t); }
}

// Headers for the Auth admin API using the secret key (never leaves Supabase).
function adminHeaders(): Record<string, string> {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const h: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' };
  if (key.split('.').length === 3) h.Authorization = `Bearer ${key}`;
  return h;
}

// Headers that act AS THE CALLER (their own token), for database checks.
function callerHeaders(req: Request): Record<string, string> {
  const apikey = req.headers.get('apikey') || Deno.env.get('SUPABASE_ANON_KEY') || '';
  return { apikey, Authorization: req.headers.get('authorization') || '', 'Content-Type': 'application/json' };
}

async function rpcAsCaller(req: Request, fn: string, args: Record<string, unknown>) {
  const r = await call(`${env('SUPABASE_URL')}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: callerHeaders(req), body: JSON.stringify(args)
  });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => null) };
}

async function findUserId(email: string): Promise<string | null> {
  // Few admins, so walk the user list (max 1000 per page, 10 pages).
  for (let page = 1; page <= 10; page++) {
    const r = await call(`${env('SUPABASE_URL')}/auth/v1/admin/users?page=${page}&per_page=1000`, { headers: adminHeaders() });
    if (!r.ok) throw new Error(`list users ${r.status}`);
    const body = await r.json();
    const users: { id: string; email?: string }[] = body.users ?? [];
    const hit = users.find((u) => (u.email || '').toLowerCase() === email);
    if (hit) return hit.id;
    if (users.length < 1000) return null;
  }
  return null;
}

async function setPassword(id: string, password: string): Promise<'ok' | 'weak_password'> {
  const r = await call(`${env('SUPABASE_URL')}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: adminHeaders(), body: JSON.stringify({ password, email_confirm: true })
  });
  const data = await r.json().catch(() => null);
  if (r.ok) return 'ok';
  if (weak(r.status, data)) return 'weak_password';
  throw new Error(`set password ${r.status}`);
}

function weak(status: number, data: unknown): boolean {
  const d = data as Record<string, unknown> | null;
  return d?.error_code === 'weak_password' || (status === 422 && /password/i.test(JSON.stringify(d ?? '')) && !/exist/i.test(JSON.stringify(d ?? '')));
}

export async function handle(req: Request): Promise<Response> {
  const headers = { ...cors(), 'Content-Type': 'application/json' };
  const reply = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers });
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  if (req.method !== 'POST') return reply(405, { result: 'error' });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply(400, { result: 'error' }); }

  try {
    // 1. Only the super admin may use this.
    const who = await rpcAsCaller(req, 'current_admin_role', {});
    if (!who.ok || who.data !== 'super_admin') return reply(403, { result: 'not_authorized' });

    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    if (!EMAIL.test(email) || email.length > 120) return reply(200, { result: 'invalid_email' });
    if (password.length < 10 || password.length > 200) return reply(200, { result: 'weak_password' });

    if (body.action === 'create') {
      const role = String(body.role ?? 'admin');
      if (role !== 'admin' && role !== 'super_admin') return reply(200, { result: 'invalid_role' });
      const r = await call(`${env('SUPABASE_URL')}/auth/v1/admin/users`, {
        method: 'POST', headers: adminHeaders(),
        body: JSON.stringify({ email, password, email_confirm: true })
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) {
        const text = JSON.stringify(data ?? '');
        if (weak(r.status, data)) return reply(200, { result: 'weak_password' });
        if (!(r.status === 422 && /already|exist|registered/i.test(text))) throw new Error(`create user ${r.status}`);
        // Login already exists: set the new password on it instead.
        const id = await findUserId(email);
        if (!id) throw new Error('existing user not found');
        const upd = await setPassword(id, password);
        if (upd !== 'ok') return reply(200, { result: upd });
      }
      // Give access through the database's own super-admin check.
      const grant = await rpcAsCaller(req, 'super_upsert_admin',
        { p_email: email, p_role: role, p_receives_emails: body.receives_emails === true });
      if (!grant.ok || grant.data?.result !== 'ok') throw new Error('grant access failed');
      return reply(200, { result: 'ok' });
    }

    if (body.action === 'set_password') {
      // Only for people who are admins (not any random account).
      const list = await rpcAsCaller(req, 'super_list_admins', {});
      if (!list.ok || !Array.isArray(list.data)) throw new Error('list admins failed');
      if (!list.data.some((a: { email: string }) => a.email === email)) return reply(200, { result: 'not_admin' });
      const id = await findUserId(email);
      if (!id) return reply(200, { result: 'not_found' });
      return reply(200, { result: await setPassword(id, password) });
    }

    return reply(400, { result: 'error' });
  } catch (e) {
    // Log the reason only; never passwords or tokens.
    console.error('admin-users failed:', e instanceof Error ? e.message : 'unknown');
    return reply(500, { result: 'error' });
  }
}

Deno.serve(handle);
