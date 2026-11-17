# Email notifications

Built. Setup steps are in [`ADMIN-SETUP.md`](ADMIN-SETUP.md) (steps 4 and 5).

- Code: `supabase/functions/notify-rsvp/` (`email.ts` builds the email, `index.ts` handles the webhook).
- One-file version for the dashboard editor: `paste-into-dashboard.ts` (regenerate with `node scripts/bundle-function.mjs`).
- Tests: `node --test tests/notify.test.mjs`.
- Recipients: admins with **Registration emails** switched on (admin site, Admins page, super admin only).
- Without a verified domain, Resend only delivers to the account owner's email.
