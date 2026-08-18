-- 20260818091500_parley_create_mode_and_overload_repair
--
-- Captured from what was applied to production, so the repo and the database agree. The engine
-- migration warns why that matters: "Rebuild this database from migrations and Parley's engine
-- vanishes silently, with the page still serving and every route still answering 200."
--
-- ★ TWO MISTAKES ARE RECORDED HERE ON PURPOSE, because both are easy to repeat.
--
-- MISTAKE 1 — I rewrote sv_truce_create from the MIGRATION FILE instead of from pg_proc, and the
-- file was older than the deployed function: the invitation work had rebuilt it directly against
-- the database. My version inserted a column `name`; the column is `display_name`. Every create
-- 400'd until it was fixed. Read the live definition before replacing a live function.
--
-- MISTAKE 2 — `create or replace function` with a NEW DEFAULTED ARGUMENT does not replace, it
-- OVERLOADS. Postgres keys a function on its argument types, so the 7-arg original survived beside
-- the 8-arg version and PostgREST answered every create with PGRST203, "could not choose the best
-- candidate function". Invisible from SQL, fatal through the API. The old signature has to be
-- dropped explicitly.

create or replace function public.sv_truce_create(
  p_secret text, p_subject text, p_kind text,
  p_a_name text, p_a_role text, p_b_name text, p_b_role text,
  p_mode text default 'instant')
returns jsonb language plpgsql security definer
set search_path to 'public', 'private', 'extensions' as $function$
declare d uuid; ta text; tb text; claim text;
begin
  perform private.require(p_secret);
  if coalesce(p_mode,'instant') not in ('instant','thread') then
    return jsonb_build_object('error','mode must be instant or thread');
  end if;

  insert into public.truce_deals (subject, kind, mode)
  values (left(coalesce(p_subject,''),200), coalesce(p_kind,'other'), coalesce(p_mode,'instant'))
  returning id into d;

  ta    := encode(gen_random_bytes(24), 'hex');
  tb    := encode(gen_random_bytes(24), 'hex');
  claim := encode(gen_random_bytes(12), 'hex');

  insert into public.truce_parties (deal_id, side, role, display_name, token, joined_at)
  values (d, 'a', coalesce(nullif(btrim(coalesce(p_a_role,'')),''),'side a'),
             coalesce(nullif(btrim(coalesce(p_a_name,'')),''),'Side A'), ta, now());

  -- Side B gets a token because the column is NOT NULL, and the creator NEVER receives it. They
  -- get the short claim_code; tr_claim exchanges it once and destroys it. The two strings are
  -- different lengths so they can never be confused - see feedback_an_invitation_is_not_a_credential,
  -- written after the sender could open the link they had texted and read the other side's limit.
  insert into public.truce_parties (deal_id, side, role, display_name, token, claim_code)
  values (d, 'b', coalesce(nullif(btrim(coalesce(p_b_role,'')),''),'side b'),
             coalesce(nullif(btrim(coalesce(p_b_name,'')),''),'Side B'), tb, claim);

  return jsonb_build_object('deal_id', d, 'a_token', ta, 'b_claim', claim,
                            'mode', coalesce(p_mode,'instant'));
end $function$;

drop function if exists public.sv_truce_create(text, text, text, text, text, text, text);

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public' and p.proname='sv_truce_create'
  loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('grant execute on function %s to anon, authenticated', f.sig);
  end loop;
end $$;
