-- Tests for tickets, payment, gate check-in and the admin portal functions.
-- Run with:  bash scripts/test-db.sh   (runs after rsvps_test.sql)
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null
set client_min_messages = notice;

create or replace function pg_temp.check(p_ok boolean, p_label text) returns void
language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_label; end if;
  raise notice 'PASS: %', p_label;
end $$;

-- Register as anon; returns the full jsonb answer.
create or replace function pg_temp.reg(p_email text, p_att text default 'yes', p_name text default 'Test Person')
returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform set_config('request.headers', json_build_object('x-forwarded-for', '198.51.100.' || (random()*250)::int)::text, true);
  set local role anon;
  r := public.register_rsvp(p_name, p_email, '08012345678', p_att, '', true, '');
  reset role;
  return r;
end $$;

-- Run SQL as a logged-in user with the given email; returns result text or SQLSTATE.
create or replace function pg_temp.as_user(p_email text, p_sql text) returns text
language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claims',
                     json_build_object('email', p_email, 'role', 'authenticated', 'sub', gen_random_uuid())::text, true);
  set local role authenticated;
  execute p_sql into r;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
exception when others then
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return 'ERR:' || sqlstate;
end $$;

create or replace function pg_temp.as_anon(p_sql text) returns text
language plpgsql as $$
declare r text;
begin
  set local role anon;
  execute p_sql into r;
  reset role;
  return r;
exception when others then
  reset role;
  return 'ERR:' || sqlstate;
end $$;

begin;

\set SUPER 'zimaofficial001@gmail.com'
\set ADMIN 'louissainaboya@gmail.com'

