-- 20260814193631_agent_tool_calls_grants_fix
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- @LANE-BOOK 2026-08-14, correcting my own migration ten minutes later, by MEASURING the grants on
-- the RPCs that already work instead of assuming mine were fine.
--
-- lib/db.mjs reaches PostgREST with the PUBLISHABLE key, so every sv_* RPC executes as the `anon`
-- role and the real gate is private.require(p_secret) INSIDE the function. sv_add_event and
-- sv_suppress are granted {anon, authenticated, postgres, service_role}. Mine were granted only
-- {postgres, service_role}: the table would have been perfect and every call from the live
-- function would have come back 403. This is the exact class of defect this estate keeps paying
-- for, a control that looks correct in the file and refuses in production, so it is fixed here
-- rather than discovered on a phone call.
grant execute on function public.sv_tool_claim(text,text,text,text,text,jsonb) to anon, authenticated;
grant execute on function public.sv_tool_settle(text,text,text,jsonb)          to anon, authenticated;;
