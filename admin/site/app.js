// Miva Fest admin: views and UI. All database access goes through api.js.
import { api, signIn, signOut, isSignedIn, currentEmail, ApiError } from './api.js';
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

const fmt = (iso) => iso ? new Date(iso).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' }) : '';

// ------------------------------------------------------------------ views
function show(view) {
  if (!role && view !== 'login') view = 'login';
  if (view === 'admins' && role !== 'super_admin') view = 'registrations';
  if (view !== 'gate' && scanner) stopCamera();
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== 'view-' + view;
  $('nav').hidden = !role;
  for (const a of document.querySelectorAll('#nav a')) {
    if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  document.querySelector('[data-super]').hidden = role !== 'super_admin';
  if (view === 'registrations') loadRegistrations();
  if (view === 'admins') loadAdmins();
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
    const actions = el('div', { class: 'row-actions' });
    if (r.attending === 'yes' && !r.checked_in_at) {
      actions.append(el('button', {
        type: 'button', class: r.paid ? 'secondary' : '',
        text: r.paid ? 'Mark NOT paid' : 'Mark paid',
        'aria-label': (r.paid ? 'Mark not paid: ' : 'Mark paid: ') + r.ticket_code + ' ' + r.name,
        onclick: (ev) => togglePaid(r, ev.currentTarget)
      }));
    }
    return el('li', { class: 'row' }, who, actions);
  }));
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
  const a = el('a', { href: url, download: 'miva-fest-registrations.csv' });
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
  not_ours: ['bad', 'NOT A MIVA FEST TICKET', 'This QR code is not one of our tickets.']
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
        el('button', { type: 'button', class: 'danger', text: 'Remove', 'aria-label': 'Remove ' + a.email,
          onclick: () => removeAdmin(a.email) })));
  }));
}

const ADMIN_RESULT = {
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
  await saveAdmin(email, $('admin-role').value, $('admin-emails').checked);
  $('admin-email').value = '';
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
