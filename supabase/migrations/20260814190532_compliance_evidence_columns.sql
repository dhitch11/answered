-- 20260814190532_compliance_evidence_columns
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- COMPLIANCE EVIDENCE AS COLUMNS, not as prose in a JSON blob.
--
-- The adversarial verification found that the largest exposure in this program is the AI that
-- listens and never speaks, and that a wiretap claim is the class-certifiable one because the
-- disclosure is a single uniform practice applied identically to every callee. That means the
-- question "was an AI listening on this call, and was it disclosed" has to be answerable per call,
-- years later, from a row — not from a memory, a script file, or a config flag.
--
-- ★ AND IT MUST BE ANSWERED FROM THE ARTIFACT, NOT FROM AN ASSERTION. On 2026-08-14 the disclosure
-- was present in the script, complete in the obligations list, approved by scriptSatisfies(), found
-- by grep — and the entire spoken output of a real call was the word "Hi", because a <Say> nested in
-- a <Gather> is cut off by the other party's first word. A boolean set at dial time would have
-- recorded that call as disclosed. So disclosure_verified is set from the TRANSCRIPT of what was
-- actually said, after the fact, and it is null until something has read the wire.

alter table public.calls add column if not exists ai_speaking boolean;
alter table public.calls add column if not exists ai_listening boolean;
alter table public.calls add column if not exists disclosure_verified boolean;
alter table public.calls add column if not exists disclosure_evidence jsonb;
alter table public.calls add column if not exists dnc_scrubbed_at_dial boolean;
alter table public.calls add column if not exists dnc_procedures_at_dial boolean;

comment on column public.calls.ai_speaking is
  'Did an artificial voice speak on this call. Decides whether 47 CFR 64.1200(a)(1) and FCC 24-17 reach it.';
comment on column public.calls.ai_listening is
  'Was an AI receiving the audio (transcription, analysis) whether or not it spoke. THE field a state all-party wiretap claim turns on. True even when ai_speaking is false.';
comment on column public.calls.disclosure_verified is
  'Was the disclosure ACTUALLY SPOKEN, read back from the transcript of what went over the wire. NULL means nobody has checked yet. Never set this at dial time: a <Say> inside a <Gather> is silenced by the callee''s first word and a dial-time boolean would record that call as disclosed.';
comment on column public.calls.dnc_scrubbed_at_dial is
  'Was the national DNC registry scrub in place when this call was placed. 47 CFR 64.1200(c)(2). Recorded per call because it is a condition precedent, so its state at dial time is the fact that matters, not its state today.';

create index if not exists calls_ai_listening_idx on public.calls (ai_listening, created_at desc)
  where ai_listening is true;
create index if not exists calls_disclosure_idx on public.calls (disclosure_verified, created_at desc);

-- The one query a regulator, a plaintiff or an auditor actually asks.
create or replace function public.sv_compliance_evidence(p_secret text, p_since timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path = public, private as $$
declare v jsonb;
begin
  perform private.require(p_secret);
  select jsonb_build_object(
    'window_start', coalesce(p_since, now() - interval '90 days'),
    'by_class', (
      select coalesce(jsonb_agg(x order by x->>'call_class'), '[]'::jsonb) from (
        select jsonb_build_object(
          'call_class', coalesce(call_class, 'unclassified'),
          'placed', count(*) filter (where placed),
          'refused', count(*) filter (where not placed),
          'ai_spoke', count(*) filter (where placed and ai_speaking),
          'ai_listened', count(*) filter (where placed and ai_listening),
          'disclosure_verified', count(*) filter (where placed and disclosure_verified is true),
          'disclosure_failed', count(*) filter (where placed and disclosure_verified is false),
          'disclosure_unchecked', count(*) filter (where placed and disclosure_verified is null),
          'dnc_scrubbed', count(*) filter (where placed and dnc_scrubbed_at_dial)
        ) as x
        from public.calls
        where created_at >= coalesce(p_since, now() - interval '90 days')
        group by coalesce(call_class, 'unclassified')
      ) s
    ),
    -- The number that matters most, alone, because burying it in a table hides it:
    -- calls where an AI received the audio and nothing has confirmed the disclosure was spoken.
    'ai_listened_without_verified_disclosure', (
      select count(*) from public.calls
       where placed and ai_listening and disclosure_verified is distinct from true
         and created_at >= coalesce(p_since, now() - interval '90 days')
    ),
    'states_refused', (
      select coalesce(jsonb_object_agg(reason, n), '{}'::jsonb) from (
        select left(refused_reason, 60) as reason, count(*) n
          from public.calls
         where not placed and refused_reason is not null
           and created_at >= coalesce(p_since, now() - interval '90 days')
         group by 1 order by 2 desc limit 12
      ) r
    )
  ) into v;
  return v;
end $$;

revoke all on function public.sv_compliance_evidence(text, timestamptz) from public;
grant execute on function public.sv_compliance_evidence(text, timestamptz) to anon, authenticated;

comment on function public.sv_truce_admin(text,int) is
  'Admin projection for Truce. It deliberately never joins sealed.limits. Adding a limit to this '
  'function breaks the promise /truce Section 3 is built on - that a party''s number is not in a '
  'message, not in the summary, not on the signed page, and not derivable from any of them. If you '
  'are here to add one, that is the reason not to.';;