-- ------------------------------------------------------------- structure
select pg_temp.check((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.admins'::regclass),
                     'RLS enabled AND forced on public.admins');
select pg_temp.check(not exists (select 1 from pg_policies where schemaname='public' and tablename='admins'
                                   and (roles <> '{rsvp_admin_ops}' or cmd = 'ALL')),
                     'admins policies exist only for rsvp_admin_ops, one per operation, none FOR ALL');
select pg_temp.check((select count(*) = 4 from pg_policies where schemaname='public' and tablename='admins'),
                     'admins has separate SELECT/INSERT/UPDATE/DELETE policies');
select pg_temp.check((select bool_and(p.prosecdef and 'search_path=""' = any(p.proconfig)
                                      and r.rolname = 'rsvp_admin_ops' and not r.rolsuper and not r.rolbypassrls)
                      from pg_proc p join pg_roles r on r.oid = p.proowner
                      where p.pronamespace = 'public'::regnamespace
                        and p.proname in ('current_admin_role','admin_list_rsvps','admin_set_paid','gate_check_in',
                                          'super_list_admins','super_upsert_admin','super_remove_admin','super_delete_rsvp')),
                     'all 8 admin functions: SECURITY DEFINER, search_path pinned, owned by non-superuser rsvp_admin_ops');
select pg_temp.check((select bool_and(not has_function_privilege('anon', p.oid, 'execute')
                                      and not has_function_privilege('public', p.oid, 'execute')
                                      and has_function_privilege('authenticated', p.oid, 'execute'))
                      from pg_proc p where p.pronamespace = 'public'::regnamespace
                        and p.proname in ('current_admin_role','admin_list_rsvps','admin_set_paid','gate_check_in',
                                          'super_list_admins','super_upsert_admin','super_remove_admin','super_delete_rsvp')),
                     'admin functions: EXECUTE for authenticated only (not anon, not PUBLIC)');
select pg_temp.check(not has_table_privilege('authenticated', 'public.rsvps', 'select')
                     and not has_table_privilege('authenticated', 'public.rsvps', 'update')
                     and not has_table_privilege('authenticated', 'public.admins', 'select')
                     and not has_table_privilege('anon', 'public.admins', 'select'),
                     'anon/authenticated still have no table privileges on rsvps or admins');
select pg_temp.check((select count(*) = 2 from public.admins)
                     and exists (select 1 from public.admins where email = :'SUPER' and role = 'super_admin' and receives_emails)
                     and exists (select 1 from public.admins where email = :'ADMIN' and role = 'admin' and not receives_emails),
                     'seeded: zimaofficial001 = super admin (emails on), louissainaboya = admin (emails off)');

-- --------------------------------------------------------------- tickets
create temp table t_yes as select pg_temp.reg('yes1@example.com', 'yes', 'Yes Person') as r;
create temp table t_no  as select pg_temp.reg('no1@example.com',  'no',  'No Person')  as r;
grant select on t_yes, t_no to public;

select pg_temp.check((select r->>'status' = 'created' and r->>'ticket_code' ~ '^MF-[0-9]{4,}$'
                        and (r->>'ticket_token')::uuid is not null from t_yes),
                     '"yes" registration returns status, ticket code MF-#### and a secret QR token');
select pg_temp.check((select r->>'status' = 'created' and r ? 'ticket_code' and not r ? 'ticket_token' from t_no),
                     '"no" registration returns a code but no QR token');
select pg_temp.check((select (r->>'ticket_token')::uuid = x.ticket_token and r->>'ticket_code' = x.ticket_code
                      from t_yes, public.rsvps x where x.email = 'yes1@example.com'),
                     'returned code/token match what is stored');
select pg_temp.check((select r = '{"status":"duplicate"}'::jsonb from (select pg_temp.reg('YES1@example.com') r) d),
                     'duplicate email returns ONLY {"status":"duplicate"}: the existing ticket is never revealed');
select pg_temp.check((select count(distinct ticket_code) = count(*) and count(distinct ticket_token) = count(*) from public.rsvps),
                     'ticket codes and tokens are unique');
select pg_temp.check((select not paid and paid_at is null and checked_in_at is null from public.rsvps where email = 'yes1@example.com'),
                     'new registrations start as NOT paid and NOT checked in');

-- ------------------------------------------------------ who can do what
select pg_temp.check(pg_temp.as_anon('select public.current_admin_role()') = 'ERR:42501',
                     'anon cannot call admin functions');
select pg_temp.check(pg_temp.as_anon($q$select public.gate_check_in(null, 'MF-0001')::text$q$) = 'ERR:42501',
                     'anon cannot call gate_check_in');
select pg_temp.check(pg_temp.as_user('stranger@example.com', 'select coalesce(public.current_admin_role(), $$none$$)') = 'none',
                     'logged-in stranger has no admin role');
select pg_temp.check(pg_temp.as_user('stranger@example.com', 'select count(*)::text from public.admin_list_rsvps()') = 'ERR:42501',
                     'logged-in stranger cannot list registrations');
select pg_temp.check(pg_temp.as_user('stranger@example.com', $q$select public.gate_check_in(null, 'MF-0001')::text$q$) = 'ERR:42501',
                     'logged-in stranger cannot use the gate');
select pg_temp.check(pg_temp.as_user(:'ADMIN', 'select public.current_admin_role()') = 'admin',
                     'louissainaboya is recognised as admin');
select pg_temp.check(pg_temp.as_user('LouissaInaboya@Gmail.com', 'select public.current_admin_role()') = 'admin',
                     'admin email match is case-insensitive');
select pg_temp.check(pg_temp.as_user(:'SUPER', 'select public.current_admin_role()') = 'super_admin',
                     'zimaofficial001 is recognised as super admin');
select pg_temp.check(pg_temp.as_user(:'ADMIN', 'select count(*)::text from public.admin_list_rsvps()')::int >= 2,
                     'admin can list registrations');
select pg_temp.check(pg_temp.as_user(:'ADMIN', 'select count(*)::text from public.rsvps') = 'ERR:42501',
                     'admin still cannot read the table directly (functions only)');
select pg_temp.check(pg_temp.as_user(:'ADMIN', 'select count(*)::text from public.super_list_admins()') = 'ERR:42501',
                     'regular admin cannot list admins');
select pg_temp.check(pg_temp.as_user(:'ADMIN', $q$select public.super_upsert_admin('evil@example.com','super_admin',true)::text$q$) = 'ERR:42501',
                     'regular admin cannot add admins / promote anyone');
select pg_temp.check(pg_temp.as_user(:'ADMIN', $q$select public.super_remove_admin('zimaofficial001@gmail.com')::text$q$) = 'ERR:42501',
                     'regular admin cannot remove admins');
-- A token whose role claim is not "authenticated" (e.g. forged anon claims) gets nothing.
select pg_temp.check((select coalesce((
         select r from (select set_config('request.jwt.claims', json_build_object('email', :'SUPER', 'role', 'anon')::text, true)) s,
                       lateral (select public.current_admin_role() r) x), 'none')) = 'none',
                     'claims with role other than "authenticated" are not treated as admin');

-- ------------------------------------------------------------ gate flow
select pg_temp.check(pg_temp.as_user(:'ADMIN', format('select public.gate_check_in(%L::uuid, null)->>$$result$$',
                       (select r->>'ticket_token' from t_yes))) = 'not_paid',
                     'gate: unpaid ticket -> NOT PAID, and is not checked in');
select pg_temp.check((select checked_in_at is null from public.rsvps where email = 'yes1@example.com'),
                     'gate: NOT PAID scan did not mark the ticket used');
select pg_temp.check(pg_temp.as_user(:'ADMIN', format('select public.admin_set_paid(%L, true)->>$$result$$',
                       lower((select r->>'ticket_code' from t_yes)))) = 'ok',
                     'admin marks the ticket paid (code is case-insensitive)');
select pg_temp.check((select paid and paid_at is not null and paid_by = 'louissainaboya@gmail.com'
                      from public.rsvps where email = 'yes1@example.com'),
                     'paid, paid_at and paid_by recorded');
select pg_temp.check(pg_temp.as_user(:'ADMIN', format('select public.gate_check_in(%L::uuid, null)->>$$result$$',
                       (select r->>'ticket_token' from t_yes))) = 'ok',
                     'gate: paid ticket, first scan -> OK (admitted)');
select pg_temp.check((select checked_in_at is not null and checked_in_by = 'louissainaboya@gmail.com'
                      from public.rsvps where email = 'yes1@example.com'),
                     'gate: check-in time and staff email recorded');
select pg_temp.check(pg_temp.as_user(:'SUPER', format('select public.gate_check_in(%L::uuid, null)->>$$result$$',
                       (select r->>'ticket_token' from t_yes))) = 'already_used',
                     'gate: second scan of the same QR -> ALREADY USED');
select pg_temp.check(pg_temp.as_user(:'SUPER', format('select public.gate_check_in(null, %L)->>$$result$$',
                       (select r->>'ticket_code' from t_yes))) = 'already_used',
                     'gate: typing the code of a used ticket -> ALREADY USED');
select pg_temp.check(pg_temp.as_user(:'ADMIN', format('select public.admin_set_paid(%L, false)->>$$result$$',
                       (select r->>'ticket_code' from t_yes))) = 'already_checked_in',
                     'cannot un-pay a ticket that was already used at the gate');
select pg_temp.check(pg_temp.as_user(:'ADMIN', format('select public.gate_check_in(null, %L)->>$$result$$',
                       (select r->>'ticket_code' from t_no))) = 'not_attending',
                     'gate: a "no" registration -> NOT ATTENDING');
select pg_temp.check(pg_temp.as_user(:'ADMIN', $q$select public.gate_check_in(gen_random_uuid(), null)->>'result'$q$) = 'not_found',
                     'gate: random/forged QR token -> NOT FOUND');
select pg_temp.check(pg_temp.as_user(:'ADMIN', $q$select public.admin_set_paid('MF-99999', true)->>'result'$q$) = 'not_found',
                     'set paid on unknown code -> not_found');
select pg_temp.check(pg_temp.as_user(:'ADMIN', $q$select public.gate_check_in(null, null)->>'result'$q$) = 'not_found',
                     'gate with nothing scanned -> not_found');

-- -------------------------------------------------------- admin management
select pg_temp.check(pg_temp.as_user(:'SUPER', 'select count(*)::text from public.super_list_admins()') = '2',
                     'super admin can list admins');
select pg_temp.check(pg_temp.as_user(:'SUPER', $q$select public.super_upsert_admin(' New.Helper@Example.com ','admin',false)->>'result'$q$) = 'ok',
                     'super admin adds an admin');
select pg_temp.check(exists (select 1 from public.admins where email = 'new.helper@example.com' and role = 'admin'
                             and created_by = 'zimaofficial001@gmail.com'),
                     'new admin stored lower-case with created_by');
select pg_temp.check(pg_temp.as_user(:'SUPER', $q$select public.super_upsert_admin('louissainaboya@gmail.com','admin',true)->>'result'$q$) = 'ok',
                     'super admin switches emails ON for an admin');
select pg_temp.check((select receives_emails from public.admins where email = 'louissainaboya@gmail.com'),
                     '... and it is stored');
select pg_temp.check(pg_temp.as_user(:'SUPER', $q$select public.super_upsert_admin('not-an-email','admin',false)->>'result'$q$) = 'invalid',
                     'invalid admin email rejected');
select pg_temp.check(pg_temp.as_user(:'SUPER', $q$select public.super_upsert_admin('x@example.com','owner',false)->>'result'$q$) = 'invalid',
                     'unknown role rejected');
select pg_temp.check(pg_temp.as_user(:'SUPER', $q$select public.super_upsert_admin('zimaofficial001@gmail.com','admin',true)->>'result'$q$) = 'last_super_admin',
                     'the last super admin cannot be demoted');
select pg_temp.check(pg_temp.as_user(:'SUPER', $q$select public.super_remove_admin('zimaofficial001@gmail.com')->>'result'$q$) = 'last_super_admin',
                     'the last super admin cannot be removed');
select pg_temp.check(pg_temp.as_user(:'SUPER', $q$select public.super_remove_admin('new.helper@example.com')->>'result'$q$) = 'ok',
                     'super admin removes an admin');
select pg_temp.check(not exists (select 1 from public.admins where email = 'new.helper@example.com'),
                     '... and the row is gone');
select pg_temp.check(pg_temp.as_user('new.helper@example.com', 'select coalesce(public.current_admin_role(), $$none$$)') = 'none',
                     'a removed admin loses access immediately');

-- ------------------------------------------------------ deleting registrations
select pg_temp.check(pg_temp.as_anon($q$select public.super_delete_rsvp('MF-0001','MF-0001')::text$q$) = 'ERR:42501',
                     'anon cannot delete registrations');
select pg_temp.check(pg_temp.as_user(:'ADMIN', format('select public.super_delete_rsvp(%L, %L)::text',
                       (select r->>'ticket_code' from t_no), (select r->>'ticket_code' from t_no))) = 'ERR:42501',
                     'regular admin cannot delete registrations');
select pg_temp.check(pg_temp.as_user(:'SUPER', format('select public.super_delete_rsvp(%L, %L)->>$$result$$',
                       (select r->>'ticket_code' from t_no), 'MF-0000')) = 'confirm_mismatch',
                     'delete with the wrong confirmation code is refused');
select pg_temp.check(exists (select 1 from public.rsvps where email = 'no1@example.com'),
                     '... and nothing was deleted');
select pg_temp.check(pg_temp.as_user(:'SUPER', format('select public.super_delete_rsvp(%L, %L)->>$$result$$',
                       (select r->>'ticket_code' from t_no), lower((select r->>'ticket_code' from t_no)))) = 'ok',
                     'super admin deletes a registration after typing its code (case-insensitive)');
select pg_temp.check(not exists (select 1 from public.rsvps where email = 'no1@example.com'),
                     '... and the row is really gone');
select pg_temp.check(pg_temp.as_user(:'SUPER', $q$select public.super_delete_rsvp('MF-99999','MF-99999')->>'result'$q$) = 'not_found',
                     'deleting an unknown code -> not_found');
select pg_temp.check(pg_temp.as_user(:'ADMIN', 'select count(*)::text from public.rsvps') = 'ERR:42501'
                     and not has_table_privilege('authenticated', 'public.rsvps', 'delete'),
                     'logged-in users still cannot delete from the table directly');

-- ---------------------------------------------- constraints on new columns
select pg_temp.check((select count(*) = 0 from public.rsvps where checked_in_at is not null and not paid),
                     'no ticket is ever checked in without being paid');

rollback;

\echo 'ALL TICKET/ADMIN TESTS PASSED'
