-- 20260814194044_hold_rpcs
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- HOLD RPCs. Two doors, deliberately different credentials, same split the ledger and truce use:
--   sv_hold_*  the estate secret. Everything the runtime and the operator do.
--   hd_view    the session's own token. Everything the customer may see about THEIR session, and
--              nothing about anyone else's. It can only ever reach the row the token names.

-- ── create ───────────────────────────────────────────────────────────────────────────────────
create or replace function public.sv_hold_create(p_secret text, p_row jsonb)
returns jsonb language plpgsql security definer set search_path to 'public','private' as $$
declare v public.hold_sessions;
begin
  perform private.require(p_secret);
  if coalesce(p_row->>'token','') = '' or length(p_row->>'token') < 32 then
    return jsonb_build_object('error','a hold session needs a token of at least 32 characters');
  end if;

  insert into public.hold_sessions (
    token, account_key, requester_phone, requester_email, requester_name, requester_state,
    target_phone, target_label, target_state, reason, reference,
    line_class, line_class_source, line_type, lookup_ok, tree_plan, status, gate, consent_id
  ) values (
    p_row->>'token', p_row->>'account_key', p_row->>'requester_phone', p_row->>'requester_email',
    p_row->>'requester_name', p_row->>'requester_state',
    p_row->>'target_phone', p_row->>'target_label', p_row->>'target_state',
    p_row->>'reason', p_row->>'reference',
    coalesce(p_row->>'line_class','commercial'),
    coalesce(p_row->>'line_class_source','default_commercial'),
    p_row->>'line_type', (p_row->>'lookup_ok')::boolean,
    coalesce(p_row->'tree_plan','[]'::jsonb),
    coalesce(p_row->>'status','queued'),
    p_row->'gate', (p_row->>'consent_id')::uuid
  ) returning * into v;

  insert into public.hold_events (session_id, kind, payload)
  values (v.id, 'session_created', jsonb_build_object(
    'target_label', v.target_label, 'line_class', v.line_class,
    'line_class_source', v.line_class_source, 'status', v.status));

  return to_jsonb(v);
end $$;

-- ── patch ────────────────────────────────────────────────────────────────────────────────────
-- ★ THE IDENTITY COLUMNS ARE STRIPPED BEFORE THE MERGE, NOT CHECKED AFTER IT. A patch that could
-- rewrite `token` would let any caller re-point somebody else's capability link at their own
-- session, and a patch that could rewrite `id` would silently orphan every event row.
create or replace function public.sv_hold_update(p_secret text, p_id uuid, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path to 'public','private' as $$
declare v public.hold_sessions; merged jsonb; clean jsonb;
begin
  perform private.require(p_secret);
  select * into v from public.hold_sessions where id = p_id;
  if not found then return jsonb_build_object('error','unknown hold session'); end if;

  clean := coalesce(p_patch,'{}'::jsonb) - 'id' - 'token' - 'created_at' - 'queued_at';
  merged := to_jsonb(v) || clean;
  v := jsonb_populate_record(v, merged);
  update public.hold_sessions set
    account_key = v.account_key, requester_email = v.requester_email, requester_name = v.requester_name,
    requester_state = v.requester_state, target_label = v.target_label, target_state = v.target_state,
    reason = v.reason, reference = v.reference,
    line_class = v.line_class, line_class_source = v.line_class_source,
    line_type = v.line_type, lookup_ok = v.lookup_ok,
    tree_plan = v.tree_plan, digits_sent = v.digits_sent, menu_depth = v.menu_depth, attempts = v.attempts,
    status = v.status, outcome = v.outcome, outcome_reason = v.outcome_reason,
    call_sid = v.call_sid, bridge_call_sid = v.bridge_call_sid, conference_name = v.conference_name,
    gate = v.gate, consent_id = v.consent_id, detector = v.detector,
    dialed_at = v.dialed_at, answered_at = v.answered_at, hold_started_at = v.hold_started_at,
    human_at = v.human_at, announced_at = v.announced_at, bridged_at = v.bridged_at, ended_at = v.ended_at,
    machine_wait_ms = v.machine_wait_ms, user_wait_ms = v.user_wait_ms,
    charge_kind = v.charge_kind, charge_cents = v.charge_cents, charge_gross_cents = v.charge_gross_cents,
    charge_reason = v.charge_reason, bill_event_id = v.bill_event_id,
    recording_sid = v.recording_sid, recording_url = v.recording_url, recording_seconds = v.recording_seconds,
    operator_note = v.operator_note
  where id = p_id
  returning * into v;
  return to_jsonb(v);
end $$;

-- ── event ────────────────────────────────────────────────────────────────────────────────────
create or replace function public.sv_hold_event(p_secret text, p_id uuid, p_kind text, p_payload jsonb)
returns bigint language plpgsql security definer set search_path to 'public','private' as $$
declare v bigint;
begin
  perform private.require(p_secret);
  insert into public.hold_events (session_id, kind, payload)
  values (p_id, p_kind, coalesce(p_payload,'{}'::jsonb)) returning id into v;
  return v;
end $$;

-- ── reads ────────────────────────────────────────────────────────────────────────────────────
create or replace function public.sv_hold_get(p_secret text, p_id uuid, p_events int default 200)
returns jsonb language plpgsql stable security definer set search_path to 'public','private' as $$
declare v public.hold_sessions;
begin
  perform private.require(p_secret);
  select * into v from public.hold_sessions where id = p_id;
  if not found then return jsonb_build_object('error','unknown hold session'); end if;
  return jsonb_build_object('session', to_jsonb(v), 'events', coalesce((
    select jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at, 'kind', e.kind, 'payload', e.payload) order by e.id)
    from (select * from public.hold_events where session_id = v.id order by id desc limit p_events) e
  ), '[]'::jsonb));
