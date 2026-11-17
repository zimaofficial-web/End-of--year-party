-- Tickets, QR codes, payment status, gate check-in and admins.
-- ---------------------------------------------------------------------------
-- Run AFTER 20261117000000_create_rsvps.sql.
--
-- Security model (extends docs/adr/001-rpc-only-writes.md, see ADR 002):
--   * anon still has NO table privileges. register_rsvp() now also returns the
--     person's ticket code and secret QR token (only on a NEW registration,
--     never for a duplicate email).
--   * Admins log in with Supabase Auth (accounts created by the super admin in
--     the Supabase dashboard; public sign-ups must be OFF). The `authenticated`
--     role also has NO table privileges. Every admin action is a function that
--     first checks the caller's email (from the verified login token) against
--     public.admins.
--   * Admin functions run as the non-login role rsvp_admin_ops, which can only
--     read rsvps, update the payment/check-in columns, and manage public.admins.
-- ---------------------------------------------------------------------------

begin;

-- 1. New columns on rsvps ----------------------------------------------------
create sequence if not exists private.ticket_seq start 1;

alter table public.rsvps
  add column ticket_code   text,
  add column ticket_token  uuid,
  add column paid          boolean     not null default false,
  add column paid_at       timestamptz,
  add column paid_by       text,
  add column checked_in_at timestamptz,
  add column checked_in_by text;

-- Give rows that already exist (e.g. test registrations) a code and token.
update public.rsvps
   set ticket_code  = 'MF-' || lpad(nextval('private.ticket_seq')::text, 4, '0'),
       ticket_token = gen_random_uuid()
 where ticket_code is null;

alter table public.rsvps
  alter column ticket_code  set not null,
  alter column ticket_token set not null,
  add constraint rsvps_ticket_code_key  unique (ticket_code),
  add constraint rsvps_ticket_token_key unique (ticket_token),
  add constraint rsvps_ticket_code_format check (ticket_code ~ '^MF-[0-9]{4,}$'),
  add constraint rsvps_paid_consistent check ((paid and paid_at is not null) or (not paid and paid_at is null)),
  add constraint rsvps_checkin_needs_paid check (checked_in_at is null or paid),
  add constraint rsvps_paid_by_len check (paid_by is null or char_length(paid_by) <= 120),
  add constraint rsvps_checked_in_by_len check (checked_in_by is null or char_length(checked_in_by) <= 120);

grant usage on sequence private.ticket_seq to rsvp_writer;

-- 2. Admins ------------------------------------------------------------------
create table public.admins (
  email            text        primary key
                   check (email = lower(btrim(email))
                          and char_length(email) between 6 and 120
                          and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  role             text        not null check (role in ('super_admin', 'admin')),
  receives_emails  boolean     not null default false,
  created_at       timestamptz not null default now(),
  created_by       text        null check (created_by is null or char_length(created_by) <= 120)
);

comment on table public.admins is
  'Who may use the admin site. Login accounts are created separately in Supabase Auth.';

alter table public.admins enable row level security;
alter table public.admins force row level security;
revoke all on table public.admins from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.admins from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.admins from authenticated';
  end if;
end $$;

insert into public.admins (email, role, receives_emails, created_by) values
  ('zimaofficial001@gmail.com', 'super_admin', true,  'migration'),
  ('louissainaboya@gmail.com',  'admin',       false, 'migration');

-- 3. Role that admin functions run as ------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'rsvp_admin_ops') then
    create role rsvp_admin_ops nologin noinherit nobypassrls;
  end if;
end $$;
grant rsvp_admin_ops to current_user;

grant usage on schema public to rsvp_admin_ops;
grant select on table public.rsvps to rsvp_admin_ops;
grant update (paid, paid_at, paid_by, checked_in_at, checked_in_by) on table public.rsvps to rsvp_admin_ops;
grant select, insert, update, delete on table public.admins to rsvp_admin_ops;

create policy rsvps_select_for_admin_functions on public.rsvps
  for select to rsvp_admin_ops using (true);
create policy rsvps_update_for_admin_functions on public.rsvps
  for update to rsvp_admin_ops using (true) with check (true);

create policy admins_select_for_admin_functions on public.admins
  for select to rsvp_admin_ops using (true);
create policy admins_insert_for_admin_functions on public.admins
  for insert to rsvp_admin_ops with check (true);
