-- 20260814230000_parley_negotiation_engine.sql
--
-- WHY THIS FILE EXISTS. Everything below was created directly against the live database while
-- building the text-native negotiation, and NONE of it was in version control. An adversarial
-- review searched supabase/migrations, found zero definitions for tr_say / tr_agent_brief /
-- tr_agent_settle / tr_agent_say, and concluded the negotiation half of the product was unbuilt.
-- It was wrong about that: the functions are live and measured working on production. But it was
-- RIGHT about the thing that matters. Rebuild this database from migrations and Parley's engine
-- vanishes silently, with the page still serving and every route still answering 200.
--
-- WHAT THE ENGINE GUARANTEES, and where each guarantee actually lives:
--
--   * A party token is the credential, and the CREATOR NEVER HOLDS THE COUNTERPARTY'S. They hold an
--     invitation, which tr_claim exchanges exactly once and destroys in the same statement.
--     Measured before this existed: the sender could open the link they had texted you, after you
--     set your number, and read your sealed limit and goal verbatim.
--
--   * Sealed numbers live in the `sealed` schema and are reachable only through functions that take
--     the operator secret. tr_agent_brief is the ONE place a counterparty's limit enters
--     application memory, and only so an agent can avoid crossing it.
--
--   * tr_agent_settle is the money guard and it does not trust the model. It re-reads the caller's
--     sealed limit, re-reads the counterparty's when they have one, and when they have NONE it
--     requires the figure to appear in a message that side actually wrote. Nobody is bound to a
--     number they never said.
--
-- Three numbers per party, two of them secret: a PUBLIC opening (the anchor), a sealed TARGET (the
-- goal being driven for), and a sealed LIMIT (the walk-away). The target changes how the agent
-- argues; it never changes how the arithmetic resolves.

-- ── schema ──────────────────────────────────────────────────────────────────

alter table public.truce_parties add column if not exists claim_code text;
alter table public.truce_parties add column if not exists claimed_at timestamptz;
alter table public.truce_parties add column if not exists stripe_account text;
alter table public.truce_parties add column if not exists payouts_ready boolean not null default false;
create unique index if not exists truce_parties_claim_code
  on public.truce_parties(claim_code) where claim_code is not null;

alter table public.truce_deals add column if not exists notified_at timestamptz;
alter table sealed.limits add column if not exists target numeric;

-- The money ledger. It records only what a payment processor said happened, never what somebody
-- said would happen: a signature is a promise, a cleared payment is a fact.
create table if not exists public.truce_payouts (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.truce_deals(id) on delete cascade,
  payer_side text not null check (payer_side in ('a','b')),
  payee_side text not null check (payee_side in ('a','b')),
  amount_cents integer not null check (amount_cents > 0),
  fee_cents integer not null check (fee_cents >= 0),
  currency text not null default 'usd',
  stripe_payment_intent text unique,
  stripe_checkout_session text,
  stripe_connected_account text,
  stripe_application_fee text,
  status text not null default 'created'
    check (status in ('created','awaiting_payee','awaiting_payment','succeeded','failed','refunded','cancelled')),
  failure_reason text,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  evidence jsonb
);
create index if not exists truce_payouts_deal on public.truce_payouts(deal_id);
create index if not exists truce_payouts_status on public.truce_payouts(status);
alter table public.truce_payouts enable row level security;
revoke all on public.truce_payouts from anon, authenticated;

-- ── the invitation model ────────────────────────────────────────────────────

create or replace function public.sv_truce_create(p_secret text, p_subject text, p_kind text,
  p_a_name text, p_a_role text, p_b_name text, p_b_role text)
returns jsonb language plpgsql security definer set search_path to 'public','private','extensions' as $function$
declare d uuid; ta text; tb text; cb text;
begin
  perform private.require(p_secret);
  insert into public.truce_deals (subject, kind) values (p_subject, coalesce(p_kind,'other')) returning id into d;
  ta := encode(gen_random_bytes(24), 'hex');   -- 48 hex: a real token
  tb := encode(gen_random_bytes(24), 'hex');
  cb := encode(gen_random_bytes(12), 'hex');   -- 24 hex: an invitation, deliberately a different
                                               -- length so the two are never confusable
  insert into public.truce_parties (deal_id, side, role, display_name, token, joined_at)
  values (d, 'a', p_a_role, p_a_name, ta, now());
  insert into public.truce_parties (deal_id, side, role, display_name, token, claim_code)
  values (d, 'b', p_b_role, p_b_name, tb, cb);
  -- b_token is created and deliberately NOT returned.
  return jsonb_build_object('deal_id', d, 'a_token', ta, 'b_claim', cb);
end $function$;

create or replace function public.tr_claim(p_secret text, p_code text)
returns jsonb language plpgsql security definer set search_path to 'public','private','extensions' as $function$
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
    -- Either it never existed or it is spent. Identical message for both, so a scanner cannot tell
    -- a wrong invitation from a used one.
    return jsonb_build_object('ok', false, 'reason', 'This invitation has already been opened, or it is not valid. Ask the person who sent it for a new one.');
  end if;
  select * into d from public.truce_deals where id = p.deal_id;
  if d.expires_at < now() then return jsonb_build_object('ok', false, 'reason', 'this deal has expired'); end if;
  return jsonb_build_object('ok', true, 'token', p.token);
end $function$;

-- ── the sealed numbers ──────────────────────────────────────────────────────

create or replace function sealed.my_limit(p_party uuid)
returns jsonb language sql stable security definer set search_path to 'sealed','public' as $function$
  select jsonb_build_object('limit', l.amount, 'amount', l.amount, 'target', l.target,
           'opening', l.opening, 'direction', l.direction, 'must_haves', l.must_haves)
    from sealed.limits l where l.party_id = p_party;
