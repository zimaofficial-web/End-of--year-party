-- Database security & validation tests for public.rsvps.
-- Run with:  bash scripts/test-db.sh
-- Every check raises an exception on failure, so psql (ON_ERROR_STOP) exits non-zero.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null
set client_min_messages = notice;

-- Helper: run a statement as a role and return the SQLSTATE (or 'ok').
create or replace function pg_temp.try_as(p_role text, p_sql text) returns text
language plpgsql as $$
begin
  execute format('set local role %I', p_role);
  execute p_sql;
  reset role;
  return 'ok';
exception when others then
  reset role;
  return sqlstate;
end $$;

-- Helper: call register_rsvp as anon with a given fake client IP.
create or replace function pg_temp.reg(p_ip text, p_name text, p_email text, p_phone text,
                                       p_att text, p_bring text, p_consent boolean, p_site text)
returns text language plpgsql as $$
declare r text;
begin
  perform set_config('request.headers', json_build_object('x-forwarded-for', p_ip)::text, true);
  set local role anon;
  r := public.register_rsvp(p_name, p_email, p_phone, p_att, p_bring, p_consent, p_site) ->> 'status';
  reset role;
  return r;
end $$;

create or replace function pg_temp.check(p_ok boolean, p_label text) returns void
language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'FAIL: %', p_label;
  end if;
  raise notice 'PASS: %', p_label;
end $$;

begin;

-- ---------------------------------------------------------------- structure
select pg_temp.check((select relrowsecurity and relforcerowsecurity from pg_class
                      where oid = 'public.rsvps'::regclass),
                     'RLS enabled AND forced on public.rsvps');

select pg_temp.check(not exists (select 1 from pg_policies where schemaname='public' and tablename='rsvps'
                                   and (roles && '{public,anon,authenticated}'::name[] or cmd = 'ALL')),
                     'no rsvps policy applies to public/anon/authenticated, and none is FOR ALL');
select pg_temp.check((select array_agg(cmd || ':' || array_to_string(roles, ',') order by cmd)
                        = '{DELETE:rsvp_admin_ops,INSERT:rsvp_writer,SELECT:rsvp_admin_ops,UPDATE:rsvp_admin_ops}'
                      from pg_policies where schemaname='public' and tablename='rsvps'),
                     'rsvps policies: INSERT for rsvp_writer only; SELECT/UPDATE/DELETE for rsvp_admin_ops only');

select pg_temp.check((select p.prosecdef and 'search_path=""' = any(p.proconfig)
                        and r.rolname = 'rsvp_writer' and not r.rolsuper and not r.rolbypassrls
                      from pg_proc p join pg_roles r on r.oid = p.proowner
                      where p.oid = 'public.register_rsvp(text,text,text,text,text,boolean,text)'::regprocedure),
                     'register_rsvp is SECURITY DEFINER, search_path pinned, owned by non-superuser rsvp_writer without BYPASSRLS');

select pg_temp.check(not has_function_privilege('public', 'public.register_rsvp(text,text,text,text,text,boolean,text)', 'execute')
                     and not has_function_privilege('authenticated', 'public.register_rsvp(text,text,text,text,text,boolean,text)', 'execute')
                     and has_function_privilege('anon', 'public.register_rsvp(text,text,text,text,text,boolean,text)', 'execute'),
                     'EXECUTE on register_rsvp: anon only (revoked from PUBLIC and authenticated)');

select pg_temp.check((select array_agg(column_name::text order by column_name::text) from information_schema.columns
                      where table_schema='public' and table_name='rsvps')
                     = '{attending,bringing,checked_in_at,checked_in_by,consent,consent_at,created_at,email,id,name,notified,paid,paid_at,paid_by,phone,policy_version,ticket_code,ticket_token}',
                     'rsvps has exactly the agreed columns: 11 form/consent + ticket, payment and check-in (data minimisation)');

select pg_temp.check((select bool_and(relrowsecurity and relforcerowsecurity) from pg_class
                      where oid in ('private.rsvp_attempts'::regclass, 'private.settings'::regclass)),
                     'RLS enabled AND forced on private.rsvp_attempts and private.settings');
select pg_temp.check(not exists (select 1 from pg_policies where schemaname = 'private'
                                   and (roles <> '{rsvp_writer}' or cmd = 'ALL')),
                     'private-table policies exist only for rsvp_writer, one per operation, none FOR ALL');

-- --------------------------------------------------- anon direct access denied
select pg_temp.check(pg_temp.try_as('anon', 'select * from public.rsvps') = '42501',
                     'anon SELECT on rsvps -> permission denied (42501)');
