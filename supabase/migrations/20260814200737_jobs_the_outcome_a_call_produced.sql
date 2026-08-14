-- 20260814200737_jobs_the_outcome_a_call_produced
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- jobs — the OUTCOME a call produced. Requested by @ANSWERED-BUILD for the customer portal, and
-- it closes a gap in /admin at the same time.
--
-- Until now a booked job persisted to a Netlify blob, an email and a HubSpot object, so "show me
-- this customer's jobs" had no answer anywhere. Same orphan shape as the billing accounts with no
-- customer, one layer up: `calls` gained account_id, but nothing connected a call to what it
-- ACHIEVED. A receptionist product whose database cannot list the appointments it booked is
-- measuring its own activity and not its own value.
--
-- TWO PROPERTIES THAT MATTER MORE THAN THE COLUMNS, both @ANSWERED-BUILD's and both right:
--
-- 1. A VOID IS A STATUS CHANGE PLUS A REASON, NEVER A DELETE. The published promise is "reply
--    VOID and the $19 comes off". A customer who disputes a charge must leave a record behind
--    rather than a hole, or the dispute cannot be audited and the refund cannot be explained.
--
-- 2. after_hours IS STORED, NOT DERIVED AT READ TIME. It decides whether the job cost $19 or $49.
--    Recomputing it later against a changed timezone, a changed hours rule or a changed clock
--    would silently restate a bill somebody has already paid. The same reasoning as the frozen
--    `rating` on billing_events: a bill is never re-derived from today's price book.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

