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
-- Mimic Supabase default privileges, so the test proves the migration revokes them.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
SQL

$PSQL -X -q -d "$DB" -v ON_ERROR_STOP=1 -f supabase/migrations/20261117000000_create_rsvps.sql
$PSQL -X -q -d "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/rsvps_test.sql