select pg_temp.check(pg_temp.try_as('anon', $q$insert into public.rsvps(name,email,phone,attending,consent,policy_version)
                                              values ('Direct','direct@x.com','08012345678','yes',true,'v1')$q$) = '42501',
                     'anon direct INSERT on rsvps -> permission denied (honeypot/rate limit cannot be bypassed)');
select pg_temp.check(pg_temp.try_as('anon', 'update public.rsvps set name = $$x$$') = '42501',
                     'anon UPDATE on rsvps -> permission denied');
select pg_temp.check(pg_temp.try_as('anon', 'delete from public.rsvps') = '42501',
                     'anon DELETE on rsvps -> permission denied');
select pg_temp.check(pg_temp.try_as('anon', 'select * from private.rsvp_attempts') = '42501',
                     'anon cannot read private.rsvp_attempts');
select pg_temp.check(pg_temp.try_as('anon', 'select * from private.settings') = '42501',
                     'anon cannot read private.settings (IP salt)');
select pg_temp.check(pg_temp.try_as('authenticated', 'select * from public.rsvps') = '42501',
                     'authenticated SELECT on rsvps -> permission denied');
select pg_temp.check(pg_temp.try_as('authenticated',
                       $q$select public.register_rsvp('A','a@b.co','08012345678','yes',null,true,'')$q$) = '42501',
                     'authenticated cannot call register_rsvp');
select pg_temp.check(pg_temp.try_as('rsvp_writer', 'select * from public.rsvps') = '42501',
                     'even rsvp_writer (function owner) cannot SELECT rsvps');

-- ------------------------------------------------------------- valid submit
select pg_temp.check(pg_temp.reg('10.0.0.1', '  Ada Obi  ', '  Ada.Obi@Example.COM ', '+234 808-063-3426',
                                 'yes', '  Zobo  ', true, '') = 'created',
                     'valid registration -> created');
select pg_temp.check((select name = 'Ada Obi' and email = 'ada.obi@example.com' and phone = '+2348080633426'
                        and attending = 'yes' and bringing = 'Zobo' and consent
                        and consent_at is not null and policy_version = 'v1-2026-11-17'
                        and notified = false and created_at is not null
                      from public.rsvps where email = 'ada.obi@example.com'),
                     'stored row is normalised; consent_at + policy_version set server-side; notified=false');
select pg_temp.check(pg_temp.reg('10.0.0.1', 'No Show', 'noshow@example.com', '08012345678',
                                 'no', '', true, '') = 'created',
                     'valid "no" registration with empty bringing -> created');
select pg_temp.check((select bringing is null from public.rsvps where email = 'noshow@example.com'),
                     'empty bringing stored as NULL');

-- ---------------------------------------------------------------- duplicates
select pg_temp.check(pg_temp.reg('10.0.0.2', 'Impostor', 'ADA.OBI@example.com', '09099999999',
                                 'no', 'nothing', true, '') = 'duplicate',
                     'same email, different case -> duplicate');
select pg_temp.check((select name = 'Ada Obi' and phone = '+2348080633426' and attending = 'yes'
                      from public.rsvps where email = 'ada.obi@example.com'),
                     'duplicate did NOT overwrite the original registration');
select pg_temp.check((select count(*) = 1 from public.rsvps where email = 'ada.obi@example.com'),
                     'still exactly one row for that email');

-- ----------------------------------------------------------------- honeypot
select pg_temp.check(pg_temp.reg('10.0.0.3', 'Bot', 'bot@example.com', '08012345678',
                                 'yes', '', true, 'http://spam.example') = 'rejected',
                     'honeypot filled -> rejected');
select pg_temp.check(not exists (select 1 from public.rsvps where email = 'bot@example.com'),
                     'honeypot submission was not stored');

-- ---------------------------------------------------- server-side validation
select pg_temp.check(pg_temp.reg('10.0.1.1', 'A', 'v1@example.com', '08012345678', 'yes', '', true, '') = 'invalid',
                     'name of 1 char -> invalid');
select pg_temp.check(pg_temp.reg('10.0.1.2', repeat('n', 81), 'v2@example.com', '08012345678', 'yes', '', true, '') = 'invalid',
                     'name of 81 chars -> invalid');
select pg_temp.check(pg_temp.reg('10.0.1.3', repeat('n', 80), 'v3@example.com', '08012345678', 'yes', '', true, '') = 'created',
                     'name of exactly 80 chars -> created (boundary)');
select pg_temp.check(pg_temp.reg('10.0.1.4', 'Valid Name', 'not-an-email', '08012345678', 'yes', '', true, '') = 'invalid',
                     'bad email format -> invalid');
