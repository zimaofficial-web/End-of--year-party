# Admin portal, tickets and emails: setup

Do these once, in order. Claude will walk you through them one at a time.

## 0. Vercel projects (from GitHub)
- **Public site** (project `miva-fest`): Settings → Git → connect `zimaofficial-web/End-of--year-party`.
  Settings → Environment Variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (publishable key). Root Directory: empty.
- **Admin site** (new project, e.g. `miva-fest-admin`): Add New → Project → same repo →
  **Root Directory = `admin`** → same two environment variables → Deploy.
  Its settings come from `admin/vercel.json` (build `node ../scripts/build.mjs …`, output `public`).
- Live addresses: public https://miva-fest.vercel.app, admin https://miva-fest-admin.vercel.app
- Production branch: `main` for the public site; the admin project follows GitHub's default branch. Keep `main` and `claude/rsvp-supabase` identical (push to both).

## 1. Update the database
Supabase → **SQL Editor** → **New query** → paste all of
`supabase/migrations/20261118000000_tickets_and_admins.sql` → **Run** → expect *Success*.

This adds ticket codes (MF-0001…), the secret QR tokens, Paid / Checked-in, and the admins list:

| Email | Role | Registration emails |
|---|---|---|
| zimaofficial001@gmail.com | Super admin | On |
| louissainaboya@gmail.com | Admin | Off (switch on in the admin site) |

## 2. Lock sign-ups
Supabase → **Authentication** → **Sign In / Providers** (or **Settings**) → turn **off** "Allow new users to sign up".
Leave Email login **on**. Only people you add can log in.

## 3. Create the logins
Supabase → **Authentication** → **Users** → **Add user** → **Create new user**:
- Email: `zimaofficial001@gmail.com`, a strong password, tick **Auto Confirm User**.
- Repeat for `louissainaboya@gmail.com` and send them their password privately.

Later, to add another admin: create their login here **and** add their email on the admin site's **Admins** page.

## 4. Emails (Resend)
1. Sign up at **resend.com** with `zimaofficial001@gmail.com`.
2. **API Keys** → **Create API Key** (permission: *Sending access*) → copy it (starts with `re_`).
3. Supabase → **Edge Functions** → **Secrets** → add:
   - `RESEND_API_KEY` = the `re_…` key
   - `WEBHOOK_SECRET` = a long random password (save it; you need it in step 6)
4. Supabase → **Edge Functions** → **Deploy a new function** → **Via Editor** → name it `notify-rsvp` →
   replace the editor content with **all** of `supabase/functions/notify-rsvp/paste-into-dashboard.ts` → **Deploy**.
   In the function's settings, turn **off** "Verify JWT" (the webhook uses `WEBHOOK_SECRET` instead).

> **Limit:** until you verify your own domain in Resend, it only delivers to the Resend account's own email
> (zimaofficial001@gmail.com). Emails to other admins start working once a domain is verified and
> `MAIL_FROM` (e.g. `Miva Fest <rsvp@yourdomain.com>`) is added as a secret.

## 5. Webhook
Supabase → **Database** → **Webhooks** → **Create a new hook**:
- Name `notify_rsvp`, table **rsvps**, events: **Insert** only.
- Type: **Supabase Edge Functions** → `notify-rsvp`, method POST.
- HTTP header: `x-webhook-secret` = the same `WEBHOOK_SECRET`.

## 6. Test
1. Register on https://miva-fest.vercel.app with **Yes** → you see the ticket code + QR; save it.
2. Within a minute you get "Miva Fest RSVP: … (Yes) - MF-…" at zimaofficial001@gmail.com.
3. Log in to the admin site → find the ticket → **Mark paid**.
4. **Gate** → **Start camera** → scan the saved QR → **ADMIT**. Scan again → **ALREADY USED**.

## Passwords
- Any admin can change their own password: admin site → **My password** (current password + new one, at least 10 characters).
- Forgot it? The super admin deletes that login in Supabase (Authentication → Users) and creates it again with the same email.
  Admin access is tied to the email, so nothing else is lost.

## How payment and the gate work
- New tickets are **NOT PAID**. When someone pays, find them on **Registrations** and tap **Mark paid**.
- At the gate, staff log in, open **Gate**, scan. Green **ADMIT** = let in. Red = don't.
- A ticket works **once**. No QR? Type the code (e.g. MF-0042) in the box below the camera.
