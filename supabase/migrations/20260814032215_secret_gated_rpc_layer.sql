-- 20260814032215_secret_gated_rpc_layer
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- The access layer.
--
-- The Supabase service_role key is not reachable from the tooling that built this project, so
-- rather than block the whole build on a manual key paste, access runs as a capability: every
-- entry point is a security-definer function that takes a shared secret and verifies it against
-- a hash held in a table nothing can read. RLS still denies all direct table access, so the
-- publishable key on its own opens nothing at all.
--
-- The secret lives only in the Netlify environment and is sent only by server-side functions.
-- It never reaches a browser. Swapping this for a real service_role key later is a one-line
-- change in lib/db.mjs and nothing else.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.app_secret (
  id          int primary key default 1,
  secret_hash text not null,
  rotated_at  timestamptz not null default now(),
  constraint one_row check (id = 1)
);

create or replace function private.auth_ok(p_secret text) returns boolean
language sql stable security definer set search_path = private, public, extensions as $$
  select exists (
    select 1 from private.app_secret
     where secret_hash = encode(digest(coalesce(p_secret,''), 'sha256'), 'hex')
  );
$$;

create or replace function private.require(p_secret text) returns void
language plpgsql stable security definer set search_path = private as $$
begin
  if not private.auth_ok(p_secret) then
    raise exception 'unauthorized' using errcode = '28000';
  end if;
end $$;

-- ── WRITES ───────────────────────────────────────────────────────────────────────────────────

create or replace function public.sv_upsert_contacts(p_secret text, p_rows jsonb)
returns int language plpgsql security definer set search_path = public, private as $$
declare n int;
begin
  perform private.require(p_secret);
  with incoming as (
    select * from jsonb_to_recordset(p_rows) as x(
      phone text, name text, trade text, state text, city text, street text, website text,
      lat numeric, lon numeric, source text, source_id text,
      line_type text, carrier text, lookup_ok boolean, lane text, lane_reasons text[]
    )
  ), ins as (
    insert into public.contacts (phone,name,trade,state,city,street,website,lat,lon,source,source_id,
                                 line_type,carrier,lookup_ok,lookup_at,lane,lane_reasons)
    select phone,name,trade,state,city,street,website,lat,lon,source,source_id,
           line_type,carrier,lookup_ok,
           case when line_type is not null then now() end,
           lane,lane_reasons
      from incoming
      where phone is not null
    on conflict (phone) do update set
      name        = coalesce(excluded.name, public.contacts.name),
      trade       = coalesce(excluded.trade, public.contacts.trade),
      state       = coalesce(excluded.state, public.contacts.state),
      city        = coalesce(excluded.city, public.contacts.city),
      street      = coalesce(excluded.street, public.contacts.street),
      website     = coalesce(excluded.website, public.contacts.website),
      lat         = coalesce(excluded.lat, public.contacts.lat),
      lon         = coalesce(excluded.lon, public.contacts.lon),
      line_type   = coalesce(excluded.line_type, public.contacts.line_type),
      carrier     = coalesce(excluded.carrier, public.contacts.carrier),
      lookup_ok   = coalesce(excluded.lookup_ok, public.contacts.lookup_ok),
      lookup_at   = coalesce(excluded.lookup_at, public.contacts.lookup_at),
      lane        = coalesce(excluded.lane, public.contacts.lane),
      lane_reasons= coalesce(excluded.lane_reasons, public.contacts.lane_reasons),
      updated_at  = now()
    returning 1
  ) select count(*) into n from ins;
  return n;
end $$;

create or replace function public.sv_record_call(p_secret text, p_row jsonb)
returns uuid language plpgsql security definer set search_path = public, private as $$
declare v_id uuid;
begin
  perform private.require(p_secret);
  insert into public.calls (
    call_sid, conference_name, contact_id, campaign_id, line_id, direction,
    from_number, to_number, status, gate, operator, placed, refused_reason, queued_at
  ) values (
    nullif(p_row->>'call_sid',''), p_row->>'conference_name',
    (p_row->>'contact_id')::uuid, (p_row->>'campaign_id')::uuid, (p_row->>'line_id')::uuid,
    coalesce(p_row->>'direction','outbound'),
    p_row->>'from_number', p_row->>'to_number', p_row->>'status',
    p_row->'gate', p_row->>'operator',
    coalesce((p_row->>'placed')::boolean,false), p_row->>'refused_reason', now()
  )
  on conflict (call_sid) do update set status = excluded.status
  returning id into v_id;

  if (p_row->>'contact_id') is not null and coalesce((p_row->>'placed')::boolean,false) then
    update public.contacts
       set call_count = call_count + 1,
           last_contacted_at = now(),
           first_contacted_at = coalesce(first_contacted_at, now()),
           disposition = case when disposition = 'new' then 'attempted' else disposition end
     where id = (p_row->>'contact_id')::uuid;
  end if;
  return v_id;
