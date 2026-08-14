-- 20260814181900_accounts_readiness_and_shape
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- What "ready" means, computed once, in the database, so the console, the
-- provisioning gate and the operator list can never disagree about whether a
-- business is ready to have a phone number pointed at it.
--
-- Every item here is something the agent cannot answer a stranger's call
-- without. A missing escalation number is not a cosmetic gap: it is the
-- difference between a burst pipe reaching a human and reaching a voicemail.

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

  if coalesce(trim(a.business_name),'') = ''      then m := m || 'business_name'; end if;
  if coalesce(trim(c.greeting_name),'')  = ''     then m := m || 'greeting_name'; end if;
  if coalesce(trim(c.business_says),'')  = ''     then m := m || 'business_says'; end if;
  if coalesce(array_length(c.services,1),0) = 0   then m := m || 'services'; end if;
  if c.hours = '{}'::jsonb                        then m := m || 'hours'; end if;
  if coalesce(trim(c.service_area),'')   = ''     then m := m || 'service_area'; end if;
  if c.booking_mode <> 'message_only'
     and coalesce(trim(c.booking_destination),'') = '' then m := m || 'booking_destination'; end if;
  if c.escalation_when <> 'never'
     and coalesce(trim(c.escalation_phone),'') = ''    then m := m || 'escalation_phone'; end if;
  if a.email_verified_at is null                  then m := m || 'email_verified'; end if;
  return m;
end $$;

-- One shape for an account, everywhere. The console, the operator list and the
-- voice resolver all read this, so a field can never mean one thing on a page
-- and another on a phone call.
create or replace function private.account_json(p_account_id uuid)
returns jsonb
language sql stable security definer set search_path to 'public','private'
as $$
  select jsonb_build_object(
    'id', a.id,
    'business_name', a.business_name,
    'owner_email', a.owner_email,
    'owner_name', a.owner_name,
    'owner_phone', a.owner_phone,
    'trade', a.trade,
    'timezone', a.timezone,
    'status', a.status,
    'email_verified_at', a.email_verified_at,
    'ready_at', a.ready_at,
    'requested_line_at', a.requested_line_at,
    'live_at', a.live_at,
    'wanted_area_code', a.wanted_area_code,
    'created_at', a.created_at,
    'updated_at', a.updated_at,
    'missing', to_jsonb(private.account_missing(a.id)),
    'config', case when c.account_id is null then null else jsonb_build_object(
      'version', c.version,
      'greeting_name', c.greeting_name,
      'business_says', c.business_says,
      'hours', c.hours,
      'after_hours', c.after_hours,
      'service_area', c.service_area,
      'services', to_jsonb(c.services),
      'never_say', to_jsonb(c.never_say),
      'always_ask', to_jsonb(c.always_ask),
      'quote_policy', c.quote_policy,
      'price_notes', c.price_notes,
      'booking_mode', c.booking_mode,
      'booking_destination', c.booking_destination,
      'escalation_phone', c.escalation_phone,
      'escalation_when', c.escalation_when,
      'monthly_cap_cents', c.monthly_cap_cents,
      'updated_at', c.updated_at
    ) end,
    'numbers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'phone', n.phone, 'kind', n.kind, 'status', n.status,
        'provisioned_at', n.provisioned_at, 'released_at', n.released_at)
        order by n.provisioned_at desc)
      from public.account_numbers n where n.account_id = a.id), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(x order by x->>'at' desc) from (
        select jsonb_build_object('kind', e.kind, 'payload', e.payload, 'actor', e.actor, 'at', e.at) as x
        from public.account_events e where e.account_id = a.id order by e.at desc limit 25) s), '[]'::jsonb)
  )
  from public.accounts a
  left join public.account_config c on c.account_id = a.id
  where a.id = p_account_id;
$$;

-- Status is derived, never asserted by a caller. Nothing here can set 'live':
-- only an operator assigning a real number does that, in its own RPC.
create or replace function private.account_resettle(p_account_id uuid)
returns void
language plpgsql security definer set search_path to 'public','private'
as $$
declare m text[]; a public.accounts%rowtype;
begin
  select * into a from public.accounts where id = p_account_id;
  if not found then return; end if;
  if a.status in ('live','paused','closed') then return; end if;
  m := private.account_missing(p_account_id);
  if array_length(m,1) is null then
    if a.status = 'awaiting_line' then
      update public.accounts set updated_at = now() where id = p_account_id;
    else
      update public.accounts
         set status = 'ready', ready_at = coalesce(ready_at, now()), updated_at = now()
       where id = p_account_id;
    end if;
  else
    update public.accounts
       set status = case when a.email_verified_at is null then 'draft' else 'configuring' end,
           ready_at = null, updated_at = now()
     where id = p_account_id;
  end if;
end $$;;
