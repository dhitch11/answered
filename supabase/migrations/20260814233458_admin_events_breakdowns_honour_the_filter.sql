-- 20260814233458_admin_events_breakdowns_honour_the_filter
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- A FILTERED TOTAL BESIDE AN UNFILTERED BREAKDOWN IS TWO NUMBERS THAT DISAGREE, WITH NOTHING SAYING SO.
--
-- total and rows honoured p_name. by_name and by_day did not. So filtering to one event name showed
-- a small total above a daily chart summing EVERY event, and the operator had no way to know which
-- of the two numbers answered their question. Both were individually true, which is what makes this
-- class of defect survive review.
--
-- The fix is not "filter everything". The two breakdowns want different scopes and the difference is
-- real:
--
--   by_day IS the time series of the thing you are looking at, so it must honour every filter.
--   by_name IS THE PICKER. Filtering it by name leaves exactly one row and destroys its only job,
--   which is showing you what else there is to select. So it stays unfiltered ON PURPOSE - and now
--   says so, in the payload, so the UI can label it instead of leaving the operator to assume.
create or replace function public.sv_admin_events(p_secret text, p_account uuid, p_name text, p_since timestamptz, p_limit integer, p_offset integer)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v jsonb; n int; lim int; off int; since timestamptz;
begin
  perform private.require(p_secret);
  lim := greatest(1, least(coalesce(p_limit, 100), 500));
  off := greatest(0, coalesce(p_offset, 0));
  since := coalesce(p_since, now() - interval '30 days');

  select count(*) into n from public.app_events e
   where e.at >= since and (p_account is null or e.account_id = p_account)
     and (p_name is null or e.name = p_name);

  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v from (
    select e.id, e.name, e.page, e.meta, e.source, e.at, e.account_id, e.anon_id,
           a.business_name
      from public.app_events e
      left join public.accounts a on a.id = e.account_id
     where e.at >= since and (p_account is null or e.account_id = p_account)
       and (p_name is null or e.name = p_name)
     order by e.at desc limit lim offset off
  ) x;

  return jsonb_build_object(
    'total', n, 'limit', lim, 'offset', off, 'since', since, 'rows', v,
    'filtered_by_name', p_name,
    -- Say what scope each breakdown was computed at, so a caller never has to infer it.
    'by_name_scope', 'all_names',
    'by_day_scope',  case when p_name is null then 'all_names' else 'this_name' end,
    'by_name', (select coalesce(jsonb_agg(jsonb_build_object(
                  'name', g.name, 'n', g.n, 'accounts', g.accts, 'last_at', g.last_at)
                  order by g.n desc), '[]'::jsonb)
                from (select name, count(*) as n, count(distinct account_id) as accts,
                             max(at) as last_at
                        from public.app_events where at >= since
                         and (p_account is null or account_id = p_account)
                       group by name) g),
    'by_day', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'n', d.n)
                 order by d.day), '[]'::jsonb)
               from (select date_trunc('day', at)::date as day, count(*) as n
                       from public.app_events where at >= since
                        and (p_account is null or account_id = p_account)
                        and (p_name is null or name = p_name)
                      group by 1) d)
  );
end $function$;;
