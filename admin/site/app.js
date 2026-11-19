// Miva IRL admin: views and UI. All database access goes through api.js.
import { api, signIn, signOut, isSignedIn, currentEmail, changePassword, adminUsers, ApiError } from './api.js';
import { Scanner, parseTicketQr } from './gate.js';

const $ = (id) => document.getElementById(id);
let role = null;
let rows = [];
let scanner = null;

// Build elements with text only (never innerHTML), so names can't inject markup.
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const k of kids) if (k) n.append(k);
  return n;
}

const MESSAGES = {
  bad_login: 'Wrong email or password.',
  rate_limited: 'Too many tries. Wait a minute and try again.',
  network: 'Can’t reach the server. Check your internet connection.',
  not_authorized: 'Your account isn’t allowed to do that.',
  signed_out: 'You were logged out. Please log in again.',
  not_configured: 'The admin site isn’t set up yet.',
  bad_current: 'Your current password is wrong.',
  weak_password: 'That new password is too weak. Use at least 10 characters.',
  same_password: 'The new password must be different from the current one.',
  helper_missing: 'The password helper isn\u2019t installed in Supabase yet (Edge Function "admin-users").',
  reauth_needed: 'Supabase wants extra confirmation for password changes. Ask the super admin to reset your login instead.',
  server: 'Something went wrong. Please try again.'
};
const say = (e) => MESSAGES[e instanceof ApiError ? e.code : 'server'] || MESSAGES.server;

function flash(text, bad = false) {
  const f = $('flash');
  f.textContent = text;
  f.className = 'flash' + (bad ? ' bad' : '');
  f.hidden = !text;
}

async function guard(fn) {
  try { return await fn(); } catch (e) {
    if (e instanceof ApiError && e.code === 'signed_out') { role = null; flash(say(e), true); show('login'); return undefined; }
    flash(say(e), true);
    return undefined;
  }
}

// Follow-up links. Nigerian numbers stored as 0XXXXXXXXXX become 234XXXXXXXXXX for WhatsApp.
export function whatsappNumber(phone) {
  const d = String(phone || '').replace(/[^\d+]/g, '');
  if (/^\+\d{10,15}$/.test(d)) return d.slice(1);
  if (/^0\d{10}$/.test(d)) return '234' + d.slice(1);
  if (/^234\d{10}$/.test(d)) return d;
  return /^\d{10,15}$/.test(d) ? d : '';
}
function followUpLinks(r) {
  const hello = `Hi ${r.name}, this is the Miva IRL team about your registration (${r.ticket_code}).`;
  const wa = whatsappNumber(r.phone);
  const links = [];
  if (wa) {
    links.push(el('a', { class: 'linkbtn', href: `https://wa.me/${wa}?text=${encodeURIComponent(hello)}`,
      target: '_blank', rel: 'noopener noreferrer', text: 'WhatsApp', 'aria-label': `WhatsApp ${r.name}` }));
  }
  links.push(el('a', { class: 'linkbtn', text: 'Email', 'aria-label': `Email ${r.name}`,
    href: `mailto:${encodeURIComponent(r.email).replace(/%40/g, '@')}?subject=${encodeURIComponent('Miva IRL: your registration ' + r.ticket_code)}&body=${encodeURIComponent(hello + '\n\n')}` }));
  return links;
}

const fmt = (iso) => iso ? new Date(iso).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' }) : '';

