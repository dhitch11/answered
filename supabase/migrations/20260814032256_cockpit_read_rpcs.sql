-- 20260814032256_cockpit_read_rpcs
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- Reads for the cockpit. Purpose-built, never a generic query passthrough: a generic reader is a
-- SQL injection surface wearing a JSON hat.

-- The live board: everything an operator needs to see in one round trip.
create or replace function public.sv_board(p_secret text)
returns jsonb language plpgsql stable security definer set search_path = public, private as $$
declare v jsonb;
begin
  perform private.require(p_secret);
  select jsonb_build_object(
    'at', now(),
    'live', coalesce((
      select jsonb_agg(x order by x->>'queued_at' desc) from (
        select jsonb_build_object(
          'call_sid', c.call_sid, 'status', c.status, 'to', c.to_number, 'from', c.from_number,
          'queued_at', c.queued_at, 'started_at', c.started_at, 'answered_at', c.answered_at,
          'answered_by', c.answered_by, 'conference_name', c.conference_name,
          'operator', c.operator, 'campaign_id', c.campaign_id,
          'contact', case when ct.id is null then null else jsonb_build_object(
            'id', ct.id, 'name', ct.name, 'trade', ct.trade, 'city', ct.city, 'state', ct.state,
            'line_type', ct.line_type, 'disposition', ct.disposition) end,
          'last_line', (select tl.text from public.transcript_lines tl
                         where tl.call_sid = c.call_sid order by tl.at desc limit 1)
        ) as x
        from public.calls c
        left join public.contacts ct on ct.id = c.contact_id
        where c.status in ('queued','initiated','ringing','in-progress')
          and c.created_at > now() - interval '2 hours'
      ) s), '[]'::jsonb),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id, 'phone', l.phone, 'label', l.label, 'purpose', l.purpose, 'status', l.status,
        'area_code', l.area_code, 'daily_cap', l.daily_cap, 'calls_today', l.calls_today,
        'calls_total', l.calls_total, 'reputation', l.reputation, 'rest_until', l.rest_until,
        'active_now', (select count(*) from public.calls c
                        where c.line_id = l.id and c.status in ('queued','initiated','ringing','in-progress'))
      ) order by l.purpose, l.phone) from public.lines l), '[]'::jsonb),
    'campaigns', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', k.id, 'name', k.name, 'mode', k.mode, 'status', k.status, 'autopilot', k.autopilot,
        'pacing_per_min', k.pacing_per_min, 'max_concurrent', k.max_concurrent,
        'halt_reason', k.halt_reason, 'started_at', k.started_at,
        'placed', (select count(*) from public.calls c where c.campaign_id = k.id and c.placed),
        'refused', (select count(*) from public.calls c where c.campaign_id = k.id and not c.placed),
        'reached', (select count(*) from public.calls c where c.campaign_id = k.id and c.answered_by = 'human'),
        'queue', (select count(*) from public.contacts ct
                   where ct.disposition in ('new','queued') and not ct.suppressed
                     and ct.lane in ('green','amber'))
      ) order by k.created_at desc) from public.campaigns k), '[]'::jsonb),
    'today', (
      select jsonb_build_object(
        'placed',  count(*) filter (where placed),
        'refused', count(*) filter (where not placed),
        'human',   count(*) filter (where answered_by = 'human'),
        'machine', count(*) filter (where answered_by like 'machine%'),
        'no_answer', count(*) filter (where status in ('no-answer','busy','failed')),
        'talk_seconds', coalesce(sum(duration_seconds) filter (where answered_by = 'human'),0)
      ) from public.calls where created_at > date_trunc('day', now() at time zone 'America/Los_Angeles')
    ),
    'funnel', (
      select jsonb_object_agg(disposition, n) from (
        select disposition, count(*) n from public.contacts group by 1) s
    ),
    'gate', (
      select jsonb_object_agg(coalesce(lane,'unclassified'), n) from (
        select lane, count(*) n from public.contacts group by 1) s
    )
  ) into v;
  return v;
end $$;

