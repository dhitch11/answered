-- 20260814214452_cockpit_board_queue_column
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- The queue ordered by x.created_at without selecting it, so the outer aggregate could not see it.
-- 42703. Added to the projection.
create or replace function public.sv_admin_cockpit(p_secret text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_dnc jsonb; v_dnc_ok boolean;
begin
  perform private.require(p_secret);
  begin v_dnc := public.sv_dnc_readiness(p_secret);
  exception when others then
    v_dnc := jsonb_build_object('scrub_ready', false, 'procedures_ready', false,
                                'error', 'readiness could not be read, which is a refusal');
  end;
  v_dnc_ok := coalesce((v_dnc->>'scrub_ready')::boolean, false)
          and coalesce((v_dnc->>'procedures_ready')::boolean, false);

  return jsonb_build_object(
    'at', now(),
    'lines', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (
        select l.id, l.phone, l.label, l.purpose, l.status, l.area_code,
               l.daily_cap, l.calls_today, l.calls_total, l.answer_rate,
               l.reputation, l.reputation_at, l.rest_until,
               (l.rest_until is not null and l.rest_until > now())          as resting,
               greatest(l.daily_cap - l.calls_today, 0)                     as remaining_today,
               (select count(*) from public.calls c
                 where c.line_id = l.id
                   and c.status in ('queued','initiated','ringing','in-progress')
                   and c.created_at > now() - interval '30 minutes')        as in_flight
          from public.lines l order by l.label nulls last) x),
    'line_capacity', (select jsonb_build_object(
        'lines', count(*), 'active', count(*) filter (where status = 'active'),
        'resting', count(*) filter (where rest_until is not null and rest_until > now()),
        'flagged', count(*) filter (where reputation in ('at_risk','flagged')),
        'calls_today', coalesce(sum(calls_today), 0),
        'daily_ceiling', coalesce(sum(daily_cap), 0)) from public.lines),

    'in_flight', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (
        select c.id, c.call_sid, c.direction, c.status, c.from_number, c.to_number,
               c.answered_by, c.created_at, c.started_at, c.answered_at,
               c.call_class, c.ai_speaking, c.ai_listening, c.disclosure_verified,
               ct.name as contact_name, ct.id as contact_id, ct.trade, ct.city, ct.state,
               extract(epoch from (now() - coalesce(c.answered_at, c.started_at, c.created_at)))::int as elapsed_s,
               (select count(*) from public.transcript_lines t where t.call_sid = c.call_sid) as lines_so_far
          from public.calls c
          left join public.contacts ct on ct.id = c.contact_id
         where c.status in ('queued','initiated','ringing','in-progress')
           and c.created_at > now() - interval '30 minutes'
         order by c.created_at desc) x),

    'recent', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (
        select c.id, c.call_sid, c.direction, c.status, c.answered_by, c.duration_seconds,
               c.from_number, c.to_number, c.created_at, c.placed, c.refused_reason,
               c.call_class, c.disclosure_verified, c.recording_sid, c.summary,
               ct.name as contact_name, ct.id as contact_id,
               (select count(*) from public.transcript_lines t where t.call_sid = c.call_sid) as transcript_lines
          from public.calls c
          left join public.contacts ct on ct.id = c.contact_id
         order by c.created_at desc limit 25) x),

    'queue', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (
        select c.id, c.name, c.phone, c.email, c.trade, c.city, c.state, c.line_type,
               c.disposition, c.lane, c.call_count, c.last_contacted_at, c.contact_name,
               c.created_at,
               coalesce(c.line_type in ('landline','fixedVoip'), false) as fixed_line,
               (c.email is not null)                                    as has_email,
               coalesce(s.human_dial_ok, false)                         as state_open,
               coalesce(s.reviewed, false)                              as state_reviewed,
               case
                 when c.email is not null then 1
                 when coalesce(s.human_dial_ok,false) and v_dnc_ok then 2
                 when coalesce(s.reviewed,false) then 4
                 else 3
               end as rank,
               case
                 when c.email is not null then 'Email is open right now. No carrier, no registry, no state clearance needed.'
                 when coalesce(s.human_dial_ok,false) and v_dnc_ok then 'State is clear and the registry is loaded.'
                 when not coalesce(s.reviewed,false) then 'Waiting on state clearance. Nobody has read this state yet, so it is a queue rather than a refusal.'
                 else coalesce(s.reason, 'Blocked by state law.')
               end as why
          from public.contacts c
          left join public.compliance_states s on s.state = c.state
         where not coalesce(c.suppressed, false)
           and c.disposition in ('new','queued','callback')
         order by
           case when c.email is not null then 1
                when coalesce(s.human_dial_ok,false) and v_dnc_ok then 2
                when coalesce(s.reviewed,false) then 4 else 3 end,
           c.created_at desc
         limit 40) x),

    'lamps', jsonb_build_object(
      'registry', jsonb_build_object('ok', v_dnc_ok, 'detail', v_dnc,
        'why', case when v_dnc_ok then 'Registry loaded and the written procedures are in place.'
                    when not coalesce((v_dnc->>'scrub_ready')::boolean,false)
                      then 'The national do-not-call registry has never been loaded, so no number can be proven absent from it. Nothing is cold-callable, whatever its line type.'
                    else 'The written procedures required by 47 CFR 64.1200(d) are not all in place.' end),
      'states', jsonb_build_object(
        'reviewed', (select count(*) from public.compliance_states where reviewed),
        'open',     (select count(*) from public.compliance_states where human_dial_ok),
        'in_book',  (select count(distinct state) from public.contacts where state is not null),
        'why', 'A state is only callable once its own statutory text has been read. Unreviewed is a queue, not a refusal.'),
      'suppression', jsonb_build_object(
        'entries', (select count(*) from public.suppression),
        'contacts', (select count(*) from public.contacts where coalesce(suppressed,false)),
        'why', 'Checked before every dial. Suppression covers every channel, not only the phone.')),

    'book', jsonb_build_object(
      'total',      (select count(*) from public.contacts),
      'emailable',  (select count(*) from public.contacts
                      where email is not null and not coalesce(suppressed,false)),
      'fixed_line', (select count(*) from public.contacts where line_type in ('landline','fixedVoip')),
      'mobile',     (select count(*) from public.contacts where line_type in ('mobile','nonFixedVoip')),
      'worked',     (select count(*) from public.contacts where last_contacted_at is not null),
      'calls_total',(select count(*) from public.calls),
      'transcript_lines', (select count(*) from public.transcript_lines),
      'recordings', (select count(*) from public.calls where recording_sid is not null),
      'messages',   (select count(*) from public.crm_messages))
  );
end $$;;
