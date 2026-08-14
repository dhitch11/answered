-- 20260814183958_call_class_and_usage
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- call_class — the compliance and cost shape of a call, written at dial time.
--
-- A call is not a call. Three outbound classes exist with genuinely different obligations and
-- genuinely different unit costs, and both billing and the compliance evidence key on which one
-- it was. A label DERIVED later from other columns would be a guess about the past; a column
-- WRITTEN at dial time by the code that made the decision is a record.
--
--   ai_cold     AI voice to a verified landline or fixedVoip. No consent needed.
--               Obligations: 64.1200(b) identification, AI disclosure, recording notice.
--   human_cold  a person dials and speaks. Neither an autodialer nor an artificial voice, so
--               64.1200(a)(1) does not reach it, which is what makes mobile reachable at all.
--               Obligations: recording notice. No AI disclosure, because no AI speaks.
--   consented   AI voice to any line type with a consent record on file. The consent artifact is
--               the thing that has to survive an audit.
--   inbound     the caller rang us. A different legal world: CIPA is the gate, not TCPA.
--   demo        our own demo and canary traffic. Belongs to no customer and bills nobody.

alter table public.calls
  add column if not exists call_class text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'calls_call_class_chk') then
    alter table public.calls add constraint calls_call_class_chk
      check (call_class is null or call_class in ('ai_cold','human_cold','consented','inbound','demo'));
  end if;
end $$;

comment on column public.calls.call_class is
  'Written at dial time by the code that made the decision, never derived afterwards. Null means a call placed before this column existed; it is not a fourth class and must never be rendered as one.';

create index if not exists calls_class_at_idx on public.calls (call_class, created_at desc);

-- Usage, aggregated in the database. A console serving hundreds of thousands of customers must
-- never pull rows in order to count them.
--
-- ★ cost_rows_written TRAVELS WITH cost_usd, ALWAYS. calls.cost_usd exists and is currently never
-- written by any path, so a naive sum returns 0 and a dashboard would render "$0.00 spent" as a
-- measurement when the truth is "nobody has recorded a cost yet". The denominator is the
-- difference between a measured zero and an unmeasured one, and this estate has a whole memory
-- doc about the day that distinction was missed.
create or replace function public.sv_admin_usage(
  p_secret text, p_account uuid, p_since timestamptz
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_since timestamptz;
begin
  perform private.require(p_secret);
  v_since := coalesce(p_since, now() - interval '30 days');
  return jsonb_build_object(
    'since', v_since,
    'by_class', (
      select coalesce(jsonb_agg(jsonb_build_object(
          'call_class', coalesce(g.klass, 'unclassified'),
          'calls', g.n, 'placed', g.placed, 'refused', g.refused,
          'reached_human', g.reached, 'recordings', g.recs,
          'talk_seconds', g.secs, 'cost_usd', g.cost,
          'cost_rows_written', g.costrows) order by g.n desc), '[]'::jsonb)
      from (
        select call_class as klass,
               count(*) as n,
               count(*) filter (where placed) as placed,
               count(*) filter (where not placed) as refused,
               count(*) filter (where answered_by = 'human') as reached,
               count(*) filter (where recording_sid is not null) as recs,
               coalesce(sum(duration_seconds), 0) as secs,
               coalesce(sum(cost_usd), 0) as cost,
               count(*) filter (where cost_usd is not null) as costrows
          from public.calls
         where created_at >= v_since
           and (p_account is null or account_id = p_account)
         group by call_class
      ) g),
    'by_day', (
      select coalesce(jsonb_agg(jsonb_build_object(
          'day', d.bucket, 'calls', d.n, 'placed', d.placed,
          'recordings', d.recs, 'talk_seconds', d.secs) order by d.bucket), '[]'::jsonb)
      from (
        select date_trunc('day', created_at)::date as bucket,
               count(*) as n,
               count(*) filter (where placed) as placed,
               count(*) filter (where recording_sid is not null) as recs,
               coalesce(sum(duration_seconds), 0) as secs
          from public.calls
         where created_at >= v_since
           and (p_account is null or account_id = p_account)
         group by 1
      ) d),
    'totals', (
      select jsonb_build_object(
        'calls', count(*),
        'placed', count(*) filter (where placed),
        'refused', count(*) filter (where not placed),
        'inbound', count(*) filter (where direction = 'inbound'),
        'recordings', count(*) filter (where recording_sid is not null),
        'talk_seconds', coalesce(sum(duration_seconds), 0),
        'cost_usd', coalesce(sum(cost_usd), 0),
        'cost_rows_written', count(*) filter (where cost_usd is not null),
        'unclassified', count(*) filter (where call_class is null))
      from public.calls
     where created_at >= v_since
       and (p_account is null or account_id = p_account))
  );
end $$;;