-- Contact list with filters. Every filter is a typed parameter, never interpolated text.
create or replace function public.sv_contacts(
  p_secret text, p_q text default null, p_lane text default null, p_disposition text default null,
  p_state text default null, p_trade text default null, p_line_type text default null,
  p_limit int default 100, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public, private as $$
declare v jsonb; total int;
begin
  perform private.require(p_secret);
  select count(*) into total from public.contacts c
   where (p_lane is null or c.lane = p_lane)
     and (p_disposition is null or c.disposition = p_disposition)
     and (p_state is null or c.state = p_state)
     and (p_trade is null or c.trade = p_trade)
     and (p_line_type is null or c.line_type = p_line_type)
     and (p_q is null or c.name ilike '%'||p_q||'%' or c.phone like '%'||p_q||'%' or c.city ilike '%'||p_q||'%');

  select jsonb_build_object('total', total, 'rows', coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb)) into v
  from (
    select c.id, c.phone, c.name, c.trade, c.state, c.city, c.line_type, c.carrier, c.lane,
           c.lane_reasons, c.disposition, c.tags, c.call_count, c.last_contacted_at, c.suppressed,
           c.website, c.score, c.owner
      from public.contacts c
     where (p_lane is null or c.lane = p_lane)
       and (p_disposition is null or c.disposition = p_disposition)
       and (p_state is null or c.state = p_state)
       and (p_trade is null or c.trade = p_trade)
       and (p_line_type is null or c.line_type = p_line_type)
       and (p_q is null or c.name ilike '%'||p_q||'%' or c.phone like '%'||p_q||'%' or c.city ilike '%'||p_q||'%')
     order by c.last_contacted_at desc nulls last, c.created_at desc
     limit least(coalesce(p_limit,100), 500) offset coalesce(p_offset,0)
  ) s;
  return v;
end $$;

-- One contact, everything about it.
create or replace function public.sv_contact(p_secret text, p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, private as $$
declare v jsonb;
begin
  perform private.require(p_secret);
  select jsonb_build_object(
    'contact', to_jsonb(c),
    'calls', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc)
                        from public.calls x where x.contact_id = c.id), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(to_jsonb(m) order by m.at desc)
                        from public.messages m where m.contact_id = c.id), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(to_jsonb(n) order by n.pinned desc, n.at desc)
                        from public.notes n where n.contact_id = c.id), '[]'::jsonb),
    'consent', coalesce((select jsonb_agg(to_jsonb(k) order by k.granted_at desc)
                        from public.consent k where k.phone = c.phone), '[]'::jsonb)
  ) into v from public.contacts c where c.id = p_id;
  return v;
end $$;

-- Transcript delta. The cockpit polls this with the last id it has.
create or replace function public.sv_transcript(p_secret text, p_call_sid text, p_since bigint default 0)
returns jsonb language plpgsql stable security definer set search_path = public, private as $$
declare v jsonb;
begin
  perform private.require(p_secret);
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb) into v
    from public.transcript_lines t
   where t.call_sid = p_call_sid and t.id > coalesce(p_since,0);
  return v;
end $$;

-- The next batch of numbers the dialler is allowed to try, newest gate state first.
create or replace function public.sv_next_batch(p_secret text, p_limit int default 25, p_lane text default null)
returns jsonb language plpgsql stable security definer set search_path = public, private as $$
declare v jsonb;
begin
  perform private.require(p_secret);
  select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) into v from (
    select c.id, c.phone, c.name, c.trade, c.state, c.city, c.line_type, c.lane, c.call_count
      from public.contacts c
     where not c.suppressed
       and c.disposition in ('new','queued')
       and c.lane = coalesce(p_lane, c.lane)
       and c.lane in ('green','amber')
       and c.call_count = 0
     order by c.lane desc, random()
     limit least(coalesce(p_limit,25), 200)
  ) s;
  return v;
end $$;

-- Recent calls for the history rail, with a filter set the operator actually uses.
create or replace function public.sv_calls(
  p_secret text, p_answered_by text default null, p_campaign uuid default null,
  p_disposition text default null, p_limit int default 100)
returns jsonb language plpgsql stable security definer set search_path = public, private as $$
declare v jsonb;
begin
  perform private.require(p_secret);
  select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) into v from (
    select c.id, c.call_sid, c.to_number, c.from_number, c.status, c.answered_by,
           c.ring_seconds, c.duration_seconds, c.created_at, c.answered_at, c.ended_at,
           c.recording_url, c.summary, c.sentiment, c.disposition, c.placed, c.refused_reason,
           c.operator, c.gate,
           ct.name as contact_name, ct.trade, ct.city, ct.state, ct.id as contact_id
      from public.calls c left join public.contacts ct on ct.id = c.contact_id
     where (p_answered_by is null or c.answered_by = p_answered_by)
       and (p_campaign is null or c.campaign_id = p_campaign)
       and (p_disposition is null or c.disposition = p_disposition)
     order by c.created_at desc
     limit least(coalesce(p_limit,100), 500)
  ) s;
  return v;
end $$;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'sv\_%'
  loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('grant execute on function %s to anon, authenticated', f.sig);
  end loop;
end $$;;
