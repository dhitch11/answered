-- 20260814073211_status_callbacks_upsert
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- MEASURED on the first real end-to-end call: sv_update_call did nothing at all, because the
-- call row did not exist. Twilio fired six status callbacks, the transcription webhook wrote 73
-- utterances, and none of it attached to a call because the row was never created.
--
-- That is not only a smoke-test artefact. Any call this system did not itself originate - an
-- inbound call to a pooled number, a call placed from the Twilio console, a leg added to a
-- conference - produces exactly the same silent hole. A telemetry layer that drops what it did
-- not expect is how you end up trusting an empty chart.
--
-- So the status writer now upserts. A call we have never seen creates its row from the callback.

create or replace function public.sv_update_call(p_secret text, p_call_sid text, p_patch jsonb)
returns void language plpgsql security definer set search_path = public, private as $$
begin
  perform private.require(p_secret);

  insert into public.calls (call_sid, direction, status, placed, to_number, from_number, queued_at)
  values (
    p_call_sid,
    coalesce(p_patch->>'direction', 'outbound'),
    p_patch->>'status',
    true,
    p_patch->>'to_number',
    p_patch->>'from_number',
    now()
  )
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
    cost_usd          = coalesce((p_patch->>'cost_usd')::numeric, cost_usd)
  where call_sid = p_call_sid;
end $$;

revoke all on function public.sv_update_call(text, text, jsonb) from public;
grant execute on function public.sv_update_call(text, text, jsonb) to anon, authenticated;

-- Backfill the row for the verification call so its 73 transcript lines have somewhere to hang.
insert into public.calls (call_sid, direction, status, placed, to_number, from_number, operator, duration_seconds, answered_by, queued_at)
values ('CA5dc9217fa23996d50fb19dd296dd209c','outbound','completed',true,'+19163504869','+19168663918','e2e-verify',20,'unknown', now())
on conflict (call_sid) do nothing;;
