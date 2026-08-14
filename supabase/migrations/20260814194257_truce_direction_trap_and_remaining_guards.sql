-- 20260814194257_truce_direction_trap_and_remaining_guards
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- ★ @LANE-PARLEY MEASURED A TRAP THAT DESTROYS A REAL NEGOTIATION AND BLAMES THE MONEY.
--
-- If both parties pick the same direction (two 'min', two sellers), the engine treated one of them
-- as a buyer, compared 900 < 1000, and returned status `no_overlap` with the one-line thread "No
-- overlap. Truce stopped, because that is where you each told it to stop."
--
-- That sentence is FALSE in this case and the failure is unrecoverable: the deal reads as a
-- disagreement about money when it was a mis-tapped radio button, and both people are told the deal
-- died. TWO SELLERS IS NOT A NO-OVERLAP, IT IS A MALFORMED DEAL, and the two must not share a status.
--
-- Also adding `them.direction` to tr_view, which they asked for and which leaks nothing: it is
-- structural rather than sealed, it is already implied by the role text both parties can read, and
-- no arithmetic on it plus the public openings recovers a limit. It lets the page lock the second
-- mover to the opposite direction so the trap cannot be sprung at all.

alter table public.truce_deals drop constraint if exists truce_deals_status_check;
alter table public.truce_deals add constraint truce_deals_status_check
  check (status in ('open','negotiating','settled','no_overlap','malformed','withdrawn','expired'));

create or replace function public.tr_set_limit(
  p_secret text, p_token text, p_direction text, p_amount numeric,
  p_must_haves text[] default '{}', p_opening numeric default null)
returns jsonb language plpgsql security definer set search_path = public, private, sealed as $$
declare me public.truce_parties; d public.truce_deals; other_dir text;
begin
  perform private.require(p_secret);
  select * into me from public.truce_parties where token = p_token;
  if not found then return jsonb_build_object('error','unknown link'); end if;
  select * into d from public.truce_deals where id = me.deal_id;
  if d.expires_at < now() then return jsonb_build_object('error','this link has expired'); end if;
  if p_direction not in ('max','min') then return jsonb_build_object('error','direction must be max or min'); end if;
  if p_amount is null or p_amount < 0 then return jsonb_build_object('error','a limit needs a number'); end if;
  if p_opening is not null then
    if p_direction = 'min' and p_opening < p_amount then
      return jsonb_build_object('error','your asking price is below the least you said you would take');
    end if;
    if p_direction = 'max' and p_opening > p_amount then
      return jsonb_build_object('error','your offer is above the most you said you would pay');
    end if;
  end if;

  -- ★ REFUSE THE MALFORMED PAIR AT THE DOOR, rather than letting it become a fake no_overlap.
  -- Nothing is written, so the party can simply pick again and the deal survives.
  select l.direction into other_dir
    from sealed.limits l
    join public.truce_parties p on p.id = l.party_id
   where p.deal_id = me.deal_id and p.side <> me.side;
  if other_dir is not null and other_dir = p_direction then
    return jsonb_build_object('error',
      case when p_direction = 'min'
        then 'You have both said this is the least you will TAKE. One of you is paying and one is being paid, so one side needs the most they will PAY.'
        else 'You have both said this is the most you will PAY. One of you is paying and one is being paid, so one side needs the least they will TAKE.' end,
      'code','same_direction');
  end if;

  insert into sealed.limits (party_id, deal_id, direction, amount, must_haves, opening)
  values (me.id, me.deal_id, p_direction, p_amount, coalesce(p_must_haves,'{}'), p_opening)
  on conflict (party_id) do update set direction = excluded.direction, amount = excluded.amount,
                                       must_haves = excluded.must_haves, opening = excluded.opening,
                                       set_at = now();

  update public.truce_parties set limit_set_at = now(), joined_at = coalesce(joined_at, now()) where id = me.id;
  -- a deal that previously died can come back when a number changes; only a settled one is final
  update public.truce_deals set status = 'negotiating'
   where id = me.deal_id and status in ('open','no_overlap','malformed');
  if (select count(*) from sealed.limits where deal_id = me.deal_id) = 2 then
    perform sealed.negotiate(me.deal_id);
  end if;
  return public.tr_view(p_secret, p_token);
end $$;

create or replace function public.tr_sign(p_secret text, p_token text, p_name text,
  p_ip inet default null, p_ua text default null)
returns jsonb language plpgsql security definer set search_path = public, private as $$
declare me public.truce_parties; d public.truce_deals;
begin
  perform private.require(p_secret);
  select * into me from public.truce_parties where token = p_token;
  if not found then return jsonb_build_object('error','unknown link'); end if;
  select * into d from public.truce_deals where id = me.deal_id;
  if d.status <> 'settled' then return jsonb_build_object('error','there is nothing to sign yet'); end if;
  if coalesce(trim(p_name),'') = '' then return jsonb_build_object('error','type your name to sign'); end if;
  insert into public.truce_signatures (deal_id, party_id, name_typed, ip, user_agent)
  values (d.id, me.id, trim(p_name), p_ip, p_ua)
  on conflict (deal_id, party_id) do nothing;
  update public.truce_parties set signed_at = coalesce(signed_at, now()) where id = me.id;
  return public.tr_view(p_secret, p_token);
end $$;

-- the counterparty's DIRECTION is public; their AMOUNT still never enters the caller's scope
create or replace function sealed.their_public(p_party uuid)
returns jsonb language sql stable security definer set search_path = sealed, public as $$
  select jsonb_build_object(
           'has_set_limit', exists (select 1 from sealed.limits l where l.party_id = p_party),
           'opening',   (select l.opening   from sealed.limits l where l.party_id = p_party),
           'direction', (select l.direction from sealed.limits l where l.party_id = p_party));
$$;

-- a same-direction pair that somehow reaches the engine is MALFORMED, never a no_overlap
create or replace function sealed.negotiate(p_deal uuid)
returns jsonb language plpgsql security definer set search_path = sealed, public as $$
declare la sealed.limits; lb sealed.limits; a public.truce_parties; b public.truce_parties;
begin
  select * into a from public.truce_parties where deal_id = p_deal and side = 'a';
  select * into b from public.truce_parties where deal_id = p_deal and side = 'b';
  select * into la from sealed.limits where party_id = a.id;
  select * into lb from sealed.limits where party_id = b.id;
  if la is null or lb is null then return jsonb_build_object('status','waiting'); end if;

  if la.direction = lb.direction then
    delete from public.truce_messages where deal_id = p_deal;
    insert into public.truce_messages (deal_id, seq, speaker, body, move)
    values (p_deal, 1, 'system',
      'Both sides described the same side of the deal, so there is nothing to negotiate between. One of you is paying and one is being paid. Nobody has lost anything: pick again and it runs.',
      'stop');
    update public.truce_deals set status = 'malformed' where id = p_deal;
    return jsonb_build_object('status','malformed');
  end if;
  return sealed.negotiate_ok(p_deal);
end $$;

drop function if exists public.tr_set_limit(text, text, numeric, text[], numeric);
drop function if exists public.tr_sign(text, text, inet, text);

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public' and p.proname like 'tr\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to anon', f.sig);
  end loop;
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='sealed'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;;
