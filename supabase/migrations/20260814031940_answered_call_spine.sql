-- 20260814031940_answered_call_spine
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- ANSWERED: the call spine.
-- Every line we own, every contact, every call, every word spoken, every legal decision.
-- RLS is on and denies everything by default: the only reader is the server-side gated cockpit
-- function holding the service role key. Nothing in this database is reachable from a browser.

create extension if not exists "pgcrypto";

-- ── LINES ────────────────────────────────────────────────────────────────────────────────────
-- Our phone numbers. Designed for 100+ from day one: a pool with per-line pacing, health and
-- reputation, so a burned number is rested rather than silently poisoning a whole campaign.
create table public.lines (
  id                uuid primary key default gen_random_uuid(),
  phone             text not null unique,
  twilio_sid        text unique,
  label             text,
  purpose           text not null default 'research'
                    check (purpose in ('research','discovery','demo','sales','inbound','overflow')),
  status            text not null default 'active'
                    check (status in ('active','resting','quarantined','retired')),
  area_code         text,
  daily_cap         int not null default 80,
  calls_today       int not null default 0,
  calls_total       int not null default 0,
  answer_rate       numeric,
  reputation        text default 'unknown' check (reputation in ('unknown','clean','at_risk','flagged')),
  reputation_at     timestamptz,
  rest_until        timestamptz,
  provisioned_at    timestamptz default now(),
  notes             text
);
comment on column public.lines.rest_until is
  'A number that has been dialling hard gets rested. Carrier analytics flag velocity, and a flagged number cannot be un-flagged quickly.';