// ------------------------------------------------------------------ views
function show(view) {
  if (!role && view !== 'login') view = 'login';
  // Admins page and My password are for the super admin only (regular admins share a password the super admin sets).
  if ((view === 'admins' || view === 'account') && role !== 'super_admin') view = 'registrations';
  if (view !== 'gate' && scanner) stopCamera();
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== 'view-' + view;
  $('nav').hidden = !role;
  for (const a of document.querySelectorAll('#nav a')) {
    if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  for (const n of document.querySelectorAll('[data-super]')) n.hidden = role !== 'super_admin';
  if (view === 'registrations') loadRegistrations();
  if (view === 'admins') loadAdmins();
  if (view === 'account') $('acc-who').textContent = 'Logged in as ' + currentEmail();
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
  $('main').focus();
}

// ------------------------------------------------------------------ login
$('login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const email = $('login-email').value.trim().toLowerCase();
  const password = $('login-password').value;
  const msg = $('login-msg');
  msg.textContent = '';
  if (!email || !password) { msg.textContent = 'Enter your email and password.'; return; }
  $('login-btn').disabled = true;
  try {
    await signIn(email, password);
    role = await api.role();
    if (!role) {
      await signOut();
      msg.textContent = 'This account isn’t an admin. Ask the super admin to add you.';
      return;
    }
    $('login-password').value = '';
    flash('');
    show('registrations');
  } catch (e) {
    msg.textContent = say(e);
  } finally {
    $('login-btn').disabled = false;
  }
});

$('logout').addEventListener('click', async () => {
  stopCamera();
  await signOut();
  role = null; rows = [];
  flash('You are logged out.');
  show('login');
});

// ---------------------------------------------------------- registrations
async function loadRegistrations() {
  const data = await guard(() => api.listRegistrations());
  if (!Array.isArray(data)) return;
  rows = data;
  renderRegistrations();
}

function matches(r, q, f) {
  if (f === 'yes' && r.attending !== 'yes') return false;
  if (f === 'no' && r.attending !== 'no') return false;
  if (f === 'unpaid' && !(r.attending === 'yes' && !r.paid)) return false;
  if (f === 'paid' && !r.paid) return false;
  if (f === 'in' && !r.checked_in_at) return false;
  if (!q) return true;
  return [r.name, r.email, r.phone, r.ticket_code].some((v) => (v || '').toLowerCase().includes(q));
}

function renderRegistrations() {
  const yes = rows.filter((r) => r.attending === 'yes');
  const stats = [['Registered', rows.length], ['Coming', yes.length], ['Paid', rows.filter((r) => r.paid).length],
    ['Checked in', rows.filter((r) => r.checked_in_at).length]];
  $('stats').replaceChildren(...stats.map(([k, v]) => el('div', {}, el('dt', { text: k }), el('dd', { text: String(v) }))));

  const q = $('search').value.trim().toLowerCase();
  const f = $('filter').value;
  const list = rows.filter((r) => matches(r, q, f));
  $('reg-count').textContent = `Showing ${list.length} of ${rows.length}`;
  $('reg-list').replaceChildren(...list.map((r) => {
    const tags = el('p', { class: 'meta' },
      el('span', { class: 'tag ' + (r.attending === 'yes' ? 'ok' : 'muted'), text: r.attending === 'yes' ? 'Coming' : 'Not coming' }),
      r.attending === 'yes' ? el('span', { class: 'tag ' + (r.paid ? 'ok' : 'bad'), text: r.paid ? 'Paid' : 'Not paid' }) : null,
      r.checked_in_at ? el('span', { class: 'tag warn', text: 'Checked in ' + fmt(r.checked_in_at) }) : null);
    const who = el('div', { class: 'who' },
      el('strong', { text: `${r.ticket_code} · ${r.name}` }),
      el('span', { class: 'meta', text: `${r.email} · ${r.phone}` }),
      r.bringing ? el('span', { class: 'meta', text: ' · Bringing: ' + r.bringing }) : null,
      tags);
    const actions = el('div', { class: 'row-actions' }, ...followUpLinks(r));
    if (r.attending === 'yes' && !r.checked_in_at) {
      actions.append(el('button', {
        type: 'button', class: r.paid ? 'secondary' : '',
        text: r.paid ? 'Mark NOT paid' : 'Mark paid',
        'aria-label': (r.paid ? 'Mark not paid: ' : 'Mark paid: ') + r.ticket_code + ' ' + r.name,
        onclick: (ev) => togglePaid(r, ev.currentTarget)
      }));
    }
    if (role === 'super_admin') {
      actions.append(el('button', {
        type: 'button', class: 'danger', text: 'Delete',
        'aria-label': 'Delete registration ' + r.ticket_code + ' ' + r.name,
        onclick: (ev) => deleteRegistration(r, ev.currentTarget)
      }));
    }
    return el('li', { class: 'row' }, who, actions);
  }));
}