select pg_temp.check(pg_temp.reg('10.0.1.5', 'Valid Name', repeat('e', 110) || '@example.com', '08012345678', 'yes', '', true, '') = 'invalid',
                     'email over 120 chars -> invalid');
select pg_temp.check(pg_temp.reg('10.0.2.1', 'Valid Name', 'v6@example.com', '12345', 'yes', '', true, '') = 'invalid',
                     'phone too short -> invalid');
select pg_temp.check(pg_temp.reg('10.0.2.2', 'Valid Name', 'v7@example.com', '0801234567a', 'yes', '', true, '') = 'invalid',
                     'phone with letters -> invalid');
select pg_temp.check(pg_temp.reg('10.0.2.3', 'Valid Name', 'v8@example.com', '08012345678', 'maybe', '', true, '') = 'invalid',
                     'attending not yes/no -> invalid');
select pg_temp.check(pg_temp.reg('10.0.2.4', 'Valid Name', 'v9@example.com', '08012345678', 'yes', '', false, '') = 'invalid',
                     'consent = false -> invalid');
select pg_temp.check(pg_temp.reg('10.0.2.5', 'Valid Name', 'v10@example.com', '08012345678', 'yes', '', null, '') = 'invalid',
                     'consent = null -> invalid');
select pg_temp.check(pg_temp.reg('10.0.3.1', 'Valid Name', 'v11@example.com', '08012345678', 'yes', repeat('b', 301), true, '') = 'invalid',
                     'bringing over 300 chars -> invalid');
select pg_temp.check(pg_temp.reg('10.0.3.2', null, 'v12@example.com', '08012345678', 'yes', '', true, '') = 'invalid',
                     'null name -> invalid');
select pg_temp.check(pg_temp.reg('10.0.3.3', 'Valid Name', null, '08012345678', 'yes', '', true, '') = 'invalid',
                     'null email -> invalid');
select pg_temp.check(pg_temp.reg('10.0.3.4', 'Bad' || chr(7) || 'Name', 'v13@example.com', '08012345678', 'yes', '', true, '') = 'invalid',
                     'control character in name -> invalid');
select pg_temp.check(not exists (select 1 from public.rsvps where email like 'v%@example.com' and email <> 'v3@example.com'),
                     'no invalid submission was stored');

-- --------------------------------------------------------------- rate limit
select pg_temp.check(pg_temp.reg('203.0.113.9', 'Rate ' || g, 'rate' || g || '@example.com', '08012345678', 'yes', '', true, '') = 'created',
                     'rate-limit attempt ' || g || ' of 5 from one IP -> created')
  from generate_series(1, 5) g;
select pg_temp.check(pg_temp.reg('203.0.113.9', 'Rate Six', 'rate6@example.com', '08012345678', 'yes', '', true, '') = 'rate_limited',
                     '6th attempt from same IP within 10 min -> rate_limited');
select pg_temp.check(not exists (select 1 from public.rsvps where email = 'rate6@example.com'),
                     'rate-limited submission was not stored');
select pg_temp.check(pg_temp.reg('203.0.113.10', 'Other IP', 'other@example.com', '08012345678', 'yes', '', true, '') = 'created',
                     'a different IP is not affected');
select pg_temp.check(not exists (select 1 from private.rsvp_attempts where ip_hash like '%203.0.113%')
                     and (select bool_and(ip_hash ~ '^[0-9a-f]{64}$') from private.rsvp_attempts),
                     'raw IPs are never stored, only 64-char salted hashes');
-- Old attempts are purged and stop counting.
update private.rsvp_attempts set created_at = now() - interval '25 hours' where true;
select pg_temp.check(pg_temp.reg('203.0.113.9', 'Rate Later', 'ratelater@example.com', '08012345678', 'yes', '', true, '') = 'created',
                     'after the window, the same IP may register again');
select pg_temp.check((select count(*) = 1 from private.rsvp_attempts),
                     'attempts older than 24 hours are deleted automatically');

-- ------------------------------------------------- owner / service_role read
select pg_temp.check(pg_temp.try_as('service_role', 'select count(*) from public.rsvps') = 'ok',
                     'service_role (server-side only) can read rsvps');

-- ------------------------------------------------- privacy runbook queries
-- Deletion on request (docs/PRIVACY-RUNBOOK.md) works and removes the row.
delete from public.rsvps where email = lower(btrim(' Ada.Obi@Example.com '));
select pg_temp.check(not exists (select 1 from public.rsvps where email = 'ada.obi@example.com'),
                     'privacy runbook delete-by-email removes the person''s row');

rollback;

\echo 'ALL DATABASE TESTS PASSED'
