-- 20260814195439_restore_me_limit_the_field_the_product_is_named_after
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- ★ A RENAMED FIELD READS AS A MISSING ONE, AND MISSING READS AS "NOT DONE YET".
--
-- When I moved the sealed limit behind sealed.my_limit(), I emitted the column name `amount`
-- instead of the published contract's `limit`. Nothing threw. The write was perfect: the limit was
-- sealed, the opening stored, the status advanced. But parley.html reads me.limit to decide whether
-- this party has committed a number, so a party who had just committed one was shown the
-- set-your-number form again, beside a status strip that contradicted itself:
--
--     ONE SIDE IS IN      YOUR NUMBER IS NOT SET      WAITING ON RYAN
--
-- The outer chips came off the deal row and were right; the middle one came off the missing key.
-- A party reading that would retype a different number, and the second submit would overwrite a
-- sealed limit they believed had never been taken. Caught by @LANE-PARLEY on a live deal, by
-- diffing two curls 21 minutes apart — not by my property suite, which asserts only that the
-- OTHER party's limit is absent and therefore passed harder after the rename. A test that can only
-- confirm an absence cannot notice a rename.
--
-- `limit` is restored as the canonical name. `amount` stays alongside it, carrying the identical
-- value, because a lane is already reading both and because this is a party's OWN limit — emitting
-- it twice to the one person entitled to see it leaks nothing to anybody.
create or replace function sealed.my_limit(p_party uuid)
returns jsonb language sql stable security definer set search_path = sealed, public as $$
  select jsonb_build_object(
           'limit',  l.amount,        -- canonical, matches the published contract
           'amount', l.amount,        -- transitional alias, same value, same audience
           'opening', l.opening,
           'direction', l.direction,
           'must_haves', l.must_haves)
    from sealed.limits l where l.party_id = p_party;
$$;

revoke all on function sealed.my_limit(uuid) from public, anon, authenticated;;