// Super admin only (the database refuses everyone else too). The code must be
// typed back, so nobody deletes the wrong person by a stray tap.
async function deleteRegistration(r, btn) {
  const typed = prompt(`Delete ${r.name} (${r.ticket_code}) for good?\n` +
    `This can't be undone. Type the ticket code ${r.ticket_code} to confirm:`);
  if (typed === null) return;
  if (typed.trim().toUpperCase() !== r.ticket_code) { flash('Code didn\u2019t match. Nothing was deleted.', true); return; }
  btn.disabled = true;
  const res = await guard(() => api.deleteRegistration(r.ticket_code, typed.trim()));
  btn.disabled = false;
  if (!res) return;
  if (res.result === 'ok') { flash(`${r.ticket_code} deleted.`); loadRegistrations(); }
  else if (res.result === 'not_found') { flash('Already deleted. Refreshing the list.', true); loadRegistrations(); }
  else flash('Code didn\u2019t match. Nothing was deleted.', true);
}

async function togglePaid(r, btn) {
  if (r.paid && !confirm(`Mark ${r.ticket_code} (${r.name}) as NOT paid?`)) return;
  btn.disabled = true;
  const res = await guard(() => api.setPaid(r.ticket_code, !r.paid));
  btn.disabled = false;
  if (!res) return;
  if (res.result === 'ok') { flash(`${r.ticket_code} marked ${res.paid ? 'paid' : 'not paid'}.`); loadRegistrations(); }
  else if (res.result === 'already_checked_in') flash('That ticket was already used at the gate, so it stays paid.', true);
  else flash('Ticket not found. Refresh the list.', true);
}

