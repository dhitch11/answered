-- 20260814180704_truce_negotiation_engine
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- TRUCE / PARLEY — the text-negotiation product's engine.
--
-- @ANSWERED-BUILD owns the page and the copy. This is the runtime behind it.
--
-- THE ONE PROPERTY THE WHOLE PRODUCT RESTS ON: a party's limit is never visible to the other
-- party. Not in a message, not in the summary, not on the signed page, not in any API response,
-- not even when the deal settles exactly at it. The marketing page promises this in words; here
-- it is enforced in the data model and in the read functions, because a privacy promise that
-- lives only in the UI is the same class of thing as a PIN curtain drawn in CSS.
--
-- The limits live in a schema nothing can select from. Every read is a purpose-built function
-- that takes the caller's own party token and can only ever return that party's own number.

create schema if not exists sealed;
revoke all on schema sealed from public, anon, authenticated;

-- ── DEALS ────────────────────────────────────────────────────────────────────────────────────
create table public.truce_deals (
  id            uuid primary key default gen_random_uuid(),
  subject       text not null,                       -- "Lease renewal at 114 Bell"
  kind          text not null default 'other'
                check (kind in ('rent','deposit','freelance','marketplace','vehicle','real_estate','invoice','other')),
  currency      text not null default 'USD',
  status        text not null default 'open'
                check (status in ('open','negotiating','settled','no_overlap','withdrawn','expired')),
  settled_at    timestamptz,
  settled_value numeric,
  -- the audit trail of how the number was reached, printable, with no limit in it
  settlement    jsonb,
  fee_cents     int not null default 2900,           -- $29 once, split. Charged only on signature.
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '30 days'
);

-- ── PARTIES ──────────────────────────────────────────────────────────────────────────────────
-- The other side has no account, no app, no password. They hold a token in a link and that is it.
create table public.truce_parties (
  id           uuid primary key default gen_random_uuid(),
  deal_id      uuid not null references public.truce_deals(id) on delete cascade,
  side         text not null check (side in ('a','b')),
  role         text not null,                        -- 'tenant' / 'owner' / 'buyer' / 'seller'
  display_name text not null,
  token        text not null unique,                 -- the link secret. Long, random, single party.
  contact      text,                                 -- phone or email, for the settled page only
  joined_at    timestamptz,
  limit_set_at timestamptz,
  signed_at    timestamptz,
  unique (deal_id, side)
);
create index truce_parties_deal on public.truce_parties (deal_id);

-- ── THE SEALED NUMBERS ───────────────────────────────────────────────────────────────────────
-- Deliberately in `sealed`, not `public`. Nothing outside a security-definer function can read it,
-- and no function returns another party's row. Ever.
create table sealed.limits (
  party_id   uuid primary key references public.truce_parties(id) on delete cascade,
  deal_id    uuid not null references public.truce_deals(id) on delete cascade,
  direction  text not null check (direction in ('max','min')),  -- max = will not pay more, min = will not take less
  amount     numeric not null check (amount >= 0),
  must_haves text[] default '{}',
  set_at     timestamptz not null default now()
);

-- ── THE THREAD ───────────────────────────────────────────────────────────────────────────────
create table public.truce_messages (
  id         bigserial primary key,
  deal_id    uuid not null references public.truce_deals(id) on delete cascade,
  seq        int not null,
  speaker    text not null,                          -- 'agent_a' | 'agent_b' | 'system'
  body       text not null,
  amount     numeric,                                -- the figure THIS message put on the table
  move       text,                                   -- 'open' | 'concede' | 'hold' | 'accept' | 'stop'
  at         timestamptz not null default now(),
  unique (deal_id, seq)
);
create index truce_messages_deal on public.truce_messages (deal_id, seq);

-- ── SIGNATURES ───────────────────────────────────────────────────────────────────────────────
create table public.truce_signatures (
  id        uuid primary key default gen_random_uuid(),
  deal_id   uuid not null references public.truce_deals(id) on delete cascade,
  party_id  uuid not null references public.truce_parties(id) on delete cascade,
  name_typed text not null,
  ip        inet,
  user_agent text,
  at        timestamptz not null default now(),
  unique (deal_id, party_id)
);

alter table public.truce_deals      enable row level security;
alter table public.truce_parties    enable row level security;
alter table public.truce_messages   enable row level security;
alter table public.truce_signatures enable row level security;
alter table sealed.limits           enable row level security;

