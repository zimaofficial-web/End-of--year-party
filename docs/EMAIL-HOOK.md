# Email notifications (later)

Not built yet. Everything is ready for it; **no change to the website is needed**.

## Where the hook goes

```
Someone registers
      │
      ▼
public.rsvps  ── new row (notified = false)
      │
      │  Supabase Database Webhook: table rsvps, event INSERT
      ▼
Edge Function  supabase/functions/notify-rsvp/index.ts   (to be written)
      │  1. reads the new row from the webhook body
      │  2. sends you an email (e.g. with Resend)
      │  3. sets notified = true for that row (uses the service_role key,
      │     which Edge Functions get automatically; it never reaches the browser)
      ▼
your inbox
```

## Steps when you're ready

1. Pick an email service (Resend has a free tier) and get an API key.
2. Write `supabase/functions/notify-rsvp/index.ts` and deploy it with the Supabase CLI.
3. Store the email API key as an Edge Function secret: `supabase secrets set RESEND_API_KEY=...`. Never in git, never in Vercel.
4. Supabase → **Database → Webhooks** → **Create**: table `rsvps`, event **Insert**, type **Supabase Edge Function**, choose `notify-rsvp`.
5. Safety net for missed emails: a scheduled job can re-send rows where `notified = false` (the index `rsvps_unnotified_idx` makes this fast).

Ask me when you want this built.