-- ── CONTACTS ─────────────────────────────────────────────────────────────────────────────────
create table public.contacts (
  id                uuid primary key default gen_random_uuid(),
  phone             text not null unique,
  name              text,
  trade             text,
  state             text,
  city              text,
  street            text,
  website           text,
  lat               numeric,
  lon               numeric,
  source            text,
  source_id         text,
  -- line type intelligence, the input to the legal gate
  line_type         text,
  carrier           text,
  lookup_ok         boolean,
  lookup_at         timestamptz,
  -- gate state, recomputed on every dial and stored so the decision is auditable after the fact
  lane              text check (lane in ('green','amber','red','hold')),
  lane_reasons      text[],
  consent           jsonb,
  suppressed        boolean not null default false,
  suppressed_reason text,
  suppressed_at     timestamptz,
  -- crm
  disposition       text not null default 'new'
                    check (disposition in ('new','queued','attempted','reached','interested','shadow_week',
                                           'callback','not_interested','bad_number','do_not_call','customer')),
  owner             text,
  tags              text[] default '{}',
  score             int,
  first_contacted_at timestamptz,
  last_contacted_at  timestamptz,
  call_count        int not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index contacts_lane_idx        on public.contacts (lane);
create index contacts_disposition_idx on public.contacts (disposition);
create index contacts_state_trade_idx on public.contacts (state, trade);
create index contacts_line_type_idx   on public.contacts (line_type);
create index contacts_name_trgm       on public.contacts using gin (to_tsvector('english', coalesce(name,'') || ' ' || coalesce(city,'')));

-- ── CAMPAIGNS ────────────────────────────────────────────────────────────────────────────────
create table public.campaigns (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  mode            text not null default 'discovery'
                  check (mode in ('measure','discovery','manual')),
  status          text not null default 'draft'
                  check (status in ('draft','armed','running','paused','done','halted')),
  autopilot       boolean not null default false,
  pacing_per_min  int not null default 4,
  max_concurrent  int not null default 3,
  policy          jsonb not null default '{}'::jsonb,
  script          jsonb not null default '{}'::jsonb,
  line_ids        uuid[] default '{}',
  stats           jsonb not null default '{}'::jsonb,
  halt_reason     text,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  ended_at        timestamptz
);
comment on column public.campaigns.halt_reason is
  'Autopilot writes here when it stops itself. A campaign that halts must say why in words an operator can read.';

-- ── CALLS ────────────────────────────────────────────────────────────────────────────────────
create table public.calls (
  id                uuid primary key default gen_random_uuid(),
  call_sid          text unique,
  parent_call_sid   text,
  conference_sid    text,
  conference_name   text,
  contact_id        uuid references public.contacts(id) on delete set null,
  campaign_id       uuid references public.campaigns(id) on delete set null,
  line_id           uuid references public.lines(id) on delete set null,
  direction         text not null default 'outbound' check (direction in ('outbound','inbound')),
  from_number       text,
  to_number         text,
  status            text,
  answered_by       text,
  ring_seconds      numeric,
  duration_seconds  int,
  queued_at         timestamptz default now(),
  started_at        timestamptz,
  answered_at       timestamptz,
  ended_at          timestamptz,
  recording_sid     text,
  recording_url     text,
  recording_seconds int,
  transcript        text,
  summary           text,
  sentiment         text,
  ai_notes          jsonb,
  disposition       text,
  outcome           jsonb,
  -- THE LEGAL RECORD. The gate verdict exactly as it stood at the moment of dialling.
  gate              jsonb,
  operator          text,
  placed            boolean not null default false,
  refused_reason    text,
  cost_usd          numeric,
  created_at        timestamptz not null default now()
);
create index calls_contact_idx   on public.calls (contact_id, created_at desc);
create index calls_campaign_idx  on public.calls (campaign_id, created_at desc);
create index calls_status_idx    on public.calls (status) where status in ('queued','initiated','ringing','in-progress');
create index calls_created_idx   on public.calls (created_at desc);

comment on column public.calls.placed is
  'False for a call the gate refused. Refusals are recorded, never discarded: the refusals are the proof the gate ran.';

-- ── CALL EVENTS ──────────────────────────────────────────────────────────────────────────────
create table public.call_events (
  id         bigserial primary key,
  call_sid   text,
  kind       text not null,
  payload    jsonb,
  at         timestamptz not null default now()
);
create index call_events_sid_idx on public.call_events (call_sid, at);

-- ── LIVE TRANSCRIPT ──────────────────────────────────────────────────────────────────────────
-- One row per utterance. Partials update in place by (call_sid, seq, track); finals supersede.
create table public.transcript_lines (
  id          bigserial primary key,
  call_sid    text not null,
  seq         int not null default 0,
  track       text,
  speaker     text,
  text        text not null,
  confidence  numeric,
  is_final    boolean not null default false,
  at          timestamptz not null default now(),
  unique (call_sid, seq, track)
);
create index transcript_call_idx on public.transcript_lines (call_sid, at);

-- ── MESSAGES ─────────────────────────────────────────────────────────────────────────────────
create table public.messages (
  id           uuid primary key default gen_random_uuid(),
  message_sid  text unique,
  contact_id   uuid references public.contacts(id) on delete set null,
  line_id      uuid references public.lines(id) on delete set null,
  direction    text not null check (direction in ('outbound','inbound')),
  from_number  text,
  to_number    text,
  body         text,
  status       text,
  error_code   text,
  operator     text,
  at           timestamptz not null default now()
);
create index messages_contact_idx on public.messages (contact_id, at desc);

-- ── CONSENT ──────────────────────────────────────────────────────────────────────────────────
-- Every basis on which we were allowed to call someone. Append only.
create table public.consent (
  id          uuid primary key default gen_random_uuid(),
  phone       text not null,
  scope       text not null default 'research_call',
  written     boolean not null default false,
  source      text not null,
  evidence    jsonb,
  ip          inet,
  user_agent  text,
  granted_at  timestamptz not null default now(),
  expires_at  timestamptz
);
create index consent_phone_idx on public.consent (phone, granted_at desc);

-- ── SUPPRESSION ──────────────────────────────────────────────────────────────────────────────
-- The list no campaign can bypass. There is deliberately no delete policy.
create table public.suppression (
  phone   text primary key,
  reason  text not null,
  source  text,
  at      timestamptz not null default now()
);

-- ── NOTES ────────────────────────────────────────────────────────────────────────────────────
create table public.notes (
  id          uuid primary key default gen_random_uuid(),
  contact_id  uuid references public.contacts(id) on delete cascade,
  call_sid    text,
  body        text not null,
  author      text,
  pinned      boolean not null default false,
  at          timestamptz not null default now()
);
create index notes_contact_idx on public.notes (contact_id, at desc);

-- ── A SUPPRESSION IS ABSOLUTE ────────────────────────────────────────────────────────────────
-- Adding a number to suppression must also mark the contact, in the same transaction, so the two
-- can never disagree. Enforcement in the database, not in whichever caller remembered to do it.
create or replace function public.apply_suppression() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.contacts
     set suppressed = true,
         suppressed_reason = new.reason,
         suppressed_at = new.at,
         disposition = 'do_not_call',
         updated_at = now()
   where phone = new.phone;
  return new;
end $$;

create trigger suppression_applies_to_contact
  after insert on public.suppression
  for each row execute function public.apply_suppression();

-- ── TOUCH updated_at ─────────────────────────────────────────────────────────────────────────
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

create trigger contacts_touch before update on public.contacts
  for each row execute function public.touch_updated_at();

-- ── RLS: deny everything. The service role bypasses RLS; nothing else gets in. ────────────────
alter table public.lines            enable row level security;
alter table public.contacts         enable row level security;
alter table public.campaigns        enable row level security;
alter table public.calls            enable row level security;
alter table public.call_events      enable row level security;
alter table public.transcript_lines enable row level security;
alter table public.messages         enable row level security;
alter table public.consent          enable row level security;
alter table public.suppression      enable row level security;
alter table public.notes            enable row level security;;