create table if not exists public.jobs (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid references public.accounts(id) on delete set null,
  contact_id    uuid references public.contacts(id) on delete set null,
  job_ref       text not null unique,
  caller_name   text,
  address       text,
  callback      text,
  window_start  timestamptz,
  window_end    timestamptz,
  trade         text,
  after_hours   boolean not null default false,
  source        text not null default 'voice' check (source in ('voice','form','operator','api')),
  call_id       uuid references public.calls(id) on delete set null,
  call_sid      text,
  status        text not null default 'booked'
                check (status in ('booked','voided','completed','no_show','rescheduled')),
  void_reason   text,
  voided_at     timestamptz,
  voided_by     text,
  billing_event_id uuid references public.billing_events(id) on delete set null,
  details       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on column public.jobs.after_hours is
  'Stored at booking time, never derived at read time. It decides whether this job was charged 19 or 49, and recomputing it later against a changed rule would restate a bill somebody already paid.';
comment on column public.jobs.job_ref is
  'The human handle a customer quotes back at us, e.g. AJ5924F7E119. Unique, because a customer saying a reference must resolve to exactly one job.';
comment on column public.jobs.billing_event_id is
  'The charge this job produced, when it produced one. Null is honest: a job below the four-piece definition is free and has no charge to point at.';

create index if not exists jobs_account_idx  on public.jobs (account_id, created_at desc);
create index if not exists jobs_contact_idx  on public.jobs (contact_id, created_at desc);
create index if not exists jobs_status_idx   on public.jobs (status, created_at desc);
create index if not exists jobs_window_idx   on public.jobs (window_start) where status = 'booked';
create index if not exists jobs_call_idx     on public.jobs (call_sid);

alter table public.jobs enable row level security;
revoke all on public.jobs from anon, authenticated;
grant all on public.jobs to service_role;

-- ── the RPCs, at the names @ANSWERED-BUILD is already coding against ─────────────────────────

create or replace function public.sv_job_create(p_secret text, p_row jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare j public.jobs%rowtype; v_ref text; v_call_id uuid;
begin
  perform private.require(p_secret);

  v_ref := nullif(trim(p_row->>'job_ref'), '');
  if v_ref is null then
    return jsonb_build_object('ok', false, 'error', 'a job needs a reference the customer can quote back');
  end if;

  -- Idempotent on the reference. A retried booking webhook must not create a second appointment,
  -- and a second appointment would be a second charge.
  select * into j from public.jobs where job_ref = v_ref;
  if j.id is not null then
    return jsonb_build_object('ok', true, 'replay', true, 'job', to_jsonb(j));
  end if;

  if nullif(p_row->>'call_sid','') is not null then
    select id into v_call_id from public.calls where call_sid = p_row->>'call_sid';
  end if;

  insert into public.jobs (
    account_id, contact_id, job_ref, caller_name, address, callback,
    window_start, window_end, trade, after_hours, source, call_id, call_sid, details
  ) values (
    nullif(p_row->>'account_id','')::uuid,
    nullif(p_row->>'contact_id','')::uuid,
    v_ref,
    nullif(p_row->>'caller_name',''), nullif(p_row->>'address',''), nullif(p_row->>'callback',''),
    case when (p_row->>'window_start') is not null then (p_row->>'window_start')::timestamptz end,
    case when (p_row->>'window_end')   is not null then (p_row->>'window_end')::timestamptz end,
    nullif(p_row->>'trade',''),
    coalesce((p_row->>'after_hours')::boolean, false),
    coalesce(nullif(p_row->>'source',''), 'voice'),
    coalesce(nullif(p_row->>'call_id','')::uuid, v_call_id),
    nullif(p_row->>'call_sid',''),
    coalesce(p_row->'details', '{}'::jsonb)
  ) returning * into j;

  -- The unified timeline, so a job appears in the same feed as the call that produced it.
  insert into public.crm_activity (contact_id, account_id, kind, title, body, payload, source,
                                   ref_kind, ref_id)
  values (j.contact_id, j.account_id, 'job',
          'Job booked ' || j.job_ref || case when j.after_hours then ' (after hours)' else '' end,
          concat_ws(' · ', nullif(j.caller_name,''), nullif(j.address,''),
                    case when j.window_start is not null then to_char(j.window_start, 'Mon DD HH24:MI') end),
          to_jsonb(j), coalesce(j.source,'voice'), 'job', j.id::text);

  return jsonb_build_object('ok', true, 'replay', false, 'job', to_jsonb(j));
end $$;

create or replace function public.sv_jobs_for_account(
  p_secret text, p_account_id uuid, p_status text, p_limit integer
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  perform private.require(p_secret);
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb) into v from (
    select j.*, c.name as contact_business,
           (j.status = 'booked' and j.window_start is not null and j.window_start > now()) as upcoming
      from public.jobs j
      left join public.contacts c on c.id = j.contact_id
     where j.account_id = p_account_id
       and (p_status is null or j.status = p_status)
     order by j.created_at desc
     limit greatest(1, least(coalesce(p_limit, 200), 500))
  ) x;
  return v;
end $$;

create or replace function public.sv_job_by_ref(p_secret text, p_ref text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare j public.jobs%rowtype;
begin
  perform private.require(p_secret);
  select * into j from public.jobs where job_ref = p_ref;
  if j.id is null then return null; end if;
  return jsonb_build_object(
    'job', to_jsonb(j),
    'account', (select jsonb_build_object('id', a.id, 'business_name', a.business_name,
                                          'owner_email', a.owner_email)
                  from public.accounts a where a.id = j.account_id),
    'call', (select jsonb_build_object('call_sid', cl.call_sid, 'created_at', cl.created_at,
                                       'duration_seconds', cl.duration_seconds,
                                       'recording_sid', cl.recording_sid, 'summary', cl.summary)
               from public.calls cl where cl.id = j.call_id or cl.call_sid = j.call_sid limit 1),
    'charge', (select jsonb_build_object('id', be.id, 'cents', be.cents, 'kind', be.kind,
                                         'state', be.state, 'reason', be.reason)
                 from public.billing_events be where be.id = j.billing_event_id));
end $$;

-- A void is a status change plus a reason. The row survives, the charge is pointed at, and the
-- who and the when are recorded, because a dispute that leaves no trace cannot be audited.
create or replace function public.sv_job_void(
  p_secret text, p_ref text, p_reason text, p_actor text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare j public.jobs%rowtype;
begin
  perform private.require(p_secret);
  select * into j from public.jobs where job_ref = p_ref;
  if j.id is null then return jsonb_build_object('ok', false, 'error', 'no job with that reference'); end if;
  if j.status = 'voided' then
    return jsonb_build_object('ok', true, 'replay', true, 'job', to_jsonb(j),
      'note', 'already voided on ' || to_char(j.voided_at, 'YYYY-MM-DD HH24:MI'));
  end if;

  update public.jobs
     set status = 'voided', void_reason = nullif(p_reason,''), voided_at = now(),
         voided_by = coalesce(nullif(p_actor,''), 'customer'), updated_at = now()
   where id = j.id returning * into j;

  insert into public.crm_activity (contact_id, account_id, kind, title, body, payload, source,
                                   actor, ref_kind, ref_id)
  values (j.contact_id, j.account_id, 'job',
          'Job ' || j.job_ref || ' voided',
          coalesce(j.void_reason, 'no reason given'), to_jsonb(j), 'dispute',
          j.voided_by, 'job', j.id::text);

  return jsonb_build_object('ok', true, 'replay', false, 'job', to_jsonb(j),
    'note', 'The job is voided and the reason is recorded. Any charge attached to it is voided separately through the billing ledger, so the two facts stay independently auditable.');
end $$;

-- What /admin needs: every job, filterable, with the customer joined.
create or replace function public.sv_admin_jobs(
  p_secret text, p_q text, p_status text, p_account uuid, p_limit integer, p_offset integer
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb; n bigint; lim integer; off integer;
begin
  perform private.require(p_secret);
  lim := greatest(1, least(coalesce(p_limit, 50), 200));
  off := greatest(0, coalesce(p_offset, 0));

  select count(*) into n from public.jobs j
   where (p_status is null or j.status = p_status)
     and (p_account is null or j.account_id = p_account)
     and (p_q is null or p_q = '' or j.job_ref ilike '%'||p_q||'%'
          or coalesce(j.caller_name,'') ilike '%'||p_q||'%'
          or coalesce(j.address,'') ilike '%'||p_q||'%'
          or coalesce(j.callback,'') ilike '%'||p_q||'%');

  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v from (
    select j.id, j.job_ref, j.caller_name, j.address, j.callback, j.window_start, j.window_end,
           j.trade, j.after_hours, j.source, j.status, j.void_reason, j.created_at,
           j.account_id, a.business_name, j.call_sid,
           be.cents as charge_cents, be.state as charge_state
      from public.jobs j
      left join public.accounts a on a.id = j.account_id
      left join public.billing_events be on be.id = j.billing_event_id
     where (p_status is null or j.status = p_status)
       and (p_account is null or j.account_id = p_account)
       and (p_q is null or p_q = '' or j.job_ref ilike '%'||p_q||'%'
            or coalesce(j.caller_name,'') ilike '%'||p_q||'%'
            or coalesce(j.address,'') ilike '%'||p_q||'%'
            or coalesce(j.callback,'') ilike '%'||p_q||'%')
     order by j.created_at desc
     limit lim offset off
  ) x;

  return jsonb_build_object('total', n, 'limit', lim, 'offset', off, 'rows', v,
    'by_status', (select coalesce(jsonb_agg(jsonb_build_object('k', status, 'n', c) order by c desc), '[]'::jsonb)
                    from (select status, count(*) c from public.jobs group by 1) s));
end $$;;
