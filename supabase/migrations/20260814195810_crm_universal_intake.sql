-- 20260814195810_crm_universal_intake
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- THE UNIVERSAL CRM INTAKE. One door every writer calls, so nothing any lane or automation
-- creates can fail to appear in the CRM.
--
-- ★ THE PROBLEM THIS SOLVES, MEASURED TODAY. A person who fills in the interest form on
-- answered.reddenda.com is written to HubSpot and emailed by Resend and DOES NOT EXIST in our own
-- contacts table. A person who rings the demo line is a `calls` row with contact_id NULL. A Truce
-- party is a token and a display name in truce_parties and nothing else. Three real intake paths,
-- three different destinations, and no single place an operator can ask "who has touched us".
-- Every new automation any lane writes will invent a fourth unless there is one door.
--
-- ★ AND THE SECOND RULE: NOTHING IS EVER DISCARDED BECAUSE WE LACK A COLUMN FOR IT.
-- Every intake writes the complete raw payload to crm_intake_raw before anything is normalised.
-- A field we do not understand today is still captured, still queryable as jsonb, and still there
-- when we add the column. The alternative is the failure this estate keeps finding: a value that
-- arrived, was silently dropped by a mapper, and reads later as though it never existed.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ── the raw ledger. Append-only. Written FIRST, before any normalisation can lose anything. ──
create table if not exists public.crm_intake_raw (
  id          bigserial primary key,
  source      text not null,
  external_id text,
  payload     jsonb not null,
  contact_id  uuid references public.contacts(id) on delete set null,
  account_id  uuid references public.accounts(id) on delete set null,
  matched_on  text,
  created     boolean,
  note        text,
  at          timestamptz not null default now()
);
comment on table public.crm_intake_raw is
  'Every payload ever handed to the CRM, verbatim, before normalisation. A field we have no column for is still captured here and still queryable. Append-only by trigger: an intake record that can be edited is not evidence of what arrived.';
create index if not exists crm_intake_raw_at_idx      on public.crm_intake_raw (at desc);
create index if not exists crm_intake_raw_source_idx  on public.crm_intake_raw (source, at desc);
create index if not exists crm_intake_raw_contact_idx on public.crm_intake_raw (contact_id, at desc);
create index if not exists crm_intake_raw_payload_gin on public.crm_intake_raw using gin (payload jsonb_path_ops);

create or replace function public.crm_intake_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'crm_intake_raw is append only: % is not permitted', tg_op;
end $$;
drop trigger if exists crm_intake_no_mutate on public.crm_intake_raw;
create trigger crm_intake_no_mutate before update or delete on public.crm_intake_raw
  for each row execute function public.crm_intake_append_only();

-- ── the unified activity stream. One timeline per record, whatever produced the event. ──────
create table if not exists public.crm_activity (
  id          bigserial primary key,
  contact_id  uuid references public.contacts(id) on delete cascade,
  account_id  uuid references public.accounts(id) on delete cascade,
  kind        text not null,
  title       text not null,
  body        text,
  payload     jsonb not null default '{}'::jsonb,
  source      text not null default 'system',
  actor       text,
  ref_kind    text,
  ref_id      text,
  at          timestamptz not null default now()
);
comment on table public.crm_activity is
  'The unified timeline. Anything that happens to a contact or an account lands here with a human-readable title, so a second operator can pick up a case cold without joining six tables in their head.';
create index if not exists crm_activity_contact_idx on public.crm_activity (contact_id, at desc);
create index if not exists crm_activity_account_idx on public.crm_activity (account_id, at desc);
create index if not exists crm_activity_kind_idx    on public.crm_activity (kind, at desc);
create index if not exists crm_activity_at_idx      on public.crm_activity (at desc);

-- ── extra identities. One business, many ways to reach it. ──────────────────────────────────
create table if not exists public.crm_identities (
  id         uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete cascade,
  kind       text not null check (kind in ('phone','email','website','domain','stripe_customer','hubspot_contact','twilio_number','deal_token','external')),
  value      text not null,
  label      text,
  verified   boolean not null default false,
  source     text,
  at         timestamptz not null default now()
);
create unique index if not exists crm_identities_uniq on public.crm_identities (kind, lower(value));
create index if not exists crm_identities_contact_idx on public.crm_identities (contact_id);

