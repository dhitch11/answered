-- 20260814183102_accounts_missing_array_append_fix
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- ★ `m := m || 'greeting_name'` looks like appending a string to a text[]. It is not. Postgres
-- resolves the unknown-typed literal against `anyarray || anyarray` first and tries to parse
-- 'greeting_name' AS AN ARRAY, so every readiness check died with
-- `malformed array literal: "greeting_name"`. Every path that renders an account went through
-- here, so signup itself was broken. array_append is unambiguous; a bare `||` here is not.

create or replace function private.account_missing(p_account_id uuid)
returns text[]
language plpgsql stable security definer set search_path to 'public','private'
as $$
declare
  a public.accounts%rowtype;
  c public.account_config%rowtype;
  m text[] := '{}';
begin
  select * into a from public.accounts where id = p_account_id;
  if not found then return array['account']; end if;
  select * into c from public.account_config where account_id = p_account_id;
  if not found then return array['everything']; end if;

  if coalesce(trim(a.business_name),'') = ''      then m := array_append(m, 'business_name'); end if;
  if coalesce(trim(c.greeting_name),'')  = ''     then m := array_append(m, 'greeting_name'); end if;
  if coalesce(trim(c.business_says),'')  = ''     then m := array_append(m, 'business_says'); end if;
  if coalesce(array_length(c.services,1),0) = 0   then m := array_append(m, 'services'); end if;
  if c.hours = '{}'::jsonb                        then m := array_append(m, 'hours'); end if;
  if coalesce(trim(c.service_area),'')   = ''     then m := array_append(m, 'service_area'); end if;
  if c.booking_mode <> 'message_only'
     and coalesce(trim(c.booking_destination),'') = '' then m := array_append(m, 'booking_destination'); end if;
  if c.escalation_when <> 'never'
     and coalesce(trim(c.escalation_phone),'') = ''    then m := array_append(m, 'escalation_phone'); end if;
  if a.email_verified_at is null                  then m := array_append(m, 'email_verified'); end if;
  return m;
end $$;;
