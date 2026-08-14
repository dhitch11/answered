-- 20260814193642_tr_terms_exchange_after_the_deal_is_over
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- tr_terms — the OTHER half of the artifact /parley sells. (@LANE-PARLEY, additive.)
--
-- WHY THIS EXISTS. must_haves are stored in sealed.limits, alongside the sealed amount, and
-- tr_view returns only me.must_haves. So the terms a party types are visible to nobody but the
-- author, while /parley sells the artifact as "One page. Plain words. Both names." and sells
-- step two as "the number you will not cross, plus the terms you actually care about". The seal
-- belongs on the NUMBER, not on the sentence.
--
-- IT DOES NOT WEAKEN THE SEAL, THREE WAYS:
--   1. It NEVER returns an amount, an opening or a direction. There is no shape of call here that
--      reaches a limit figure.
--   2. It opens only once the negotiation is OVER (settled or no_overlap). Before that a term is
--      still leverage, and leverage handed to the other side mid-deal is the same defect class as
--      an opening anchored on the overlap.
--   3. It REDACTS any line whose digits contain EITHER party's sealed limit, and reports the count.
--      A free-text box next to a sealed number is a leak vector: a party who types "I need at
--      least 1400" would otherwise hand over the number the page promises is never told. Failing
--      closed here costs a redacted line; failing open costs the promise.
create or replace function public.tr_terms(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'sealed'
as $function$
declare
  me public.truce_parties; them public.truce_parties; d public.truce_deals;
  mine sealed.limits; theirs sealed.limits;
  my_out text[] := '{}'; their_out text[] := '{}';
  my_held int := 0; their_held int := 0;
  line text; digits text; a_dig text; b_dig text;
begin
  select * into me from public.truce_parties where token = p_token;
  if not found then return jsonb_build_object('error','unknown link'); end if;
  select * into d    from public.truce_deals   where id = me.deal_id;
  select * into them from public.truce_parties where deal_id = me.deal_id and side <> me.side;
  select * into mine   from sealed.limits where party_id = me.id;
  select * into theirs from sealed.limits where party_id = them.id;

  -- digits of each sealed limit, used only for the redaction comparison and never returned
  a_dig := nullif(regexp_replace(coalesce(trunc(mine.amount)::text,   ''), '\D', '', 'g'), '');
  b_dig := nullif(regexp_replace(coalesce(trunc(theirs.amount)::text, ''), '\D', '', 'g'), '');

  foreach line in array coalesce(mine.must_haves, '{}'::text[]) loop
    digits := regexp_replace(line, '\D', '', 'g');
    if (a_dig is not null and digits like '%' || a_dig || '%')
       or (b_dig is not null and digits like '%' || b_dig || '%') then
      my_held := my_held + 1;
    else
      my_out := my_out || line;
    end if;
  end loop;

  if d.status in ('settled','no_overlap') then
    foreach line in array coalesce(theirs.must_haves, '{}'::text[]) loop
      digits := regexp_replace(line, '\D', '', 'g');
      if (a_dig is not null and digits like '%' || a_dig || '%')
         or (b_dig is not null and digits like '%' || b_dig || '%') then
        their_held := their_held + 1;
      else
        their_out := their_out || line;
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'status', d.status,
    -- false is not "empty": it says the terms are still closed and why, so a caller can print the
    -- true reason instead of an empty list that reads as "they asked for nothing".
    'exchanged', d.status in ('settled','no_overlap'),
    'me',   jsonb_build_object('name', me.display_name,   'role', me.role,
                               'terms', to_jsonb(my_out),    'held_back', my_held),
    'them', jsonb_build_object('name', them.display_name, 'role', them.role,
                               'terms', to_jsonb(their_out), 'held_back', their_held,
                               'set_any', coalesce(array_length(theirs.must_haves,1),0) > 0)
  );
end $function$;

revoke all on function public.tr_terms(text) from public;
grant execute on function public.tr_terms(text) to anon, authenticated, service_role;;
