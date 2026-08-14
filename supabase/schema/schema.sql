-- answered-prod, current database definition.
-- Exported 2026-08-14T23:36:36.316595+00:00 by scripts/dump-schema.mjs. Postgres 17.6.
--
-- STRUCTURE ONLY. This file contains no row data of any kind.
-- This is what the database IS. supabase/migrations/ is how it got here. Both are kept
-- because they answer different questions and they diverge the moment anyone runs SQL
-- outside a migration.

-- ──────────────────────────────────────────────────────────────────────────────────────────
-- EXTENSIONS
-- ──────────────────────────────────────────────────────────────────────────────────────────

-- pg_stat_statements 1.11
-- pgcrypto 1.3
-- plpgsql 1.0
-- supabase_vault 0.3.1
-- uuid-ossp 1.1

-- ──────────────────────────────────────────────────────────────────────────────────────────
-- SCHEMAS
-- ──────────────────────────────────────────────────────────────────────────────────────────

create schema if not exists auth;
create schema if not exists extensions;
create schema if not exists graphql;
create schema if not exists graphql_public;
create schema if not exists private;
create schema if not exists quarantine;
create schema if not exists realtime;
create schema if not exists sealed;
create schema if not exists storage;
create schema if not exists supabase_migrations;
create schema if not exists vault;

-- ──────────────────────────────────────────────────────────────────────────────────────────
-- TABLES
-- ──────────────────────────────────────────────────────────────────────────────────────────

-- private.app_secret
create table if not exists private.app_secret (
  id integer default 1 not null,
  secret_hash text not null,
  rotated_at timestamp with time zone default now() not null
);

-- public.account_config   [RLS ENABLED]
create table if not exists public.account_config (
  account_id uuid not null,
  version integer default 1 not null,
  greeting_name text,
  business_says text,
  hours jsonb default '{}'::jsonb not null,
  after_hours text default 'take_message'::text not null,
  service_area text,
  services ARRAY default '{}'::text[] not null,
  never_say ARRAY default '{}'::text[] not null,
  always_ask ARRAY default '{}'::text[] not null,
  quote_policy text default 'never'::text not null,
  price_notes text,
  booking_mode text default 'sends_invite'::text not null,
  booking_destination text,
  escalation_phone text,
  escalation_when text default 'emergency'::text not null,
  monthly_cap_cents integer default 54900 not null,
  updated_at timestamp with time zone default now() not null,
  updated_by text
);
comment on column public.account_config.booking_mode is $c$sends_invite: the agent emails an invitation a human must accept. writes_directly: the agent writes the booking into a calendar we hold credentials for. message_only: the agent never books, it takes a message. The page must print the one that is true, because a caller told a job is booked when only an invite was sent is a broken promise made in our voice.$c$;
comment on column public.account_config.monthly_cap_cents is $c$The owner-adjustable meter cap. Default 54900 = the published $549 cap.$c$;
alter table public.account_config enable row level security;

-- public.account_config_versions   [RLS ENABLED]
create table if not exists public.account_config_versions (
  id bigint default nextval('account_config_versions_id_seq'::regclass) not null,
  account_id uuid not null,
  version integer not null,
  config jsonb not null,
  author text,
  at timestamp with time zone default now() not null
);
alter table public.account_config_versions enable row level security;

-- public.account_events   [RLS ENABLED]
create table if not exists public.account_events (
  id bigint default nextval('account_events_id_seq'::regclass) not null,
  account_id uuid,
  kind text not null,
  payload jsonb default '{}'::jsonb not null,
  actor text,
  at timestamp with time zone default now() not null
);
alter table public.account_events enable row level security;

-- public.account_notify   [RLS ENABLED]
create table if not exists public.account_notify (
  account_id uuid not null,
  email_extra ARRAY default '{}'::text[] not null,
  sms_on boolean default true not null,
  sms_to text,
  call_on boolean default false not null,
  call_after_hours_only boolean default true not null,
  call_to text,
  updated_at timestamp with time zone default now() not null,
  updated_by text
);
alter table public.account_notify enable row level security;

-- public.account_numbers   [RLS ENABLED]
create table if not exists public.account_numbers (
  id uuid default gen_random_uuid() not null,
  account_id uuid not null,
  phone text not null,
  twilio_sid text,
  kind text default 'answered'::text not null,
  status text default 'provisioned'::text not null,
  provisioned_at timestamp with time zone default now() not null,
  released_at timestamp with time zone,
  assigned_by text,
  notes text
);
alter table public.account_numbers enable row level security;

-- public.account_tokens   [RLS ENABLED]
--   Only the sha256 of the emailed token is stored. A database read can never mint a session.
create table if not exists public.account_tokens (
  id uuid default gen_random_uuid() not null,
  account_id uuid not null,
  purpose text default 'login'::text not null,
  token_hash text not null,
  expires_at timestamp with time zone not null,
  consumed_at timestamp with time zone,
  issued_ip text,
  issued_ua text,
  consumed_ip text,
  at timestamp with time zone default now() not null,
  sent_at timestamp with time zone
);
comment on column public.account_tokens.sent_at is $c$Set only after the mail provider accepted the message. Null means this link was minted and never sent, and it must not count against the rate limit.$c$;
alter table public.account_tokens enable row level security;

-- public.accounts   [RLS ENABLED]
create table if not exists public.accounts (
  id uuid default gen_random_uuid() not null,
  business_name text not null,
  owner_email text not null,
  owner_name text,
  owner_phone text,
  trade text,
  timezone text default 'America/Los_Angeles'::text not null,
  status text default 'draft'::text not null,
  email_verified_at timestamp with time zone,
  ready_at timestamp with time zone,
  requested_line_at timestamp with time zone,
  live_at timestamp with time zone,
  wanted_area_code text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  billing_account_key text
);
comment on column public.accounts.status is $c$draft: created, email never confirmed. configuring: confirmed, rules incomplete. ready: rules complete, no line asked for. awaiting_line: owner asked for a line and a human has not assigned one. live: a provisioned number resolves to this account. Nothing sets live except an explicit operator assignment of a real number.$c$;
comment on column public.accounts.billing_account_key is $c$Points at public.billing_accounts.account_key. Null means this business has no billing record yet, which is the true state for every account until the billing lane creates one.$c$;
alter table public.accounts enable row level security;

-- public.admin_audit   [RLS ENABLED]
--   Append only. The UPDATE and DELETE trigger below is the enforcement; a policy that lives only in application code is a policy the next lane does not know about.
create table if not exists public.admin_audit (
  id bigint default nextval('admin_audit_id_seq'::regclass) not null,
  admin_id uuid,
  actor_email text,
  action text not null,
  target_kind text,
  target_id text,
  payload jsonb default '{}'::jsonb not null,
  result text,
  ip text,
  ua text,
  at timestamp with time zone default now() not null
);
alter table public.admin_audit enable row level security;

-- public.admin_sessions   [RLS ENABLED]
--   Only the sha256 of the session token is stored, so a database read can never mint a session. The row exists so a session can be REVOKED server side; a bare signed cookie cannot be taken back before it expires.
create table if not exists public.admin_sessions (
  id uuid default gen_random_uuid() not null,
  admin_id uuid not null,
  token_hash text not null,
  issued_at timestamp with time zone default now() not null,
  expires_at timestamp with time zone not null,
  last_seen_at timestamp with time zone,
  revoked_at timestamp with time zone,
  ip text,
  ua text
);
alter table public.admin_sessions enable row level security;

-- public.admin_users   [RLS ENABLED]
create table if not exists public.admin_users (
  id uuid default gen_random_uuid() not null,
  email text not null,
  name text,
  password_hash text not null,
  role text default 'owner'::text not null,
  status text default 'active'::text not null,
  must_change boolean default false not null,
  last_login_at timestamp with time zone,
  last_login_ip text,
  failed_count integer default 0 not null,
  locked_until timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
comment on column public.admin_users.password_hash is $c$scrypt$N$r$p$salt_b64$hash_b64. A verifier, never a password. Nothing in this database or any log can be replayed as a credential.$c$;
comment on column public.admin_users.locked_until is $c$Set by the login path after repeated failures. Lockout is stored here rather than in memory because a Netlify function has no memory between invocations, so an in-process rate limiter would count to one forever.$c$;
alter table public.admin_users enable row level security;

-- public.agent_tool_calls   [RLS ENABLED]
--   One row per mid-call tool ACTION taken by a voice agent. idem_key is the atomic claim: a retried tool call finds the row and replays the stored result instead of acting twice. @LANE-BOOK 2026-08-14.
create table if not exists public.agent_tool_calls (
  id bigint default nextval('agent_tool_calls_id_seq'::regclass) not null,
  idem_key text not null,
  tool text not null,
  conversation text,
  call_sid text,
  args jsonb default '{}'::jsonb not null,
  status text default 'running'::text not null,
  result jsonb,
  created_at timestamp with time zone default now() not null,
  settled_at timestamp with time zone
);
alter table public.agent_tool_calls enable row level security;

-- public.app_events   [RLS ENABLED]
--   Behavioural events, queryable. anon_id carries a first-party id set before signup so pre-account activity can be stitched to an account afterwards without ever storing a raw IP. ip_sha256 is a hash, never the address.
create table if not exists public.app_events (
  id bigint default nextval('app_events_id_seq'::regclass) not null,
  account_id uuid,
  anon_id text,
  session_id text,
  name text not null,
  page text,
  meta jsonb default '{}'::jsonb not null,
  ua text,
  ip_sha256 text,
  source text default 'web'::text not null,
  at timestamp with time zone default now() not null
);
alter table public.app_events enable row level security;

-- public.billing_accounts   [RLS ENABLED]
create table if not exists public.billing_accounts (
  id uuid default gen_random_uuid() not null,
  account_key text not null,
  business_name text not null,
  email text not null,
  phone text,
  plan text default 'standard'::text not null,
  cap_cents integer default 54900 not null,
  pending_cap_cents integer,
  pending_cap_month date,
  quiet_notice_at timestamp with time zone,
  stripe_customer_id text,
  card_on_file boolean default false not null,
  card_brand text,
  card_last4 text,
  statement_token text not null,
  status text default 'active'::text not null,
  created_at timestamp with time zone default now() not null,
  account_id uuid
);
comment on column public.billing_accounts.pending_cap_month is $c$The first cycle a changed cap may apply to. A cap never moves inside a cycle the customer is already standing in.$c$;
comment on column public.billing_accounts.card_on_file is $c$Set only by the Stripe webhook after a real setup intent succeeded. Never set optimistically by the page that opened checkout.$c$;
comment on column public.billing_accounts.account_id is $c$The customer this bill belongs to. Nullable only so a billing row can exist before its account does; every path that creates both must set it. account_key remains the external handle Stripe keys on.$c$;
alter table public.billing_accounts enable row level security;

-- public.billing_events   [RLS ENABLED]
create table if not exists public.billing_events (
  id uuid default gen_random_uuid() not null,
  account_id uuid not null,
  idem_key text not null,
  kind text not null,
  product text,
  label text,
  occurred_at timestamp with time zone default now() not null,
  cycle_month date not null,
  gross_cents integer default 0 not null,
  cap_applied_cents integer default 0 not null,
  credit_applied_cents integer default 0 not null,
  credit_created_cents integer default 0 not null,
  cents integer default 0 not null,
  billable boolean default false not null,
  rated_ok boolean default true not null,
  counts_toward_cap boolean default false not null,
  reason text not null,
  evidence jsonb default '{}'::jsonb not null,
  rating jsonb default '{}'::jsonb not null,
  state text default 'open'::text not null,
  voided_at timestamp with time zone,
  void_reason text,
  voided_by text,
  stripe_invoice_item_id text,
  stripe_invoice_id text,
  created_at timestamp with time zone default now() not null
);
comment on column public.billing_events.idem_key is $c$The caller handle on this outcome, usually a call sid or a deal id. The unique index is the whole idempotency story: a retried webhook cannot bill twice.$c$;
comment on column public.billing_events.rating is $c$The complete rating as the engine produced it, frozen. A bill is never re-derived from today price book.$c$;
alter table public.billing_events enable row level security;

-- public.billing_invoices   [RLS ENABLED]
create table if not exists public.billing_invoices (
  id uuid default gen_random_uuid() not null,
  account_id uuid not null,
  cycle_month date not null,
  stripe_invoice_id text,
  status text default 'draft'::text not null,
  total_cents integer default 0 not null,
  hosted_url text,
  created_at timestamp with time zone default now() not null,
  finalized_at timestamp with time zone,
  paid_at timestamp with time zone
);
alter table public.billing_invoices enable row level security;

-- public.billing_refunds   [RLS ENABLED]
create table if not exists public.billing_refunds (
  id uuid default gen_random_uuid() not null,
  account_id uuid not null,
  billing_event_id uuid,
  stripe_refund_id text,
  stripe_invoice_id text,
  stripe_charge_id text,
  amount_cents integer not null,
  currency text default 'usd'::text not null,
  reason text,
  note text,
  status text default 'pending'::text not null,
  failure_reason text,
  idem_key text not null,
  created_by text,
  created_at timestamp with time zone default now() not null,
  settled_at timestamp with time zone
);
comment on column public.billing_refunds.status is $c$recorded_offline means money moved outside Stripe and an operator recorded it. It is a distinct state on purpose: a refund we did not execute must never read as one we did.$c$;
comment on column public.billing_refunds.idem_key is $c$The whole idempotency story. A double-clicked refund button, a retried request and a replayed webhook all collide on this unique index instead of refunding twice.$c$;
alter table public.billing_refunds enable row level security;

-- public.call_events   [RLS ENABLED]
create table if not exists public.call_events (
  id bigint default nextval('call_events_id_seq'::regclass) not null,
  call_sid text,
  kind text not null,
  payload jsonb,
  at timestamp with time zone default now() not null
);
alter table public.call_events enable row level security;

-- public.calls   [RLS ENABLED]
create table if not exists public.calls (
  id uuid default gen_random_uuid() not null,
  call_sid text,
  parent_call_sid text,
  conference_sid text,
  conference_name text,
  contact_id uuid,
  campaign_id uuid,
  line_id uuid,
  direction text default 'outbound'::text not null,
  from_number text,
  to_number text,
  status text,
  answered_by text,
  ring_seconds numeric,
  duration_seconds integer,
  queued_at timestamp with time zone default now(),
  started_at timestamp with time zone,
  answered_at timestamp with time zone,
  ended_at timestamp with time zone,
  recording_sid text,
  recording_url text,
  recording_seconds integer,
  transcript text,
  summary text,
  sentiment text,
  ai_notes jsonb,
  disposition text,
  outcome jsonb,
  gate jsonb,
  operator text,
  placed boolean default false not null,
  refused_reason text,
  cost_usd numeric,
  created_at timestamp with time zone default now() not null,
  account_id uuid,
  call_class text,
  ai_speaking boolean,
  ai_listening boolean,
  disclosure_verified boolean,
  disclosure_evidence jsonb,
  dnc_scrubbed_at_dial boolean,
  dnc_procedures_at_dial boolean
);
comment on column public.calls.placed is $c$False for a call the gate refused. Refusals are recorded, never discarded: the refusals are the proof the gate ran.$c$;
comment on column public.calls.account_id is $c$The paying business this call belongs to. For inbound, resolved from account_numbers.phone = the number that was dialled. Null on research and demo calls, which belong to no customer. Never confuse with contact_id, which is the person we dialled.$c$;
comment on column public.calls.call_class is $c$Written at dial time by the code that made the decision, never derived afterwards. Null means a call placed before this column existed; it is not a fourth class and must never be rendered as one.$c$;
comment on column public.calls.ai_speaking is $c$Did an artificial voice speak on this call. Decides whether 47 CFR 64.1200(a)(1) and FCC 24-17 reach it.$c$;
comment on column public.calls.ai_listening is $c$Was an AI receiving the audio (transcription, analysis) whether or not it spoke. THE field a state all-party wiretap claim turns on. True even when ai_speaking is false.$c$;
comment on column public.calls.disclosure_verified is $c$Was the disclosure ACTUALLY SPOKEN, read back from the transcript of what went over the wire. NULL means nobody has checked yet. Never set this at dial time: a <Say> inside a <Gather> is silenced by the callee's first word and a dial-time boolean would record that call as disclosed.$c$;
comment on column public.calls.dnc_scrubbed_at_dial is $c$Was the national DNC registry scrub in place when this call was placed. 47 CFR 64.1200(c)(2). Recorded per call because it is a condition precedent, so its state at dial time is the fact that matters, not its state today.$c$;
alter table public.calls enable row level security;

-- public.campaigns   [RLS ENABLED]
create table if not exists public.campaigns (
  id uuid default gen_random_uuid() not null,
  name text not null,
  mode text default 'discovery'::text not null,
  status text default 'draft'::text not null,
  autopilot boolean default false not null,
  pacing_per_min integer default 4 not null,
  max_concurrent integer default 3 not null,
  policy jsonb default '{}'::jsonb not null,
  script jsonb default '{}'::jsonb not null,
  line_ids ARRAY default '{}'::uuid[],
  stats jsonb default '{}'::jsonb not null,
  halt_reason text,
  created_at timestamp with time zone default now() not null,
  started_at timestamp with time zone,
  ended_at timestamp with time zone
);
comment on column public.campaigns.halt_reason is $c$Autopilot writes here when it stops itself. A campaign that halts must say why in words an operator can read.$c$;
alter table public.campaigns enable row level security;

-- public.compliance_policy   [RLS ENABLED]
--   64.1200(d)(1) requires a written policy AVAILABLE ON DEMAND, (d)(5) a written affiliate scope, (d)(6) five-year retention. Stored as rows so "does it exist" is a query, not a memory.
create table if not exists public.compliance_policy (
  id uuid default gen_random_uuid() not null,
  kind text not null,
  version text not null,
  body text not null,
  effective_at timestamp with time zone default now() not null,
  superseded_at timestamp with time zone,
  public_url text
);
alter table public.compliance_policy enable row level security;

-- public.compliance_states   [RLS ENABLED]
--   Rendered by /admin, owned by the outbound lane. research/lib/lane.mjs is the authority: this table is how that verdict reaches a screen. reviewed=false means NOBODY HAS READ THAT STATE YET, which is a work queue, not a refusal.
create table if not exists public.compliance_states (
  state text not null,
  reviewed boolean default false not null,
  ai_voice_ok boolean default false not null,
  human_dial_ok boolean default false not null,
  reason text,
  statute text,
  reviewed_at timestamp with time zone,
  reviewed_by text,
  updated_at timestamp with time zone default now() not null
);
comment on column public.compliance_states.reviewed is $c$Has the state's own statutory text been read for solicitor registration, bonding, artificial-voice restriction, recording consent, DNC treatment and damages exposure? False means unknown, not blocked. The difference is a work queue versus a dead lead.$c$;
comment on column public.compliance_states.human_dial_ok is $c$A person dials and a person speaks, with no artificial voice anywhere on the call. This relaxes ONE thing: which line types are reachable. The registry, the window, the frequency cap, suppression and every state rule still bind.$c$;
alter table public.compliance_states enable row level security;

-- public.compliance_training   [RLS ENABLED]
create table if not exists public.compliance_training (
  id uuid default gen_random_uuid() not null,
  person text not null,
  curriculum text not null,
  trained_at timestamp with time zone default now() not null,
  attested_by text
);
alter table public.compliance_training enable row level security;

-- public.consent   [RLS ENABLED]
create table if not exists public.consent (
  id uuid default gen_random_uuid() not null,
  phone text not null,
  scope text default 'research_call'::text not null,
  written boolean default false not null,
  source text not null,
  evidence jsonb,
  ip inet,
  user_agent text,
  granted_at timestamp with time zone default now() not null,
  expires_at timestamp with time zone
);
alter table public.consent enable row level security;

-- public.consent_sources   [RLS ENABLED]
create table if not exists public.consent_sources (
  external_id text not null,
  consent_id uuid,
  synced_at timestamp with time zone default now() not null
);
alter table public.consent_sources enable row level security;

-- public.contacts   [RLS ENABLED]
create table if not exists public.contacts (
  id uuid default gen_random_uuid() not null,
  phone text not null,
  name text,
  trade text,
  state text,
  city text,
  street text,
  website text,
  lat numeric,
  lon numeric,
  source text,
  source_id text,
  line_type text,
  carrier text,
  lookup_ok boolean,
  lookup_at timestamp with time zone,
  lane text,
  lane_reasons ARRAY,
  consent jsonb,
  suppressed boolean default false not null,
  suppressed_reason text,
  suppressed_at timestamp with time zone,
  disposition text default 'new'::text not null,
  owner text,
  tags ARRAY default '{}'::text[],
  score integer,
  first_contacted_at timestamp with time zone,
  last_contacted_at timestamp with time zone,
  call_count integer default 0 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  contact_name text,
  contact_role text,
  email text,
  email_source text,
  linkedin_url text,
  enriched_at timestamp with time zone,
  enrichment_sources ARRAY default '{}'::text[],
  enrichment_failed_reason text,
  first_seen_via text,
  intake_count integer default 0 not null
);
comment on column public.contacts.contact_name is $c$The HUMAN who answers, not the business. Null with enriched_at set means we looked and they do not publish one.$c$;
comment on column public.contacts.enriched_at is $c$Null = never attempted. Set = attempted, whatever the outcome. This is the field that separates "not looked at" from "looked and found nothing", and a console must render those differently.$c$;
comment on column public.contacts.enrichment_sources is $c$Every source consulted, including those that returned nothing, so an absence is evidenced rather than claimed.$c$;
comment on column public.contacts.enrichment_failed_reason is $c$Set when the attempt could not COMPLETE: unreachable, timeout, non-200, robots-disallowed, or a JS shell with nothing in the HTML. Null with enriched_at set means we genuinely read the page and they publish nothing. Only a set reason means retrying is worthwhile.$c$;
comment on column public.contacts.first_seen_via is $c$The intake that created this record. Never overwritten: the second time we meet someone is not how we met them.$c$;
alter table public.contacts enable row level security;

-- public.crm_activity   [RLS ENABLED]
--   The unified timeline. Anything that happens to a contact or an account lands here with a human-readable title, so a second operator can pick up a case cold without joining six tables in their head.
create table if not exists public.crm_activity (
  id bigint default nextval('crm_activity_id_seq'::regclass) not null,
  contact_id uuid,
  account_id uuid,
  kind text not null,
  title text not null,
  body text,
  payload jsonb default '{}'::jsonb not null,
  source text default 'system'::text not null,
  actor text,
  ref_kind text,
  ref_id text,
  at timestamp with time zone default now() not null
);
alter table public.crm_activity enable row level security;

-- public.crm_identities   [RLS ENABLED]
create table if not exists public.crm_identities (
  id uuid default gen_random_uuid() not null,
  contact_id uuid not null,
  kind text not null,
  value text not null,
  label text,
  verified boolean default false not null,
  source text,
  at timestamp with time zone default now() not null
);
alter table public.crm_identities enable row level security;

-- public.crm_intake_raw   [RLS ENABLED]
--   Every payload ever handed to the CRM, verbatim, before normalisation. A field we have no column for is still captured here and still queryable. Append-only by trigger: an intake record that can be edited is not evidence of what arrived.
create table if not exists public.crm_intake_raw (
  id bigint default nextval('crm_intake_raw_id_seq'::regclass) not null,
  source text not null,
  external_id text,
  payload jsonb not null,
  contact_id uuid,
  account_id uuid,
  matched_on text,
  created boolean,
  note text,
  at timestamp with time zone default now() not null
);
alter table public.crm_intake_raw enable row level security;

-- public.crm_messages   [RLS ENABLED]
--   Every message this company sends or receives on any channel, with the record it belongs to. A blocked attempt is recorded with status=blocked and its reason, because "we did not contact them, and here is why" is evidence an operator and a regulator both need.
create table if not exists public.crm_messages (
  id uuid default gen_random_uuid() not null,
  contact_id uuid,
  account_id uuid,
  channel text not null,
  direction text default 'outbound'::text not null,
  to_addr text,
  from_addr text,
  subject text,
  body text,
  template text,
  provider text,
  provider_id text,
  status text default 'queued'::text not null,
  failure_reason text,
  meta jsonb default '{}'::jsonb not null,
  ai_assisted boolean default false not null,
  ai_model text,
  sent_by text,
  created_at timestamp with time zone default now() not null,
  sent_at timestamp with time zone,
  updated_at timestamp with time zone default now() not null
);
alter table public.crm_messages enable row level security;

-- public.crm_tasks   [RLS ENABLED]
--   An operator task against a contact or an account. The CHECK forbids a task attached to neither, because a task with no subject is a note that will never be found again.
create table if not exists public.crm_tasks (
  id uuid default gen_random_uuid() not null,
  contact_id uuid,
  account_id uuid,
  title text not null,
  body text,
  due_at timestamp with time zone,
  status text default 'open'::text not null,
  priority text default 'normal'::text not null,
  assignee text,
  created_by text,
  created_at timestamp with time zone default now() not null,
  done_at timestamp with time zone,
  done_by text
);
alter table public.crm_tasks enable row level security;

-- public.crm_templates   [RLS ENABLED]
create table if not exists public.crm_templates (
  id uuid default gen_random_uuid() not null,
  key text not null,
  version integer default 1 not null,
  channel text not null,
  name text not null,
  subject text,
  body text not null,
  variables ARRAY default '{}'::text[] not null,
  active boolean default true not null,
  created_by text,
  created_at timestamp with time zone default now() not null
);
comment on column public.crm_templates.variables is $c$Every variable the body references. Rendering FAILS LOUDLY on a missing one rather than sending "Hi {{first_name}}", which is the single most common way a CRM embarrasses a company in public.$c$;
alter table public.crm_templates enable row level security;

-- public.dnc_registry   [RLS ENABLED]
create table if not exists public.dnc_registry (
  phone text not null,
  area_code text,
  snapshot_id uuid not null
);
alter table public.dnc_registry enable row level security;

-- public.dnc_requests   [RLS ENABLED]
create table if not exists public.dnc_requests (
  id uuid default gen_random_uuid() not null,
  phone text not null,
  requested_at timestamp with time zone default now() not null,
  honour_by timestamp with time zone not null,
  honoured_at timestamp with time zone,
  channel text not null,
  heard_as text,
  call_sid text,
  recorded_by text default 'system'::text not null
);
alter table public.dnc_requests enable row level security;

-- public.dnc_snapshots   [RLS ENABLED]
--   One row per registry download. 64.1200(c)(2)(i)(D) requires the version used to be no more than 31 days old, so freshness is a property of the SNAPSHOT and is checked at dial time, never assumed.
create table if not exists public.dnc_snapshots (
  id uuid default gen_random_uuid() not null,
  source text default 'national_dnc'::text not null,
  san text,
  area_codes ARRAY default '{}'::text[] not null,
  numbers bigint default 0 not null,
  downloaded_at timestamp with time zone default now() not null,
  notes text
);
alter table public.dnc_snapshots enable row level security;

-- public.hold_events   [RLS ENABLED]
--   Every state change, every digit sent, every detector verdict with the words that produced it. This is what the Hold Receipt is rendered from, so it is written even when nothing goes wrong.
create table if not exists public.hold_events (
  id bigint default nextval('hold_events_id_seq'::regclass) not null,
  session_id uuid not null,
  at timestamp with time zone default now() not null,
  kind text not null,
  payload jsonb default '{}'::jsonb not null
);
alter table public.hold_events enable row level security;

-- public.hold_sessions   [RLS ENABLED]
--   One row per Hold errand. A redial is an attempt on the same row, never a new session, so the "one price for the whole errand" promise cannot be broken by a reconnect.
create table if not exists public.hold_sessions (
  id uuid default gen_random_uuid() not null,
  token text not null,
  created_at timestamp with time zone default now() not null,
  account_key text,
  requester_phone text not null,
  requester_email text,
  requester_name text,
  requester_state text,
  target_phone text not null,
  target_label text not null,
  target_state text,
  reason text not null,
  reference text,
  line_class text default 'commercial'::text not null,
  line_class_source text default 'default_commercial'::text not null,
  line_type text,
  lookup_ok boolean,
  tree_plan jsonb default '[]'::jsonb not null,
  digits_sent jsonb default '[]'::jsonb not null,
  menu_depth integer default 0 not null,
  attempts integer default 0 not null,
  status text default 'queued'::text not null,
  outcome text,
  outcome_reason text,
  call_sid text,
  bridge_call_sid text,
  conference_name text,
  gate jsonb,
  consent_id uuid,
  detector jsonb default '{}'::jsonb not null,
  queued_at timestamp with time zone default now() not null,
  dialed_at timestamp with time zone,
  answered_at timestamp with time zone,
  hold_started_at timestamp with time zone,
  human_at timestamp with time zone,
  announced_at timestamp with time zone,
  bridged_at timestamp with time zone,
  ended_at timestamp with time zone,
  machine_wait_ms bigint default 0 not null,
  user_wait_ms bigint default 0 not null,
  charge_kind text,
  charge_cents integer,
  charge_gross_cents integer,
  charge_reason text,
  bill_event_id uuid,
  recording_sid text,
  recording_url text,
  recording_seconds integer,
  operator_note text
);
comment on column public.hold_sessions.token is $c$The capability link. 192 bits of randomness IS the credential for this one session, because a Hold customer has no account.$c$;
comment on column public.hold_sessions.line_class is $c$gov ($20) or commercial ($10). Defaults to the cheaper one; the dearer one needs a recorded source in line_class_source.$c$;
alter table public.hold_sessions enable row level security;

-- public.jobs   [RLS ENABLED]
create table if not exists public.jobs (
  id uuid default gen_random_uuid() not null,
  account_id uuid,
  contact_id uuid,
  job_ref text not null,
  caller_name text,
  address text,
  callback text,
  window_start timestamp with time zone,
  window_end timestamp with time zone,
  trade text,
  after_hours boolean default false not null,
  source text default 'voice'::text not null,
  call_id uuid,
  call_sid text,
  status text default 'booked'::text not null,
  void_reason text,
  voided_at timestamp with time zone,
  voided_by text,
  billing_event_id uuid,
  details jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
comment on column public.jobs.job_ref is $c$The human handle a customer quotes back at us, e.g. AJ5924F7E119. Unique, because a customer saying a reference must resolve to exactly one job.$c$;
comment on column public.jobs.after_hours is $c$Stored at booking time, never derived at read time. It decides whether this job was charged 19 or 49, and recomputing it later against a changed rule would restate a bill somebody already paid.$c$;
comment on column public.jobs.billing_event_id is $c$The charge this job produced, when it produced one. Null is honest: a job below the four-piece definition is free and has no charge to point at.$c$;
alter table public.jobs enable row level security;

-- public.lines   [RLS ENABLED]
create table if not exists public.lines (
  id uuid default gen_random_uuid() not null,
  phone text not null,
  twilio_sid text,
  label text,
  purpose text default 'research'::text not null,
  status text default 'active'::text not null,
  area_code text,
  daily_cap integer default 80 not null,
  calls_today integer default 0 not null,
  calls_total integer default 0 not null,
  answer_rate numeric,
  reputation text default 'unknown'::text,
  reputation_at timestamp with time zone,
  rest_until timestamp with time zone,
  provisioned_at timestamp with time zone default now(),
  notes text
);
comment on column public.lines.rest_until is $c$A number that has been dialling hard gets rested. Carrier analytics flag velocity, and a flagged number cannot be un-flagged quickly.$c$;
alter table public.lines enable row level security;

-- public.messages   [RLS ENABLED]
create table if not exists public.messages (
  id uuid default gen_random_uuid() not null,
  message_sid text,
  contact_id uuid,
  line_id uuid,
  direction text not null,
  from_number text,
  to_number text,
  body text,
  status text,
  error_code text,
  operator text,
  at timestamp with time zone default now() not null
);
alter table public.messages enable row level security;

-- public.notes   [RLS ENABLED]
create table if not exists public.notes (
  id uuid default gen_random_uuid() not null,
  contact_id uuid,
  call_sid text,
  body text not null,
  author text,
  pinned boolean default false not null,
  at timestamp with time zone default now() not null
);
alter table public.notes enable row level security;

-- public.rate_limits   [RLS ENABLED]
create table if not exists public.rate_limits (
  bucket text not null,
  key_hash text not null,
  window_start timestamp with time zone not null,
  n integer default 0 not null
);
alter table public.rate_limits enable row level security;

-- public.recap_deliveries   [RLS ENABLED]
create table if not exists public.recap_deliveries (
  id uuid default gen_random_uuid() not null,
  spine_key text not null,
  conversation_id text,
  channel text not null,
  status text default 'claimed'::text not null,
  target text,
  provider_id text,
  reason text,
  lines integer,
  attempts integer default 1 not null,
  claimed_at timestamp with time zone default now() not null,
  settled_at timestamp with time zone
);
alter table public.recap_deliveries enable row level security;

-- public.recover_calls   [RLS ENABLED]
create table if not exists public.recover_calls (
  id uuid default gen_random_uuid() not null,
  invoice_id uuid not null,
  call_sid text,
  placed boolean default false not null,
  refused_reason text,
  gate jsonb default '{}'::jsonb not null,
  opening_spoken text,
  from_number text,
  to_number text,
  status text,
  answered_by text,
  duration_seconds integer,
  disposition text,
  identity_confirmed boolean,
  outcome jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  ended_at timestamp with time zone,
  token_sha256 text,
  call_class text
);
alter table public.recover_calls enable row level security;

-- public.recover_invoices   [RLS ENABLED]
create table if not exists public.recover_invoices (
  id uuid default gen_random_uuid() not null,
  account_key text not null,
  account_id uuid,
  business_name text not null,
  business_phone text,
  invoice_number text not null,
  amount_cents integer not null,
  issued_at date not null,
  due_at date,
  job_description text,
  job_address text,
  job_completed_on date,
  debtor_name text not null,
  debtor_phone text not null,
  debtor_state text,
  debtor_timezone text,
  debtor_zone_source text,
  band text not null,
  band_shown_at timestamp with time zone not null,
  fee_mode text default 'contingency'::text not null,
  fee_mode_reason text,
  status text default 'open'::text not null,
  paid_cents integer default 0 not null,
  first_call_at timestamp with time zone,
  last_contact_at timestamp with time zone,
  last_conversation_at timestamp with time zone,
  next_action_at timestamp with time zone,
  stop_reason text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  debtor_line_type text,
  debtor_lookup_ok boolean,
  debtor_lookup_at timestamp with time zone,
  consent_basis text,
  number_source text,
  number_given_at timestamp with time zone
);
comment on column public.recover_invoices.consent_basis is $c$Why an artificial voice may lawfully call this number. provided_in_transaction = the debtor gave this number to the business in connection with the job (FCC 2008 Declaratory Ruling, 23 FCC Rcd 559). estate_qa_line = a line this estate owns, used for proving the runtime, never a consumer. Anything else, or null, refuses a mobile.$c$;
alter table public.recover_invoices enable row level security;

-- public.recover_payments   [RLS ENABLED]
create table if not exists public.recover_payments (
  id uuid default gen_random_uuid() not null,
  invoice_id uuid not null,
  amount_cents integer not null,
  landed_at timestamp with time zone not null,
  source text not null,
  reference text,
  recorded_by text,
  idem_key text not null,
  fee_rated jsonb,
  billing_event_id uuid,
  created_at timestamp with time zone default now() not null
);
alter table public.recover_payments enable row level security;

-- public.recover_promises   [RLS ENABLED]
create table if not exists public.recover_promises (
  id uuid default gen_random_uuid() not null,
  invoice_id uuid not null,
  call_sid text,
  amount_cents integer,
  promised_for date not null,
  spoken_text text not null,
  method text default 'spoken_on_call'::text not null,
  kept boolean,
  captured_at timestamp with time zone default now() not null
);
alter table public.recover_promises enable row level security;

-- public.saved_views   [RLS ENABLED]
create table if not exists public.saved_views (
  id uuid default gen_random_uuid() not null,
  owner_id uuid,
  scope text not null,
  name text not null,
  filters jsonb default '{}'::jsonb not null,
  shared boolean default false not null,
  sort_order integer default 0 not null,
  created_at timestamp with time zone default now() not null,
  used_at timestamp with time zone
);
alter table public.saved_views enable row level security;

-- public.suppression   [RLS ENABLED]
create table if not exists public.suppression (
  phone text not null,
  reason text not null,
  source text,
  at timestamp with time zone default now() not null
);
alter table public.suppression enable row level security;

-- public.transcript_lines   [RLS ENABLED]
create table if not exists public.transcript_lines (
  id bigint default nextval('transcript_lines_id_seq'::regclass) not null,
  call_sid text not null,
  seq integer default 0 not null,
  track text,
  speaker text,
  text text not null,
  confidence numeric,
  is_final boolean default false not null,
  at timestamp with time zone default now() not null
);
alter table public.transcript_lines enable row level security;

-- public.truce_deals   [RLS ENABLED]
create table if not exists public.truce_deals (
  id uuid default gen_random_uuid() not null,
  subject text not null,
  kind text default 'other'::text not null,
  currency text default 'USD'::text not null,
  status text default 'open'::text not null,
  settled_at timestamp with time zone,
  settled_value numeric,
  settlement jsonb,
  fee_cents integer default 2900 not null,
  created_at timestamp with time zone default now() not null,
  expires_at timestamp with time zone default (now() + '7 days'::interval) not null,
  seed double precision,
  notified_at timestamp with time zone
);
alter table public.truce_deals enable row level security;

-- public.truce_messages   [RLS ENABLED]
create table if not exists public.truce_messages (
  id bigint default nextval('truce_messages_id_seq'::regclass) not null,
  deal_id uuid not null,
  seq integer not null,
  speaker text not null,
  body text not null,
  amount numeric,
  move text,
  at timestamp with time zone default now() not null
);
alter table public.truce_messages enable row level security;

-- public.truce_parties   [RLS ENABLED]
create table if not exists public.truce_parties (
  id uuid default gen_random_uuid() not null,
  deal_id uuid not null,
  side text not null,
  role text not null,
  display_name text not null,
  token text not null,
  contact text,
  joined_at timestamp with time zone,
  limit_set_at timestamp with time zone,
  signed_at timestamp with time zone,
  stripe_account text,
  payouts_ready boolean default false not null,
  claim_code text,
  claimed_at timestamp with time zone
);
alter table public.truce_parties enable row level security;

-- public.truce_payouts   [RLS ENABLED]
create table if not exists public.truce_payouts (
  id uuid default gen_random_uuid() not null,
  deal_id uuid not null,
  payer_side text not null,
  payee_side text not null,
  amount_cents integer not null,
  fee_cents integer not null,
  currency text default 'usd'::text not null,
  stripe_payment_intent text,
  stripe_checkout_session text,
  stripe_connected_account text,
  stripe_application_fee text,
  status text default 'created'::text not null,
  failure_reason text,
  created_at timestamp with time zone default now() not null,
  paid_at timestamp with time zone,
  evidence jsonb
);
alter table public.truce_payouts enable row level security;

-- public.truce_signatures   [RLS ENABLED]
create table if not exists public.truce_signatures (
  id uuid default gen_random_uuid() not null,
  deal_id uuid not null,
  party_id uuid not null,
  name_typed text not null,
  ip inet,
  user_agent text,
  at timestamp with time zone default now() not null
);
alter table public.truce_signatures enable row level security;

-- quarantine.app_events_probes_20260814
create table if not exists quarantine.app_events_probes_20260814 (
  id bigint,
  account_id uuid,
  anon_id text,
  session_id text,
  name text,
  page text,
  meta jsonb,
  ua text,
  ip_sha256 text,
  source text,
  at timestamp with time zone
);

-- quarantine.billing_accounts_20260814
create table if not exists quarantine.billing_accounts_20260814 (
  id uuid,
  account_key text,
  business_name text,
  email text,
  phone text,
  plan text,
  cap_cents integer,
  pending_cap_cents integer,
  pending_cap_month date,
  quiet_notice_at timestamp with time zone,
  stripe_customer_id text,
  card_on_file boolean,
  card_brand text,
  card_last4 text,
  statement_token text,
  status text,
  created_at timestamp with time zone,
  account_id uuid
);

-- quarantine.billing_events_20260814
create table if not exists quarantine.billing_events_20260814 (
  id uuid,
  account_id uuid,
  idem_key text,
  kind text,
  product text,
  label text,
  occurred_at timestamp with time zone,
  cycle_month date,
  gross_cents integer,
  cap_applied_cents integer,
  credit_applied_cents integer,
  credit_created_cents integer,
  cents integer,
  billable boolean,
  rated_ok boolean,
  counts_toward_cap boolean,
  reason text,
  evidence jsonb,
  rating jsonb,
  state text,
  voided_at timestamp with time zone,
  void_reason text,
  voided_by text,
  stripe_invoice_item_id text,
  stripe_invoice_id text,
  created_at timestamp with time zone
);

-- quarantine.billing_invoices_20260814
create table if not exists quarantine.billing_invoices_20260814 (
  id uuid,
  account_id uuid,
  cycle_month date,
  stripe_invoice_id text,
  status text,
  total_cents integer,
  hosted_url text,
  created_at timestamp with time zone,
  finalized_at timestamp with time zone,
  paid_at timestamp with time zone
);

-- quarantine.contacts_probes_20260814
create table if not exists quarantine.contacts_probes_20260814 (
  id uuid,
  phone text,
  name text,
  trade text,
  state text,
  city text,
  street text,
  website text,
  lat numeric,
  lon numeric,
  source text,
  source_id text,
  line_type text,
  carrier text,
  lookup_ok boolean,
  lookup_at timestamp with time zone,
  lane text,
  lane_reasons ARRAY,
  consent jsonb,
  suppressed boolean,
  suppressed_reason text,
  suppressed_at timestamp with time zone,
  disposition text,
  owner text,
  tags ARRAY,
  score integer,
  first_contacted_at timestamp with time zone,
  last_contacted_at timestamp with time zone,
  call_count integer,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  contact_name text,
  contact_role text,
  email text,
  email_source text,
  linkedin_url text,
  enriched_at timestamp with time zone,
  enrichment_sources ARRAY,
  enrichment_failed_reason text,
  first_seen_via text,
  intake_count integer
);

-- quarantine.log
create table if not exists quarantine.log (
  id bigint default nextval('quarantine.log_id_seq'::regclass) not null,
  moved_at timestamp with time zone default now() not null,
  source text not null,
  target text not null,
  rows_moved integer not null,
  reason text not null,
  requested_by text,
  actioned_by text
);

-- sealed.limits   [RLS ENABLED]
create table if not exists sealed.limits (
  party_id uuid not null,
  deal_id uuid not null,
  direction text not null,
  amount numeric not null,
  must_haves ARRAY default '{}'::text[],
  set_at timestamp with time zone default now() not null,
  opening numeric,
  target numeric
);
alter table sealed.limits enable row level security;

-- ──────────────────────────────────────────────────────────────────────────────────────────
-- CONSTRAINTS
-- ──────────────────────────────────────────────────────────────────────────────────────────

alter table private.app_secret add constraint app_secret_pkey PRIMARY KEY (id);
alter table private.app_secret add constraint one_row CHECK ((id = 1));
alter table public.account_config add constraint account_config_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
alter table public.account_config add constraint account_config_after_hours_check CHECK ((after_hours = ANY (ARRAY['take_message'::text, 'book'::text, 'urgent_only'::text, 'transfer'::text])));
alter table public.account_config add constraint account_config_booking_mode_check CHECK ((booking_mode = ANY (ARRAY['sends_invite'::text, 'writes_directly'::text, 'message_only'::text])));
alter table public.account_config add constraint account_config_escalation_when_check CHECK ((escalation_when = ANY (ARRAY['never'::text, 'emergency'::text, 'on_request'::text, 'always'::text])));
alter table public.account_config add constraint account_config_monthly_cap_cents_check CHECK (((monthly_cap_cents >= 0) AND (monthly_cap_cents <= 10000000)));
alter table public.account_config add constraint account_config_pkey PRIMARY KEY (account_id);
alter table public.account_config add constraint account_config_quote_policy_check CHECK ((quote_policy = ANY (ARRAY['never'::text, 'range'::text, 'exact'::text])));
alter table public.account_config_versions add constraint account_config_versions_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
alter table public.account_config_versions add constraint account_config_versions_pkey PRIMARY KEY (id);
alter table public.account_events add constraint account_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
alter table public.account_events add constraint account_events_pkey PRIMARY KEY (id);
alter table public.account_notify add constraint account_notify_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
alter table public.account_notify add constraint account_notify_pkey PRIMARY KEY (account_id);
alter table public.account_numbers add constraint account_numbers_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
alter table public.account_numbers add constraint account_numbers_kind_check CHECK ((kind = ANY (ARRAY['answered'::text, 'forward_target'::text])));
alter table public.account_numbers add constraint account_numbers_phone_key UNIQUE (phone);
alter table public.account_numbers add constraint account_numbers_pkey PRIMARY KEY (id);
alter table public.account_numbers add constraint account_numbers_status_check CHECK ((status = ANY (ARRAY['provisioned'::text, 'released'::text])));
alter table public.account_numbers add constraint account_numbers_twilio_sid_key UNIQUE (twilio_sid);
alter table public.account_tokens add constraint account_tokens_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
alter table public.account_tokens add constraint account_tokens_pkey PRIMARY KEY (id);
alter table public.account_tokens add constraint account_tokens_purpose_check CHECK ((purpose = ANY (ARRAY['login'::text, 'verify_email'::text])));
alter table public.account_tokens add constraint account_tokens_token_hash_key UNIQUE (token_hash);
alter table public.accounts add constraint accounts_pkey PRIMARY KEY (id);
alter table public.accounts add constraint accounts_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'configuring'::text, 'ready'::text, 'awaiting_line'::text, 'live'::text, 'paused'::text, 'closed'::text])));
alter table public.admin_audit add constraint admin_audit_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES admin_users(id) ON DELETE SET NULL;
alter table public.admin_audit add constraint admin_audit_pkey PRIMARY KEY (id);
alter table public.admin_sessions add constraint admin_sessions_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES admin_users(id) ON DELETE CASCADE;
alter table public.admin_sessions add constraint admin_sessions_pkey PRIMARY KEY (id);
alter table public.admin_sessions add constraint admin_sessions_token_hash_key UNIQUE (token_hash);
alter table public.admin_users add constraint admin_users_pkey PRIMARY KEY (id);
alter table public.admin_users add constraint admin_users_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'operator'::text, 'viewer'::text])));
alter table public.admin_users add constraint admin_users_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text])));
alter table public.agent_tool_calls add constraint agent_tool_calls_idem_key_key UNIQUE (idem_key);
alter table public.agent_tool_calls add constraint agent_tool_calls_pkey PRIMARY KEY (id);
alter table public.app_events add constraint app_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL;
alter table public.app_events add constraint app_events_pkey PRIMARY KEY (id);
alter table public.app_events add constraint app_events_source_check CHECK ((source = ANY (ARRAY['web'::text, 'api'::text, 'system'::text, 'phone'::text, 'admin'::text])));
alter table public.billing_accounts add constraint billing_accounts_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL;
alter table public.billing_accounts add constraint billing_accounts_account_key_key UNIQUE (account_key);
alter table public.billing_accounts add constraint billing_accounts_cap_cents_check CHECK ((cap_cents >= 0));
alter table public.billing_accounts add constraint billing_accounts_pending_cap_cents_check CHECK ((pending_cap_cents >= 0));
alter table public.billing_accounts add constraint billing_accounts_pkey PRIMARY KEY (id);
alter table public.billing_accounts add constraint billing_accounts_plan_check CHECK ((plan = ANY (ARRAY['standard'::text, 'subscriber'::text])));
alter table public.billing_accounts add constraint billing_accounts_statement_token_key UNIQUE (statement_token);
alter table public.billing_accounts add constraint billing_accounts_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'closed'::text])));
alter table public.billing_accounts add constraint billing_accounts_stripe_customer_id_key UNIQUE (stripe_customer_id);
alter table public.billing_events add constraint billing_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES billing_accounts(id);
alter table public.billing_events add constraint billing_events_account_id_idem_key_key UNIQUE (account_id, idem_key);
alter table public.billing_events add constraint billing_events_pkey PRIMARY KEY (id);
alter table public.billing_events add constraint billing_events_state_check CHECK ((state = ANY (ARRAY['open'::text, 'invoiced'::text, 'paid'::text, 'voided'::text])));
alter table public.billing_invoices add constraint billing_invoices_account_id_cycle_month_key UNIQUE (account_id, cycle_month);
alter table public.billing_invoices add constraint billing_invoices_account_id_fkey FOREIGN KEY (account_id) REFERENCES billing_accounts(id);
alter table public.billing_invoices add constraint billing_invoices_pkey PRIMARY KEY (id);
alter table public.billing_invoices add constraint billing_invoices_stripe_invoice_id_key UNIQUE (stripe_invoice_id);
alter table public.billing_refunds add constraint billing_refunds_account_id_fkey FOREIGN KEY (account_id) REFERENCES billing_accounts(id) ON DELETE RESTRICT;
alter table public.billing_refunds add constraint billing_refunds_amount_cents_check CHECK ((amount_cents > 0));
alter table public.billing_refunds add constraint billing_refunds_billing_event_id_fkey FOREIGN KEY (billing_event_id) REFERENCES billing_events(id) ON DELETE SET NULL;
alter table public.billing_refunds add constraint billing_refunds_idem_key_key UNIQUE (idem_key);
alter table public.billing_refunds add constraint billing_refunds_pkey PRIMARY KEY (id);
alter table public.billing_refunds add constraint billing_refunds_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'succeeded'::text, 'failed'::text, 'canceled'::text, 'recorded_offline'::text])));
alter table public.billing_refunds add constraint billing_refunds_stripe_refund_id_key UNIQUE (stripe_refund_id);
alter table public.call_events add constraint call_events_pkey PRIMARY KEY (id);
alter table public.calls add constraint calls_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL;
alter table public.calls add constraint calls_call_class_chk CHECK (((call_class IS NULL) OR (call_class = ANY (ARRAY['ai_cold'::text, 'human_cold'::text, 'consented'::text, 'inbound'::text, 'demo'::text]))));
alter table public.calls add constraint calls_call_sid_key UNIQUE (call_sid);
alter table public.calls add constraint calls_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL;
alter table public.calls add constraint calls_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL;
alter table public.calls add constraint calls_direction_check CHECK ((direction = ANY (ARRAY['outbound'::text, 'inbound'::text])));
alter table public.calls add constraint calls_line_id_fkey FOREIGN KEY (line_id) REFERENCES lines(id) ON DELETE SET NULL;
alter table public.calls add constraint calls_pkey PRIMARY KEY (id);
alter table public.campaigns add constraint campaigns_mode_check CHECK ((mode = ANY (ARRAY['measure'::text, 'discovery'::text, 'manual'::text])));
alter table public.campaigns add constraint campaigns_pkey PRIMARY KEY (id);
alter table public.campaigns add constraint campaigns_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'armed'::text, 'running'::text, 'paused'::text, 'done'::text, 'halted'::text])));
alter table public.compliance_policy add constraint compliance_policy_kind_check CHECK ((kind = ANY (ARRAY['dnc_policy'::text, 'affiliate_scope'::text, 'retention'::text, 'training_curriculum'::text])));
alter table public.compliance_policy add constraint compliance_policy_pkey PRIMARY KEY (id);
alter table public.compliance_states add constraint compliance_states_pkey PRIMARY KEY (state);
alter table public.compliance_training add constraint compliance_training_pkey PRIMARY KEY (id);
alter table public.consent add constraint consent_pkey PRIMARY KEY (id);
alter table public.consent_sources add constraint consent_sources_consent_id_fkey FOREIGN KEY (consent_id) REFERENCES consent(id) ON DELETE SET NULL;
alter table public.consent_sources add constraint consent_sources_pkey PRIMARY KEY (external_id);
alter table public.contacts add constraint contacts_contact_role_check CHECK (((contact_role IS NULL) OR (contact_role = ANY (ARRAY['owner'::text, 'manager'::text, 'dispatcher'::text, 'unknown'::text]))));
alter table public.contacts add constraint contacts_disposition_check CHECK ((disposition = ANY (ARRAY['new'::text, 'queued'::text, 'attempted'::text, 'reached'::text, 'interested'::text, 'shadow_week'::text, 'callback'::text, 'not_interested'::text, 'bad_number'::text, 'do_not_call'::text, 'customer'::text])));
alter table public.contacts add constraint contacts_lane_check CHECK ((lane = ANY (ARRAY['green'::text, 'amber'::text, 'red'::text, 'hold'::text])));
alter table public.contacts add constraint contacts_phone_key UNIQUE (phone);
alter table public.contacts add constraint contacts_pkey PRIMARY KEY (id);
alter table public.crm_activity add constraint crm_activity_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
alter table public.crm_activity add constraint crm_activity_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE;
alter table public.crm_activity add constraint crm_activity_pkey PRIMARY KEY (id);
alter table public.crm_identities add constraint crm_identities_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE;
alter table public.crm_identities add constraint crm_identities_kind_check CHECK ((kind = ANY (ARRAY['phone'::text, 'email'::text, 'website'::text, 'domain'::text, 'stripe_customer'::text, 'hubspot_contact'::text, 'twilio_number'::text, 'deal_token'::text, 'external'::text])));
alter table public.crm_identities add constraint crm_identities_pkey PRIMARY KEY (id);
alter table public.crm_intake_raw add constraint crm_intake_raw_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL;
alter table public.crm_intake_raw add constraint crm_intake_raw_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL;
alter table public.crm_intake_raw add constraint crm_intake_raw_pkey PRIMARY KEY (id);
alter table public.crm_messages add constraint crm_messages_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL;
alter table public.crm_messages add constraint crm_messages_channel_check CHECK ((channel = ANY (ARRAY['email'::text, 'sms'::text, 'call'::text, 'note'::text])));
alter table public.crm_messages add constraint crm_messages_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL;
alter table public.crm_messages add constraint crm_messages_direction_check CHECK ((direction = ANY (ARRAY['outbound'::text, 'inbound'::text])));
alter table public.crm_messages add constraint crm_messages_pkey PRIMARY KEY (id);
alter table public.crm_messages add constraint crm_messages_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'sent'::text, 'delivered'::text, 'opened'::text, 'clicked'::text, 'bounced'::text, 'complained'::text, 'failed'::text, 'blocked'::text])));
alter table public.crm_tasks add constraint crm_tasks_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
alter table public.crm_tasks add constraint crm_tasks_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE;
alter table public.crm_tasks add constraint crm_tasks_has_a_subject CHECK (((contact_id IS NOT NULL) OR (account_id IS NOT NULL)));
alter table public.crm_tasks add constraint crm_tasks_pkey PRIMARY KEY (id);
alter table public.crm_tasks add constraint crm_tasks_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text])));
alter table public.crm_tasks add constraint crm_tasks_status_check CHECK ((status = ANY (ARRAY['open'::text, 'done'::text, 'cancelled'::text])));
alter table public.crm_templates add constraint crm_templates_channel_check CHECK ((channel = ANY (ARRAY['email'::text, 'sms'::text])));
alter table public.crm_templates add constraint crm_templates_pkey PRIMARY KEY (id);
alter table public.dnc_registry add constraint dnc_registry_pkey PRIMARY KEY (phone);
alter table public.dnc_requests add constraint dnc_requests_phone_requested_at_key UNIQUE (phone, requested_at);
alter table public.dnc_requests add constraint dnc_requests_pkey PRIMARY KEY (id);
alter table public.dnc_snapshots add constraint dnc_snapshots_pkey PRIMARY KEY (id);
alter table public.hold_events add constraint hold_events_pkey PRIMARY KEY (id);
alter table public.hold_events add constraint hold_events_session_id_fkey FOREIGN KEY (session_id) REFERENCES hold_sessions(id) ON DELETE CASCADE;
alter table public.hold_sessions add constraint hold_line_class_known CHECK ((line_class = ANY (ARRAY['gov'::text, 'commercial'::text])));
alter table public.hold_sessions add constraint hold_requester_e164 CHECK ((requester_phone ~ '^\+\d{8,15}$'::text));
alter table public.hold_sessions add constraint hold_sessions_pkey PRIMARY KEY (id);
alter table public.hold_sessions add constraint hold_sessions_token_key UNIQUE (token);
alter table public.hold_sessions add constraint hold_status_known CHECK ((status = ANY (ARRAY['queued'::text, 'refused'::text, 'dialing'::text, 'ringing'::text, 'navigating'::text, 'holding'::text, 'announcing'::text, 'bridging'::text, 'bridged'::text, 'ended'::text])));
alter table public.hold_sessions add constraint hold_target_e164 CHECK ((target_phone ~ '^\+\d{8,15}$'::text));
alter table public.jobs add constraint jobs_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL;
alter table public.jobs add constraint jobs_billing_event_id_fkey FOREIGN KEY (billing_event_id) REFERENCES billing_events(id) ON DELETE SET NULL;
alter table public.jobs add constraint jobs_call_id_fkey FOREIGN KEY (call_id) REFERENCES calls(id) ON DELETE SET NULL;
alter table public.jobs add constraint jobs_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL;
alter table public.jobs add constraint jobs_job_ref_key UNIQUE (job_ref);
alter table public.jobs add constraint jobs_pkey PRIMARY KEY (id);
alter table public.jobs add constraint jobs_source_check CHECK ((source = ANY (ARRAY['voice'::text, 'form'::text, 'operator'::text, 'api'::text])));
alter table public.jobs add constraint jobs_status_check CHECK ((status = ANY (ARRAY['booked'::text, 'voided'::text, 'completed'::text, 'no_show'::text, 'rescheduled'::text])));
alter table public.lines add constraint lines_phone_key UNIQUE (phone);
alter table public.lines add constraint lines_pkey PRIMARY KEY (id);
alter table public.lines add constraint lines_purpose_check CHECK ((purpose = ANY (ARRAY['research'::text, 'discovery'::text, 'demo'::text, 'sales'::text, 'inbound'::text, 'overflow'::text])));
alter table public.lines add constraint lines_reputation_check CHECK ((reputation = ANY (ARRAY['unknown'::text, 'clean'::text, 'at_risk'::text, 'flagged'::text])));
alter table public.lines add constraint lines_status_check CHECK ((status = ANY (ARRAY['active'::text, 'resting'::text, 'quarantined'::text, 'retired'::text])));
alter table public.lines add constraint lines_twilio_sid_key UNIQUE (twilio_sid);
alter table public.messages add constraint messages_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL;
alter table public.messages add constraint messages_direction_check CHECK ((direction = ANY (ARRAY['outbound'::text, 'inbound'::text])));
alter table public.messages add constraint messages_line_id_fkey FOREIGN KEY (line_id) REFERENCES lines(id) ON DELETE SET NULL;
alter table public.messages add constraint messages_message_sid_key UNIQUE (message_sid);
alter table public.messages add constraint messages_pkey PRIMARY KEY (id);
alter table public.notes add constraint notes_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE;
alter table public.notes add constraint notes_pkey PRIMARY KEY (id);
alter table public.rate_limits add constraint rate_limits_pkey PRIMARY KEY (bucket, key_hash, window_start);
alter table public.recap_deliveries add constraint recap_deliveries_channel_check CHECK ((channel = ANY (ARRAY['email'::text, 'sms'::text, 'webhook'::text])));
alter table public.recap_deliveries add constraint recap_deliveries_key_channel UNIQUE (spine_key, channel);
alter table public.recap_deliveries add constraint recap_deliveries_pkey PRIMARY KEY (id);
alter table public.recap_deliveries add constraint recap_deliveries_status_check CHECK ((status = ANY (ARRAY['claimed'::text, 'sent'::text, 'failed'::text, 'skipped'::text])));
alter table public.recover_calls add constraint recover_calls_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES recover_invoices(id) ON DELETE CASCADE;
alter table public.recover_calls add constraint recover_calls_pkey PRIMARY KEY (id);
alter table public.recover_invoices add constraint recover_invoices_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id);
alter table public.recover_invoices add constraint recover_invoices_account_key_invoice_number_key UNIQUE (account_key, invoice_number);
alter table public.recover_invoices add constraint recover_invoices_amount_cents_check CHECK ((amount_cents > 0));
alter table public.recover_invoices add constraint recover_invoices_band_check CHECK ((band = ANY (ARRAY['newer'::text, 'most'::text, 'oldest'::text])));
alter table public.recover_invoices add constraint recover_invoices_fee_mode_check CHECK ((fee_mode = ANY (ARRAY['contingency'::text, 'flat'::text])));
alter table public.recover_invoices add constraint recover_invoices_paid_cents_check CHECK ((paid_cents >= 0));
alter table public.recover_invoices add constraint recover_invoices_pkey PRIMARY KEY (id);
alter table public.recover_invoices add constraint recover_invoices_status_check CHECK ((status = ANY (ARRAY['open'::text, 'promised'::text, 'paid'::text, 'stopped'::text, 'disputed'::text, 'closed'::text])));
alter table public.recover_payments add constraint recover_payments_amount_cents_check CHECK ((amount_cents > 0));
alter table public.recover_payments add constraint recover_payments_idem_key_key UNIQUE (idem_key);
alter table public.recover_payments add constraint recover_payments_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES recover_invoices(id) ON DELETE CASCADE;
alter table public.recover_payments add constraint recover_payments_pkey PRIMARY KEY (id);
alter table public.recover_promises add constraint recover_promises_amount_cents_check CHECK (((amount_cents IS NULL) OR (amount_cents > 0)));
alter table public.recover_promises add constraint recover_promises_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES recover_invoices(id) ON DELETE CASCADE;
alter table public.recover_promises add constraint recover_promises_pkey PRIMARY KEY (id);
alter table public.saved_views add constraint saved_views_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES admin_users(id) ON DELETE CASCADE;
alter table public.saved_views add constraint saved_views_pkey PRIMARY KEY (id);
alter table public.saved_views add constraint saved_views_scope_check CHECK ((scope = ANY (ARRAY['contacts'::text, 'calls'::text, 'accounts'::text, 'events'::text, 'billing'::text])));
alter table public.suppression add constraint suppression_pkey PRIMARY KEY (phone);
alter table public.transcript_lines add constraint transcript_lines_call_sid_seq_track_key UNIQUE (call_sid, seq, track);
alter table public.transcript_lines add constraint transcript_lines_pkey PRIMARY KEY (id);
alter table public.truce_deals add constraint truce_deals_kind_check CHECK ((kind = ANY (ARRAY['rent'::text, 'deposit'::text, 'freelance'::text, 'marketplace'::text, 'vehicle'::text, 'real_estate'::text, 'invoice'::text, 'other'::text])));
alter table public.truce_deals add constraint truce_deals_pkey PRIMARY KEY (id);
alter table public.truce_deals add constraint truce_deals_status_check CHECK ((status = ANY (ARRAY['open'::text, 'negotiating'::text, 'settled'::text, 'no_overlap'::text, 'malformed'::text, 'withdrawn'::text, 'expired'::text])));
alter table public.truce_messages add constraint truce_messages_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES truce_deals(id) ON DELETE CASCADE;
alter table public.truce_messages add constraint truce_messages_deal_id_seq_key UNIQUE (deal_id, seq);
alter table public.truce_messages add constraint truce_messages_pkey PRIMARY KEY (id);
alter table public.truce_parties add constraint truce_parties_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES truce_deals(id) ON DELETE CASCADE;
alter table public.truce_parties add constraint truce_parties_deal_id_side_key UNIQUE (deal_id, side);
alter table public.truce_parties add constraint truce_parties_pkey PRIMARY KEY (id);
alter table public.truce_parties add constraint truce_parties_side_check CHECK ((side = ANY (ARRAY['a'::text, 'b'::text])));
alter table public.truce_parties add constraint truce_parties_token_key UNIQUE (token);
alter table public.truce_payouts add constraint truce_payouts_amount_cents_check CHECK ((amount_cents > 0));
alter table public.truce_payouts add constraint truce_payouts_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES truce_deals(id) ON DELETE CASCADE;
alter table public.truce_payouts add constraint truce_payouts_fee_cents_check CHECK ((fee_cents >= 0));
alter table public.truce_payouts add constraint truce_payouts_payee_side_check CHECK ((payee_side = ANY (ARRAY['a'::text, 'b'::text])));
alter table public.truce_payouts add constraint truce_payouts_payer_side_check CHECK ((payer_side = ANY (ARRAY['a'::text, 'b'::text])));
alter table public.truce_payouts add constraint truce_payouts_pkey PRIMARY KEY (id);
alter table public.truce_payouts add constraint truce_payouts_status_check CHECK ((status = ANY (ARRAY['created'::text, 'awaiting_payee'::text, 'awaiting_payment'::text, 'succeeded'::text, 'failed'::text, 'refunded'::text, 'cancelled'::text])));
alter table public.truce_payouts add constraint truce_payouts_stripe_payment_intent_key UNIQUE (stripe_payment_intent);
alter table public.truce_signatures add constraint truce_signatures_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES truce_deals(id) ON DELETE CASCADE;
alter table public.truce_signatures add constraint truce_signatures_deal_id_party_id_key UNIQUE (deal_id, party_id);
alter table public.truce_signatures add constraint truce_signatures_party_id_fkey FOREIGN KEY (party_id) REFERENCES truce_parties(id) ON DELETE CASCADE;
alter table public.truce_signatures add constraint truce_signatures_pkey PRIMARY KEY (id);
alter table sealed.limits add constraint limits_amount_check CHECK ((amount >= (0)::numeric));
alter table sealed.limits add constraint limits_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES truce_deals(id) ON DELETE CASCADE;
alter table sealed.limits add constraint limits_direction_check CHECK ((direction = ANY (ARRAY['max'::text, 'min'::text])));
alter table sealed.limits add constraint limits_party_id_fkey FOREIGN KEY (party_id) REFERENCES truce_parties(id) ON DELETE CASCADE;
alter table sealed.limits add constraint limits_pkey PRIMARY KEY (party_id);