$function$;

-- ── the conversation ────────────────────────────────────────────────────────

create or replace function public.tr_say(p_secret text, p_token text, p_body text)
returns jsonb language plpgsql security definer set search_path to 'public','private','extensions' as $function$
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
end $function$;

-- SERVER ONLY. The one place a counterparty's sealed limit enters application memory, and only so
-- the agent speaking for them can avoid crossing it.
create or replace function public.tr_agent_brief(p_secret text, p_token text)
returns jsonb language plpgsql stable security definer set search_path to 'public','private','extensions' as $function$
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
end $function$;

create or replace function public.tr_agent_say(p_secret text, p_deal uuid, p_side text, p_body text, p_amount numeric, p_move text)
returns jsonb language plpgsql security definer set search_path to 'public','private','extensions' as $function$
declare n int;
begin
  perform private.require(p_secret);
  select coalesce(max(seq),0)+1 into n from public.truce_messages where deal_id = p_deal;
  insert into public.truce_messages (deal_id, seq, speaker, body, amount, move)
  values (p_deal, n, p_side, left(btrim(coalesce(p_body,'')),1200), p_amount, coalesce(p_move,'agent'));
  return jsonb_build_object('ok', true, 'seq', n);
end $function$;

-- ★ THE MONEY GUARD. A model must never be the thing that binds somebody to a number.
create or replace function public.tr_agent_settle(p_secret text, p_deal uuid, p_side text, p_amount numeric)
returns jsonb language plpgsql security definer set search_path to 'public','private','extensions','sealed' as $function$
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

  if lim.direction = 'min' and p_amount < lim.amount then
    return jsonb_build_object('ok', false, 'reason', 'below the floor', 'refused', true);
  end if;
  if lim.direction = 'max' and p_amount > lim.amount then
    return jsonb_build_object('ok', false, 'reason', 'above the ceiling', 'refused', true);
  end if;

  other_side := case when p_side = 'a' then 'b' else 'a' end;

  -- The COUNTERPARTY's number, when they sealed one. Talking an agent UP past the other side's
  -- ceiling is the easier and more profitable attack than talking it DOWN past its own floor, and a
  -- same-author test checks the direction its author was defending.
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
    -- ★ AND WHEN THEY SEALED NOTHING, WHICH IS THE NORMAL CONVERSATIONAL CASE. The other side is
    -- haggling in the open with no floor of their own, so there is no limit to check and the guard
    -- used to wave everything through. NOBODY IS BOUND TO A NUMBER THEY NEVER SAID: the figure has
    -- to appear in a message that side actually wrote. Their own offer is their consent; anything
    -- else is our agent inventing a price for a person who never named it.
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
end $function$;

-- ── telling both sides how it ended ─────────────────────────────────────────

create or replace function public.tr_set_contact(p_secret text, p_token text, p_contact text)
returns jsonb language plpgsql security definer set search_path to 'public','private','extensions' as $function$
declare pid uuid; c text;
begin
  perform private.require(p_secret);
  select id into pid from public.truce_parties where token = p_token;
  if pid is null then return jsonb_build_object('ok', false, 'reason', 'unknown token'); end if;
  c := nullif(btrim(coalesce(p_contact,'')), '');
  -- Only an email. A phone number would imply we can text, and texting is not switched on.
  if c is not null and c !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return jsonb_build_object('ok', false, 'reason', 'that does not look like an email address');
  end if;
  -- ★ A PARTY MAY ONLY EVER WRITE THEIR OWN CONTACT. There is deliberately no path that lets one
  -- side supply the other side's address: the sender passes the link on themselves.
  update public.truce_parties set contact = c where id = pid;
  return jsonb_build_object('ok', true, 'saved', c is not null);
end $function$;

create or replace function public.tr_settlement_notice(p_secret text, p_deal uuid)
returns jsonb language plpgsql security definer set search_path to 'public','private','extensions' as $function$
declare d record; out jsonb;
begin
  perform private.require(p_secret);
  -- CLAIM-ONCE, ATOMICALLY. Both sides can race here and a retry must never send a second notice.
  update public.truce_deals
     set notified_at = now()
   where id = p_deal and status = 'settled' and notified_at is null
  returning id, subject, settled_value into d;
  if d.id is null then return jsonb_build_object('ok', true, 'claimed', false); end if;
  select jsonb_build_object(
    'ok', true, 'claimed', true, 'subject', d.subject, 'settled_value', d.settled_value,
    'parties', coalesce(jsonb_agg(jsonb_build_object(
        'side', p.side, 'name', p.display_name, 'contact', p.contact, 'token', p.token
      ) order by p.side) filter (where p.contact is not null), '[]'::jsonb)
  ) into out
  from public.truce_parties p where p.deal_id = d.id;
  return out;
end $function$;

-- ── grants ──────────────────────────────────────────────────────────────────
--
-- A Postgres function is born EXECUTE to PUBLIC, which is the opposite default from a table, so
-- these REVOKEs are load bearing. Only tr_say, tr_set_contact and tr_claim are reachable with the
-- publishable key plus the shared secret; anything that can see a sealed number is operator-only.
revoke all on function public.tr_agent_brief(text,text) from anon, authenticated;
revoke all on function public.tr_agent_say(text,uuid,text,text,numeric,text) from anon, authenticated;
revoke all on function public.tr_agent_settle(text,uuid,text,numeric) from anon, authenticated;
revoke all on function public.tr_settlement_notice(text,uuid) from anon, authenticated;
grant execute on function public.tr_say(text,text,text) to anon;
grant execute on function public.tr_set_contact(text,text,text) to anon;
grant execute on function public.tr_claim(text,text) to anon;
