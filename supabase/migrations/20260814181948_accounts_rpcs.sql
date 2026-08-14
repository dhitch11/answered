-- 20260814181948_accounts_rpcs
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- Public RPCs. Every one takes the shared secret; nothing else can reach a row.

-- Sign up, or ask for another link. Deliberately idempotent on the email so a
-- second attempt is a second link, never a second business. The caller gets the
-- same answer either way, so this endpoint cannot be used to ask whether an
-- address is already a customer.
create or replace function public.sv_account_start(
  p_secret text, p_email text, p_business_name text, p_owner_name text,
  p_phone text, p_trade text, p_token_hash text, p_ttl_minutes integer,
  p_ip text, p_ua text)
returns jsonb
language plpgsql security definer set search_path to 'public','private'
as $$
declare a public.accounts%rowtype; v_recent int; v_new boolean := false;
begin
  perform private.require(p_secret);
  if coalesce(trim(p_email),'') = '' or position('@' in p_email) < 2 then
    raise exception 'email required' using errcode = '22023';
  end if;

  select * into a from public.accounts where lower(owner_email) = lower(trim(p_email));
  if not found then
    if coalesce(trim(p_business_name),'') = '' then
      raise exception 'business name required' using errcode = '22023';
    end if;
    insert into public.accounts (business_name, owner_email, owner_name, owner_phone, trade)
    values (trim(p_business_name), lower(trim(p_email)), nullif(trim(coalesce(p_owner_name,'')),''),
            nullif(trim(coalesce(p_phone,'')),''), nullif(trim(coalesce(p_trade,'')),''))
    returning * into a;
    insert into public.account_config (account_id) values (a.id);
    insert into public.account_events (account_id, kind, payload, actor)
      values (a.id, 'account_created', jsonb_build_object('trade', p_trade), 'self');
    v_new := true;
  end if;

  -- Five links in fifteen minutes is a mailbox flooder, not a person who lost one.
  select count(*) into v_recent from public.account_tokens
   where account_id = a.id and at > now() - interval '15 minutes';
  if v_recent >= 5 then
    return jsonb_build_object('ok', false, 'throttled', true, 'created', v_new);
  end if;

  insert into public.account_tokens (account_id, purpose, token_hash, expires_at, issued_ip, issued_ua)
  values (a.id, 'login', p_token_hash,
          now() + make_interval(mins => greatest(5, least(coalesce(p_ttl_minutes,20), 120))),
          nullif(p_ip,''), left(coalesce(p_ua,''), 300));

  insert into public.account_events (account_id, kind, payload, actor)
    values (a.id, 'login_link_issued', jsonb_build_object('new_account', v_new), 'self');

  return jsonb_build_object('ok', true, 'throttled', false, 'created', v_new,
                            'account', private.account_json(a.id));
end $$;

-- Consume a link. Single use, enforced by the UPDATE ... WHERE consumed_at IS
-- NULL, so two clicks on the same link is one session, not two.
create or replace function public.sv_account_consume_token(p_secret text, p_token_hash text, p_ip text)
returns jsonb
language plpgsql security definer set search_path to 'public','private'
as $$
declare t public.account_tokens%rowtype;
begin
  perform private.require(p_secret);
  update public.account_tokens
     set consumed_at = now(), consumed_ip = nullif(p_ip,'')
   where token_hash = p_token_hash and consumed_at is null and expires_at > now()
  returning * into t;
  if not found then return jsonb_build_object('ok', false); end if;

  update public.accounts
     set email_verified_at = coalesce(email_verified_at, now()), updated_at = now()
   where id = t.account_id;
  insert into public.account_events (account_id, kind, actor) values (t.account_id, 'signed_in', 'self');
  perform private.account_resettle(t.account_id);
  return jsonb_build_object('ok', true, 'account', private.account_json(t.account_id));
end $$;

