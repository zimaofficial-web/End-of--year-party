-- Miva Fest registrations
-- ---------------------------------------------------------------------------
-- Security model (see docs/adr/001-rpc-only-writes.md):
--   * The browser uses the public anon key. The anon role has NO privileges on
--     the rsvps table at all: it cannot SELECT, INSERT, UPDATE or DELETE.
--   * The only thing anon can do is EXECUTE public.register_rsvp(). That
--     function runs as the dedicated, non-login role rsvp_writer, which can
--     only INSERT (enforced by RLS + grants). It checks the honeypot, applies a
--     rate limit and never overwrites an existing registration.
--   * Reading/deleting rows is for the project owner only: Supabase dashboard
--     (postgres) or the service_role key, which never leaves the server.
-- ---------------------------------------------------------------------------

begin;

-- 1. Private schema: not exposed through the Supabase API --------------------
create schema if not exists private;
revoke all on schema private from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema private from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema private from authenticated';
  end if;
end $$;

-- Random salt used to hash IP addresses for rate limiting. Generated once,
-- never leaves the database.
create table private.settings (
  key   text primary key,
  value text not null
);
insert into private.settings (key, value)
values ('ip_salt', gen_random_uuid()::text || gen_random_uuid()::text);

-- Rate-limit log. Stores only a salted SHA-256 hash of the IP, never the IP.
-- Rows older than 24 hours are deleted on every call to register_rsvp().
create table private.rsvp_attempts (
  id          bigint generated always as identity primary key,
  ip_hash     text        not null check (char_length(ip_hash) = 64),
  created_at  timestamptz not null default now()
);
create index rsvp_attempts_ip_time_idx on private.rsvp_attempts (ip_hash, created_at);
create index rsvp_attempts_time_idx on private.rsvp_attempts (created_at);

