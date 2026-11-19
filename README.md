# Miva Fest website

Public registration page for **Miva Fest: The December Experience**, 22 December 2026.

Static site on **Vercel**, registrations stored in **Supabase**.

**Live:** https://miva-fest.vercel.app (deploys from the `main` branch) (Vercel project `miva-fest`, Supabase project `houljdudfeyhrhxrcrfs`).

## Folders

| Path | What it is |
|---|---|
| `site/` | Public website: `index.html`, `styles.css`, `app.js`, `vendor/qrcode.js` |
| `admin/` | Admin website (separate Vercel project): `admin/site/*`, `admin/vercel.json` |
| `scripts/build.mjs` | Vercel build: copies `site/` to `public/` and writes `config.js` from env vars |
| `vercel.json` | Build settings + security headers (CSP etc.) |
| `supabase/migrations/` | Database setup (table, security rules, `register_rsvp` function) |
| `supabase/functions/notify-rsvp/` | Edge Function that emails admins about new registrations |
| `supabase/tests/` | Database tests |
| `tests/` | Browser tests (form, CSP, mobile, accessibility) |
| `flyer/` | Phone flyer (1080×1350): `flyer.html` source, `miva-wrap-party-flyer.png` output. Re-render: `node scripts/render-flyer.mjs [url]` (checks the QR) |
| `docs/` | Deploy guide, privacy runbook, email hook plan, decisions |

## Start here

- Deploy: [`docs/DEPLOY.md`](docs/DEPLOY.md)
- Admin portal, tickets, emails: [`docs/ADMIN-SETUP.md`](docs/ADMIN-SETUP.md)
- Delete or export someone's data: [`docs/PRIVACY-RUNBOOK.md`](docs/PRIVACY-RUNBOOK.md)
- Email notifications later: [`docs/EMAIL-HOOK.md`](docs/EMAIL-HOOK.md)
- Why it's built this way: [`docs/adr/001-rpc-only-writes.md`](docs/adr/001-rpc-only-writes.md), [`docs/adr/002-tickets-and-admin-portal.md`](docs/adr/002-tickets-and-admin-portal.md)

## Environment variables

See `.env.example`. Only two, both public by design:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` (anon or `sb_publishable_` key; the build refuses service_role / secret keys)

## Run the tests

Browser and function tests (needs Node 22.18+ and Playwright with Chromium):

```bash
node --test tests/e2e.test.mjs tests/admin.e2e.test.mjs tests/notify.test.mjs
```

Database tests (needs a local PostgreSQL 15+):

```bash
PSQL="sudo -u postgres psql" bash scripts/test-db.sh
```

## Payment

Gate fee ₦3,000 by bank transfer (OPay 7044916819, Obirai Ozioma), ticket code as narration. Details live in `PAYMENT` in `site/app.js`. Admins tick **Mark paid** after checking the bank app.

## Placeholders still to fill

- `YOUR-PROJECT-REF` in `vercel.json` (see deploy guide, step 6)
