/* Miva Fest registration form.
 *
 * Layers (top to bottom):
 *   1. CONTACT / MESSAGES  - all user-facing text in one place
 *   2. registrationApi     - the only code that knows about Supabase
 *   3. validate()          - client-side checks (mirrors the database CHECKs)
 *   4. form wiring         - accessibility, button state, result display
 *
 * Config comes from config.js, which is generated at build time from
 * environment variables (scripts/build.mjs). It only ever holds the public
 * anon key. Never put a service_role key anywhere near this file.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------ 1. messages
  var CONTACT = 'email zimaofficial001@gmail.com or WhatsApp +234 808 063 3426';
  var MESSAGES = {
    createdYes: function (name) {
      return ['Registration received', 'Thanks, ' + name + '. [PAYMENT INSTRUCTIONS TO BE ADDED]'];
    },
    createdNo: function (name) {
      return ['Thanks for letting us know', 'Thanks, ' + name + '. We’ll miss you!'];
    },
    duplicate: ['Already registered',
      'This email is already registered. To change your details, ' + CONTACT + '.'],
    invalid: ['Please check your details',
      'Something in the form doesn’t look right. Check each field and try again.'],
    rateLimited: ['Too many attempts',
      'Please wait about 10 minutes and try again.'],
    network: ['Something went wrong',
      'Your registration was not saved. Check your internet connection and try again.'],
    notOpen: ['Registration isn’t open yet',
      'Nothing was saved. Please try again later.']
  };

  // ------------------------------------------------------ 2. registrationApi
  // Calls the database function public.register_rsvp through Supabase's REST
  // API. Returns one of: created | duplicate | invalid | rate_limited |
  // rejected | error. Never exposes raw server errors to the caller.
  var registrationApi = {
    TIMEOUT_MS: 10000,

    isConfigured: function () {
      var c = window.MIVA_CONFIG;
      return !!(c && /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(c.supabaseUrl) && c.anonKey);
    },

    register: async function (data) {
      var c = window.MIVA_CONFIG;
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, registrationApi.TIMEOUT_MS);
      var headers = { 'Content-Type': 'application/json', 'apikey': c.anonKey };
      // Legacy anon keys are JWTs and also go in Authorization. New
      // publishable keys (sb_publishable_...) only go in apikey.
      if (c.anonKey.split('.').length === 3) headers.Authorization = 'Bearer ' + c.anonKey;
      try {
        var res = await fetch(c.supabaseUrl + '/rest/v1/rpc/register_rsvp', {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({
            p_name: data.name,
            p_email: data.email,
            p_phone: data.phone,
            p_attending: data.attending,
            p_bringing: data.bringing,
            p_consent: data.consent,
            p_site: data.site
          }),
          signal: controller.signal,
          credentials: 'omit',
          cache: 'no-store'
        });
        if (!res.ok) return 'error';
        var status = await res.json();
        var known = ['created', 'duplicate', 'invalid', 'rate_limited', 'rejected'];
        return known.indexOf(status) !== -1 ? status : 'error';
      } catch (e) {
        return 'error';
      } finally {
        clearTimeout(timer);
      }
    }
  };

  // ------------------------------------------------------------ 3. validate
  var form = document.getElementById('rsvp');
  var result = document.getElementById('result');
  var send = document.getElementById('send');
  if (!form || !result || !send) return;

  function setErr(id, msg, input) {
    var el = document.getElementById(id + '-err');
    if (el) el.textContent = msg || '';
    if (input) {
      if (msg) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
  }

  function normalisePhone(v) { return v.replace(/[\s-]/g, ''); }

  function validate() {
    var ok = true, first = null;
    var n = form.name.value.trim();
    var e = form.email.value.trim();
    var p = normalisePhone(form.phone.value);
    var attendInputs = form.querySelectorAll('input[name=attend]');
    function bad(id, msg, input) { setErr(id, msg, input); ok = false; if (!first) first = input; }

    setErr('name', '', form.name);
    setErr('email', '', form.email);
    setErr('phone', '', form.phone);
    setErr('attend', '');
    attendInputs.forEach(function (r) { r.removeAttribute('aria-invalid'); });
    setErr('consent', '', form.consent);

    if (n.length < 2 || n.length > 80) bad('name', 'Enter your name (2 to 80 characters).', form.name);
    if (e.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) bad('email', 'Enter a valid email address.', form.email);
    if (!/^\+?\d{10,15}$/.test(p)) bad('phone', 'Enter a valid phone number, for example 08012345678 or +2348012345678.', form.phone);
    if (!form.attend.value) {
      bad('attend', 'Choose yes or no.', attendInputs[0]);
      attendInputs.forEach(function (r) { r.setAttribute('aria-invalid', 'true'); });
    }
    if (form.bring.value.trim().length > 300) bad('bring', 'Keep this under 300 characters.', form.bring);
    if (!form.consent.checked) bad('consent', 'Tick the box to continue.', form.consent);

    if (first) first.focus();
    return ok;
  }

  // -------------------------------------------------------- 4. form wiring
  function show(msg, kind) {
    result.hidden = false;
    result.className = 'result ' + (kind === 'ok' ? 'is-ok' : 'is-error');
    result.textContent = '';
    var s = document.createElement('strong');
    s.textContent = msg[0];
    var t = document.createElement('span');
    t.textContent = msg[1];
    result.appendChild(s);
    result.appendChild(t);
  }

  var busy = false;

  form.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    if (busy) return;

    var data = {
      name: form.name.value.trim(),
      email: form.email.value.trim().toLowerCase(),
      phone: normalisePhone(form.phone.value.trim()),
      attending: form.attend.value,
      bringing: form.bring.value.trim(),
      consent: form.consent.checked,
      site: form.site.value
    };

    // Honeypot: bots fill hidden fields. Pretend it worked, send nothing.
    if (data.site) {
      show(MESSAGES.createdYes(data.name || 'there'), 'ok');
      form.reset();
      return;
    }

    if (!validate()) return;

    if (!registrationApi.isConfigured()) {
      show(MESSAGES.notOpen, 'error');
      return;
    }

    busy = true;
    send.disabled = true;
    send.setAttribute('aria-busy', 'true');
    var originalLabel = send.textContent;
    send.textContent = 'Sending…';
    result.hidden = true;

    var status = await registrationApi.register(data);

    switch (status) {
      case 'created':
        show(data.attending === 'yes' ? MESSAGES.createdYes(data.name) : MESSAGES.createdNo(data.name), 'ok');
        form.reset();
        break;
      case 'rejected':           // server-side honeypot; behave like success
        show(MESSAGES.createdYes(data.name), 'ok');
        form.reset();
        break;
      case 'duplicate':
        show(MESSAGES.duplicate, 'error');
        break;
      case 'invalid':
        show(MESSAGES.invalid, 'error');
        break;
      case 'rate_limited':
        show(MESSAGES.rateLimited, 'error');
        break;
      default:
        show(MESSAGES.network, 'error');
    }

    busy = false;
    send.disabled = false;
    send.removeAttribute('aria-busy');
    send.textContent = originalLabel;
  });
})();
