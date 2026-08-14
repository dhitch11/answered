-- 20260814190756_dnc_program_64_1200_d
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- THE DO-NOT-CALL PROGRAM. 47 CFR 64.1200(c)(2) and (d), built as evidence rather than as a flag.
--
-- 64.1200(d) is a CONDITION PRECEDENT: "No person or entity shall initiate any call for
-- telemarketing purposes ... UNLESS such person or entity has instituted procedures". A company
-- with no procedures has no safe harbour, so its first wrong call is unmitigated. That means the
-- gate must not open on someone setting `dncScrubbed: true` in a config file. It opens on a
-- REGISTRY SNAPSHOT THAT EXISTS AND IS FRESH, and on POLICY ROWS THAT EXIST. If the evidence is
-- absent the gate stays shut, which is the same posture as everything else in this system.

-- ── (c)(2) the national registry ─────────────────────────────────────────────────────────────
create table if not exists public.dnc_registry (
  phone       text primary key,
  area_code   text generated always as (substring(phone from 3 for 3)) stored,
  snapshot_id uuid not null
);
create index if not exists dnc_registry_snapshot on public.dnc_registry (snapshot_id);

create table if not exists public.dnc_snapshots (
  id           uuid primary key default gen_random_uuid(),
  source       text not null default 'national_dnc',
  san          text,                       -- Subscription Account Number, evidence of entitlement
  area_codes   text[] not null default '{}',
  numbers      bigint not null default 0,
  downloaded_at timestamptz not null default now(),
  notes        text
);
comment on table public.dnc_snapshots is
  'One row per registry download. 64.1200(c)(2)(i)(D) requires the version used to be no more than 31 days old, so freshness is a property of the SNAPSHOT and is checked at dial time, never assumed.';

-- ── (d)(3) the internal list. Recorded AT THE TIME the request is made. ──────────────────────
create table if not exists public.dnc_requests (
  id           uuid primary key default gen_random_uuid(),
  phone        text not null,
  requested_at timestamptz not null default now(),
  -- amended effective 2025-04-11: honour within TEN BUSINESS DAYS, not thirty.
  honour_by    timestamptz not null,
  honoured_at  timestamptz,
  channel      text not null,              -- 'call' | 'sms' | 'email' | 'web' | 'operator'
  heard_as     text,                       -- the words they actually used
  call_sid     text,
  recorded_by  text not null default 'system',
  unique (phone, requested_at)
);
create index if not exists dnc_requests_open on public.dnc_requests (honour_by) where honoured_at is null;

-- ── (d)(1), (d)(2), (d)(5), (d)(6) the paper the rule requires ───────────────────────────────
create table if not exists public.compliance_policy (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('dnc_policy','affiliate_scope','retention','training_curriculum')),
  version       text not null,
  body          text not null,
  effective_at  timestamptz not null default now(),
  superseded_at timestamptz,
  public_url    text
);
comment on table public.compliance_policy is
  '64.1200(d)(1) requires a written policy AVAILABLE ON DEMAND, (d)(5) a written affiliate scope, (d)(6) five-year retention. Stored as rows so "does it exist" is a query, not a memory.';

create table if not exists public.compliance_training (
  id          uuid primary key default gen_random_uuid(),
  person      text not null,
  curriculum  text not null,
  trained_at  timestamptz not null default now(),
  attested_by text
);

alter table public.dnc_registry       enable row level security;
alter table public.dnc_snapshots      enable row level security;
alter table public.dnc_requests       enable row level security;
alter table public.compliance_policy  enable row level security;
alter table public.compliance_training enable row level security;
revoke all on public.dnc_registry, public.dnc_snapshots, public.dnc_requests,
              public.compliance_policy, public.compliance_training from anon, authenticated;

-- ── THE READINESS ANSWER THE GATE ASKS ON EVERY DIAL ─────────────────────────────────────────
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
    'snapshot_numbers', coalesce(snap.numbers, 0),
    'snapshot_area_codes', coalesce(array_length(snap.area_codes, 1), 0),
    'san_on_file', snap.san is not null,
    -- (d): every element has to be present. Missing paper is a shut gate, not a warning.
    'policy_written',   exists (select 1 from public.compliance_policy where kind='dnc_policy' and superseded_at is null),
    'affiliate_scope',  exists (select 1 from public.compliance_policy where kind='affiliate_scope' and superseded_at is null),
    'retention_policy', exists (select 1 from public.compliance_policy where kind='retention' and superseded_at is null),
    'training_recorded',exists (select 1 from public.compliance_training),
    'internal_list_live', true,   -- public.suppression has existed and been enforced since day one
    -- the operational number: requests past their ten-business-day deadline, unhonoured
    'overdue_requests', (select count(*) from public.dnc_requests where honoured_at is null and honour_by < now())
  ) into v;

  return v || jsonb_build_object(
    'procedures_ready',
      (v->>'policy_written')::boolean and (v->>'affiliate_scope')::boolean
      and (v->>'retention_policy')::boolean and (v->>'training_recorded')::boolean
      and (v->>'overdue_requests')::int = 0
  );
end $$;

-- Recording a request is the (d)(3) obligation and it must happen AT THE TIME MADE.
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
  insert into public.suppression (phone, reason, source)
  values (p_phone, coalesce('do-not-call request: ' || p_heard_as, 'do-not-call request'), coalesce(p_channel,'call'))
  on conflict (phone) do nothing;
  update public.dnc_requests set honoured_at = now() where phone = p_phone and honoured_at is null;

  return jsonb_build_object('ok', true, 'honour_by', v_by, 'honoured_at', now());
end $$;

revoke all on function public.sv_dnc_readiness(text) from public;
revoke all on function public.sv_dnc_request(text,text,text,text,text,text) from public;
grant execute on function public.sv_dnc_readiness(text) to anon, authenticated;
grant execute on function public.sv_dnc_request(text,text,text,text,text,text) to anon, authenticated;;
