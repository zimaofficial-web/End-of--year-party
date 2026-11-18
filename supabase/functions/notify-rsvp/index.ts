// Supabase Edge Function: email admins about each new registration.
//
// Triggered by a Database Webhook (table public.rsvps, event INSERT) that
// sends the header  x-webhook-secret: <WEBHOOK_SECRET>.
//
// Secrets (Supabase > Edge Functions > Secrets), never in git:
//   RESEND_API_KEY   from resend.com
//   WEBHOOK_SECRET   any long random string; the same value goes in the webhook header
//   MAIL_FROM        optional, e.g. "Miva IRL <rsvp@your-domain>" once a domain is verified
// Provided automatically by Supabase: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Who gets the email: every row in public.admins with receives_emails = true
// (the super admin switches this on/off in the admin site).
import { buildEmail, isValidRecord, safeEqual } from './email.ts';

const TIMEOUT_MS = 10000;

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

function dbHeaders(): Record<string, string> {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const h: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' };
  if (key.split('.').length === 3) h.Authorization = `Bearer ${key}`;
  return h;
}

const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply(405, { error: 'method' });
  if (!safeEqual(req.headers.get('x-webhook-secret') ?? '', env('WEBHOOK_SECRET'))) {
    return reply(401, { error: 'unauthorized' });
  }

  let payload: { type?: string; table?: string; schema?: string; record?: unknown };
  try { payload = await req.json(); } catch { return reply(400, { error: 'bad json' }); }
  if (payload.type !== 'INSERT' || payload.table !== 'rsvps' || payload.schema !== 'public') {
    return reply(200, { skipped: true });
  }
  const r = payload.record;
  if (!isValidRecord(r)) return reply(400, { error: 'bad record' });

  const base = env('SUPABASE_URL');
  try {
    const res = await call(`${base}/rest/v1/admins?select=email&receives_emails=eq.true`, { headers: dbHeaders() });
    if (!res.ok) throw new Error(`admins lookup ${res.status}`);
    const to = ((await res.json()) as { email: string }[]).map((a) => a.email);
    if (to.length === 0) return reply(200, { sent: 0, reason: 'no recipients' });

    const { subject, html, text } = buildEmail(r);
    const mail = await call('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: Deno.env.get('MAIL_FROM') || 'Miva IRL <onboarding@resend.dev>',
        to, subject, html, text
      })
    });
    if (!mail.ok) throw new Error(`resend ${mail.status}`);

    const mark = await call(`${base}/rest/v1/rsvps?id=eq.${encodeURIComponent(r.id)}`, {
      method: 'PATCH',
      headers: { ...dbHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({ notified: true })
    });
    if (!mark.ok) throw new Error(`mark notified ${mark.status}`);

    return reply(200, { sent: to.length });
  } catch (e) {
    // Log only the reason, never the person's details.
    console.error('notify-rsvp failed:', e instanceof Error ? e.message : 'unknown', 'ticket', r.ticket_code);
    return reply(500, { error: 'notify failed' });
  }
});
