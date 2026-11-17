# Deploying Miva Fest

Do these in order. Each step is small. Tick them off as you go.

## Part A: Supabase (the database)

1. Go to <https://supabase.com>, sign in, click **New project**.
   - Name: `miva-fest`
   - Region: the closest to Nigeria (e.g. **West EU (London)** or **Central EU (Frankfurt)**).
   - Save the database password somewhere safe (a password manager). You will rarely need it.
2. Wait until the project says it is ready.
3. Open **SQL Editor** → **New query**.
4. Open `supabase/migrations/20261117000000_create_rsvps.sql` from this repo, copy **all** of it, paste it in, click **Run**. It should say *Success. No rows returned*.
5. Open **Project Settings → API** (or **API Keys**). Copy two values into a note for the next part:
   - **Project URL**, looks like `https://abcd1234.supabase.co`
   - The **anon / public** key (or **Publishable** key, starts with `sb_publishable_`).
   - ⚠️ Do **not** copy the `service_role` / **Secret** key. It never goes into Vercel or the website.

## Part B: Put your Project URL in the security rules

6. Open `vercel.json`. Find `https://YOUR-PROJECT-REF.supabase.co` and replace it with **your** Project URL from step 5. Save and commit.
   (The build refuses to run until you do this, so you cannot forget.)

## Part C: Vercel (the website)

7. Go to <https://vercel.com>, sign in with GitHub, click **Add New… → Project**, choose the `end-of--year-party` repository, click **Import**.
8. Before clicking Deploy, open **Environment Variables** and add:

   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | your Project URL from step 5 |
   | `SUPABASE_ANON_KEY` | your anon / publishable key from step 5 |

   Leave the build settings alone. `vercel.json` already sets them (build command `node scripts/build.mjs`, output folder `public`).
9. Click **Deploy**. When it finishes, click the link to open your site.
   - If the build fails, open the build log. The last line says exactly what is missing.

## Part D: Test the live site (about 10 minutes)

Use your phone for at least one of these. Write ✅ or ❌ next to each.

| # | Test | How | Expected |
|---|---|---|---|
| 1 | **Valid submit** | Fill every field with real-looking data, choose **Yes**, tick consent, submit. | "Registration received" + `[PAYMENT INSTRUCTIONS TO BE ADDED]`. In Supabase **Table Editor → rsvps** you see one new row, with `consent_at`, `policy_version = v1-2026-11-17` and `notified = false`. |
| 2 | **Invalid submit** | Leave name empty, type `abc` as email, submit. | Red messages under the fields, cursor jumps to the first bad field, nothing new in the table. |
| 3 | **Duplicate email** | Submit again with the **same email** (try capital letters too) and a different name. | "Already registered…" with your contact. The row in the table still has the **first** name. |
| 4 | **Honeypot filled** | On a laptop: right-click the page → Inspect → Console, paste `document.getElementById('site').value='spam'` and press Enter. Then fill the form normally and submit. | Looks like a success, but **no** new row appears in the table. |
| 5 | **Anonymous SELECT must fail** | Run the command below in a terminal (replace the two values). | The reply is an error like `permission denied for table rsvps` (code `42501`). It must **not** list any rows. |
| 6 | **Mobile layout** | Open the site on your phone. | No sideways scrolling, every button is easy to tap, the form fits the screen. |

Command for test 5:

```bash
curl -s "https://YOUR-PROJECT-REF.supabase.co/rest/v1/rsvps?select=*" -H "apikey: YOUR_ANON_KEY" -H "Authorization: Bearer YOUR_ANON_KEY"
```

Also check the security headers. Paste your site address into <https://securityheaders.com>. You should get an **A** or better.

When you are done testing, delete your test rows: `docs/PRIVACY-RUNBOOK.md` shows how.

## Part E: Turn on backups (recommended)

Supabase free plan keeps daily backups for a short time only. Before the event, open **Database → Backups**, check that backups exist. If you upgrade the plan, try a restore to a new project once.
