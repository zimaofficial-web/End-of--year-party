// Miva IRL admin: login session + database calls.
// The only module that talks to Supabase. Uses the public publishable/anon
// key plus the logged-in admin's own access token. No secret keys, ever.

const TIMEOUT_MS = 10000;
const STORE_KEY = 'mivaAdminSession';

function cfg() {
  const c = window.MIVA_CONFIG;
  if (!c || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(c.supabaseUrl) || !c.anonKey) {
    throw new ApiError('not_configured');
  }
  return c;
}

export class ApiError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// ---------------------------------------------------------------- session
// Kept in sessionStorage: cleared when the tab/browser is closed.
let session = null;

function load() {
  if (session) return session;
  try { session = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null'); } catch { session = null; }
  return session;
}
function save(s) {
  session = s;
  try {
    if (s) sessionStorage.setItem(STORE_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(STORE_KEY);
  } catch { /* private mode: keep in memory only */ }
}

async function request(path, { method = 'POST', body, token } = {}) {
  const c = cfg();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers = { 'Content-Type': 'application/json', apikey: c.anonKey };
  if (token) headers.Authorization = 'Bearer ' + token;
  else if (c.anonKey.split('.').length === 3) headers.Authorization = 'Bearer ' + c.anonKey;
  try {
    const res = await fetch(c.supabaseUrl + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal, credentials: 'omit', cache: 'no-store'
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { ok: res.ok, status: res.status, data };
  } catch {
    throw new ApiError('network');
  } finally {
    clearTimeout(timer);
  }
}

function fromTokenResponse(d) {
  if (!d || typeof d.access_token !== 'string' || typeof d.refresh_token !== 'string') return null;
  const expiresAt = typeof d.expires_at === 'number' ? d.expires_at * 1000 : Date.now() + (d.expires_in || 3600) * 1000;
  const email = d.user && typeof d.user.email === 'string' ? d.user.email.toLowerCase() : '';
  return { accessToken: d.access_token, refreshToken: d.refresh_token, expiresAt, email };
}

export async function signIn(email, password) {
  const r = await request('/auth/v1/token?grant_type=password', { body: { email, password } });
  if (r.status === 400 || r.status === 401) throw new ApiError('bad_login');
  if (r.status === 429) throw new ApiError('rate_limited');
  const s = r.ok ? fromTokenResponse(r.data) : null;
  if (!s) throw new ApiError('server');
  save(s);
  return s;
}

async function freshToken() {
  const s = load();
  if (!s) throw new ApiError('signed_out');
  if (Date.now() < s.expiresAt - 60000) return s.accessToken;
  const r = await request('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: s.refreshToken } });
  const n = r.ok ? fromTokenResponse(r.data) : null;
  if (!n) { save(null); throw new ApiError('signed_out'); }
  save(n);
  return n.accessToken;
}

export async function signOut() {
  const s = load();
  save(null);
  if (s) {
    try { await request('/auth/v1/logout', { token: s.accessToken }); } catch { /* already signed out locally */ }
  }
}

// Change the logged-in admin's own password. The current password is checked
// first (so a phone left logged in can't be used to lock the owner out).
// Super admin: create an admin login / set an admin's password. Goes through
// the Supabase Edge Function "admin-users", which holds the secret key and
// re-checks that the caller is the super admin.
// Supabase gave the deployed "admin-users" function this web address (slug).
const ADMIN_USERS_FUNCTION = 'smart-endpoint';
export async function adminUsers(action, payload) {
  const token = await freshToken();
  const r = await request('/functions/v1/' + ADMIN_USERS_FUNCTION, { body: { action, ...payload }, token });
  if (r.status === 401) { save(null); throw new ApiError('signed_out'); }
  if (r.status === 403) throw new ApiError('not_authorized');
  if (r.status === 404) throw new ApiError('helper_missing');
  const result = r.data && r.data.result;
  if (typeof result !== 'string') throw new ApiError('server');
  return result;
}

export async function changePassword(currentPassword, newPassword) {
  const email = currentEmail();
  if (!email) throw new ApiError('signed_out');
  const check = await request('/auth/v1/token?grant_type=password', { body: { email, password: currentPassword } });
  if (check.status === 400 || check.status === 401) throw new ApiError('bad_current');
  if (check.status === 429) throw new ApiError('rate_limited');
  const s = check.ok ? fromTokenResponse(check.data) : null;
  if (!s) throw new ApiError('server');
  save(s);
  const r = await request('/auth/v1/user', { method: 'PUT', body: { password: newPassword }, token: s.accessToken });
  if (r.ok) return true;
  const code = (r.data && (r.data.error_code || r.data.code)) || '';
  if (code === 'same_password') throw new ApiError('same_password');
  if (code === 'weak_password' || (r.status === 422 && /weak|short|character/i.test(JSON.stringify(r.data)))) {
    throw new ApiError('weak_password');
  }
  if (code === 'reauthentication_needed') throw new ApiError('reauth_needed');
  if (r.status === 429) throw new ApiError('rate_limited');
  throw new ApiError('server');
}

export function currentEmail() {
  const s = load();
  return s ? s.email : '';
}

// ------------------------------------------------------------------- RPCs
async function rpc(name, args = {}) {
  const token = await freshToken();
  const r = await request('/rest/v1/rpc/' + name, { body: args, token });
  if (r.status === 401) { save(null); throw new ApiError('signed_out'); }
  if (r.status === 403 || (r.data && r.data.code === '42501')) throw new ApiError('not_authorized');
  if (!r.ok) throw new ApiError('server');
  return r.data;
}

export const api = {
  role: () => rpc('current_admin_role'),
  listRegistrations: () => rpc('admin_list_rsvps'),
  setPaid: (ticketCode, paid) => rpc('admin_set_paid', { p_ticket_code: ticketCode, p_paid: paid }),
  checkInToken: (token) => rpc('gate_check_in', { p_token: token, p_code: null }),
  checkInCode: (code) => rpc('gate_check_in', { p_token: null, p_code: code }),
  listAdmins: () => rpc('super_list_admins'),
  upsertAdmin: (email, role, receivesEmails) =>
    rpc('super_upsert_admin', { p_email: email, p_role: role, p_receives_emails: receivesEmails }),
  removeAdmin: (email) => rpc('super_remove_admin', { p_email: email }),
  deleteRegistration: (ticketCode, confirmCode) =>
    rpc('super_delete_rsvp', { p_ticket_code: ticketCode, p_confirm: confirmCode })
};

export function isSignedIn() { return !!load(); }