create or replace function public.sv_account(p_secret text, p_account_id uuid)
returns jsonb
language plpgsql stable security definer set search_path to 'public','private'
as $$
begin
  perform private.require(p_secret);
  return private.account_json(p_account_id);
end $$;

-- Save rules. Only the keys named here can move; anything else in the patch is
-- ignored rather than trusted. Every save writes an immutable version row.
create or replace function public.sv_account_save_config(
  p_secret text, p_account_id uuid, p_patch jsonb, p_author text)
returns jsonb
language plpgsql security definer set search_path to 'public','private'
as $$
declare c public.account_config%rowtype; v_next int;
begin
  perform private.require(p_secret);
  select * into c from public.account_config where account_id = p_account_id;
  if not found then raise exception 'no such account' using errcode = '22023'; end if;
  v_next := c.version + 1;

  update public.account_config set
    greeting_name       = coalesce(nullif(trim(p_patch->>'greeting_name'),''),        greeting_name),
    business_says       = coalesce(nullif(trim(p_patch->>'business_says'),''),        business_says),
    service_area        = coalesce(nullif(trim(p_patch->>'service_area'),''),         service_area),
    price_notes         = coalesce(nullif(trim(p_patch->>'price_notes'),''),          price_notes),
    booking_destination = coalesce(nullif(trim(p_patch->>'booking_destination'),''),  booking_destination),
    escalation_phone    = coalesce(nullif(trim(p_patch->>'escalation_phone'),''),     escalation_phone),
    hours               = coalesce(p_patch->'hours',                                  hours),
    services            = coalesce((select array_agg(trim(x)) from jsonb_array_elements_text(p_patch->'services') x
                                     where trim(x) <> ''),                            services),
    never_say           = coalesce((select array_agg(trim(x)) from jsonb_array_elements_text(p_patch->'never_say') x
                                     where trim(x) <> ''),                            never_say),
    always_ask          = coalesce((select array_agg(trim(x)) from jsonb_array_elements_text(p_patch->'always_ask') x
                                     where trim(x) <> ''),                            always_ask),
    after_hours         = coalesce(nullif(p_patch->>'after_hours',''),                after_hours),
    quote_policy        = coalesce(nullif(p_patch->>'quote_policy',''),               quote_policy),
    booking_mode        = coalesce(nullif(p_patch->>'booking_mode',''),               booking_mode),
    escalation_when     = coalesce(nullif(p_patch->>'escalation_when',''),            escalation_when),
    monthly_cap_cents   = coalesce((p_patch->>'monthly_cap_cents')::int,              monthly_cap_cents),
    version             = v_next,
    updated_at          = now(),
    updated_by          = p_author
  where account_id = p_account_id;

  update public.accounts set
    business_name = coalesce(nullif(trim(p_patch->>'business_name'),''), business_name),
    owner_name    = coalesce(nullif(trim(p_patch->>'owner_name'),''),    owner_name),
    owner_phone   = coalesce(nullif(trim(p_patch->>'owner_phone'),''),   owner_phone),
    trade         = coalesce(nullif(trim(p_patch->>'trade'),''),         trade),
    timezone      = coalesce(nullif(trim(p_patch->>'timezone'),''),      timezone),
    updated_at    = now()
  where id = p_account_id;

  insert into public.account_config_versions (account_id, version, config, author)
  select p_account_id, v_next, private.account_json(p_account_id)->'config', p_author;

  insert into public.account_events (account_id, kind, payload, actor)
    values (p_account_id, 'rules_saved',
            jsonb_build_object('version', v_next, 'fields', (select jsonb_agg(k) from jsonb_object_keys(p_patch) k)),
            p_author);

  perform private.account_resettle(p_account_id);
  return private.account_json(p_account_id);
end $$;

-- Ask for a line. Refuses while anything is missing, and says exactly what.
-- It does NOT create a phone row: no number exists yet, and a row that looks
-- like one would be the lie.
create or replace function public.sv_account_request_line(
  p_secret text, p_account_id uuid, p_area_code text, p_note text)
