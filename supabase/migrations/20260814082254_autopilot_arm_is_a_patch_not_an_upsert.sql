-- 20260814082254_autopilot_arm_is_a_patch_not_an_upsert
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- ★ Arming a campaign went through the same upsert as creating one, and that upsert's ON CONFLICT
-- set policy, script and line_ids straight from the incoming row with no coalesce. The console's
-- Arm button sends none of those fields, so they defaulted to '{}' and arming a campaign WIPED its
-- calling policy and its disclosure script. It also set status unconditionally, which silently
-- resurrected a campaign the safety checks had halted.
--
-- Arming is now its own narrow operation. It touches two columns, and it refuses to un-halt.

create or replace function public.sv_set_autopilot(p_secret text, p_id uuid, p_on boolean, p_resume boolean default false)
returns jsonb language plpgsql security definer set search_path = public, private as $$
declare cur public.campaigns; 
begin
  perform private.require(p_secret);
  select * into cur from public.campaigns where id = p_id;
  if not found then return jsonb_build_object('refused', 'no such campaign'); end if;

  if cur.status = 'halted' and p_on and not p_resume then
    return jsonb_build_object('refused',
      'this campaign halted itself: ' || coalesce(cur.halt_reason, 'no reason recorded') ||
      '  Read that before resuming, then resume deliberately.');
  end if;

  update public.campaigns
     set autopilot = p_on,
         status = case when p_on then 'running' else 'paused' end,
         halt_reason = case when p_on and p_resume then null else halt_reason end,
         started_at = case when p_on and started_at is null then now() else started_at end
   where id = p_id;

  return (select to_jsonb(c) from public.campaigns c where c.id = p_id);
end $$;