end $$;

create or replace function public.sv_update_call(p_secret text, p_call_sid text, p_patch jsonb)
returns void language plpgsql security definer set search_path = public, private as $$
begin
  perform private.require(p_secret);
  update public.calls set
    status            = coalesce(p_patch->>'status', status),
    answered_by       = coalesce(p_patch->>'answered_by', answered_by),
    conference_sid    = coalesce(p_patch->>'conference_sid', conference_sid),
    ring_seconds      = coalesce((p_patch->>'ring_seconds')::numeric, ring_seconds),
    duration_seconds  = coalesce((p_patch->>'duration_seconds')::int, duration_seconds),
    started_at        = coalesce((p_patch->>'started_at')::timestamptz, started_at),
    answered_at       = coalesce((p_patch->>'answered_at')::timestamptz, answered_at),
    ended_at          = coalesce((p_patch->>'ended_at')::timestamptz, ended_at),
    recording_sid     = coalesce(p_patch->>'recording_sid', recording_sid),
    recording_url     = coalesce(p_patch->>'recording_url', recording_url),
    recording_seconds = coalesce((p_patch->>'recording_seconds')::int, recording_seconds),
    transcript        = coalesce(p_patch->>'transcript', transcript),
    summary           = coalesce(p_patch->>'summary', summary),
    sentiment         = coalesce(p_patch->>'sentiment', sentiment),
    ai_notes          = coalesce(p_patch->'ai_notes', ai_notes),
    disposition       = coalesce(p_patch->>'disposition', disposition),
    outcome           = coalesce(p_patch->'outcome', outcome),
    cost_usd          = coalesce((p_patch->>'cost_usd')::numeric, cost_usd)
  where call_sid = p_call_sid;
end $$;

create or replace function public.sv_add_transcript(p_secret text, p_call_sid text, p_rows jsonb)
returns int language plpgsql security definer set search_path = public, private as $$
declare n int;
begin
  perform private.require(p_secret);
  with incoming as (
    select * from jsonb_to_recordset(p_rows) as x(
      seq int, track text, speaker text, text text, confidence numeric, is_final boolean
    )
  ), ins as (
    insert into public.transcript_lines (call_sid, seq, track, speaker, text, confidence, is_final)
    select p_call_sid, coalesce(seq,0), track, speaker, text, confidence, coalesce(is_final,false)
      from incoming where text is not null and text <> ''
    on conflict (call_sid, seq, track) do update set
      text = excluded.text, confidence = excluded.confidence,
      is_final = excluded.is_final, at = now()
    returning 1
  ) select count(*) into n from ins;
  return n;
end $$;

create or replace function public.sv_add_event(p_secret text, p_call_sid text, p_kind text, p_payload jsonb)
returns void language plpgsql security definer set search_path = public, private as $$
begin
  perform private.require(p_secret);
  insert into public.call_events (call_sid, kind, payload) values (p_call_sid, p_kind, p_payload);
end $$;

create or replace function public.sv_suppress(p_secret text, p_phone text, p_reason text, p_source text)
returns void language plpgsql security definer set search_path = public, private as $$
begin
  perform private.require(p_secret);
  insert into public.suppression (phone, reason, source) values (p_phone, p_reason, p_source)
  on conflict (phone) do nothing;
end $$;

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
      purpose = excluded.purpose, status = excluded.status,
      daily_cap = excluded.daily_cap, notes = coalesce(excluded.notes, public.lines.notes)
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
      name = excluded.name, mode = excluded.mode, status = excluded.status,
      autopilot = excluded.autopilot, pacing_per_min = excluded.pacing_per_min,
      max_concurrent = excluded.max_concurrent, policy = excluded.policy,
      script = excluded.script, line_ids = excluded.line_ids
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

-- ── LOCK DOWN ────────────────────────────────────────────────────────────────────────────────
-- Everything is revoked from public first, then execute is granted only for the entry points.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'sv\_%'
  loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('grant execute on function %s to anon, authenticated', f.sig);
  end loop;
end $$;

revoke all on function private.auth_ok(text) from public, anon, authenticated;
revoke all on function private.require(text) from public, anon, authenticated;;
