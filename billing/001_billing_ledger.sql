-- 001_billing_ledger.sql — the meter's ledger.
--
-- THREE PROPERTIES THIS SCHEMA EXISTS TO ENFORCE, because each one is a sentence we published:
--
--   "Your bill stops at $549."          -> the cap is clamped INSIDE the transaction, under a row
--                                          lock, so two bookings arriving at the same moment cannot
--                                          both read the same headroom and both spend it.
--   "We never bill backwards."          -> the ledger is append-only. A price is frozen onto the
--                                          event at the moment it is rated and is never recomputed.
--                                          A void writes a new state, it does not delete a row.
--   "A new cap takes effect at your      -> a cap change lands in pending_cap_cents and is promoted
--    next billing cycle."                  only when a later cycle opens, never mid-cycle.
--
-- Same posture as the rest of this database: RLS on with no policies, so the publishable key opens
-- nothing, and every entry point is a security-definer function gated by private.require().
-- Customer-facing reads take a per-account STATEMENT TOKEN instead of the estate secret, exactly
-- like the truce party token, because a customer must be able to read their own bill without a
-- credential that could read anyone else's.

create table if not exists public.billing_accounts (
  id                    uuid primary key default gen_random_uuid(),
  account_key           text not null unique,
  business_name         text not null,
  email                 text not null,
  phone                 text,
  plan                  text not null default 'standard' check (plan in ('standard','subscriber')),
  cap_cents             integer not null default 54900 check (cap_cents >= 0),
  pending_cap_cents     integer check (pending_cap_cents >= 0),
  pending_cap_month     date,
  quiet_notice_at       timestamptz,
  stripe_customer_id    text unique,
  card_on_file          boolean not null default false,
  card_brand            text,
  card_last4            text,
  statement_token       text not null unique,
  status                text not null default 'active' check (status in ('active','paused','closed')),
  created_at            timestamptz not null default now()
);
comment on column public.billing_accounts.pending_cap_month is
  'The first cycle a changed cap may apply to. A cap never moves inside a cycle the customer is already standing in.';
comment on column public.billing_accounts.card_on_file is
  'Set only by the Stripe webhook after a real setup intent succeeded. Never set optimistically by the page that opened checkout.';

create table if not exists public.billing_events (
  id                      uuid primary key default gen_random_uuid(),
  account_id              uuid not null references public.billing_accounts(id),
  idem_key                text not null,
  kind                    text not null,
  product                 text,
  label                   text,
  occurred_at             timestamptz not null default now(),
  cycle_month             date not null,
  gross_cents             integer not null default 0,
  cap_applied_cents       integer not null default 0,
  credit_applied_cents    integer not null default 0,
  credit_created_cents    integer not null default 0,
  cents                   integer not null default 0,
  billable                boolean not null default false,
  rated_ok                boolean not null default true,
  counts_toward_cap       boolean not null default false,
  reason                  text not null,
  evidence                jsonb not null default '{}'::jsonb,
  rating                  jsonb not null default '{}'::jsonb,
  state                   text not null default 'open' check (state in ('open','invoiced','paid','voided')),
  voided_at               timestamptz,
  void_reason             text,
  voided_by               text,
  stripe_invoice_item_id  text,
  stripe_invoice_id       text,
  created_at              timestamptz not null default now(),
  unique (account_id, idem_key)
);
comment on column public.billing_events.idem_key is
  'The caller''s handle on this outcome, usually a call sid or a deal id. The unique index is the whole idempotency story: a retried webhook cannot bill twice.';
comment on column public.billing_events.rating is
  'The complete rating as the engine produced it, frozen. A bill is never re-derived from today''s price book.';

create index if not exists billing_events_cycle_idx on public.billing_events (account_id, cycle_month);
create index if not exists billing_events_state_idx on public.billing_events (account_id, state);