-- ──────────────────────────────────────────────────────────────────────────────────────────
-- INDEXES
-- ──────────────────────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX app_secret_pkey ON private.app_secret USING btree (id);
CREATE UNIQUE INDEX account_config_pkey ON public.account_config USING btree (account_id);
CREATE INDEX account_config_versions_acct_idx ON public.account_config_versions USING btree (account_id, version DESC);
CREATE UNIQUE INDEX account_config_versions_pkey ON public.account_config_versions USING btree (id);
CREATE INDEX account_events_acct_idx ON public.account_events USING btree (account_id, at DESC);
CREATE UNIQUE INDEX account_events_pkey ON public.account_events USING btree (id);
CREATE UNIQUE INDEX account_notify_pkey ON public.account_notify USING btree (account_id);
CREATE INDEX account_numbers_acct_idx ON public.account_numbers USING btree (account_id);
CREATE UNIQUE INDEX account_numbers_phone_key ON public.account_numbers USING btree (phone);
CREATE UNIQUE INDEX account_numbers_pkey ON public.account_numbers USING btree (id);
CREATE UNIQUE INDEX account_numbers_twilio_sid_key ON public.account_numbers USING btree (twilio_sid);
CREATE INDEX account_tokens_acct_idx ON public.account_tokens USING btree (account_id, at DESC);
CREATE UNIQUE INDEX account_tokens_pkey ON public.account_tokens USING btree (id);
CREATE UNIQUE INDEX account_tokens_token_hash_key ON public.account_tokens USING btree (token_hash);
CREATE INDEX accounts_billing_key_idx ON public.accounts USING btree (billing_account_key);
CREATE UNIQUE INDEX accounts_owner_email_key ON public.accounts USING btree (lower(owner_email));
CREATE UNIQUE INDEX accounts_pkey ON public.accounts USING btree (id);
CREATE INDEX accounts_status_idx ON public.accounts USING btree (status);
CREATE INDEX admin_audit_actor_idx ON public.admin_audit USING btree (admin_id, at DESC);
CREATE INDEX admin_audit_at_idx ON public.admin_audit USING btree (at DESC);
CREATE UNIQUE INDEX admin_audit_pkey ON public.admin_audit USING btree (id);
CREATE INDEX admin_audit_target_idx ON public.admin_audit USING btree (target_kind, target_id, at DESC);
CREATE INDEX admin_sessions_admin_idx ON public.admin_sessions USING btree (admin_id, issued_at DESC);
CREATE INDEX admin_sessions_live_idx ON public.admin_sessions USING btree (expires_at) WHERE (revoked_at IS NULL);
CREATE UNIQUE INDEX admin_sessions_pkey ON public.admin_sessions USING btree (id);
CREATE UNIQUE INDEX admin_sessions_token_hash_key ON public.admin_sessions USING btree (token_hash);
CREATE UNIQUE INDEX admin_users_email_uniq ON public.admin_users USING btree (lower(email));
CREATE UNIQUE INDEX admin_users_pkey ON public.admin_users USING btree (id);
CREATE INDEX agent_tool_calls_conv_idx ON public.agent_tool_calls USING btree (conversation);
CREATE INDEX agent_tool_calls_created_idx ON public.agent_tool_calls USING btree (created_at DESC);
CREATE UNIQUE INDEX agent_tool_calls_idem_key_key ON public.agent_tool_calls USING btree (idem_key);
CREATE UNIQUE INDEX agent_tool_calls_pkey ON public.agent_tool_calls USING btree (id);
CREATE INDEX app_events_account_at_idx ON public.app_events USING btree (account_id, at DESC);
CREATE INDEX app_events_anon_idx ON public.app_events USING btree (anon_id, at DESC) WHERE (anon_id IS NOT NULL);
CREATE INDEX app_events_at_idx ON public.app_events USING btree (at DESC);
CREATE INDEX app_events_meta_gin ON public.app_events USING gin (meta jsonb_path_ops);
CREATE INDEX app_events_name_at_idx ON public.app_events USING btree (name, at DESC);
CREATE UNIQUE INDEX app_events_pkey ON public.app_events USING btree (id);
CREATE UNIQUE INDEX billing_accounts_account_id_uniq ON public.billing_accounts USING btree (account_id) WHERE (account_id IS NOT NULL);
CREATE UNIQUE INDEX billing_accounts_account_key_key ON public.billing_accounts USING btree (account_key);
CREATE UNIQUE INDEX billing_accounts_pkey ON public.billing_accounts USING btree (id);
CREATE UNIQUE INDEX billing_accounts_statement_token_key ON public.billing_accounts USING btree (statement_token);
CREATE UNIQUE INDEX billing_accounts_stripe_customer_id_key ON public.billing_accounts USING btree (stripe_customer_id);
CREATE UNIQUE INDEX billing_events_account_id_idem_key_key ON public.billing_events USING btree (account_id, idem_key);
CREATE INDEX billing_events_cycle_idx ON public.billing_events USING btree (account_id, cycle_month);
CREATE UNIQUE INDEX billing_events_pkey ON public.billing_events USING btree (id);
CREATE INDEX billing_events_state_idx ON public.billing_events USING btree (account_id, state);
CREATE UNIQUE INDEX billing_invoices_account_id_cycle_month_key ON public.billing_invoices USING btree (account_id, cycle_month);
CREATE UNIQUE INDEX billing_invoices_pkey ON public.billing_invoices USING btree (id);
CREATE UNIQUE INDEX billing_invoices_stripe_invoice_id_key ON public.billing_invoices USING btree (stripe_invoice_id);
CREATE INDEX billing_refunds_account_idx ON public.billing_refunds USING btree (account_id, created_at DESC);
CREATE INDEX billing_refunds_event_idx ON public.billing_refunds USING btree (billing_event_id);
CREATE UNIQUE INDEX billing_refunds_idem_key_key ON public.billing_refunds USING btree (idem_key);
CREATE UNIQUE INDEX billing_refunds_pkey ON public.billing_refunds USING btree (id);
CREATE UNIQUE INDEX billing_refunds_stripe_refund_id_key ON public.billing_refunds USING btree (stripe_refund_id);
CREATE UNIQUE INDEX call_events_pkey ON public.call_events USING btree (id);
CREATE INDEX call_events_sid_idx ON public.call_events USING btree (call_sid, at);
CREATE INDEX calls_account_id_at_idx ON public.calls USING btree (account_id, created_at DESC) WHERE (account_id IS NOT NULL);
CREATE INDEX calls_ai_listening_idx ON public.calls USING btree (ai_listening, created_at DESC) WHERE (ai_listening IS TRUE);
CREATE UNIQUE INDEX calls_call_sid_key ON public.calls USING btree (call_sid);
CREATE INDEX calls_campaign_idx ON public.calls USING btree (campaign_id, created_at DESC);
CREATE INDEX calls_class_at_idx ON public.calls USING btree (call_class, created_at DESC);
CREATE INDEX calls_contact_idx ON public.calls USING btree (contact_id, created_at DESC);
CREATE INDEX calls_created_at_idx ON public.calls USING btree (created_at DESC);
CREATE INDEX calls_created_idx ON public.calls USING btree (created_at DESC);
CREATE INDEX calls_disclosure_idx ON public.calls USING btree (disclosure_verified, created_at DESC);
CREATE UNIQUE INDEX calls_pkey ON public.calls USING btree (id);
CREATE INDEX calls_recording_idx ON public.calls USING btree (account_id, created_at DESC) WHERE (recording_sid IS NOT NULL);
CREATE INDEX calls_status_idx ON public.calls USING btree (status) WHERE (status = ANY (ARRAY['queued'::text, 'initiated'::text, 'ringing'::text, 'in-progress'::text]));
CREATE UNIQUE INDEX campaigns_pkey ON public.campaigns USING btree (id);
CREATE UNIQUE INDEX compliance_policy_pkey ON public.compliance_policy USING btree (id);
CREATE UNIQUE INDEX compliance_states_pkey ON public.compliance_states USING btree (state);
CREATE UNIQUE INDEX compliance_training_pkey ON public.compliance_training USING btree (id);
CREATE INDEX consent_phone_idx ON public.consent USING btree (phone, granted_at DESC);
CREATE UNIQUE INDEX consent_pkey ON public.consent USING btree (id);
CREATE UNIQUE INDEX consent_sources_pkey ON public.consent_sources USING btree (external_id);
CREATE INDEX contacts_callable_crm ON public.contacts USING btree (lane, disposition) WHERE (NOT suppressed);
CREATE INDEX contacts_disposition_idx ON public.contacts USING btree (disposition);
CREATE INDEX contacts_lane_idx ON public.contacts USING btree (lane);
CREATE INDEX contacts_line_type_idx ON public.contacts USING btree (line_type);
CREATE INDEX contacts_name_trgm ON public.contacts USING gin (to_tsvector('english'::regconfig, ((COALESCE(name, ''::text) || ' '::text) || COALESCE(city, ''::text))));
CREATE UNIQUE INDEX contacts_phone_key ON public.contacts USING btree (phone);
CREATE UNIQUE INDEX contacts_pkey ON public.contacts USING btree (id);
CREATE INDEX contacts_retryable ON public.contacts USING btree (enriched_at) WHERE (enrichment_failed_reason IS NOT NULL);
CREATE INDEX contacts_state_trade_idx ON public.contacts USING btree (state, trade);
CREATE INDEX contacts_unenriched ON public.contacts USING btree (created_at) WHERE ((enriched_at IS NULL) AND (website IS NOT NULL));
CREATE INDEX crm_activity_account_idx ON public.crm_activity USING btree (account_id, at DESC);
CREATE INDEX crm_activity_at_idx ON public.crm_activity USING btree (at DESC);
CREATE INDEX crm_activity_contact_idx ON public.crm_activity USING btree (contact_id, at DESC);
CREATE INDEX crm_activity_kind_idx ON public.crm_activity USING btree (kind, at DESC);
CREATE UNIQUE INDEX crm_activity_pkey ON public.crm_activity USING btree (id);
CREATE INDEX crm_identities_contact_idx ON public.crm_identities USING btree (contact_id);
CREATE UNIQUE INDEX crm_identities_pkey ON public.crm_identities USING btree (id);
CREATE UNIQUE INDEX crm_identities_uniq ON public.crm_identities USING btree (kind, lower(value));
CREATE INDEX crm_intake_raw_at_idx ON public.crm_intake_raw USING btree (at DESC);
CREATE INDEX crm_intake_raw_contact_idx ON public.crm_intake_raw USING btree (contact_id, at DESC);
CREATE INDEX crm_intake_raw_payload_gin ON public.crm_intake_raw USING gin (payload jsonb_path_ops);
CREATE UNIQUE INDEX crm_intake_raw_pkey ON public.crm_intake_raw USING btree (id);
CREATE INDEX crm_intake_raw_source_idx ON public.crm_intake_raw USING btree (source, at DESC);
CREATE INDEX crm_messages_account_idx ON public.crm_messages USING btree (account_id, created_at DESC);
CREATE INDEX crm_messages_channel_idx ON public.crm_messages USING btree (channel, created_at DESC);
CREATE INDEX crm_messages_contact_idx ON public.crm_messages USING btree (contact_id, created_at DESC);
CREATE UNIQUE INDEX crm_messages_pkey ON public.crm_messages USING btree (id);
CREATE UNIQUE INDEX crm_messages_provider_uniq ON public.crm_messages USING btree (provider, provider_id) WHERE (provider_id IS NOT NULL);
CREATE INDEX crm_messages_status_idx ON public.crm_messages USING btree (status, created_at DESC);
CREATE INDEX crm_tasks_account_idx ON public.crm_tasks USING btree (account_id, created_at DESC);
CREATE INDEX crm_tasks_contact_idx ON public.crm_tasks USING btree (contact_id, created_at DESC);
CREATE INDEX crm_tasks_open_idx ON public.crm_tasks USING btree (status, due_at) WHERE (status = 'open'::text);
CREATE UNIQUE INDEX crm_tasks_pkey ON public.crm_tasks USING btree (id);
CREATE UNIQUE INDEX crm_templates_key_ver ON public.crm_templates USING btree (key, version);
CREATE UNIQUE INDEX crm_templates_pkey ON public.crm_templates USING btree (id);
CREATE UNIQUE INDEX dnc_registry_pkey ON public.dnc_registry USING btree (phone);
CREATE INDEX dnc_registry_snapshot ON public.dnc_registry USING btree (snapshot_id);
CREATE INDEX dnc_requests_open ON public.dnc_requests USING btree (honour_by) WHERE (honoured_at IS NULL);
CREATE UNIQUE INDEX dnc_requests_phone_requested_at_key ON public.dnc_requests USING btree (phone, requested_at);
CREATE UNIQUE INDEX dnc_requests_pkey ON public.dnc_requests USING btree (id);
CREATE UNIQUE INDEX dnc_snapshots_pkey ON public.dnc_snapshots USING btree (id);
CREATE INDEX hold_events_kind_idx ON public.hold_events USING btree (kind, at DESC);
CREATE UNIQUE INDEX hold_events_pkey ON public.hold_events USING btree (id);
CREATE INDEX hold_events_session_idx ON public.hold_events USING btree (session_id, at);
CREATE INDEX hold_sessions_bridge_idx ON public.hold_sessions USING btree (bridge_call_sid);
CREATE INDEX hold_sessions_call_idx ON public.hold_sessions USING btree (call_sid);
CREATE INDEX hold_sessions_conf_idx ON public.hold_sessions USING btree (conference_name);
CREATE UNIQUE INDEX hold_sessions_pkey ON public.hold_sessions USING btree (id);
CREATE INDEX hold_sessions_status_idx ON public.hold_sessions USING btree (status, created_at DESC);
CREATE UNIQUE INDEX hold_sessions_token_key ON public.hold_sessions USING btree (token);
CREATE INDEX jobs_account_idx ON public.jobs USING btree (account_id, created_at DESC);
CREATE INDEX jobs_call_idx ON public.jobs USING btree (call_sid);
CREATE INDEX jobs_contact_idx ON public.jobs USING btree (contact_id, created_at DESC);
CREATE UNIQUE INDEX jobs_job_ref_key ON public.jobs USING btree (job_ref);
CREATE UNIQUE INDEX jobs_pkey ON public.jobs USING btree (id);
CREATE INDEX jobs_status_idx ON public.jobs USING btree (status, created_at DESC);
CREATE INDEX jobs_window_idx ON public.jobs USING btree (window_start) WHERE (status = 'booked'::text);
CREATE UNIQUE INDEX lines_phone_key ON public.lines USING btree (phone);
CREATE UNIQUE INDEX lines_pkey ON public.lines USING btree (id);
CREATE UNIQUE INDEX lines_twilio_sid_key ON public.lines USING btree (twilio_sid);
CREATE INDEX messages_contact_idx ON public.messages USING btree (contact_id, at DESC);
CREATE UNIQUE INDEX messages_message_sid_key ON public.messages USING btree (message_sid);
CREATE UNIQUE INDEX messages_pkey ON public.messages USING btree (id);
CREATE INDEX notes_contact_idx ON public.notes USING btree (contact_id, at DESC);
CREATE UNIQUE INDEX notes_pkey ON public.notes USING btree (id);
CREATE UNIQUE INDEX rate_limits_pkey ON public.rate_limits USING btree (bucket, key_hash, window_start);
CREATE INDEX recap_deliveries_claimed_at_idx ON public.recap_deliveries USING btree (claimed_at DESC);
CREATE UNIQUE INDEX recap_deliveries_key_channel ON public.recap_deliveries USING btree (spine_key, channel);
CREATE UNIQUE INDEX recap_deliveries_pkey ON public.recap_deliveries USING btree (id);
CREATE INDEX recover_calls_invoice_idx ON public.recover_calls USING btree (invoice_id, created_at DESC);
CREATE UNIQUE INDEX recover_calls_pkey ON public.recover_calls USING btree (id);
CREATE UNIQUE INDEX recover_calls_sid_idx ON public.recover_calls USING btree (call_sid) WHERE (call_sid IS NOT NULL);
CREATE UNIQUE INDEX recover_invoices_account_key_invoice_number_key ON public.recover_invoices USING btree (account_key, invoice_number);
CREATE INDEX recover_invoices_acct_idx ON public.recover_invoices USING btree (account_key);
CREATE INDEX recover_invoices_phone_idx ON public.recover_invoices USING btree (debtor_phone);
CREATE UNIQUE INDEX recover_invoices_pkey ON public.recover_invoices USING btree (id);
CREATE INDEX recover_invoices_status_idx ON public.recover_invoices USING btree (status, next_action_at);
CREATE UNIQUE INDEX recover_payments_idem_key_key ON public.recover_payments USING btree (idem_key);
CREATE INDEX recover_payments_invoice_idx ON public.recover_payments USING btree (invoice_id, landed_at DESC);
CREATE UNIQUE INDEX recover_payments_pkey ON public.recover_payments USING btree (id);
CREATE INDEX recover_promises_invoice_idx ON public.recover_promises USING btree (invoice_id, captured_at DESC);
CREATE UNIQUE INDEX recover_promises_pkey ON public.recover_promises USING btree (id);
CREATE UNIQUE INDEX saved_views_name_uniq ON public.saved_views USING btree (owner_id, scope, lower(name));
CREATE UNIQUE INDEX saved_views_pkey ON public.saved_views USING btree (id);
CREATE INDEX saved_views_scope_idx ON public.saved_views USING btree (scope, sort_order);
CREATE UNIQUE INDEX suppression_pkey ON public.suppression USING btree (phone);
CREATE INDEX transcript_call_idx ON public.transcript_lines USING btree (call_sid, at);
CREATE UNIQUE INDEX transcript_lines_call_sid_seq_track_key ON public.transcript_lines USING btree (call_sid, seq, track);
CREATE UNIQUE INDEX transcript_lines_pkey ON public.transcript_lines USING btree (id);
CREATE UNIQUE INDEX truce_deals_pkey ON public.truce_deals USING btree (id);
CREATE INDEX truce_messages_deal ON public.truce_messages USING btree (deal_id, seq);
CREATE UNIQUE INDEX truce_messages_deal_id_seq_key ON public.truce_messages USING btree (deal_id, seq);
CREATE UNIQUE INDEX truce_messages_pkey ON public.truce_messages USING btree (id);
CREATE UNIQUE INDEX truce_parties_claim_code ON public.truce_parties USING btree (claim_code) WHERE (claim_code IS NOT NULL);
CREATE INDEX truce_parties_deal ON public.truce_parties USING btree (deal_id);
CREATE UNIQUE INDEX truce_parties_deal_id_side_key ON public.truce_parties USING btree (deal_id, side);
CREATE UNIQUE INDEX truce_parties_pkey ON public.truce_parties USING btree (id);
CREATE UNIQUE INDEX truce_parties_token_key ON public.truce_parties USING btree (token);
CREATE INDEX truce_payouts_deal ON public.truce_payouts USING btree (deal_id);
CREATE UNIQUE INDEX truce_payouts_pkey ON public.truce_payouts USING btree (id);
CREATE INDEX truce_payouts_status ON public.truce_payouts USING btree (status);
CREATE UNIQUE INDEX truce_payouts_stripe_payment_intent_key ON public.truce_payouts USING btree (stripe_payment_intent);
CREATE UNIQUE INDEX truce_signatures_deal_id_party_id_key ON public.truce_signatures USING btree (deal_id, party_id);
CREATE UNIQUE INDEX truce_signatures_pkey ON public.truce_signatures USING btree (id);
CREATE UNIQUE INDEX log_pkey ON quarantine.log USING btree (id);
CREATE UNIQUE INDEX limits_pkey ON sealed.limits USING btree (party_id);

