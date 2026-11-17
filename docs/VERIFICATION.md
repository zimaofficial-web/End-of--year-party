# Verification checklist: Miva Fest registration

Assessed by: Claude (AI assistant) · Date: 2026-11-17 · Against: `Zima/04-checklists/*`

**Key**
- ✅ **Verified**: evidence cited (file or test I actually ran)
- 👤 **Needs you**: `[REQUIRES HUMAN VERIFICATION]`, can only be checked on your Supabase/Vercel or by a person
- ➖ **N/A**: doesn't apply to this project (reason given)
- ❌ **Not met**: required by the checklist but not done (reason given)

**Test runs this evidence comes from**
- DB: `bash scripts/test-db.sh` → **52/52 PASS**, "ALL DATABASE TESTS PASSED", exit 0. Real PostgreSQL 16.15 in a scratch container, with Supabase's `anon` / `authenticated` / `service_role` roles and default grants recreated, and the migration run as a **non-superuser** admin like Supabase's `postgres` (this reproduced, then confirmed the fix for, the "permission denied for schema public" error seen on the real project). **Not** your real Supabase project.
- Browser: `node --test tests/e2e.test.mjs` → **22/22 pass**, 3 runs in a row with 0 failures. Chromium (Playwright 1.63), page served with the real `vercel.json` headers, Supabase stubbed at the network level.
- CSP test checked for teeth: adding one inline `style=""` made it fail; reverted.

---

## Supabase security (`supabase-security.md`)

| Item | Status | Evidence |
|---|---|---|
| RLS enabled on all public tables | ✅ | `rsvps` is the only public table. Migration §3; DB test "RLS enabled AND forced". The rate-limit tables live in schema `private`, which isn't exposed to the API and has no grants (test: "anon cannot read private.*"). |
| FORCE RLS | ✅ | Same test. |
| Separate per-operation policies, no `FOR ALL` | ✅ | One `INSERT` policy only; tests "exactly one policy" and "the only policy is INSERT for rsvp_writer". Missing SELECT/UPDATE/DELETE policies mean those are denied. |
| `INSERT … WITH CHECK (auth.uid() = user_id)` | ➖ | No user accounts. INSERT is limited to the role `rsvp_writer` instead (ADR 001). |
| UPDATE policies with USING + WITH CHECK | ➖ | No UPDATE policy exists by design. |
| FK columns in policies indexed / `(select auth.uid())` | ➖ | No foreign keys, no `auth.uid()`. |
| service_role key never in client/Git/frontend env | ✅ + 👤 | Build refuses service_role JWTs and `sb_secret_` keys (tests "build: refuses…"); secret scan of repo: none. 👤 You must not paste the secret key into Vercel. |
| SECURITY DEFINER functions pin search_path | ✅ | `set search_path = ''` (stricter than `public, auth`); DB test checks `proconfig`. |
| EXECUTE revoked from PUBLIC | ✅ | DB test: anon only; PUBLIC and authenticated revoked. |
| Storage buckets (3 items) | ➖ | No file storage used. |

## Database readiness (`database-readiness.md`)

| Item | Status | Evidence |
|---|---|---|
| 3NF | ✅ | One table, one row per person, no repeating groups (migration §2). |
| Primary key | ✅ | `id uuid default gen_random_uuid()`. |
| Foreign keys | ➖ | No relationships. |
| NOT NULL by default | ✅ | All columns NOT NULL except `bringing` (optional form field, justified in a comment). |
| CHECK + UNIQUE | ✅ | Migration §2; 14 validation tests + duplicate tests. |
| Leftmost-prefix compound index | ✅ | `rsvp_attempts(ip_hash, created_at)` matches `where ip_hash = … and created_at > …`. |
| No unindexed scans (EXPLAIN ANALYZE) | ➖ | Not run; the table will hold hundreds of rows, and the lookup paths are indexed (email unique, attempts index). |
| No N+1 | ➖ | No ORM or loops. |
| Partial index for status queries | ✅ | `rsvps_unnotified_idx … where notified = false`. |
| Atomic transactions | ✅ | Migration wrapped in `begin … commit`; the function runs in one transaction. |
| Migrations in version control | ✅ | `supabase/migrations/20261117000000_create_rsvps.sql`. |
| Expand/contract, CONCURRENTLY | ➖ | Brand-new tables, nothing to lock. CONCURRENTLY can't run inside a transaction and isn't needed on empty tables. |
| Backups with restore drill | 👤 | `docs/DEPLOY.md` Part E. |

