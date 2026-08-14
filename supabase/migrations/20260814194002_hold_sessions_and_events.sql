-- 20260814194002_hold_sessions_and_events
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- HOLD: the session spine. @LANE-HOLD, 2026-08-14. Additive only; nothing here drops, renames
-- or redefines an existing object.
--
-- One row per errand, not per call, because the product's promise is "one price for the whole
-- errand, however many redials it takes". A redial is an attempt on the SAME session, so the
-- charge can never multiply by accident: there is exactly one place a charge can be written.

create table if not exists public.hold_sessions (
  id                  uuid primary key default gen_random_uuid(),
  -- 192 bits. The customer has no account, so the link IS the credential, same posture as truce.
  token               text not null unique,
  created_at          timestamptz not null default now(),

  -- who asked, and where we ring them back
  account_key         text,
  requester_phone     text not null,
  requester_email     text,
  requester_name      text,
  requester_state     text,

  -- the line we work
  target_phone        text not null,
  target_label        text not null,
  target_state        text,
  reason              text not null,
  reference           text,

  -- ★ PRICE CLASS IS EVIDENCE, NOT A GUESS. 'commercial' ($10) is the default because it is the
  -- CHEAPER of the two. A government line is $20, so the higher price is only ever reached from a
  -- recorded source. An unproved upgrade falls toward the customer, exactly as lib/meter.mjs
  -- already does for an after-hours booking with no timestamp.
  line_class          text not null default 'commercial',
  line_class_source   text not null default 'default_commercial',
  line_type           text,
  lookup_ok           boolean,

  tree_plan           jsonb not null default '[]'::jsonb,
  digits_sent         jsonb not null default '[]'::jsonb,
  menu_depth          int  not null default 0,
  attempts            int  not null default 0,

  status              text not null default 'queued',
  outcome             text,
  outcome_reason      text,

  call_sid            text,
  bridge_call_sid     text,
  conference_name     text,
  gate                jsonb,
  consent_id          uuid,
  detector            jsonb not null default '{}'::jsonb,

  queued_at           timestamptz not null default now(),
  dialed_at           timestamptz,
  answered_at         timestamptz,
  hold_started_at     timestamptz,
  human_at            timestamptz,
  announced_at        timestamptz,
  bridged_at          timestamptz,
  ended_at            timestamptz,

  -- the two clocks the receipt prints, kept as measurements rather than derived at render time
  machine_wait_ms     bigint not null default 0,
  user_wait_ms        bigint not null default 0,

  charge_kind         text,
  charge_cents        int,
  charge_gross_cents  int,
  charge_reason       text,
  bill_event_id       uuid,

  recording_sid       text,
  recording_url       text,
  recording_seconds   int,
  operator_note       text,

  constraint hold_line_class_known check (line_class in ('gov','commercial')),
  constraint hold_status_known check (status in
    ('queued','refused','dialing','ringing','navigating','holding','announcing','bridging','bridged','ended')),
  constraint hold_requester_e164 check (requester_phone ~ '^\+\d{8,15}$'),
  constraint hold_target_e164 check (target_phone ~ '^\+\d{8,15}$')
);

comment on table public.hold_sessions is
  'One row per Hold errand. A redial is an attempt on the same row, never a new session, so the "one price for the whole errand" promise cannot be broken by a reconnect.';
comment on column public.hold_sessions.line_class is
  'gov ($20) or commercial ($10). Defaults to the cheaper one; the dearer one needs a recorded source in line_class_source.';
comment on column public.hold_sessions.token is
  'The capability link. 192 bits of randomness IS the credential for this one session, because a Hold customer has no account.';

create index if not exists hold_sessions_status_idx  on public.hold_sessions (status, created_at desc);
create index if not exists hold_sessions_call_idx    on public.hold_sessions (call_sid);
create index if not exists hold_sessions_bridge_idx  on public.hold_sessions (bridge_call_sid);
create index if not exists hold_sessions_conf_idx    on public.hold_sessions (conference_name);

create table if not exists public.hold_events (
  id          bigserial primary key,
  session_id  uuid not null references public.hold_sessions(id) on delete cascade,
  at          timestamptz not null default now(),
  kind        text not null,
  payload     jsonb not null default '{}'::jsonb
);
comment on table public.hold_events is
  'Every state change, every digit sent, every detector verdict with the words that produced it. This is what the Hold Receipt is rendered from, so it is written even when nothing goes wrong.';
create index if not exists hold_events_session_idx on public.hold_events (session_id, at);
create index if not exists hold_events_kind_idx    on public.hold_events (kind, at desc);

-- Same posture as every other table here: RLS on, no policies, and no grant to any role. The
-- publishable key opens nothing; access is only ever through a security-definer function.
alter table public.hold_sessions enable row level security;
alter table public.hold_events   enable row level security;
revoke all on public.hold_sessions from anon, authenticated;
revoke all on public.hold_events   from anon, authenticated;;
