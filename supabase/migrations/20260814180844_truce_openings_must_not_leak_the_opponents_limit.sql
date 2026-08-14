-- 20260814180844_truce_openings_must_not_leak_the_opponents_limit
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- ★★ THE LEAK, AND WHY IT SURVIVED A CORRECT-LOOKING RESULT.
--
-- The first version walked the concession schedule inward from the EDGES OF THE OVERLAP. The
-- edges of the overlap are, by definition, the two sealed limits. So the opening messages read:
--
--     "Dana is at $1,975."   <- that is RYAN's secret maximum
--     "Ryan is at $1,875."   <- that is DANA's secret minimum
--
-- It settled at exactly $1,925, the right answer, by the right method, and printed each party's
-- private number to the other party in message one. Every check that looked at the OUTCOME passed.
--
-- This matters beyond a bug: /truce Section 3 ships a button labelled "Show me every message that
-- mentions my limit", whose answer is "None. That is the point." With edge-anchored openings that
-- answer is FALSE — a search for your own limit finds it in your opponent's opening line.
--
-- The fix: an opening is anchored ONLY on the speaker's own limit. A seller opens above their own
-- floor; a buyer opens below their own ceiling. The engine still knows both numbers, because it is
-- the trusted third party and that is its job — but no number it PRINTS is ever derived from the
-- listener's secret.

create or replace function sealed.negotiate(p_deal uuid)
returns jsonb language plpgsql security definer set search_path = sealed, public as $$
declare
  a public.truce_parties; b public.truce_parties;
  la sealed.limits; lb sealed.limits;
  buyer_max numeric; seller_min numeric;
  target numeric; open_ask numeric; open_bid numeric;
  buyer public.truce_parties; seller public.truce_parties;
  steps numeric[] := array[1.0, 0.52, 0.24, 0.0];
  seq int := 0; i int; bid numeric; ask numeric;
  SPREAD constant numeric := 0.06;   -- how far above/below its OWN limit a side opens
begin
  select * into a from public.truce_parties where deal_id = p_deal and side = 'a';
  select * into b from public.truce_parties where deal_id = p_deal and side = 'b';
  select * into la from sealed.limits where party_id = a.id;
  select * into lb from sealed.limits where party_id = b.id;
  if la is null or lb is null then return jsonb_build_object('status','waiting'); end if;

  if la.direction = 'max' then buyer := a; seller := b; buyer_max := la.amount; seller_min := lb.amount;
  else buyer := b; seller := a; buyer_max := lb.amount; seller_min := la.amount; end if;

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

  target := round((seller_min + buyer_max) / 2.0, 0);

  -- ANCHORED ON SELF, NEVER ON THE OPPONENT.
  open_ask := round(seller_min * (1 + SPREAD), 0);   -- the seller asks above its own floor
  open_bid := round(buyer_max  * (1 - SPREAD), 0);   -- the buyer bids below its own ceiling
  -- If a self-anchored opening has already crossed the target, start at the target instead of
  -- walking backwards, so the thread never reads as a side bidding against itself.
  if open_ask < target then open_ask := target; end if;
  if open_bid > target then open_bid := target; end if;

  for i in 1 .. array_length(steps,1) loop
    ask := round(target + (open_ask - target) * steps[i], 0);
    bid := round(target - (target - open_bid) * steps[i], 0);

    seq := seq + 1;
    insert into public.truce_messages (deal_id, seq, speaker, body, amount, move)
    values (p_deal, seq, 'agent_' || seller.side,
      case when i = 1
        then format('This is an A I agent for %s, and this conversation is on the record. %s is asking $%s.', seller.display_name, seller.display_name, to_char(ask,'FM999,999,999'))
        else format('%s can do $%s.', seller.display_name, to_char(ask,'FM999,999,999')) end,
      ask, case when i = 1 then 'open' else 'concede' end);

    seq := seq + 1;
    insert into public.truce_messages (deal_id, seq, speaker, body, amount, move)
    values (p_deal, seq, 'agent_' || buyer.side,
      case when i = 1
        then format('This is an A I agent for %s, also on the record. %s is offering $%s.', buyer.display_name, buyer.display_name, to_char(bid,'FM999,999,999'))
        else format('%s can go to $%s.', buyer.display_name, to_char(bid,'FM999,999,999')) end,
      bid, case when i = 1 then 'open' else 'concede' end);

    exit when ask <= bid;
  end loop;

  seq := seq + 1;
  insert into public.truce_messages (deal_id, seq, speaker, body, amount, move)
  values (p_deal, seq, 'system',
    format('Settled at $%s. Neither limit was ever shown to the other side.', to_char(target,'FM999,999,999')),
    target, 'accept');

  update public.truce_deals
     set status = 'settled', settled_at = now(), settled_value = target,
         settlement = jsonb_build_object('value', target, 'messages', seq,
           'method', 'midpoint of the overlap between two sealed limits', 'computed_at', now())
   where id = p_deal;

  return jsonb_build_object('status','settled','value',target,'messages',seq);
end $$;

revoke all on function sealed.negotiate(uuid) from public, anon, authenticated;

-- ── THE INSTRUMENT ───────────────────────────────────────────────────────────────────────────
-- The page ships a button that answers "how many messages mention my limit". That answer must be
-- computed against the real thread, and it must be able to come back non-zero, or it is a slogan.
create or replace function public.tr_leak_check(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public, sealed as $$
declare me public.truce_parties; mine sealed.limits; theirs sealed.limits;
        them public.truce_parties; mine_hits int; theirs_hits int;
begin
  select * into me from public.truce_parties where token = p_token;
  if not found then return jsonb_build_object('error','unknown link'); end if;
  select * into them from public.truce_parties where deal_id = me.deal_id and side <> me.side;
  select * into mine from sealed.limits where party_id = me.id;
  select * into theirs from sealed.limits where party_id = them.id;

  select count(*) into mine_hits from public.truce_messages m
   where m.deal_id = me.deal_id and mine.amount is not null and m.amount = mine.amount;
  select count(*) into theirs_hits from public.truce_messages m
   where m.deal_id = me.deal_id and theirs.amount is not null and m.amount = theirs.amount;

  return jsonb_build_object(
    'your_limit_appears_in_messages', mine_hits,
    'their_limit_appears_in_messages', theirs_hits,
    -- a settlement that lands exactly on a limit is a zero-width overlap, which is honest and
    -- unavoidable; it is reported rather than hidden.
    'settled_on_a_limit', (select d.settled_value from public.truce_deals d where d.id = me.deal_id)
                          in (mine.amount, theirs.amount)
  );
end $$;
revoke all on function public.tr_leak_check(text) from public;
grant execute on function public.tr_leak_check(text) to anon, authenticated;;
