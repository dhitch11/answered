-- 20260814201021_sv_consent_for_scope
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- ★ WHY THIS EXISTS, MEASURED 2026-08-14 BY @LANE-HOLD.
-- sv_dial_context hardcodes `x.scope = 'research_call'` in its consent subquery. That is exactly
-- right for the caller it was written for: the cold research dialler must never treat a permission
-- granted for one purpose as permission for another. But it means consent recorded under ANY other
-- scope is invisible through that door, and Hold records `hold_bridge`. The Hold gate read
-- ctx.consent, got null for a customer who had agreed in writing four hundred milliseconds
-- earlier, and refused to ring them. Every legitimate Hold errand would have been refused, with a
-- correct-sounding reason.
--
-- sv_dial_context is NOT changed. Widening its scope filter would quietly widen what the cold
-- dialler accepts, which is another lane's compliance decision and not one to make as a side
-- effect. This is an additive read that takes the scope as an argument, so the caller has to name
-- the permission it is relying on.
create or replace function public.sv_consent_for(p_secret text, p_phone text, p_scope text)
returns jsonb language plpgsql stable security definer set search_path to 'public','private' as $$
declare v jsonb;
begin
  perform private.require(p_secret);
  if p_phone is null or p_scope is null then
    return jsonb_build_object('error','a consent read needs both a number and the scope it is for');
  end if;
  select to_jsonb(x) into v from public.consent x
   where x.phone = p_phone and x.scope = p_scope
     and (x.expires_at is null or x.expires_at > now())
   order by x.granted_at desc limit 1;
  -- Suppression outranks consent in both directions, the same rule sv_grant_consent already
  -- enforces on the write side. A number that said stop is reported as having no usable consent
  -- however many forms it has since submitted.
  if exists (select 1 from public.suppression s where s.phone = p_phone)
     or exists (select 1 from public.contacts c where c.phone = p_phone and c.suppressed) then
    return jsonb_build_object('suppressed', true, 'consent', null);
  end if;
  return jsonb_build_object('suppressed', false, 'consent', v);
end $$;;
