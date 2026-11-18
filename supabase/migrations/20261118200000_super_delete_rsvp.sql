-- Super admin can delete a registration (test entries, privacy requests).
-- The caller must repeat the ticket code as confirmation.
-- Regular admins, logged-in strangers and anon cannot delete anything.

begin;

grant delete on table public.rsvps to rsvp_admin_ops;

drop policy if exists rsvps_delete_for_admin_functions on public.rsvps;
create policy rsvps_delete_for_admin_functions on public.rsvps
  for delete to rsvp_admin_ops using (true);

create or replace function public.super_delete_rsvp(p_ticket_code text, p_confirm text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text := upper(btrim(coalesce(p_ticket_code, '')));
begin
  if public.current_admin_role() is distinct from 'super_admin' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_code = '' or upper(btrim(coalesce(p_confirm, ''))) <> v_code then
    return jsonb_build_object('result', 'confirm_mismatch');
  end if;
  delete from public.rsvps where ticket_code = v_code;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  return jsonb_build_object('result', 'ok', 'ticket_code', v_code);
end;
$$;

grant create on schema public to rsvp_admin_ops;
alter function public.super_delete_rsvp(text, text) owner to rsvp_admin_ops;
revoke create on schema public from rsvp_admin_ops;
revoke all on function public.super_delete_rsvp(text, text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.super_delete_rsvp(text, text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.super_delete_rsvp(text, text) to authenticated';
  end if;
end $$;

commit;