## Application security (`application-security.md`)

| Item | Status | Evidence |
|---|---|---|
| Parameterised SQL | ✅ | Browser sends JSON args to the RPC; the function uses no dynamic SQL (no `EXECUTE` in `register_rsvp`). |
| No dynamic shell commands | ➖ | None at runtime. |
| HTML escaping of user data | ✅ | `app.js` uses `textContent` only; tests "names with HTML…" and "unexpected 200 body…". |
| Strict CSP | ✅ + 👤 | `vercel.json`: no `unsafe-inline`/`unsafe-eval`, `default-src 'none'`. Test "zero violations" (proven able to fail). 👤 Check the live site at securityheaders.com. |
| Anti-CSRF | ➖ | No cookies; `fetch` uses `credentials: 'omit'`. |
| Password hashing, session cookies | ➖ | No logins. |
| Rate limiting on registration | ✅ | 5 per IP per 10 min; DB tests "rate-limit attempt…", "6th attempt → rate_limited". 👤 Confirm Supabase sends `x-forwarded-for` (if not, the IP limit is skipped; duplicate-email blocking still works). |
| No secrets in Git | ✅ | Repo scan: no keys. `.gitignore` excludes `.env*` and `public/`. Nothing committed yet. |
| Dependency scanning | ➖ | Zero dependencies (no `package.json`). |
| File uploads (3 items) | ➖ | No uploads. |
| Security logging | ❌ | Not set up (RECOMMENDED only). Supabase's built-in API logs are available in the dashboard. |

## Backend readiness (`backend-readiness.md`)

| Item | Status | Evidence |
|---|---|---|
| RESTful plural-noun endpoints | ➖ | Deliberately one RPC endpoint (ADR 001). |
| Zero-trust input validation | ✅ | Fixed function signature; DB CHECKs; direct table insert denied (DB test). |
| Correlation IDs | ➖ | Managed by Supabase; no custom backend. |
| Security headers / CORS | ✅ + 👤 | Headers in `vercel.json`. CORS on the API is Supabase-managed (not verified). |
| Auth on non-public endpoints | ➖ | The only endpoint is public by design. |
| IDOR prevention | ✅ | No read endpoint for anon; anon SELECT → 42501 (DB test). |
| Rate limiting | ✅ | See above. |
| RFC 7807 errors | ➖ | Function returns a fixed status word; the browser never displays server bodies (test "server error: raw server text is never shown"). |
| No stack traces/SQL leaked | ✅ | Validation errors are mapped to `invalid` inside the function. Other PostgREST errors could still appear in the browser's network tab, but never on the page. |
| PII-scrubbed logging | ➖ | No custom logging. |
| Async queues | ➖ | Email later via webhook (`docs/EMAIL-HOOK.md`). |

## Frontend readiness (`frontend-readiness.md`)

