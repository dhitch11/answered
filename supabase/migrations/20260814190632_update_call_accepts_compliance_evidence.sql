-- 20260814190632_update_call_accepts_compliance_evidence
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- THE THIRD TIME THIS EXACT BUG HAS APPEARED TODAY: a value computed in one place and never
-- received in the other. answered_by was written by a webhook that never gets it. call_class was
-- computed at dial time and dropped by an RPC that did not read it. Now the compliance evidence.
-- The code producing it looks correct in every case; only the column stays empty.
--
-- Checking the RPC signature against the caller is now part of adding any field.
create or replace function public.sv_update_call(p_secret text, p_call_sid text, p_patch jsonb)
returns void language plpgsql security definer set search_path = public, private as $$
begin
  perform private.require(p_secret);

  insert into public.calls (call_sid, direction, status, placed, to_number, from_number, queued_at)
  values (p_call_sid, coalesce(p_patch->>'direction','outbound'), p_patch->>'status', true,
          p_patch->>'to_number', p_patch->>'from_number', now())
  on conflict (call_sid) do nothing;

  update public.calls set
    status            = coalesce(p_patch->>'status', status),
    answered_by       = coalesce(p_patch->>'answered_by', answered_by),
    conference_sid    = coalesce(p_patch->>'conference_sid', conference_sid),
    conference_name   = coalesce(p_patch->>'conference_name', conference_name),
    to_number         = coalesce(to_number, p_patch->>'to_number'),
    from_number       = coalesce(from_number, p_patch->>'from_number'),
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
    cost_usd          = coalesce((p_patch->>'cost_usd')::numeric, cost_usd),
    call_class        = coalesce(call_class, p_patch->>'call_class'),
    -- compliance evidence
    ai_speaking            = coalesce((p_patch->>'ai_speaking')::boolean, ai_speaking),
    ai_listening           = coalesce((p_patch->>'ai_listening')::boolean, ai_listening),
    disclosure_verified    = coalesce((p_patch->>'disclosure_verified')::boolean, disclosure_verified),
    disclosure_evidence    = coalesce(p_patch->'disclosure_evidence', disclosure_evidence),
    dnc_scrubbed_at_dial   = coalesce((p_patch->>'dnc_scrubbed_at_dial')::boolean, dnc_scrubbed_at_dial),
    dnc_procedures_at_dial = coalesce((p_patch->>'dnc_procedures_at_dial')::boolean, dnc_procedures_at_dial)
  where call_sid = p_call_sid;
end $$;

-- and the dial path writes them on creation
create or replace function public.sv_record_call(p_secret text, p_row jsonb)
returns uuid language plpgsql security definer set search_path = public, private as $$
declare v_id uuid;
begin
  perform private.require(p_secret);
  insert into public.calls (
    call_sid, conference_name, contact_id, campaign_id, line_id, direction,
    from_number, to_number, status, gate, operator, placed, refused_reason, call_class,
    ai_speaking, ai_listening, dnc_scrubbed_at_dial, dnc_procedures_at_dial, queued_at
  ) values (
    nullif(p_row->>'call_sid',''), p_row->>'conference_name',
    (p_row->>'contact_id')::uuid, (p_row->>'campaign_id')::uuid, (p_row->>'line_id')::uuid,
    coalesce(p_row->>'direction','outbound'),
    p_row->>'from_number', p_row->>'to_number', p_row->>'status',
    p_row->'gate', p_row->>'operator',
    coalesce((p_row->>'placed')::boolean,false), p_row->>'refused_reason', p_row->>'call_class',
    (p_row->>'ai_speaking')::boolean, (p_row->>'ai_listening')::boolean,
    (p_row->>'dnc_scrubbed_at_dial')::boolean, (p_row->>'dnc_procedures_at_dial')::boolean,
    now()
  )
  on conflict (call_sid) do update set
    status = excluded.status,
    call_class = coalesce(public.calls.call_class, excluded.call_class)
  returning id into v_id;

  if (p_row->>'contact_id') is not null and coalesce((p_row->>'placed')::boolean,false) then
    update public.contacts
       set call_count = call_count + 1, last_contacted_at = now(),
           first_contacted_at = coalesce(first_contacted_at, now()),
           disposition = case when disposition = 'new' then 'attempted' else disposition end
     where id = (p_row->>'contact_id')::uuid;
  end if;
  return v_id;
end $$;

revoke all on function public.sv_update_call(text, text, jsonb) from public;
revoke all on function public.sv_record_call(text, jsonb) from public;
grant execute on function public.sv_update_call(text, text, jsonb) to anon, authenticated;
grant execute on function public.sv_record_call(text, jsonb) to anon, authenticated;;
