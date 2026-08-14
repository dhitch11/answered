-- 20260814190301_truce_test_teardown_that_cannot_touch_a_real_deal
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- Teardown for the property suite.
--
-- A previous run left 14 fabricated negotiations in the production table the operator console reads,
-- and a teammate found them and reasoned about them as if they were real. A test that writes to
-- production and does not clean up is manufacturing evidence.
--
-- ★ THE DESIGN CONSTRAINT: this must be INCAPABLE of deleting a real deal, not merely trusted not
-- to. So it takes the run tag as an argument AND requires the deal's own subject to start with it
-- AND requires that tag to match the test-run shape. A caller who passes a real deal's id gets
-- deleted=false, because the subject will not match. There is no argument that widens it.
create or replace function public.sv_truce_purge_test(p_secret text, p_deal uuid, p_run text)
returns jsonb language plpgsql security definer set search_path = public, private as $$
declare v_subject text; v_deleted int;
begin
  perform private.require(p_secret);

  if p_run is null or p_run !~ '^truce-test-[a-z0-9]+$' then
    return jsonb_build_object('deleted', false, 'refused', 'that is not a test-run tag');
  end if;

  select subject into v_subject from public.truce_deals where id = p_deal;
  if v_subject is null then
    return jsonb_build_object('deleted', false, 'refused', 'no such deal');
  end if;
  if position(p_run in v_subject) <> 1 then
    -- The deal exists but was not created by this run. Refuse loudly rather than silently.
    return jsonb_build_object('deleted', false, 'refused', 'that deal was not created by this test run');
  end if;

  delete from public.truce_deals where id = p_deal;
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('deleted', v_deleted = 1);
end $$;

revoke all on function public.sv_truce_purge_test(text, uuid, text) from public;
grant execute on function public.sv_truce_purge_test(text, uuid, text) to anon, authenticated;;
