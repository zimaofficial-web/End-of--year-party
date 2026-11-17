#!/usr/bin/env bash
# Runs the migration against a throwaway local PostgreSQL database that mimics
# Supabase's roles (anon, authenticated, service_role), then runs the tests.
#
# Needs a local PostgreSQL 15+ server and psql. Usage:
#   bash scripts/test-db.sh            # uses PSQL="psql" and connects as postgres
#   PSQL="sudo -u postgres psql" bash scripts/test-db.sh
set -euo pipefail

cd "$(dirname "$0")/.."
PSQL=${PSQL:-psql}
DB=miva_rsvp_test_$$

$PSQL -X -q -d postgres -c "create database $DB" >/dev/null
trap '$PSQL -X -q -d postgres -c "drop database if exists $DB" >/dev/null' EXIT

# Minimal Supabase role setup (roles are cluster-wide, so create only if missing).
$PSQL -X -q -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
-- Start like a fresh Supabase project: no leftover rsvp_writer from earlier runs.
-- (Each run uses its own database, which is dropped afterwards.)
drop role if exists rsvp_writer;
drop role if exists rsvp_admin_ops;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
SQL

# Run the migration the way Supabase does: as a NON-superuser admin role
# (Supabase's "postgres" is not a superuser), so permission problems show up here.
$PSQL -X -q -d "$DB" -v ON_ERROR_STOP=1 <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'supa_admin') then
    create role supa_admin nologin createrole bypassrls;
  end if;
end \$\$;
-- As on Supabase: the admin role owns the database, and schema public is
-- owned by pg_database_owner (the PostgreSQL 15+ default), i.e. by the admin.
alter database $DB owner to supa_admin;
alter schema public owner to pg_database_owner;
-- Supabase default privileges for objects the admin creates, so the tests
-- prove the migration revokes them from anon/authenticated.
alter default privileges for role supa_admin in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role supa_admin in schema public grant all on functions to anon, authenticated, service_role;
grant anon, authenticated, service_role to supa_admin with admin option;
SQL
for m in supabase/migrations/*.sql; do
  ( echo "set role supa_admin;"; cat "$m" ) | $PSQL -X -q -d "$DB" -v ON_ERROR_STOP=1
done
$PSQL -X -q -d "$DB" -v ON_ERROR_STOP=1 -c "select 'migration owner check', rolsuper from pg_roles r join pg_proc p on p.proowner=r.oid where p.proname='register_rsvp'" >/dev/null
for t in supabase/tests/*.sql; do
  $PSQL -X -q -d "$DB" -v ON_ERROR_STOP=1 -f "$t"
done