-- ── THE ENGINE ───────────────────────────────────────────────────────────────────────────────
-- Deterministic. Every figure printed in the thread is a figure this function computed; nothing
-- is a hardcoded script. The language layer may reword a message, but it may never choose a number.
--
-- Concession walk: each side opens at its own limit, then moves toward the midpoint of the overlap
-- in shrinking steps. Settlement is the midpoint, rounded to the currency's natural increment.
create or replace function sealed.negotiate(p_deal uuid)
returns jsonb language plpgsql security definer set search_path = sealed, public as $$
declare
  a public.truce_parties; b public.truce_parties;
  la sealed.limits; lb sealed.limits;
  buyer_max numeric; seller_min numeric;
  overlap_lo numeric; overlap_hi numeric; target numeric;
  buyer public.truce_parties; seller public.truce_parties;
  steps numeric[] := array[1.0, 0.55, 0.28, 0.0];   -- fraction of the gap still held at each move
  seq int := 0; i int; bid numeric; ask numeric;
  msgs jsonb := '[]'::jsonb;
begin
  select * into a from public.truce_parties where deal_id = p_deal and side = 'a';
  select * into b from public.truce_parties where deal_id = p_deal and side = 'b';
  select * into la from sealed.limits where party_id = a.id;
  select * into lb from sealed.limits where party_id = b.id;
  if la is null or lb is null then return jsonb_build_object('status','waiting'); end if;

  if la.direction = 'max' then buyer := a; seller := b; buyer_max := la.amount; seller_min := lb.amount;
  else buyer := b; seller := a; buyer_max := lb.amount; seller_min := la.amount; end if;

  delete from public.truce_messages where deal_id = p_deal;

  -- No overlap is a real, honest outcome. It is not a failure and it is not billable.
  if buyer_max < seller_min then
    seq := seq + 1;
    insert into public.truce_messages (deal_id, seq, speaker, body, move)
    values (p_deal, seq, 'system',
      'No overlap. Truce stopped, because that is where you each told it to stop. There is nothing to sign and nothing to pay.',
      'stop');
    update public.truce_deals set status = 'no_overlap' where id = p_deal;
    return jsonb_build_object('status','no_overlap');
  end if;

  overlap_lo := seller_min; overlap_hi := buyer_max;
  target := round((overlap_lo + overlap_hi) / 2.0, 0);

  for i in 1 .. array_length(steps,1) loop
    -- seller walks down from its ask toward the target; buyer walks up from its bid toward it
    ask := round(target + (overlap_hi - target) * steps[i], 0);
    bid := round(target - (target - overlap_lo) * steps[i], 0);

    seq := seq + 1;
    insert into public.truce_messages (deal_id, seq, speaker, body, amount, move)
    values (p_deal, seq, 'agent_' || seller.side,
      case when i = 1
        then format('This is an A I agent for %s, and this conversation is on the record. %s is at $%s.', seller.display_name, seller.display_name, to_char(ask,'FM999,999,999'))
        else format('%s can do $%s.', seller.display_name, to_char(ask,'FM999,999,999')) end,
      ask, case when i = 1 then 'open' else 'concede' end);

    seq := seq + 1;
    insert into public.truce_messages (deal_id, seq, speaker, body, amount, move)
    values (p_deal, seq, 'agent_' || buyer.side,
      case when i = 1
        then format('This is an A I agent for %s, also on the record. %s is at $%s.', buyer.display_name, buyer.display_name, to_char(bid,'FM999,999,999'))
        else format('%s can go to $%s.', buyer.display_name, to_char(bid,'FM999,999,999')) end,
      bid, case when i = 1 then 'open' else 'concede' end);

    exit when ask <= bid;
  end loop;

  seq := seq + 1;
  insert into public.truce_messages (deal_id, seq, speaker, body, amount, move)
  values (p_deal, seq, 'system',
    format('Settled at $%s. Neither number was ever shown to the other side.', to_char(target,'FM999,999,999')),
    target, 'accept');

  update public.truce_deals
     set status = 'settled', settled_at = now(), settled_value = target,
         settlement = jsonb_build_object(
           'value', target, 'messages', seq,
           'method', 'midpoint of the overlap between the two sealed limits',
           -- deliberately NOT the limits themselves. This object is printed on the signed page.
           'computed_at', now())
   where id = p_deal;

  return jsonb_build_object('status','settled','value',target,'messages',seq);
end $$;

-- ── THE ONLY DOORS ───────────────────────────────────────────────────────────────────────────
-- Every read takes the caller's OWN party token. There is no shape of call that returns the other
-- side's number, because no function ever selects a limit row it was not given the token for.

