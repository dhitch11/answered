-- 20260814193650_truce_expiry_terms_and_a_real_rate_limit
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- @LANE-PARLEY found four defects in this engine by reading pg_get_functiondef and curling prod.
-- All four are mine. Three are fixed here; the fourth (the /truce/* route) is theirs and correct.

-- ── 1. THE EXPIRY WAS DECORATIVE ────────────────────────────────────────────────────────────
-- expires_at defaulted to 30 days while the page publishes "seven days", and NO function read the
-- column at all, so a party token worked forever. A published promise that nothing enforces is the
-- same class of thing as a PIN curtain in CSS: it reads as a control and is not one.
alter table public.truce_deals alter column expires_at set default (now() + interval '7 days');

create or replace function public.tr_view(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public, sealed as $$
declare me public.truce_parties; d public.truce_deals; them public.truce_parties;
        mine sealed.limits; theirs sealed.limits;
begin
  select * into me from public.truce_parties where token = p_token;
  if not found then return jsonb_build_object('error','unknown link'); end if;
  select * into d from public.truce_deals where id = me.deal_id;
  if d.expires_at < now() and d.status not in ('settled','no_overlap') then
    return jsonb_build_object('error','this link has expired', 'expired_at', d.expires_at);
  end if;
  select * into them from public.truce_parties where deal_id = me.deal_id and side <> me.side;
  select * into mine from sealed.limits where party_id = me.id;
  select * into theirs from sealed.limits where party_id = them.id;

  return jsonb_build_object(
    'deal', jsonb_build_object('id', d.id, 'subject', d.subject, 'kind', d.kind,
              'status', d.status, 'settled_value', d.settled_value, 'settlement', d.settlement,
              'fee_cents', d.fee_cents, 'expires_at', d.expires_at),
    'me', jsonb_build_object('side', me.side, 'role', me.role, 'name', me.display_name,
            'limit', mine.amount, 'opening', mine.opening, 'direction', mine.direction,
            'must_haves', mine.must_haves, 'signed_at', me.signed_at),
    'them', jsonb_build_object('role', them.role, 'name', them.display_name,
              'has_set_limit', theirs.party_id is not null,
              'opening', theirs.opening,
              'joined', them.joined_at is not null, 'signed_at', them.signed_at),
    'thread', coalesce((select jsonb_agg(jsonb_build_object(
                 'seq', m.seq, 'speaker', m.speaker, 'body', m.body, 'amount', m.amount,
                 'move', m.move, 'at', m.at) order by m.seq)
               from public.truce_messages m where m.deal_id = d.id), '[]'::jsonb)
  );
end $$;

create or replace function public.tr_set_limit(
  p_token text, p_direction text, p_amount numeric,
  p_must_haves text[] default '{}', p_opening numeric default null)
returns jsonb language plpgsql security definer set search_path = public, sealed as $$
declare me public.truce_parties; d public.truce_deals;
begin
  select * into me from public.truce_parties where token = p_token;
  if not found then return jsonb_build_object('error','unknown link'); end if;
  select * into d from public.truce_deals where id = me.deal_id;
  if d.expires_at < now() then return jsonb_build_object('error','this link has expired'); end if;
  if p_direction not in ('max','min') then return jsonb_build_object('error','direction must be max or min'); end if;
  if p_amount is null or p_amount < 0 then return jsonb_build_object('error','a limit needs a number'); end if;
  if p_opening is not null then
    if p_direction = 'min' and p_opening < p_amount then
      return jsonb_build_object('error','your asking price is below the least you said you would take');
    end if;
    if p_direction = 'max' and p_opening > p_amount then
      return jsonb_build_object('error','your offer is above the most you said you would pay');
    end if;
  end if;

  insert into sealed.limits (party_id, deal_id, direction, amount, must_haves, opening)
  values (me.id, me.deal_id, p_direction, p_amount, coalesce(p_must_haves,'{}'), p_opening)
  on conflict (party_id) do update set direction = excluded.direction, amount = excluded.amount,
                                       must_haves = excluded.must_haves, opening = excluded.opening,
                                       set_at = now();

  update public.truce_parties set limit_set_at = now(), joined_at = coalesce(joined_at, now()) where id = me.id;
  update public.truce_deals set status = 'negotiating' where id = me.deal_id and status = 'open';
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
  -- A settled deal stays signable past expiry: the link expiring is about the INVITATION going
  -- stale, not about voiding an agreement two people already reached.
  if d.status <> 'settled' then return jsonb_build_object('error','there is nothing to sign yet'); end if;
  if coalesce(trim(p_name),'') = '' then return jsonb_build_object('error','type your name to sign'); end if;
  insert into public.truce_signatures (deal_id, party_id, name_typed, ip, user_agent)
  values (d.id, me.id, trim(p_name), p_ip, p_ua)
  on conflict (deal_id, party_id) do nothing;
  update public.truce_parties set signed_at = coalesce(signed_at, now()) where id = me.id;
  return public.tr_view(p_token);
end $$;

-- ── 2. THE TERMS EXISTED AND COULD NEVER BE SEEN ────────────────────────────────────────────
-- I put must_haves inside sealed.limits, which meant they were sealed along with the number. But
-- the number is the secret; the TERMS are the deal. A settled agreement produced a money line and
-- no words, so half the promised artifact did not exist.
--
-- Exchanged only once the negotiation is over, and each line is redacted if it contains its own
-- author's sealed figure, so a free-text box cannot reopen the leak the openings fix closed.
create or replace function public.tr_terms(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public, sealed as $$
declare me public.truce_parties; d public.truce_deals; out_terms jsonb;
begin
  select * into me from public.truce_parties where token = p_token;
  if not found then return jsonb_build_object('error','unknown link'); end if;
  select * into d from public.truce_deals where id = me.deal_id;
  if d.status not in ('settled','no_overlap') then
    return jsonb_build_object('status', d.status, 'terms', '[]'::jsonb,
      'note','terms are exchanged when the negotiation finishes, not while it is running');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'side', p.side, 'name', p.display_name, 'term', t.term) order by p.side), '[]'::jsonb)
    into out_terms
    from public.truce_parties p
    join sealed.limits l on l.party_id = p.id
    cross join lateral unnest(coalesce(l.must_haves,'{}')) as t(term)
   where p.deal_id = d.id
     -- a term whose digits contain the author's own sealed figure is withheld from everyone,
     -- because publishing it would hand the other side the number by the back door
     and position(regexp_replace(l.amount::text, '\.0+$', '') in regexp_replace(t.term, '[^0-9]', '', 'g')) = 0;

  return jsonb_build_object('status', d.status, 'settled_value', d.settled_value, 'terms', out_terms);
end $$;

-- ── 3. A REAL RATE LIMIT ON THE OPEN CREATE DOOR ────────────────────────────────────────────
-- op:'create' is an unauthenticated public write, which it has to be: the whole product is that a
-- stranger can start a deal with no account. @LANE-PARLEY was right to refuse to ship an in-memory
-- limiter, because a control that fails open when an instance recycles is worse than a documented
-- open door. This one is DURABLE and FAILS CLOSED.
create table if not exists public.rate_limits (
  bucket   text not null,
  key_hash text not null,
  window_start timestamptz not null,
  n        int not null default 0,
  primary key (bucket, key_hash, window_start)
);
alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from anon, authenticated;

create or replace function public.sv_rate_take(p_secret text, p_bucket text, p_key text,
  p_limit int, p_window interval)
returns jsonb language plpgsql security definer set search_path = public, private, extensions as $$
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
end $$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public' and (p.proname like 'tr\_%' or p.proname = 'sv_rate_take')
  loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('grant execute on function %s to anon, authenticated', f.sig);
  end loop;
end $$;;