create table if not exists public.billing_invoices (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references public.billing_accounts(id),
  cycle_month         date not null,
  stripe_invoice_id   text unique,
  status              text not null default 'draft',
  total_cents         integer not null default 0,
  hosted_url          text,
  created_at          timestamptz not null default now(),
  finalized_at        timestamptz,
  paid_at             timestamptz,
  unique (account_id, cycle_month)
);

alter table public.billing_accounts enable row level security;
alter table public.billing_events   enable row level security;
alter table public.billing_invoices enable row level security;

-- ── the shared reader every surface uses ─────────────────────────────────────────────────────────
-- One statement shape, so the operator console and the customer's own page can never drift into
-- showing two different bills for the same month.
create or replace function public.bl_statement_for(p_account uuid, p_cycle date)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
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
    -- Every line, including the free ones and the refusals. A statement that hides the zeros
    -- cannot prove the zeros happened, and the zeros are the entire product claim.
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
end $$;

-- ── operator writes ──────────────────────────────────────────────────────────────────────────────
create or replace function public.sv_bill_account(p_secret text, p_row jsonb)
returns jsonb language plpgsql security definer set search_path to 'public','private' as $$
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
    -- gen_random_bytes lives in the `extensions` schema on Supabase and is invisible under
    -- this pinned search_path. gen_random_uuid() is core, CSPRNG-backed, and two of them
    -- give 64 hex characters, the same order of randomness as the truce party token.
    replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
  )
  on conflict (account_key) do update
     set business_name = coalesce(nullif(trim(excluded.business_name),''), public.billing_accounts.business_name),
         email         = coalesce(nullif(excluded.email,''), public.billing_accounts.email),
         phone         = coalesce(excluded.phone, public.billing_accounts.phone)
  returning * into a;
  return jsonb_build_object('id', a.id, 'account_key', a.account_key,
                            'statement_token', a.statement_token, 'cap_cents', a.cap_cents,
                            'plan', a.plan, 'stripe_customer_id', a.stripe_customer_id);
end $$;

-- A cap change is scheduled, never applied. The terms say so and this is where that promise lives.
create or replace function public.sv_bill_set_cap(p_secret text, p_account_key text, p_cap_cents integer)
returns jsonb language plpgsql security definer set search_path to 'public','private' as $$
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
end $$;

create or replace function public.sv_bill_quiet_notice(p_secret text, p_account_key text)
returns jsonb language plpgsql security definer set search_path to 'public','private' as $$
declare a public.billing_accounts;
begin
  perform private.require(p_secret);
  update public.billing_accounts set quiet_notice_at = coalesce(quiet_notice_at, now())
   where account_key = lower(trim(p_account_key)) returning * into a;
  if not found then raise exception 'unknown account'; end if;
  return jsonb_build_object('quiet_notice_at', a.quiet_notice_at);
end $$;

-- Everything the rating engine needs about an account, in one round trip, so a caller never rates
-- against a stale cap or a spent credit.
create or replace function public.sv_bill_context(p_secret text, p_account_key text, p_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path to 'public','private' as $$
declare a public.billing_accounts; v_cycle date; v_charged int; v_credit int; v_holds int; v_months jsonb;
begin
  perform private.require(p_secret);
  select * into a from public.billing_accounts where account_key = lower(trim(p_account_key));
  if not found then return jsonb_build_object('error','unknown account'); end if;
  v_cycle := date_trunc('month', p_at)::date;

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
       and state <> 'voided' and occurred_at >= p_at - interval '90 days'
     group by 1) s;

  return jsonb_build_object(
    'account_id', a.id, 'plan', a.plan,
    'cap_cents', case when a.pending_cap_month is not null and a.pending_cap_month <= v_cycle
                      then a.pending_cap_cents else a.cap_cents end,
    'month_charged_cents', v_charged,
    'quiet_credit_cents', greatest(0, v_credit),
    'first_hold_used', v_holds > 0,
    'quiet_notice_at', a.quiet_notice_at,
    'bookings_last_90d', coalesce(v_months, '[]'::jsonb),
    'statement_token', a.statement_token,
    'stripe_customer_id', a.stripe_customer_id,
    'card_on_file', a.card_on_file);
