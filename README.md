# Miva Fest website

Public registration page for **Miva Fest: The December Experience**, 22 December 2026.

Static site on **Vercel**, registrations stored in **Supabase**.

**Live:** https://miva-fest.vercel.app (Vercel project `miva-fest`, Supabase project `houljdudfeyhrhxrcrfs`).

## Folders

| Path | What it is |
|---|---|
| `site/` | The website: `index.html`, `styles.css`, `app.js` |
| `scripts/build.mjs` | Vercel build: copies `site/` to `public/` and writes `config.js` from env vars |
| `vercel.json` | Build settings + security headers (CSP etc.) |
| `supabase/migrations/` | Database setup (table, security rules, `register_rsvp` function) |
| `supabase/tests/` | Database tests |
| `tests/` | Browser tests (form, CSP, mobile, accessibility) |
| `docs/` | Deploy guide, privacy runbook, email hook plan, decisions |

## Start here

- Deploy: [`docs/DEPLOY.md`](docs/DEPLOY.md)
- Delete or export someone's data: [`docs/PRIVACY-RUNBOOK.md`](docs/PRIVACY-RUNBOOK.md)
- Email notifications later: [`docs/EMAIL-HOOK.md`](docs/EMAIL-HOOK.md)
- Why it's built this way: [`docs/adr/001-rpc-only-writes.md`](docs/adr/001-rpc-only-writes.md)

## Environment variables

See `.env.example`. Only two, both public by design:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` (anon or `sb_publishable_` key; the build refuses service_role / secret keys)

## Run the tests

Browser tests (needs Node 18+ and Playwright with Chromium):

```bash
node --test tests/e2e.test.mjs
```

Database tests (needs a local PostgreSQL 15+):

```bash
PSQL="sudo -u postgres psql" bash scripts/test-db.sh
```

## Placeholders still to fill

- `[PAYMENT INSTRUCTIONS TO BE ADDED]` in `site/app.js`
- `YOUR-PROJECT-REF` in `vercel.json` (see deploy guide, step 6)
