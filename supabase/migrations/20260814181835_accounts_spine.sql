-- 20260814181835_accounts_spine
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- The customer spine. Until now this database held the call spine only: who we
-- dialled and what happened. Nothing in it described a CUSTOMER, so a contractor
-- who said yes had nowhere to exist.
--
-- Same posture as every other table here: RLS on with no policies, so the
-- publishable key opens nothing, and every path in runs through a
-- security-definer RPC holding the shared secret.
--
-- Two honesty rules are enforced in the schema itself rather than in a comment:
--   1. A number row exists only when a real number exists. There is no
--      "pending" phone row with a null number, because a row that looks like a
--      provisioned line and is not one is exactly the lie this build refuses.
--      A line REQUEST is an account status plus an event.
--   2. Config history is append-only. A rule change on a line that answers a
--      stranger's emergency call is an auditable act, not an UPDATE.

create table if not exists public.accounts (
  id                 uuid primary key default gen_random_uuid(),
  business_name      text not null,
  owner_email        text not null,
  owner_name         text,
  owner_phone        text,
  trade              text,
  timezone           text not null default 'America/Los_Angeles',
  status             text not null default 'draft'
                       check (status in ('draft','configuring','ready','awaiting_line','live','paused','closed')),
  email_verified_at  timestamptz,
  ready_at           timestamptz,
  requested_line_at  timestamptz,
  live_at            timestamptz,
  wanted_area_code   text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
comment on column public.accounts.status is
  'draft: created, email never confirmed. configuring: confirmed, rules incomplete. ready: rules complete, no line asked for. awaiting_line: owner asked for a line and a human has not assigned one. live: a provisioned number resolves to this account. Nothing sets live except an explicit operator assignment of a real number.';

create unique index if not exists accounts_owner_email_key on public.accounts (lower(owner_email));
create index if not exists accounts_status_idx on public.accounts (status);

create table if not exists public.account_config (
  account_id          uuid primary key references public.accounts(id) on delete cascade,
  version             integer not null default 1,
  greeting_name       text,
  business_says       text,
  hours               jsonb   not null default '{}'::jsonb,
  after_hours         text    not null default 'take_message'
                        check (after_hours in ('take_message','book','urgent_only','transfer')),
  service_area        text,
  services            text[]  not null default '{}',
  never_say           text[]  not null default '{}',
  always_ask          text[]  not null default '{}',
  quote_policy        text    not null default 'never'
                        check (quote_policy in ('never','range','exact')),
  price_notes         text,
  booking_mode        text    not null default 'sends_invite'
                        check (booking_mode in ('sends_invite','writes_directly','message_only')),
  booking_destination text,
  escalation_phone    text,
  escalation_when     text    not null default 'emergency'
                        check (escalation_when in ('never','emergency','on_request','always')),
  monthly_cap_cents   integer not null default 54900 check (monthly_cap_cents between 0 and 10000000),
  updated_at          timestamptz not null default now(),
  updated_by          text
);
comment on column public.account_config.booking_mode is
  'sends_invite: the agent emails an invitation a human must accept. writes_directly: the agent writes the booking into a calendar we hold credentials for. message_only: the agent never books, it takes a message. The page must print the one that is true, because a caller told a job is booked when only an invite was sent is a broken promise made in our voice.';
comment on column public.account_config.monthly_cap_cents is
  'The owner-adjustable meter cap. Default 54900 = the published $549 cap.';

create table if not exists public.account_config_versions (
  id         bigserial primary key,
  account_id uuid not null references public.accounts(id) on delete cascade,
  version    integer not null,
  config     jsonb not null,
  author     text,
  at         timestamptz not null default now()
);
create index if not exists account_config_versions_acct_idx on public.account_config_versions (account_id, version desc);

create table if not exists public.account_numbers (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references public.accounts(id) on delete cascade,
  phone          text not null unique,
  twilio_sid     text unique,
  kind           text not null default 'answered' check (kind in ('answered','forward_target')),
  status         text not null default 'provisioned' check (status in ('provisioned','released')),
  provisioned_at timestamptz not null default now(),
  released_at    timestamptz,
  assigned_by    text,
  notes          text
);
create index if not exists account_numbers_acct_idx on public.account_numbers (account_id);

create table if not exists public.account_tokens (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references public.accounts(id) on delete cascade,
  purpose     text not null default 'login' check (purpose in ('login','verify_email')),
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  issued_ip   text,
  issued_ua   text,
  consumed_ip text,
  at          timestamptz not null default now()
);
comment on table public.account_tokens is
  'Only the sha256 of the emailed token is stored. A database read can never mint a session.';
create index if not exists account_tokens_acct_idx on public.account_tokens (account_id, at desc);

create table if not exists public.account_events (
  id         bigserial primary key,
  account_id uuid references public.accounts(id) on delete cascade,
  kind       text not null,
  payload    jsonb not null default '{}'::jsonb,
  actor      text,
  at         timestamptz not null default now()
);
create index if not exists account_events_acct_idx on public.account_events (account_id, at desc);

alter table public.accounts                 enable row level security;
alter table public.account_config           enable row level security;
alter table public.account_config_versions  enable row level security;
alter table public.account_numbers          enable row level security;
alter table public.account_tokens           enable row level security;
alter table public.account_events           enable row level security;

revoke all on public.accounts, public.account_config, public.account_config_versions,
                public.account_numbers, public.account_tokens, public.account_events
  from anon, authenticated;;