end $$;

-- ★ THE ONE THAT MATTERS. Idempotent, atomic, and the only place a cap is ever applied.
--
-- The caller hands in a rating from the engine. This function does NOT trust the caller's cap and
-- credit arithmetic: it locks the account row, recomputes both from the ledger as it stands right
-- now, and clamps. The caller's numbers are stored alongside as `rating` so a divergence between
-- the engine and the ledger is visible in the record rather than silently resolved.
create or replace function public.sv_bill_record(p_secret text, p_account_key text, p_row jsonb)
returns jsonb language plpgsql security definer set search_path to 'public','private' as $$
declare
  a public.billing_accounts; e public.billing_events;
  v_cycle date; v_at timestamptz; v_charged int; v_credit int; v_cap int;
  v_gross int; v_room int; v_after_cap int; v_cap_applied int; v_credit_used int; v_cents int;
  v_counts boolean; v_creates int;
begin
  perform private.require(p_secret);
  select * into a from public.billing_accounts where account_key = lower(trim(p_account_key)) for update;
  if not found then raise exception 'unknown account %', p_account_key; end if;

  v_at    := coalesce((p_row->>'occurred_at')::timestamptz, now());
  v_cycle := date_trunc('month', v_at)::date;

  -- Promote a scheduled cap the moment a new cycle actually opens, and only then.
  if a.pending_cap_month is not null and a.pending_cap_month <= v_cycle then
    update public.billing_accounts
       set cap_cents = a.pending_cap_cents, pending_cap_cents = null, pending_cap_month = null
     where id = a.id returning * into a;
  end if;
  v_cap := a.cap_cents;

  -- Idempotency first, before any arithmetic: a retry must return the ORIGINAL row untouched,
  -- with its original price, not a freshly rated one.
  select * into e from public.billing_events
   where account_id = a.id and idem_key = p_row->>'idem_key';
  if found then
    return jsonb_build_object('replay', true, 'id', e.id, 'cents', e.cents, 'state', e.state,
                              'billable', e.billable, 'reason', e.reason, 'cycle_month', e.cycle_month);
  end if;

  v_gross   := coalesce((p_row->>'gross_cents')::int, 0);
  v_counts  := coalesce((p_row->>'counts_toward_cap')::boolean, false);
  v_creates := coalesce((p_row->>'credit_created_cents')::int, 0);

  if v_counts then
    select coalesce(sum(cents),0) into v_charged from public.billing_events
     where account_id = a.id and cycle_month = v_cycle and state <> 'voided' and counts_toward_cap;
    v_room       := greatest(0, v_cap - v_charged);
    v_after_cap  := least(v_gross, v_room);
    v_cap_applied:= v_gross - v_after_cap;

    select coalesce(sum(credit_created_cents),0) - coalesce(sum(credit_applied_cents),0) into v_credit
      from public.billing_events where account_id = a.id and state <> 'voided';
    v_credit_used := least(greatest(0, v_credit), v_after_cap);
    v_cents := v_after_cap - v_credit_used;
  else
    v_cap_applied := 0; v_credit_used := 0; v_cents := v_gross;
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
end $$;

create or replace function public.sv_bill_statement(p_secret text, p_account_key text, p_cycle date default null)
returns jsonb language plpgsql security definer set search_path to 'public','private' as $$
declare a public.billing_accounts;
begin
  perform private.require(p_secret);
  select * into a from public.billing_accounts where account_key = lower(trim(p_account_key));
  if not found then return jsonb_build_object('error','unknown account'); end if;
  return public.bl_statement_for(a.id, p_cycle)
         || jsonb_build_object('account_key', a.account_key, 'statement_token', a.statement_token);
end $$;