-- ──────────────────────────────────────────────────────────────────────────────────────────
-- VIEWS
-- ──────────────────────────────────────────────────────────────────────────────────────────

create or replace view public.v_account_balance as
 SELECT ba.id AS billing_account_id,
    ba.account_key,
    ba.account_id,
    ba.plan,
    ba.cap_cents,
    ba.status,
    COALESCE(sum(be.cents) FILTER (WHERE (be.state <> 'voided'::text)), (0)::bigint) AS charged_cents,
    COALESCE(sum(be.credit_created_cents) FILTER (WHERE (be.state <> 'voided'::text)), (0)::bigint) AS credit_created_cents,
    COALESCE(sum(be.credit_applied_cents) FILTER (WHERE (be.state <> 'voided'::text)), (0)::bigint) AS credit_applied_cents,
    (COALESCE(sum(be.credit_created_cents) FILTER (WHERE (be.state <> 'voided'::text)), (0)::bigint) - COALESCE(sum(be.credit_applied_cents) FILTER (WHERE (be.state <> 'voided'::text)), (0)::bigint)) AS credit_balance_cents,
    COALESCE(sum(be.cents) FILTER (WHERE (be.state = 'open'::text)), (0)::bigint) AS unbilled_cents,
    COALESCE(sum(be.cents) FILTER (WHERE (be.state = 'paid'::text)), (0)::bigint) AS paid_cents,
    COALESCE(( SELECT sum(r.amount_cents) AS sum
           FROM billing_refunds r
          WHERE ((r.account_id = ba.id) AND (r.status = ANY (ARRAY['succeeded'::text, 'recorded_offline'::text])))), (0)::bigint) AS refunded_cents,
    count(be.id) AS event_count,
    max(be.occurred_at) AS last_event_at
   FROM (billing_accounts ba
     LEFT JOIN billing_events be ON ((be.account_id = ba.id)))
  GROUP BY ba.id;

-- ──────────────────────────────────────────────────────────────────────────────────────────
-- FUNCTIONS — these bodies ARE the security model
-- ──────────────────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION private.account_json(p_account_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
  select jsonb_build_object(
    'id', a.id,
    'business_name', a.business_name,
    'owner_email', a.owner_email,
    'owner_name', a.owner_name,
    'owner_phone', a.owner_phone,
    'trade', a.trade,
    'timezone', a.timezone,
    'status', a.status,
    'email_verified_at', a.email_verified_at,
    'ready_at', a.ready_at,
    'requested_line_at', a.requested_line_at,
    'live_at', a.live_at,
    'wanted_area_code', a.wanted_area_code,
    'created_at', a.created_at,
    'updated_at', a.updated_at,
    'missing', to_jsonb(private.account_missing(a.id)),
    'config', case when c.account_id is null then null else jsonb_build_object(
      'version', c.version,
      'greeting_name', c.greeting_name,
      'business_says', c.business_says,
      'hours', c.hours,
      'after_hours', c.after_hours,
      'service_area', c.service_area,
      'services', to_jsonb(c.services),
      'never_say', to_jsonb(c.never_say),
      'always_ask', to_jsonb(c.always_ask),
      'quote_policy', c.quote_policy,
      'price_notes', c.price_notes,
      'booking_mode', c.booking_mode,
      'booking_destination', c.booking_destination,
      'escalation_phone', c.escalation_phone,
      'escalation_when', c.escalation_when,
      'monthly_cap_cents', c.monthly_cap_cents,
      'updated_at', c.updated_at
    ) end,
    'numbers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'phone', n.phone, 'kind', n.kind, 'status', n.status,
        'provisioned_at', n.provisioned_at, 'released_at', n.released_at)
        order by n.provisioned_at desc)
      from public.account_numbers n where n.account_id = a.id), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(x order by x->>'at' desc) from (
        select jsonb_build_object('kind', e.kind, 'payload', e.payload, 'actor', e.actor, 'at', e.at) as x
        from public.account_events e where e.account_id = a.id order by e.at desc limit 25) s), '[]'::jsonb)
  )
  from public.accounts a
  left join public.account_config c on c.account_id = a.id
  where a.id = p_account_id;
$function$
;

CREATE OR REPLACE FUNCTION private.account_missing(p_account_id uuid)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare
  a public.accounts%rowtype;
  c public.account_config%rowtype;
  m text[] := '{}';
begin
  select * into a from public.accounts where id = p_account_id;
  if not found then return array['account']; end if;
  select * into c from public.account_config where account_id = p_account_id;
  if not found then return array['everything']; end if;

  if coalesce(trim(a.business_name),'') = ''      then m := array_append(m, 'business_name'); end if;
  if coalesce(trim(c.greeting_name),'')  = ''     then m := array_append(m, 'greeting_name'); end if;
  if coalesce(trim(c.business_says),'')  = ''     then m := array_append(m, 'business_says'); end if;
  if coalesce(array_length(c.services,1),0) = 0   then m := array_append(m, 'services'); end if;
  if c.hours = '{}'::jsonb                        then m := array_append(m, 'hours'); end if;
  if coalesce(trim(c.service_area),'')   = ''     then m := array_append(m, 'service_area'); end if;
  if c.booking_mode <> 'message_only'
     and coalesce(trim(c.booking_destination),'') = '' then m := array_append(m, 'booking_destination'); end if;
  if c.escalation_when <> 'never'
     and coalesce(trim(c.escalation_phone),'') = ''    then m := array_append(m, 'escalation_phone'); end if;
  if a.email_verified_at is null                  then m := array_append(m, 'email_verified'); end if;
  return m;
end $function$
;

