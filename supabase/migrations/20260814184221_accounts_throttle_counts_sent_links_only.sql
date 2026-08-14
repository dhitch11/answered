-- 20260814184221_accounts_throttle_counts_sent_links_only
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- ★ The throttle counted TOKENS ISSUED, and a token row is written before the email is attempted.
-- So five failed sends filled the budget, and the sixth attempt took the throttled branch and
-- answered "check your email" without trying to send anything. A page that says check your email
-- while nothing was ever sent is the exact failure this endpoint was written to avoid, and the
-- rate limiter was the thing producing it.
--
-- Now only a link that actually left the building counts against the budget. A failed send costs
-- the person nothing and can never be mistaken for a delivered one.

alter table public.account_tokens add column if not exists sent_at timestamptz;
comment on column public.account_tokens.sent_at is
  'Set only after the mail provider accepted the message. Null means this link was minted and never sent, and it must not count against the rate limit.';

create or replace function public.sv_account_token_sent(p_secret text, p_token_hash text)
returns void
language plpgsql security definer set search_path to 'public','private'
as $$
begin
  perform private.require(p_secret);
  update public.account_tokens set sent_at = now() where token_hash = p_token_hash and sent_at is null;
end $$;

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

  -- Five links that ACTUALLY WENT OUT in fifteen minutes is a mailbox flooder, not a person who
  -- lost one. Links that failed to send do not count; see sent_at.
  select count(*) into v_recent from public.account_tokens
   where account_id = a.id and sent_at is not null and sent_at > now() - interval '15 minutes';
  if v_recent >= 5 then
    return jsonb_build_object('ok', false, 'throttled', true, 'created', v_new,
                              'account', private.account_json(a.id));
  end if;

  insert into public.account_tokens (account_id, purpose, token_hash, expires_at, issued_ip, issued_ua)
  values (a.id, 'login', p_token_hash,
          now() + make_interval(mins => greatest(5, least(coalesce(p_ttl_minutes,20), 120))),
          nullif(p_ip,''), left(coalesce(p_ua,''), 300));

  insert into public.account_events (account_id, kind, payload, actor)
    values (a.id, 'login_link_issued', jsonb_build_object('new_account', v_new), 'self');

  return jsonb_build_object('ok', true, 'throttled', false, 'created', v_new,
                            'account', private.account_json(a.id));
end $$;;