create or replace function public.tr_view(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public, sealed, private as $$
declare me public.truce_parties; d public.truce_deals; them public.truce_parties; mine sealed.limits;
begin
  select * into me from public.truce_parties where token = p_token;
  if not found then return jsonb_build_object('error','unknown link'); end if;
  select * into d from public.truce_deals where id = me.deal_id;
  select * into them from public.truce_parties where deal_id = me.deal_id and side <> me.side;
  select * into mine from sealed.limits where party_id = me.id;

  return jsonb_build_object(
    'deal', jsonb_build_object('id', d.id, 'subject', d.subject, 'kind', d.kind,
              'status', d.status, 'settled_value', d.settled_value, 'settlement', d.settlement,
              'fee_cents', d.fee_cents, 'expires_at', d.expires_at),
    'me', jsonb_build_object('side', me.side, 'role', me.role, 'name', me.display_name,
            'limit', mine.amount, 'direction', mine.direction, 'must_haves', mine.must_haves,
            'signed_at', me.signed_at),
    -- what we say about the other party: that they exist, that they have set a number, and
    -- nothing else. Never the number, not even after settlement.
    'them', jsonb_build_object('role', them.role, 'name', them.display_name,
              'has_set_limit', exists (select 1 from sealed.limits where party_id = them.id),
              'joined', them.joined_at is not null, 'signed_at', them.signed_at),
    'thread', coalesce((select jsonb_agg(jsonb_build_object(
                 'seq', m.seq, 'speaker', m.speaker, 'body', m.body, 'amount', m.amount,
                 'move', m.move, 'at', m.at) order by m.seq)
               from public.truce_messages m where m.deal_id = d.id), '[]'::jsonb)
  );
end $$;

create or replace function public.tr_set_limit(p_token text, p_direction text, p_amount numeric, p_must_haves text[] default '{}')
returns jsonb language plpgsql security definer set search_path = public, sealed as $$
declare me public.truce_parties;
begin
  select * into me from public.truce_parties where token = p_token;
  if not found then return jsonb_build_object('error','unknown link'); end if;
  if p_direction not in ('max','min') then return jsonb_build_object('error','direction must be max or min'); end if;
  if p_amount is null or p_amount < 0 then return jsonb_build_object('error','a limit needs a number'); end if;

  insert into sealed.limits (party_id, deal_id, direction, amount, must_haves)
  values (me.id, me.deal_id, p_direction, p_amount, coalesce(p_must_haves,'{}'))
  on conflict (party_id) do update set direction = excluded.direction, amount = excluded.amount,
                                       must_haves = excluded.must_haves, set_at = now();

  update public.truce_parties set limit_set_at = now(), joined_at = coalesce(joined_at, now()) where id = me.id;
  update public.truce_deals set status = 'negotiating' where id = me.deal_id and status = 'open';

  -- Run only when BOTH sides are in. One side's number alone reveals nothing and does nothing.
  if (select count(*) from sealed.limits where deal_id = me.deal_id) = 2 then
    perform sealed.negotiate(me.deal_id);
  end if;
  return public.tr_view(p_token);
end $$;

create or replace function public.tr_sign(p_token text, p_name text, p_ip inet default null, p_ua text default null)
returns jsonb language plpgsql security definer set search_path = public, sealed as $$
declare me public.truce_parties; d public.truce_deals;
begin
  select * into me from public.truce_parties where token = p_token;
  if not found then return jsonb_build_object('error','unknown link'); end if;
  select * into d from public.truce_deals where id = me.deal_id;
  if d.status <> 'settled' then return jsonb_build_object('error','there is nothing to sign yet'); end if;
  if coalesce(trim(p_name),'') = '' then return jsonb_build_object('error','type your name to sign'); end if;

  insert into public.truce_signatures (deal_id, party_id, name_typed, ip, user_agent)
  values (d.id, me.id, trim(p_name), p_ip, p_ua)
  on conflict (deal_id, party_id) do nothing;
  update public.truce_parties set signed_at = coalesce(signed_at, now()) where id = me.id;
  return public.tr_view(p_token);
end $$;

-- Creation is an operator/owner action and keeps the estate's shared-secret posture.
create or replace function public.sv_truce_create(
  p_secret text, p_subject text, p_kind text,
  p_a_name text, p_a_role text, p_b_name text, p_b_role text)
returns jsonb language plpgsql security definer set search_path = public, private, extensions as $$
declare d uuid; ta text; tb text;
begin
  perform private.require(p_secret);
  insert into public.truce_deals (subject, kind) values (p_subject, coalesce(p_kind,'other')) returning id into d;
  ta := encode(gen_random_bytes(24), 'hex');
  tb := encode(gen_random_bytes(24), 'hex');
  insert into public.truce_parties (deal_id, side, role, display_name, token, joined_at)
  values (d, 'a', p_a_role, p_a_name, ta, now());
  insert into public.truce_parties (deal_id, side, role, display_name, token, tb_placeholder_fix)
  select d, 'b', p_b_role, p_b_name, tb, null where false;
  insert into public.truce_parties (deal_id, side, role, display_name, token)
  values (d, 'b', p_b_role, p_b_name, tb);
  return jsonb_build_object('deal_id', d, 'a_token', ta, 'b_token', tb);
end $$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (p.proname like 'sv\_%' or p.proname like 'tr\_%')
  loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('grant execute on function %s to anon, authenticated', f.sig);
  end loop;
end $$;

revoke all on function sealed.negotiate(uuid) from public, anon, authenticated;;