-- And the generic upsert stops being able to blank a live campaign's configuration.
create or replace function public.sv_exec(p_secret text, p_table text, p_row jsonb)
returns jsonb language plpgsql security definer set search_path = public, private as $$
declare v jsonb;
begin
  perform private.require(p_secret);
  if p_table = 'lines' then
    insert into public.lines (phone, twilio_sid, label, purpose, status, area_code, daily_cap, notes)
    values (p_row->>'phone', p_row->>'twilio_sid', p_row->>'label',
            coalesce(p_row->>'purpose','research'), coalesce(p_row->>'status','active'),
            p_row->>'area_code', coalesce((p_row->>'daily_cap')::int, 80), p_row->>'notes')
    on conflict (phone) do update set
      label = coalesce(excluded.label, public.lines.label),
      purpose = coalesce(excluded.purpose, public.lines.purpose),
      -- a quarantined line is never reactivated as a side effect of an unrelated edit
      status = case when public.lines.status = 'quarantined' and coalesce(p_row->>'unquarantine','') <> 'true'
                    then public.lines.status else excluded.status end,
      daily_cap = coalesce(excluded.daily_cap, public.lines.daily_cap),
      notes = coalesce(excluded.notes, public.lines.notes)
    returning to_jsonb(public.lines.*) into v;
  elsif p_table = 'campaigns' then
    insert into public.campaigns (id, name, mode, status, autopilot, pacing_per_min, max_concurrent, policy, script, line_ids)
    values (coalesce((p_row->>'id')::uuid, gen_random_uuid()), p_row->>'name',
            coalesce(p_row->>'mode','discovery'), coalesce(p_row->>'status','draft'),
            coalesce((p_row->>'autopilot')::boolean,false),
            coalesce((p_row->>'pacing_per_min')::int,4), coalesce((p_row->>'max_concurrent')::int,3),
            coalesce(p_row->'policy','{}'::jsonb), coalesce(p_row->'script','{}'::jsonb),
            coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p_row->'line_ids','[]'::jsonb)) x), '{}'))
    on conflict (id) do update set
      -- EVERY field coalesces against what is already there. A partial patch can no longer blank
      -- a policy or a script by not mentioning it.
      name           = coalesce(nullif(p_row->>'name',''), public.campaigns.name),
      mode           = coalesce(p_row->>'mode', public.campaigns.mode),
      status         = coalesce(p_row->>'status', public.campaigns.status),
      autopilot      = coalesce((p_row->>'autopilot')::boolean, public.campaigns.autopilot),
      pacing_per_min = coalesce((p_row->>'pacing_per_min')::int, public.campaigns.pacing_per_min),
      max_concurrent = coalesce((p_row->>'max_concurrent')::int, public.campaigns.max_concurrent),
      policy         = coalesce(p_row->'policy', public.campaigns.policy),
      script         = coalesce(p_row->'script', public.campaigns.script),
      line_ids       = coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p_row->'line_ids') x), public.campaigns.line_ids)
    returning to_jsonb(public.campaigns.*) into v;
  elsif p_table = 'notes' then
    insert into public.notes (contact_id, call_sid, body, author, pinned)
    values ((p_row->>'contact_id')::uuid, p_row->>'call_sid', p_row->>'body',
            p_row->>'author', coalesce((p_row->>'pinned')::boolean,false))
    returning to_jsonb(public.notes.*) into v;
  elsif p_table = 'messages' then
    insert into public.messages (message_sid, contact_id, line_id, direction, from_number, to_number, body, status, operator)
    values (p_row->>'message_sid', (p_row->>'contact_id')::uuid, (p_row->>'line_id')::uuid,
            coalesce(p_row->>'direction','outbound'), p_row->>'from_number', p_row->>'to_number',
            p_row->>'body', p_row->>'status', p_row->>'operator')
    on conflict (message_sid) do update set status = excluded.status
    returning to_jsonb(public.messages.*) into v;
  elsif p_table = 'consent' then
    insert into public.consent (phone, scope, written, source, evidence, ip, user_agent, expires_at)
    values (p_row->>'phone', coalesce(p_row->>'scope','research_call'),
            coalesce((p_row->>'written')::boolean,false), p_row->>'source',
            p_row->'evidence', (p_row->>'ip')::inet, p_row->>'user_agent',
            (p_row->>'expires_at')::timestamptz)
    returning to_jsonb(public.consent.*) into v;
  elsif p_table = 'contact_patch' then
    update public.contacts set
      disposition = coalesce(p_row->>'disposition', disposition),
      owner       = coalesce(p_row->>'owner', owner),
      score       = coalesce((p_row->>'score')::int, score),
      tags        = coalesce((select array_agg(x) from jsonb_array_elements_text(p_row->'tags') x), tags),
      updated_at  = now()
    where id = (p_row->>'id')::uuid
    returning to_jsonb(public.contacts.*) into v;
  else
    raise exception 'unknown target %', p_table;
  end if;
  return v;
end $$;

-- ★ A number on the suppression list must never re-enter the queue, even if a later corpus
-- re-ingest inserts a fresh contact row for it. The claim and batch selectors now consult the
-- suppression table itself, not just the denormalised flag on the contact.
create or replace function public.sv_claim(p_secret text, p_campaign uuid, p_limit int)
returns jsonb language plpgsql security definer set search_path = public, private as $$
declare v jsonb;
begin
  perform private.require(p_secret);
  with picked as (
    select c.id from public.contacts c
     where not c.suppressed
       and not exists (select 1 from public.suppression s where s.phone = c.phone)
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

create or replace function public.sv_next_batch(p_secret text, p_limit int default 25, p_lane text default null)
returns jsonb language plpgsql stable security definer set search_path = public, private as $$
declare v jsonb;
begin
  perform private.require(p_secret);
  select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) into v from (
    select c.id, c.phone, c.name, c.trade, c.state, c.city, c.line_type, c.lane, c.call_count
      from public.contacts c
     where not c.suppressed
       and not exists (select 1 from public.suppression sp where sp.phone = c.phone)
       and c.disposition in ('new','queued')
       and c.lane = coalesce(p_lane, c.lane)
       and c.lane in ('green','amber')
       and c.call_count = 0
     order by c.lane desc, random()
     limit least(coalesce(p_limit,25), 200)
  ) s;
  return v;
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