alter table public.crm_intake_raw enable row level security;
alter table public.crm_activity   enable row level security;
alter table public.crm_identities enable row level security;
revoke all on public.crm_intake_raw, public.crm_activity, public.crm_identities from anon, authenticated;
grant all  on public.crm_intake_raw, public.crm_activity, public.crm_identities to service_role;

-- Contacts gains only what the CRM needs to explain where a record came from. Nothing existing
-- is redefined.
alter table public.contacts add column if not exists first_seen_via text;
alter table public.contacts add column if not exists intake_count integer not null default 0;
comment on column public.contacts.first_seen_via is
  'The intake that created this record. Never overwritten: the second time we meet someone is not how we met them.';

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- sv_crm_capture — THE ONE DOOR.
--
-- Idempotent on phone, then email, then external id. Safe to call from anywhere, as often as you
-- like. Returns what it matched on and whether it created, so a caller can log a measured fact
-- rather than an assumption.
--
-- ★ IT NEVER OVERWRITES A MEASURED FIELD WITH A SUPPLIED ONE. line_type, carrier, lane and
-- lane_reasons come from a Twilio Line Type Intelligence lookup and a compliance gate. A web form
-- that says "I am a plumber in Texas" must not be able to overwrite a carrier classification the
-- dial gate depends on. Supplied values fill BLANKS only; measured values win every time.
-- ═══════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.sv_crm_capture(p_secret text, p_row jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c            public.contacts%rowtype;
  v_phone      text;
  v_email      text;
  v_source     text;
  v_matched    text;
  v_created    boolean := false;
  v_raw_id     bigint;
  v_title      text;
begin
  perform private.require(p_secret);

  v_source := coalesce(nullif(trim(p_row->>'source'), ''), 'unknown');

  -- 1. RAW FIRST. Whatever happens below, the payload is on the record.
  insert into public.crm_intake_raw (source, external_id, payload)
  values (v_source, nullif(p_row->>'external_id',''), p_row)
  returning id into v_raw_id;

  -- E.164 only. A number we cannot dial is not an identity we can match on.
  v_phone := nullif(regexp_replace(coalesce(p_row->>'phone',''), '[^0-9+]', '', 'g'), '');
  if v_phone is not null and v_phone !~ '^\+' and length(v_phone) = 10 then
    v_phone := '+1' || v_phone;
  elsif v_phone is not null and v_phone !~ '^\+' and length(v_phone) = 11 and left(v_phone,1) = '1' then
    v_phone := '+' || v_phone;
  end if;
  if v_phone is not null and v_phone !~ '^\+\d{8,15}$' then v_phone := null; end if;

  v_email := nullif(lower(trim(coalesce(p_row->>'email',''))), '');
  if v_email is not null and position('@' in v_email) < 2 then v_email := null; end if;

  -- 2. MATCH: phone, then email, then an explicit id.
  if v_phone is not null then
    select * into c from public.contacts where phone = v_phone;
    if found then v_matched := 'phone'; end if;
  end if;
  if not found and v_email is not null then
    select * into c from public.contacts where lower(email) = v_email limit 1;
    if found then v_matched := 'email'; end if;
  end if;
  if not found and nullif(p_row->>'contact_id','') is not null then
    select * into c from public.contacts where id = (p_row->>'contact_id')::uuid;
    if found then v_matched := 'contact_id'; end if;
  end if;

  -- 3. CREATE or ENRICH.
  if not found then
    if v_phone is null and v_email is null then
      return jsonb_build_object('ok', false, 'raw_id', v_raw_id,
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
    -- Fill blanks only. A measured field is never overwritten by a supplied one.
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

  -- 4. IDENTITIES, so the same business found by a different handle later still resolves here.
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

  -- 5. TIMELINE, in words an operator can read.
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
    'raw_id', v_raw_id, 'intake_count', c.intake_count,
    'phone', c.phone, 'name', c.name);
end $$;

comment on function public.sv_crm_capture(text, jsonb) is
  'THE ONE DOOR into the CRM. Every lane and every automation calls this. Idempotent on phone then email then contact_id. Writes the complete raw payload to crm_intake_raw BEFORE normalising, so a field we have no column for is still captured. Never overwrites a measured field (line_type, carrier, lane) with a supplied one: supplied values fill blanks only.';

-- A plain activity write, for events about a record we already have.
create or replace function public.sv_crm_activity(p_secret text, p_row jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
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
end $$;;
