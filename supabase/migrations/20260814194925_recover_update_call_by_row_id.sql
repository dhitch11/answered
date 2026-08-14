-- 20260814194925_recover_update_call_by_row_id
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- ★ THE CONVERSATION KEYS ON OUR OWN ROW ID, NOT ON TWILIO'S CallSid.
--
-- The webhook already proves which call it is by presenting a capability token bound to a row, so
-- the row id is in hand on every turn. The CallSid is the vendor's identifier: it can be absent
-- (a dial that failed after the row was written), late, or different from what we recorded. Keying
-- the writes on it meant every disposition, every identity confirmation and every promise link was
-- silently discarded whenever the vendor's id was not exactly where we expected it, and the
-- surrounding .catch(() => {}) made that discard invisible.
create or replace function public.sv_recover_update_call_by_id(p_secret text, p_id uuid, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path to 'public','private' as $$
declare c public.recover_calls%rowtype;
begin
  perform private.require(p_secret);
  update public.recover_calls set
    call_sid           = coalesce(p_patch->>'call_sid', call_sid),
    status             = coalesce(p_patch->>'status', status),
    answered_by        = coalesce(p_patch->>'answered_by', answered_by),
    duration_seconds   = coalesce((p_patch->>'duration_seconds')::int, duration_seconds),
    disposition        = coalesce(p_patch->>'disposition', disposition),
    identity_confirmed = coalesce((p_patch->>'identity_confirmed')::boolean, identity_confirmed),
    outcome            = outcome || coalesce(p_patch->'outcome','{}'::jsonb),
    ended_at           = coalesce((p_patch->>'ended_at')::timestamptz, ended_at)
   where id = p_id returning * into c;
  if not found then return jsonb_build_object('error','no such call row'); end if;

  if c.identity_confirmed then
    update public.recover_invoices
       set last_conversation_at = now(), last_contact_at = now()
     where id = c.invoice_id;
  end if;
  return to_jsonb(c);
end $$;

-- The status webhook is the one place the CallSid is the only handle we are given, so that path
-- keeps sv_recover_update_call. Both exist on purpose.;
