-- 20260814211958_contacts_reach_and_enrichment_filters
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- The filter vocabulary an operator actually thinks in.
--
-- `reach` collapses three related questions into one control: can I email them, is this a fixed
-- business line, is it a mobile, or is there no channel at all. The RPC keeps them as separate
-- columns and only the VOCABULARY is collapsed, so the filter stays explainable in terms of the
-- query it runs rather than becoming a magic word.
--
-- `enriched` distinguishes the two empties that matter: a site nobody has read yet (a work queue)
-- from a site that was read and published nothing (an honest absence). Same distinction as
-- waiting-on-state-clearance versus blocked-by-state-law.
--
-- Suppressed leads are excluded by DEFAULT at the call site, not here: an operator working a list
-- should never have to remember that some rows must never be contacted.

drop function if exists public.sv_admin_contacts(
  text, text, text, text, text, text, text, text, text, boolean, boolean, text, integer, integer, boolean);

create or replace function public.sv_admin_contacts(
  p_secret text, p_q text, p_lane text, p_disposition text, p_state text, p_trade text,
  p_line_type text, p_owner text, p_tag text, p_suppressed boolean,
  p_reach text, p_enriched text, p_sort text, p_limit integer, p_offset integer
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb; n bigint; lim integer; off integer;
begin
  perform private.require(p_secret);
  lim := greatest(1, least(coalesce(p_limit, 50), 200));
  off := greatest(0, coalesce(p_offset, 0));

  create temp table if not exists _crm_filtered on commit drop as
  select c.* from public.contacts c where false;
  delete from _crm_filtered;

  insert into _crm_filtered
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
         or coalesce(c.contact_name,'') ilike '%'||p_q||'%' or c.id::text = p_q));

  select count(*) into n from _crm_filtered;

  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v from (
    select c.id, c.name, c.phone, c.trade, c.state, c.city, c.website, c.line_type, c.carrier,
           c.lane, c.lane_reasons, c.disposition, c.owner, c.tags, c.score, c.suppressed,
           c.suppressed_reason, c.call_count, c.first_contacted_at, c.last_contacted_at,
           c.created_at, c.contact_name, c.contact_role, c.email, c.linkedin_url, c.enriched_at,
           c.first_seen_via,
           coalesce(c.line_type in ('landline','fixedVoip'), false) as ai_dialable,
           (select count(*) from public.notes nt where nt.contact_id = c.id) as note_count,
           (select count(*) from public.crm_tasks t
             where t.contact_id = c.id and t.status = 'open')        as open_tasks
      from _crm_filtered c
     order by
       case when coalesce(p_sort,'recent') = 'recent'  then c.created_at end desc nulls last,
       case when p_sort = 'name'    then lower(c.name) end asc  nulls last,
       case when p_sort = 'calls'   then c.call_count end desc nulls last,
       case when p_sort = 'touched' then c.last_contacted_at end desc nulls last,
       c.created_at desc
     limit lim offset off
  ) x;

  return jsonb_build_object('total', n, 'limit', lim, 'offset', off, 'rows', v);
end $$;;
