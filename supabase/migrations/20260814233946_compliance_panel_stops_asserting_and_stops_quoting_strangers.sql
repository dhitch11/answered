-- 20260814233946_compliance_panel_stops_asserting_and_stops_quoting_strangers
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- Three defects in my own compliance surface, all found by @ANSWERED-INTEL, all verified from the
-- live function bodies before changing anything.

-- ── 1. A STRANGER'S SPEECH WAS CONCATENATED INTO OUR COMPLIANCE DETERMINATION ────────────────
--
-- `sv_dnc_request` built ONE string out of two things that must never be one thing:
--     coalesce('do-not-call request: ' || p_heard_as, 'do-not-call request')
-- so up to 200 characters of transcribed speech from an unknown caller landed inside
-- `suppression.reason`, which the console then splices into the sentence an operator reads as OUR
-- finding. An operator seeing "Do not contact: do-not-call request: wrong number, try 555-0100"
-- may act on a stranger's instruction believing it is our determination. It is escaped, so it is
-- not an injection into the page — it is an injection into the VOICE.
--
-- ★ AND THE REASON ESCAPING IS THE WRONG FIX: the day that sentence reaches a model prompt,
-- escaping does nothing at all. Only structural separation helps. `dnc_requests` already had a
-- `heard_as` column doing this correctly; `suppression` did not, so the two diverged.
alter table public.suppression add column if not exists heard_as text;
comment on column public.suppression.heard_as is
  'VERBATIM THIRD-PARTY SPEECH. Never our determination, never concatenated into one. Render it as an attributed quotation and never splice it into a sentence an operator reads as our finding. Structurally separate because escaping stops helping the moment this text reaches a model prompt.';

create or replace function public.sv_dnc_request(p_secret text, p_phone text, p_channel text,
  p_heard_as text default null, p_call_sid text default null, p_by text default 'system')
returns jsonb language plpgsql security definer set search_path = public, private as $$
declare v_by timestamptz;
begin
  perform private.require(p_secret);
  if p_phone is null or p_phone !~ '^\+1\d{10}$' then
    return jsonb_build_object('error','a do-not-call request needs a usable number');
  end if;

  -- ten BUSINESS days, weekends skipped. Amended effective 2025-04-11 (was thirty).
  v_by := now();
  for i in 1..10 loop
    v_by := v_by + interval '1 day';
    while extract(isodow from v_by) in (6,7) loop v_by := v_by + interval '1 day'; end loop;
  end loop;

  insert into public.dnc_requests (phone, honour_by, channel, heard_as, call_sid, recorded_by)
  values (p_phone, v_by, coalesce(p_channel,'call'), p_heard_as, p_call_sid, coalesce(p_by,'system'));

  -- Honoured immediately, because there is no reason to use the ten days. The deadline is recorded
  -- so the evidence shows we were inside it, not so we can spend it.
  --
  -- ★ `reason` is now OURS ALONE and is a fixed string. Their words go in `heard_as`, beside it,
  -- never inside it. Two columns, two authors, no sentence that blends them.
  insert into public.suppression (phone, reason, heard_as, source)
  values (p_phone, 'do-not-call request', p_heard_as, coalesce(p_channel,'call'))
  on conflict (phone) do nothing;
  update public.dnc_requests set honoured_at = now() where phone = p_phone and honoured_at is null;

  return jsonb_build_object('ok', true, 'honour_by', v_by, 'honoured_at', now());
end $$;

-- ── 2 + 3. THE READINESS PANEL ASSERTED ONE ROW AND RENDERED TWO ABSENCES AS ZEROS ───────────
--
-- `snapshot_numbers` and `snapshot_area_codes` were `coalesce(..., 0)`, so WITH NO SNAPSHOT AT ALL
-- they printed 0 — indistinguishable from a snapshot containing zero numbers. The function was
-- internally inconsistent about it: `snapshot_age_days` already returned NULL for absence and got
-- it right. This is the estate's own card, a failure rendering as a measurement, inside the
-- compliance panel of all places.
--
-- `internal_list_live` was the literal `true`, sitting among genuinely measured `exists(...)`
-- checks, so a row that reads as measured was asserted. My comment justified it ("has existed
-- since day one") and that was true — but it is a 47 CFR 64.1200(d)(3) element displayed as
-- satisfied on the strength of a comment. It is now measured, and it now COUNTS toward
-- procedures_ready, which it never did: the gate was silently ignoring one of the six elements it
-- claims to enforce.
create or replace function public.sv_dnc_readiness(p_secret text)
returns jsonb language plpgsql stable security definer set search_path = public, private as $$
declare snap public.dnc_snapshots; v jsonb;
begin
  perform private.require(p_secret);
  select * into snap from public.dnc_snapshots order by downloaded_at desc limit 1;

  select jsonb_build_object(
    -- (c)(2): a snapshot must EXIST and be under 31 days old. Both, measured.
    'scrub_ready', snap.id is not null and snap.downloaded_at > now() - interval '31 days',
    'snapshot_age_days', case when snap.id is null then null
                              else round(extract(epoch from (now() - snap.downloaded_at)) / 86400) end,
    -- NULL means no snapshot has ever been loaded. 0 would mean one was loaded and held nothing.
    -- Those are different facts and the panel must not blend them.
    'snapshot_numbers',    case when snap.id is null then null else snap.numbers end,
    'snapshot_area_codes', case when snap.id is null then null else array_length(snap.area_codes, 1) end,
    'san_on_file', snap.san is not null,
    -- (d): every element has to be present. Missing paper is a shut gate, not a warning.
    'policy_written',   exists (select 1 from public.compliance_policy where kind='dnc_policy' and superseded_at is null),
    'affiliate_scope',  exists (select 1 from public.compliance_policy where kind='affiliate_scope' and superseded_at is null),
    'retention_policy', exists (select 1 from public.compliance_policy where kind='retention' and superseded_at is null),
    'training_recorded',exists (select 1 from public.compliance_training),
    -- MEASURED, not asserted: the internal list is live when the table exists and is readable.
    'internal_list_live', (to_regclass('public.suppression') is not null),
    -- the operational number: requests past their ten-business-day deadline, unhonoured
    'overdue_requests', (select count(*) from public.dnc_requests where honoured_at is null and honour_by < now())
  ) into v;

  return v || jsonb_build_object(
    'procedures_ready',
      (v->>'policy_written')::boolean and (v->>'affiliate_scope')::boolean
      and (v->>'retention_policy')::boolean and (v->>'training_recorded')::boolean
      and (v->>'internal_list_live')::boolean       -- was omitted entirely; 64.1200(d)(3) is an element
      and (v->>'overdue_requests')::int = 0
  );
end $$;;