returns jsonb
language plpgsql security definer set search_path to 'public','private'
as $$
declare m text[]; a public.accounts%rowtype;
begin
  perform private.require(p_secret);
  select * into a from public.accounts where id = p_account_id;
  if not found then raise exception 'no such account' using errcode = '22023'; end if;
  m := private.account_missing(p_account_id);
  if array_length(m,1) is not null then
    return jsonb_build_object('ok', false, 'missing', to_jsonb(m), 'account', private.account_json(p_account_id));
  end if;
  if a.status = 'live' then
    return jsonb_build_object('ok', false, 'already_live', true, 'account', private.account_json(p_account_id));
  end if;
  update public.accounts
     set status = 'awaiting_line',
         requested_line_at = coalesce(requested_line_at, now()),
         wanted_area_code = coalesce(nullif(regexp_replace(coalesce(p_area_code,''), '\D', '', 'g'),''), wanted_area_code),
         updated_at = now()
   where id = p_account_id;
  insert into public.account_events (account_id, kind, payload, actor)
    values (p_account_id, 'line_requested',
            jsonb_build_object('area_code', p_area_code, 'note', left(coalesce(p_note,''), 500)), 'self');
  return jsonb_build_object('ok', true, 'account', private.account_json(p_account_id));
end $$;

-- The only path to 'live', and it needs a real E.164 number an operator typed.
create or replace function public.sv_account_assign_number(
  p_secret text, p_account_id uuid, p_phone text, p_twilio_sid text, p_actor text)
returns jsonb
language plpgsql security definer set search_path to 'public','private'
as $$
declare m text[];
begin
  perform private.require(p_secret);
  if p_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'phone must be E.164' using errcode = '22023';
  end if;
  m := private.account_missing(p_account_id);
  if array_length(m,1) is not null then
    return jsonb_build_object('ok', false, 'missing', to_jsonb(m));
  end if;
  insert into public.account_numbers (account_id, phone, twilio_sid, assigned_by)
  values (p_account_id, p_phone, nullif(p_twilio_sid,''), p_actor)
  on conflict (phone) do update
    set account_id = excluded.account_id, status = 'provisioned',
        released_at = null, twilio_sid = coalesce(excluded.twilio_sid, public.account_numbers.twilio_sid),
        assigned_by = excluded.assigned_by;
  update public.accounts
     set status = 'live', live_at = coalesce(live_at, now()), updated_at = now()
   where id = p_account_id;
  insert into public.account_events (account_id, kind, payload, actor)
    values (p_account_id, 'number_assigned', jsonb_build_object('phone', p_phone), p_actor);
  return jsonb_build_object('ok', true, 'account', private.account_json(p_account_id));
end $$;

-- The voice resolver. A dialled number in, that business's rules out, or null.
-- Null is the honest answer and callers must handle it; there is no default
-- business to fall back to.
create or replace function public.sv_account_for_number(p_secret text, p_phone text)
returns jsonb
language plpgsql stable security definer set search_path to 'public','private'
as $$
declare v_id uuid;
begin
  perform private.require(p_secret);
  select n.account_id into v_id
    from public.account_numbers n
    join public.accounts a on a.id = n.account_id
   where n.phone = p_phone and n.status = 'provisioned' and a.status = 'live'
   limit 1;
  if v_id is null then return null; end if;
  return private.account_json(v_id);
end $$;

create or replace function public.sv_accounts(p_secret text, p_status text, p_limit integer)
returns jsonb
language plpgsql stable security definer set search_path to 'public','private'
as $$
begin
  perform private.require(p_secret);
  return coalesce((
    select jsonb_agg(private.account_json(a.id) order by a.updated_at desc)
    from (select id, updated_at from public.accounts
           where p_status is null or status = p_status
           order by updated_at desc limit greatest(1, least(coalesce(p_limit,100), 500))) a), '[]'::jsonb);
end $$;;
