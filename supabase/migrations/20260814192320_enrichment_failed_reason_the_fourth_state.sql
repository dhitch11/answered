-- 20260814192320_enrichment_failed_reason_the_fourth_state
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- @ANSWERED-INTEL found a fourth state my field set collapsed into the second.
--
--   enriched_at NULL                        nobody looked
--   enriched_at set, fields null, no reason  we READ the page and they publish nothing
--   enriched_at set, fields null, reason set we NEVER GOT TO READ the page
--   field present                            the value
--
-- The middle two rendered identically and they are different facts: one says this contractor does
-- not publish an owner name, the other says the site timed out. Only one of them means stop trying.
-- Same shape as the three-state registry scrub, where null means "could not answer" rather than
-- "clear", and for the same reason: an unanswered question must never render as an answer.

alter table public.contacts add column if not exists enrichment_failed_reason text;

comment on column public.contacts.enrichment_failed_reason is
  'Set when the attempt could not COMPLETE: unreachable, timeout, non-200, robots-disallowed, or a JS shell with nothing in the HTML. Null with enriched_at set means we genuinely read the page and they publish nothing. Only a set reason means retrying is worthwhile.';

create index if not exists contacts_retryable on public.contacts (enriched_at)
  where enrichment_failed_reason is not null;

create or replace function public.sv_enrich_contact(p_secret text, p_phone text, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = public, private as $$
begin
  perform private.require(p_secret);
  update public.contacts set
    contact_name       = coalesce(p_patch->>'contact_name', contact_name),
    contact_role       = coalesce(p_patch->>'contact_role', contact_role),
    email              = coalesce(p_patch->>'email', email),
    email_source       = coalesce(p_patch->>'email_source', email_source),
    linkedin_url       = coalesce(p_patch->>'linkedin_url', linkedin_url),
    website            = coalesce(website, p_patch->>'website'),
    -- overwritten every attempt, including being CLEARED when an attempt finally succeeds
    enrichment_failed_reason = p_patch->>'failed_reason',
    enriched_at        = now(),
    enrichment_sources = (
      select array(select distinct unnest(
        coalesce(enrichment_sources,'{}') ||
        coalesce((select array_agg(x) from jsonb_array_elements_text(p_patch->'sources') x), '{}')))
    ),
    updated_at         = now()
  where phone = p_phone;
  return jsonb_build_object('ok', found);
end $$;

-- Backfill the 40 already enriched, DERIVED FROM THE RECORDED SOURCES rather than assumed. A row
-- whose sources contain a failure marker never got read; one without a marker was read and was
-- genuinely bare. This is evidence we already stored, not a guess.
update public.contacts
   set enrichment_failed_reason = case
         when 'robots_disallowed' = any(enrichment_sources) then 'robots_disallowed'
         when 'unreachable' = any(enrichment_sources) then 'unreachable'
         when exists (select 1 from unnest(enrichment_sources) s where s like 'http\_%') then
           (select s from unnest(enrichment_sources) s where s like 'http\_%' limit 1)
         else null end
 where enriched_at is not null and enrichment_failed_reason is null;

create or replace function public.sv_lead_book(p_secret text, p_lane text default null,
  p_state text default null, p_trade text default null, p_limit int default 200, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public, private as $$
declare v jsonb; total int;
begin
  perform private.require(p_secret);
  select count(*) into total from public.contacts c
   where not c.suppressed
     and (p_lane is null or c.lane = p_lane)
     and (p_state is null or c.state = p_state)
     and (p_trade is null or c.trade = p_trade);

  select jsonb_build_object('total', total, 'rows', coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb)) into v
  from (
    select c.id, c.phone, c.name as business_name, c.contact_name, c.contact_role,
           c.email, c.email_source, c.linkedin_url, c.website, c.trade, c.city, c.state, c.street,
           c.line_type, c.carrier, c.lane, c.lane_reasons, c.disposition, c.tags, c.score,
           c.call_count, c.last_contacted_at, c.lat, c.lon,
           c.enriched_at, c.enrichment_sources, c.enrichment_failed_reason,
           -- four states, never two, so the console never renders "could not read" as "publishes none"
           case when c.enriched_at is null                    then 'never_looked'
                when c.enrichment_failed_reason is not null   then 'could_not_read'
                when c.contact_name is null                   then 'looked_none_published'
                else 'found' end as contact_name_state,
           (c.enrichment_failed_reason is not null)           as retry_worthwhile,
           (c.lane in ('green','amber') and not c.suppressed) as callable
      from public.contacts c
     where not c.suppressed
       and (p_lane is null or c.lane = p_lane)
       and (p_state is null or c.state = p_state)
       and (p_trade is null or c.trade = p_trade)
     order by (c.lane = 'green') desc, c.enriched_at desc nulls last, c.created_at desc
     limit least(coalesce(p_limit,200), 1000) offset coalesce(p_offset,0)
  ) s;
  return v;
end $$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public' and p.proname in ('sv_enrich_contact','sv_lead_book')
  loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('grant execute on function %s to anon, authenticated', f.sig);
  end loop;
end $$;;
