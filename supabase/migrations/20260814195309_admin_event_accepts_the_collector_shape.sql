-- 20260814195309_admin_event_accepts_the_collector_shape
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- sv_admin_event — accept the shape the collector actually sends.
--
-- ★ THE SEAM, MEASURED. `/api/event` dual-writes with `p_row->>'event'` for the event name. This
-- function read `p_row->>'name'`. Every write therefore failed:
--
--   23502  null value in column "name" of relation "app_events"
--   Failing row contains (1, null, seamprobe, null, null, /seam-probe, {"probe": true}, probe, null, web, ...)
--
-- and the collector's own error handling is deliberately non-fatal — the raw Blobs log has already
-- succeeded at that point, so it logs and returns 204. From outside, the site looks perfectly
-- healthy while the queryable table stays empty forever. Two halves that each work, and nobody
-- asserted on the seam. That is the same shape as the consent record written to Blobs while the
-- dial gate read Postgres, and as AnsweredBy arriving on a webhook the only writer never watched.
--
-- THE FIX IS ON THIS SIDE ON PURPOSE. The collector is another lane's file and is already
-- deployed; changing it means a coordinated redeploy of a live endpoint to fix a contract I
-- defined. A receiver should be liberal in what it accepts, and the name of a field is not worth
-- a deploy. `name` still wins if both are present, so no existing caller changes behaviour.
--
-- It also now honours `at` and `ip_sha256`, which the collector sends and this function silently
-- dropped: `at` matters because a queued or retried write must carry the time the event HAPPENED,
-- not the time the row landed, or every funnel built on this table is skewed by our own latency.

create or replace function public.sv_admin_event(p_secret text, p_row jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare v bigint; v_name text;
begin
  perform private.require(p_secret);

  -- Accept either key. A missing name is a REFUSAL, not a null row: an event with no name is
  -- unqueryable and would quietly inflate every count while telling nobody anything.
  v_name := coalesce(nullif(trim(p_row->>'name'), ''), nullif(trim(p_row->>'event'), ''));
  if v_name is null then
    raise exception 'an event needs a name: send it as "name" or as "event"'
      using errcode = '22023';
  end if;

  insert into public.app_events
    (account_id, anon_id, session_id, name, page, meta, ua, ip_sha256, source, at)
  values (
    nullif(p_row->>'account_id','')::uuid,
    nullif(p_row->>'anon_id',''),
    nullif(p_row->>'session_id',''),
    left(v_name, 120),
    left(coalesce(p_row->>'page',''), 300),
    coalesce(p_row->'meta', '{}'::jsonb),
    left(coalesce(p_row->>'ua',''), 400),
    nullif(p_row->>'ip_sha256',''),
    coalesce(nullif(p_row->>'source',''), 'web'),
    -- The time the event HAPPENED, when the caller knows it. Falls back to now() rather than
    -- failing, because a malformed timestamp must not cost us the event.
    coalesce(
      case when (p_row->>'at') is not null
           then (p_row->>'at')::timestamptz else null end,
      now())
  )
  returning id into v;
  return v;
exception
  when invalid_datetime_format then
    -- A bad timestamp is not worth losing the event over; record it at now() and carry on.
    insert into public.app_events
      (account_id, anon_id, session_id, name, page, meta, ua, ip_sha256, source)
    values (nullif(p_row->>'account_id','')::uuid, nullif(p_row->>'anon_id',''),
            nullif(p_row->>'session_id',''), left(v_name,120),
            left(coalesce(p_row->>'page',''),300), coalesce(p_row->'meta','{}'::jsonb),
            left(coalesce(p_row->>'ua',''),400), nullif(p_row->>'ip_sha256',''),
            coalesce(nullif(p_row->>'source',''),'web'))
    returning id into v;
    return v;
end $$;

comment on function public.sv_admin_event(text, jsonb) is
  'Accepts the event name as either "name" or "event" because the /api/event collector sends the latter. Deliberately liberal: a field name is not worth a coordinated redeploy of a live endpoint, and the alternative was a queryable table that stayed empty forever while every surface reported success.';;
