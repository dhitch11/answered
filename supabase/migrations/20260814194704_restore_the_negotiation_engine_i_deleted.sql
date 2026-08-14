-- 20260814194704_restore_the_negotiation_engine_i_deleted
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- ★ I DELETED THE NEGOTIATION ENGINE AND THE ONLY REASON I KNOW IS THAT I PROBED THE SERVING PATH.
--
-- The previous migration replaced sealed.negotiate's body with a same-direction guard that then
-- delegated to `sealed.negotiate_ok`, a function I never wrote. Every CORRECTLY formed deal — the
-- entire product — began raising undefined_function, which PostgREST returns as a 404. So the fix
-- for a rare malformed pair had broken every well-formed pair, and it would have looked like a
-- routing bug rather than a missing function.
--
-- Nothing about this was visible in the migration: it applied cleanly, the guard worked, and the
-- refusal I was testing for behaved exactly as designed. Postgres resolves a function call inside
-- plpgsql at EXECUTION time, so a body referring to a function that does not exist compiles, ships
-- and stores without complaint, and only fails on the first call that reaches that line.
--
-- The engine below is byte-for-byte the version from migration 20260814181351, recovered from the
-- migration history, moved under the name the guard already calls.

create or replace function sealed.negotiate_ok(p_deal uuid)
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

revoke all on function sealed.negotiate_ok(uuid) from public, anon, authenticated;;
