-- 20260814205943_compliance_states_and_the_human_dial_lane
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- STATE CLEARANCE, AND THE HUMAN-DIALLED LANE.
--
-- David: "still keep all mobile numbers. we will be calling them. they should be available and
-- listed as mobile in crm."
--
-- No mobile was ever discarded — all 1,507 are stored, labelled and queryable. They were refused
-- by the gate, not deleted from the book. What was wrong was the DISPLAY: a mobile read as
-- unusable when it is in fact reachable by a person dialling and speaking.
--
-- ★ THE DISTINCTION THIS TABLE EXISTS TO MAKE, AND IT IS THE WHOLE POINT.
--
--   "not dialable"                 reads as a dead lead. An operator skips it forever.
--   "waiting on state clearance"   is a WORK QUEUE. It opens when a lawyer finishes reading.
--
-- Those are different facts and the console must never render the second as the first. Same
-- family as a column never written reading as a measured zero: an absence of knowledge dressed
-- up as a finding.
--
-- ★ THE AUTHORITY IS research/lib/lane.mjs, NOT THIS TABLE. The outbound lane reads primary
-- statutory text and encodes the verdict in VERIFIED_STATES and the gate. This table exists so a
-- console can RENDER that verdict without duplicating a legal judgement, and it is seeded from
-- their current constants verbatim. When they clear a state, they write the row. Nothing in
-- /admin ever decides whether a state is open.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

create table if not exists public.compliance_states (
  state          text primary key,
  reviewed       boolean not null default false,
  ai_voice_ok    boolean not null default false,
  human_dial_ok  boolean not null default false,
  reason         text,
  statute        text,
  reviewed_at    timestamptz,
  reviewed_by    text,
  updated_at     timestamptz not null default now()
);

comment on table public.compliance_states is
  'Rendered by /admin, owned by the outbound lane. research/lib/lane.mjs is the authority: this table is how that verdict reaches a screen. reviewed=false means NOBODY HAS READ THAT STATE YET, which is a work queue, not a refusal.';
comment on column public.compliance_states.reviewed is
  'Has the state''s own statutory text been read for solicitor registration, bonding, artificial-voice restriction, recording consent, DNC treatment and damages exposure? False means unknown, not blocked. The difference is a work queue versus a dead lead.';
comment on column public.compliance_states.human_dial_ok is
  'A person dials and a person speaks, with no artificial voice anywhere on the call. This relaxes ONE thing: which line types are reachable. The registry, the window, the frequency cap, suppression and every state rule still bind.';

alter table public.compliance_states enable row level security;
revoke all on public.compliance_states from anon, authenticated;
grant all on public.compliance_states to service_role;

-- Seeded VERBATIM from research/lib/lane.mjs as it stands 2026-08-14. Nothing here is my legal
-- conclusion; every row restates theirs, and any state not listed is reviewed=false by absence.
insert into public.compliance_states (state, reviewed, ai_voice_ok, human_dial_ok, reason, statute, reviewed_at, reviewed_by)
values
  ('TX', true, false, false, 'Telephone-solicitor registration and bond bind before the first call, and Texas extends criminal liability to the individual representative personally.', 'Tex. Bus. & Com. Code ch. 302', '2026-08-13', '@ANSWERED-RESEARCH'),
  ('WA', true, false, false, 'Telephone-solicitor registration and bond bind before the first call.', 'RCW 19.158', '2026-08-13', '@ANSWERED-RESEARCH'),
  ('FL', true, false, false, 'Telephone-solicitor registration and bond bind before the first call.', 'Fla. Stat. 501.059 / 501.601', '2026-08-13', '@ANSWERED-RESEARCH'),
  ('IL', true, false, false, 'BIPA requires a WRITTEN release before a voiceprint is collected, and no spoken call-open disclosure can supply one. Blocked until the transcription stack can demonstrably prove it performs no voice-based speaker modelling.', '740 ILCS 14/15(b)', '2026-08-13', '@ANSWERED-RESEARCH'),
  ('CA', true, false, false, 'A live human must personally make the announcement before any artificial voice speaks: nature of the call, business name, address, phone, the artificial-voice disclosure, and a captured consent to continue. Until that path exists, California is closed to autonomous AI.', 'Cal. Pub. Util. Code 2874', '2026-08-14', '@ANSWERED-RESEARCH'),
  ('NV', true, false, false, 'Reviewed in the four-state primary-law pass and refused.', 'four-state verification 2026-08-14', '2026-08-14', '@ANSWERED-RESEARCH'),
  ('AZ', true, false, false, 'Reviewed in the four-state primary-law pass and refused.', 'four-state verification 2026-08-14', '2026-08-14', '@ANSWERED-RESEARCH'),
  ('OR', true, true,  true,  'Reviewed and clear. The only state of the four-state pass that is open.', 'four-state verification 2026-08-14', '2026-08-14', '@ANSWERED-RESEARCH')
