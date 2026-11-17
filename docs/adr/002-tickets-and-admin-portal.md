# ADR 002: Tickets, QR gate check-in and a separate admin site

- Status: Accepted
- Date: 2026-11-18
- Decided by: Zima

## Decisions
1. **Ticket code + secret token.** Each registration gets a readable code (`MF-0001`, sequential) and a random UUID token. The QR holds only `MIVAFEST1:<token>`: no personal data, and unguessable, so tickets can't be forged by counting codes.
2. **Ticket only on a new registration.** `register_rsvp` returns the code/token only when it creates the row. A duplicate email gets `{"status":"duplicate"}` and nothing else, so knowing someone's email never reveals their QR.
3. **Paid is set by admins.** Tickets start NOT PAID. The gate admits only paid tickets, once (`checked_in_at`), with a row lock so two phones can't admit the same ticket. A used ticket can't be marked unpaid.
4. **Separate admin site** (owner's choice), same Supabase project. Strict CSP of its own; camera allowed only there.
5. **Login with Supabase Auth; access by `public.admins`.** Admin status is matched on the email in the verified login token. Public sign-ups are turned off and accounts are created by the super admin. Roles: `super_admin` (also manages admins and email switches) and `admin` (registrations + gate). The last super admin can't be removed or demoted.
6. **Still no table privileges for browsers.** `anon` and `authenticated` can only call functions. Admin functions run as the non-login role `rsvp_admin_ops`, which can read rsvps, update only the payment/check-in columns, and manage `admins`.
7. **Emails**: Database Webhook → Edge Function `notify-rsvp` → Resend → sets `notified = true`. Recipients are admins with `receives_emails = true`. The webhook is authenticated with a shared secret header, and the email never contains the QR token.
8. **No emoji in the subject**, per the owner.
9. **QR libraries** are copied into the repo (qrcode-generator MIT, jsQR Apache-2.0), so the CSP stays `script-src 'self'`.

## Consequences
- Students don't get their ticket by email yet: Resend needs a verified domain to email anyone except the account owner. They save the ticket from the screen. A lost ticket is re-issued by an admin looking up the code.
- Admin identity depends on Supabase Auth emails being trustworthy, which is why sign-ups must stay off.
- `checked_in_by` and `paid_by` store the admin's email, for accountability.