create policy admins_update_for_admin_functions on public.admins
  for update to rsvp_admin_ops using (true) with check (true);
create policy admins_delete_for_admin_functions on public.admins
  for delete to rsvp_admin_ops using (true);

-- 4. register_rsvp now returns the ticket -------------------------------------
-- Return type changes (text -> jsonb), so the old function must be dropped.
drop function public.register_rsvp(text, text, text, text, text, boolean, text);

create function public.register_rsvp(
  p_name      text,
  p_email     text,
  p_phone     text,
  p_attending text,
  p_bringing  text,
  p_consent   boolean,
  p_site      text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_policy_version constant text := 'v1-2026-11-17';
  c_max_attempts   constant int  := 5;
  c_window         constant interval := interval '10 minutes';
  v_headers  json;
  v_ip       text;
  v_ip_hash  text;
  v_salt     text;
  v_attempts int;
  v_rows     int;
  v_code     text;
  v_token    uuid;
begin
  if coalesce(btrim(p_site), '') <> '' then
    return jsonb_build_object('status', 'rejected');
  end if;

  if p_consent is distinct from true then
    return jsonb_build_object('status', 'invalid');
  end if;

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
     where ip_hash = v_ip_hash and created_at > now() - c_window;
    if v_attempts >= c_max_attempts then
      return jsonb_build_object('status', 'rate_limited');
    end if;
    insert into private.rsvp_attempts (ip_hash) values (v_ip_hash);
  end if;

  v_code  := 'MF-' || lpad(nextval('private.ticket_seq')::text, 4, '0');
  v_token := gen_random_uuid();

  begin
    insert into public.rsvps
      (name, email, phone, attending, bringing, consent, consent_at, policy_version,
       ticket_code, ticket_token)
    values
      (btrim(p_name),
       lower(btrim(p_email)),
       regexp_replace(coalesce(p_phone, ''), '[[:space:]-]', '', 'g'),
       p_attending,
       nullif(btrim(p_bringing), ''),
       p_consent,
       now(),
       c_policy_version,
       v_code,
       v_token)
    on conflict do nothing;   -- no target: a target would need SELECT privilege
    get diagnostics v_rows = row_count;
  exception
    when check_violation or not_null_violation or string_data_right_truncation
         or invalid_text_representation then
      return jsonb_build_object('status', 'invalid');
    when unique_violation then
      return jsonb_build_object('status', 'duplicate');
  end;

  if v_rows = 0 then
    return jsonb_build_object('status', 'duplicate');   -- never reveal the existing ticket
  end if;

  if p_attending = 'yes' then
    return jsonb_build_object('status', 'created', 'ticket_code', v_code, 'ticket_token', v_token);
  end if;
  return jsonb_build_object('status', 'created', 'ticket_code', v_code);
end;
$$;

grant create on schema public to rsvp_writer;
alter function public.register_rsvp(text, text, text, text, text, boolean, text) owner to rsvp_writer;
revoke create on schema public from rsvp_writer;
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

-- 5. Admin functions ---------------------------------------------------------
-- Who is calling? Supabase puts the verified login token's claims here.
create function public.current_admin_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select a.role
    from public.admins a
   where a.email = lower(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
     and (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role') = 'authenticated';
$$;

create function public.admin_list_rsvps()
returns table (
  ticket_code text, name text, email text, phone text, attending text, bringing text,
  paid boolean, paid_at timestamptz, paid_by text,
  checked_in_at timestamptz, checked_in_by text, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if public.current_admin_role() is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return query
    select r.ticket_code, r.name, r.email, r.phone, r.attending, r.bringing,
           r.paid, r.paid_at, r.paid_by, r.checked_in_at, r.checked_in_by, r.created_at
      from public.rsvps r
     order by r.created_at desc;
end;
$$;

create function public.admin_set_paid(p_ticket_code text, p_paid boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me   text := lower(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email');
  v_row  record;
begin
  if public.current_admin_role() is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select r.ticket_code, r.checked_in_at into v_row
    from public.rsvps r where r.ticket_code = upper(btrim(p_ticket_code));
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if not coalesce(p_paid, false) and v_row.checked_in_at is not null then
    return jsonb_build_object('result', 'already_checked_in');
  end if;

  update public.rsvps r
     set paid    = coalesce(p_paid, false),
         paid_at = case when coalesce(p_paid, false) then coalesce(r.paid_at, now()) end,
         paid_by = case when coalesce(p_paid, false) then coalesce(r.paid_by, v_me) end
   where r.ticket_code = v_row.ticket_code;

  return jsonb_build_object('result', 'ok', 'ticket_code', v_row.ticket_code, 'paid', coalesce(p_paid, false));
end;
$$;

-- Gate: scan a QR (token) or type a ticket code. Checks in only if paid and
-- not used before. The row is locked so two phones can't admit the same ticket.
create function public.gate_check_in(p_token uuid default null, p_code text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me  text := lower(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email');
  v_row record;
begin
  if public.current_admin_role() is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select r.id, r.ticket_code, r.name, r.attending, r.paid, r.checked_in_at, r.checked_in_by
    into v_row
    from public.rsvps r
   where (p_token is not null and r.ticket_token = p_token)
      or (p_token is null and p_code is not null and r.ticket_code = upper(btrim(p_code)))
   for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_row.attending <> 'yes' then
    return jsonb_build_object('result', 'not_attending', 'ticket_code', v_row.ticket_code, 'name', v_row.name);
  end if;
  if not v_row.paid then
    return jsonb_build_object('result', 'not_paid', 'ticket_code', v_row.ticket_code, 'name', v_row.name);
  end if;
  if v_row.checked_in_at is not null then
    return jsonb_build_object('result', 'already_used', 'ticket_code', v_row.ticket_code, 'name', v_row.name,
                              'checked_in_at', v_row.checked_in_at, 'checked_in_by', v_row.checked_in_by);
  end if;

  update public.rsvps r
     set checked_in_at = now(), checked_in_by = v_me
   where r.id = v_row.id;

  return jsonb_build_object('result', 'ok', 'ticket_code', v_row.ticket_code, 'name', v_row.name);
end;
$$;

-- Super admin only ------------------------------------------------------------
create function public.super_list_admins()
returns table (email text, role text, receives_emails boolean, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if public.current_admin_role() is distinct from 'super_admin' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return query select a.email, a.role, a.receives_emails, a.created_at
                 from public.admins a order by a.role desc, a.email;
end;
$$;

create function public.super_upsert_admin(p_email text, p_role text, p_receives_emails boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me    text := lower(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email');
  v_email text := lower(btrim(p_email));
begin
  if public.current_admin_role() is distinct from 'super_admin' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_role not in ('super_admin', 'admin') then
    return jsonb_build_object('result', 'invalid');
  end if;
  -- Never leave the portal without a super admin.
  if p_role = 'admin'
     and exists (select 1 from public.admins where email = v_email and role = 'super_admin')
     and (select count(*) from public.admins where role = 'super_admin') <= 1 then
    return jsonb_build_object('result', 'last_super_admin');
  end if;

  begin
    insert into public.admins as a (email, role, receives_emails, created_by)
    values (v_email, p_role, coalesce(p_receives_emails, false), v_me)
    on conflict (email) do update
      set role = excluded.role, receives_emails = excluded.receives_emails;
  exception when check_violation or not_null_violation then
    return jsonb_build_object('result', 'invalid');
  end;
  return jsonb_build_object('result', 'ok');
end;
$$;

create function public.super_remove_admin(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(p_email));
begin
  if public.current_admin_role() is distinct from 'super_admin' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if exists (select 1 from public.admins where email = v_email and role = 'super_admin')
     and (select count(*) from public.admins where role = 'super_admin') <= 1 then
    return jsonb_build_object('result', 'last_super_admin');
  end if;
  delete from public.admins where email = v_email;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  return jsonb_build_object('result', 'ok');
end;
$$;

-- Hand the admin functions to rsvp_admin_ops and expose them to logged-in users only.
grant create on schema public to rsvp_admin_ops;
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.current_admin_role()',
    'public.admin_list_rsvps()',
    'public.admin_set_paid(text, boolean)',
    'public.gate_check_in(uuid, text)',
    'public.super_list_admins()',
    'public.super_upsert_admin(text, text, boolean)',
    'public.super_remove_admin(text)'
  ] loop
    execute format('alter function %s owner to rsvp_admin_ops', f);
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon', f);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('grant execute on function %s to authenticated', f);
    end if;
  end loop;
end $$;
revoke create on schema public from rsvp_admin_ops;
-- rsvp_admin_ops functions call current_admin_role(); the owner may execute its own functions.

commit;