| Item | Status | Evidence |
|---|---|---|
| Strict TypeScript | ❌ | Plain JS, no build tooling (your choice of a static page, no React). Mitigated by 22 tests. |
| Components ≤200 lines | ➖ | No components. `app.js` is 211 lines in 4 labelled sections. |
| Server-state caching lib | ➖ | Nothing is read from the server. |
| Runtime schema validation (Zod) + 5 form states | ❌ | No Zod (it would add a dependency). Hand-written checks mirror the DB CHECKs. Submitting, success and error states are covered; "dirty" isn't tracked. |
| Double-submit prevention | ✅ | Test "button disabled while sending" (+ `busy` flag in `app.js`). |
| Error boundaries | ➖ | No React. |
| Empty states / skeletons | ➖ | No loaded content. |
| CLS ≤0.1 | ➖ | No images; not measured. |
| No unescaped input | ✅ | `textContent` only; no `innerHTML` in `app.js`. |
| No secrets in bundle | ✅ | `public/config.js` holds only URL + anon key (test "build: output contains…"). |
| Code splitting / virtualisation | ➖ | Single small page. |

## Accessibility (`accessibility-verification.md`)

| Item | Status | Evidence |
|---|---|---|
| Text contrast ≥4.5:1 | ✅ | Measured: lowest is 5.49:1 (gold on blue). Body 8.72, labels 12.51, errors 8.30, buttons 10.08. |
| UI contrast ≥3:1 | ✅ | Error border was 2.07:1 in the original design → changed to `#C62828` (5.11:1). Focus ring 5.49:1. |
| Colour not the only indicator | ✅ | Errors have text + ⚠ + `aria-invalid`; results have a heading. |
| Reduced motion respected | ✅ | All motion is inside `prefers-reduced-motion: no-preference`; test "reduced motion: animations are switched off". |
| Keyboard operable | ✅ (partial) + 👤 | Native controls only; skip-link test. Full Tab-through not automated. 👤 Tab through the form once. |
| Visible focus ring | ✅ | `:focus-visible{outline:3px solid gold}` in `styles.css`. |
| No bare `outline:none` | ✅ | grep: none. |
| Skip link first | ✅ | Test "keyboard: skip link is the first Tab stop" (goes to the registration form, as in the original). |
| Modal focus trap | ➖ | No modals. |
| Native elements | ✅ | `<button>`, `<main>`, `<fieldset>`, `<label>`. |
| One h1, no skipped levels | ✅ | Test counts one h1; h1 → h2 → h3 in `index.html`. |
| Alt text | ➖ | No images; decorative rings are `aria-hidden`. |
| Icon-only buttons | ➖ | None. |
| Labels bound to inputs | ✅ | `<label for>` on every field. |
| `aria-describedby` + `aria-invalid` | ✅ | Test "invalid submit…". |
| Real screen-reader test | 👤 | Try with TalkBack/VoiceOver on your phone. |

## Privacy (`privacy-compliance.md`)

| Item | Status | Evidence |
|---|---|---|
| Data minimisation | ✅ | Test "exactly the 11 agreed columns". IPs stored only as salted hashes, purged after 24 h (DB tests). |
| Cookie banner for tracking | ➖ | No cookies, analytics or trackers. Note: Google Fonts sees visitors' IPs (you allowed it in the CSP). Self-hosting the font would remove that. |
| No pre-ticked consent | ✅ | Test "consent is unticked". |
| Consent logged with time + version | ✅ | DB test "consent_at + policy_version set server-side". |
| Export my data | ✅ (manual) | `docs/PRIVACY-RUNBOOK.md` query; not self-serve. |
| Hard delete | ✅ + 👤 | Runbook delete tested (DB test "privacy runbook delete…"). 👤 Backups keep it a few days. |
| Shared attribution | ➖ | Nothing shared. |
| Retention schedule | ✅ + 👤 | Attempts auto-purged after 24 h (DB test). Registrations: 👤 delete by 31 Jan 2027 (runbook, optional `pg_cron`). |
| Telemetry PII scrubbing | ➖ | No telemetry. |
| Unsubscribe | ➖ | No marketing emails. |
| Licences | ✅ | No dependencies; Space Grotesk font is SIL OFL. |
| Legal review | 👤 | Have someone check the privacy note against Nigeria's NDPA. |

## Testing & QA (`testing-qa-signoff.md`)

