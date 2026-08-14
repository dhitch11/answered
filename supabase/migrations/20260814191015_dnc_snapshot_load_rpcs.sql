-- 20260814191015_dnc_snapshot_load_rpcs
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- Loading a registry download. Three calls so a partial load can never be mistaken for a complete
-- one: the snapshot row is only finished, and therefore only counted as fresh by the gate, after
-- every number is in.
create or replace function public.sv_dnc_begin_snapshot(p_secret text, p_san text, p_source text default 'national_dnc')
returns jsonb language plpgsql security definer set search_path = public, private as $$
declare v uuid;
begin
  perform private.require(p_secret);
  -- downloaded_at is set far in the past until the load completes, so an interrupted ingest leaves
  -- a snapshot the freshness check will never accept.
  insert into public.dnc_snapshots (source, san, downloaded_at, notes)
  values (coalesce(p_source,'national_dnc'), p_san, now() - interval '100 years', 'loading')
  returning id into v;
  return jsonb_build_object('snapshot_id', v);
end $$;

create or replace function public.sv_dnc_load(p_secret text, p_snapshot uuid, p_numbers text[])
returns int language plpgsql security definer set search_path = public, private as $$
declare n int;
begin
  perform private.require(p_secret);
  insert into public.dnc_registry (phone, snapshot_id)
  select unnest(p_numbers), p_snapshot
  on conflict (phone) do update set snapshot_id = excluded.snapshot_id;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.sv_dnc_finish_snapshot(p_secret text, p_snapshot uuid, p_numbers bigint, p_area_codes text[])
returns jsonb language plpgsql security definer set search_path = public, private as $$
begin
  perform private.require(p_secret);
  if p_numbers <= 0 then
    return jsonb_build_object('error','refusing to mark an empty snapshot as complete');
  end if;
  update public.dnc_snapshots
     set downloaded_at = now(), numbers = p_numbers, area_codes = coalesce(p_area_codes,'{}'), notes = 'complete'
   where id = p_snapshot;
  -- retire the numbers belonging to older snapshots for the same area codes
  delete from public.dnc_registry r
   where r.snapshot_id <> p_snapshot and r.area_code = any(coalesce(p_area_codes,'{}'));
  return jsonb_build_object('ok', true);
end $$;

-- The scrub itself: is THIS number on the registry, per the current fresh snapshot.
create or replace function public.sv_dnc_listed(p_secret text, p_phone text)
returns boolean language plpgsql stable security definer set search_path = public, private as $$
declare fresh uuid;
begin
  perform private.require(p_secret);
  select id into fresh from public.dnc_snapshots
   where notes = 'complete' and downloaded_at > now() - interval '31 days'
   order by downloaded_at desc limit 1;
  if fresh is null then return null; end if;   -- null means "cannot answer", never "not listed"
  return exists (select 1 from public.dnc_registry where phone = p_phone and snapshot_id = fresh);
end $$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname='public' and p.proname like 'sv\_dnc%'
  loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('grant execute on function %s to anon, authenticated', f.sig);
  end loop;
end $$;;
