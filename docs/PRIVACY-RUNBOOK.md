# Privacy runbook

What we store: name, email, phone, yes/no, what they're bringing (optional), consent, when they agreed and which privacy text they agreed to (`policy_version`).
Nothing else. No IP addresses (only a salted hash for spam protection, deleted after 24 hours).

A copy of each new registration is emailed to the organisers through **FormSubmit** (formsubmit.co). Those emails live in the organisers' inboxes: when deleting someone's data, also delete their registration email.

All queries below go in **Supabase → SQL Editor**. Replace `person@example.com` with the email the person gave.

## Someone asks: "What do you have about me?"

```sql
select name, email, phone, attending, bringing, consent_at, policy_version, created_at
from public.rsvps
where email = lower(trim('person@example.com'));
```

Click **Download CSV** (or copy the result) and send it to them.

## Someone asks: "Delete my details"

**Easiest:** log in to https://miva-fest-admin.vercel.app as the super admin, find them on
**Registrations**, tap **Delete**, and type their ticket code to confirm. Only super admins see this button.

**Or with SQL:**

1. Check it's really them: reply from the same email or WhatsApp number they registered with.
2. Run:

```sql
delete from public.rsvps
where email = lower(trim('person@example.com'))
returning email;
```

3. If one row comes back, it's deleted. Tell them it's done. If nothing comes back, there was no registration with that email.

Note: Supabase backups may still hold the row for a few days until they expire. That's normal; mention it if they ask.

## Someone wants to change their details

The form never overwrites an existing registration (so nobody can change someone else's). Do it here instead, after checking it's really them:

```sql
update public.rsvps
set phone = '+2348012345678'          -- change only what they asked for
where email = lower(trim('person@example.com'))
returning *;
```

## After the event: delete everything by 31 January 2027

```sql
delete from public.rsvps;
delete from private.rsvp_attempts;
```

Optional, to make it automatic: **Database → Extensions** → enable `pg_cron`, then run once:

```sql
select cron.schedule(
  'miva-fest-purge',
  '0 2 31 1 *',                 -- 02:00 UTC on 31 January
  $$ delete from public.rsvps; delete from private.rsvp_attempts; $$
);
```

## If the privacy text changes

Change the text in `site/index.html`, then change `c_policy_version` in the `register_rsvp` function to a new value (for example `v2-2027-01-10`). New registrations will then record which version they agreed to.
