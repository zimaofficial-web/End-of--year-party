-- Fix: registrations from the website failed with
--   new row violates row-level security policy for table "rsvp_attempts"
--
-- The Supabase project switches RLS on automatically for every new table,
-- including the private rate-limit tables. RLS with no policy denies
-- everything, so register_rsvp (running as rsvp_writer) could not write its
-- rate-limit row or read the IP salt.
--
-- Keep RLS on (and forced) for both private tables, and add explicit,
-- per-operation policies for rsvp_writer only. anon/authenticated still have
-- no privileges on schema private at all.

begin;

alter table private.rsvp_attempts enable row level security;
alter table private.rsvp_attempts force row level security;
alter table private.settings      enable row level security;
alter table private.settings      force row level security;

drop policy if exists rsvp_attempts_select_writer on private.rsvp_attempts;
drop policy if exists rsvp_attempts_insert_writer on private.rsvp_attempts;
drop policy if exists rsvp_attempts_delete_writer on private.rsvp_attempts;
drop policy if exists settings_select_writer      on private.settings;

create policy rsvp_attempts_select_writer on private.rsvp_attempts
  for select to rsvp_writer using (true);
create policy rsvp_attempts_insert_writer on private.rsvp_attempts
  for insert to rsvp_writer with check (char_length(ip_hash) = 64);
create policy rsvp_attempts_delete_writer on private.rsvp_attempts
  for delete to rsvp_writer using (created_at < now() - interval '24 hours');
create policy settings_select_writer on private.settings
  for select to rsvp_writer using (key = 'ip_salt');

commit;
