# Email notifications

**In use: FormSubmit** (owner's choice). After a registration is saved, the public page sends a copy
to `https://formsubmit.co/ajax/<address>` (`site/app.js`, `emailCopy`). Best effort: a failure never
affects the registration. The QR token is never included. CSP `connect-src` allows `https://formsubmit.co`.

- First use: FormSubmit emails an **Activate** link to the address. Click it once.
- FormSubmit then offers a random alias; put it in `FORMSUBMIT_TO` in `site/app.js` to hide the address.
- Other admins: FormSubmit supports a `_cc` field, but those addresses would be visible in the page code.

**Alternative, built but not deployed:** Supabase Edge Function `supabase/functions/notify-rsvp/` +
Resend (server-side, no ads, recipients from the admin site's email switches). Setup: `ADMIN-SETUP.md` steps 4–5.
