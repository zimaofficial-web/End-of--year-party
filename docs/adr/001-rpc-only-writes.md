# ADR 001: The website writes only through one database function

- Status: Accepted
- Date: 2026-11-17
- Decided by: Zima

## Context

The registration form is public. Requirements: anonymous visitors may only add registrations, never read, change or delete them; one registration per email; reject the honeypot; basic rate limiting; no secret keys in the browser.

A plain RLS `INSERT` policy for `anon` would let anyone post straight to the table and skip the honeypot and rate limit. Updating a row when the email already exists would let anyone who knows a classmate's email overwrite that classmate's details.

## Decision

1. `anon` has **no** privileges on `public.rsvps`. RLS is enabled and forced; the only policy is `INSERT` for the role `rsvp_writer`.
2. The website calls `public.register_rsvp()` (`SECURITY DEFINER`, owned by `rsvp_writer`, `search_path` pinned). It checks the honeypot, rate-limits by salted IP hash, and inserts with `ON CONFLICT DO NOTHING`.
3. A second registration with the same email is **not** applied; the visitor is told to contact the organiser.
4. The page is split into `index.html`, `styles.css` and `app.js` so the CSP can be `script-src 'self'` and `style-src 'self' fonts.googleapis.com` without `'unsafe-inline'`.
5. No supabase-js: the page uses `fetch` to the REST RPC endpoint. No dependencies, nothing extra for the CSP.
6. Plain CSS animation instead of React. Respects `prefers-reduced-motion`.

## Consequences

- People cannot fix their own typo by re-submitting; the organiser updates it (`docs/PRIVACY-RUNBOOK.md`).
- The response says whether an email is already registered. Accepted: low-sensitivity data, and the rate limit slows guessing.
- A future admin portal adds Supabase Auth plus an explicit `SELECT` policy for an admin role. No change to this design is needed.
