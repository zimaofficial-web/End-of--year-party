-- Privacy note v2: a copy of each registration is emailed to the organisers
-- through FormSubmit. The policy version is now read from private.settings,
-- so the next wording change is a single UPDATE.
--
--   v1-2026-11-17  original note
--   v2-2026-11-18  adds "a copy is emailed to the organisers through FormSubmit"

begin;

insert into private.settings (key, value) values ('policy_version', 'v2-2026-11-18')
on conflict (key) do update set value = excluded.value;

drop policy if exists settings_select_writer on private.settings;
create policy settings_select_writer on private.settings
  for select to rsvp_writer using (key in ('ip_salt', 'policy_version'));

create or replace function public.register_rsvp(
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
  v_policy_version text;
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

  -- Which privacy text the person agreed to (kept in private.settings so a
  -- wording change only needs one UPDATE, not a new function).
  select value into v_policy_version from private.settings where key = 'policy_version';
  v_policy_version := coalesce(v_policy_version, 'v1-2026-11-17');

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
       v_policy_version,
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

commit;
