-- 20260814183042_admin_console_identity_and_analytics
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- /admin — the operator business console. Schema owned by @ANSWERED-INTEL, ruled 2026-08-14.
--
-- THIS MIGRATION IS PURELY ADDITIVE. It drops nothing, renames nothing, and redefines nothing
-- that the accounts, billing, call-spine or truce lanes built. Three lanes are writing this
-- database at once and the only safe change is one that cannot break a lane that is mid-flight.
--
-- IT CLOSES THE ONE STRUCTURAL DEFECT: there were two account identities with no foreign key
-- between them (public.accounts.id and public.billing_accounts.id keyed by a separate text
-- account_key), and public.calls carried no payer identity at all. So "how many calls has this
-- customer had" and "recordings tagged to users" were unanswerable by any query in either
-- direction. Both tables are empty, so there is no backfill and no risk.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ── 1. ONE ACCOUNT ID ────────────────────────────────────────────────────────────────────────
-- account_key survives untouched as the external handle the Stripe webhook already keys on.
-- account_id becomes the internal join. Nullable so nothing that exists today breaks.

alter table public.billing_accounts
  add column if not exists account_id uuid references public.accounts(id) on delete set null;

comment on column public.billing_accounts.account_id is
  'The customer this bill belongs to. Nullable only so a billing row can exist before its account does; every path that creates both must set it. account_key remains the external handle Stripe keys on.';

create unique index if not exists billing_accounts_account_id_uniq
  on public.billing_accounts (account_id) where account_id is not null;

-- A call belongs to the business that was PAID FOR, which is not the contact that was dialled.
-- contact_id is who we called. account_id is who we bill. They are never the same thing.
alter table public.calls
  add column if not exists account_id uuid references public.accounts(id) on delete set null;

comment on column public.calls.account_id is
  'The paying business this call belongs to. For inbound, resolved from account_numbers.phone = the number that was dialled. Null on research and demo calls, which belong to no customer. Never confuse with contact_id, which is the person we dialled.';

create index if not exists calls_account_id_at_idx on public.calls (account_id, created_at desc)
  where account_id is not null;
create index if not exists calls_recording_idx on public.calls (account_id, created_at desc)
  where recording_sid is not null;
create index if not exists calls_created_at_idx on public.calls (created_at desc);

-- ── 2. app_events — the queryable behavioural layer ──────────────────────────────────────────
-- /api/event writes to Netlify Blobs, which is durable object storage and cannot be grouped,
-- filtered or joined. An operator console asking "what does this customer use, and how often"
-- needs a table. Blobs stays as the raw append-only log; this is the queryable view of the same
-- stream. Nothing is migrated out of Blobs, so no history is destroyed by this existing.

create table if not exists public.app_events (
  id           bigserial primary key,
  account_id   uuid references public.accounts(id) on delete set null,
  anon_id      text,
  session_id   text,
  name         text not null,
  page         text,
  meta         jsonb not null default '{}'::jsonb,
  ua           text,
  ip_sha256    text,
  source       text not null default 'web' check (source in ('web','api','system','phone','admin')),
  at           timestamptz not null default now()
);

comment on table public.app_events is
  'Behavioural events, queryable. anon_id carries a first-party id set before signup so pre-account activity can be stitched to an account afterwards without ever storing a raw IP. ip_sha256 is a hash, never the address.';

create index if not exists app_events_account_at_idx on public.app_events (account_id, at desc);
create index if not exists app_events_name_at_idx    on public.app_events (name, at desc);
create index if not exists app_events_at_idx         on public.app_events (at desc);
create index if not exists app_events_anon_idx       on public.app_events (anon_id, at desc) where anon_id is not null;
create index if not exists app_events_meta_gin       on public.app_events using gin (meta jsonb_path_ops);

-- ── 3. THE OPERATOR'S OWN IDENTITY ───────────────────────────────────────────────────────────
-- Distinct from accounts (customers) and from the cockpit PIN (a shared secret, not a person).
-- David asked for an email and a password, so this stores a password VERIFIER, never a password.

