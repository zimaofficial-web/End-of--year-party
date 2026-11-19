/* Miva Wrap Party 2026 registration form.
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
  // Gate fee is paid by bank transfer; an admin marks the ticket Paid.
  var PAYMENT = { bank: 'OPay', number: '7044916819', name: 'Obirai Ozioma', amount: '\u20a63,000' };
  var MESSAGES = {
    createdYes: function (name, code) {
      return ['Registration received',
        'Thanks, ' + name + '.' + (code ? ' Your ticket code is ' + code + '.' : '') +
        ' Pay the ' + PAYMENT.amount + ' gate fee by bank transfer using the details below.'];
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
  // API. Resolves to { status, ticketCode, ticketToken } where status is one
  // of: created | duplicate | invalid | rate_limited | rejected | error.
  // Never exposes raw server errors to the caller.
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
        if (!res.ok) return { status: 'error' };
        var body = await res.json();
        // Older database version answered a plain string; newer answers an object.
        var status = typeof body === 'string' ? body : (body && body.status);
        var known = ['created', 'duplicate', 'invalid', 'rate_limited', 'rejected'];
        if (known.indexOf(status) === -1) return { status: 'error' };
        var code = body && typeof body.ticket_code === 'string' && /^MF-\d{4,}$/.test(body.ticket_code) ? body.ticket_code : null;
        var token = body && typeof body.ticket_token === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.ticket_token) ? body.ticket_token : null;
        return { status: status, ticketCode: code, ticketToken: token };
      } catch (e) {
        return { status: 'error' };
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

  // ------------------------------------------------------- email copy
  // After a registration is SAVED, send a copy to the organisers' inbox via
  // FormSubmit (formsubmit.co). Best effort: if it fails, the registration is
  // still saved and visible in the admin site. Never includes the QR token.
  // To switch to FormSubmit's secret alias after activation, replace the
  // email in FORMSUBMIT_TO with the alias string FormSubmit sends you.
  var FORMSUBMIT_TO = 'zimaofficial001@gmail.com';
  var emailCopy = {
    TIMEOUT_MS: 10000,
    send: function (data, code) {
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, emailCopy.TIMEOUT_MS);
      var coming = data.attending === 'yes' ? 'Yes' : 'No';
      var oneLine = function (v) { return String(v || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 80); };
      return fetch('https://formsubmit.co/ajax/' + encodeURIComponent(FORMSUBMIT_TO), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          _subject: 'Miva Wrap Party RSVP: ' + oneLine(data.name) + ' (' + coming + ') - ' + (code || 'no code'),
          _template: 'table',
          _captcha: 'false',
          'Ticket code': code || '-',
          'Full name': data.name,
          'Email address': data.email,
          'Phone / WhatsApp': data.phone,
          'Coming': coming,
          'Bringing': data.bringing || '-',
          'Submitted at': new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' }) + ' (WAT)'
        }),
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'strict-origin-when-cross-origin'
      }).catch(function () { /* best effort */ }).finally(function () { clearTimeout(timer); });
    }
  };

  // ------------------------------------------------------------- ticket
  // The QR holds only "MIVAFEST1:" + a random secret token, never personal data.
  // The gate page (admin site) looks the token up.
  function drawTicket(name, code, token) {
    if (typeof window.qrcode !== 'function') return null;
    var qr = window.qrcode(0, 'M');
    qr.addData('MIVAFEST1:' + token);
    qr.make();
    var n = qr.getModuleCount();
    var W = 600, H = 820, cell = Math.floor(440 / (n + 8)), size = cell * (n + 8);
    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var g = canvas.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#09314F'; g.fillRect(0, 0, W, 120);
    g.fillStyle = '#E43B31'; g.fillRect(0, 112, W, 8);
    g.fillStyle = '#FFFFFF'; g.font = 'bold 54px "Space Grotesk", system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'bold 40px "Space Grotesk", system-ui, sans-serif';
    g.fillText('MIVA WRAP PARTY 2026', W / 2, 62);
    var x0 = (W - size) / 2, y0 = 140;
    g.fillStyle = '#ffffff'; g.fillRect(x0, y0, size, size);
    g.fillStyle = '#000000';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (qr.isDark(r, c)) g.fillRect(x0 + (c + 4) * cell, y0 + (r + 4) * cell, cell, cell);
      }
    }
    var ty = y0 + size + 50;
    g.fillStyle = '#09314F'; g.font = 'bold 48px "Space Grotesk", system-ui, sans-serif';
    g.fillText(code, W / 2, ty);
    g.font = '28px "Space Grotesk", system-ui, sans-serif';
    var shown = name.length > 32 ? name.slice(0, 31) + '\u2026' : name;
    g.fillText(shown, W / 2, ty + 52);
    g.font = '22px "Space Grotesk", system-ui, sans-serif'; g.fillStyle = '#444';
    g.fillText('22 December 2026 \u00b7 National Children\u2019s Park, Abuja', W / 2, ty + 96);
    g.fillText('Valid once payment is confirmed. One entry only.', W / 2, ty + 130);
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Ticket QR code for ' + code);
    return canvas;
  }

  // Bank-transfer details with copy buttons. The ticket code is the narration,
  // so the admin can match the payment and tap "Mark paid".
  function copyButton(label, value) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'copy-btn';
    b.textContent = 'Copy';
    b.setAttribute('aria-label', 'Copy ' + label);
    b.addEventListener('click', function () {
      var done = function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 2000); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(done, function () { b.textContent = value; });
      } else {
        b.textContent = value;   // no clipboard: show the value to copy by hand
      }
    });
    return b;
  }

  function showPayment(code) {
    var box = document.createElement('div');
    box.className = 'pay-box';
    var h = document.createElement('p');
    h.className = 'pay-title';
    h.textContent = 'Pay ' + PAYMENT.amount + ' gate fee';
    box.appendChild(h);
    var dl = document.createElement('dl');
    [['Bank', PAYMENT.bank, null],
     ['Account number', PAYMENT.number, 'account number'],
     ['Account name', PAYMENT.name, null],
     ['Amount', PAYMENT.amount, null],
     ['Narration', code, 'ticket code']].forEach(function (row) {
      var div = document.createElement('div');
      var dt = document.createElement('dt'); dt.textContent = row[0];
      var dd = document.createElement('dd');
      var v = document.createElement('span'); v.textContent = row[1];
      dd.appendChild(v);
      if (row[2]) dd.appendChild(copyButton(row[2], row[1]));
      div.appendChild(dt); div.appendChild(dd); dl.appendChild(div);
    });
    box.appendChild(dl);
    var note = document.createElement('p');
    note.className = 'pay-note';
    note.textContent = 'Use your ticket code ' + code + ' as the transfer narration. Your ticket works once we confirm your payment. No refunds.';
    box.appendChild(note);
    result.appendChild(box);
  }

  function showTicket(name, code, token) {
    var canvas = drawTicket(name, code, token);
    if (!canvas) return;
    var box = document.createElement('div');
    box.className = 'ticket-out';
    var c = document.createElement('p');
    c.className = 'ticket-code';
    c.textContent = code;
    var help = document.createElement('p');
    help.className = 'ticket-help';
    help.textContent = 'Save this ticket now and show the QR code at the gate. It works only once, and only after your payment is confirmed.';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'save-ticket';
    btn.textContent = 'Save ticket';
    btn.addEventListener('click', function () {
      canvas.toBlob(function (blob) {
        if (!blob) return;
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'miva-wrap-party-ticket-' + code + '.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
      }, 'image/png');
    });
    box.appendChild(c);
    box.appendChild(canvas);
    box.appendChild(help);
    box.appendChild(btn);
    result.appendChild(box);
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

    var answer = await registrationApi.register(data);

    switch (answer.status) {
      case 'created':
        emailCopy.send(data, answer.ticketCode);   // not awaited: never delays the ticket
        if (data.attending === 'yes') {
          show(MESSAGES.createdYes(data.name, answer.ticketCode), 'ok');
          if (answer.ticketCode) showPayment(answer.ticketCode);
          if (answer.ticketCode && answer.ticketToken) showTicket(data.name, answer.ticketCode, answer.ticketToken);
        } else {
          show(MESSAGES.createdNo(data.name), 'ok');
        }
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
