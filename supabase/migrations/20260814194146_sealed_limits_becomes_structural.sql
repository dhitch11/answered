-- 20260814194146_sealed_limits_becomes_structural
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- ★ @ANSWERED-INTEL CORRECTED A CLAIM I MADE AND THEY WERE RIGHT.
--
-- I said the Truce privacy promise was "enforced in the data model". It was not. The zero grants on
-- sealed.limits are real, and they do not bind a SECURITY DEFINER function that names the schema in
-- its search_path. tr_view and tr_leak_check both ran `select * into theirs from sealed.limits`, so
-- THE COUNTERPARTY'S SEALED NUMBER WAS IN A LOCAL VARIABLE inside them. The only thing keeping it
-- private was that the return statement emitted theirs.opening and not theirs.amount.
--
-- That is a code review, not a structure. One careless jsonb_build_object key away from a leak, with
-- nothing underneath it. /truce Section 3 sells a guarantee; a guarantee that depends on nobody ever
-- adding a field is a promise, not a mechanism.
--
-- THE FIX: the caller-facing functions can no longer REACH the table. sealed access moves into three
-- helpers that return only what may be emitted, and `sealed` is removed from the search_path of every
-- tr_* function, so a reference to sealed.limits in one of them is now a compile error rather than a
-- judgement call. A careless key cannot leak what the function cannot fetch.

-- Only ever the caller's OWN limit. There is no parameter that returns someone else's.
create or replace function sealed.my_limit(p_party uuid)
returns jsonb language sql stable security definer set search_path = sealed, public as $$
  select jsonb_build_object('amount', l.amount, 'opening', l.opening,
                            'direction', l.direction, 'must_haves', l.must_haves)
    from sealed.limits l where l.party_id = p_party;
$$;

-- The counterparty, reduced to what is PUBLIC BY DESIGN. `amount` is not selected, so it cannot be
-- returned by accident: the value never enters the caller's scope at all.
create or replace function sealed.their_public(p_party uuid)
returns jsonb language sql stable security definer set search_path = sealed, public as $$
  select jsonb_build_object(
           'has_set_limit', exists (select 1 from sealed.limits l where l.party_id = p_party),
           'opening', (select l.opening from sealed.limits l where l.party_id = p_party));
$$;

-- Counts only. The instrument behind the Section 3 button needs to compare against both limits and
-- must never carry either one out.
create or replace function sealed.leak_counts(p_deal uuid, p_me uuid, p_them uuid)
returns jsonb language sql stable security definer set search_path = sealed, public as $$
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
$$;

-- The redaction happens inside the seal, so the raw amount is never in the caller's scope.
create or replace function sealed.terms_for(p_deal uuid)
returns jsonb language sql stable security definer set search_path = sealed, public as $$
  select coalesce(jsonb_agg(jsonb_build_object('side', p.side, 'name', p.display_name, 'term', t.term)
                            order by p.side), '[]'::jsonb)
    from public.truce_parties p
    join sealed.limits l on l.party_id = p.id
    cross join lateral unnest(coalesce(l.must_haves, '{}')) as t(term)
   where p.deal_id = p_deal
     and position(regexp_replace(l.amount::text, '\.0+$', '') in regexp_replace(t.term, '[^0-9]', '', 'g')) = 0;
$$;

revoke all on function sealed.my_limit(uuid), sealed.their_public(uuid),
                      sealed.leak_counts(uuid,uuid,uuid), sealed.terms_for(uuid)
  from public, anon, authenticated;

-- ── the caller-facing functions, with `sealed` OUT of their search_path ──────────────────────
-- They also now require the shared secret, which closes the second half of the finding: every one
-- of these was anonymously invokable with the publishable key, which bypassed the rate limiting in
-- /api/truce entirely. The party token remains the USER's credential; the secret proves the call
-- came from our server. Two layers, and neither is the other's substitute.
create or replace function public.tr_view(p_secret text, p_token text)
returns jsonb language plpgsql stable security definer set search_path = public, private as $$
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
end $$;

create or replace function public.tr_leak_check(p_secret text, p_token text)
returns jsonb language plpgsql stable security definer set search_path = public, private as $$
declare me public.truce_parties; them public.truce_parties;
begin
  perform private.require(p_secret);
  select * into me from public.truce_parties where token = p_token;
  if not found then return jsonb_build_object('error','unknown link'); end if;
  select * into them from public.truce_parties where deal_id = me.deal_id and side <> me.side;
  return sealed.leak_counts(me.deal_id, me.id, them.id);
end $$;

create or replace function public.tr_terms(p_secret text, p_token text)
returns jsonb language plpgsql stable security definer set search_path = public, private as $$
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
end $$;

-- drop the old unguarded single-argument signatures so nothing can call them
drop function if exists public.tr_view(text);
drop function if exists public.tr_leak_check(text);
drop function if exists public.tr_terms(text);;
