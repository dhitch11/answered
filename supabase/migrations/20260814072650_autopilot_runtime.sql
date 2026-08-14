-- 20260814072650_autopilot_runtime
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- Autopilot needs to answer four questions every minute, cheaply, and one of them is
-- "should I stop". A dialler that can only be stopped by a human watching it is not safe to
-- leave running, so the halt conditions are computed here and the runner obeys them.

create or replace function public.sv_autopilot_state(p_secret text)
returns jsonb language plpgsql stable security definer set search_path = public, private as $$
declare v jsonb;
begin
  perform private.require(p_secret);
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v from (
    select jsonb_build_object(
      'id', k.id, 'name', k.name, 'mode', k.mode, 'status', k.status,
      'autopilot', k.autopilot, 'pacing_per_min', k.pacing_per_min,
      'max_concurrent', k.max_concurrent, 'policy', k.policy,
      'in_flight', (select count(*) from public.calls c
                     where c.campaign_id = k.id
                       and c.status in ('queued','initiated','ringing','in-progress')
                       and c.created_at > now() - interval '30 minutes'),
      'placed_today', (select count(*) from public.calls c
                        where c.campaign_id = k.id and c.placed
                          and c.created_at > date_trunc('day', now() at time zone 'America/Los_Angeles')),
      -- the last fifty attempts decide whether this campaign is still healthy
      'recent', (
        select jsonb_build_object(
          'attempts', count(*),
          'refused', count(*) filter (where not placed),
          'reached', count(*) filter (where answered_by = 'human'),
          'stopped', count(*) filter (where disposition = 'do_not_call')
        )
        from (select * from public.calls c where c.campaign_id = k.id
               order by c.created_at desc limit 50) r
      )
    ) as x
    from public.campaigns k
    where k.autopilot = true and k.status = 'running'
  ) s;
  return v;
end $$;

create or replace function public.sv_halt(p_secret text, p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, private as $$
begin
  perform private.require(p_secret);
  update public.campaigns
     set autopilot = false, status = 'halted', halt_reason = p_reason, ended_at = now()
   where id = p_id;
end $$;

create or replace function public.sv_claim(p_secret text, p_campaign uuid, p_limit int)
returns jsonb language plpgsql security definer set search_path = public, private as $$
declare v jsonb;
begin
  perform private.require(p_secret);
  -- Claim by flipping disposition to 'queued' inside the same statement that selects, so two
  -- overlapping runner invocations can never hand the same shop to two different calls.
  with picked as (
    select c.id from public.contacts c
     where not c.suppressed
       and c.disposition = 'new'
       and c.lane in ('green','amber')
       and c.call_count = 0
     order by random()
     limit least(coalesce(p_limit,5), 50)
     for update skip locked
  ), claimed as (
    update public.contacts c set disposition = 'queued', updated_at = now()
      from picked p where c.id = p.id
    returning c.id, c.phone, c.name, c.trade, c.state, c.city, c.line_type, c.lookup_ok, c.lane
  )
  select coalesce(jsonb_agg(to_jsonb(claimed)), '[]'::jsonb) into v from claimed;
  return v;
end $$;

create or replace function public.sv_release(p_secret text, p_id uuid)
returns void language plpgsql security definer set search_path = public, private as $$
begin
  perform private.require(p_secret);
  update public.contacts set disposition = 'new', updated_at = now()
   where id = p_id and disposition = 'queued';
end $$;

create or replace function public.sv_bump_line(p_secret text, p_line uuid)
returns void language plpgsql security definer set search_path = public, private as $$
begin
  perform private.require(p_secret);
  update public.lines
     set calls_today = calls_today + 1, calls_total = calls_total + 1
   where id = p_line;
end $$;

-- Reset the per-line daily counters. Called by the runner when the local day rolls over.
create or replace function public.sv_roll_day(p_secret text)
returns int language plpgsql security definer set search_path = public, private as $$
declare n int;
begin
  perform private.require(p_secret);
  update public.lines set calls_today = 0 where calls_today > 0;
  get diagnostics n = row_count;
  return n;
end $$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'sv\_%'
  loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('grant execute on function %s to anon, authenticated', f.sig);
  end loop;
end $$;;
