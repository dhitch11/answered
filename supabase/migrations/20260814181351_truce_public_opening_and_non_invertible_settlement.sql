-- 20260814181351_truce_public_opening_and_non_invertible_settlement
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- ★★★ TWO DEFECTS THE LIVE RUN EXPOSED. THE SECOND IS IN THE SPECIFIED ALGORITHM, NOT THE CODE.
--
-- (1) THE THREAD COLLAPSED. With Dana's floor at $1,400 and Ryan's ceiling at $1,700, both
--     self-anchored openings landed past the midpoint, got clamped to it, and the "negotiation"
--     was three messages with no movement at all. The back and forth IS the product; a wide
--     overlap produced a thread with nothing in it.
--
-- (2) SETTLING ON THE EXACT MIDPOINT LEAKS BOTH LIMITS, and no wording fixes it.
--     If settled = (mine + theirs) / 2, then theirs = 2 x settled - mine.
--     Every party can compute the other's sealed number exactly, with arithmetic a ten year old
--     can do, from a figure we print on the signed page. /truce Section 3 says the limit "is not
--     in a message, not in the summary, not on the signed page" — all true, and all irrelevant,
--     because it is DERIVABLE from the page. This is a property of "settle at the midpoint of the
--     overlap", which is what the spec asks for. It is not an implementation slip.
--
-- THE FIX FOR BOTH IS THE SAME MISSING CONCEPT: a side has TWO numbers, not one.
--   OPENING  public. What you are asking or offering. Shown to the other side. Leaks nothing.
--   LIMIT    sealed. What you will not cross. Never shown, never derivable.
-- This is also what the hero narrative already assumes — Dana "at $2,050" and Ryan "at $1,875"
-- settling at $1,925 are OPENINGS; as limits they do not overlap and the honest answer would be
-- "no deal". The page was right and the single slider was the ambiguity.
--
-- Settlement is now the midpoint plus a bounded, per-deal, seeded offset inside the overlap, so
-- 2 x settled - mine yields a RANGE rather than their number. The seed is stored, so the result
-- stays reproducible and auditable.

alter table sealed.limits add column if not exists opening numeric;
alter table public.truce_deals add column if not exists seed double precision;

create or replace function sealed.negotiate(p_deal uuid)
returns jsonb language plpgsql security definer set search_path = sealed, public as $$
declare
  a public.truce_parties; b public.truce_parties;
  la sealed.limits; lb sealed.limits;
  buyer_max numeric; seller_min numeric; buyer_open numeric; seller_open numeric;
  mid numeric; half numeric; jitter numeric; target numeric; incr numeric;
  buyer public.truce_parties; seller public.truce_parties;
  seq int := 0; i int; bid numeric; ask numeric; rounds int := 4; f numeric;
  s double precision;
begin
  select * into a from public.truce_parties where deal_id = p_deal and side = 'a';
  select * into b from public.truce_parties where deal_id = p_deal and side = 'b';
  select * into la from sealed.limits where party_id = a.id;
  select * into lb from sealed.limits where party_id = b.id;
  if la is null or lb is null then return jsonb_build_object('status','waiting'); end if;

  if la.direction = 'max' then
    buyer := a; seller := b; buyer_max := la.amount; seller_min := lb.amount;
    buyer_open := coalesce(la.opening, la.amount * 0.90); seller_open := coalesce(lb.opening, lb.amount * 1.10);
  else
    buyer := b; seller := a; buyer_max := lb.amount; seller_min := la.amount;
    buyer_open := coalesce(lb.opening, lb.amount * 0.90); seller_open := coalesce(la.opening, la.amount * 1.10);
  end if;

  delete from public.truce_messages where deal_id = p_deal;

  if buyer_max < seller_min then
    seq := seq + 1;
    insert into public.truce_messages (deal_id, seq, speaker, body, move)
    values (p_deal, seq, 'system',
      'No overlap. Truce stopped, because that is where you each told it to stop. There is nothing to sign and nothing to pay.',
      'stop');
    update public.truce_deals set status = 'no_overlap' where id = p_deal;
    return jsonb_build_object('status','no_overlap');
  end if;

  -- a stable per-deal seed, so the same deal always produces the same settlement
  select seed into s from public.truce_deals where id = p_deal;
  if s is null then s := random(); update public.truce_deals set seed = s where id = p_deal; end if;

  mid  := (seller_min + buyer_max) / 2.0;
  half := (buyer_max - seller_min) / 2.0;
  -- bounded to a third of the half-overlap: enough that 2*settled-mine is a range, never a number,
  -- and small enough that neither side can call the outcome unfair.
  jitter := (s - 0.5) * 2.0 * (half / 3.0);
  incr := greatest(1, round(greatest(buyer_max, 1) * 0.005, 0));   -- ~0.5% natural increment
  target := round((mid + jitter) / incr, 0) * incr;
  target := least(greatest(target, seller_min), buyer_max);        -- never outside either limit

  -- Openings are the PUBLIC numbers. Printing them leaks nothing, and they give the thread its
  -- movement back. Clamp only so a side never opens worse for itself than the settlement.
  seller_open := greatest(seller_open, target);
  buyer_open  := least(buyer_open,  target);

  for i in 1 .. rounds loop
    f := (rounds - i)::numeric / (rounds - 1);          -- 1.0, 0.66, 0.33, 0.0
    ask := round((target + (seller_open - target) * f) / incr, 0) * incr;
    bid := round((target - (target - buyer_open) * f) / incr, 0) * incr;

    seq := seq + 1;
    insert into public.truce_messages (deal_id, seq, speaker, body, amount, move)
    values (p_deal, seq, 'agent_' || seller.side,
      case when i = 1
        then format('This is an A I agent for %s, and this conversation is on the record. %s is asking $%s.', seller.display_name, seller.display_name, to_char(ask,'FM999,999,999'))
        when ask = target then format('%s can do $%s. That works.', seller.display_name, to_char(ask,'FM999,999,999'))
        else format('%s can come down to $%s.', seller.display_name, to_char(ask,'FM999,999,999')) end,
      ask, case when i = 1 then 'open' else 'concede' end);

    seq := seq + 1;
    insert into public.truce_messages (deal_id, seq, speaker, body, amount, move)
    values (p_deal, seq, 'agent_' || buyer.side,
      case when i = 1
        then format('This is an A I agent for %s, also on the record. %s is offering $%s.', buyer.display_name, buyer.display_name, to_char(bid,'FM999,999,999'))
        when bid = target then format('%s can go to $%s. Agreed.', buyer.display_name, to_char(bid,'FM999,999,999'))
        else format('%s can go to $%s.', buyer.display_name, to_char(bid,'FM999,999,999')) end,
      bid, case when i = 1 then 'open' else 'concede' end);
  end loop;

  seq := seq + 1;
  insert into public.truce_messages (deal_id, seq, speaker, body, amount, move)
  values (p_deal, seq, 'system',
    format('Settled at $%s in %s messages. Neither limit was shown, and neither can be worked out from this number.', to_char(target,'FM999,999,999'), seq),
    target, 'accept');

  update public.truce_deals
     set status = 'settled', settled_at = now(), settled_value = target,
         settlement = jsonb_build_object('value', target, 'messages', seq,
           'method', 'a point inside the overlap between two sealed limits, offset so the figure cannot be inverted to reveal either one',
           'increment', incr, 'computed_at', now())
   where id = p_deal;

  return jsonb_build_object('status','settled','value',target,'messages',seq);