-- 2. The registrations table -------------------------------------------------
create table public.rsvps (
  id              uuid        primary key default gen_random_uuid(),
  name            text        not null
                  check (char_length(name) between 2 and 80
                         and name = btrim(name)
                         and name !~ '[[:cntrl:]]'),
  email           text        not null
                  constraint rsvps_email_key unique
                  check (char_length(email) between 6 and 120
                         and email = lower(btrim(email))
                         and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  phone           text        not null
                  check (phone ~ '^\+?[0-9]{10,15}$'),
  attending       text        not null
                  check (attending in ('yes', 'no')),
  bringing        text        null      -- optional field in the form
                  check (bringing is null
                         or (char_length(bringing) between 1 and 300
                             and bringing !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]')),
  consent         boolean     not null
                  check (consent = true),
  consent_at      timestamptz not null default now(),
  policy_version  text        not null
                  check (char_length(policy_version) between 1 and 40),
  created_at      timestamptz not null default now(),
  -- For the email step later: an Edge Function sets this to true after it has
  -- emailed the organiser about the row. See docs/EMAIL-HOOK.md.
  notified        boolean     not null default false
);

comment on table public.rsvps is
  'Miva Fest registrations. Personal data: delete all rows by 31 Jan 2027 (docs/PRIVACY-RUNBOOK.md).';

-- Lets the future notifier find unsent rows quickly.
create index rsvps_unnotified_idx on public.rsvps (created_at) where notified = false;

-- 3. Row Level Security ------------------------------------------------------
alter table public.rsvps enable row level security;
alter table public.rsvps force row level security;

-- Supabase grants table privileges to anon/authenticated by default.
-- Take them all away.
revoke all on table public.rsvps from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.rsvps from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.rsvps from authenticated';
  end if;
end $$;

-- Dedicated non-login role that owns the registration function.
-- It is NOT a superuser and does NOT bypass RLS, so the policy below applies.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'rsvp_writer') then
    create role rsvp_writer nologin noinherit nobypassrls;
  end if;
end $$;
-- Needed so the migration user may hand the function over to rsvp_writer.
grant rsvp_writer to current_user;

grant usage on schema public, private to rsvp_writer;
grant insert on table public.rsvps to rsvp_writer;           -- no SELECT/UPDATE/DELETE
grant select on table private.settings to rsvp_writer;
grant select, insert, delete on table private.rsvp_attempts to rsvp_writer;

-- One explicit policy per operation. Only INSERT exists, only for rsvp_writer.
-- No SELECT, UPDATE or DELETE policies exist, so those are denied to every
-- role that does not bypass RLS (anon, authenticated, rsvp_writer).
create policy rsvps_insert_via_register_function
  on public.rsvps
  for insert
  to rsvp_writer
  with check (consent = true and notified = false);

-- 4. The only entry point for the website ------------------------------------
-- Returns one of: 'created' | 'duplicate' | 'invalid' | 'rate_limited' | 'rejected'
-- Never returns database error text.
create or replace function public.register_rsvp(
  p_name      text,
  p_email     text,
  p_phone     text,
  p_attending text,
  p_bringing  text,
  p_consent   boolean,
  p_site      text default ''          -- honeypot: must be empty
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_policy_version constant text := 'v1-2026-11-17';
  c_max_attempts   constant int  := 5;                    -- per IP ...
  c_window         constant interval := interval '10 minutes'; -- ... per window
  v_headers  json;
  v_ip       text;
  v_ip_hash  text;
  v_salt     text;
  v_attempts int;
  v_rows     int;
begin
  -- Honeypot: humans never see or fill this field.
  if coalesce(btrim(p_site), '') <> '' then
    return 'rejected';
  end if;

  -- Consent must be explicitly true (the CHECK constraint enforces it too,
  -- but the RLS policy would reject first with a permission error).
  if p_consent is distinct from true then
    return 'invalid';
  end if;

  -- Rate limit by salted IP hash. PostgREST exposes request headers here.
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    v_headers := null;
  end;
  v_ip := btrim(split_part(coalesce(v_headers ->> 'x-forwarded-for',
                                    v_headers ->> 'cf-connecting-ip',
                                    v_headers ->> 'x-real-ip', ''), ',', 1));

  delete from private.rsvp_attempts where created_at < now() - interval '24 hours';

  if v_ip <> '' then
    select value into v_salt from private.settings where key = 'ip_salt';
    v_ip_hash := encode(sha256(convert_to(v_salt || v_ip, 'UTF8')), 'hex');

    select count(*) into v_attempts
      from private.rsvp_attempts
     where ip_hash = v_ip_hash
       and created_at > now() - c_window;

    if v_attempts >= c_max_attempts then
      return 'rate_limited';
    end if;

    insert into private.rsvp_attempts (ip_hash) values (v_ip_hash);
  end if;

  -- Normalise, then let the CHECK constraints do the real validation.
  begin
    insert into public.rsvps
      (name, email, phone, attending, bringing, consent, consent_at, policy_version)
    values
      (btrim(p_name),
       lower(btrim(p_email)),
       regexp_replace(coalesce(p_phone, ''), '[[:space:]-]', '', 'g'),
       p_attending,
       nullif(btrim(p_bringing), ''),
       p_consent,
       now(),
       c_policy_version)
    -- One registration per email; never overwrite. No conflict target on
    -- purpose: a target would need SELECT privilege, which rsvp_writer lacks.
    -- The only unique key that can clash is rsvps_email_key (id is a fresh UUID).
    on conflict do nothing;

    get diagnostics v_rows = row_count;
  exception
    when check_violation or not_null_violation or string_data_right_truncation
         or invalid_text_representation then
      return 'invalid';
    when unique_violation then
      return 'duplicate';
  end;

  if v_rows = 0 then
    return 'duplicate';
  end if;
  return 'created';
end;
$$;

-- A new owner must hold CREATE on the schema. Grant it only for the hand-over,
-- then take it back so rsvp_writer cannot create anything.
grant create on schema public to rsvp_writer;
alter function public.register_rsvp(text, text, text, text, text, boolean, text) owner to rsvp_writer;
revoke create on schema public from rsvp_writer;

-- Supabase grants EXECUTE on new functions to public/anon/authenticated by
-- default. Reset, then allow only anon (the website).
revoke all on function public.register_rsvp(text, text, text, text, text, boolean, text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.register_rsvp(text, text, text, text, text, boolean, text) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function public.register_rsvp(text, text, text, text, text, boolean, text) to anon';
  end if;
end $$;

commit;