$('search').addEventListener('input', renderRegistrations);
$('filter').addEventListener('change', renderRegistrations);
$('refresh').addEventListener('click', loadRegistrations);
$('export').addEventListener('click', () => {
  const cols = ['ticket_code', 'name', 'email', 'phone', 'attending', 'bringing', 'paid', 'paid_at', 'paid_by', 'checked_in_at', 'checked_in_by', 'created_at'];
  // Quote every cell; prefix cells that start with = + - @ so spreadsheets don't run them as formulas.
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = el('a', { href: url, download: 'miva-irl-registrations.csv' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

// ------------------------------------------------------------------- gate
const GATE = {
  ok: ['ok', 'ADMIT', 'Paid ticket. Let them in.'],
  already_used: ['bad', 'ALREADY USED', 'This ticket was already scanned.'],
  not_paid: ['bad', 'NOT PAID', 'Payment not confirmed. Do not admit.'],
  not_attending: ['warn', 'NOT ATTENDING', 'They registered as not coming. No ticket.'],
  not_found: ['bad', 'NOT FOUND', 'No ticket matches this code.'],
  not_ours: ['bad', 'NOT A MIVA IRL TICKET', 'This QR code is not one of our tickets.']
};

function gateResult(res) {
  const [cls, big, why] = GATE[res.result] || GATE.not_found;
  let detail = why;
  if (res.result === 'already_used' && res.checked_in_at) {
    detail += ` First used ${fmt(res.checked_in_at)}${res.checked_in_by ? ' by ' + res.checked_in_by : ''}.`;
  }
  const box = $('gate-result');
  box.className = 'gate-result ' + cls;
  box.replaceChildren(el('span', { class: 'big', text: big }),
    res.name ? el('span', { class: 'who', text: `${res.ticket_code} · ${res.name}` }) : null,
    el('span', { class: 'why', text: detail }));
  box.hidden = false;
  if (navigator.vibrate) navigator.vibrate(cls === 'ok' ? 80 : [60, 60, 60]);
  $('scan-next').hidden = !scanner;
}

async function onScan(text) {
  const token = parseTicketQr(text);
  if (!token) { gateResult({ result: 'not_ours' }); return; }
  const res = await guard(() => api.checkInToken(token));
  if (res) gateResult(res); else $('scan-next').hidden = false;
}

async function startCamera() {
  try {
    scanner = new Scanner($('cam'), onScan);
    await scanner.start();
    $('cam-start').hidden = true;
    $('cam-stop').hidden = false;
  } catch {
    scanner = null;
    flash('Can’t open the camera. Allow camera access, or type the ticket code below.', true);
  }
}
function stopCamera() {
  if (scanner) scanner.stop();
  scanner = null;
  $('cam-start').hidden = false;
  $('cam-stop').hidden = true;
  $('scan-next').hidden = true;
}

$('cam-start').addEventListener('click', startCamera);
$('cam-stop').addEventListener('click', stopCamera);
$('scan-next').addEventListener('click', () => {
  $('gate-result').hidden = true;
  $('scan-next').hidden = true;
  if (scanner) scanner.resume();
});
$('code-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const code = $('code-input').value.trim().toUpperCase();
  if (!/^MF-\d{4,}$/.test(code)) { gateResult({ result: 'not_found' }); return; }
  const res = await guard(() => api.checkInCode(code));
  if (res) { gateResult(res); $('code-input').value = ''; }
});

// ------------------------------------------------------- change password
$('pw-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('pw-msg');
  const cur = $('pw-current').value, next = $('pw-new').value, again = $('pw-confirm').value;
  msg.textContent = '';
  if (!cur || !next) { msg.textContent = 'Fill in all three boxes.'; return; }
  if (next.length < 10) { msg.textContent = 'The new password needs at least 10 characters.'; $('pw-new').focus(); return; }
  if (next !== again) { msg.textContent = 'The two new passwords don’t match.'; $('pw-confirm').focus(); return; }
  if (next === cur) { msg.textContent = MESSAGES.same_password; $('pw-new').focus(); return; }
  $('pw-btn').disabled = true;
  try {
    await changePassword(cur, next);
    for (const id of ['pw-current', 'pw-new', 'pw-confirm']) $(id).value = '';
    flash('Password changed. Use the new one next time you log in.');
  } catch (e) {
    if (e instanceof ApiError && e.code === 'signed_out') { role = null; flash(say(e), true); show('login'); return; }
    msg.textContent = say(e);
  } finally {
    $('pw-btn').disabled = false;
  }
});

// ----------------------------------------------------------------- admins
async function loadAdmins() {
  const list = await guard(() => api.listAdmins());
  if (!Array.isArray(list)) return;
  const me = currentEmail();
  $('admin-list').replaceChildren(...list.map((a) => {
    const emails = el('input', { type: 'checkbox', id: 'em-' + a.email, checked: a.receives_emails });
    emails.addEventListener('change', () => saveAdmin(a.email, a.role, emails.checked));
    return el('li', { class: 'row' },
      el('div', { class: 'who' },
        el('strong', { text: a.email + (a.email === me ? ' (you)' : '') }),
        el('span', { class: 'tag ' + (a.role === 'super_admin' ? 'warn' : 'muted'), text: a.role === 'super_admin' ? 'Super admin' : 'Admin' })),
      el('div', { class: 'row-actions' },
        el('label', { class: 'check', for: 'em-' + a.email }, emails, 'Registration emails'),
        a.email === me ? null : el('button', { type: 'button', class: 'secondary', text: 'Set password',
          'aria-label': 'Set password for ' + a.email, 'aria-expanded': 'false',
          onclick: (ev) => togglePasswordForm(ev.currentTarget, a.email) }),
        el('button', { type: 'button', class: 'danger', text: 'Remove', 'aria-label': 'Remove ' + a.email,
          onclick: () => removeAdmin(a.email) })));
  }));
}

// Inline "set password" form under an admin's row (super admin only; the
// Supabase helper re-checks this).
function togglePasswordForm(btn, email) {
  const row = btn.closest('li');
  const open = row.querySelector('form.pw-set');
  if (open) { open.remove(); btn.setAttribute('aria-expanded', 'false'); btn.focus(); return; }
  const id = 'pw-' + email.replace(/[^a-z0-9]/gi, '-');
  const input = el('input', { id, type: 'password', autocomplete: 'new-password', minlength: '10', maxlength: '200', required: true });
  const again = el('input', { id: id + '-2', type: 'password', autocomplete: 'new-password', maxlength: '200', required: true });
  const msg = el('p', { class: 'msg', role: 'alert' });
  const save = el('button', { type: 'submit', text: 'Save password' });
  const form = el('form', { class: 'pw-set card', novalidate: true },
    el('label', { for: id, text: 'New password for ' + email }), input,
    el('label', { for: id + '-2', text: 'Type it again' }), again, save, msg);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    msg.textContent = '';
    if (input.value.length < 10) { msg.textContent = 'At least 10 characters.'; input.focus(); return; }
    if (input.value !== again.value) { msg.textContent = 'The two passwords don\u2019t match.'; again.focus(); return; }
    save.disabled = true;
    try {
      const result = await adminUsers('set_password', { email, password: input.value });
      if (result === 'ok') { flash(`Password set for ${email}. Send it to them privately.`); form.remove(); btn.setAttribute('aria-expanded', 'false'); }
      else msg.textContent = ADMIN_RESULT[result] || MESSAGES.server;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'signed_out') { role = null; flash(say(e), true); show('login'); return; }
      msg.textContent = say(e);
    } finally { save.disabled = false; }
  });
  row.append(form);
  btn.setAttribute('aria-expanded', 'true');
  input.focus();
}

