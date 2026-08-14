-- 20260814212447_contacts_filter_disambiguate_count
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- 42702 "column reference n is ambiguous": the CTE exposed a column called `n` and the function
-- declares a variable called `n`, so `select n from counted` could mean either. PL/pgSQL resolves
-- that by refusing, which is the right behaviour and a good reason to never name a variable after
-- something a query might also call a column.
--
-- Renamed the variable rather than the column, because `n` reads well in the CTE and the variable
-- is the thing with a scope problem.

create or replace function public.sv_admin_contacts(
  p_secret text, p_q text, p_lane text, p_disposition text, p_state text, p_trade text,
  p_line_type text, p_owner text, p_tag text, p_suppressed boolean,
  p_reach text, p_enriched text, p_sort text, p_limit integer, p_offset integer
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_rows jsonb; v_total bigint; v_lim integer; v_off integer;
begin
  perform private.require(p_secret);
  v_lim := greatest(1, least(coalesce(p_limit, 50), 200));
  v_off := greatest(0, coalesce(p_offset, 0));

  with filtered as (
    select c.* from public.contacts c
     where (p_lane        is null or c.lane = p_lane)
       and (p_disposition is null or c.disposition = p_disposition)
       and (p_state       is null or c.state = p_state)
       and (p_trade       is null or c.trade = p_trade)
       and (p_line_type   is null or c.line_type = p_line_type)
       and (p_owner       is null or c.owner = p_owner)
       and (p_tag         is null or c.tags @> array[p_tag])
       and (p_suppressed  is null or coalesce(c.suppressed,false) = p_suppressed)
       and (p_reach is null or p_reach = '' or
            (p_reach = 'email'  and c.email is not null) or
            (p_reach = 'fixed'  and c.line_type in ('landline','fixedVoip')) or
            (p_reach = 'mobile' and c.line_type in ('mobile','nonFixedVoip')) or
            (p_reach = 'none'   and c.email is null
                                and (c.line_type is null or c.line_type = 'tollFree')))
       and (p_enriched is null or p_enriched = '' or
            (p_enriched = 'done' and c.enriched_at is not null) or
            (p_enriched = 'todo' and c.enriched_at is null and c.website is not null))
       and (p_q is null or p_q = '' or (
              c.name ilike '%'||p_q||'%' or c.phone ilike '%'||p_q||'%' or c.city ilike '%'||p_q||'%'
           or c.website ilike '%'||p_q||'%' or c.street ilike '%'||p_q||'%'
           or coalesce(c.email,'') ilike '%'||p_q||'%'
           or coalesce(c.contact_name,'') ilike '%'||p_q||'%'
           or (p_q ~ '^[0-9a-f-]{36}$' and c.id::text = p_q)))
  ),
  page as (
    select c.id, c.name, c.phone, c.trade, c.state, c.city, c.website, c.line_type, c.carrier,
           c.lane, c.lane_reasons, c.disposition, c.owner, c.tags, c.score, c.suppressed,
           c.suppressed_reason, c.call_count, c.first_contacted_at, c.last_contacted_at,
           c.created_at, c.contact_name, c.contact_role, c.email, c.linkedin_url, c.enriched_at,
           c.first_seen_via,
           coalesce(c.line_type in ('landline','fixedVoip'), false) as ai_dialable,
           (select count(*) from public.notes nt where nt.contact_id = c.id) as note_count,
           (select count(*) from public.crm_tasks t
             where t.contact_id = c.id and t.status = 'open')        as open_tasks
      from filtered c
     order by
       case when coalesce(p_sort,'recent') = 'recent'  then c.created_at end desc nulls last,
       case when p_sort = 'name'    then lower(c.name) end asc  nulls last,
       case when p_sort = 'calls'   then c.call_count end desc nulls last,
       case when p_sort = 'touched' then c.last_contacted_at end desc nulls last,
       c.created_at desc
     limit v_lim offset v_off
  )
  select (select count(*) from filtered),
         coalesce((select jsonb_agg(to_jsonb(page)) from page), '[]'::jsonb)
    into v_total, v_rows;

  return jsonb_build_object('total', v_total, 'limit', v_lim, 'offset', v_off, 'rows', v_rows);
end $$;;