end $$;

create or replace function public.tr_set_limit(
  p_token text, p_direction text, p_amount numeric,
  p_must_haves text[] default '{}', p_opening numeric default null)
returns jsonb language plpgsql security definer set search_path = public, sealed as $$
declare me public.truce_parties;
begin
  select * into me from public.truce_parties where token = p_token;
  if not found then return jsonb_build_object('error','unknown link'); end if;
  if p_direction not in ('max','min') then return jsonb_build_object('error','direction must be max or min'); end if;
  if p_amount is null or p_amount < 0 then return jsonb_build_object('error','a limit needs a number'); end if;
  -- An opening that is worse for you than your own limit is a typo, not a strategy.
  if p_opening is not null then
    if p_direction = 'min' and p_opening < p_amount then
      return jsonb_build_object('error','your asking price is below the least you said you would take');
    end if;
    if p_direction = 'max' and p_opening > p_amount then
      return jsonb_build_object('error','your offer is above the most you said you would pay');
    end if;
  end if;

  insert into sealed.limits (party_id, deal_id, direction, amount, must_haves, opening)
  values (me.id, me.deal_id, p_direction, p_amount, coalesce(p_must_haves,'{}'), p_opening)
  on conflict (party_id) do update set direction = excluded.direction, amount = excluded.amount,
                                       must_haves = excluded.must_haves, opening = excluded.opening,
                                       set_at = now();

  update public.truce_parties set limit_set_at = now(), joined_at = coalesce(joined_at, now()) where id = me.id;
  update public.truce_deals set status = 'negotiating' where id = me.deal_id and status = 'open';

  if (select count(*) from sealed.limits where deal_id = me.deal_id) = 2 then
    perform sealed.negotiate(me.deal_id);
  end if;
  return public.tr_view(p_token);
end $$;

-- tr_view must surface the opening (public, yours) without ever surfacing a limit that is not yours.
create or replace function public.tr_view(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public, sealed as $$
declare me public.truce_parties; d public.truce_deals; them public.truce_parties;
        mine sealed.limits; theirs sealed.limits;
begin
  select * into me from public.truce_parties where token = p_token;
  if not found then return jsonb_build_object('error','unknown link'); end if;
  select * into d from public.truce_deals where id = me.deal_id;
  select * into them from public.truce_parties where deal_id = me.deal_id and side <> me.side;
  select * into mine from sealed.limits where party_id = me.id;
  select * into theirs from sealed.limits where party_id = them.id;

  return jsonb_build_object(
    'deal', jsonb_build_object('id', d.id, 'subject', d.subject, 'kind', d.kind,
              'status', d.status, 'settled_value', d.settled_value, 'settlement', d.settlement,
              'fee_cents', d.fee_cents, 'expires_at', d.expires_at),
    'me', jsonb_build_object('side', me.side, 'role', me.role, 'name', me.display_name,
            'limit', mine.amount, 'opening', mine.opening, 'direction', mine.direction,
            'must_haves', mine.must_haves, 'signed_at', me.signed_at),
    'them', jsonb_build_object('role', them.role, 'name', them.display_name,
              'has_set_limit', theirs.party_id is not null,
              -- their OPENING is public by design; their LIMIT is never returned by any path.
              'opening', theirs.opening,
              'joined', them.joined_at is not null, 'signed_at', them.signed_at),
    'thread', coalesce((select jsonb_agg(jsonb_build_object(
                 'seq', m.seq, 'speaker', m.speaker, 'body', m.body, 'amount', m.amount,
                 'move', m.move, 'at', m.at) order by m.seq)
               from public.truce_messages m where m.deal_id = d.id), '[]'::jsonb)
  );
end $$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (p.proname like 'sv\_%' or p.proname like 'tr\_%')
  loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('grant execute on function %s to anon, authenticated', f.sig);
  end loop;
end $$;
revoke all on function sealed.negotiate(uuid) from public, anon, authenticated;;