create table if not exists public.admin_users (
  id             uuid primary key default gen_random_uuid(),
  email          text not null,
  name           text,
  password_hash  text not null,
  role           text not null default 'owner' check (role in ('owner','operator','viewer')),
  status         text not null default 'active' check (status in ('active','disabled')),
  must_change    boolean not null default false,
  last_login_at  timestamptz,
  last_login_ip  text,
  failed_count   integer not null default 0,
  locked_until   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on column public.admin_users.password_hash is
  'scrypt$N$r$p$salt_b64$hash_b64. A verifier, never a password. Nothing in this database or any log can be replayed as a credential.';
comment on column public.admin_users.locked_until is
  'Set by the login path after repeated failures. Lockout is stored here rather than in memory because a Netlify function has no memory between invocations, so an in-process rate limiter would count to one forever.';

create unique index if not exists admin_users_email_uniq on public.admin_users (lower(email));

create table if not exists public.admin_sessions (
  id           uuid primary key default gen_random_uuid(),
  admin_id     uuid not null references public.admin_users(id) on delete cascade,
  token_hash   text not null unique,
  issued_at    timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_seen_at timestamptz,
  revoked_at   timestamptz,
  ip           text,
  ua           text
);

comment on table public.admin_sessions is
  'Only the sha256 of the session token is stored, so a database read can never mint a session. The row exists so a session can be REVOKED server side; a bare signed cookie cannot be taken back before it expires.';

create index if not exists admin_sessions_admin_idx on public.admin_sessions (admin_id, issued_at desc);
create index if not exists admin_sessions_live_idx  on public.admin_sessions (expires_at) where revoked_at is null;

-- ── 4. THE AUDIT LOG ─────────────────────────────────────────────────────────────────────────
-- Append only, enforced by a trigger rather than by convention. An operator console that can
-- refund money and read a customer's recordings must be able to answer "who did that, and when",
-- and it must not be able to answer it differently later.

create table if not exists public.admin_audit (
  id          bigserial primary key,
  admin_id    uuid references public.admin_users(id) on delete set null,
  actor_email text,
  action      text not null,
  target_kind text,
  target_id   text,
  payload     jsonb not null default '{}'::jsonb,
  result      text,
  ip          text,
  ua          text,
  at          timestamptz not null default now()
);

comment on table public.admin_audit is
  'Append only. The UPDATE and DELETE trigger below is the enforcement; a policy that lives only in application code is a policy the next lane does not know about.';

create index if not exists admin_audit_at_idx     on public.admin_audit (at desc);
create index if not exists admin_audit_actor_idx  on public.admin_audit (admin_id, at desc);
create index if not exists admin_audit_target_idx on public.admin_audit (target_kind, target_id, at desc);

create or replace function public.admin_audit_is_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'admin_audit is append only: % is not permitted', tg_op;
end $$;

drop trigger if exists admin_audit_no_mutate on public.admin_audit;
create trigger admin_audit_no_mutate
  before update or delete on public.admin_audit
  for each row execute function public.admin_audit_is_append_only();

-- ── 5. REFUNDS ───────────────────────────────────────────────────────────────────────────────
-- A refund is a ROW, never an edit to what was charged. billing_events keeps its frozen rating
-- and its original amount forever; the refund sits beside it. That is the only way to answer
-- "why is this balance what it is" six months later.

create table if not exists public.billing_refunds (
  id                 uuid primary key default gen_random_uuid(),
  account_id         uuid not null references public.billing_accounts(id) on delete restrict,
  billing_event_id   uuid references public.billing_events(id) on delete set null,
  stripe_refund_id   text unique,
  stripe_invoice_id  text,
  stripe_charge_id   text,
  amount_cents       integer not null check (amount_cents > 0),
  currency           text not null default 'usd',
  reason             text,
  note               text,
  status             text not null default 'pending'
                     check (status in ('pending','succeeded','failed','canceled','recorded_offline')),
  failure_reason     text,
  idem_key           text not null unique,
  created_by         text,
  created_at         timestamptz not null default now(),
  settled_at         timestamptz
);

comment on column public.billing_refunds.idem_key is
  'The whole idempotency story. A double-clicked refund button, a retried request and a replayed webhook all collide on this unique index instead of refunding twice.';
comment on column public.billing_refunds.status is
  'recorded_offline means money moved outside Stripe and an operator recorded it. It is a distinct state on purpose: a refund we did not execute must never read as one we did.';

create index if not exists billing_refunds_account_idx on public.billing_refunds (account_id, created_at desc);
create index if not exists billing_refunds_event_idx   on public.billing_refunds (billing_event_id);

-- ── 6. DERIVED BALANCES. NEVER A MUTABLE INTEGER. ────────────────────────────────────────────
-- Credits and the amount owed are COMPUTED from the append-only rows every time they are read.
-- A stored balance is a way to silently rewrite what a customer was charged, with no answer to
-- "why is my balance this".

create or replace view public.v_account_balance as
select
  ba.id                                          as billing_account_id,
  ba.account_key,
  ba.account_id,
  ba.plan,
  ba.cap_cents,
  ba.status,
  coalesce(sum(be.cents)              filter (where be.state <> 'voided'), 0)::bigint as charged_cents,
  coalesce(sum(be.credit_created_cents) filter (where be.state <> 'voided'), 0)::bigint as credit_created_cents,
  coalesce(sum(be.credit_applied_cents) filter (where be.state <> 'voided'), 0)::bigint as credit_applied_cents,
  (coalesce(sum(be.credit_created_cents) filter (where be.state <> 'voided'), 0)
   - coalesce(sum(be.credit_applied_cents) filter (where be.state <> 'voided'), 0))::bigint as credit_balance_cents,
  coalesce(sum(be.cents) filter (where be.state = 'open'), 0)::bigint as unbilled_cents,
  coalesce(sum(be.cents) filter (where be.state = 'paid'), 0)::bigint as paid_cents,
  coalesce((select sum(r.amount_cents) from public.billing_refunds r
             where r.account_id = ba.id and r.status in ('succeeded','recorded_offline')), 0)::bigint as refunded_cents,
  count(be.id)                                   as event_count,
  max(be.occurred_at)                            as last_event_at
from public.billing_accounts ba
left join public.billing_events be on be.account_id = ba.id
group by ba.id;

comment on view public.v_account_balance is
  'Every figure here is derived from append-only rows at read time. There is deliberately no stored balance column anywhere in this database.';

-- ── 7. CLOSE THE DEFENCE-IN-DEPTH GAP ────────────────────────────────────────────────────────
-- Measured before this migration: the account_* tables had anon and authenticated revoked, while
-- billing_*, calls, contacts, campaigns, consent, lines, messages, notes, suppression,
-- transcript_lines, call_events and every truce_* table still carried the default public-schema
-- grants of SELECT, INSERT, UPDATE, DELETE and TRUNCATE for anon and authenticated.
--
-- Nothing is leaking today, because RLS is enabled everywhere and pg_policies returns zero rows,
-- so every anonymous read is denied. But that made RLS a SINGLE control: one permissive policy
-- added by a future lane to make one page work, or one DISABLE ROW LEVEL SECURITY, and the grant
-- underneath is a full table drop. sealed.limits already gets this right, holding no grant for
-- any role. This makes the rest of the database agree with it.
--
-- service_role keeps everything. The security-definer sv_* RPCs are unaffected: a definer runs as
-- its owner, not as the caller.

do $$
declare t record;
begin
  for t in
    select schemaname, tablename from pg_tables
    where schemaname = 'public'
  loop
    execute format('revoke all on public.%I from anon, authenticated', t.tablename);
  end loop;
end $$;

revoke all on public.v_account_balance from anon, authenticated;

-- New objects: RLS on, no policies, matching the house posture exactly.
alter table public.app_events       enable row level security;
alter table public.admin_users      enable row level security;
alter table public.admin_sessions   enable row level security;
alter table public.admin_audit      enable row level security;
alter table public.billing_refunds  enable row level security;

grant all on public.app_events, public.admin_users, public.admin_sessions,
             public.admin_audit, public.billing_refunds to service_role;
grant usage, select on all sequences in schema public to service_role;;