CREATE OR REPLACE FUNCTION private.account_resettle(p_account_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare m text[]; a public.accounts%rowtype;
begin
  select * into a from public.accounts where id = p_account_id;
  if not found then return; end if;
  if a.status in ('live','paused','closed') then return; end if;
  m := private.account_missing(p_account_id);
  if array_length(m,1) is null then
    if a.status = 'awaiting_line' then
      update public.accounts set updated_at = now() where id = p_account_id;
    else
      update public.accounts
         set status = 'ready', ready_at = coalesce(ready_at, now()), updated_at = now()
       where id = p_account_id;
    end if;
  else
    update public.accounts
       set status = case when a.email_verified_at is null then 'draft' else 'configuring' end,
           ready_at = null, updated_at = now()
     where id = p_account_id;
  end if;
end $function$
;

CREATE OR REPLACE FUNCTION private.auth_ok(p_secret text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'private', 'public', 'extensions'
AS $function$
  select exists (
    select 1 from private.app_secret
     where secret_hash = encode(digest(coalesce(p_secret,''), 'sha256'), 'hex')
  );
$function$
;

CREATE OR REPLACE FUNCTION private.require(p_secret text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'private'
AS $function$
begin
  if not private.auth_ok(p_secret) then
    raise exception 'unauthorized' using errcode = '28000';
  end if;
end $function$
;

CREATE OR REPLACE FUNCTION public.admin_audit_is_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  raise exception 'admin_audit is append only: % is not permitted', tg_op;
end $function$
;

CREATE OR REPLACE FUNCTION public.apply_suppression()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update public.contacts
     set suppressed = true,
         suppressed_reason = new.reason,
         suppressed_at = new.at,
         disposition = 'do_not_call',
         updated_at = now()
   where phone = new.phone;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.bl_statement(p_token text, p_cycle date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.billing_accounts;
begin
  select * into a from public.billing_accounts where statement_token = p_token;
  if not found then return jsonb_build_object('error','unknown link'); end if;
  return public.bl_statement_for(a.id, p_cycle);
end $function$
;

CREATE OR REPLACE FUNCTION public.bl_statement_for(p_account uuid, p_cycle date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.billing_accounts; v_cycle date; v_charged integer; v_credit integer;
begin
  select * into a from public.billing_accounts where id = p_account;
  if not found then return jsonb_build_object('error','unknown account'); end if;
  v_cycle := coalesce(p_cycle, date_trunc('month', now())::date);

  select coalesce(sum(cents),0) into v_charged
    from public.billing_events
   where account_id = a.id and cycle_month = v_cycle
     and state <> 'voided' and counts_toward_cap;

  select coalesce(sum(credit_created_cents),0) - coalesce(sum(credit_applied_cents),0)
    into v_credit
    from public.billing_events
   where account_id = a.id and state <> 'voided';

  return jsonb_build_object(
    'account', jsonb_build_object(
       'business_name', a.business_name, 'email', a.email, 'plan', a.plan,
       'cap_cents', a.cap_cents, 'pending_cap_cents', a.pending_cap_cents,
       'pending_cap_month', a.pending_cap_month,
       'card_on_file', a.card_on_file, 'card_brand', a.card_brand, 'card_last4', a.card_last4,
       'status', a.status, 'quiet_notice_at', a.quiet_notice_at),
    'cycle', v_cycle,
    'cap_cents', a.cap_cents,
    'charged_cents', v_charged,
    'cap_room_cents', greatest(0, a.cap_cents - v_charged),
    'credit_cents', greatest(0, v_credit),
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
        'id', e.id, 'kind', e.kind, 'product', e.product, 'label', e.label,
        'occurred_at', e.occurred_at, 'gross_cents', e.gross_cents, 'cents', e.cents,
        'cap_applied_cents', e.cap_applied_cents, 'credit_applied_cents', e.credit_applied_cents,
        'billable', e.billable, 'rated_ok', e.rated_ok, 'reason', e.reason,
        'state', e.state, 'voided_at', e.voided_at, 'void_reason', e.void_reason,
        'evidence', e.evidence) order by e.occurred_at desc)
      from public.billing_events e
     where e.account_id = a.id and e.cycle_month = v_cycle), '[]'::jsonb),
    'due_cents', coalesce((select sum(cents) from public.billing_events
                            where account_id = a.id and cycle_month = v_cycle
                              and state in ('open','invoiced')), 0)
  );
end $function$
;

CREATE OR REPLACE FUNCTION public.bl_void(p_token text, p_event uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.billing_accounts; e public.billing_events;
begin
  select * into a from public.billing_accounts where statement_token = p_token;
  if not found then return jsonb_build_object('error','unknown link'); end if;
  select * into e from public.billing_events where id = p_event and account_id = a.id;
  if not found then return jsonb_build_object('error','that charge is not on this account'); end if;
  if e.state = 'voided' then
    return jsonb_build_object('ok', true, 'already', true, 'id', e.id, 'cents', 0);
  end if;
  if e.state = 'paid' then
    return jsonb_build_object('ok', false, 'needs_refund', true, 'id', e.id,
                              'error', 'This one is already paid, so voiding it is a refund. We will process it and email you.');
  end if;
  update public.billing_events
     set state = 'voided', voided_at = now(), voided_by = 'customer',
         void_reason = coalesce(nullif(trim(p_reason),''), 'voided by the customer')
   where id = e.id returning * into e;
  return jsonb_build_object('ok', true, 'id', e.id, 'voided_at', e.voided_at, 'cents', 0);
end $function$
;

-- Protects the evidence, not the conclusion. The payload as it arrived is immutable; which contact it resolved to may be written and rewritten, because that is a judgement that can be corrected by a later merge.
CREATE OR REPLACE FUNCTION public.crm_intake_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'crm_intake_raw is append only: DELETE is not permitted';
  end if;

  if new.payload     is distinct from old.payload
     or new.source      is distinct from old.source
     or new.external_id is distinct from old.external_id
     or new.at          is distinct from old.at then
    raise exception
      'crm_intake_raw: payload, source, external_id and at are immutable. Only the resolution columns (contact_id, account_id, matched_on, created, note) may be written.';
  end if;

  return new;
end $function$
;
comment on function public.crm_intake_append_only() is $c$Protects the evidence, not the conclusion. The payload as it arrived is immutable; which contact it resolved to may be written and rewritten, because that is a judgement that can be corrected by a later merge.$c$;

CREATE OR REPLACE FUNCTION public.hd_view(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v public.hold_sessions;
begin
  if p_token is null or length(p_token) < 32 then return jsonb_build_object('error','that link is not valid'); end if;
  select * into v from public.hold_sessions where token = p_token;
  if not found then return jsonb_build_object('error','unknown link'); end if;

  return jsonb_build_object(
    'session', jsonb_build_object(
      'id', v.id, 'created_at', v.created_at, 'status', v.status,
      'outcome', v.outcome, 'outcome_reason', v.outcome_reason,
      'target_label', v.target_label, 'target_phone', v.target_phone,
      'reason', v.reason, 'reference', case when v.reference is null then null else 'on file' end,
      'requester_last4', right(v.requester_phone, 4),
      'line_class', v.line_class, 'line_class_source', v.line_class_source,
      'menu_depth', v.menu_depth, 'attempts', v.attempts, 'digits_sent', v.digits_sent,
      'queued_at', v.queued_at, 'dialed_at', v.dialed_at, 'answered_at', v.answered_at,
      'hold_started_at', v.hold_started_at, 'human_at', v.human_at,
      'announced_at', v.announced_at, 'bridged_at', v.bridged_at, 'ended_at', v.ended_at,
      'machine_wait_ms', v.machine_wait_ms, 'user_wait_ms', v.user_wait_ms,
      'charge_kind', v.charge_kind, 'charge_cents', v.charge_cents,
      'charge_gross_cents', v.charge_gross_cents, 'charge_reason', v.charge_reason,
      'recording_seconds', v.recording_seconds,
      'has_recording', v.recording_sid is not null),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('at', e.at, 'kind', e.kind, 'payload', e.payload) order by e.id)
      from public.hold_events e where e.session_id = v.id
        and e.kind not in ('gate_verdict','operator_note','detector_debug')), '[]'::jsonb));
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_account(p_secret text, p_account_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
begin
  perform private.require(p_secret);
  return private.account_json(p_account_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_account_assign_number(p_secret text, p_account_id uuid, p_phone text, p_twilio_sid text, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare m text[];
begin
  perform private.require(p_secret);
  if p_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'phone must be E.164' using errcode = '22023';
  end if;
  m := private.account_missing(p_account_id);
  if array_length(m,1) is not null then
    return jsonb_build_object('ok', false, 'missing', to_jsonb(m));
  end if;
  insert into public.account_numbers (account_id, phone, twilio_sid, assigned_by)
  values (p_account_id, p_phone, nullif(p_twilio_sid,''), p_actor)
  on conflict (phone) do update
    set account_id = excluded.account_id, status = 'provisioned',
        released_at = null, twilio_sid = coalesce(excluded.twilio_sid, public.account_numbers.twilio_sid),
        assigned_by = excluded.assigned_by;
  update public.accounts
     set status = 'live', live_at = coalesce(live_at, now()), updated_at = now()
   where id = p_account_id;
  insert into public.account_events (account_id, kind, payload, actor)
    values (p_account_id, 'number_assigned', jsonb_build_object('phone', p_phone), p_actor);
  return jsonb_build_object('ok', true, 'account', private.account_json(p_account_id));
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_account_consume_token(p_secret text, p_token_hash text, p_ip text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare t public.account_tokens%rowtype;
begin
  perform private.require(p_secret);
  update public.account_tokens
     set consumed_at = now(), consumed_ip = nullif(p_ip,'')
   where token_hash = p_token_hash and consumed_at is null and expires_at > now()
  returning * into t;
  if not found then return jsonb_build_object('ok', false); end if;

  update public.accounts
     set email_verified_at = coalesce(email_verified_at, now()), updated_at = now()
   where id = t.account_id;
  insert into public.account_events (account_id, kind, actor) values (t.account_id, 'signed_in', 'self');
  perform private.account_resettle(t.account_id);
  return jsonb_build_object('ok', true, 'account', private.account_json(t.account_id));
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_account_for_number(p_secret text, p_phone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v_id uuid;
begin
  perform private.require(p_secret);
  select n.account_id into v_id
    from public.account_numbers n
    join public.accounts a on a.id = n.account_id
   where n.phone = p_phone and n.status = 'provisioned' and a.status = 'live'
   limit 1;
  if v_id is null then return null; end if;
  return private.account_json(v_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_account_link_billing(p_secret text, p_account_id uuid, p_billing_account_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
begin
  perform private.require(p_secret);
  update public.accounts
     set billing_account_key = nullif(trim(p_billing_account_key),''), updated_at = now()
   where id = p_account_id;
  if not found then return jsonb_build_object('ok', false, 'why', 'no such account'); end if;
  insert into public.account_events (account_id, kind, payload, actor)
    values (p_account_id, 'billing_linked', jsonb_build_object('account_key', p_billing_account_key), 'system');
  return jsonb_build_object('ok', true, 'account', private.account_json(p_account_id));
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_account_notify(p_secret text, p_account_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare n public.account_notify%rowtype; a public.accounts%rowtype;
begin
  perform private.require(p_secret);
  select * into a from public.accounts where id = p_account_id;
  if a.id is null then return null; end if;
  select * into n from public.account_notify where account_id = p_account_id;
  return jsonb_build_object(
    'stored',                n.account_id is not null,
    'owner_email',           a.owner_email,
    'owner_phone',           a.owner_phone,
    'email_extra',           coalesce(n.email_extra, '{}'::text[]),
    'sms_on',                coalesce(n.sms_on, true),
    'sms_to',                coalesce(n.sms_to, a.owner_phone),
    'call_on',               coalesce(n.call_on, false),
    'call_after_hours_only', coalesce(n.call_after_hours_only, true),
    'call_to',               coalesce(n.call_to, a.owner_phone),
    'updated_at',            n.updated_at,
    'updated_by',            n.updated_by);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_account_notify_save(p_secret text, p_account_id uuid, p_patch jsonb, p_author text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare cur jsonb;
begin
  perform private.require(p_secret);
  if not exists (select 1 from public.accounts where id = p_account_id) then
    raise exception 'no such account' using errcode = '22023';
  end if;

  cur := public.sv_account_notify(p_secret, p_account_id);

  insert into public.account_notify as n
    (account_id, email_extra, sms_on, sms_to, call_on, call_after_hours_only, call_to, updated_at, updated_by)
  values (
    p_account_id,
    case when p_patch ? 'email_extra'
         then coalesce((select array_agg(btrim(x)) from jsonb_array_elements_text(p_patch->'email_extra') x
                         where btrim(x) <> ''), '{}'::text[])
         else (cur->>'email_extra')::text[] end,
    case when p_patch ? 'sms_on' then (p_patch->>'sms_on')::boolean else (cur->>'sms_on')::boolean end,
    case when p_patch ? 'sms_to' then nullif(btrim(p_patch->>'sms_to'),'') else cur->>'sms_to' end,
    case when p_patch ? 'call_on' then (p_patch->>'call_on')::boolean else (cur->>'call_on')::boolean end,
    case when p_patch ? 'call_after_hours_only' then (p_patch->>'call_after_hours_only')::boolean
         else (cur->>'call_after_hours_only')::boolean end,
    case when p_patch ? 'call_to' then nullif(btrim(p_patch->>'call_to'),'') else cur->>'call_to' end,
    now(), coalesce(nullif(p_author,''), 'owner'))
  on conflict (account_id) do update set
    email_extra           = excluded.email_extra,
    sms_on                = excluded.sms_on,
    sms_to                = excluded.sms_to,
    call_on               = excluded.call_on,
    call_after_hours_only = excluded.call_after_hours_only,
    call_to               = excluded.call_to,
    updated_at            = now(),
    updated_by            = excluded.updated_by;

  insert into public.account_events (account_id, kind, payload, actor)
  values (p_account_id, 'notify_saved',
          jsonb_build_object('fields', (select jsonb_agg(k) from jsonb_object_keys(p_patch) k)),
          coalesce(nullif(p_author,''), 'owner'));

  return public.sv_account_notify(p_secret, p_account_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_account_request_line(p_secret text, p_account_id uuid, p_area_code text, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare m text[]; a public.accounts%rowtype;
begin
  perform private.require(p_secret);
  select * into a from public.accounts where id = p_account_id;
  if not found then raise exception 'no such account' using errcode = '22023'; end if;
  m := private.account_missing(p_account_id);
  if array_length(m,1) is not null then
    return jsonb_build_object('ok', false, 'missing', to_jsonb(m), 'account', private.account_json(p_account_id));
  end if;
  if a.status = 'live' then
    return jsonb_build_object('ok', false, 'already_live', true, 'account', private.account_json(p_account_id));
  end if;
  update public.accounts
     set status = 'awaiting_line',
         requested_line_at = coalesce(requested_line_at, now()),
         wanted_area_code = coalesce(nullif(regexp_replace(coalesce(p_area_code,''), '\D', '', 'g'),''), wanted_area_code),
         updated_at = now()
   where id = p_account_id;
  insert into public.account_events (account_id, kind, payload, actor)
    values (p_account_id, 'line_requested',
            jsonb_build_object('area_code', p_area_code, 'note', left(coalesce(p_note,''), 500)), 'self');
  return jsonb_build_object('ok', true, 'account', private.account_json(p_account_id));
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_account_save_config(p_secret text, p_account_id uuid, p_patch jsonb, p_author text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare c public.account_config%rowtype; v_next int;
begin
  perform private.require(p_secret);
  select * into c from public.account_config where account_id = p_account_id;
  if not found then raise exception 'no such account' using errcode = '22023'; end if;
  v_next := c.version + 1;

  update public.account_config set
    greeting_name       = coalesce(nullif(trim(p_patch->>'greeting_name'),''),        greeting_name),
    business_says       = coalesce(nullif(trim(p_patch->>'business_says'),''),        business_says),
    service_area        = coalesce(nullif(trim(p_patch->>'service_area'),''),         service_area),
    price_notes         = coalesce(nullif(trim(p_patch->>'price_notes'),''),          price_notes),
    booking_destination = coalesce(nullif(trim(p_patch->>'booking_destination'),''),  booking_destination),
    escalation_phone    = coalesce(nullif(trim(p_patch->>'escalation_phone'),''),     escalation_phone),
    hours               = coalesce(p_patch->'hours',                                  hours),
    services            = coalesce((select array_agg(trim(x)) from jsonb_array_elements_text(p_patch->'services') x
                                     where trim(x) <> ''),                            services),
    never_say           = coalesce((select array_agg(trim(x)) from jsonb_array_elements_text(p_patch->'never_say') x
                                     where trim(x) <> ''),                            never_say),
    always_ask          = coalesce((select array_agg(trim(x)) from jsonb_array_elements_text(p_patch->'always_ask') x
                                     where trim(x) <> ''),                            always_ask),
    after_hours         = coalesce(nullif(p_patch->>'after_hours',''),                after_hours),
    quote_policy        = coalesce(nullif(p_patch->>'quote_policy',''),               quote_policy),
    booking_mode        = coalesce(nullif(p_patch->>'booking_mode',''),               booking_mode),
    escalation_when     = coalesce(nullif(p_patch->>'escalation_when',''),            escalation_when),
    monthly_cap_cents   = coalesce((p_patch->>'monthly_cap_cents')::int,              monthly_cap_cents),
    version             = v_next,
    updated_at          = now(),
    updated_by          = p_author
  where account_id = p_account_id;

  update public.accounts set
    business_name = coalesce(nullif(trim(p_patch->>'business_name'),''), business_name),
    owner_name    = coalesce(nullif(trim(p_patch->>'owner_name'),''),    owner_name),
    owner_phone   = coalesce(nullif(trim(p_patch->>'owner_phone'),''),   owner_phone),
    trade         = coalesce(nullif(trim(p_patch->>'trade'),''),         trade),
    timezone      = coalesce(nullif(trim(p_patch->>'timezone'),''),      timezone),
    updated_at    = now()
  where id = p_account_id;

  insert into public.account_config_versions (account_id, version, config, author)
  select p_account_id, v_next, private.account_json(p_account_id)->'config', p_author;

  insert into public.account_events (account_id, kind, payload, actor)
    values (p_account_id, 'rules_saved',
            jsonb_build_object('version', v_next, 'fields', (select jsonb_agg(k) from jsonb_object_keys(p_patch) k)),
            p_author);

  perform private.account_resettle(p_account_id);
  return private.account_json(p_account_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_account_start(p_secret text, p_email text, p_business_name text, p_owner_name text, p_phone text, p_trade text, p_token_hash text, p_ttl_minutes integer, p_ip text, p_ua text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare a public.accounts%rowtype; v_recent int; v_new boolean := false;
begin
  perform private.require(p_secret);
  if coalesce(trim(p_email),'') = '' or position('@' in p_email) < 2 then
    raise exception 'email required' using errcode = '22023';
  end if;

  select * into a from public.accounts where lower(owner_email) = lower(trim(p_email));
  if not found then
    if coalesce(trim(p_business_name),'') = '' then
      raise exception 'business name required' using errcode = '22023';
    end if;
    insert into public.accounts (business_name, owner_email, owner_name, owner_phone, trade)
    values (trim(p_business_name), lower(trim(p_email)), nullif(trim(coalesce(p_owner_name,'')),''),
            nullif(trim(coalesce(p_phone,'')),''), nullif(trim(coalesce(p_trade,'')),''))
    returning * into a;
    insert into public.account_config (account_id) values (a.id);
    insert into public.account_events (account_id, kind, payload, actor)
      values (a.id, 'account_created', jsonb_build_object('trade', p_trade), 'self');
    v_new := true;
  end if;

  -- Five links that ACTUALLY WENT OUT in fifteen minutes is a mailbox flooder, not a person who
  -- lost one. Links that failed to send do not count; see sent_at.
  select count(*) into v_recent from public.account_tokens
   where account_id = a.id and sent_at is not null and sent_at > now() - interval '15 minutes';
  if v_recent >= 5 then
    return jsonb_build_object('ok', false, 'throttled', true, 'created', v_new,
                              'account', private.account_json(a.id));
  end if;

  insert into public.account_tokens (account_id, purpose, token_hash, expires_at, issued_ip, issued_ua)
  values (a.id, 'login', p_token_hash,
          now() + make_interval(mins => greatest(5, least(coalesce(p_ttl_minutes,20), 120))),
          nullif(p_ip,''), left(coalesce(p_ua,''), 300));

  insert into public.account_events (account_id, kind, payload, actor)
    values (a.id, 'login_link_issued', jsonb_build_object('new_account', v_new), 'self');

  return jsonb_build_object('ok', true, 'throttled', false, 'created', v_new,
                            'account', private.account_json(a.id));
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_account_token_sent(p_secret text, p_token_hash text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
begin
  perform private.require(p_secret);
  update public.account_tokens set sent_at = now() where token_hash = p_token_hash and sent_at is null;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_accounts(p_secret text, p_status text, p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
begin
  perform private.require(p_secret);
  return coalesce((
    select jsonb_agg(private.account_json(a.id) order by a.updated_at desc)
    from (select id, updated_at from public.accounts
           where p_status is null or status = p_status
           order by updated_at desc limit greatest(1, least(coalesce(p_limit,100), 500))) a), '[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_add_event(p_secret text, p_call_sid text, p_kind text, p_payload jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
begin
  perform private.require(p_secret);
  insert into public.call_events (call_sid, kind, payload) values (p_call_sid, p_kind, p_payload);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_add_transcript(p_secret text, p_call_sid text, p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare n int;
begin
  perform private.require(p_secret);
  with incoming as (
    select * from jsonb_to_recordset(p_rows) as x(
      seq int, track text, speaker text, text text, confidence numeric, is_final boolean
    )
  ), ins as (
    insert into public.transcript_lines (call_sid, seq, track, speaker, text, confidence, is_final)
    select p_call_sid, coalesce(seq,0), track, speaker, text, confidence, coalesce(is_final,false)
      from incoming where text is not null and text <> ''
    on conflict (call_sid, seq, track) do update set
      text = excluded.text, confidence = excluded.confidence,
      is_final = excluded.is_final, at = now()
    returning 1
  ) select count(*) into n from ins;
  return n;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_account(p_secret text, p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.accounts%rowtype; b public.billing_accounts%rowtype; v jsonb;
begin
  perform private.require(p_secret);
  select * into a from public.accounts where id = p_id;
  if not found then return null; end if;
  select * into b from public.billing_accounts where account_id = p_id;

  select jsonb_build_object(
    'account', to_jsonb(a),
    'config',  (select to_jsonb(c) from public.account_config c where c.account_id = p_id),
    'config_versions', (select coalesce(jsonb_agg(jsonb_build_object(
                          'version', cv.version, 'author', cv.author, 'at', cv.at) order by cv.at desc), '[]'::jsonb)
                        from public.account_config_versions cv where cv.account_id = p_id),
    'numbers', (select coalesce(jsonb_agg(to_jsonb(an) order by an.provisioned_at desc), '[]'::jsonb)
                  from public.account_numbers an where an.account_id = p_id),
    'timeline',(select coalesce(jsonb_agg(jsonb_build_object(
                        'kind', ae.kind, 'payload', ae.payload, 'actor', ae.actor, 'at', ae.at)
                        order by ae.at desc), '[]'::jsonb)
                  from (select * from public.account_events where account_id = p_id
                         order by at desc limit 100) ae),
    'billing', case when b.id is null then null else jsonb_build_object(
        'account_key', b.account_key, 'plan', b.plan, 'cap_cents', b.cap_cents,
        'pending_cap_cents', b.pending_cap_cents, 'pending_cap_month', b.pending_cap_month,
        'status', b.status, 'card_on_file', b.card_on_file, 'card_brand', b.card_brand,
        'card_last4', b.card_last4, 'stripe_customer_id', b.stripe_customer_id,
        'quiet_notice_at', b.quiet_notice_at, 'created_at', b.created_at,
        'balance', (select to_jsonb(vb) from public.v_account_balance vb where vb.billing_account_id = b.id)
      ) end,
    'charges', case when b.id is null then '[]'::jsonb else
      (select coalesce(jsonb_agg(to_jsonb(e) order by e.occurred_at desc), '[]'::jsonb)
         from (select id, idem_key, kind, product, label, occurred_at, cycle_month,
                      gross_cents, cents, credit_applied_cents, credit_created_cents,
                      billable, rated_ok, counts_toward_cap, reason, state, voided_at,
                      void_reason, stripe_invoice_id
                 from public.billing_events where account_id = b.id
                order by occurred_at desc limit 200) e) end,
    'invoices', case when b.id is null then '[]'::jsonb else
      (select coalesce(jsonb_agg(to_jsonb(i) order by i.created_at desc), '[]'::jsonb)
         from public.billing_invoices i where i.account_id = b.id) end,
    'refunds', case when b.id is null then '[]'::jsonb else
      (select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc), '[]'::jsonb)
         from public.billing_refunds r where r.account_id = b.id) end,
    'calls', (select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at desc), '[]'::jsonb)
                from (select id, call_sid, direction, from_number, to_number, status,
                             answered_by, duration_seconds, recording_sid, recording_seconds,
                             summary, sentiment, disposition, placed, refused_reason,
                             cost_usd, created_at
                        from public.calls where account_id = p_id
                       order by created_at desc limit 100) c),
    'usage', (select jsonb_build_object(
                'calls_total',   count(*),
                'calls_30d',     count(*) filter (where created_at > now() - interval '30 days'),
                'calls_7d',      count(*) filter (where created_at > now() - interval '7 days'),
                'recordings',    count(*) filter (where recording_sid is not null),
                'talk_seconds',  coalesce(sum(duration_seconds), 0),
                'first_call_at', min(created_at), 'last_call_at', max(created_at))
                from public.calls where account_id = p_id),
    'events_recent', (select coalesce(jsonb_agg(jsonb_build_object(
                        'name', e.name, 'page', e.page, 'meta', e.meta, 'source', e.source, 'at', e.at)
                        order by e.at desc), '[]'::jsonb)
                        from (select * from public.app_events where account_id = p_id
                               order by at desc limit 100) e),
    'events_rollup', (select coalesce(jsonb_agg(jsonb_build_object(
                        'name', g.name, 'n', g.n, 'last_at', g.last_at) order by g.n desc), '[]'::jsonb)
                        from (select name, count(*) as n, max(at) as last_at
                                from public.app_events where account_id = p_id
                               group by name) g),
    'audit', (select coalesce(jsonb_agg(jsonb_build_object(
                'actor_email', au.actor_email, 'action', au.action, 'payload', au.payload,
                'result', au.result, 'at', au.at) order by au.at desc), '[]'::jsonb)
                from (select * from public.admin_audit
                       where target_kind = 'account' and target_id = p_id::text
                       order by at desc limit 50) au)
  ) into v;
  return v;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_account_status(p_secret text, p_id uuid, p_status text, p_actor text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.accounts%rowtype;
begin
  perform private.require(p_secret);
  if p_status not in ('configuring','ready','awaiting_line','paused','closed') then
    return jsonb_build_object('ok', false, 'error',
      case when p_status = 'live'
        then 'live is set by assigning a real number to this account, never by hand'
        else 'that is not a status an operator may set' end);
  end if;
  update public.accounts
     set status = p_status, updated_at = now()
   where id = p_id returning * into a;
  if not found then return jsonb_build_object('ok', false, 'error', 'no such account'); end if;

  insert into public.account_events (account_id, kind, payload, actor)
  values (p_id, 'status_changed',
          jsonb_build_object('to', p_status, 'reason', p_reason), coalesce(p_actor, 'operator'));

  return jsonb_build_object('ok', true, 'account', to_jsonb(a));
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_accounts(p_secret text, p_q text, p_status text, p_sort text, p_limit integer, p_offset integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v jsonb; n bigint; lim integer; off integer;
begin
  perform private.require(p_secret);
  lim := greatest(1, least(coalesce(p_limit, 50), 200));
  off := greatest(0, coalesce(p_offset, 0));

  select count(*) into n from public.accounts a
   where (p_status is null or a.status = p_status)
     and (p_q is null or p_q = '' or (
          a.business_name ilike '%'||p_q||'%' or a.owner_email ilike '%'||p_q||'%'
       or coalesce(a.owner_name,'') ilike '%'||p_q||'%'
       or coalesce(a.owner_phone,'') ilike '%'||p_q||'%'
       or a.id::text = p_q));

  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v from (
    select a.id, a.business_name, a.owner_email, a.owner_name, a.owner_phone, a.trade,
           a.status, a.timezone, a.created_at, a.email_verified_at, a.ready_at,
           a.requested_line_at, a.live_at, a.wanted_area_code,
           (select an.phone from public.account_numbers an
             where an.account_id = a.id and an.status = 'provisioned'
             order by an.provisioned_at limit 1)                       as phone,
           (select count(*) from public.calls c where c.account_id = a.id)        as calls,
           (select count(*) from public.calls c
             where c.account_id = a.id and c.recording_sid is not null)           as recordings,
           (select max(c.created_at) from public.calls c where c.account_id = a.id) as last_call_at,
           (select count(*) from public.app_events e where e.account_id = a.id)   as events,
           (select max(e.at) from public.app_events e where e.account_id = a.id)  as last_seen_at,
           b.account_key, b.plan, b.cap_cents, b.card_on_file, b.card_brand, b.card_last4,
           b.status                                                              as billing_status,
           coalesce(v2.charged_cents, 0)                                         as charged_cents,
           coalesce(v2.unbilled_cents, 0)                                        as unbilled_cents,
           coalesce(v2.credit_balance_cents, 0)                                  as credit_cents,
           coalesce(v2.refunded_cents, 0)                                        as refunded_cents
      from public.accounts a
      left join public.billing_accounts b   on b.account_id = a.id
      left join public.v_account_balance v2 on v2.billing_account_id = b.id
     where (p_status is null or a.status = p_status)
       and (p_q is null or p_q = '' or (
            a.business_name ilike '%'||p_q||'%' or a.owner_email ilike '%'||p_q||'%'
         or coalesce(a.owner_name,'') ilike '%'||p_q||'%'
         or coalesce(a.owner_phone,'') ilike '%'||p_q||'%'
         or a.id::text = p_q))
     order by
       case when coalesce(p_sort,'recent') = 'recent'  then a.created_at end desc nulls last,
       case when p_sort = 'oldest'                     then a.created_at end asc  nulls last,
       case when p_sort = 'name'                       then lower(a.business_name) end asc,
       a.created_at desc
     limit lim offset off
  ) x;

  return jsonb_build_object('total', n, 'limit', lim, 'offset', off, 'rows', v);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_attribute_backfill(p_secret text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n integer;
begin
  perform private.require(p_secret);
  update public.calls c
     set account_id = an.account_id
    from public.account_numbers an
   where c.account_id is null
     and an.status = 'provisioned'
     and ((c.direction = 'inbound'  and c.to_number   = an.phone)
       or (c.direction = 'outbound' and c.from_number = an.phone));
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'attributed', n,
    'remaining_unattributed', (select count(*) from public.calls where account_id is null));
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_attribute_call(p_secret text, p_call_sid text, p_account_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare c public.calls%rowtype;
begin
  perform private.require(p_secret);
  update public.calls set account_id = p_account_id where call_sid = p_call_sid returning * into c;
  if not found then return jsonb_build_object('ok', false, 'error', 'no such call'); end if;
  return jsonb_build_object('ok', true, 'call_id', c.id, 'account_id', c.account_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_audit(p_secret text, p_row jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v bigint;
begin
  perform private.require(p_secret);
  insert into public.admin_audit (admin_id, actor_email, action, target_kind, target_id,
                                  payload, result, ip, ua)
  values (nullif(p_row->>'admin_id','')::uuid, p_row->>'actor_email', p_row->>'action',
          p_row->>'target_kind', p_row->>'target_id',
          coalesce(p_row->'payload','{}'::jsonb), p_row->>'result',
          left(coalesce(p_row->>'ip',''),60), left(coalesce(p_row->>'ua',''),300))
  returning id into v;
  return v;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_audit_list(p_secret text, p_target_kind text, p_target_id text, p_limit integer, p_offset integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v jsonb; n bigint;
begin
  perform private.require(p_secret);
  select count(*) into n from public.admin_audit a
   where (p_target_kind is null or a.target_kind = p_target_kind)
     and (p_target_id  is null or a.target_id  = p_target_id);
  select coalesce(jsonb_agg(to_jsonb(x) order by x.at desc), '[]'::jsonb) into v from (
    select a.id, a.actor_email, a.action, a.target_kind, a.target_id, a.payload,
           a.result, a.ip, a.at
      from public.admin_audit a
     where (p_target_kind is null or a.target_kind = p_target_kind)
       and (p_target_id  is null or a.target_id  = p_target_id)
     order by a.at desc
     limit greatest(1, least(coalesce(p_limit,100), 500)) offset greatest(0, coalesce(p_offset,0))
  ) x;
  return jsonb_build_object('total', n, 'rows', v);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_billing_accounts(p_secret text, p_q text, p_limit integer, p_offset integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v jsonb; n bigint; lim integer; off integer;
begin
  perform private.require(p_secret);
  lim := greatest(1, least(coalesce(p_limit, 100), 500));
  off := greatest(0, coalesce(p_offset, 0));

  select count(*) into n from public.billing_accounts b
   where (p_q is null or p_q = '' or b.business_name ilike '%'||p_q||'%'
          or b.email ilike '%'||p_q||'%' or b.account_key ilike '%'||p_q||'%');

  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v from (
    select b.id                as billing_account_id,
           b.account_id,
           b.account_key,
           coalesce(a.business_name, b.business_name) as business_name,
           b.email, b.plan, b.cap_cents, b.status,
           b.card_on_file, b.card_brand, b.card_last4, b.stripe_customer_id,
           b.created_at,
           (a.id is not null)  as linked,
           coalesce(v2.charged_cents, 0)        as charged_cents,
           coalesce(v2.unbilled_cents, 0)       as unbilled_cents,
           coalesce(v2.paid_cents, 0)           as paid_cents,
           coalesce(v2.credit_balance_cents, 0) as credit_balance_cents,
           coalesce(v2.refunded_cents, 0)       as refunded_cents,
           coalesce(v2.event_count, 0)          as charges,
           v2.last_event_at
      from public.billing_accounts b
      left join public.accounts a          on a.id = b.account_id
      left join public.v_account_balance v2 on v2.billing_account_id = b.id
     where (p_q is null or p_q = '' or b.business_name ilike '%'||p_q||'%'
            or b.email ilike '%'||p_q||'%' or b.account_key ilike '%'||p_q||'%')
     order by coalesce(v2.last_event_at, b.created_at) desc
     limit lim offset off
  ) x;

  return jsonb_build_object(
    'total', n, 'limit', lim, 'offset', off, 'rows', v,
    -- Surfaced as its own figure so the console can state it plainly rather than making an
    -- operator count coloured pills.
    'orphans', (select count(*) from public.billing_accounts where account_id is null));
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_bootstrap(p_secret text, p_email text, p_hash text, p_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare u public.admin_users%rowtype;
begin
  perform private.require(p_secret);
  select * into u from public.admin_users where lower(email) = lower(trim(p_email));
  if found then
    return jsonb_build_object('created', false, 'id', u.id, 'email', u.email,
      'note', 'an operator with this email already exists and was not modified');
  end if;
  insert into public.admin_users (email, name, password_hash, role, status)
  values (lower(trim(p_email)), nullif(trim(coalesce(p_name,'')),''), p_hash, 'owner', 'active')
  returning * into u;
  return jsonb_build_object('created', true, 'id', u.id, 'email', u.email);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_by_email(p_secret text, p_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare u public.admin_users%rowtype;
begin
  perform private.require(p_secret);
  select * into u from public.admin_users where lower(email) = lower(trim(p_email));
  if not found then return null; end if;
  return jsonb_build_object(
    'id', u.id, 'email', u.email, 'name', u.name, 'role', u.role, 'status', u.status,
    'password_hash', u.password_hash, 'must_change', u.must_change,
    'failed_count', u.failed_count, 'locked_until', u.locked_until,
    'locked', (u.locked_until is not null and u.locked_until > now())
  );
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_call(p_secret text, p_call_sid text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v jsonb;
begin
  perform private.require(p_secret);
  select jsonb_build_object(
    'call', (select to_jsonb(c) from public.calls c where c.call_sid = p_call_sid),
    'account', (select jsonb_build_object('id', a.id, 'business_name', a.business_name,
                                          'owner_email', a.owner_email)
                  from public.calls c join public.accounts a on a.id = c.account_id
                 where c.call_sid = p_call_sid),
    'transcript', (select coalesce(jsonb_agg(jsonb_build_object(
                     'seq', t.seq, 'speaker', t.speaker, 'text', t.text,
                     'is_final', t.is_final, 'at', t.at) order by t.seq, t.id), '[]'::jsonb)
                     from public.transcript_lines t where t.call_sid = p_call_sid),
    'events', (select coalesce(jsonb_agg(jsonb_build_object(
                 'kind', e.kind, 'payload', e.payload, 'at', e.at) order by e.at), '[]'::jsonb)
                 from public.call_events e where e.call_sid = p_call_sid)
  ) into v;
  return v;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_call_summary(p_secret text, p_call_sid text, p_row jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_id uuid;
begin
  perform private.require(p_secret);

  update public.calls
     set summary   = nullif(p_row->>'summary',''),
         sentiment = nullif(p_row->>'sentiment',''),
         ai_notes  = p_row - 'summary' - 'sentiment'
   where call_sid = p_call_sid
   returning id into v_id;

  -- An UPDATE that matched nothing must say so. A silent zero-row update reads to the caller as
  -- success and is how a console ends up displaying a summary that was never stored.
  if v_id is null then
    return jsonb_build_object('ok', false, 'reason', 'no call has that sid');
  end if;

  insert into public.crm_activity (contact_id, account_id, kind, title, body, payload, source, actor,
                                   ref_kind, ref_id)
  select c.contact_id, c.account_id, 'call',
         'Call summarised by ' || coalesce(p_row->>'model','an unnamed model'),
         left(coalesce(p_row->>'summary',''), 2000),
         p_row, 'admin-console', nullif(p_row->>'actor',''), 'call', p_call_sid
    from public.calls c where c.id = v_id;

  return jsonb_build_object('ok', true, 'call_id', v_id);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_calls(p_secret text, p_account uuid, p_q text, p_direction text, p_recorded boolean, p_limit integer, p_offset integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v jsonb; n bigint; lim integer; off integer;
begin
  perform private.require(p_secret);
  lim := greatest(1, least(coalesce(p_limit, 50), 200));
  off := greatest(0, coalesce(p_offset, 0));

  select count(*) into n from public.calls c
   where (p_account is null or c.account_id = p_account)
     and (p_direction is null or c.direction = p_direction)
     and (p_recorded is null or (c.recording_sid is not null) = p_recorded)
     and (p_q is null or p_q = '' or c.call_sid = p_q or c.from_number ilike '%'||p_q||'%'
          or c.to_number ilike '%'||p_q||'%' or coalesce(c.summary,'') ilike '%'||p_q||'%');

  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v from (
    select c.id, c.call_sid, c.account_id, a.business_name, c.contact_id, ct.name as contact_name,
           c.direction, c.from_number, c.to_number, c.status, c.answered_by,
           c.duration_seconds, c.recording_sid, c.recording_seconds, c.summary, c.sentiment,
           c.disposition, c.placed, c.refused_reason, c.cost_usd, c.created_at,
           (select count(*) from public.transcript_lines t where t.call_sid = c.call_sid) as transcript_lines
      from public.calls c
      left join public.accounts a on a.id = c.account_id
      left join public.contacts ct on ct.id = c.contact_id
     where (p_account is null or c.account_id = p_account)
       and (p_direction is null or c.direction = p_direction)
       and (p_recorded is null or (c.recording_sid is not null) = p_recorded)
       and (p_q is null or p_q = '' or c.call_sid = p_q or c.from_number ilike '%'||p_q||'%'
            or c.to_number ilike '%'||p_q||'%' or coalesce(c.summary,'') ilike '%'||p_q||'%')
     order by c.created_at desc
     limit lim offset off
  ) x;
  return jsonb_build_object('total', n, 'limit', lim, 'offset', off, 'rows', v);
end $function$
;

-- Everything the cockpit paints, in one round trip, because David asked for no lengthy processes and a board that needs nine requests is out of date before it finishes painting. Every lamp returns its state AND the sentence explaining it, so the front end can never invent a reason.
CREATE OR REPLACE FUNCTION public.sv_admin_cockpit(p_secret text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$
;
comment on function public.sv_admin_cockpit(p_secret text) is $c$Everything the cockpit paints, in one round trip, because David asked for no lengthy processes and a board that needs nine requests is out of date before it finishes painting. Every lamp returns its state AND the sentence explaining it, so the front end can never invent a reason.$c$;

CREATE OR REPLACE FUNCTION public.sv_admin_contact(p_secret text, p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare c public.contacts%rowtype;
begin
  perform private.require(p_secret);
  select * into c from public.contacts where id = p_id;
  if not found then return null; end if;

  return jsonb_build_object(
    'contact', to_jsonb(c) || jsonb_build_object('ai_dialable', (c.line_type in ('landline','fixedVoip'))),
    'calls', (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb) from (
        select id, call_sid, direction, status, answered_by, duration_seconds, recording_sid,
               summary, sentiment, disposition, placed, refused_reason, call_class,
               ai_speaking, ai_listening, disclosure_verified, created_at
          from public.calls where contact_id = p_id order by created_at desc limit 50) x),
    'notes', (select coalesce(jsonb_agg(to_jsonb(x) order by x.pinned desc, x.at desc), '[]'::jsonb) from (
        select id, body, author, pinned, at, call_sid from public.notes
         where contact_id = p_id order by pinned desc, at desc limit 100) x),
    'tasks', (select coalesce(jsonb_agg(to_jsonb(x) order by
                (x.status='open') desc, x.due_at asc nulls last), '[]'::jsonb) from (
        select id, title, body, due_at, status, priority, assignee, created_by, created_at,
               done_at, done_by
          from public.crm_tasks where contact_id = p_id order by created_at desc limit 100) x),
    'consent', (select coalesce(jsonb_agg(to_jsonb(x) order by x.granted_at desc), '[]'::jsonb) from (
        select scope, written, source, granted_at, expires_at from public.consent
         where phone = c.phone) x),
    'suppression', (select to_jsonb(s) from public.suppression s where s.phone = c.phone),
    'audit', (select coalesce(jsonb_agg(jsonb_build_object(
        'actor_email', a.actor_email, 'action', a.action, 'payload', a.payload, 'at', a.at)
        order by a.at desc), '[]'::jsonb)
        from (select * from public.admin_audit
               where target_kind = 'contact' and target_id = p_id::text
               order by at desc limit 50) a)
  );
end $function$
;

-- fixed_line is a PROPERTY of the phone number. callable_now is a PERMISSION and is computed from the same do-not-call gate the per-record preflight uses, so the list and the record cannot drift apart. They did: the list once claimed 1,212 callable while every record said none were.
CREATE OR REPLACE FUNCTION public.sv_admin_contact_facets(p_secret text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_dnc jsonb; v_gate_open boolean;
begin
  perform private.require(p_secret);

  begin
    v_dnc := public.sv_dnc_readiness(p_secret);
  exception when others then
    v_dnc := jsonb_build_object('scrub_ready', false, 'procedures_ready', false);
  end;
  -- The same condition the per-record preflight applies. One authority, two surfaces.
  v_gate_open := coalesce((v_dnc->>'scrub_ready')::boolean, false)
             and coalesce((v_dnc->>'procedures_ready')::boolean, false);

  return jsonb_build_object(
    'total',        (select count(*) from public.contacts),
    -- A PROPERTY of the number. Renamed from ai_dialable, which read as permission.
    'fixed_line',   (select count(*) from public.contacts
                      where line_type in ('landline','fixedVoip')),
    -- The PERMISSION, right now. Zero while the registry is unloaded, and that is correct.
    'callable_now', case when v_gate_open
                      then (select count(*) from public.contacts
                             where line_type in ('landline','fixedVoip')
                               and not coalesce(suppressed, false))
                      else 0 end,
    'callable_blocked_because',
      case when v_gate_open then null
           when not coalesce((v_dnc->>'scrub_ready')::boolean, false)
             then 'The national do-not-call registry has never been loaded, so no number can be proven absent from it. Until then nothing is cold-callable, whatever its line type.'
           else 'The written do-not-call procedures required by 47 CFR 64.1200(d) are not all in place.' end,
    'emailable_now',(select count(*) from public.contacts
                      where email is not null and not coalesce(suppressed, false)),
    'textable_line',(select count(*) from public.contacts
                      where line_type in ('mobile','nonFixedVoip')),
    'suppressed',   (select count(*) from public.contacts where coalesce(suppressed,false)),
    'enriched',     (select count(*) from public.contacts where enriched_at is not null),
    'with_email',   (select count(*) from public.contacts where email is not null),
    'with_website', (select count(*) from public.contacts where website is not null),
    'websites_unread', (select count(*) from public.contacts
                         where website is not null and enriched_at is null),
    'lane',        (select coalesce(jsonb_agg(jsonb_build_object('k', coalesce(lane,'none'), 'n', n) order by n desc), '[]'::jsonb)
                      from (select lane, count(*) n from public.contacts group by 1) s),
    'disposition', (select coalesce(jsonb_agg(jsonb_build_object('k', disposition, 'n', n) order by n desc), '[]'::jsonb)
                      from (select disposition, count(*) n from public.contacts group by 1) s),
    'line_type',   (select coalesce(jsonb_agg(jsonb_build_object('k', coalesce(line_type,'unknown'), 'n', n) order by n desc), '[]'::jsonb)
                      from (select line_type, count(*) n from public.contacts group by 1) s),
    'trade',       (select coalesce(jsonb_agg(jsonb_build_object('k', trade, 'n', n) order by n desc), '[]'::jsonb)
                      from (select trade, count(*) n from public.contacts where trade is not null group by 1 order by 2 desc limit 24) s),
    'state',       (select coalesce(jsonb_agg(jsonb_build_object('k', state, 'n', n) order by n desc), '[]'::jsonb)
                      from (select state, count(*) n from public.contacts where state is not null group by 1 order by 2 desc limit 60) s),
    'owner',       (select coalesce(jsonb_agg(jsonb_build_object('k', owner, 'n', n) order by n desc), '[]'::jsonb)
                      from (select owner, count(*) n from public.contacts where owner is not null group by 1) s)
  );
end $function$
;
comment on function public.sv_admin_contact_facets(p_secret text) is $c$fixed_line is a PROPERTY of the phone number. callable_now is a PERMISSION and is computed from the same do-not-call gate the per-record preflight uses, so the list and the record cannot drift apart. They did: the list once claimed 1,212 callable while every record said none were.$c$;

CREATE OR REPLACE FUNCTION public.sv_admin_contact_update(p_secret text, p_id uuid, p_patch jsonb, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare c public.contacts%rowtype;
begin
  perform private.require(p_secret);

  -- An operator may set exactly these. Everything else on the row is measured from a source
  -- (line_type from a carrier lookup, lane from the gate) and must not be typed over by hand:
  -- a hand-edited lane would be a compliance decision made in a text box.
  update public.contacts set
    disposition = coalesce(nullif(p_patch->>'disposition',''), disposition),
    owner       = case when p_patch ? 'owner' then nullif(p_patch->>'owner','') else owner end,
    score       = case when p_patch ? 'score' then (p_patch->>'score')::int else score end,
    tags        = case when p_patch ? 'tags'
                       then coalesce((select array_agg(t) from jsonb_array_elements_text(p_patch->'tags') t), '{}')
                       else tags end,
    contact_name= case when p_patch ? 'contact_name' then nullif(p_patch->>'contact_name','') else contact_name end,
    contact_role= case when p_patch ? 'contact_role' then nullif(p_patch->>'contact_role','') else contact_role end,
    email       = case when p_patch ? 'email' then nullif(p_patch->>'email','') else email end,
    updated_at  = now()
  where id = p_id
  returning * into c;

  if not found then return jsonb_build_object('ok', false, 'error', 'no such contact'); end if;
  return jsonb_build_object('ok', true, 'contact', to_jsonb(c));
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_contacts(p_secret text, p_q text, p_lane text, p_disposition text, p_state text, p_trade text, p_line_type text, p_owner text, p_tag text, p_suppressed boolean, p_reach text, p_enriched text, p_sort text, p_limit integer, p_offset integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_rows jsonb; v_total bigint; v_lim integer; v_off integer;
begin
  perform private.require(p_secret);
  v_lim := greatest(1, least(coalesce(p_limit, 50), 200));
  v_off := greatest(0, coalesce(p_offset, 0));

  with filtered as (
    select c.* from public.contacts c
     where (p_lane        is null or c.lane = p_lane)
       and (p_disposition is null or c.disposition = p_disposition)
       and (p_state       is null or c.state = p_state)
       and (p_trade       is null or c.trade = p_trade)
       and (p_line_type   is null or c.line_type = p_line_type)
       and (p_owner       is null or c.owner = p_owner)
       and (p_tag         is null or c.tags @> array[p_tag])
       and (p_suppressed  is null or coalesce(c.suppressed,false) = p_suppressed)
       and (p_reach is null or p_reach = '' or
            (p_reach = 'email'  and c.email is not null) or
            (p_reach = 'fixed'  and c.line_type in ('landline','fixedVoip')) or
            (p_reach = 'mobile' and c.line_type in ('mobile','nonFixedVoip')) or
            (p_reach = 'none'   and c.email is null
                                and (c.line_type is null or c.line_type = 'tollFree')))
       and (p_enriched is null or p_enriched = '' or
            (p_enriched = 'done' and c.enriched_at is not null) or
            (p_enriched = 'todo' and c.enriched_at is null and c.website is not null))
       and (p_q is null or p_q = '' or (
              c.name ilike '%'||p_q||'%' or c.phone ilike '%'||p_q||'%' or c.city ilike '%'||p_q||'%'
           or c.website ilike '%'||p_q||'%' or c.street ilike '%'||p_q||'%'
           or coalesce(c.email,'') ilike '%'||p_q||'%'
           or coalesce(c.contact_name,'') ilike '%'||p_q||'%'
           or (p_q ~ '^[0-9a-f-]{36}$' and c.id::text = p_q)))
  ),
  page as (
    select c.id, c.name, c.phone, c.trade, c.state, c.city, c.website, c.line_type, c.carrier,
           c.lane, c.lane_reasons, c.disposition, c.owner, c.tags, c.score, c.suppressed,
           c.suppressed_reason, c.call_count, c.first_contacted_at, c.last_contacted_at,
           c.created_at, c.contact_name, c.contact_role, c.email, c.linkedin_url, c.enriched_at,
           c.first_seen_via,
           coalesce(c.line_type in ('landline','fixedVoip'), false) as ai_dialable,
           (select count(*) from public.notes nt where nt.contact_id = c.id) as note_count,
           (select count(*) from public.crm_tasks t
             where t.contact_id = c.id and t.status = 'open')        as open_tasks
      from filtered c
     order by
       case when coalesce(p_sort,'recent') = 'recent'  then c.created_at end desc nulls last,
       case when p_sort = 'name'    then lower(c.name) end asc  nulls last,
       case when p_sort = 'calls'   then c.call_count end desc nulls last,
       case when p_sort = 'touched' then c.last_contacted_at end desc nulls last,
       c.created_at desc
     limit v_lim offset v_off
  )
  select (select count(*) from filtered),
         coalesce((select jsonb_agg(to_jsonb(page)) from page), '[]'::jsonb)
    into v_total, v_rows;

  return jsonb_build_object('total', v_total, 'limit', v_lim, 'offset', v_off, 'rows', v_rows);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_contacts_bulk(p_secret text, p_ids uuid[], p_action text, p_value text, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n integer := 0;
begin
  perform private.require(p_secret);
  if p_ids is null or array_length(p_ids, 1) is null then
    return jsonb_build_object('ok', false, 'error', 'nothing was selected');
  end if;
  if array_length(p_ids, 1) > 5000 then
    return jsonb_build_object('ok', false, 'error',
      'that is more than 5,000 rows in one action. Narrow the filter or do it in passes, so a mistake is recoverable.');
  end if;

  if p_action = 'disposition' then
    update public.contacts set disposition = p_value, updated_at = now()
     where id = any(p_ids) and disposition is distinct from p_value;
    get diagnostics n = row_count;

  elsif p_action = 'owner' then
    update public.contacts set owner = nullif(p_value,''), updated_at = now()
     where id = any(p_ids) and owner is distinct from nullif(p_value,'');
    get diagnostics n = row_count;

  elsif p_action = 'tag_add' then
    update public.contacts set tags = array(select distinct unnest(tags || array[p_value])), updated_at = now()
     where id = any(p_ids) and not (tags @> array[p_value]);
    get diagnostics n = row_count;

  elsif p_action = 'tag_remove' then
    update public.contacts set tags = array_remove(tags, p_value), updated_at = now()
     where id = any(p_ids) and tags @> array[p_value];
    get diagnostics n = row_count;

  elsif p_action = 'suppress' then
    -- Suppression is a compliance act, so it writes the durable suppression ledger too, not just
    -- a flag on the row. The ledger is what the dial gate reads.
    update public.contacts set suppressed = true, suppressed_reason = coalesce(nullif(p_value,''),'operator'),
           suppressed_at = now(), disposition = 'do_not_call', updated_at = now()
     where id = any(p_ids) and not suppressed;
    get diagnostics n = row_count;
    insert into public.suppression (phone, reason, source)
      select c.phone, coalesce(nullif(p_value,''),'operator'), 'admin console'
        from public.contacts c where c.id = any(p_ids)
      on conflict (phone) do nothing;

  else
    return jsonb_build_object('ok', false, 'error', 'unknown bulk action: ' || coalesce(p_action,'(none)'));
  end if;

  return jsonb_build_object('ok', true, 'action', p_action, 'value', p_value,
    'selected', array_length(p_ids, 1), 'changed', n,
    'unchanged', array_length(p_ids, 1) - n,
    'note', case when n < array_length(p_ids,1)
                 then 'Rows that already had this value were left alone and are counted as unchanged.'
                 else null end);
end $function$
;

-- Accepts the event name as either "name" or "event" because the /api/event collector sends the latter. Deliberately liberal: a field name is not worth a coordinated redeploy of a live endpoint, and the alternative was a queryable table that stayed empty forever while every surface reported success.
CREATE OR REPLACE FUNCTION public.sv_admin_event(p_secret text, p_row jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$
;
comment on function public.sv_admin_event(p_secret text, p_row jsonb) is $c$Accepts the event name as either "name" or "event" because the /api/event collector sends the latter. Deliberately liberal: a field name is not worth a coordinated redeploy of a live endpoint, and the alternative was a queryable table that stayed empty forever while every surface reported success.$c$;

CREATE OR REPLACE FUNCTION public.sv_admin_event_claim(p_secret text, p_anon_id text, p_account_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n integer;
begin
  perform private.require(p_secret);
  update public.app_events set account_id = p_account_id
   where anon_id = p_anon_id and account_id is null;
  get diagnostics n = row_count;
  return n;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_events(p_secret text, p_account uuid, p_name text, p_since timestamp with time zone, p_limit integer, p_offset integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v jsonb; n int; lim int; off int; since timestamptz;
begin
  perform private.require(p_secret);
  lim := greatest(1, least(coalesce(p_limit, 100), 500));
  off := greatest(0, coalesce(p_offset, 0));
  since := coalesce(p_since, now() - interval '30 days');

  select count(*) into n from public.app_events e
   where e.at >= since and (p_account is null or e.account_id = p_account)
     and (p_name is null or e.name = p_name);

  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v from (
    select e.id, e.name, e.page, e.meta, e.source, e.at, e.account_id, e.anon_id,
           a.business_name
      from public.app_events e
      left join public.accounts a on a.id = e.account_id
     where e.at >= since and (p_account is null or e.account_id = p_account)
       and (p_name is null or e.name = p_name)
     order by e.at desc limit lim offset off
  ) x;

  return jsonb_build_object(
    'total', n, 'limit', lim, 'offset', off, 'since', since, 'rows', v,
    'filtered_by_name', p_name,
    -- Say what scope each breakdown was computed at, so a caller never has to infer it.
    'by_name_scope', 'all_names',
    'by_day_scope',  case when p_name is null then 'all_names' else 'this_name' end,
    'by_name', (select coalesce(jsonb_agg(jsonb_build_object(
                  'name', g.name, 'n', g.n, 'accounts', g.accts, 'last_at', g.last_at)
                  order by g.n desc), '[]'::jsonb)
                from (select name, count(*) as n, count(distinct account_id) as accts,
                             max(at) as last_at
                        from public.app_events where at >= since
                         and (p_account is null or account_id = p_account)
                       group by name) g),
    'by_day', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'n', d.n)
                 order by d.day), '[]'::jsonb)
               from (select date_trunc('day', at)::date as day, count(*) as n
                       from public.app_events where at >= since
                        and (p_account is null or account_id = p_account)
                        and (p_name is null or name = p_name)
                      group by 1) d)
  );
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_jobs(p_secret text, p_q text, p_status text, p_account uuid, p_limit integer, p_offset integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_link_billing(p_secret text, p_account_id uuid, p_account_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare b public.billing_accounts%rowtype;
begin
  perform private.require(p_secret);
  update public.billing_accounts set account_id = p_account_id
   where account_key = p_account_key returning * into b;
  if not found then return jsonb_build_object('ok', false, 'error', 'no such billing account'); end if;
  return jsonb_build_object('ok', true, 'billing', to_jsonb(b));
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_login_attempt(p_secret text, p_admin_id uuid, p_ok boolean, p_ip text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare u public.admin_users%rowtype; v_lock timestamptz;
begin
  perform private.require(p_secret);
  if p_ok then
    update public.admin_users
       set failed_count = 0, locked_until = null, last_login_at = now(),
           last_login_ip = left(coalesce(p_ip,''), 60), updated_at = now()
     where id = p_admin_id returning * into u;
  else
    select * into u from public.admin_users where id = p_admin_id for update;
    if not found then return jsonb_build_object('ok', false); end if;
    -- 5 free, then escalating: 1, 5, 15, 60 minutes, capped. Slow enough to stop a script,
    -- short enough that a tired operator is not locked out of his own business overnight.
    v_lock := case
      when u.failed_count + 1 >= 9 then now() + interval '60 minutes'
      when u.failed_count + 1 >= 8 then now() + interval '15 minutes'
      when u.failed_count + 1 >= 7 then now() + interval '5 minutes'
      when u.failed_count + 1 >= 6 then now() + interval '1 minute'
      else null end;
    update public.admin_users
       set failed_count = u.failed_count + 1, locked_until = v_lock, updated_at = now()
     where id = p_admin_id returning * into u;
  end if;
  return jsonb_build_object('ok', true, 'failed_count', u.failed_count,
                            'locked_until', u.locked_until);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_migrations(p_secret text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v jsonb;
begin
  perform private.require(p_secret);
  select coalesce(jsonb_agg(jsonb_build_object(
           'version', m.version, 'name', m.name, 'statements', to_jsonb(m.statements)
         ) order by m.version), '[]'::jsonb)
    into v
    from supabase_migrations.schema_migrations m;
  return v;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_note_add(p_secret text, p_contact_id uuid, p_call_sid text, p_body text, p_author text, p_pinned boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.notes%rowtype;
begin
  perform private.require(p_secret);
  if coalesce(trim(p_body),'') = '' then
    return jsonb_build_object('ok', false, 'error', 'an empty note helps nobody');
  end if;
  insert into public.notes (contact_id, call_sid, body, author, pinned)
  values (p_contact_id, nullif(p_call_sid,''), trim(p_body), coalesce(p_author,'operator'), coalesce(p_pinned,false))
  returning * into r;
  return jsonb_build_object('ok', true, 'note', to_jsonb(r));
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_note_pin(p_secret text, p_id uuid, p_pinned boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.notes%rowtype;
begin
  perform private.require(p_secret);
  update public.notes set pinned = coalesce(p_pinned,false) where id = p_id returning * into r;
  if not found then return jsonb_build_object('ok', false, 'error', 'no such note'); end if;
  return jsonb_build_object('ok', true, 'note', to_jsonb(r));
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_overview(p_secret text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v jsonb;
begin
  perform private.require(p_secret);
  select jsonb_build_object(
    'at', now(),
    'accounts', jsonb_build_object(
      'total',        (select count(*) from public.accounts),
      'live',         (select count(*) from public.accounts where status = 'live'),
      'awaiting_line',(select count(*) from public.accounts where status = 'awaiting_line'),
      'configuring',  (select count(*) from public.accounts where status = 'configuring'),
      'ready',        (select count(*) from public.accounts where status = 'ready'),
      'draft',        (select count(*) from public.accounts where status = 'draft'),
      'paused',       (select count(*) from public.accounts where status = 'paused'),
      'closed',       (select count(*) from public.accounts where status = 'closed'),
      'new_7d',       (select count(*) from public.accounts where created_at > now() - interval '7 days'),
      'new_30d',      (select count(*) from public.accounts where created_at > now() - interval '30 days')
    ),
    'calls', jsonb_build_object(
      'total',        (select count(*) from public.calls),
      'placed',       (select count(*) from public.calls where placed),
      'refused',      (select count(*) from public.calls where not placed),
      'inbound',      (select count(*) from public.calls where direction = 'inbound'),
      'outbound',     (select count(*) from public.calls where direction = 'outbound'),
      'with_recording',(select count(*) from public.calls where recording_sid is not null),
      'attributed',   (select count(*) from public.calls where account_id is not null),
      'last_24h',     (select count(*) from public.calls where created_at > now() - interval '24 hours'),
      'last_7d',      (select count(*) from public.calls where created_at > now() - interval '7 days'),
      'last_at',      (select max(created_at) from public.calls)
    ),
    'billing', jsonb_build_object(
      'accounts',      (select count(*) from public.billing_accounts),
      'with_card',     (select count(*) from public.billing_accounts where card_on_file),
      'events',        (select count(*) from public.billing_events),
      'open_cents',    (select coalesce(sum(cents),0) from public.billing_events where state = 'open'),
      'paid_cents',    (select coalesce(sum(cents),0) from public.billing_events where state = 'paid'),
      'voided',        (select count(*) from public.billing_events where state = 'voided'),
      'invoices',      (select count(*) from public.billing_invoices),
      'refunds',       (select count(*) from public.billing_refunds),
      'refunded_cents',(select coalesce(sum(amount_cents),0) from public.billing_refunds
                         where status in ('succeeded','recorded_offline'))
    ),
    'events', jsonb_build_object(
      'total',   (select count(*) from public.app_events),
      'last_24h',(select count(*) from public.app_events where at > now() - interval '24 hours'),
      'last_at', (select max(at) from public.app_events),
      'attributed',(select count(*) from public.app_events where account_id is not null)
    ),
    'parley', jsonb_build_object(
      'deals',     (select count(*) from public.truce_deals),
      'settled',   (select count(*) from public.truce_deals where status = 'settled'),
      'no_overlap',(select count(*) from public.truce_deals where status = 'no_overlap'),
      'signatures',(select count(*) from public.truce_signatures)
    ),
    'pipeline', jsonb_build_object(
      'contacts',    (select count(*) from public.contacts),
      'suppressed',  (select count(*) from public.contacts where suppressed),
      'suppression_list',(select count(*) from public.suppression),
      'consent_rows',(select count(*) from public.consent),
      'lines',       (select count(*) from public.lines),
      'campaigns_running',(select count(*) from public.campaigns where status = 'running')
    ),
    'operators', jsonb_build_object(
      'total',   (select count(*) from public.admin_users),
      'active',  (select count(*) from public.admin_users where status = 'active'),
      'sessions_live',(select count(*) from public.admin_sessions
                        where revoked_at is null and expires_at > now())
    )
  ) into v;
  return v;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_parley(p_secret text, p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v jsonb;
begin
  perform private.require(p_secret);
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb) into v from (
    select d.id, d.subject, d.kind, d.status, d.settled_value, d.fee_cents,
           d.created_at, d.settled_at, d.expires_at,
           (select count(*) from public.truce_parties p where p.deal_id = d.id and p.joined_at is not null) as joined,
           (select count(*) from public.truce_parties p where p.deal_id = d.id and p.limit_set_at is not null) as ready,
           (select count(*) from public.truce_signatures s where s.deal_id = d.id) as signatures,
           (select count(*) from public.truce_messages m where m.deal_id = d.id) as messages,
           (d.status = 'settled'
             and (select count(*) from public.truce_signatures s where s.deal_id = d.id) >= 2) as billable
      from public.truce_deals d
     order by d.created_at desc
     limit greatest(1, least(coalesce(p_limit, 100), 500))
  ) x;
  return v;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_purge_probe(p_secret text, p_account_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.accounts%rowtype; n_calls int; n_bill int; n_nums int;
begin
  perform private.require(p_secret);

  select * into a from public.accounts where id = p_account_id;
  if not found then return jsonb_build_object('ok', true, 'note', 'already gone'); end if;

  if a.owner_email !~* '\.invalid$' then
    return jsonb_build_object('ok', false,
      'error', 'refused: this function only removes verification probes on the reserved .invalid domain, and that account is not one');
  end if;

  select count(*) into n_calls from public.calls where account_id = p_account_id;
  select count(*) into n_bill  from public.billing_accounts where account_id = p_account_id;
  select count(*) into n_nums  from public.account_numbers where account_id = p_account_id;
  if n_calls > 0 or n_bill > 0 or n_nums > 0 then
    return jsonb_build_object('ok', false,
      'error', 'refused: that account has real activity attached',
      'calls', n_calls, 'billing', n_bill, 'numbers', n_nums);
  end if;

  delete from public.account_config_versions where account_id = p_account_id;
  delete from public.account_config          where account_id = p_account_id;
  delete from public.account_tokens          where account_id = p_account_id;
  delete from public.account_events          where account_id = p_account_id;
  delete from public.app_events              where account_id = p_account_id;
  delete from public.accounts                where id         = p_account_id;

  -- The audit trail of what an operator did to the probe is NOT deleted. It is append only by
  -- trigger, and a record of a verification run is worth keeping.
  return jsonb_build_object('ok', true, 'purged', p_account_id, 'email', a.owner_email);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_reachable(p_secret text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform private.require(p_secret);
  return jsonb_build_object(
    'total',            (select count(*) from public.contacts),
    'emailable',        (select count(*) from public.contacts
                          where email is not null and not coalesce(suppressed,false)),
    'ai_callable_line', (select count(*) from public.contacts
                          where line_type in ('landline','fixedVoip') and not coalesce(suppressed,false)),
    'textable_line',    (select count(*) from public.contacts
                          where line_type in ('mobile','nonFixedVoip') and not coalesce(suppressed,false)),
    'no_channel',       (select count(*) from public.contacts
                          where coalesce(suppressed,false)
                             or (email is null and (line_type is null or line_type = 'tollFree'))),
    'website_unread',   (select count(*) from public.contacts
                          where website is not null and enriched_at is null),
    'suppressed',       (select count(*) from public.contacts where coalesce(suppressed,false))
  );
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_refund_open(p_secret text, p_row jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.billing_refunds%rowtype;
        v_acct uuid;
        v_ev   public.billing_events%rowtype;
        v_max  integer;
        v_done integer;
begin
  perform private.require(p_secret);

  v_acct := nullif(p_row->>'account_id','')::uuid;
  if v_acct is null then
    return jsonb_build_object('ok', false, 'error', 'a refund needs a billing account');
  end if;
  if (p_row->>'amount_cents')::integer is null or (p_row->>'amount_cents')::integer <= 0 then
    return jsonb_build_object('ok', false, 'error', 'a refund needs a positive amount');
  end if;

  -- Replay: the same idem_key returns the existing row rather than creating a second refund.
  select * into r from public.billing_refunds where idem_key = p_row->>'idem_key';
  if found then
    return jsonb_build_object('ok', true, 'replay', true, 'refund', to_jsonb(r));
  end if;

  -- A refund against a specific charge can never exceed what that charge actually cost, minus
  -- what has already been refunded against it. This is the check that stops a typo becoming a
  -- larger refund than the original sale.
  if nullif(p_row->>'billing_event_id','') is not null then
    select * into v_ev from public.billing_events where id = (p_row->>'billing_event_id')::uuid;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'that charge does not exist');
    end if;
    if v_ev.account_id <> v_acct then
      return jsonb_build_object('ok', false, 'error', 'that charge belongs to a different account');
    end if;
    select coalesce(sum(amount_cents), 0) into v_done from public.billing_refunds
      where billing_event_id = v_ev.id and status in ('pending','succeeded','recorded_offline');
    v_max := v_ev.cents - v_done;
    if (p_row->>'amount_cents')::integer > v_max then
      return jsonb_build_object('ok', false, 'error',
        format('that charge is %s cents and %s is already refunded, so at most %s can be refunded',
               v_ev.cents, v_done, greatest(v_max, 0)));
    end if;
  end if;

  insert into public.billing_refunds
    (account_id, billing_event_id, stripe_invoice_id, stripe_charge_id, amount_cents,
     reason, note, idem_key, created_by, status)
  values
    (v_acct, nullif(p_row->>'billing_event_id','')::uuid, nullif(p_row->>'stripe_invoice_id',''),
     nullif(p_row->>'stripe_charge_id',''), (p_row->>'amount_cents')::integer,
     nullif(p_row->>'reason',''), nullif(p_row->>'note',''), p_row->>'idem_key',
     nullif(p_row->>'created_by',''), coalesce(nullif(p_row->>'status',''), 'pending'))
  returning * into r;

  return jsonb_build_object('ok', true, 'replay', false, 'refund', to_jsonb(r));
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_refund_settle(p_secret text, p_id uuid, p_status text, p_stripe_refund_id text, p_failure text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.billing_refunds%rowtype;
begin
  perform private.require(p_secret);
  if p_status not in ('succeeded','failed','canceled','recorded_offline') then
    return jsonb_build_object('ok', false, 'error', 'unknown refund status');
  end if;
  update public.billing_refunds
     set status = p_status,
         stripe_refund_id = coalesce(nullif(p_stripe_refund_id,''), stripe_refund_id),
         failure_reason = nullif(p_failure,''),
         settled_at = case when p_status in ('succeeded','recorded_offline') then now() else settled_at end
   where id = p_id returning * into r;
  if not found then return jsonb_build_object('ok', false, 'error', 'no such refund'); end if;
  return jsonb_build_object('ok', true, 'refund', to_jsonb(r));
end $function$
;

-- Structure only, never row data. Exports what is actually in the database now, as distinct from sv_admin_migrations which exports what was applied. They diverge the moment anyone runs SQL outside a migration, which is exactly when you need to know.
CREATE OR REPLACE FUNCTION public.sv_admin_schema_snapshot(p_secret text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v jsonb;
begin
  perform private.require(p_secret);

  select jsonb_build_object(
    'taken_at', now(),
    'postgres', current_setting('server_version'),

    'schemas', (select coalesce(jsonb_agg(nspname order by nspname), '[]'::jsonb)
                  from pg_namespace
                 where nspname not like 'pg_%' and nspname <> 'information_schema'),

    'tables', (select coalesce(jsonb_agg(t order by t->>'schema', t->>'name'), '[]'::jsonb) from (
        select jsonb_build_object(
          'schema', c.table_schema, 'name', c.table_name,
          'rls', (select relrowsecurity from pg_class pc
                    join pg_namespace pn on pn.oid = pc.relnamespace
                   where pn.nspname = c.table_schema and pc.relname = c.table_name),
          'comment', obj_description(format('%I.%I', c.table_schema, c.table_name)::regclass, 'pg_class'),
          'columns', (select jsonb_agg(jsonb_build_object(
                        'name', k.column_name, 'type', k.data_type,
                        'nullable', (k.is_nullable = 'YES'), 'default', k.column_default,
                        'comment', col_description(format('%I.%I', k.table_schema, k.table_name)::regclass,
                                                   k.ordinal_position))
                        order by k.ordinal_position)
                      from information_schema.columns k
                     where k.table_schema = c.table_schema and k.table_name = c.table_name)
        ) as t
        from information_schema.tables c
       where c.table_schema in ('public','sealed','private','quarantine')
         and c.table_type = 'BASE TABLE') s),

    'views', (select coalesce(jsonb_agg(jsonb_build_object(
                'schema', schemaname, 'name', viewname, 'definition', definition)
                order by schemaname, viewname), '[]'::jsonb)
                from pg_views where schemaname in ('public','sealed','private')),

    'functions', (select coalesce(jsonb_agg(jsonb_build_object(
                    'schema', n.nspname, 'name', p.proname,
                    'args', pg_get_function_identity_arguments(p.oid),
                    'returns', pg_get_function_result(p.oid),
                    'security_definer', p.prosecdef,
                    'config', to_jsonb(p.proconfig),
                    'acl', to_jsonb(p.proacl::text[]),
                    'comment', obj_description(p.oid, 'pg_proc'),
                    'definition', pg_get_functiondef(p.oid))
                    order by n.nspname, p.proname), '[]'::jsonb)
                    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname in ('public','sealed','private')
                     and p.prokind = 'f'),

    'indexes', (select coalesce(jsonb_agg(jsonb_build_object(
                  'schema', schemaname, 'table', tablename, 'name', indexname, 'definition', indexdef)
                  order by schemaname, tablename, indexname), '[]'::jsonb)
                  from pg_indexes where schemaname in ('public','sealed','private','quarantine')),

    'constraints', (select coalesce(jsonb_agg(jsonb_build_object(
                      'schema', n.nspname, 'table', rel.relname, 'name', con.conname,
                      'type', con.contype, 'definition', pg_get_constraintdef(con.oid))
                      order by n.nspname, rel.relname, con.conname), '[]'::jsonb)
                      from pg_constraint con
                      join pg_class rel on rel.oid = con.conrelid
                      join pg_namespace n on n.oid = rel.relnamespace
                     where n.nspname in ('public','sealed','private')),

    'triggers', (select coalesce(jsonb_agg(jsonb_build_object(
                   'schema', n.nspname, 'table', c.relname, 'name', t.tgname,
                   'definition', pg_get_triggerdef(t.oid))
                   order by n.nspname, c.relname, t.tgname), '[]'::jsonb)
                   from pg_trigger t
                   join pg_class c on c.oid = t.tgrelid
                   join pg_namespace n on n.oid = c.relnamespace
                  where not t.tgisinternal and n.nspname in ('public','sealed','private')),

    'policies', (select coalesce(jsonb_agg(jsonb_build_object(
                   'schema', schemaname, 'table', tablename, 'name', policyname,
                   'command', cmd, 'roles', to_jsonb(roles),
                   'using', qual, 'check', with_check)
                   order by schemaname, tablename, policyname), '[]'::jsonb)
                   from pg_policies where schemaname in ('public','sealed','private')),

    -- The grants are part of the security model and were the subject of a real defect, so they
    -- are exported rather than assumed to be defaults.
    'grants', (select coalesce(jsonb_agg(jsonb_build_object(
                 'schema', table_schema, 'table', table_name, 'grantee', grantee,
                 'privileges', privs) order by table_schema, table_name, grantee), '[]'::jsonb)
                 from (select table_schema, table_name, grantee,
                              string_agg(distinct privilege_type, ',' order by privilege_type) as privs
                         from information_schema.role_table_grants
                        where table_schema in ('public','sealed','private','quarantine')
                          and grantee in ('anon','authenticated','service_role','PUBLIC')
                        group by 1,2,3) g),

    'sequences', (select coalesce(jsonb_agg(jsonb_build_object(
                    'schema', sequence_schema, 'name', sequence_name) order by sequence_name), '[]'::jsonb)
                    from information_schema.sequences
                   where sequence_schema in ('public','sealed','private')),

    'extensions', (select coalesce(jsonb_agg(jsonb_build_object(
                     'name', extname, 'version', extversion) order by extname), '[]'::jsonb)
                     from pg_extension)
  ) into v;

  return v;
end $function$
;
comment on function public.sv_admin_schema_snapshot(p_secret text) is $c$Structure only, never row data. Exports what is actually in the database now, as distinct from sv_admin_migrations which exports what was applied. They diverge the moment anyone runs SQL outside a migration, which is exactly when you need to know.$c$;

CREATE OR REPLACE FUNCTION public.sv_admin_session(p_secret text, p_token_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record;
begin
  perform private.require(p_secret);
  select s.id as sid, s.expires_at, s.revoked_at, u.id, u.email, u.name, u.role, u.status,
         u.must_change
    into r
    from public.admin_sessions s join public.admin_users u on u.id = s.admin_id
   where s.token_hash = p_token_hash;
  if not found then return null; end if;
  if r.revoked_at is not null then return jsonb_build_object('revoked', true); end if;
  if r.expires_at <= now() then return jsonb_build_object('expired', true); end if;
  if r.status <> 'active' then return jsonb_build_object('disabled', true); end if;
  update public.admin_sessions set last_seen_at = now() where id = r.sid;
  return jsonb_build_object('session_id', r.sid, 'admin_id', r.id, 'email', r.email,
                            'name', r.name, 'role', r.role, 'must_change', r.must_change,
                            'expires_at', r.expires_at);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_session_create(p_secret text, p_admin_id uuid, p_token_hash text, p_hours integer, p_ip text, p_ua text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare s public.admin_sessions%rowtype;
begin
  perform private.require(p_secret);
  insert into public.admin_sessions (admin_id, token_hash, expires_at, ip, ua)
  values (p_admin_id, p_token_hash, now() + (coalesce(p_hours,12) || ' hours')::interval,
          left(coalesce(p_ip,''),60), left(coalesce(p_ua,''),300))
  returning * into s;
  return jsonb_build_object('id', s.id, 'expires_at', s.expires_at);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_session_revoke(p_secret text, p_token_hash text, p_all_for uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n integer;
begin
  perform private.require(p_secret);
  if p_all_for is not null then
    update public.admin_sessions set revoked_at = now()
     where admin_id = p_all_for and revoked_at is null;
  else
    update public.admin_sessions set revoked_at = now()
     where token_hash = p_token_hash and revoked_at is null;
  end if;
  get diagnostics n = row_count;
  return n;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_set_cap(p_secret text, p_account_key text, p_cap_cents integer, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare b public.billing_accounts%rowtype; nxt date;
begin
  perform private.require(p_secret);
  if p_cap_cents is null or p_cap_cents < 0 then
    return jsonb_build_object('ok', false, 'error', 'a cap cannot be negative');
  end if;
  select * into b from public.billing_accounts where account_key = p_account_key;
  if not found then return jsonb_build_object('ok', false, 'error', 'no such billing account'); end if;

  if p_cap_cents <= b.cap_cents then
    update public.billing_accounts set cap_cents = p_cap_cents,
           pending_cap_cents = null, pending_cap_month = null
     where id = b.id returning * into b;
    return jsonb_build_object('ok', true, 'applied', 'immediately',
      'note', 'a lower cap can only protect the customer, so it takes effect now', 'billing', to_jsonb(b));
  end if;

  nxt := (date_trunc('month', now()) + interval '1 month')::date;
  update public.billing_accounts
     set pending_cap_cents = p_cap_cents, pending_cap_month = nxt
   where id = b.id returning * into b;
  return jsonb_build_object('ok', true, 'applied', 'next_cycle', 'effective', nxt,
    'note', 'a cap never moves inside a cycle the customer is already standing in',
    'billing', to_jsonb(b));
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_set_password(p_secret text, p_admin_id uuid, p_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform private.require(p_secret);
  update public.admin_users
     set password_hash = p_hash, must_change = false, failed_count = 0,
         locked_until = null, updated_at = now()
   where id = p_admin_id;
  if not found then return jsonb_build_object('ok', false); end if;
  -- Every other session for this operator dies with the old password. A password change that
  -- leaves the attacker's session alive has changed nothing.
  update public.admin_sessions set revoked_at = now()
   where admin_id = p_admin_id and revoked_at is null;
  return jsonb_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_state_pool(p_secret text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_task_add(p_secret text, p_row jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.crm_tasks%rowtype;
begin
  perform private.require(p_secret);
  if coalesce(trim(p_row->>'title'),'') = '' then
    return jsonb_build_object('ok', false, 'error', 'a task needs a title');
  end if;
  insert into public.crm_tasks (contact_id, account_id, title, body, due_at, priority, assignee, created_by)
  values (nullif(p_row->>'contact_id','')::uuid, nullif(p_row->>'account_id','')::uuid,
          trim(p_row->>'title'), nullif(p_row->>'body',''),
          case when (p_row->>'due_at') is not null then (p_row->>'due_at')::timestamptz end,
          coalesce(nullif(p_row->>'priority',''),'normal'), nullif(p_row->>'assignee',''),
          nullif(p_row->>'created_by',''))
  returning * into r;
  return jsonb_build_object('ok', true, 'task', to_jsonb(r));
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_task_set(p_secret text, p_id uuid, p_status text, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.crm_tasks%rowtype;
begin
  perform private.require(p_secret);
  if p_status not in ('open','done','cancelled') then
    return jsonb_build_object('ok', false, 'error', 'unknown task status');
  end if;
  update public.crm_tasks
     set status = p_status,
         done_at = case when p_status = 'done' then now() else null end,
         done_by = case when p_status = 'done' then p_actor else null end
   where id = p_id returning * into r;
  if not found then return jsonb_build_object('ok', false, 'error', 'no such task'); end if;
  return jsonb_build_object('ok', true, 'task', to_jsonb(r));
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_tasks(p_secret text, p_status text, p_assignee text, p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v jsonb;
begin
  perform private.require(p_secret);
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v from (
    select t.id, t.title, t.body, t.due_at, t.status, t.priority, t.assignee, t.created_by,
           t.created_at, t.done_at, t.contact_id, t.account_id,
           c.name as contact_name, c.phone as contact_phone,
           a.business_name as account_name,
           (t.status = 'open' and t.due_at is not null and t.due_at < now()) as overdue
      from public.crm_tasks t
      left join public.contacts c on c.id = t.contact_id
      left join public.accounts a on a.id = t.account_id
     where (p_status is null or t.status = p_status)
       and (p_assignee is null or t.assignee = p_assignee)
     order by (t.status = 'open') desc, t.due_at asc nulls last, t.created_at desc
     limit greatest(1, least(coalesce(p_limit, 200), 500))
  ) x;
  return v;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_usage(p_secret text, p_account uuid, p_since timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_view_delete(p_secret text, p_owner uuid, p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n integer;
begin
  perform private.require(p_secret);
  delete from public.saved_views where id = p_id and owner_id = p_owner;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', n > 0, 'deleted', n,
    'error', case when n = 0 then 'that view does not exist, or it belongs to another operator' end);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_view_save(p_secret text, p_owner uuid, p_scope text, p_name text, p_filters jsonb, p_shared boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.saved_views%rowtype;
begin
  perform private.require(p_secret);
  if coalesce(trim(p_name),'') = '' then
    return jsonb_build_object('ok', false, 'error', 'a view needs a name');
  end if;
  insert into public.saved_views (owner_id, scope, name, filters, shared)
  values (p_owner, p_scope, trim(p_name), coalesce(p_filters,'{}'::jsonb), coalesce(p_shared,false))
  on conflict (owner_id, scope, lower(name))
    do update set filters = excluded.filters, shared = excluded.shared
  returning * into r;
  return jsonb_build_object('ok', true, 'view', to_jsonb(r));
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_admin_views(p_secret text, p_owner uuid, p_scope text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v jsonb;
begin
  perform private.require(p_secret);
  select coalesce(jsonb_agg(to_jsonb(x) order by x.sort_order, x.created_at), '[]'::jsonb) into v from (
    select id, scope, name, filters, shared, sort_order, created_at, used_at,
           (owner_id = p_owner) as mine
      from public.saved_views
     where (p_scope is null or scope = p_scope)
       and (owner_id = p_owner or shared)
  ) x;
  return v;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_autopilot_state(p_secret text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v jsonb;
begin
  perform private.require(p_secret);
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v from (
    select jsonb_build_object(
      'id', k.id, 'name', k.name, 'mode', k.mode, 'status', k.status,
      'autopilot', k.autopilot, 'pacing_per_min', k.pacing_per_min,
      'max_concurrent', k.max_concurrent, 'policy', k.policy,
      'in_flight', (select count(*) from public.calls c
                     where c.campaign_id = k.id
                       and c.status in ('queued','initiated','ringing','in-progress')
                       and c.created_at > now() - interval '30 minutes'),
      'placed_today', (select count(*) from public.calls c
                        where c.campaign_id = k.id and c.placed
                          and c.created_at > date_trunc('day', now() at time zone 'America/Los_Angeles')),
      -- the last fifty attempts decide whether this campaign is still healthy
      'recent', (
        select jsonb_build_object(
          'attempts', count(*),
          'refused', count(*) filter (where not placed),
          'reached', count(*) filter (where answered_by = 'human'),
          'stopped', count(*) filter (where disposition = 'do_not_call')
        )
        from (select * from public.calls c where c.campaign_id = k.id
               order by c.created_at desc limit 50) r
      )
    ) as x
    from public.campaigns k
    where k.autopilot = true and k.status = 'running'
  ) s;
  return v;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_bill_account(p_secret text, p_row jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare a public.billing_accounts;
begin
  perform private.require(p_secret);
  insert into public.billing_accounts (account_key, business_name, email, phone, plan, cap_cents, statement_token)
  values (
    lower(trim(p_row->>'account_key')),
    coalesce(nullif(trim(p_row->>'business_name'),''), 'unnamed account'),
    lower(trim(p_row->>'email')),
    nullif(p_row->>'phone',''),
    coalesce(nullif(p_row->>'plan',''), 'standard'),
    coalesce((p_row->>'cap_cents')::int, 54900),
    replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
  )
  on conflict (account_key) do update
     set business_name = coalesce(nullif(trim(p_row->>'business_name'),''), public.billing_accounts.business_name),
         email         = coalesce(nullif(lower(trim(p_row->>'email')),''), public.billing_accounts.email),
         phone         = coalesce(nullif(p_row->>'phone',''), public.billing_accounts.phone),
         plan          = coalesce(nullif(p_row->>'plan',''), public.billing_accounts.plan)
  returning * into a;
  return jsonb_build_object('id', a.id, 'account_key', a.account_key,
                            'statement_token', a.statement_token, 'cap_cents', a.cap_cents,
                            'plan', a.plan, 'stripe_customer_id', a.stripe_customer_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_bill_card(p_secret text, p_customer text, p_brand text, p_last4 text, p_on_file boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare a public.billing_accounts;
begin
  perform private.require(p_secret);
  update public.billing_accounts
     set card_on_file = coalesce(p_on_file, false), card_brand = p_brand, card_last4 = p_last4
   where stripe_customer_id = p_customer returning * into a;
  if not found then return jsonb_build_object('matched', false); end if;
  return jsonb_build_object('matched', true, 'account_key', a.account_key, 'card_on_file', a.card_on_file);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_bill_context(p_secret text, p_account_key text, p_at timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare a public.billing_accounts; v_at timestamptz; v_cycle date; v_charged int; v_credit int; v_holds int; v_months jsonb;
begin
  perform private.require(p_secret);
  select * into a from public.billing_accounts where account_key = lower(trim(p_account_key));
  if not found then return jsonb_build_object('error','unknown account'); end if;
  v_at    := coalesce(p_at, now());
  v_cycle := date_trunc('month', v_at)::date;

  select coalesce(sum(cents),0) into v_charged from public.billing_events
   where account_id = a.id and cycle_month = v_cycle and state <> 'voided' and counts_toward_cap;
  select coalesce(sum(credit_created_cents),0) - coalesce(sum(credit_applied_cents),0) into v_credit
    from public.billing_events where account_id = a.id and state <> 'voided';
  select count(*) into v_holds from public.billing_events
   where account_id = a.id and kind in ('hold_gov','hold_commercial') and state <> 'voided';
  select jsonb_agg(c order by m) into v_months from (
    select date_trunc('month', occurred_at)::date as m, count(*) as c
      from public.billing_events
     where account_id = a.id and kind in ('booked_job','booked_job_after_hours')
       and state <> 'voided' and occurred_at >= v_at - interval '90 days'
     group by 1) s;

  return jsonb_build_object(
    'account_id', a.id, 'plan', a.plan,
    'cap_cents', case when a.pending_cap_month is not null and a.pending_cap_month <= v_cycle
                      then a.pending_cap_cents else a.cap_cents end,
    'cycle', v_cycle,
    'month_charged_cents', v_charged,
    'quiet_credit_cents', greatest(0, v_credit),
    'first_hold_used', v_holds > 0,
    'quiet_notice_at', a.quiet_notice_at,
    'bookings_last_90d', coalesce(v_months, '[]'::jsonb),
    'statement_token', a.statement_token,
    'stripe_customer_id', a.stripe_customer_id,
    'card_on_file', a.card_on_file);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_bill_invoice(p_secret text, p_account_key text, p_cycle date, p_row jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare a public.billing_accounts; i public.billing_invoices;
begin
  perform private.require(p_secret);
  select * into a from public.billing_accounts where account_key = lower(trim(p_account_key));
  if not found then raise exception 'unknown account'; end if;
  insert into public.billing_invoices (account_id, cycle_month, stripe_invoice_id, status, total_cents, hosted_url, finalized_at, paid_at)
  values (a.id, p_cycle, p_row->>'stripe_invoice_id', coalesce(p_row->>'status','draft'),
          coalesce((p_row->>'total_cents')::int, 0), p_row->>'hosted_url',
          (p_row->>'finalized_at')::timestamptz, (p_row->>'paid_at')::timestamptz)
  on conflict (account_id, cycle_month) do update
     set stripe_invoice_id = coalesce(excluded.stripe_invoice_id, public.billing_invoices.stripe_invoice_id),
         status = excluded.status,
         total_cents = excluded.total_cents,
         hosted_url = coalesce(excluded.hosted_url, public.billing_invoices.hosted_url),
         finalized_at = coalesce(excluded.finalized_at, public.billing_invoices.finalized_at),
         paid_at = coalesce(excluded.paid_at, public.billing_invoices.paid_at)
  returning * into i;
  return jsonb_build_object('id', i.id, 'status', i.status, 'total_cents', i.total_cents,
                            'stripe_invoice_id', i.stripe_invoice_id, 'hosted_url', i.hosted_url);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_bill_mark(p_secret text, p_ids uuid[], p_state text, p_invoice_id text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare n integer;
begin
  perform private.require(p_secret);
  if p_state not in ('invoiced','paid') then raise exception 'sv_bill_mark only moves an event to invoiced or paid'; end if;
  update public.billing_events
     set state = p_state, stripe_invoice_id = coalesce(p_invoice_id, stripe_invoice_id)
   where id = any(p_ids) and state <> 'voided';
  get diagnostics n = row_count;
  return n;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_bill_open_lines(p_secret text, p_account_key text, p_cycle date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare a public.billing_accounts;
begin
  perform private.require(p_secret);
  select * into a from public.billing_accounts where account_key = lower(trim(p_account_key));
  if not found then raise exception 'unknown account'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'label', label,
             'cents', cents, 'occurred_at', occurred_at, 'reason', reason) order by occurred_at)
      from public.billing_events
     where account_id = a.id and cycle_month = p_cycle and state = 'open' and cents > 0), '[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_bill_quiet_notice(p_secret text, p_account_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare a public.billing_accounts;
begin
  perform private.require(p_secret);
  update public.billing_accounts set quiet_notice_at = coalesce(quiet_notice_at, now())
   where account_key = lower(trim(p_account_key)) returning * into a;
  if not found then raise exception 'unknown account'; end if;
  return jsonb_build_object('quiet_notice_at', a.quiet_notice_at);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_bill_record(p_secret text, p_account_key text, p_row jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare
  a public.billing_accounts; e public.billing_events;
  v_cycle date; v_at timestamptz; v_charged int; v_credit int; v_cap int;
  v_gross int; v_charge int; v_room int; v_after_cap int; v_cap_applied int; v_credit_used int; v_cents int;
  v_counts boolean; v_creates int;
begin
  perform private.require(p_secret);
  select * into a from public.billing_accounts where account_key = lower(trim(p_account_key)) for update;
  if not found then raise exception 'unknown account %', p_account_key; end if;

  v_at    := coalesce((p_row->>'occurred_at')::timestamptz, now());
  v_cycle := date_trunc('month', v_at)::date;

  if a.pending_cap_month is not null and a.pending_cap_month <= v_cycle then
    update public.billing_accounts
       set cap_cents = a.pending_cap_cents, pending_cap_cents = null, pending_cap_month = null
     where id = a.id returning * into a;
  end if;
  v_cap := a.cap_cents;

  select * into e from public.billing_events
   where account_id = a.id and idem_key = p_row->>'idem_key';
  if found then
    return jsonb_build_object('replay', true, 'id', e.id, 'cents', e.cents, 'state', e.state,
                              'billable', e.billable, 'reason', e.reason, 'cycle_month', e.cycle_month);
  end if;

  v_gross   := coalesce((p_row->>'gross_cents')::int, 0);
  -- What the engine says to charge, which is not always the list price. Falls back to the list
  -- price only when the caller did not say, so an old caller cannot silently start billing zero.
  v_charge  := coalesce((p_row->>'charge_cents')::int, v_gross);
  v_counts  := coalesce((p_row->>'counts_toward_cap')::boolean, false);
  v_creates := coalesce((p_row->>'credit_created_cents')::int, 0);

  if v_counts then
    select coalesce(sum(cents),0) into v_charged from public.billing_events
     where account_id = a.id and cycle_month = v_cycle and state <> 'voided' and counts_toward_cap;
    v_room       := greatest(0, v_cap - v_charged);
    v_after_cap  := least(v_charge, v_room);
    v_cap_applied:= v_charge - v_after_cap;

    select coalesce(sum(credit_created_cents),0) - coalesce(sum(credit_applied_cents),0) into v_credit
      from public.billing_events where account_id = a.id and state <> 'voided';
    v_credit_used := least(greatest(0, v_credit), v_after_cap);
    v_cents := v_after_cap - v_credit_used;
  else
    v_cap_applied := 0; v_credit_used := 0; v_cents := v_charge;
  end if;

  insert into public.billing_events (
    account_id, idem_key, kind, product, label, occurred_at, cycle_month,
    gross_cents, cap_applied_cents, credit_applied_cents, credit_created_cents, cents,
    billable, rated_ok, counts_toward_cap, reason, evidence, rating)
  values (
    a.id, p_row->>'idem_key', p_row->>'kind', p_row->>'product', p_row->>'label', v_at, v_cycle,
    v_gross, v_cap_applied, v_credit_used, v_creates, v_cents,
    v_cents > 0, coalesce((p_row->>'rated_ok')::boolean, true), v_counts,
    coalesce(p_row->>'reason', 'no reason recorded, which is itself a defect'),
    coalesce(p_row->'evidence', '{}'::jsonb), coalesce(p_row->'rating', '{}'::jsonb))
  returning * into e;

  return jsonb_build_object('replay', false, 'id', e.id, 'cents', e.cents, 'billable', e.billable,
                            'gross_cents', e.gross_cents, 'cap_applied_cents', e.cap_applied_cents,
                            'credit_applied_cents', e.credit_applied_cents,
                            'cycle_month', e.cycle_month, 'reason', e.reason, 'state', e.state);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_bill_set_cap(p_secret text, p_account_key text, p_cap_cents integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare a public.billing_accounts;
begin
  perform private.require(p_secret);
  if p_cap_cents is null or p_cap_cents < 0 then raise exception 'a cap needs a number'; end if;
  update public.billing_accounts
     set pending_cap_cents = p_cap_cents,
         pending_cap_month = (date_trunc('month', now()) + interval '1 month')::date
   where account_key = lower(trim(p_account_key))
  returning * into a;
  if not found then raise exception 'unknown account'; end if;
  return jsonb_build_object('cap_cents', a.cap_cents, 'pending_cap_cents', a.pending_cap_cents,
                            'pending_cap_month', a.pending_cap_month);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_bill_statement(p_secret text, p_account_key text, p_cycle date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare a public.billing_accounts;
begin
  perform private.require(p_secret);
  select * into a from public.billing_accounts where account_key = lower(trim(p_account_key));
  if not found then return jsonb_build_object('error','unknown account'); end if;
  return public.bl_statement_for(a.id, p_cycle)
         || jsonb_build_object('account_key', a.account_key, 'statement_token', a.statement_token);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_bill_stripe_customer(p_secret text, p_account_key text, p_customer text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare a public.billing_accounts;
begin
  perform private.require(p_secret);
  update public.billing_accounts set stripe_customer_id = p_customer
   where account_key = lower(trim(p_account_key)) returning * into a;
  if not found then raise exception 'unknown account'; end if;
  return jsonb_build_object('stripe_customer_id', a.stripe_customer_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_bill_unmark(p_secret text, p_invoice_id text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare n integer;
begin
  perform private.require(p_secret);
  if p_invoice_id is null or p_invoice_id = '' then raise exception 'sv_bill_unmark needs an invoice id'; end if;
  update public.billing_events
     set state = 'open', stripe_invoice_id = null, stripe_invoice_item_id = null
   where stripe_invoice_id = p_invoice_id and state = 'invoiced';
  get diagnostics n = row_count;
  return n;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_board(p_secret text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v jsonb;
begin
  perform private.require(p_secret);
  select jsonb_build_object(
    'at', now(),
    'live', coalesce((
      select jsonb_agg(x order by x->>'queued_at' desc) from (
        select jsonb_build_object(
          'call_sid', c.call_sid, 'status', c.status, 'to', c.to_number, 'from', c.from_number,
          'queued_at', c.queued_at, 'started_at', c.started_at, 'answered_at', c.answered_at,
          'answered_by', c.answered_by, 'conference_name', c.conference_name,
          'operator', c.operator, 'campaign_id', c.campaign_id,
          'contact', case when ct.id is null then null else jsonb_build_object(
            'id', ct.id, 'name', ct.name, 'trade', ct.trade, 'city', ct.city, 'state', ct.state,
            'line_type', ct.line_type, 'disposition', ct.disposition) end,
          'last_line', (select tl.text from public.transcript_lines tl
                         where tl.call_sid = c.call_sid order by tl.at desc limit 1)
        ) as x
        from public.calls c
        left join public.contacts ct on ct.id = c.contact_id
        where c.status in ('queued','initiated','ringing','in-progress')
          and c.created_at > now() - interval '2 hours'
      ) s), '[]'::jsonb),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id, 'phone', l.phone, 'label', l.label, 'purpose', l.purpose, 'status', l.status,
        'area_code', l.area_code, 'daily_cap', l.daily_cap, 'calls_today', l.calls_today,
        'calls_total', l.calls_total, 'reputation', l.reputation, 'rest_until', l.rest_until,
        'active_now', (select count(*) from public.calls c
                        where c.line_id = l.id and c.status in ('queued','initiated','ringing','in-progress'))
      ) order by l.purpose, l.phone) from public.lines l), '[]'::jsonb),
    'campaigns', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', k.id, 'name', k.name, 'mode', k.mode, 'status', k.status, 'autopilot', k.autopilot,
        'pacing_per_min', k.pacing_per_min, 'max_concurrent', k.max_concurrent,
        'halt_reason', k.halt_reason, 'started_at', k.started_at,
        'placed', (select count(*) from public.calls c where c.campaign_id = k.id and c.placed),
        'refused', (select count(*) from public.calls c where c.campaign_id = k.id and not c.placed),
        'reached', (select count(*) from public.calls c where c.campaign_id = k.id and c.answered_by = 'human'),
        'queue', (select count(*) from public.contacts ct
                   where ct.disposition in ('new','queued') and not ct.suppressed
                     and ct.lane in ('green','amber'))
      ) order by k.created_at desc) from public.campaigns k), '[]'::jsonb),
    'today', (
      select jsonb_build_object(
        'placed',  count(*) filter (where placed),
        'refused', count(*) filter (where not placed),
        'human',   count(*) filter (where answered_by = 'human'),
        'machine', count(*) filter (where answered_by like 'machine%'),
        'no_answer', count(*) filter (where status in ('no-answer','busy','failed')),
        'talk_seconds', coalesce(sum(duration_seconds) filter (where answered_by = 'human'),0)
      ) from public.calls where created_at > date_trunc('day', now() at time zone 'America/Los_Angeles')
    ),
    'funnel', (
      select jsonb_object_agg(disposition, n) from (
        select disposition, count(*) n from public.contacts group by 1) s
    ),
    'gate', (
      select jsonb_object_agg(coalesce(lane,'unclassified'), n) from (
        select lane, count(*) n from public.contacts group by 1) s
    )
  ) into v;
  return v;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_bump_line(p_secret text, p_line uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
begin
  perform private.require(p_secret);
  update public.lines
     set calls_today = calls_today + 1, calls_total = calls_total + 1
   where id = p_line;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_calls(p_secret text, p_answered_by text DEFAULT NULL::text, p_campaign uuid DEFAULT NULL::uuid, p_disposition text DEFAULT NULL::text, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v jsonb;
begin
  perform private.require(p_secret);
  select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) into v from (
    select c.id, c.call_sid, c.to_number, c.from_number, c.status, c.answered_by,
           c.ring_seconds, c.duration_seconds, c.created_at, c.answered_at, c.ended_at,
           c.recording_url, c.summary, c.sentiment, c.disposition, c.placed, c.refused_reason,
           c.operator, c.gate,
           ct.name as contact_name, ct.trade, ct.city, ct.state, ct.id as contact_id
      from public.calls c left join public.contacts ct on ct.id = c.contact_id
     where (p_answered_by is null or c.answered_by = p_answered_by)
       and (p_campaign is null or c.campaign_id = p_campaign)
       and (p_disposition is null or c.disposition = p_disposition)
     order by c.created_at desc
     limit least(coalesce(p_limit,100), 500)
  ) s;
  return v;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_claim(p_secret text, p_campaign uuid, p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v jsonb;
begin
  perform private.require(p_secret);
  with picked as (
    select c.id from public.contacts c
     where not c.suppressed
       and not exists (select 1 from public.suppression s where s.phone = c.phone)
       and c.disposition = 'new'
       and c.lane in ('green','amber')
       and c.call_count = 0
     order by random()
     limit least(coalesce(p_limit,5), 50)
     for update skip locked
  ), claimed as (
    update public.contacts c set disposition = 'queued', updated_at = now()
      from picked p where c.id = p.id
    returning c.id, c.phone, c.name, c.trade, c.state, c.city, c.line_type, c.lookup_ok, c.lane
  )
  select coalesce(jsonb_agg(to_jsonb(claimed)), '[]'::jsonb) into v from claimed;
  return v;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_compliance_evidence(p_secret text, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
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
    'ai_listened_without_verified_disclosure', (
      select count(*) from public.calls
       where placed and ai_listening and disclosure_verified is distinct from true
         and created_at >= coalesce(p_since, now() - interval '90 days')
    ),
    -- ★ Rendered so a zero can never be mistaken for a clean bill. @ANSWERED-INTEL made the panel
    -- three-way on this and was right to; the denominator ships with the number so nobody has to
    -- remember to ask for it.
    'ai_listened_total', (
      select count(*) from public.calls
       where placed and ai_listening
         and created_at >= coalesce(p_since, now() - interval '90 days')
    ),
    'refusals', (
      select coalesce(jsonb_agg(jsonb_build_object('code', code, 'reason', reason, 'n', n)
                                order by n desc), '[]'::jsonb)
      from (
        select
          case
            when refused_reason ilike '%do-not-call registry%'        then 'dnc_listed'
            when refused_reason ilike '%registry snapshot%'           then 'dnc_unanswerable'
            when refused_reason ilike '%has not been scrubbed%'       then 'dnc_no_scrub'
            when refused_reason ilike '%condition precedent%'         then 'dnc_no_procedures'
            when refused_reason ilike '%registration and bond%'       then 'state_licensing'
            when refused_reason ilike '%WRITTEN release%'             then 'state_biometric'
            when refused_reason ilike '%prior express consent%'       then 'mobile_no_consent'
            when refused_reason ilike '%not a verified fixed business line%' then 'line_type_unfit'
            when refused_reason ilike '%lookup failed%'               then 'lookup_failed'
            when refused_reason ilike '%no source state%'             then 'no_state'
            when refused_reason ilike '%suppression%'                 then 'suppressed'
            when refused_reason ilike '%already called%'              then 'frequency_cap'
            when refused_reason ilike '%called party pays%'           then 'toll_free'
            else 'other'
          end as code,
          -- the FULL sentence, never cut. Grouping happens on the code above.
          min(refused_reason) as reason,
          count(*) as n
          from public.calls
         where not placed and refused_reason is not null
           and created_at >= coalesce(p_since, now() - interval '90 days')
         group by 1
      ) r
    )
  ) into v;
  return v;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_consent_for(p_secret text, p_phone text, p_scope text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v jsonb;
begin
  perform private.require(p_secret);
  if p_phone is null or p_scope is null then
    return jsonb_build_object('error','a consent read needs both a number and the scope it is for');
  end if;
  select to_jsonb(x) into v from public.consent x
   where x.phone = p_phone and x.scope = p_scope
     and (x.expires_at is null or x.expires_at > now())
   order by x.granted_at desc limit 1;
  -- Suppression outranks consent in both directions, the same rule sv_grant_consent already
  -- enforces on the write side. A number that said stop is reported as having no usable consent
  -- however many forms it has since submitted.
  if exists (select 1 from public.suppression s where s.phone = p_phone)
     or exists (select 1 from public.contacts c where c.phone = p_phone and c.suppressed) then
    return jsonb_build_object('suppressed', true, 'consent', null);
  end if;
  return jsonb_build_object('suppressed', false, 'consent', v);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_contact(p_secret text, p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v jsonb;
begin
  perform private.require(p_secret);
  select jsonb_build_object(
    'contact', to_jsonb(c),
    'calls', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc)
                        from public.calls x where x.contact_id = c.id), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(to_jsonb(m) order by m.at desc)
                        from public.messages m where m.contact_id = c.id), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(to_jsonb(n) order by n.pinned desc, n.at desc)
                        from public.notes n where n.contact_id = c.id), '[]'::jsonb),
    'consent', coalesce((select jsonb_agg(to_jsonb(k) order by k.granted_at desc)
                        from public.consent k where k.phone = c.phone), '[]'::jsonb)
  ) into v from public.contacts c where c.id = p_id;
  return v;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_contacts(p_secret text, p_q text DEFAULT NULL::text, p_lane text DEFAULT NULL::text, p_disposition text DEFAULT NULL::text, p_state text DEFAULT NULL::text, p_trade text DEFAULT NULL::text, p_line_type text DEFAULT NULL::text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v jsonb; total int;
begin
  perform private.require(p_secret);
  select count(*) into total from public.contacts c
   where (p_lane is null or c.lane = p_lane)
     and (p_disposition is null or c.disposition = p_disposition)
     and (p_state is null or c.state = p_state)
     and (p_trade is null or c.trade = p_trade)
     and (p_line_type is null or c.line_type = p_line_type)
     and (p_q is null or c.name ilike '%'||p_q||'%' or c.phone like '%'||p_q||'%' or c.city ilike '%'||p_q||'%');

  select jsonb_build_object('total', total, 'rows', coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb)) into v
  from (
    select c.id, c.phone, c.name, c.trade, c.state, c.city, c.line_type, c.carrier, c.lane,
           c.lane_reasons, c.disposition, c.tags, c.call_count, c.last_contacted_at, c.suppressed,
           c.website, c.score, c.owner
      from public.contacts c
     where (p_lane is null or c.lane = p_lane)
       and (p_disposition is null or c.disposition = p_disposition)
       and (p_state is null or c.state = p_state)
       and (p_trade is null or c.trade = p_trade)
       and (p_line_type is null or c.line_type = p_line_type)
       and (p_q is null or c.name ilike '%'||p_q||'%' or c.phone like '%'||p_q||'%' or c.city ilike '%'||p_q||'%')
     order by c.last_contacted_at desc nulls last, c.created_at desc
     limit least(coalesce(p_limit,100), 500) offset coalesce(p_offset,0)
  ) s;
  return v;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_crm_activity(p_secret text, p_row jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v bigint;
begin
  perform private.require(p_secret);
  insert into public.crm_activity (contact_id, account_id, kind, title, body, payload, source,
                                   actor, ref_kind, ref_id, at)
  values (nullif(p_row->>'contact_id','')::uuid, nullif(p_row->>'account_id','')::uuid,
          coalesce(nullif(p_row->>'kind',''),'event'),
          coalesce(nullif(p_row->>'title',''),'(untitled)'), nullif(p_row->>'body',''),
          coalesce(p_row->'payload','{}'::jsonb), coalesce(nullif(p_row->>'source',''),'system'),
          nullif(p_row->>'actor',''), nullif(p_row->>'ref_kind',''), nullif(p_row->>'ref_id',''),
          coalesce(case when (p_row->>'at') is not null then (p_row->>'at')::timestamptz end, now()))
  returning id into v;
  return v;
end $function$
;

-- THE ONE DOOR into the CRM. Every lane and every automation calls this. Idempotent on phone then email then contact_id. Writes the complete raw payload to crm_intake_raw BEFORE normalising, so a field we have no column for is still captured. Never overwrites a measured field (line_type, carrier, lane) with a supplied one: supplied values fill blanks only.
CREATE OR REPLACE FUNCTION public.sv_crm_capture(p_secret text, p_row jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  c         public.contacts%rowtype;
  v_phone   text;
  v_email   text;
  v_source  text;
  v_matched text;
  v_created boolean := false;
  v_hit     boolean := false;   -- never FOUND: see the note above
  v_raw_id  bigint;
  v_title   text;
begin
  perform private.require(p_secret);
  v_source := coalesce(nullif(trim(p_row->>'source'), ''), 'unknown');

  insert into public.crm_intake_raw (source, external_id, payload)
  values (v_source, nullif(p_row->>'external_id',''), p_row)
  returning id into v_raw_id;

  v_phone := nullif(regexp_replace(coalesce(p_row->>'phone',''), '[^0-9+]', '', 'g'), '');
  if v_phone is not null and v_phone !~ '^\+' and length(v_phone) = 10 then
    v_phone := '+1' || v_phone;
  elsif v_phone is not null and v_phone !~ '^\+' and length(v_phone) = 11 and left(v_phone,1) = '1' then
    v_phone := '+' || v_phone;
  end if;
  if v_phone is not null and v_phone !~ '^\+\d{8,15}$' then v_phone := null; end if;

  v_email := nullif(lower(trim(coalesce(p_row->>'email',''))), '');
  if v_email is not null and position('@' in v_email) < 2 then v_email := null; end if;

  if v_phone is not null then
    select * into c from public.contacts where phone = v_phone limit 1;
    if c.id is not null then v_hit := true; v_matched := 'phone'; end if;
  end if;
  if not v_hit and v_email is not null then
    select * into c from public.contacts where lower(email) = v_email limit 1;
    if c.id is not null then v_hit := true; v_matched := 'email'; end if;
  end if;
  if not v_hit and nullif(p_row->>'contact_id','') is not null then
    select * into c from public.contacts where id = (p_row->>'contact_id')::uuid limit 1;
    if c.id is not null then v_hit := true; v_matched := 'contact_id'; end if;
  end if;

  if not v_hit then
    if v_phone is null and v_email is null then
      update public.crm_intake_raw
         set note = 'refused: no usable phone or email to identify this record'
       where id = v_raw_id;
      return jsonb_build_object('ok', false, 'raw_id', v_raw_id, 'created', false,
        'error', 'a new CRM record needs at least a usable phone or an email. The payload is kept in crm_intake_raw so nothing is lost.');
    end if;
    insert into public.contacts (
      phone, name, trade, state, city, street, website, source, source_id,
      contact_name, contact_role, email, linkedin_url, disposition, owner, tags,
      first_seen_via, intake_count
    ) values (
      coalesce(v_phone, 'email:' || v_email),
      nullif(trim(coalesce(p_row->>'name','')), ''),
      nullif(p_row->>'trade',''), nullif(upper(p_row->>'state'),''), nullif(p_row->>'city',''),
      nullif(p_row->>'street',''), nullif(p_row->>'website',''),
      v_source, nullif(p_row->>'external_id',''),
      nullif(p_row->>'contact_name',''), nullif(p_row->>'contact_role',''),
      v_email, nullif(p_row->>'linkedin_url',''),
      coalesce(nullif(p_row->>'disposition',''), 'new'),
      nullif(p_row->>'owner',''),
      coalesce((select array_agg(t) from jsonb_array_elements_text(p_row->'tags') t), '{}'),
      v_source, 1
    ) returning * into c;
    v_created := true; v_matched := 'created';
  else
    update public.contacts set
      name         = coalesce(name, nullif(trim(coalesce(p_row->>'name','')),'')),
      trade        = coalesce(trade, nullif(p_row->>'trade','')),
      state        = coalesce(state, nullif(upper(p_row->>'state'),'')),
      city         = coalesce(city, nullif(p_row->>'city','')),
      street       = coalesce(street, nullif(p_row->>'street','')),
      website      = coalesce(website, nullif(p_row->>'website','')),
      contact_name = coalesce(contact_name, nullif(p_row->>'contact_name','')),
      contact_role = coalesce(contact_role, nullif(p_row->>'contact_role','')),
      email        = coalesce(email, v_email),
      linkedin_url = coalesce(linkedin_url, nullif(p_row->>'linkedin_url','')),
      tags         = array(select distinct unnest(
                        tags || coalesce((select array_agg(t) from jsonb_array_elements_text(p_row->'tags') t), '{}'))),
      intake_count = intake_count + 1,
      updated_at   = now()
    where id = c.id returning * into c;
  end if;

  update public.crm_intake_raw
     set contact_id = c.id, matched_on = v_matched, created = v_created
   where id = v_raw_id;

  if v_phone is not null then
    insert into public.crm_identities (contact_id, kind, value, source, verified)
    values (c.id, 'phone', v_phone, v_source, true) on conflict do nothing;
  end if;
  if v_email is not null then
    insert into public.crm_identities (contact_id, kind, value, source)
    values (c.id, 'email', v_email, v_source) on conflict do nothing;
  end if;
  if nullif(p_row->>'website','') is not null then
    insert into public.crm_identities (contact_id, kind, value, source)
    values (c.id, 'website', p_row->>'website', v_source) on conflict do nothing;
  end if;
  if nullif(p_row->>'external_id','') is not null then
    insert into public.crm_identities (contact_id, kind, value, label, source)
    values (c.id, 'external', p_row->>'external_id', v_source, v_source) on conflict do nothing;
  end if;

  v_title := coalesce(nullif(p_row->>'title',''),
    case when v_created then 'First seen via ' || v_source else 'Seen again via ' || v_source end);
  insert into public.crm_activity (contact_id, account_id, kind, title, body, payload, source, actor,
                                   ref_kind, ref_id)
  values (c.id, nullif(p_row->>'account_id','')::uuid,
          coalesce(nullif(p_row->>'kind',''), 'intake'), v_title,
          nullif(p_row->>'body',''), p_row, v_source, nullif(p_row->>'actor',''),
          nullif(p_row->>'ref_kind',''), nullif(p_row->>'ref_id',''));

  return jsonb_build_object(
    'ok', true, 'contact_id', c.id, 'created', v_created, 'matched_on', v_matched,
    'raw_id', v_raw_id, 'intake_count', c.intake_count, 'phone', c.phone, 'name', c.name);
end $function$
;
comment on function public.sv_crm_capture(p_secret text, p_row jsonb) is $c$THE ONE DOOR into the CRM. Every lane and every automation calls this. Idempotent on phone then email then contact_id. Writes the complete raw payload to crm_intake_raw BEFORE normalising, so a field we have no column for is still captured. Never overwrites a measured field (line_type, carrier, lane) with a supplied one: supplied values fill blanks only.$c$;

CREATE OR REPLACE FUNCTION public.sv_crm_message(p_secret text, p_row jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.crm_messages%rowtype;
begin
  perform private.require(p_secret);
  insert into public.crm_messages (
    contact_id, account_id, channel, direction, to_addr, from_addr, subject, body, template,
    provider, provider_id, status, failure_reason, meta, ai_assisted, ai_model, sent_by, sent_at
  ) values (
    nullif(p_row->>'contact_id','')::uuid, nullif(p_row->>'account_id','')::uuid,
    p_row->>'channel', coalesce(nullif(p_row->>'direction',''),'outbound'),
    nullif(p_row->>'to_addr',''), nullif(p_row->>'from_addr',''),
    nullif(p_row->>'subject',''), nullif(p_row->>'body',''), nullif(p_row->>'template',''),
    nullif(p_row->>'provider',''), nullif(p_row->>'provider_id',''),
    coalesce(nullif(p_row->>'status',''),'queued'), nullif(p_row->>'failure_reason',''),
    coalesce(p_row->'meta','{}'::jsonb), coalesce((p_row->>'ai_assisted')::boolean,false),
    nullif(p_row->>'ai_model',''), nullif(p_row->>'sent_by',''),
    case when (p_row->>'status') in ('sent','delivered') then now() end
  ) returning * into r;

  -- Every message is also a timeline entry, so one feed answers "what has happened with this
  -- business" without an operator having to know which table to look in.
  insert into public.crm_activity (contact_id, account_id, kind, title, body, payload, source, actor,
                                   ref_kind, ref_id)
  values (r.contact_id, r.account_id, r.channel,
          case r.status
            when 'blocked' then 'Blocked ' || r.channel || ': ' || coalesce(r.failure_reason,'no reason recorded')
            when 'failed'  then 'Failed ' || r.channel || ': ' || coalesce(r.failure_reason,'no reason recorded')
            else initcap(r.direction) || ' ' || r.channel ||
                 coalesce(' — ' || r.subject, coalesce(' to ' || r.to_addr, '')) end,
          left(coalesce(r.body,''), 2000), coalesce(p_row->'meta','{}'::jsonb),
          coalesce(r.provider,'console'), r.sent_by, 'crm_message', r.id::text);

  if r.status in ('sent','delivered') and r.contact_id is not null then
    update public.contacts
       set last_contacted_at = now(),
           first_contacted_at = coalesce(first_contacted_at, now()),
           updated_at = now()
     where id = r.contact_id;
  end if;

  return jsonb_build_object('ok', true, 'message', to_jsonb(r));
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_crm_message_status(p_secret text, p_provider text, p_provider_id text, p_status text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.crm_messages%rowtype;
begin
  perform private.require(p_secret);
  update public.crm_messages
     set status = p_status, failure_reason = nullif(p_reason,''), updated_at = now()
   where provider = p_provider and provider_id = p_provider_id
  returning * into r;
  if r.id is null then return jsonb_build_object('ok', false, 'error', 'no such message'); end if;

  -- A hard bounce or a spam complaint suppresses the contact automatically. Continuing to email
  -- someone whose mailbox rejected us, or who marked us as spam, is how a sending domain dies.
  if p_status in ('bounced','complained') and r.contact_id is not null then
    update public.contacts
       set suppressed = true,
           suppressed_reason = 'email ' || p_status,
           suppressed_at = now(), updated_at = now()
     where id = r.contact_id and not suppressed;
    insert into public.crm_activity (contact_id, kind, title, source, ref_kind, ref_id)
    values (r.contact_id, 'suppression',
            'Suppressed automatically after an email ' || p_status, 'system', 'crm_message', r.id::text);
  end if;
  return jsonb_build_object('ok', true, 'message', to_jsonb(r));
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_crm_outreach_state(p_secret text, p_contact_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  c          public.contacts%rowtype;
  v_supp     public.suppression%rowtype;
  v_cons     integer;
  v_dnc      jsonb;
  v_blocked  boolean;
  v_call_ok  boolean;
  v_call_why text;
  v_sms_ok   boolean;
  v_sms_why  text;
  v_mail_ok  boolean;
  v_mail_why text;
begin
  perform private.require(p_secret);
  select * into c from public.contacts where id = p_contact_id;
  if c.id is null then return null; end if;

  select * into v_supp from public.suppression where phone = c.phone;
  select count(*) into v_cons from public.consent
   where phone = c.phone and (expires_at is null or expires_at > now());

  v_blocked := coalesce(c.suppressed, false) or (v_supp.phone is not null);

  begin
    v_dnc := public.sv_dnc_readiness(p_secret);
  exception when others then
    v_dnc := jsonb_build_object('scrub_ready', false, 'procedures_ready', false,
                                'error', 'do-not-call readiness could not be read, which is a refusal');
  end;

  -- ── CALL. Most absolute first. Unknown is refused, never assumed. ─────────────────────────
  if v_blocked then
    v_call_ok := false;
    v_call_why := 'This number is on our suppression list' ||
      coalesce(': ' || coalesce(c.suppressed_reason, v_supp.reason), '') ||
      '. It is never called again, by anyone, for any reason.';
  elsif c.phone is null or c.phone !~ '^\+\d{8,15}$' then
    v_call_ok := false;
    v_call_why := 'There is no dialable number on this record.';
  elsif c.line_type is null then
    v_call_ok := false;
    v_call_why := 'We have never established what kind of line this is. An unanswerable question is a refusal, so run a line-type lookup before anything dials it.';
  elsif v_cons > 0 then
    v_call_ok := true;
    v_call_why := 'There is a consent record on file for this number, so this is a consented call regardless of line type.';
  elsif c.line_type in ('mobile','nonFixedVoip') then
    v_call_ok := false;
    v_call_why := 'This is a ' || c.line_type || '. An AI voice may not cold-call it without prior express consent. A person may dial and speak to it, which is a different call class.';
  elsif c.line_type = 'tollFree' then
    v_call_ok := false;
    v_call_why := 'Toll free numbers are not dialled: the called party pays.';
  elsif c.line_type not in ('landline','fixedVoip') then
    v_call_ok := false;
    v_call_why := 'Line type "' || c.line_type || '" is not one we have a rule for, so it is refused rather than guessed at.';
  elsif not coalesce((v_dnc->>'scrub_ready')::boolean, false) then
    v_call_ok := false;
    v_call_why := 'The national do-not-call registry has never been loaded, so we cannot prove this number is not on it. That is a condition precedent, not a formality.';
  elsif not coalesce((v_dnc->>'procedures_ready')::boolean, false) then
    v_call_ok := false;
    v_call_why := 'The written do-not-call procedures required by 47 CFR 64.1200(d) are not all in place.';
  else
    v_call_ok := true;
    v_call_why := 'Verified fixed business line, not suppressed, scrubbed against a current registry snapshot.';
  end if;

  -- ── SMS. Same discipline. ─────────────────────────────────────────────────────────────────
  if v_blocked then
    v_sms_ok := false;
    v_sms_why := 'This contact asked not to be contacted. Suppression covers every channel, not only the phone.';
  elsif c.phone is null or c.phone !~ '^\+\d{8,15}$' then
    v_sms_ok := false;
    v_sms_why := 'There is no mobile number on this record.';
  elsif c.line_type is null then
    v_sms_ok := false;
    v_sms_why := 'We have never established what kind of line this is, so we do not know whether it can receive a text. Unknown is not permission.';
  elsif c.line_type in ('mobile','nonFixedVoip') then
    v_sms_ok := true;
    v_sms_why := 'The number is a ' || c.line_type || ', so it can receive text messages.';
  else
    v_sms_ok := false;
    v_sms_why := 'A ' || c.line_type || ' line does not receive text messages.';
  end if;

  -- ── EMAIL. ────────────────────────────────────────────────────────────────────────────────
  if v_blocked then
    v_mail_ok := false;
    v_mail_why := 'This contact asked not to be contacted. Suppression covers every channel.';
  elsif c.email is null or position('@' in c.email) < 2 then
    v_mail_ok := false;
    v_mail_why := 'We hold no email address for this business yet. The enrichment pass reads what each business publishes on its own site; until it reaches this record, this is an honest absence rather than a gap.';
  else
    v_mail_ok := true;
    v_mail_why := 'A business email is on file and this contact is not suppressed.';
  end if;

  return jsonb_build_object(
    'contact_id', c.id, 'name', c.name, 'phone', c.phone, 'email', c.email,
    'line_type', c.line_type, 'lane', c.lane,
    'suppressed', v_blocked,
    'consent_records', v_cons,
    'dnc', v_dnc,
    -- Every boolean is coalesced. No caller may receive a null and decide for itself what it meant.
    'call',  jsonb_build_object('ok', coalesce(v_call_ok, false), 'why', v_call_why,
             'class', case when v_cons > 0 then 'consented'
                           when c.line_type in ('landline','fixedVoip') then 'ai_cold'
                           else null end),
    'email_db', jsonb_build_object('ok', coalesce(v_mail_ok, false), 'why', v_mail_why),
    'sms_db',   jsonb_build_object('ok', coalesce(v_sms_ok,  false), 'why', v_sms_why),
    'counts', jsonb_build_object(
      'messages', (select count(*) from public.crm_messages m where m.contact_id = c.id),
      'calls',    (select count(*) from public.calls cl where cl.contact_id = c.id),
      'last_contacted_at', c.last_contacted_at)
  );
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_crm_thread(p_secret text, p_contact_id uuid, p_limit integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_rows jsonb;
  v_total int;
  v_counts jsonb;
begin
  perform private.require(p_secret);

  select count(*) into v_total from public.crm_messages where contact_id = p_contact_id;

  -- Per-channel, per-direction and per-status counts, so the header can state what is in the thread
  -- without the client re-deriving it from a windowed list. A count computed from a page of 200 is
  -- a different number from the truth and would silently disagree with itself on the 201st message.
  select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) into v_counts from (
    select channel || '_' || direction as k, count(*) as n
      from public.crm_messages where contact_id = p_contact_id
     group by 1
    union all
    select 'status_' || status, count(*)
      from public.crm_messages where contact_id = p_contact_id
     group by 1
  ) s;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at asc), '[]'::jsonb) into v_rows
    from (
      select id, channel, direction, to_addr, from_addr, subject, body, status, failure_reason,
             provider, provider_id, ai_assisted, ai_model, sent_by, sent_at, created_at, meta
        from public.crm_messages
       where contact_id = p_contact_id
       order by created_at desc
       limit greatest(1, least(coalesce(p_limit, 200), 500))
    ) t;

  return jsonb_build_object(
    'ok', true,
    'contact_id', p_contact_id,
    'total', v_total,
    'returned', jsonb_array_length(v_rows),
    -- The client must never infer "this is everything" from a full page. Say it explicitly.
    'truncated', v_total > jsonb_array_length(v_rows),
    'counts', v_counts,
    'messages', v_rows
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sv_crm_timeline(p_secret text, p_contact_id uuid, p_account_id uuid, p_limit integer, p_before timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v jsonb;
begin
  perform private.require(p_secret);
  select coalesce(jsonb_agg(to_jsonb(x) order by x.at desc), '[]'::jsonb) into v from (
    select a.id, a.kind, a.title, a.body, a.source, a.actor, a.ref_kind, a.ref_id, a.at, a.payload
      from public.crm_activity a
     where ((p_contact_id is not null and a.contact_id = p_contact_id)
         or (p_account_id is not null and a.account_id = p_account_id))
       and (p_before is null or a.at < p_before)
     order by a.at desc
     limit greatest(1, least(coalesce(p_limit, 100), 300))
  ) x;
  return v;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_dial_context(p_secret text, p_phone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v jsonb; fresh uuid;
begin
  perform private.require(p_secret);

  select id into fresh from public.dnc_snapshots
   where notes = 'complete' and downloaded_at > now() - interval '31 days'
   order by downloaded_at desc limit 1;

  select jsonb_build_object(
    'phone', p_phone,
    'suppressed', exists (select 1 from public.suppression s where s.phone = p_phone)
                  or exists (select 1 from public.contacts c where c.phone = p_phone and c.suppressed),
    'dnc_listed', case when fresh is null then null
                       else exists (select 1 from public.dnc_registry r
                                     where r.phone = p_phone and r.snapshot_id = fresh) end,
    'dnc_snapshot_fresh', fresh is not null,
    'contact', (select to_jsonb(c) from public.contacts c where c.phone = p_phone),
    'calls_30d', (
      select count(*) from public.calls k
       where k.to_number = p_phone and k.placed
         and k.created_at > now() - interval '30 days'
    ),
    'consent', (
      select to_jsonb(x) from public.consent x
       where x.phone = p_phone and x.scope = 'research_call'
         and (x.expires_at is null or x.expires_at > now())
       order by x.granted_at desc limit 1
    )
  ) into v;
  return v;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_dnc_begin_snapshot(p_secret text, p_san text, p_source text DEFAULT 'national_dnc'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v uuid;
begin
  perform private.require(p_secret);
  -- downloaded_at is set far in the past until the load completes, so an interrupted ingest leaves
  -- a snapshot the freshness check will never accept.
  insert into public.dnc_snapshots (source, san, downloaded_at, notes)
  values (coalesce(p_source,'national_dnc'), p_san, now() - interval '100 years', 'loading')
  returning id into v;
  return jsonb_build_object('snapshot_id', v);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_dnc_finish_snapshot(p_secret text, p_snapshot uuid, p_numbers bigint, p_area_codes text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
begin
  perform private.require(p_secret);
  if p_numbers <= 0 then
    return jsonb_build_object('error','refusing to mark an empty snapshot as complete');
  end if;
  update public.dnc_snapshots
     set downloaded_at = now(), numbers = p_numbers, area_codes = coalesce(p_area_codes,'{}'), notes = 'complete'
   where id = p_snapshot;
  -- retire the numbers belonging to older snapshots for the same area codes
  delete from public.dnc_registry r
   where r.snapshot_id <> p_snapshot and r.area_code = any(coalesce(p_area_codes,'{}'));
  return jsonb_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_dnc_listed(p_secret text, p_phone text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare fresh uuid;
begin
  perform private.require(p_secret);
  select id into fresh from public.dnc_snapshots
   where notes = 'complete' and downloaded_at > now() - interval '31 days'
   order by downloaded_at desc limit 1;
  if fresh is null then return null; end if;   -- null means "cannot answer", never "not listed"
  return exists (select 1 from public.dnc_registry where phone = p_phone and snapshot_id = fresh);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_dnc_load(p_secret text, p_snapshot uuid, p_numbers text[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare n int;
begin
  perform private.require(p_secret);
  insert into public.dnc_registry (phone, snapshot_id)
  select unnest(p_numbers), p_snapshot
  on conflict (phone) do update set snapshot_id = excluded.snapshot_id;
  get diagnostics n = row_count;
  return n;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_dnc_readiness(p_secret text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_dnc_request(p_secret text, p_phone text, p_channel text, p_heard_as text DEFAULT NULL::text, p_call_sid text DEFAULT NULL::text, p_by text DEFAULT 'system'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_enrich_contact(p_secret text, p_phone text, p_patch jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
begin
  perform private.require(p_secret);
  update public.contacts set
    contact_name       = coalesce(p_patch->>'contact_name', contact_name),
    contact_role       = coalesce(p_patch->>'contact_role', contact_role),
    email              = coalesce(p_patch->>'email', email),
    email_source       = coalesce(p_patch->>'email_source', email_source),
    linkedin_url       = coalesce(p_patch->>'linkedin_url', linkedin_url),
    website            = coalesce(website, p_patch->>'website'),
    -- overwritten every attempt, including being CLEARED when an attempt finally succeeds
    enrichment_failed_reason = p_patch->>'failed_reason',
    enriched_at        = now(),
    enrichment_sources = (
      select array(select distinct unnest(
        coalesce(enrichment_sources,'{}') ||
        coalesce((select array_agg(x) from jsonb_array_elements_text(p_patch->'sources') x), '{}')))
    ),
    updated_at         = now()
  where phone = p_phone;
  return jsonb_build_object('ok', found);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_exec(p_secret text, p_table text, p_row jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v jsonb;
begin
  perform private.require(p_secret);
  if p_table = 'lines' then
    insert into public.lines (phone, twilio_sid, label, purpose, status, area_code, daily_cap, notes)
    values (p_row->>'phone', p_row->>'twilio_sid', p_row->>'label',
            coalesce(p_row->>'purpose','research'), coalesce(p_row->>'status','active'),
            p_row->>'area_code', coalesce((p_row->>'daily_cap')::int, 80), p_row->>'notes')
    on conflict (phone) do update set
      label = coalesce(excluded.label, public.lines.label),
      purpose = coalesce(excluded.purpose, public.lines.purpose),
      -- a quarantined line is never reactivated as a side effect of an unrelated edit
      status = case when public.lines.status = 'quarantined' and coalesce(p_row->>'unquarantine','') <> 'true'
                    then public.lines.status else excluded.status end,
      daily_cap = coalesce(excluded.daily_cap, public.lines.daily_cap),
      notes = coalesce(excluded.notes, public.lines.notes)
    returning to_jsonb(public.lines.*) into v;
  elsif p_table = 'campaigns' then
    insert into public.campaigns (id, name, mode, status, autopilot, pacing_per_min, max_concurrent, policy, script, line_ids)
    values (coalesce((p_row->>'id')::uuid, gen_random_uuid()), p_row->>'name',
            coalesce(p_row->>'mode','discovery'), coalesce(p_row->>'status','draft'),
            coalesce((p_row->>'autopilot')::boolean,false),
            coalesce((p_row->>'pacing_per_min')::int,4), coalesce((p_row->>'max_concurrent')::int,3),
            coalesce(p_row->'policy','{}'::jsonb), coalesce(p_row->'script','{}'::jsonb),
            coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p_row->'line_ids','[]'::jsonb)) x), '{}'))
    on conflict (id) do update set
      -- EVERY field coalesces against what is already there. A partial patch can no longer blank
      -- a policy or a script by not mentioning it.
      name           = coalesce(nullif(p_row->>'name',''), public.campaigns.name),
      mode           = coalesce(p_row->>'mode', public.campaigns.mode),
      status         = coalesce(p_row->>'status', public.campaigns.status),
      autopilot      = coalesce((p_row->>'autopilot')::boolean, public.campaigns.autopilot),
      pacing_per_min = coalesce((p_row->>'pacing_per_min')::int, public.campaigns.pacing_per_min),
      max_concurrent = coalesce((p_row->>'max_concurrent')::int, public.campaigns.max_concurrent),
      policy         = coalesce(p_row->'policy', public.campaigns.policy),
      script         = coalesce(p_row->'script', public.campaigns.script),
      line_ids       = coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p_row->'line_ids') x), public.campaigns.line_ids)
    returning to_jsonb(public.campaigns.*) into v;
  elsif p_table = 'notes' then
    insert into public.notes (contact_id, call_sid, body, author, pinned)
    values ((p_row->>'contact_id')::uuid, p_row->>'call_sid', p_row->>'body',
            p_row->>'author', coalesce((p_row->>'pinned')::boolean,false))
    returning to_jsonb(public.notes.*) into v;
  elsif p_table = 'messages' then
    insert into public.messages (message_sid, contact_id, line_id, direction, from_number, to_number, body, status, operator)
    values (p_row->>'message_sid', (p_row->>'contact_id')::uuid, (p_row->>'line_id')::uuid,
            coalesce(p_row->>'direction','outbound'), p_row->>'from_number', p_row->>'to_number',
            p_row->>'body', p_row->>'status', p_row->>'operator')
    on conflict (message_sid) do update set status = excluded.status
    returning to_jsonb(public.messages.*) into v;
  elsif p_table = 'consent' then
    insert into public.consent (phone, scope, written, source, evidence, ip, user_agent, expires_at)
    values (p_row->>'phone', coalesce(p_row->>'scope','research_call'),
            coalesce((p_row->>'written')::boolean,false), p_row->>'source',
            p_row->'evidence', (p_row->>'ip')::inet, p_row->>'user_agent',
            (p_row->>'expires_at')::timestamptz)
    returning to_jsonb(public.consent.*) into v;
  elsif p_table = 'contact_patch' then
    update public.contacts set
      disposition = coalesce(p_row->>'disposition', disposition),
      owner       = coalesce(p_row->>'owner', owner),
      score       = coalesce((p_row->>'score')::int, score),
      tags        = coalesce((select array_agg(x) from jsonb_array_elements_text(p_row->'tags') x), tags),
      updated_at  = now()
    where id = (p_row->>'id')::uuid
    returning to_jsonb(public.contacts.*) into v;
  else
    raise exception 'unknown target %', p_table;
  end if;
  return v;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_grant_consent(p_secret text, p_phone text, p_source text, p_evidence jsonb DEFAULT '{}'::jsonb, p_scope text DEFAULT 'research_call'::text, p_written boolean DEFAULT false, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_ip inet DEFAULT NULL::inet, p_user_agent text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v_id uuid; v_supp boolean;
begin
  perform private.require(p_secret);

  if p_phone is null or p_phone !~ '^\+1\d{10}$' then
    return jsonb_build_object('error', format('not a US E.164 number: %s', coalesce(p_phone,'null')));
  end if;
  if coalesce(trim(p_source),'') = '' then
    return jsonb_build_object('error','a consent record with no source is not evidence of anything');
  end if;

  -- ★ SUPPRESSION OUTRANKS CONSENT, ALWAYS AND IN BOTH DIRECTIONS. Someone who said stop and later
  -- submits a form has not un-said it. Recording consent for a suppressed number would let a web
  -- form quietly overturn a spoken opt-out, which is the worst failure this system could have.
  select exists (select 1 from public.suppression s where s.phone = p_phone) into v_supp;
  if v_supp then
    return jsonb_build_object('refused','this number is on the do-not-call list; consent cannot override it',
                              'phone_last4', right(p_phone,4));
  end if;

  insert into public.consent (phone, scope, written, source, evidence, ip, user_agent, expires_at)
  values (p_phone, coalesce(p_scope,'research_call'), coalesce(p_written,false), p_source,
          coalesce(p_evidence,'{}'::jsonb), p_ip, p_user_agent, p_expires_at)
  returning id into v_id;

  -- A number that raised its hand should also exist as a contact, so the console can see it and
  -- the funnel counts it. Nothing here overwrites a richer record that already exists.
  insert into public.contacts (phone, source, lane, disposition)
  values (p_phone, coalesce(p_source,'consent'), 'green', 'new')
  on conflict (phone) do update set lane = 'green', updated_at = now();

  return jsonb_build_object('ok', true, 'consent_id', v_id, 'phone_last4', right(p_phone,4), 'scope', coalesce(p_scope,'research_call'));
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_grant_consent_once(p_secret text, p_external_id text, p_phone text, p_source text, p_evidence jsonb DEFAULT '{}'::jsonb, p_scope text DEFAULT 'research_call'::text, p_written boolean DEFAULT false, p_granted_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v jsonb; v_id uuid;
begin
  perform private.require(p_secret);
  if exists (select 1 from public.consent_sources where external_id = p_external_id) then
    return jsonb_build_object('ok', true, 'already', true);
  end if;

  v := public.sv_grant_consent(p_secret, p_phone, p_source, p_evidence, p_scope, p_written, null, null, null);
  if v ? 'error' or v ? 'refused' then return v; end if;

  v_id := (v->>'consent_id')::uuid;
  if p_granted_at is not null then
    update public.consent set granted_at = p_granted_at where id = v_id;
  end if;
  insert into public.consent_sources (external_id, consent_id) values (p_external_id, v_id)
  on conflict (external_id) do nothing;
  return v || jsonb_build_object('already', false);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_halt(p_secret text, p_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
begin
  perform private.require(p_secret);
  update public.campaigns
     set autopilot = false, status = 'halted', halt_reason = p_reason, ended_at = now()
   where id = p_id;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_hold_by_call(p_secret text, p_call_sid text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v public.hold_sessions;
begin
  perform private.require(p_secret);
  select * into v from public.hold_sessions
   where call_sid = p_call_sid or bridge_call_sid = p_call_sid
   order by created_at desc limit 1;
  if not found then return jsonb_build_object('error','no hold session for that call'); end if;
  return jsonb_build_object('session', to_jsonb(v),
    'leg', case when v.bridge_call_sid = p_call_sid then 'user' else 'target' end);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_hold_create(p_secret text, p_row jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v public.hold_sessions;
begin
  perform private.require(p_secret);
  if coalesce(p_row->>'token','') = '' or length(p_row->>'token') < 32 then
    return jsonb_build_object('error','a hold session needs a token of at least 32 characters');
  end if;

  insert into public.hold_sessions (
    token, account_key, requester_phone, requester_email, requester_name, requester_state,
    target_phone, target_label, target_state, reason, reference,
    line_class, line_class_source, line_type, lookup_ok, tree_plan, status, gate, consent_id
  ) values (
    p_row->>'token', p_row->>'account_key', p_row->>'requester_phone', p_row->>'requester_email',
    p_row->>'requester_name', p_row->>'requester_state',
    p_row->>'target_phone', p_row->>'target_label', p_row->>'target_state',
    p_row->>'reason', p_row->>'reference',
    coalesce(p_row->>'line_class','commercial'),
    coalesce(p_row->>'line_class_source','default_commercial'),
    p_row->>'line_type', (p_row->>'lookup_ok')::boolean,
    coalesce(p_row->'tree_plan','[]'::jsonb),
    coalesce(p_row->>'status','queued'),
    p_row->'gate', (p_row->>'consent_id')::uuid
  ) returning * into v;

  insert into public.hold_events (session_id, kind, payload)
  values (v.id, 'session_created', jsonb_build_object(
    'target_label', v.target_label, 'line_class', v.line_class,
    'line_class_source', v.line_class_source, 'status', v.status));

  return to_jsonb(v);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_hold_event(p_secret text, p_id uuid, p_kind text, p_payload jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v bigint;
begin
  perform private.require(p_secret);
  insert into public.hold_events (session_id, kind, payload)
  values (p_id, p_kind, coalesce(p_payload,'{}'::jsonb)) returning id into v;
  return v;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_hold_get(p_secret text, p_id uuid, p_events integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v public.hold_sessions;
begin
  perform private.require(p_secret);
  select * into v from public.hold_sessions where id = p_id;
  if not found then return jsonb_build_object('error','unknown hold session'); end if;
  return jsonb_build_object('session', to_jsonb(v), 'events', coalesce((
    select jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at, 'kind', e.kind, 'payload', e.payload) order by e.id)
    from (select * from public.hold_events where session_id = v.id order by id desc limit p_events) e
  ), '[]'::jsonb));
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_hold_list(p_secret text, p_status text DEFAULT NULL::text, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
begin
  perform private.require(p_secret);
  return coalesce((
    select jsonb_agg(to_jsonb(s) order by s.created_at desc) from (
      select * from public.hold_sessions
       where (p_status is null or status = p_status)
       order by created_at desc limit greatest(1, least(coalesce(p_limit,50), 200))
    ) s), '[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_hold_update(p_secret text, p_id uuid, p_patch jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v public.hold_sessions; merged jsonb; clean jsonb;
begin
  perform private.require(p_secret);
  select * into v from public.hold_sessions where id = p_id;
  if not found then return jsonb_build_object('error','unknown hold session'); end if;

  clean := coalesce(p_patch,'{}'::jsonb) - 'id' - 'token' - 'created_at' - 'queued_at';
  merged := to_jsonb(v) || clean;
  v := jsonb_populate_record(v, merged);
  update public.hold_sessions set
    account_key = v.account_key, requester_email = v.requester_email, requester_name = v.requester_name,
    requester_state = v.requester_state, target_label = v.target_label, target_state = v.target_state,
    reason = v.reason, reference = v.reference,
    line_class = v.line_class, line_class_source = v.line_class_source,
    line_type = v.line_type, lookup_ok = v.lookup_ok,
    tree_plan = v.tree_plan, digits_sent = v.digits_sent, menu_depth = v.menu_depth, attempts = v.attempts,
    status = v.status, outcome = v.outcome, outcome_reason = v.outcome_reason,
    call_sid = v.call_sid, bridge_call_sid = v.bridge_call_sid, conference_name = v.conference_name,
    gate = v.gate, consent_id = v.consent_id, detector = v.detector,
    dialed_at = v.dialed_at, answered_at = v.answered_at, hold_started_at = v.hold_started_at,
    human_at = v.human_at, announced_at = v.announced_at, bridged_at = v.bridged_at, ended_at = v.ended_at,
    machine_wait_ms = v.machine_wait_ms, user_wait_ms = v.user_wait_ms,
    charge_kind = v.charge_kind, charge_cents = v.charge_cents, charge_gross_cents = v.charge_gross_cents,
    charge_reason = v.charge_reason, bill_event_id = v.bill_event_id,
    recording_sid = v.recording_sid, recording_url = v.recording_url, recording_seconds = v.recording_seconds,
    operator_note = v.operator_note
  where id = p_id
  returning * into v;
  return to_jsonb(v);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_job_by_ref(p_secret text, p_ref text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_job_create(p_secret text, p_row jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_job_void(p_secret text, p_ref text, p_reason text, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_jobs_for_account(p_secret text, p_account_id uuid, p_status text, p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_lead_book(p_secret text, p_lane text DEFAULT NULL::text, p_state text DEFAULT NULL::text, p_trade text DEFAULT NULL::text, p_limit integer DEFAULT 200, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v jsonb; total int;
begin
  perform private.require(p_secret);
  select count(*) into total from public.contacts c
   where not c.suppressed
     and (p_lane is null or c.lane = p_lane)
     and (p_state is null or c.state = p_state)
     and (p_trade is null or c.trade = p_trade);

  select jsonb_build_object('total', total, 'rows', coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb)) into v
  from (
    select c.id, c.phone, c.name as business_name, c.contact_name, c.contact_role,
           c.email, c.email_source, c.linkedin_url, c.website, c.trade, c.city, c.state, c.street,
           c.line_type, c.carrier, c.lane, c.lane_reasons, c.disposition, c.tags, c.score,
           c.call_count, c.last_contacted_at, c.lat, c.lon,
           c.enriched_at, c.enrichment_sources, c.enrichment_failed_reason,
           -- four states, never two, so the console never renders "could not read" as "publishes none"
           case when c.enriched_at is null                    then 'never_looked'
                when c.enrichment_failed_reason is not null   then 'could_not_read'
                when c.contact_name is null                   then 'looked_none_published'
                else 'found' end as contact_name_state,
           (c.enrichment_failed_reason is not null)           as retry_worthwhile,
           (c.lane in ('green','amber') and not c.suppressed) as callable
      from public.contacts c
     where not c.suppressed
       and (p_lane is null or c.lane = p_lane)
       and (p_state is null or c.state = p_state)
       and (p_trade is null or c.trade = p_trade)
     order by (c.lane = 'green') desc, c.enriched_at desc nulls last, c.created_at desc
     limit least(coalesce(p_limit,200), 1000) offset coalesce(p_offset,0)
  ) s;
  return v;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_next_batch(p_secret text, p_limit integer DEFAULT 25, p_lane text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v jsonb;
begin
  perform private.require(p_secret);
  select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) into v from (
    select c.id, c.phone, c.name, c.trade, c.state, c.city, c.line_type, c.lane, c.call_count
      from public.contacts c
     where not c.suppressed
       and not exists (select 1 from public.suppression sp where sp.phone = c.phone)
       and c.disposition in ('new','queued')
       and c.lane = coalesce(p_lane, c.lane)
       and c.lane in ('green','amber')
       and c.call_count = 0
     order by c.lane desc, random()
     limit least(coalesce(p_limit,25), 200)
  ) s;
  return v;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_qa_delete_account(p_secret text, p_account_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v_email text; v_name text;
begin
  perform private.require(p_secret);
  select owner_email, business_name into v_email, v_name from public.accounts where id = p_account_id;
  if not found then return jsonb_build_object('ok', true, 'deleted', false, 'why', 'no such account'); end if;
  if lower(v_email) <> 'delivered@resend.dev' then
    return jsonb_build_object('ok', false, 'deleted', false, 'why', 'that is not a harness account');
  end if;
  delete from public.accounts where id = p_account_id;
  return jsonb_build_object('ok', true, 'deleted', true, 'business', v_name);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_rate_take(p_secret text, p_bucket text, p_key text, p_limit integer, p_window interval)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'extensions'
AS $function$
declare v_hash text; v_start timestamptz; v_n int;
begin
  perform private.require(p_secret);
  if coalesce(trim(p_key),'') = '' then
    -- No key means we cannot attribute the request, and an unattributable request is refused
    -- rather than waved through. Same posture as an unanswerable registry check.
    return jsonb_build_object('allowed', false, 'reason', 'no rate-limit key');
  end if;
  v_hash := encode(digest(p_key, 'sha256'), 'hex');
  v_start := date_trunc('hour', now()) + floor(extract(epoch from (now() - date_trunc('hour', now())))
             / extract(epoch from p_window))::int * p_window;

  insert into public.rate_limits (bucket, key_hash, window_start, n)
  values (p_bucket, v_hash, v_start, 1)
  on conflict (bucket, key_hash, window_start) do update set n = public.rate_limits.n + 1
  returning n into v_n;

  delete from public.rate_limits where window_start < now() - interval '2 days';
  return jsonb_build_object('allowed', v_n <= p_limit, 'count', v_n, 'limit', p_limit);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_recap_claim(p_secret text, p_key text, p_channel text, p_conversation_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v_row public.recap_deliveries; v_claimed boolean := false;
begin
  perform private.require(p_secret);
  if p_key is null or p_key = '' then
    raise exception 'sv_recap_claim needs a spine key' using errcode = '22023';
  end if;

  insert into public.recap_deliveries (spine_key, conversation_id, channel)
  values (p_key, p_conversation_id, p_channel)
  on conflict (spine_key, channel) do nothing
  returning * into v_row;

  if found then
    v_claimed := true;
  else
    update public.recap_deliveries
       set claimed_at = now(), attempts = attempts + 1, status = 'claimed',
           conversation_id = coalesce(conversation_id, p_conversation_id)
     where spine_key = p_key and channel = p_channel
       and (status = 'failed' or (status = 'claimed' and claimed_at < now() - interval '10 minutes'))
    returning * into v_row;
    if found then
      v_claimed := true;
    else
      select * into v_row from public.recap_deliveries
       where spine_key = p_key and channel = p_channel;
    end if;
  end if;

  return jsonb_build_object('claimed', v_claimed, 'row', to_jsonb(v_row));
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_recap_deliveries(p_secret text, p_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v jsonb;
begin
  perform private.require(p_secret);
  select coalesce(jsonb_agg(to_jsonb(r) order by r.claimed_at desc), '[]'::jsonb) into v
    from public.recap_deliveries r where r.spine_key = p_key;
  return v;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_recap_settle(p_secret text, p_key text, p_channel text, p_status text, p_target text DEFAULT NULL::text, p_provider_id text DEFAULT NULL::text, p_reason text DEFAULT NULL::text, p_lines integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v_row public.recap_deliveries;
begin
  perform private.require(p_secret);
  update public.recap_deliveries
     set status = p_status, target = p_target, provider_id = p_provider_id,
         reason = p_reason, lines = coalesce(p_lines, lines), settled_at = now()
   where spine_key = p_key and channel = p_channel
  returning * into v_row;
  return to_jsonb(v_row);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_record_call(p_secret text, p_row jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v_id uuid;
begin
  perform private.require(p_secret);
  insert into public.calls (
    call_sid, conference_name, contact_id, campaign_id, line_id, direction,
    from_number, to_number, status, gate, operator, placed, refused_reason, call_class,
    ai_speaking, ai_listening, dnc_scrubbed_at_dial, dnc_procedures_at_dial, queued_at
  ) values (
    nullif(p_row->>'call_sid',''), p_row->>'conference_name',
    (p_row->>'contact_id')::uuid, (p_row->>'campaign_id')::uuid, (p_row->>'line_id')::uuid,
    coalesce(p_row->>'direction','outbound'),
    p_row->>'from_number', p_row->>'to_number', p_row->>'status',
    p_row->'gate', p_row->>'operator',
    coalesce((p_row->>'placed')::boolean,false), p_row->>'refused_reason', p_row->>'call_class',
    (p_row->>'ai_speaking')::boolean, (p_row->>'ai_listening')::boolean,
    (p_row->>'dnc_scrubbed_at_dial')::boolean, (p_row->>'dnc_procedures_at_dial')::boolean,
    now()
  )
  on conflict (call_sid) do update set
    status = excluded.status,
    call_class = coalesce(public.calls.call_class, excluded.call_class)
  returning id into v_id;

  if (p_row->>'contact_id') is not null and coalesce((p_row->>'placed')::boolean,false) then
    update public.contacts
       set call_count = call_count + 1, last_contacted_at = now(),
           first_contacted_at = coalesce(first_contacted_at, now()),
           disposition = case when disposition = 'new' then 'attempted' else disposition end
     where id = (p_row->>'contact_id')::uuid;
  end if;
  return v_id;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_recover_bind_call(p_secret text, p_id uuid, p_patch jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare c public.recover_calls%rowtype;
begin
  perform private.require(p_secret);
  update public.recover_calls set
    call_sid       = coalesce(p_patch->>'call_sid', call_sid),
    placed         = coalesce((p_patch->>'placed')::boolean, placed),
    status         = coalesce(p_patch->>'status', status),
    token_sha256   = coalesce(p_patch->>'token_sha256', token_sha256),
    call_class     = coalesce(p_patch->>'call_class', call_class),
    refused_reason = coalesce(p_patch->>'refused_reason', refused_reason),
    outcome        = outcome || coalesce(p_patch->'outcome','{}'::jsonb)
   where id = p_id returning * into c;
  if not found then return jsonb_build_object('error','no such call row'); end if;
  if c.placed then
    update public.recover_invoices
       set first_call_at = coalesce(first_call_at, now()), last_contact_at = now()
     where id = c.invoice_id;
  end if;
  return to_jsonb(c);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_recover_board(p_secret text, p_account_key text, p_status text, p_limit integer, p_offset integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v jsonb;
begin
  perform private.require(p_secret);
  select jsonb_build_object(
    'totals', (select jsonb_build_object(
        'invoices', count(*),
        'open_cents', coalesce(sum(amount_cents - paid_cents) filter (where status in ('open','promised')),0),
        'recovered_cents', coalesce(sum(paid_cents),0),
        'stopped', count(*) filter (where status = 'stopped'),
        'disputed', count(*) filter (where status = 'disputed'))
      from public.recover_invoices
      where (p_account_key is null or account_key = lower(p_account_key))),
    'invoices', coalesce((select jsonb_agg(x order by x->>'created_at' desc) from (
        select jsonb_build_object(
          'id', i.id, 'account_key', i.account_key, 'business_name', i.business_name,
          'invoice_number', i.invoice_number, 'amount_cents', i.amount_cents,
          'paid_cents', i.paid_cents, 'balance_cents', i.amount_cents - i.paid_cents,
          'debtor_name', i.debtor_name, 'debtor_phone', i.debtor_phone, 'debtor_state', i.debtor_state,
          'band', i.band, 'fee_mode', i.fee_mode, 'status', i.status,
          'issued_at', i.issued_at, 'first_call_at', i.first_call_at,
          'last_contact_at', i.last_contact_at, 'next_action_at', i.next_action_at,
          'created_at', i.created_at,
          'calls_placed', (select count(*) from public.recover_calls c where c.invoice_id = i.id and c.placed),
          'calls_refused', (select count(*) from public.recover_calls c where c.invoice_id = i.id and not c.placed),
          'promises', (select count(*) from public.recover_promises p where p.invoice_id = i.id)
        ) as x
        from public.recover_invoices i
        where (p_account_key is null or i.account_key = lower(p_account_key))
          and (p_status is null or i.status = p_status)
        order by i.created_at desc
        limit coalesce(p_limit,50) offset coalesce(p_offset,0)) s), '[]'::jsonb)
  ) into v;
  return v;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_recover_call_context(p_secret text, p_id uuid, p_token_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare c public.recover_calls%rowtype; i public.recover_invoices%rowtype;
begin
  perform private.require(p_secret);
  select * into c from public.recover_calls where id = p_id;
  if not found then return jsonb_build_object('error','no such call'); end if;
  if c.token_sha256 is null or c.token_sha256 <> p_token_sha256 then
    return jsonb_build_object('error','token mismatch');
  end if;
  select * into i from public.recover_invoices where id = c.invoice_id;
  return jsonb_build_object('call', to_jsonb(c), 'invoice', to_jsonb(i),
                            'balance_cents', i.amount_cents - i.paid_cents);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_recover_gate_facts(p_secret text, p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare i public.recover_invoices%rowtype; v jsonb;
begin
  perform private.require(p_secret);
  select * into i from public.recover_invoices where id = p_id;
  if not found then return jsonb_build_object('error','no such invoice'); end if;
  select jsonb_build_object(
    'invoice', to_jsonb(i),
    'balance_cents', i.amount_cents - i.paid_cents,
    'placed_today', (select count(*) from public.recover_calls c
                      where c.invoice_id = i.id and c.placed and c.created_at > now() - interval '1 day'),
    'placed_7d',    (select count(*) from public.recover_calls c
                      where c.invoice_id = i.id and c.placed and c.created_at > now() - interval '7 days'),
    'placed_total', (select count(*) from public.recover_calls c where c.invoice_id = i.id and c.placed),
    'conversations_total', (select count(*) from public.recover_calls c
                      where c.invoice_id = i.id and c.identity_confirmed),
    'suppressed', exists (select 1 from public.suppression s where s.phone = i.debtor_phone)
                  or exists (select 1 from public.contacts c where c.phone = i.debtor_phone and c.suppressed),
    'open_promise', (select to_jsonb(p) from public.recover_promises p
                      where p.invoice_id = i.id and p.kept is null
                      order by p.captured_at desc limit 1)
  ) into v;
  return v;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_recover_get(p_secret text, p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v jsonb;
begin
  perform private.require(p_secret);
  select jsonb_build_object(
    'invoice', to_jsonb(i),
    'balance_cents', i.amount_cents - i.paid_cents,
    'calls', coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at desc)
                         from public.recover_calls c where c.invoice_id = i.id), '[]'::jsonb),
    'promises', coalesce((select jsonb_agg(to_jsonb(p) order by p.captured_at desc)
                         from public.recover_promises p where p.invoice_id = i.id), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(to_jsonb(y) order by y.landed_at desc)
                         from public.recover_payments y where y.invoice_id = i.id), '[]'::jsonb)
  ) into v from public.recover_invoices i where i.id = p_id;
  return coalesce(v, jsonb_build_object('error','no such invoice'));
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_recover_log_call(p_secret text, p_row jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare c public.recover_calls%rowtype;
begin
  perform private.require(p_secret);
  insert into public.recover_calls (
    invoice_id, call_sid, placed, refused_reason, gate, opening_spoken,
    from_number, to_number, status, disposition)
  values (
    (p_row->>'invoice_id')::uuid, p_row->>'call_sid',
    coalesce((p_row->>'placed')::boolean,false), p_row->>'refused_reason',
    coalesce(p_row->'gate','{}'::jsonb), p_row->>'opening_spoken',
    p_row->>'from_number', p_row->>'to_number', p_row->>'status', p_row->>'disposition')
  returning * into c;

  -- first_call_at is stamped ONLY by a call that was actually placed. meter.mjs compares it to
  -- band_shown_at, so letting a refusal stamp it would fabricate a disclosure ordering.
  if c.placed then
    update public.recover_invoices
       set first_call_at   = coalesce(first_call_at, now()),
           last_contact_at = now()
     where id = c.invoice_id;
  end if;
  return to_jsonb(c);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_recover_payment(p_secret text, p_row jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare i public.recover_invoices%rowtype; y public.recover_payments%rowtype;
        v_promise public.recover_promises%rowtype; v_placed int; v_conv int;
begin
  perform private.require(p_secret);
  select * into i from public.recover_invoices where id = (p_row->>'invoice_id')::uuid for update;
  if not found then return jsonb_build_object('error','no such invoice'); end if;

  select * into y from public.recover_payments where idem_key = p_row->>'idem_key';
  if not found then
    insert into public.recover_payments (invoice_id, amount_cents, landed_at, source, reference, recorded_by, idem_key)
    values (i.id, (p_row->>'amount_cents')::int,
            coalesce((p_row->>'landed_at')::timestamptz, now()),
            coalesce(p_row->>'source','operator_confirmed'), p_row->>'reference',
            p_row->>'recorded_by', p_row->>'idem_key')
    returning * into y;

    update public.recover_invoices
       set paid_cents = paid_cents + y.amount_cents,
           status = case when paid_cents + y.amount_cents >= amount_cents then 'paid' else status end
     where id = i.id returning * into i;
  end if;

  select * into v_promise from public.recover_promises
   where invoice_id = i.id and captured_at <= y.landed_at order by captured_at desc limit 1;
  select count(*) into v_placed from public.recover_calls where invoice_id = i.id and placed;
  select count(*) into v_conv   from public.recover_calls where invoice_id = i.id and identity_confirmed;

  return jsonb_build_object(
    'replay', (p_row->>'idem_key') is not null and y.created_at < now() - interval '1 second',
    'payment', to_jsonb(y),
    'invoice', to_jsonb(i),
    'balance_cents', i.amount_cents - i.paid_cents,
    'placed_calls', v_placed,
    'conversations', v_conv,
    -- Everything meter.mjs needs to rate this, read from the record rather than passed in by a caller.
    'meter_inputs', jsonb_build_object(
      'recovered_cents', y.amount_cents,
      'band', i.band,
      'band_shown_at', i.band_shown_at,
      'first_call_at', i.first_call_at,
      'last_contact_at', i.last_contact_at,
      'landed_at', y.landed_at,
      'fee_mode', i.fee_mode),
    -- ★ SPOKEN IS NOT WRITTEN. /terms extends the window only "by a date the payer promised IN
    -- WRITING". A promise captured from speech is returned here for the operator to see, and it is
    -- deliberately NOT offered to the meter as promised_by. See the note in netlify/functions/recover.mjs.
    'spoken_promise', case when v_promise.id is null then null else to_jsonb(v_promise) end
  );
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_recover_payment_rated(p_secret text, p_payment_id uuid, p_rating jsonb, p_billing_event uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare y public.recover_payments%rowtype;
begin
  perform private.require(p_secret);
  update public.recover_payments set fee_rated = p_rating, billing_event_id = p_billing_event
   where id = p_payment_id returning * into y;
  if not found then return jsonb_build_object('error','no such payment'); end if;
  return to_jsonb(y);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_recover_promise(p_secret text, p_row jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare p public.recover_promises%rowtype;
begin
  perform private.require(p_secret);
  insert into public.recover_promises (invoice_id, call_sid, amount_cents, promised_for, spoken_text, method)
  values ((p_row->>'invoice_id')::uuid, p_row->>'call_sid', (p_row->>'amount_cents')::int,
          (p_row->>'promised_for')::date, p_row->>'spoken_text',
          coalesce(p_row->>'method','spoken_on_call'))
  returning * into p;

  -- The page promises "Thursday's follow up happens without you". next_action_at is that promise,
  -- as a column: nothing dials this invoice again until the day after the date they gave.
  update public.recover_invoices
     set status = case when status in ('open','promised') then 'promised' else status end,
         last_conversation_at = now(),
         last_contact_at = now(),
         next_action_at = (p.promised_for + 1)::timestamptz
   where id = p.invoice_id;
  return to_jsonb(p);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_recover_stop(p_secret text, p_id uuid, p_reason text, p_call_sid text, p_kind text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare i public.recover_invoices%rowtype;
begin
  perform private.require(p_secret);
  update public.recover_invoices
     set status = case when p_kind = 'dispute' then 'disputed' else 'stopped' end,
         stop_reason = p_reason,
         next_action_at = null,
         last_contact_at = now()
   where id = p_id returning * into i;
  if not found then return jsonb_build_object('error','no such invoice'); end if;

  -- A stop is a fact about the NUMBER, not about this invoice, so it is written to the estate-wide
  -- suppression list too. A dispute is not: it stops this debt, and says nothing about the person.
  if p_kind <> 'dispute' and i.debtor_phone ~ '^\+\d{8,15}$' then
    insert into public.suppression (phone, reason, source)
    values (i.debtor_phone, coalesce(p_reason,'stop requested on a recover call'), 'recover')
    on conflict (phone) do nothing;
  end if;
  return to_jsonb(i);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_recover_update_call(p_secret text, p_call_sid text, p_patch jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare c public.recover_calls%rowtype;
begin
  perform private.require(p_secret);
  update public.recover_calls set
    status             = coalesce(p_patch->>'status', status),
    answered_by        = coalesce(p_patch->>'answered_by', answered_by),
    duration_seconds   = coalesce((p_patch->>'duration_seconds')::int, duration_seconds),
    disposition        = coalesce(p_patch->>'disposition', disposition),
    identity_confirmed = coalesce((p_patch->>'identity_confirmed')::boolean, identity_confirmed),
    outcome            = outcome || coalesce(p_patch->'outcome','{}'::jsonb),
    ended_at           = coalesce((p_patch->>'ended_at')::timestamptz, ended_at)
   where call_sid = p_call_sid returning * into c;
  if not found then return jsonb_build_object('error','no such call'); end if;

  -- A confirmed identity means a real conversation happened about this debt. That timestamp is
  -- what the 7-day cooldown counts from, so it is written here and nowhere else.
  if c.identity_confirmed then
    update public.recover_invoices
       set last_conversation_at = now(), last_contact_at = now()
     where id = c.invoice_id;
  end if;
  return to_jsonb(c);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_recover_update_call_by_id(p_secret text, p_id uuid, p_patch jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare c public.recover_calls%rowtype;
begin
  perform private.require(p_secret);
  update public.recover_calls set
    call_sid           = coalesce(p_patch->>'call_sid', call_sid),
    status             = coalesce(p_patch->>'status', status),
    answered_by        = coalesce(p_patch->>'answered_by', answered_by),
    duration_seconds   = coalesce((p_patch->>'duration_seconds')::int, duration_seconds),
    disposition        = coalesce(p_patch->>'disposition', disposition),
    identity_confirmed = coalesce((p_patch->>'identity_confirmed')::boolean, identity_confirmed),
    outcome            = outcome || coalesce(p_patch->'outcome','{}'::jsonb),
    ended_at           = coalesce((p_patch->>'ended_at')::timestamptz, ended_at)
   where id = p_id returning * into c;
  if not found then return jsonb_build_object('error','no such call row'); end if;

  if c.identity_confirmed then
    update public.recover_invoices
       set last_conversation_at = now(), last_contact_at = now()
     where id = c.invoice_id;
  end if;
  return to_jsonb(c);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_recover_upsert_invoice(p_secret text, p_row jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v public.recover_invoices%rowtype; existing public.recover_invoices%rowtype; v_band text;
begin
  perform private.require(p_secret);

  select * into existing from public.recover_invoices
   where account_key = lower(trim(p_row->>'account_key'))
     and invoice_number = trim(p_row->>'invoice_number')
   for update;

  v_band := coalesce(p_row->>'band', existing.band);

  -- ★ THE PRICE CANNOT MOVE AFTER WE HAVE DIALLED. /terms promises the band is shown before the
  -- first call; a band edited afterwards would make that promise unfalsifiable.
  if found and existing.first_call_at is not null and v_band is distinct from existing.band then
    return jsonb_build_object('error',
      'this invoice has already been called on band "' || existing.band ||
      '", and the band cannot change after the first call');
  end if;

  if found then
    update public.recover_invoices set
      business_name    = coalesce(p_row->>'business_name', business_name),
      business_phone   = coalesce(p_row->>'business_phone', business_phone),
      amount_cents     = coalesce((p_row->>'amount_cents')::int, amount_cents),
      issued_at        = coalesce((p_row->>'issued_at')::date, issued_at),
      due_at           = coalesce((p_row->>'due_at')::date, due_at),
      job_description  = coalesce(p_row->>'job_description', job_description),
      job_address      = coalesce(p_row->>'job_address', job_address),
      job_completed_on = coalesce((p_row->>'job_completed_on')::date, job_completed_on),
      debtor_name      = coalesce(p_row->>'debtor_name', debtor_name),
      debtor_phone     = coalesce(p_row->>'debtor_phone', debtor_phone),
      debtor_state     = coalesce(p_row->>'debtor_state', debtor_state),
      debtor_timezone  = coalesce(p_row->>'debtor_timezone', debtor_timezone),
      debtor_zone_source = coalesce(p_row->>'debtor_zone_source', debtor_zone_source),
      -- A band change BEFORE the first call restamps when it was shown, because that is when it
      -- was shown. Carrying the old timestamp forward would be a fabricated disclosure date.
      band             = v_band,
      band_shown_at    = case when v_band is distinct from existing.band then now() else band_shown_at end,
      fee_mode         = coalesce(p_row->>'fee_mode', fee_mode),
      fee_mode_reason  = coalesce(p_row->>'fee_mode_reason', fee_mode_reason),
      account_id       = coalesce((p_row->>'account_id')::uuid, account_id)
     where id = existing.id returning * into v;
    return jsonb_build_object('created', false, 'invoice', to_jsonb(v));
  end if;

  insert into public.recover_invoices (
    account_key, account_id, business_name, business_phone, invoice_number, amount_cents,
    issued_at, due_at, job_description, job_address, job_completed_on,
    debtor_name, debtor_phone, debtor_state, debtor_timezone, debtor_zone_source,
    band, band_shown_at, fee_mode, fee_mode_reason)
  values (
    lower(trim(p_row->>'account_key')), (p_row->>'account_id')::uuid,
    p_row->>'business_name', p_row->>'business_phone', trim(p_row->>'invoice_number'),
    (p_row->>'amount_cents')::int, (p_row->>'issued_at')::date, (p_row->>'due_at')::date,
    p_row->>'job_description', p_row->>'job_address', (p_row->>'job_completed_on')::date,
    p_row->>'debtor_name', p_row->>'debtor_phone', p_row->>'debtor_state',
    p_row->>'debtor_timezone', p_row->>'debtor_zone_source',
    p_row->>'band', coalesce((p_row->>'band_shown_at')::timestamptz, now()),
    coalesce(p_row->>'fee_mode','contingency'), p_row->>'fee_mode_reason')
  returning * into v;
  return jsonb_build_object('created', true, 'invoice', to_jsonb(v));
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_release(p_secret text, p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
begin
  perform private.require(p_secret);
  update public.contacts set disposition = 'new', updated_at = now()
   where id = p_id and disposition = 'queued';
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_roll_day(p_secret text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare n int;
begin
  perform private.require(p_secret);
  update public.lines set calls_today = 0 where calls_today > 0;
  get diagnostics n = row_count;
  return n;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_set_autopilot(p_secret text, p_id uuid, p_on boolean, p_resume boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare cur public.campaigns; 
begin
  perform private.require(p_secret);
  select * into cur from public.campaigns where id = p_id;
  if not found then return jsonb_build_object('refused', 'no such campaign'); end if;

  if cur.status = 'halted' and p_on and not p_resume then
    return jsonb_build_object('refused',
      'this campaign halted itself: ' || coalesce(cur.halt_reason, 'no reason recorded') ||
      '  Read that before resuming, then resume deliberately.');
  end if;

  update public.campaigns
     set autopilot = p_on,
         status = case when p_on then 'running' else 'paused' end,
         halt_reason = case when p_on and p_resume then null else halt_reason end,
         started_at = case when p_on and started_at is null then now() else started_at end
   where id = p_id;

  return (select to_jsonb(c) from public.campaigns c where c.id = p_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_state_clearance(p_secret text, p_state text, p_reviewed boolean, p_ai boolean, p_human boolean, p_reason text, p_statute text, p_by text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_suppress(p_secret text, p_phone text, p_reason text, p_source text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
begin
  perform private.require(p_secret);
  insert into public.suppression (phone, reason, source) values (p_phone, p_reason, p_source)
  on conflict (phone) do nothing;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_tool_claim(p_secret text, p_key text, p_tool text, p_conversation text, p_call_sid text, p_args jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v public.agent_tool_calls;
begin
  perform private.require(p_secret);
  if coalesce(p_key,'') = '' then
    raise exception 'sv_tool_claim: refusing to claim an empty key';
  end if;

  insert into public.agent_tool_calls (idem_key, tool, conversation, call_sid, args)
  values (p_key, p_tool, nullif(p_conversation,''), nullif(p_call_sid,''), coalesce(p_args,'{}'::jsonb))
  on conflict (idem_key) do nothing
  returning * into v;
  if found then
    return jsonb_build_object('claimed', true, 'id', v.id, 'replay', false);
  end if;

  -- somebody holds it. A settled holder is replayed; an abandoned one is taken over.
  update public.agent_tool_calls
     set created_at = now(), args = coalesce(p_args, args), status = 'running'
   where idem_key = p_key
     and status = 'running'
     and created_at < now() - interval '90 seconds'
  returning * into v;
  if found then
    return jsonb_build_object('claimed', true, 'id', v.id, 'replay', false, 'took_over', true);
  end if;

  select * into v from public.agent_tool_calls where idem_key = p_key;
  return jsonb_build_object(
    'claimed', false, 'id', v.id, 'replay', true,
    'status', v.status, 'result', v.result,
    'held_for_seconds', round(extract(epoch from (now() - v.created_at)))
  );
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_tool_settle(p_secret text, p_key text, p_status text, p_result jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v public.agent_tool_calls;
begin
  perform private.require(p_secret);
  update public.agent_tool_calls
     set status = coalesce(nullif(p_status,''),'done'), result = p_result, settled_at = now()
   where idem_key = p_key
  returning * into v;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no claim with that key');
  end if;
  return jsonb_build_object('ok', true, 'id', v.id, 'status', v.status);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_transcript(p_secret text, p_call_sid text, p_since bigint DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v jsonb;
begin
  perform private.require(p_secret);
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb) into v
    from public.transcript_lines t
   where t.call_sid = p_call_sid and t.id > coalesce(p_since,0);
  return v;
end $function$
;

-- The ONLY projection of a Truce deal an operator console may read. It does not join sealed.limits and it must never be changed to. /truce Section 3 promises a party's limit is not merely unnamed but not derivable, and an admin surface able to print both numbers would break that promise from the inside. set_a_number is a boolean rather than a value on purpose.
CREATE OR REPLACE FUNCTION public.sv_truce_admin(p_secret text, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v jsonb;
begin
  perform private.require(p_secret);
  select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc), '[]'::jsonb) into v from (
    select d.id, d.subject, d.kind, d.status,
           d.settled_value, d.fee_cents, d.created_at, d.settled_at, d.expires_at,
           -- how far along, without any number either side sealed
           (select count(*) from public.truce_parties p where p.deal_id = d.id and p.limit_set_at is not null) as sides_ready,
           (select count(*) from public.truce_signatures g where g.deal_id = d.id) as signatures,
           (select count(*) from public.truce_messages m where m.deal_id = d.id) as messages,
           (select jsonb_agg(jsonb_build_object('side', p.side, 'role', p.role, 'name', p.display_name,
                    'joined', p.joined_at is not null, 'set_a_number', p.limit_set_at is not null,
                    'signed_at', p.signed_at) order by p.side)
              from public.truce_parties p where p.deal_id = d.id) as parties,
           -- billable only when BOTH sides signed a settled deal. "You pay only if you both sign it."
           (d.status = 'settled'
            and (select count(*) from public.truce_signatures g where g.deal_id = d.id) = 2) as billable
      from public.truce_deals d
     order by d.created_at desc
     limit least(coalesce(p_limit,100), 500)
  ) s;
  return v;
end $function$
;
comment on function public.sv_truce_admin(p_secret text, p_limit integer) is $c$The ONLY projection of a Truce deal an operator console may read. It does not join sealed.limits and it must never be changed to. /truce Section 3 promises a party's limit is not merely unnamed but not derivable, and an admin surface able to print both numbers would break that promise from the inside. set_a_number is a boolean rather than a value on purpose.$c$;

CREATE OR REPLACE FUNCTION public.sv_truce_create(p_secret text, p_subject text, p_kind text, p_a_name text, p_a_role text, p_b_name text, p_b_role text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'extensions'
AS $function$
declare d uuid; ta text; tb text; cb text;
begin
  perform private.require(p_secret);
  insert into public.truce_deals (subject, kind) values (p_subject, coalesce(p_kind,'other')) returning id into d;
  ta := encode(gen_random_bytes(24), 'hex');   -- 48 hex: a real token
  tb := encode(gen_random_bytes(24), 'hex');
  cb := encode(gen_random_bytes(12), 'hex');   -- 24 hex: an invitation code, deliberately shorter
                                               -- so a token and an invitation are never confusable
  insert into public.truce_parties (deal_id, side, role, display_name, token, joined_at)
  values (d, 'a', p_a_role, p_a_name, ta, now());
  insert into public.truce_parties (deal_id, side, role, display_name, token, claim_code)
  values (d, 'b', p_b_role, p_b_name, tb, cb);
  -- b_token is created and deliberately NOT returned.
  return jsonb_build_object('deal_id', d, 'a_token', ta, 'b_claim', cb);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_truce_purge_test(p_secret text, p_deal uuid, p_run text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare v_subject text; v_deleted int;
begin
  perform private.require(p_secret);

  if p_run is null or p_run !~ '^truce-test-[a-z0-9]+$' then
    return jsonb_build_object('deleted', false, 'refused', 'that is not a test-run tag');
  end if;

  select subject into v_subject from public.truce_deals where id = p_deal;
  if v_subject is null then
    return jsonb_build_object('deleted', false, 'refused', 'no such deal');
  end if;
  if position(p_run in v_subject) <> 1 then
    -- The deal exists but was not created by this run. Refuse loudly rather than silently.
    return jsonb_build_object('deleted', false, 'refused', 'that deal was not created by this test run');
  end if;

  delete from public.truce_deals where id = p_deal;
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('deleted', v_deleted = 1);
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_update_call(p_secret text, p_call_sid text, p_patch jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
begin
  perform private.require(p_secret);

  insert into public.calls (call_sid, direction, status, placed, to_number, from_number, queued_at)
  values (p_call_sid, coalesce(p_patch->>'direction','outbound'), p_patch->>'status', true,
          p_patch->>'to_number', p_patch->>'from_number', now())
  on conflict (call_sid) do nothing;

  update public.calls set
    status            = coalesce(p_patch->>'status', status),
    answered_by       = coalesce(p_patch->>'answered_by', answered_by),
    conference_sid    = coalesce(p_patch->>'conference_sid', conference_sid),
    conference_name   = coalesce(p_patch->>'conference_name', conference_name),
    to_number         = coalesce(to_number, p_patch->>'to_number'),
    from_number       = coalesce(from_number, p_patch->>'from_number'),
    ring_seconds      = coalesce((p_patch->>'ring_seconds')::numeric, ring_seconds),
    duration_seconds  = coalesce((p_patch->>'duration_seconds')::int, duration_seconds),
    started_at        = coalesce((p_patch->>'started_at')::timestamptz, started_at),
    answered_at       = coalesce((p_patch->>'answered_at')::timestamptz, answered_at),
    ended_at          = coalesce((p_patch->>'ended_at')::timestamptz, ended_at),
    recording_sid     = coalesce(p_patch->>'recording_sid', recording_sid),
    recording_url     = coalesce(p_patch->>'recording_url', recording_url),
    recording_seconds = coalesce((p_patch->>'recording_seconds')::int, recording_seconds),
    transcript        = coalesce(p_patch->>'transcript', transcript),
    summary           = coalesce(p_patch->>'summary', summary),
    sentiment         = coalesce(p_patch->>'sentiment', sentiment),
    ai_notes          = coalesce(p_patch->'ai_notes', ai_notes),
    disposition       = coalesce(p_patch->>'disposition', disposition),
    outcome           = coalesce(p_patch->'outcome', outcome),
    cost_usd          = coalesce((p_patch->>'cost_usd')::numeric, cost_usd),
    call_class        = coalesce(call_class, p_patch->>'call_class'),
    -- compliance evidence
    ai_speaking            = coalesce((p_patch->>'ai_speaking')::boolean, ai_speaking),
    ai_listening           = coalesce((p_patch->>'ai_listening')::boolean, ai_listening),
    disclosure_verified    = coalesce((p_patch->>'disclosure_verified')::boolean, disclosure_verified),
    disclosure_evidence    = coalesce(p_patch->'disclosure_evidence', disclosure_evidence),
    dnc_scrubbed_at_dial   = coalesce((p_patch->>'dnc_scrubbed_at_dial')::boolean, dnc_scrubbed_at_dial),
    dnc_procedures_at_dial = coalesce((p_patch->>'dnc_procedures_at_dial')::boolean, dnc_procedures_at_dial)
  where call_sid = p_call_sid;
end $function$
;

CREATE OR REPLACE FUNCTION public.sv_upsert_contacts(p_secret text, p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare n int;
begin
  perform private.require(p_secret);
  with incoming as (
    select * from jsonb_to_recordset(p_rows) as x(
      phone text, name text, trade text, state text, city text, street text, website text,
      lat numeric, lon numeric, source text, source_id text,
      line_type text, carrier text, lookup_ok boolean, lane text, lane_reasons text[]
    )
  ), ins as (
    insert into public.contacts (phone,name,trade,state,city,street,website,lat,lon,source,source_id,
                                 line_type,carrier,lookup_ok,lookup_at,lane,lane_reasons)
    select phone,name,trade,state,city,street,website,lat,lon,source,source_id,
           line_type,carrier,lookup_ok,
           case when line_type is not null then now() end,
           lane,lane_reasons
      from incoming
      where phone is not null
    on conflict (phone) do update set
      name        = coalesce(excluded.name, public.contacts.name),
      trade       = coalesce(excluded.trade, public.contacts.trade),
      state       = coalesce(excluded.state, public.contacts.state),
      city        = coalesce(excluded.city, public.contacts.city),
      street      = coalesce(excluded.street, public.contacts.street),
      website     = coalesce(excluded.website, public.contacts.website),
      lat         = coalesce(excluded.lat, public.contacts.lat),
      lon         = coalesce(excluded.lon, public.contacts.lon),
      line_type   = coalesce(excluded.line_type, public.contacts.line_type),
      carrier     = coalesce(excluded.carrier, public.contacts.carrier),
      lookup_ok   = coalesce(excluded.lookup_ok, public.contacts.lookup_ok),
      lookup_at   = coalesce(excluded.lookup_at, public.contacts.lookup_at),
      lane        = coalesce(excluded.lane, public.contacts.lane),
      lane_reasons= coalesce(excluded.lane_reasons, public.contacts.lane_reasons),
      updated_at  = now()
    returning 1
  ) select count(*) into n from ins;
  return n;
end $function$
;

CREATE OR REPLACE FUNCTION public.touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$ begin new.updated_at = now(); return new; end $function$
;

CREATE OR REPLACE FUNCTION public.tr_agent_brief(p_secret text, p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private', 'extensions'
AS $function$
declare sender public.truce_parties; rep public.truce_parties; d public.truce_deals;
begin
  perform private.require(p_secret);
  select * into sender from public.truce_parties where token = p_token;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown link'); end if;
  select * into d from public.truce_deals where id = sender.deal_id;
  -- the agent that answers represents the OTHER side: you haggle with their agent, not your own
  select * into rep from public.truce_parties where deal_id = sender.deal_id and side <> sender.side;
  return jsonb_build_object(
    'ok', true,
    'deal', jsonb_build_object('id', d.id, 'subject', d.subject, 'kind', d.kind, 'status', d.status,
              'settled_value', d.settled_value, 'expires_at', d.expires_at),
    'sender', jsonb_build_object('side', sender.side, 'name', sender.display_name, 'role', sender.role),
    'represents', jsonb_build_object('side', rep.side, 'name', rep.display_name, 'role', rep.role,
                    'limit_set', rep.limit_set_at is not null)
                  || coalesce(sealed.my_limit(rep.id), '{}'::jsonb),
    'thread', coalesce((select jsonb_agg(jsonb_build_object('seq', m.seq, 'speaker', m.speaker,
                 'body', m.body, 'amount', m.amount, 'move', m.move) order by m.seq)
               from public.truce_messages m where m.deal_id = d.id), '[]'::jsonb)
  );
end $function$
;

CREATE OR REPLACE FUNCTION public.tr_agent_say(p_secret text, p_deal uuid, p_side text, p_body text, p_amount numeric, p_move text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'extensions'
AS $function$
declare n int;
begin
  perform private.require(p_secret);
  select coalesce(max(seq),0)+1 into n from public.truce_messages where deal_id = p_deal;
  insert into public.truce_messages (deal_id, seq, speaker, body, amount, move)
  values (p_deal, n, p_side, left(btrim(coalesce(p_body,'')),1200), p_amount, coalesce(p_move,'agent'));
  return jsonb_build_object('ok', true, 'seq', n);
end $function$
;

CREATE OR REPLACE FUNCTION public.tr_agent_settle(p_secret text, p_deal uuid, p_side text, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'extensions', 'sealed'
AS $function$
declare d public.truce_deals; me public.truce_parties; lim record; other record;
        other_side text; said boolean;
begin
  perform private.require(p_secret);
  select * into d from public.truce_deals where id = p_deal;
  if d.id is null then return jsonb_build_object('ok', false, 'reason', 'unknown deal'); end if;
  if d.status = 'settled' then
    return jsonb_build_object('ok', true, 'already', true, 'settled_value', d.settled_value);
  end if;
  if d.status in ('withdrawn','no_overlap') or d.expires_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'this deal is not open');
  end if;
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'a settlement needs a positive number');
  end if;

  select * into me from public.truce_parties where deal_id = p_deal and side = p_side;
  if me.id is null then return jsonb_build_object('ok', false, 'reason', 'unknown side'); end if;
  select l.amount, l.direction into lim from sealed.limits l where l.party_id = me.id;
  if lim.amount is null then
    return jsonb_build_object('ok', false, 'reason', 'that side has no limit set, so nothing can be agreed for them');
  end if;

  -- The represented side's own number.
  if lim.direction = 'min' and p_amount < lim.amount then
    return jsonb_build_object('ok', false, 'reason', 'below the floor', 'refused', true);
  end if;
  if lim.direction = 'max' and p_amount > lim.amount then
    return jsonb_build_object('ok', false, 'reason', 'above the ceiling', 'refused', true);
  end if;

  other_side := case when p_side = 'a' then 'b' else 'a' end;

  -- The COUNTERPARTY's number, when they sealed one. @ANSWERED-RESEARCH pushed on this and was
  -- right to: talking an agent UP past the other side's ceiling is the easier and more profitable
  -- attack than talking it DOWN past its own floor, and a same-author test checks the direction its
  -- author was defending.
  select l.amount as amount, l.direction as direction into other
    from sealed.limits l join public.truce_parties p on p.id = l.party_id
   where p.deal_id = p_deal and p.side = other_side;
  if other.amount is not null then
    if other.direction = 'min' and p_amount < other.amount then
      return jsonb_build_object('ok', false, 'reason', 'below the other floor', 'refused', true);
    end if;
    if other.direction = 'max' and p_amount > other.amount then
      return jsonb_build_object('ok', false, 'reason', 'above the other ceiling', 'refused', true);
    end if;
  else
    -- ★ AND WHEN THEY SEALED NOTHING, WHICH IS THE NORMAL CONVERSATIONAL CASE: the other side is
    -- haggling in the open with no floor of their own, so there is no limit to check against and
    -- the old guard simply waved it through. That is the real hole underneath the reported one.
    -- NOBODY MAY BE BOUND TO A NUMBER THEY NEVER SAID. So the figure has to appear in something
    -- that side actually wrote. Their own offer is their consent; anything else is our agent
    -- inventing a price for a person who never named it.
    select exists (
      select 1 from public.truce_messages m
       where m.deal_id = p_deal and m.speaker = other_side
         and m.body ~ ('(^|[^0-9.])' || regexp_replace(trim_scale(p_amount)::text, '\.', '\.') || '([^0-9]|$)')
    ) into said;
    if not said then
      return jsonb_build_object('ok', false, 'refused', true,
        'reason', 'the other side never named that number, and nobody is bound to a figure they did not say');
    end if;
  end if;

  update public.truce_deals
     set status = 'settled', settled_at = now(), settled_value = p_amount,
         settlement = jsonb_build_object(
           'value', p_amount,
           'method', 'agreed in conversation, re-checked against both sealed limits and against what the other side actually said',
           'agreed_by_side', p_side, 'computed_at', now())
   where id = p_deal;
  return jsonb_build_object('ok', true, 'settled_value', p_amount);
end $function$
;

CREATE OR REPLACE FUNCTION public.tr_board(p_secret text, p_limit integer DEFAULT 60)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private', 'sealed', 'extensions'
AS $function$
declare out jsonb;
begin
  perform private.require(p_secret);
  select coalesce(jsonb_agg(row order by created_at desc), '[]'::jsonb) into out from (
    select d.created_at,
      jsonb_build_object(
        'id', d.id,
        'subject', d.subject,
        'kind', d.kind,
        'status', d.status,
        'created_at', d.created_at,
        'expires_at', d.expires_at,
        'settled_at', d.settled_at,
        'settled_value', d.settled_value,
        'method', d.settlement->>'method',
        'notified', d.notified_at is not null,
        'messages', (select count(*) from public.truce_messages m where m.deal_id = d.id),
        'human_messages', (select count(*) from public.truce_messages m where m.deal_id = d.id and m.move = 'human'),
        'parties', (select jsonb_agg(jsonb_build_object(
              'side', p.side, 'name', p.display_name, 'role', p.role,
              'joined', p.joined_at is not null,
              'invited_not_opened', p.claim_code is not null,
              'number_set', p.limit_set_at is not null,
              'opening', (select l.opening from sealed.limits l where l.party_id = p.id),
              'signed', p.signed_at is not null,
              'told_by_email', p.contact is not null,
              'payouts_ready', p.payouts_ready
            ) order by p.side) from public.truce_parties p where p.deal_id = d.id),
        'payout', (select jsonb_build_object('status', y.status, 'amount_cents', y.amount_cents,
                     'fee_cents', y.fee_cents, 'paid_at', y.paid_at)
                   from public.truce_payouts y where y.deal_id = d.id
                   order by y.created_at desc limit 1)
      ) as row
    from public.truce_deals d
    order by d.created_at desc
    limit greatest(1, least(coalesce(p_limit,60), 200))
  ) x;
  return jsonb_build_object('ok', true, 'deals', out,
    'revenue', public.tr_revenue(p_secret, 30));
end $function$
;

CREATE OR REPLACE FUNCTION public.tr_claim(p_secret text, p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'extensions'
AS $function$
declare p public.truce_parties; d public.truce_deals;
begin
  perform private.require(p_secret);
  -- The claim and the invalidation are ONE statement, so two people opening the link at the same
  -- instant cannot both win it.
  update public.truce_parties
     set claimed_at = now(), joined_at = coalesce(joined_at, now()), claim_code = null
   where claim_code = p_code and claimed_at is null
  returning * into p;

  if p.id is null then
    -- Either it never existed or it is spent. Say the same thing for both, so a scanner cannot
    -- tell a wrong code from a used one.
    return jsonb_build_object('ok', false, 'reason', 'This invitation has already been opened, or it is not valid. Ask the person who sent it for a new one.');
  end if;
  select * into d from public.truce_deals where id = p.deal_id;
  if d.expires_at < now() then return jsonb_build_object('ok', false, 'reason', 'this deal has expired'); end if;
  return jsonb_build_object('ok', true, 'token', p.token);
end $function$
;

CREATE OR REPLACE FUNCTION public.tr_leak_check(p_secret text, p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare me public.truce_parties; them public.truce_parties;
begin
  perform private.require(p_secret);
  select * into me from public.truce_parties where token = p_token;
  if not found then return jsonb_build_object('error','unknown link'); end if;
  select * into them from public.truce_parties where deal_id = me.deal_id and side <> me.side;
  return sealed.leak_counts(me.deal_id, me.id, them.id);
end $function$
;

CREATE OR REPLACE FUNCTION public.tr_payee_account(p_secret text, p_token text, p_account text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
begin
  perform private.require(p_secret);
  update public.truce_parties set stripe_account = p_account where token = p_token;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown link'); end if;
  return jsonb_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.tr_payee_ready(p_secret text, p_token text, p_ready boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
begin
  perform private.require(p_secret);
  update public.truce_parties set payouts_ready = coalesce(p_ready,false) where token = p_token;
  return jsonb_build_object('ok', found);
end $function$
;

CREATE OR REPLACE FUNCTION public.tr_payee_state(p_secret text, p_token text, p_other boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare me public.truce_parties; target public.truce_parties;
begin
  perform private.require(p_secret);
  select * into me from public.truce_parties where token = p_token;
  if me.id is null then return jsonb_build_object('ok', false, 'reason', 'unknown link'); end if;
  if p_other then
    select * into target from public.truce_parties where deal_id = me.deal_id and side <> me.side;
  else
    target := me;
  end if;
  return jsonb_build_object('ok', true, 'account', target.stripe_account, 'ready', target.payouts_ready);
end $function$
;

CREATE OR REPLACE FUNCTION public.tr_payout_intent(p_secret text, p_payout uuid, p_session text, p_intent text, p_account text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
begin
  perform private.require(p_secret);
  update public.truce_payouts
     set stripe_checkout_session = p_session,
         stripe_payment_intent = coalesce(p_intent, stripe_payment_intent),
         stripe_connected_account = p_account,
         status = 'awaiting_payment'
   where id = p_payout;
  return jsonb_build_object('ok', found);
end $function$
;

CREATE OR REPLACE FUNCTION public.tr_payout_open(p_secret text, p_deal uuid, p_payer_side text, p_fee_cents integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'extensions'
AS $function$
declare d public.truce_deals; existing public.truce_payouts; amt integer; payee text;
begin
  perform private.require(p_secret);
  select * into d from public.truce_deals where id = p_deal;
  if d.id is null then return jsonb_build_object('ok', false, 'reason', 'unknown deal'); end if;
  if d.status <> 'settled' or d.settled_value is null then
    return jsonb_build_object('ok', false, 'reason', 'nothing to pay: this deal has not settled');
  end if;
  if p_payer_side not in ('a','b') then return jsonb_build_object('ok', false, 'reason', 'payer must be a or b'); end if;

  select * into existing from public.truce_payouts where deal_id = p_deal and status <> 'cancelled' limit 1;
  if existing.id is not null then
    return jsonb_build_object('ok', true, 'already', true, 'payout_id', existing.id,
      'status', existing.status, 'amount_cents', existing.amount_cents, 'fee_cents', existing.fee_cents);
  end if;

  amt := round(d.settled_value * 100)::integer;
  payee := case when p_payer_side = 'a' then 'b' else 'a' end;
  if p_fee_cents < 0 or p_fee_cents >= amt then
    return jsonb_build_object('ok', false, 'reason', 'the fee must be smaller than the amount');
  end if;

  insert into public.truce_payouts (deal_id, payer_side, payee_side, amount_cents, fee_cents, status)
  values (p_deal, p_payer_side, payee, amt, p_fee_cents, 'created')
  returning * into existing;
  return jsonb_build_object('ok', true, 'payout_id', existing.id, 'amount_cents', amt,
    'fee_cents', p_fee_cents, 'status', 'created');
end $function$
;

CREATE OR REPLACE FUNCTION public.tr_payout_settle(p_secret text, p_intent text, p_status text, p_evidence jsonb, p_fee_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'extensions'
AS $function$
declare row public.truce_payouts;
begin
  perform private.require(p_secret);
  select * into row from public.truce_payouts where stripe_payment_intent = p_intent;
  if row.id is null then return jsonb_build_object('ok', false, 'reason', 'no payout for that intent'); end if;
  if row.status = 'succeeded' then
    return jsonb_build_object('ok', true, 'already', true, 'payout_id', row.id);
  end if;
  update public.truce_payouts
     set status = p_status,
         paid_at = case when p_status = 'succeeded' then now() else paid_at end,
         stripe_application_fee = coalesce(p_fee_id, stripe_application_fee),
         evidence = p_evidence,
         failure_reason = case when p_status = 'succeeded' then null else p_evidence->>'reason' end
   where id = row.id;
  return jsonb_build_object('ok', true, 'payout_id', row.id, 'status', p_status);
end $function$
;

CREATE OR REPLACE FUNCTION public.tr_revenue(p_secret text, p_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private', 'extensions'
AS $function$
declare out jsonb;
begin
  perform private.require(p_secret);
  select jsonb_build_object(
    'window_days', p_days,
    'deals_settled', (select count(*) from public.truce_deals where status='settled' and settled_at > now() - (p_days||' days')::interval),
    'payouts_succeeded', (select count(*) from public.truce_payouts where status='succeeded' and paid_at > now() - (p_days||' days')::interval),
    'gross_settled_cents', (select coalesce(sum(amount_cents),0) from public.truce_payouts where status='succeeded' and paid_at > now() - (p_days||' days')::interval),
    'fees_earned_cents', (select coalesce(sum(fee_cents),0) from public.truce_payouts where status='succeeded' and paid_at > now() - (p_days||' days')::interval),
    'awaiting', (select count(*) from public.truce_payouts where status in ('created','awaiting_payee','awaiting_payment')),
    'failed', (select count(*) from public.truce_payouts where status in ('failed','cancelled'))
  ) into out;
  return out;
end $function$
;

CREATE OR REPLACE FUNCTION public.tr_say(p_secret text, p_token text, p_body text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'extensions'
AS $function$
declare me public.truce_parties; d public.truce_deals; n int; b text;
begin
  perform private.require(p_secret);
  select * into me from public.truce_parties where token = p_token;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown link'); end if;
  select * into d from public.truce_deals where id = me.deal_id;
  if d.expires_at < now() then return jsonb_build_object('ok', false, 'reason', 'this link has expired'); end if;
  if d.status in ('settled','no_overlap','withdrawn') then
    return jsonb_build_object('ok', false, 'reason', 'this deal is finished');
  end if;
  b := btrim(coalesce(p_body,''));
  if b = '' then return jsonb_build_object('ok', false, 'reason', 'say something'); end if;
  b := left(b, 1200);
  select coalesce(max(seq),0)+1 into n from public.truce_messages where deal_id = d.id;
  insert into public.truce_messages (deal_id, seq, speaker, body, move)
  values (d.id, n, me.side, b, 'human');
  update public.truce_deals set status='negotiating' where id=d.id and status='open';
  return jsonb_build_object('ok', true, 'seq', n, 'side', me.side);
end $function$
;

CREATE OR REPLACE FUNCTION public.tr_set_contact(p_secret text, p_token text, p_contact text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'extensions'
AS $function$
declare pid uuid; did uuid; c text;
begin
  perform private.require(p_secret);
  select id, deal_id into pid, did from public.truce_parties where token = p_token;
  if pid is null then return jsonb_build_object('ok', false, 'reason', 'unknown token'); end if;
  c := nullif(btrim(coalesce(p_contact,'')), '');
  -- Only an email. A phone number would imply we can text, and texting is not switched on.
  if c is not null and c !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return jsonb_build_object('ok', false, 'reason', 'that does not look like an email address');
  end if;
  -- ★ A PARTY MAY ONLY EVER WRITE THEIR OWN CONTACT, because the token identifies exactly one
  -- row. There is deliberately no path anywhere that lets one side supply the other side's
  -- address: the whole invitation model is that the sender passes the link on themselves.
  update public.truce_parties set contact = c where id = pid;
  return jsonb_build_object('ok', true, 'saved', c is not null);
end $function$
;

CREATE OR REPLACE FUNCTION public.tr_set_limit(p_secret text, p_token text, p_direction text, p_amount numeric, p_must_haves text[] DEFAULT '{}'::text[], p_opening numeric DEFAULT NULL::numeric, p_target numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'sealed', 'extensions'
AS $function$
declare me public.truce_parties; d public.truce_deals; other public.truce_parties;
        o_amt numeric; o_dir text; lo numeric; hi numeric; mid numeric; val numeric; n int;
begin
  perform private.require(p_secret);
  select * into me from public.truce_parties where token = p_token;
  if me.id is null then return jsonb_build_object('error','unknown link'); end if;
  select * into d from public.truce_deals where id = me.deal_id;
  if d.status = 'settled' then return public.tr_view(p_secret, p_token); end if;

  if p_target is not null then
    if p_direction = 'min' and p_target < p_amount then
      return jsonb_build_object('error','your goal is below your floor. The goal is what you push for; the floor is where you stop.');
    end if;
    if p_direction = 'max' and p_target > p_amount then
      return jsonb_build_object('error','your goal is above your ceiling. The goal is what you push for; the ceiling is where you stop.');
    end if;
  end if;

  -- deal_id is NOT NULL here and the first draft of this function omitted it, which threw and
  -- surfaced as a generic 500 on the one path that mattered.
  insert into sealed.limits (party_id, deal_id, amount, direction, must_haves, opening, target)
  values (me.id, me.deal_id, p_amount, p_direction, coalesce(p_must_haves,'{}'), p_opening, p_target)
  on conflict (party_id) do update
    set amount = excluded.amount, direction = excluded.direction,
        must_haves = excluded.must_haves, opening = excluded.opening, target = excluded.target;
  update public.truce_parties set limit_set_at = now() where id = me.id;
  update public.truce_deals set status='negotiating' where id=d.id and status='open';

  select * into other from public.truce_parties where deal_id = d.id and side <> me.side;
  select l.amount, l.direction into o_amt, o_dir from sealed.limits l where l.party_id = other.id;
  if o_amt is not null then
    if p_direction = o_dir then
      return jsonb_build_object('error','you both picked the same direction, so there is nothing to settle');
    end if;
    lo := least(p_amount, o_amt); hi := greatest(p_amount, o_amt);
    if (p_direction='min' and p_amount > o_amt) or (p_direction='max' and p_amount < o_amt) then
      update public.truce_deals set status='no_overlap' where id=d.id;
      return public.tr_view(p_secret, p_token);
    end if;
    mid := (lo + hi) / 2.0;
    val := round(mid + ((coalesce(d.seed, 0.5) - 0.5) * (hi - lo) * 0.18));
    if val < lo then val := lo; end if;
    if val > hi then val := hi; end if;
    select coalesce(max(seq),0) into n from public.truce_messages where deal_id = d.id;
    update public.truce_deals
       set status='settled', settled_at=now(), settled_value=val,
           settlement = jsonb_build_object('value', val, 'method',
             'a point inside the overlap between two sealed limits, offset so the figure cannot be inverted to reveal either one',
             'messages', n, 'computed_at', now())
     where id = d.id;
  end if;
  return public.tr_view(p_secret, p_token);
end $function$
;

CREATE OR REPLACE FUNCTION public.tr_settlement_notice(p_secret text, p_deal uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'extensions'
AS $function$
declare d record; out jsonb;
begin
  perform private.require(p_secret);
  -- ★ CLAIM-ONCE, ATOMICALLY. Both sides can race here, and a retry must never send a second
  -- "you settled" email. The UPDATE ... where notified_at is null RETURNING is the claim: exactly
  -- one caller wins it, everyone else gets claimed:false and sends nothing.
  update public.truce_deals
     set notified_at = now()
   where id = p_deal and status = 'settled' and notified_at is null
  returning id, subject, settled_value into d;

  if d.id is null then
    return jsonb_build_object('ok', true, 'claimed', false);
  end if;

  select jsonb_build_object(
    'ok', true, 'claimed', true, 'subject', d.subject, 'settled_value', d.settled_value,
    'parties', coalesce(jsonb_agg(jsonb_build_object(
        'side', p.side, 'name', p.display_name, 'contact', p.contact, 'token', p.token
      ) order by p.side) filter (where p.contact is not null), '[]'::jsonb)
  ) into out
  from public.truce_parties p where p.deal_id = d.id;
  return out;
end $function$
;

CREATE OR REPLACE FUNCTION public.tr_sign(p_secret text, p_token text, p_name text, p_ip inet DEFAULT NULL::inet, p_ua text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare me public.truce_parties; d public.truce_deals;
begin
  perform private.require(p_secret);
  select * into me from public.truce_parties where token = p_token;
  if not found then return jsonb_build_object('error','unknown link'); end if;
  select * into d from public.truce_deals where id = me.deal_id;
  if d.status <> 'settled' then return jsonb_build_object('error','there is nothing to sign yet'); end if;
  if coalesce(trim(p_name),'') = '' then return jsonb_build_object('error','type your name to sign'); end if;
  insert into public.truce_signatures (deal_id, party_id, name_typed, ip, user_agent)
  values (d.id, me.id, trim(p_name), p_ip, p_ua)
  on conflict (deal_id, party_id) do nothing;
  update public.truce_parties set signed_at = coalesce(signed_at, now()) where id = me.id;
  return public.tr_view(p_secret, p_token);
end $function$
;

CREATE OR REPLACE FUNCTION public.tr_terms(p_secret text, p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare me public.truce_parties; d public.truce_deals;
begin
  perform private.require(p_secret);
  select * into me from public.truce_parties where token = p_token;
  if not found then return jsonb_build_object('error','unknown link'); end if;
  select * into d from public.truce_deals where id = me.deal_id;
  if d.status not in ('settled','no_overlap') then
    return jsonb_build_object('status', d.status, 'terms', '[]'::jsonb,
      'note','terms are exchanged when the negotiation finishes, not while it is running');
  end if;
  return jsonb_build_object('status', d.status, 'settled_value', d.settled_value,
                            'terms', sealed.terms_for(d.id));
end $function$
;

CREATE OR REPLACE FUNCTION public.tr_thread_admin(p_secret text, p_deal uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private', 'extensions'
AS $function$
declare out jsonb;
begin
  perform private.require(p_secret);
  select jsonb_build_object('ok', true,
    'subject', (select subject from public.truce_deals where id = p_deal),
    'thread', coalesce((select jsonb_agg(jsonb_build_object(
        'seq', m.seq, 'speaker', m.speaker, 'body', m.body, 'move', m.move,
        'amount', m.amount, 'at', m.at) order by m.seq)
      from public.truce_messages m where m.deal_id = p_deal), '[]'::jsonb))
  into out;
  return out;
end $function$
;

CREATE OR REPLACE FUNCTION public.tr_view(p_secret text, p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare me public.truce_parties; d public.truce_deals; them public.truce_parties;
begin
  perform private.require(p_secret);
  select * into me from public.truce_parties where token = p_token;
  if not found then return jsonb_build_object('error','unknown link'); end if;
  select * into d from public.truce_deals where id = me.deal_id;
  if d.expires_at < now() and d.status not in ('settled','no_overlap') then
    return jsonb_build_object('error','this link has expired', 'expired_at', d.expires_at);
  end if;
  select * into them from public.truce_parties where deal_id = me.deal_id and side <> me.side;

  return jsonb_build_object(
    'deal', jsonb_build_object('id', d.id, 'subject', d.subject, 'kind', d.kind,
              'status', d.status, 'settled_value', d.settled_value, 'settlement', d.settlement,
              'fee_cents', d.fee_cents, 'expires_at', d.expires_at),
    'me', jsonb_build_object('side', me.side, 'role', me.role, 'name', me.display_name,
            'signed_at', me.signed_at) || coalesce(sealed.my_limit(me.id), '{}'::jsonb),
    'them', jsonb_build_object('role', them.role, 'name', them.display_name,
              'joined', them.joined_at is not null, 'signed_at', them.signed_at)
            || sealed.their_public(them.id),
    'thread', coalesce((select jsonb_agg(jsonb_build_object(
                 'seq', m.seq, 'speaker', m.speaker, 'body', m.body, 'amount', m.amount,
                 'move', m.move, 'at', m.at) order by m.seq)
               from public.truce_messages m where m.deal_id = d.id), '[]'::jsonb)
  );
end $function$
;

CREATE OR REPLACE FUNCTION sealed.leak_counts(p_deal uuid, p_me uuid, p_them uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'sealed', 'public'
AS $function$
  select jsonb_build_object(
    'your_limit_appears_in_messages',
      (select count(*) from public.truce_messages m
        where m.deal_id = p_deal and m.amount = (select l.amount from sealed.limits l where l.party_id = p_me)),
    'their_limit_appears_in_messages',
      (select count(*) from public.truce_messages m
        where m.deal_id = p_deal and m.amount = (select l.amount from sealed.limits l where l.party_id = p_them)),
    'settled_on_a_limit',
      (select d.settled_value from public.truce_deals d where d.id = p_deal)
      in ((select l.amount from sealed.limits l where l.party_id = p_me),
          (select l.amount from sealed.limits l where l.party_id = p_them)));
$function$
;

CREATE OR REPLACE FUNCTION sealed.my_limit(p_party uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'sealed', 'public'
AS $function$
  select jsonb_build_object('limit', l.amount, 'amount', l.amount, 'target', l.target,
           'opening', l.opening, 'direction', l.direction, 'must_haves', l.must_haves)
    from sealed.limits l where l.party_id = p_party;
$function$
;

CREATE OR REPLACE FUNCTION sealed.negotiate(p_deal uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'sealed', 'public'
AS $function$
declare la sealed.limits; lb sealed.limits; a public.truce_parties; b public.truce_parties;
begin
  select * into a from public.truce_parties where deal_id = p_deal and side = 'a';
  select * into b from public.truce_parties where deal_id = p_deal and side = 'b';
  select * into la from sealed.limits where party_id = a.id;
  select * into lb from sealed.limits where party_id = b.id;
  if la is null or lb is null then return jsonb_build_object('status','waiting'); end if;

  if la.direction = lb.direction then
    delete from public.truce_messages where deal_id = p_deal;
    insert into public.truce_messages (deal_id, seq, speaker, body, move)
    values (p_deal, 1, 'system',
      'Both sides described the same side of the deal, so there is nothing to negotiate between. One of you is paying and one is being paid. Nobody has lost anything: pick again and it runs.',
      'stop');
    update public.truce_deals set status = 'malformed' where id = p_deal;
    return jsonb_build_object('status','malformed');
  end if;
  return sealed.negotiate_ok(p_deal);
end $function$
;

CREATE OR REPLACE FUNCTION sealed.negotiate_ok(p_deal uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'sealed', 'public'
AS $function$
declare
  a public.truce_parties; b public.truce_parties;
  la sealed.limits; lb sealed.limits;
  buyer_max numeric; seller_min numeric; buyer_open numeric; seller_open numeric;
  mid numeric; half numeric; jitter numeric; target numeric; incr numeric;
  buyer public.truce_parties; seller public.truce_parties;
  seq int := 0; i int; bid numeric; ask numeric; rounds int := 4; f numeric;
  s double precision;
begin
  select * into a from public.truce_parties where deal_id = p_deal and side = 'a';
  select * into b from public.truce_parties where deal_id = p_deal and side = 'b';
  select * into la from sealed.limits where party_id = a.id;
  select * into lb from sealed.limits where party_id = b.id;
  if la is null or lb is null then return jsonb_build_object('status','waiting'); end if;

  if la.direction = 'max' then
    buyer := a; seller := b; buyer_max := la.amount; seller_min := lb.amount;
    buyer_open := coalesce(la.opening, la.amount * 0.90); seller_open := coalesce(lb.opening, lb.amount * 1.10);
  else
    buyer := b; seller := a; buyer_max := lb.amount; seller_min := la.amount;
    buyer_open := coalesce(lb.opening, lb.amount * 0.90); seller_open := coalesce(la.opening, la.amount * 1.10);
  end if;

  delete from public.truce_messages where deal_id = p_deal;

  if buyer_max < seller_min then
    seq := seq + 1;
    insert into public.truce_messages (deal_id, seq, speaker, body, move)
    values (p_deal, seq, 'system',
      'No overlap. Truce stopped, because that is where you each told it to stop. There is nothing to sign and nothing to pay.',
      'stop');
    update public.truce_deals set status = 'no_overlap' where id = p_deal;
    return jsonb_build_object('status','no_overlap');
  end if;

  -- a stable per-deal seed, so the same deal always produces the same settlement
  select seed into s from public.truce_deals where id = p_deal;
  if s is null then s := random(); update public.truce_deals set seed = s where id = p_deal; end if;

  mid  := (seller_min + buyer_max) / 2.0;
  half := (buyer_max - seller_min) / 2.0;
  -- bounded to a third of the half-overlap: enough that 2*settled-mine is a range, never a number,
  -- and small enough that neither side can call the outcome unfair.
  jitter := (s - 0.5) * 2.0 * (half / 3.0);
  incr := greatest(1, round(greatest(buyer_max, 1) * 0.005, 0));   -- ~0.5% natural increment
  target := round((mid + jitter) / incr, 0) * incr;
  target := least(greatest(target, seller_min), buyer_max);        -- never outside either limit

  -- Openings are the PUBLIC numbers. Printing them leaks nothing, and they give the thread its
  -- movement back. Clamp only so a side never opens worse for itself than the settlement.
  seller_open := greatest(seller_open, target);
  buyer_open  := least(buyer_open,  target);

  for i in 1 .. rounds loop
    f := (rounds - i)::numeric / (rounds - 1);          -- 1.0, 0.66, 0.33, 0.0
    ask := round((target + (seller_open - target) * f) / incr, 0) * incr;
    bid := round((target - (target - buyer_open) * f) / incr, 0) * incr;

    seq := seq + 1;
    insert into public.truce_messages (deal_id, seq, speaker, body, amount, move)
    values (p_deal, seq, 'agent_' || seller.side,
      case when i = 1
        then format('This is an A I agent for %s, and this conversation is on the record. %s is asking $%s.', seller.display_name, seller.display_name, to_char(ask,'FM999,999,999'))
        when ask = target then format('%s can do $%s. That works.', seller.display_name, to_char(ask,'FM999,999,999'))
        else format('%s can come down to $%s.', seller.display_name, to_char(ask,'FM999,999,999')) end,
      ask, case when i = 1 then 'open' else 'concede' end);

    seq := seq + 1;
    insert into public.truce_messages (deal_id, seq, speaker, body, amount, move)
    values (p_deal, seq, 'agent_' || buyer.side,
      case when i = 1
        then format('This is an A I agent for %s, also on the record. %s is offering $%s.', buyer.display_name, buyer.display_name, to_char(bid,'FM999,999,999'))
        when bid = target then format('%s can go to $%s. Agreed.', buyer.display_name, to_char(bid,'FM999,999,999'))
        else format('%s can go to $%s.', buyer.display_name, to_char(bid,'FM999,999,999')) end,
      bid, case when i = 1 then 'open' else 'concede' end);
  end loop;

  seq := seq + 1;
  insert into public.truce_messages (deal_id, seq, speaker, body, amount, move)
  values (p_deal, seq, 'system',
    format('Settled at $%s in %s messages. Neither limit was shown, and neither can be worked out from this number.', to_char(target,'FM999,999,999'), seq),
    target, 'accept');

  update public.truce_deals
     set status = 'settled', settled_at = now(), settled_value = target,
         settlement = jsonb_build_object('value', target, 'messages', seq,
           'method', 'a point inside the overlap between two sealed limits, offset so the figure cannot be inverted to reveal either one',
           'increment', incr, 'computed_at', now())
   where id = p_deal;

  return jsonb_build_object('status','settled','value',target,'messages',seq);
end $function$
;

CREATE OR REPLACE FUNCTION sealed.terms_for(p_deal uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'sealed', 'public'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('side', p.side, 'name', p.display_name, 'term', t.term)
                            order by p.side), '[]'::jsonb)
    from public.truce_parties p
    join sealed.limits l on l.party_id = p.id
    cross join lateral unnest(coalesce(l.must_haves, '{}')) as t(term)
   where p.deal_id = p_deal
     and position(regexp_replace(l.amount::text, '\.0+$', '') in regexp_replace(t.term, '[^0-9]', '', 'g')) = 0;
$function$
;

CREATE OR REPLACE FUNCTION sealed.their_public(p_party uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'sealed', 'public'
AS $function$
  select jsonb_build_object(
           'has_set_limit', exists (select 1 from sealed.limits l where l.party_id = p_party),
           'opening',   (select l.opening   from sealed.limits l where l.party_id = p_party),
           'direction', (select l.direction from sealed.limits l where l.party_id = p_party));
$function$
;

-- ──────────────────────────────────────────────────────────────────────────────────────────
-- TRIGGERS
-- ──────────────────────────────────────────────────────────────────────────────────────────

CREATE TRIGGER admin_audit_no_mutate BEFORE DELETE OR UPDATE ON public.admin_audit FOR EACH ROW EXECUTE FUNCTION admin_audit_is_append_only();
CREATE TRIGGER contacts_touch BEFORE UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER crm_intake_no_mutate BEFORE DELETE OR UPDATE ON public.crm_intake_raw FOR EACH ROW EXECUTE FUNCTION crm_intake_append_only();
CREATE TRIGGER recover_invoices_touch BEFORE UPDATE ON public.recover_invoices FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER suppression_applies_to_contact AFTER INSERT ON public.suppression FOR EACH ROW EXECUTE FUNCTION apply_suppression();

-- ──────────────────────────────────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY POLICIES
-- ──────────────────────────────────────────────────────────────────────────────────────────

-- There are deliberately ZERO policies. RLS is enabled on every table and no policy
-- grants access, so anon and authenticated reach nothing. All access runs through
-- security-definer RPCs guarded by a shared secret. If a policy ever appears here,
-- somebody has opened a door and it needs explaining.

-- ──────────────────────────────────────────────────────────────────────────────────────────
-- GRANTS — part of the security model, exported rather than assumed
-- ──────────────────────────────────────────────────────────────────────────────────────────

-- public.account_config  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.account_config_versions  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.account_events  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.account_notify  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.account_numbers  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.account_tokens  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.accounts  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.admin_audit  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.admin_sessions  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.admin_users  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.agent_tool_calls  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.app_events  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.billing_accounts  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.billing_events  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.billing_invoices  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.billing_refunds  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.call_events  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.calls  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.campaigns  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.compliance_policy  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.compliance_states  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.compliance_training  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.consent  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.consent_sources  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.contacts  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.crm_activity  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.crm_identities  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.crm_intake_raw  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.crm_messages  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.crm_tasks  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.crm_templates  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.dnc_registry  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.dnc_requests  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.dnc_snapshots  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.hold_events  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.hold_sessions  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.jobs  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.lines  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.messages  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.notes  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.rate_limits  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.recap_deliveries  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.recover_calls  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.recover_invoices  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.recover_payments  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.recover_promises  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.saved_views  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.suppression  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.transcript_lines  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.truce_deals  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.truce_messages  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.truce_parties  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.truce_payouts  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.truce_signatures  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- public.v_account_balance  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- quarantine.billing_accounts_20260814  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- quarantine.billing_events_20260814  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- quarantine.billing_invoices_20260814  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- quarantine.log  service_role  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

-- Any anon or authenticated row above is a table where RLS is the ONLY control.
-- Defence in depth is a revoke; RLS alone is one layer thick.
