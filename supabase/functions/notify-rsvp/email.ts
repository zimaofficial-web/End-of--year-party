// Pure helpers for the registration email (no network, easy to test).

export type Rsvp = {
  id: string;
  ticket_code: string;
  name: string;
  email: string;
  phone: string;
  attending: string;
  bringing: string | null;
  consent_at: string;
  policy_version: string;
  created_at: string;
  ticket_token?: string; // present in the webhook payload; NEVER put in an email
};

export function escapeHtml(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// One line, no control characters (prevents header tricks), max 80 chars.
export function oneLine(v: unknown, max = 80): string {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function lagosTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  }).format(d) + ' (WAT)';
}

export function isValidRecord(r: unknown): r is Rsvp {
  if (!r || typeof r !== 'object') return false;
  const x = r as Record<string, unknown>;
  return typeof x.id === 'string' && typeof x.ticket_code === 'string' && typeof x.name === 'string' &&
    typeof x.email === 'string' && typeof x.phone === 'string' && (x.attending === 'yes' || x.attending === 'no') &&
    typeof x.created_at === 'string';
}

export function buildEmail(r: Rsvp): { subject: string; html: string; text: string } {
  const coming = r.attending === 'yes' ? 'Yes' : 'No';
  const subject = `Miva Stars 2026 RSVP: ${oneLine(r.name)} (${coming}) - ${oneLine(r.ticket_code, 20)}`;
  const rows: [string, string][] = [
    ['Ticket code', r.ticket_code],
    ['Full name', r.name],
    ['Email address', r.email],
    ['Phone number', r.phone],
    ['Coming', coming],
    ['Bringing', r.bringing || '-'],
    ['Payment', r.attending === 'yes' ? 'Not paid yet (mark Paid in the admin site)' : 'No ticket'],
    ['Consent given', lagosTime(r.consent_at) + ' - policy ' + (r.policy_version || '')]
  ];
  const cell = 'padding:10px 12px;border:1px solid #c9c2b2;font-family:Arial,sans-serif;font-size:15px;vertical-align:top';
  const html =
    `<div style="font-family:Arial,sans-serif;color:#0B1530;max-width:640px">` +
    `<p style="font-size:16px">Someone just registered for <b>Miva Stars 2026 Wrap Party</b>.</p>` +
    `<table role="presentation" style="border-collapse:collapse;width:100%">` +
    `<tr><th style="${cell};background:#09314F;color:#fff;text-align:left">Field</th>` +
    `<th style="${cell};background:#09314F;color:#fff;text-align:left">Answer</th></tr>` +
    rows.map(([k, v]) => `<tr><td style="${cell};font-weight:bold;width:38%">${escapeHtml(k)}</td>` +
      `<td style="${cell};font-family:Consolas,monospace">${escapeHtml(v)}</td></tr>`).join('') +
    `</table>` +
    `<p style="font-size:15px;text-align:center;margin-top:18px"><b>Submitted at ${escapeHtml(lagosTime(r.created_at))}</b></p>` +
    `<p style="font-size:13px;color:#555">You get this because registration emails are switched on for you in the Miva Stars admin site.</p>` +
    `</div>`;
  const text = `Someone just registered for Miva Stars 2026 Wrap Party.\n\n` +
    rows.map(([k, v]) => `${k}: ${oneLine(v, 300)}`).join('\n') +
    `\n\nSubmitted at ${lagosTime(r.created_at)}\n`;
  return { subject, html, text };
}

// Constant-time string compare for the webhook secret.
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