on conflict (state) do update set
  reviewed = excluded.reviewed, ai_voice_ok = excluded.ai_voice_ok,
  human_dial_ok = excluded.human_dial_ok, reason = excluded.reason,
  statute = excluded.statute, reviewed_at = excluded.reviewed_at,
  reviewed_by = excluded.reviewed_by, updated_at = now();

-- The outbound lane writes this when a state clears. One row, one call, no schema knowledge needed.
create or replace function public.sv_state_clearance(
  p_secret text, p_state text, p_reviewed boolean, p_ai boolean, p_human boolean,
  p_reason text, p_statute text, p_by text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.compliance_states%rowtype;
begin
  perform private.require(p_secret);
  insert into public.compliance_states (state, reviewed, ai_voice_ok, human_dial_ok, reason,
                                        statute, reviewed_at, reviewed_by)
  values (upper(trim(p_state)), coalesce(p_reviewed,true), coalesce(p_ai,false),
          coalesce(p_human,false), nullif(p_reason,''), nullif(p_statute,''), now(), nullif(p_by,''))
  on conflict (state) do update set
    reviewed = excluded.reviewed, ai_voice_ok = excluded.ai_voice_ok,
    human_dial_ok = excluded.human_dial_ok, reason = excluded.reason,
    statute = excluded.statute, reviewed_at = excluded.reviewed_at,
    reviewed_by = excluded.reviewed_by, updated_at = now()
  returning * into r;
  return jsonb_build_object('ok', true, 'state', to_jsonb(r));
end $$;

-- What the console renders: the pool, by what is actually blocking it.
create or replace function public.sv_admin_state_pool(p_secret text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_dnc jsonb; v_dnc_ok boolean;
begin
  perform private.require(p_secret);
  begin v_dnc := public.sv_dnc_readiness(p_secret);
  exception when others then v_dnc := jsonb_build_object('scrub_ready', false, 'procedures_ready', false); end;
  v_dnc_ok := coalesce((v_dnc->>'scrub_ready')::boolean, false)
          and coalesce((v_dnc->>'procedures_ready')::boolean, false);

  return jsonb_build_object(
    'dnc_ready', v_dnc_ok,
    'by_state', (select coalesce(jsonb_agg(to_jsonb(x) order by x.contacts desc), '[]'::jsonb) from (
        select c.state,
               count(*)                                                        as contacts,
               count(*) filter (where c.line_type in ('landline','fixedVoip')) as fixed_lines,
               count(*) filter (where c.line_type in ('mobile'))               as mobiles,
               coalesce(s.reviewed, false)      as reviewed,
               coalesce(s.ai_voice_ok, false)   as ai_voice_ok,
               coalesce(s.human_dial_ok, false) as human_dial_ok,
               s.reason, s.statute,
               case
                 when s.state is null or not s.reviewed then 'waiting_on_state_clearance'
                 when s.human_dial_ok and v_dnc_ok      then 'open'
                 when s.human_dial_ok and not v_dnc_ok  then 'waiting_on_dnc_registry'
                 else 'blocked_by_state_law'
               end as status
          from public.contacts c
          left join public.compliance_states s on s.state = c.state
         where c.state is not null
         group by c.state, s.state, s.reviewed, s.ai_voice_ok, s.human_dial_ok, s.reason, s.statute
    ) x),
    'totals', (select jsonb_build_object(
        'contacts',        count(*),
        'mobiles',         count(*) filter (where c.line_type = 'mobile'),
        'fixed_lines',     count(*) filter (where c.line_type in ('landline','fixedVoip')),
        -- The number that matters, and it is not the one anyone expects.
        'human_dialable_now', count(*) filter (
            where coalesce(s.human_dial_ok,false) and v_dnc_ok
              and not coalesce(c.suppressed,false)
              and c.line_type in ('landline','fixedVoip','mobile')),
        'human_dialable_when_dnc_lands', count(*) filter (
            where coalesce(s.human_dial_ok,false)
              and not coalesce(c.suppressed,false)
              and c.line_type in ('landline','fixedVoip','mobile')),
        'waiting_on_state_clearance', count(*) filter (where s.state is null or not s.reviewed),
        'blocked_by_state_law', count(*) filter (where s.reviewed and not s.human_dial_ok))
      from public.contacts c left join public.compliance_states s on s.state = c.state)
  );
end $$;;