end $$;

-- The runtime webhooks know a CallSid and nothing else, so this is the only way in from Twilio.
create or replace function public.sv_hold_by_call(p_secret text, p_call_sid text)
returns jsonb language plpgsql stable security definer set search_path to 'public','private' as $$
declare v public.hold_sessions;
begin
  perform private.require(p_secret);
  select * into v from public.hold_sessions
   where call_sid = p_call_sid or bridge_call_sid = p_call_sid
   order by created_at desc limit 1;
  if not found then return jsonb_build_object('error','no hold session for that call'); end if;
  return jsonb_build_object('session', to_jsonb(v),
    'leg', case when v.bridge_call_sid = p_call_sid then 'user' else 'target' end);
end $$;

create or replace function public.sv_hold_list(p_secret text, p_status text default null, p_limit int default 50)
returns jsonb language plpgsql stable security definer set search_path to 'public','private' as $$
begin
  perform private.require(p_secret);
  return coalesce((
    select jsonb_agg(to_jsonb(s) order by s.created_at desc) from (
      select * from public.hold_sessions
       where (p_status is null or status = p_status)
       order by created_at desc limit greatest(1, least(coalesce(p_limit,50), 200))
    ) s), '[]'::jsonb);
end $$;

-- ── the customer's own door ──────────────────────────────────────────────────────────────────
-- ★ THIS RETURNS A DELIBERATELY NARROWER OBJECT THAN sv_hold_get, and the narrowing is the point.
-- No gate verdict, no consent id, no account key, no operator note, and the requester's own
-- number is reduced to its last four digits: a capability link can be forwarded, pasted into a
-- support thread or left open on a shared screen, and none of those should hand over a phone
-- number. What it DOES return is everything the receipt prints, because that is the artifact the
-- customer was promised.
create or replace function public.hd_view(p_token text)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare v public.hold_sessions;
begin
  if p_token is null or length(p_token) < 32 then return jsonb_build_object('error','that link is not valid'); end if;
  select * into v from public.hold_sessions where token = p_token;
  if not found then return jsonb_build_object('error','unknown link'); end if;

  return jsonb_build_object(
    'session', jsonb_build_object(
      'id', v.id, 'created_at', v.created_at, 'status', v.status,
      'outcome', v.outcome, 'outcome_reason', v.outcome_reason,
      'target_label', v.target_label, 'target_phone', v.target_phone,
      'reason', v.reason, 'reference', case when v.reference is null then null else 'on file' end,
      'requester_last4', right(v.requester_phone, 4),
      'line_class', v.line_class, 'line_class_source', v.line_class_source,
      'menu_depth', v.menu_depth, 'attempts', v.attempts, 'digits_sent', v.digits_sent,
      'queued_at', v.queued_at, 'dialed_at', v.dialed_at, 'answered_at', v.answered_at,
      'hold_started_at', v.hold_started_at, 'human_at', v.human_at,
      'announced_at', v.announced_at, 'bridged_at', v.bridged_at, 'ended_at', v.ended_at,
      'machine_wait_ms', v.machine_wait_ms, 'user_wait_ms', v.user_wait_ms,
      'charge_kind', v.charge_kind, 'charge_cents', v.charge_cents,
      'charge_gross_cents', v.charge_gross_cents, 'charge_reason', v.charge_reason,
      'recording_seconds', v.recording_seconds,
      'has_recording', v.recording_sid is not null),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('at', e.at, 'kind', e.kind, 'payload', e.payload) order by e.id)
      from public.hold_events e where e.session_id = v.id
        and e.kind not in ('gate_verdict','operator_note','detector_debug')), '[]'::jsonb));
end $$;

revoke all on function public.sv_hold_create(text,jsonb)        from anon, authenticated;
revoke all on function public.sv_hold_update(text,uuid,jsonb)   from anon, authenticated;
revoke all on function public.sv_hold_event(text,uuid,text,jsonb) from anon, authenticated;
revoke all on function public.sv_hold_get(text,uuid,int)        from anon, authenticated;
revoke all on function public.sv_hold_by_call(text,text)        from anon, authenticated;
revoke all on function public.sv_hold_list(text,text,int)       from anon, authenticated;
grant execute on function public.hd_view(text) to anon, authenticated;;