create or replace function public.sv_bill_open_lines(p_secret text, p_account_key text, p_cycle date)
returns jsonb language plpgsql security definer set search_path to 'public','private' as $$
declare a public.billing_accounts;
begin
  perform private.require(p_secret);
  select * into a from public.billing_accounts where account_key = lower(trim(p_account_key));
  if not found then raise exception 'unknown account'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'label', label,
             'cents', cents, 'occurred_at', occurred_at, 'reason', reason) order by occurred_at)
      from public.billing_events
     where account_id = a.id and cycle_month = p_cycle and state = 'open' and cents > 0), '[]'::jsonb);
end $$;

create or replace function public.sv_bill_mark(p_secret text, p_ids uuid[], p_state text,
                                               p_invoice_id text default null)
returns integer language plpgsql security definer set search_path to 'public','private' as $$
declare n integer;
begin
  perform private.require(p_secret);
  if p_state not in ('invoiced','paid') then raise exception 'sv_bill_mark only moves an event to invoiced or paid'; end if;
  -- A voided event is never resurrected by an invoicing sweep.
  update public.billing_events
     set state = p_state, stripe_invoice_id = coalesce(p_invoice_id, stripe_invoice_id)
   where id = any(p_ids) and state <> 'voided';
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.sv_bill_stripe_customer(p_secret text, p_account_key text, p_customer text)
returns jsonb language plpgsql security definer set search_path to 'public','private' as $$
declare a public.billing_accounts;
begin
  perform private.require(p_secret);
  update public.billing_accounts set stripe_customer_id = p_customer
   where account_key = lower(trim(p_account_key)) returning * into a;
  if not found then raise exception 'unknown account'; end if;
  return jsonb_build_object('stripe_customer_id', a.stripe_customer_id);
end $$;

create or replace function public.sv_bill_card(p_secret text, p_customer text, p_brand text,
                                               p_last4 text, p_on_file boolean)
returns jsonb language plpgsql security definer set search_path to 'public','private' as $$
declare a public.billing_accounts;
begin
  perform private.require(p_secret);
  update public.billing_accounts
     set card_on_file = coalesce(p_on_file, false), card_brand = p_brand, card_last4 = p_last4
   where stripe_customer_id = p_customer returning * into a;
  if not found then return jsonb_build_object('matched', false); end if;
  return jsonb_build_object('matched', true, 'account_key', a.account_key, 'card_on_file', a.card_on_file);
end $$;

create or replace function public.sv_bill_invoice(p_secret text, p_account_key text, p_cycle date,
                                                  p_row jsonb)
returns jsonb language plpgsql security definer set search_path to 'public','private' as $$
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
end $$;

-- ── the customer's own two doors, gated by their statement token ─────────────────────────────────
create or replace function public.bl_statement(p_token text, p_cycle date default null)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare a public.billing_accounts;
begin
  select * into a from public.billing_accounts where statement_token = p_token;
  if not found then return jsonb_build_object('error','unknown link'); end if;
  return public.bl_statement_for(a.id, p_cycle);
end $$;

-- VOID. /terms: "If you think a charge is wrong, tap it or reply VOID, and it dies. The default
-- outcome is in your favor." So this refuses nothing a customer asks for on an open charge, it
-- takes no reason, and it never asks a question back.
create or replace function public.bl_void(p_token text, p_event uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
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
    -- A paid charge is a refund, which moves money and is therefore never a database-only action.
    return jsonb_build_object('ok', false, 'needs_refund', true, 'id', e.id,
                              'error', 'This one is already paid, so voiding it is a refund. We will process it and email you.');
  end if;
  update public.billing_events
     set state = 'voided', voided_at = now(), voided_by = 'customer',
         void_reason = coalesce(nullif(trim(p_reason),''), 'voided by the customer')
   where id = e.id returning * into e;
  return jsonb_build_object('ok', true, 'id', e.id, 'voided_at', e.voided_at, 'cents', 0);
end $$;

revoke all on function public.bl_statement_for(uuid, date) from public, anon, authenticated;
grant execute on function public.bl_statement(text, date) to anon, authenticated;
grant execute on function public.bl_void(text, uuid, text) to anon, authenticated;