const ADMIN_RESULT = {
  weak_password: 'That password is too weak. Use at least 10 characters.',
  invalid_email: 'That email address isn\u2019t valid.',
  invalid_role: 'Choose Admin or Super admin.',
  not_admin: 'That person isn\u2019t an admin. Add them first.',
  not_authorized: 'Only the super admin can do that.',
  error: 'Something went wrong. Please try again.',
  ok: 'Saved.', invalid: 'That email or role isn’t valid.',
  last_super_admin: 'You can’t remove or demote the last super admin.', not_found: 'Admin not found.'
};

async function saveAdmin(email, r, emails) {
  const res = await guard(() => api.upsertAdmin(email, r, emails));
  if (res) { flash(ADMIN_RESULT[res.result] || ADMIN_RESULT.invalid, res.result !== 'ok'); loadAdmins(); }
}
async function removeAdmin(email) {
  if (!confirm(`Remove ${email} as an admin? They lose access immediately.`)) return;
  const res = await guard(() => api.removeAdmin(email));
  if (res) { flash(ADMIN_RESULT[res.result] || ADMIN_RESULT.invalid, res.result !== 'ok'); loadAdmins(); }
}
$('admin-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const email = $('admin-email').value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { flash(ADMIN_RESULT.invalid, true); return; }
  const password = $('admin-password').value;
  if (!password) {
    // Access only (they already have a login).
    await saveAdmin(email, $('admin-role').value, $('admin-emails').checked);
    $('admin-email').value = '';
    return;
  }
  if (password.length < 10) { flash(ADMIN_RESULT.weak_password, true); $('admin-password').focus(); return; }
  $('admin-add-btn').disabled = true;
  try {
    const result = await adminUsers('create', { email, password, role: $('admin-role').value, receives_emails: $('admin-emails').checked });
    if (result === 'ok') {
      flash(`${email} can now log in. Send them the password privately.`);
      $('admin-email').value = ''; $('admin-password').value = '';
      loadAdmins();
    } else flash(ADMIN_RESULT[result] || ADMIN_RESULT.error, true);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'signed_out') { role = null; flash(say(e), true); show('login'); return; }
    flash(say(e), true);
  } finally { $('admin-add-btn').disabled = false; }
});

// ------------------------------------------------------------------ start
window.addEventListener('hashchange', () => show(location.hash.slice(1) || 'registrations'));
(async function init() {
  if (isSignedIn()) {
    role = await guard(() => api.role());
    if (!role) { await signOut(); role = null; }
  }
  show(role ? (location.hash.slice(1) || 'registrations') : 'login');
})();