| Item | Status | Evidence |
|---|---|---|
| All tests pass in CI | ❌ | Pass locally (52 + 22), but **no CI pipeline** is set up. |
| No flaky tests (3 runs) | ✅ | 3 consecutive browser runs: 22/22 each. |
| No sleeps in tests | ✅ | grep: none; waits are event-based. |
| Parallel-safe | ✅ | DB tests use a throwaway database per run + `rollback`; browser tests use separate contexts. |
| ≥80% coverage | ❌ | Not measured. |
| Edge cases | ✅ | Boundaries (80/81 chars, 120 email, 300 bringing), null values, control characters. |
| Failure scenarios | ✅ (partial) | Network drop, 400/500, duplicate tested. The 10 s timeout is **not** tested. |
| Unauthorised access fails | ✅ | anon/authenticated SELECT, UPDATE, DELETE, direct INSERT → 42501. |
| Real database in tests | ✅ | Real PostgreSQL 16 (Supabase runs 15/17; behaviour should match but isn't verified). |
| Network-level mocking | ✅ | Playwright request routing (same idea as MSW). |
| Lighthouse ≥90 | ❌ | Not run (RECOMMENDED only). |

## Production deployment (`production-deployment.md`)

| Item | Status | Evidence |
|---|---|---|
| CI green | ❌ | No CI. |
| Env vars validated at startup | ✅ | `scripts/build.mjs` stops the build if they're missing or wrong (4 build tests). |
| No secrets in client bundle | ✅ | See above. |
| Zero-downtime migrations | ➖ | First deploy. |
| Rollback artifact | 👤 | Vercel keeps previous deployments ("Promote" in the dashboard). |
| Health probes | ➖ | Static site. |
| TLS + HSTS | ✅ + 👤 | HSTS in `vercel.json`; Vercel provides TLS. Check live. |
| Error monitoring | ❌ | None set up. |
| Backups + restore | 👤 | DEPLOY.md Part E. |
| Live smoke test | 👤 | DEPLOY.md Part D, tests 1–6. |
| 15-minute monitoring, webhooks | 👤 / ➖ | No webhooks yet. |

## Architecture (`architecture-readiness.md`)

| Item | Status | Evidence |
|---|---|---|
| Layer separation | ✅ | DB rules in SQL; `app.js` split into messages / `registrationApi` / validation / UI. |
| Dependency direction | ✅ | UI calls `registrationApi`; only that object knows about Supabase. |
| Feature modules | ➖ | One feature. |
| Third-party SDK behind an adapter | ✅ | `registrationApi` in `app.js`. |
| No shared mutable server state | ➖ | No server runtime. |
| HTTP timeouts ≤10 s | ✅ (code) | `TIMEOUT_MS: 10000` with `AbortController`; not tested. |
| ADRs | ✅ | `docs/adr/001-rpc-only-writes.md`. |
| Files ≤400 lines | ✅ | Largest is 368 lines (`tests/e2e.test.mjs`). |

## Final review (`final-project-review.md`)

| Item | Status |
|---|---|
| Your 12 requirements delivered | ✅ for 1–12 in code and tests. Live behaviour is 👤 until deployed. |
| Supabase RLS hardened | ✅ locally · 👤 re-run DEPLOY.md test 5 on the live project |
| Privacy | ✅ (manual export/delete) |
| Test sign-off | ❌ (no CI, coverage not measured) |
| Accessibility | ✅ automated items · 👤 screen-reader and keyboard pass |
| Docs | ✅ README, `.env.example`, DEPLOY, PRIVACY-RUNBOOK, EMAIL-HOOK, ADR |
| **Final acceptance by Zima** | 👤 |

**Suggested decision: CONDITIONAL APPROVAL.** Ready to deploy once you complete DEPLOY.md and tests 1–6 pass on the live site. The ❌ items are known gaps for you to accept or ask me to fix: CI, TypeScript/Zod, coverage, Lighthouse, error monitoring, security logging.
