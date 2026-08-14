-- 20260814191833_contacts_crm_enrichment_fields
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- Full lead depth on contacts, per David 2026-08-14: website, contractor name, business name,
-- location, phone, LinkedIn, and anything else we can honestly find.
--
-- ★ THE DISTINCTION THAT MATTERS MORE THAN THE FIELDS: `enriched_at IS NULL` means nobody has
-- looked. `enriched_at` set with `contact_name` null means we DID look and this contractor does not
-- publish one. Those are two different empties and a console that renders them the same way is
-- lying in one of the two cases. `enrichment_sources` records every source consulted INCLUDING the
-- ones that returned nothing, so "we tried" is provable rather than asserted.

alter table public.contacts add column if not exists contact_name text;
alter table public.contacts add column if not exists contact_role text
  check (contact_role is null or contact_role in ('owner','manager','dispatcher','unknown'));
alter table public.contacts add column if not exists email text;
alter table public.contacts add column if not exists email_source text;
alter table public.contacts add column if not exists linkedin_url text;
alter table public.contacts add column if not exists enriched_at timestamptz;
alter table public.contacts add column if not exists enrichment_sources text[] default '{}';

comment on column public.contacts.contact_name is
  'The HUMAN who answers, not the business. Null with enriched_at set means we looked and they do not publish one.';
comment on column public.contacts.enriched_at is
  'Null = never attempted. Set = attempted, whatever the outcome. This is the field that separates "not looked at" from "looked and found nothing", and a console must render those differently.';
comment on column public.contacts.enrichment_sources is
  'Every source consulted, including those that returned nothing, so an absence is evidenced rather than claimed.';

create index if not exists contacts_unenriched on public.contacts (created_at)
  where enriched_at is null and website is not null;
create index if not exists contacts_callable_crm on public.contacts (lane, disposition)
  where not suppressed;

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
    -- set WHATEVER the outcome, so "we looked" is recorded even when nothing was found
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

-- What the console needs: the callable book with every lead field, one query.
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
           c.email, c.linkedin_url, c.website, c.trade, c.city, c.state, c.street,
           c.line_type, c.carrier, c.lane, c.lane_reasons, c.disposition, c.tags, c.score,
           c.call_count, c.last_contacted_at, c.lat, c.lon,
           c.enriched_at, c.enrichment_sources,
           -- so a console never has to guess which empty it is looking at
           case when c.enriched_at is null then 'never_looked'
                when c.contact_name is null then 'looked_none_published'
                else 'found' end as contact_name_state,
           -- the one-click call button only lights when the gate would actually allow it
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
