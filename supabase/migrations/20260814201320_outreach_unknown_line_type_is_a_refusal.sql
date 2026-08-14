-- 20260814201320_outreach_unknown_line_type_is_a_refusal
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- ★ AN UNKNOWN LINE TYPE REPORTED "The number can receive texts." AND THAT IS THE SAME BUG AGAIN.
--
-- In SQL, `NULL not in ('mobile','nonFixedVoip')` is NULL, not TRUE. So a contact whose line type
-- has never been established fell through every CASE arm to the ELSE and was described as able to
-- receive texts, and `sms_db.ok` came back NULL rather than false — which JavaScript then treated
-- as falsy and rendered as "blocked" for the wrong reason, with the right-sounding wrong sentence
-- underneath it.
--
-- It is the identical shape to `ctx.suppressed ?` and `Number(ctx.calls_30d || 0)` failing OPEN on
-- a missing field, and to a state with zero measured numbers printing "0% fixed-line" instead of
-- "not measured". A control whose absence means permission must test PRESENCE, never truthiness,
-- and an unanswerable question is a refusal.
--
-- Fixed here by testing `line_type IS NULL` FIRST, before any comparison that a null can collapse,
-- and by coalescing every boolean this function returns so no caller can ever receive a null and
-- decide for itself what it meant.

create or replace function public.sv_crm_outreach_state(p_secret text, p_contact_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c          public.contacts%rowtype;
  v_supp     public.suppression%rowtype;
  v_cons     integer;
  v_dnc      jsonb;
  v_blocked  boolean;
  v_call_ok  boolean;
  v_call_why text;
  v_sms_ok   boolean;
  v_sms_why  text;
  v_mail_ok  boolean;
  v_mail_why text;
begin
  perform private.require(p_secret);
  select * into c from public.contacts where id = p_contact_id;
  if c.id is null then return null; end if;

  select * into v_supp from public.suppression where phone = c.phone;
  select count(*) into v_cons from public.consent
   where phone = c.phone and (expires_at is null or expires_at > now());

  v_blocked := coalesce(c.suppressed, false) or (v_supp.phone is not null);

  begin
    v_dnc := public.sv_dnc_readiness(p_secret);
  exception when others then
    v_dnc := jsonb_build_object('scrub_ready', false, 'procedures_ready', false,
                                'error', 'do-not-call readiness could not be read, which is a refusal');
  end;

  -- ── CALL. Most absolute first. Unknown is refused, never assumed. ─────────────────────────
  if v_blocked then
    v_call_ok := false;
    v_call_why := 'This number is on our suppression list' ||
      coalesce(': ' || coalesce(c.suppressed_reason, v_supp.reason), '') ||
      '. It is never called again, by anyone, for any reason.';
  elsif c.phone is null or c.phone !~ '^\+\d{8,15}$' then
    v_call_ok := false;
    v_call_why := 'There is no dialable number on this record.';
  elsif c.line_type is null then
    v_call_ok := false;
    v_call_why := 'We have never established what kind of line this is. An unanswerable question is a refusal, so run a line-type lookup before anything dials it.';
  elsif v_cons > 0 then
    v_call_ok := true;
    v_call_why := 'There is a consent record on file for this number, so this is a consented call regardless of line type.';
  elsif c.line_type in ('mobile','nonFixedVoip') then
    v_call_ok := false;
    v_call_why := 'This is a ' || c.line_type || '. An AI voice may not cold-call it without prior express consent. A person may dial and speak to it, which is a different call class.';
  elsif c.line_type = 'tollFree' then
    v_call_ok := false;
    v_call_why := 'Toll free numbers are not dialled: the called party pays.';
  elsif c.line_type not in ('landline','fixedVoip') then
    v_call_ok := false;
    v_call_why := 'Line type "' || c.line_type || '" is not one we have a rule for, so it is refused rather than guessed at.';
  elsif not coalesce((v_dnc->>'scrub_ready')::boolean, false) then
    v_call_ok := false;
    v_call_why := 'The national do-not-call registry has never been loaded, so we cannot prove this number is not on it. That is a condition precedent, not a formality.';
  elsif not coalesce((v_dnc->>'procedures_ready')::boolean, false) then
    v_call_ok := false;
    v_call_why := 'The written do-not-call procedures required by 47 CFR 64.1200(d) are not all in place.';
  else
    v_call_ok := true;
    v_call_why := 'Verified fixed business line, not suppressed, scrubbed against a current registry snapshot.';
  end if;

  -- ── SMS. Same discipline. ─────────────────────────────────────────────────────────────────
  if v_blocked then
    v_sms_ok := false;
    v_sms_why := 'This contact asked not to be contacted. Suppression covers every channel, not only the phone.';
  elsif c.phone is null or c.phone !~ '^\+\d{8,15}$' then
    v_sms_ok := false;
    v_sms_why := 'There is no mobile number on this record.';
  elsif c.line_type is null then
    v_sms_ok := false;
    v_sms_why := 'We have never established what kind of line this is, so we do not know whether it can receive a text. Unknown is not permission.';
  elsif c.line_type in ('mobile','nonFixedVoip') then
    v_sms_ok := true;
    v_sms_why := 'The number is a ' || c.line_type || ', so it can receive text messages.';
  else
    v_sms_ok := false;
    v_sms_why := 'A ' || c.line_type || ' line does not receive text messages.';
  end if;

  -- ── EMAIL. ────────────────────────────────────────────────────────────────────────────────
  if v_blocked then
    v_mail_ok := false;
    v_mail_why := 'This contact asked not to be contacted. Suppression covers every channel.';
  elsif c.email is null or position('@' in c.email) < 2 then
    v_mail_ok := false;
    v_mail_why := 'We hold no email address for this business yet. The enrichment pass reads what each business publishes on its own site; until it reaches this record, this is an honest absence rather than a gap.';
  else
    v_mail_ok := true;
    v_mail_why := 'A business email is on file and this contact is not suppressed.';
  end if;

  return jsonb_build_object(
    'contact_id', c.id, 'name', c.name, 'phone', c.phone, 'email', c.email,
    'line_type', c.line_type, 'lane', c.lane,
    'suppressed', v_blocked,
    'consent_records', v_cons,
    'dnc', v_dnc,
    -- Every boolean is coalesced. No caller may receive a null and decide for itself what it meant.
    'call',  jsonb_build_object('ok', coalesce(v_call_ok, false), 'why', v_call_why,
             'class', case when v_cons > 0 then 'consented'
                           when c.line_type in ('landline','fixedVoip') then 'ai_cold'
                           else null end),
    'email_db', jsonb_build_object('ok', coalesce(v_mail_ok, false), 'why', v_mail_why),
    'sms_db',   jsonb_build_object('ok', coalesce(v_sms_ok,  false), 'why', v_sms_why),
    'counts', jsonb_build_object(
      'messages', (select count(*) from public.crm_messages m where m.contact_id = c.id),
      'calls',    (select count(*) from public.calls cl where cl.contact_id = c.id),
      'last_contacted_at', c.last_contacted_at)
  );
end $$;;
