-- 20260814193703_recover_runtime_tables
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- ── RECOVER: the runtime behind /recover ────────────────────────────────────────────────────
-- First-party collection. Every call is placed in the CREDITOR'S OWN NAME about ONE invoice, which
-- is the whole legal footing of the product (FDCPA 1692a(6): collecting in the name of the creditor).
-- So the creditor's name, the debtor's own local time, the stop, and the amount are all COLUMNS,
-- not conventions: a rule that lives only in application code is a rule the next lane does not know.

create table if not exists public.recover_invoices (
  id                    uuid primary key default gen_random_uuid(),

  -- WHO GETS BILLED WHEN MONEY LANDS. Joins billing_accounts.account_key, which is what the meter takes.
  account_key           text not null,
  account_id            uuid references public.accounts(id),

  -- WHO THE CALL IS FOR. business_name is spoken in the first sentence of every call on this invoice.
  -- It is not decoration: saying anyone else's name is what would turn this into third-party collection.
  business_name         text not null,
  business_phone        text,

  -- THE INVOICE. One call is about one of these, and the amount is never improvised.
  invoice_number        text not null,
  amount_cents          integer not null check (amount_cents > 0),
  issued_at             date not null,
  due_at                date,
  job_description       text,
  job_address           text,
  job_completed_on      date,

  -- THE DEBTOR. debtor_state/timezone drive the calling window, because the window is a fact about
  -- where the DEBTOR is, and an area code is not that fact.
  debtor_name           text not null,
  debtor_phone          text not null,
  debtor_state          text,
  debtor_timezone       text,
  debtor_zone_source    text,

  -- THE PRICE, FIXED AND SHOWN BEFORE ANYONE DIALS. /terms promises exactly this, and meter.mjs
  -- REFUSES a fee whose band was shown after the first call, so both timestamps are stored.
  band                  text not null check (band in ('newer','most','oldest')),
  band_shown_at         timestamptz not null,
  fee_mode              text not null default 'contingency' check (fee_mode in ('contingency','flat')),
  fee_mode_reason       text,

  -- STATE
  status                text not null default 'open'
                        check (status in ('open','promised','paid','stopped','disputed','closed')),
  paid_cents            integer not null default 0 check (paid_cents >= 0),
  first_call_at         timestamptz,
  last_contact_at       timestamptz,
  last_conversation_at  timestamptz,
  next_action_at        timestamptz,
  stop_reason           text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (account_key, invoice_number)
);

create index if not exists recover_invoices_status_idx on public.recover_invoices (status, next_action_at);
create index if not exists recover_invoices_phone_idx  on public.recover_invoices (debtor_phone);
create index if not exists recover_invoices_acct_idx   on public.recover_invoices (account_key);

drop trigger if exists recover_invoices_touch on public.recover_invoices;
create trigger recover_invoices_touch before update on public.recover_invoices
  for each row execute function public.touch_updated_at();

-- Every attempt, placed or refused. A refusal is a ROW, never a silence: these rows are the evidence
-- the gate ran, and they are the first thing anybody auditing this should read.
create table if not exists public.recover_calls (
  id                  uuid primary key default gen_random_uuid(),
  invoice_id          uuid not null references public.recover_invoices(id) on delete cascade,
  call_sid            text,
  placed              boolean not null default false,
  refused_reason      text,
  gate                jsonb not null default '{}'::jsonb,
  opening_spoken      text,
  from_number         text,
  to_number           text,
  status              text,
  answered_by         text,
  duration_seconds    integer,
  disposition         text,
  identity_confirmed  boolean,
  outcome             jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  ended_at            timestamptz
);
create unique index if not exists recover_calls_sid_idx on public.recover_calls (call_sid) where call_sid is not null;
create index if not exists recover_calls_invoice_idx on public.recover_calls (invoice_id, created_at desc);

-- A promise to pay: who said it, how much, by when, and THE WORDS THEY USED. The spoken text is
-- stored because a promise summarised is a promise nobody can check.
create table if not exists public.recover_promises (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid not null references public.recover_invoices(id) on delete cascade,
  call_sid      text,
  amount_cents  integer check (amount_cents is null or amount_cents > 0),
  promised_for  date not null,
  spoken_text   text not null,
  method        text not null default 'spoken_on_call',
  kept          boolean,
  captured_at   timestamptz not null default now()
);
create index if not exists recover_promises_invoice_idx on public.recover_promises (invoice_id, captured_at desc);

-- Money that ACTUALLY LANDED. This table is the only thing that can create a Recover fee.
create table if not exists public.recover_payments (
  id                uuid primary key default gen_random_uuid(),
  invoice_id        uuid not null references public.recover_invoices(id) on delete cascade,
  amount_cents      integer not null check (amount_cents > 0),
  landed_at         timestamptz not null,
  source            text not null,
  reference         text,
  recorded_by       text,
  idem_key          text not null unique,
  fee_rated         jsonb,
  billing_event_id  uuid,
  created_at        timestamptz not null default now()
);
create index if not exists recover_payments_invoice_idx on public.recover_payments (invoice_id, landed_at desc);

-- Same posture as every other table here: RLS on with no policies, and no grant to any browser role.
-- Reaching this data is only possible through the security-definer functions below.
alter table public.recover_invoices enable row level security;
alter table public.recover_calls    enable row level security;
alter table public.recover_promises enable row level security;
alter table public.recover_payments enable row level security;

revoke all on public.recover_invoices from anon, authenticated;
revoke all on public.recover_calls    from anon, authenticated;
revoke all on public.recover_promises from anon, authenticated;
revoke all on public.recover_payments from anon, authenticated;;
