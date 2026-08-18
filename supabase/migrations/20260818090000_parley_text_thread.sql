-- 20260818090000_parley_text_thread
--
-- ═══ WHY THIS EXISTS: THE NEGOTIATION ENGINE WAS BUILT AND COULD NEVER RUN ═══
--
-- Everything needed for a real haggle already shipped: tr_say records a turn, tr_agent_brief hands
-- an agent the sealed floor it must not cross, lib/parley-agent.mjs runs the model behind a
-- deterministic firewall, and tr_agent_settle re-reads both sealed limits so nobody is bound to a
-- figure the model was talked into. truce.mjs:198 even says what it was for:
--
--     "You say something, and the OTHER side's agent answers ... This is the product as it was
--      specced: you haggle with their agent, not with a form. The same call serves the web thread
--      today and the SMS thread the moment the number is live."
--
-- None of it could ever be reached, because `tr_set_limit` SETTLES INLINE. The instant the second
-- limit lands it computes a figure and writes status='settled', and tr_say then refuses every
-- message with "this deal is finished". Measured on production before this migration:
--
--     23 of 23 settled deals settled 0.000000 seconds after the second limit arrived
--     23 of 23 settled deals carry ZERO messages
--     settlement.messages has been recording that zero the whole time
--
-- So the shipped product was a sealed-bid CALCULATOR wearing a negotiation's clothes, and the
-- negotiation was dead code sitting one branch away. This is the estate's most familiar failure -
-- built and wired and never fed - and the tell was in the data the entire time.
--
-- ═══ WHAT CHANGES ═══
--
-- 1. `truce_deals.mode` — 'instant' keeps the calculator exactly as it is, so all 23 existing deals
--    and the web flow are untouched. 'thread' means the two sides TALK, through their agents, and
--    settlement comes from tr_agent_settle at the end of a real conversation rather than from
--    arithmetic at the start of one.
--
--    Defaulting to 'instant' is deliberate: a migration that silently changed how every existing
--    deal resolves would be a behaviour change disguised as a feature.
--
-- 2. `truce_parties.phone` — an E.164 number so a thread can live in SMS. `tr_set_contact` refused
--    phone numbers with a comment that was honest at the time: "A phone number would imply we can
--    text, and texting is not switched on." It is switched on now, so the refusal goes.
--
--    The rule that does NOT change: a party may only ever write their OWN contact. The token
--    identifies exactly one row, and there is still no path for one side to supply the other's
--    number. That is the invitation model and it is load-bearing - see
--    feedback_an_invitation_is_not_a_credential.
--
-- 3. `tr_party_by_phone` — the inbound door. An SMS arrives carrying only a phone number, so the
--    transport needs to turn that into a party token. It resolves ONLY to a live thread deal, and
--    returns nothing for a settled, expired, withdrawn or instant-mode deal, so an old number
--    cannot wake a finished negotiation.
--
-- 4. `tr_thread_state` — one read that tells the transport everything it needs about whose turn it
--    is, without handing it a sealed number.

begin;

-- ── 1. mode ──────────────────────────────────────────────────────────────────────────────────
alter table public.truce_deals
  add column if not exists mode text not null default 'instant';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'truce_deals_mode_ck') then
    alter table public.truce_deals
      add constraint truce_deals_mode_ck check (mode in ('instant', 'thread'));
  end if;
end $$;

comment on column public.truce_deals.mode is
  'instant = the sealed-bid calculator: both limits in, settle arithmetically, no conversation. '
  'thread = the two sides negotiate through their agents and tr_agent_settle records the close. '
  'Existing deals default to instant so nothing already agreed changes meaning.';

-- ── 2. a phone number per party ──────────────────────────────────────────────────────────────
alter table public.truce_parties
  add column if not exists phone text;

create unique index if not exists truce_parties_phone_live_uq
  on public.truce_parties (phone)
  where phone is not null;

comment on column public.truce_parties.phone is
  'E.164, this party''s OWN number, written only through tr_set_contact with this party''s token. '
  'Unique so one handset is never two parties at once, which would make an inbound SMS ambiguous.';

-- ── 3. tr_set_limit: do not settle a deal that is meant to be talked through ─────────────────
create or replace function public.tr_set_limit(
  p_secret text, p_token text, p_direction text, p_amount numeric,
  p_must_haves text[] default '{}'::text[], p_opening numeric default null,
  p_target numeric default null)
returns jsonb language plpgsql security definer
set search_path to 'public', 'private', 'sealed', 'extensions' as $function$
declare me public.truce_parties; d public.truce_deals; other public.truce_parties;
        o_amt numeric; o_dir text; lo numeric; hi numeric; mid numeric; val numeric; n int;
        s double precision;
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

    -- ★ THE ONE-LINE CHANGE THIS MIGRATION EXISTS FOR.
    -- In THREAD mode the overlap is not the answer, it is the room the negotiation happens inside.
    -- Settling here would end the deal before either agent has said a word - which is exactly what
    -- has happened to all 23 deals on this database. The status stays 'negotiating', the sealed
    -- numbers stay sealed, and tr_agent_settle closes it when the conversation actually concludes.
    -- The overlap check ABOVE still runs, so a genuinely impossible pair still dies immediately
    -- instead of sending two agents to haggle over nothing.
    if d.mode = 'thread' then
      return public.tr_view(p_secret, p_token);
    end if;

    -- ★ WRITE THE SEED, THEN USE IT. Deliberately no coalesce to a neutral value: if a seed
    -- cannot be established the offset must not silently become zero, which is the entire defect
    -- the previous migration exists to remove.
    s := d.seed;
    if s is null then
      s := random();
      update public.truce_deals set seed = s where id = d.id;
    end if;

    mid := (lo + hi) / 2.0;
    val := round(mid + ((s - 0.5) * (hi - lo) * 0.18));
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
end $function$;

-- ── 4. tr_set_contact: an E.164 phone is now a legitimate contact ────────────────────────────
create or replace function public.tr_set_contact(p_secret text, p_token text, p_contact text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'private', 'extensions' as $function$
declare pid uuid; did uuid; c text; is_phone boolean;
begin
  perform private.require(p_secret);
  select id, deal_id into pid, did from public.truce_parties where token = p_token;
  if pid is null then return jsonb_build_object('ok', false, 'reason', 'unknown token'); end if;
  c := nullif(btrim(coalesce(p_contact,'')), '');

  -- ★ THE OLD COMMENT HERE READ: "Only an email. A phone number would imply we can text, and
  -- texting is not switched on." That was honest and it is now out of date. A thread deal lives in
  -- SMS, so a number is the whole point.
  is_phone := c is not null and c ~ '^\+[1-9][0-9]{7,14}$';
  if c is not null and not is_phone
     and c !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return jsonb_build_object('ok', false, 'reason',
      'that is neither an email address nor a phone number in +15551234567 form');
  end if;

  -- ★ A PARTY MAY ONLY EVER WRITE THEIR OWN CONTACT, because the token identifies exactly one
  -- row. There is deliberately no path anywhere that lets one side supply the other side's
  -- address or number: the whole invitation model is that the sender passes the link on
  -- themselves. Unchanged, and the reason it is unchanged is that the last time this rule was
  -- weak the sender could read the counterparty's sealed limit.
  if is_phone then
    -- One handset cannot be two live parties, or an inbound SMS is ambiguous and we would have to
    -- guess which negotiation it belongs to. Guessing is not available on this surface.
    if exists (select 1 from public.truce_parties tp
                join public.truce_deals td on td.id = tp.deal_id
               where tp.phone = c and tp.id <> pid
                 and td.status in ('open','negotiating') and td.expires_at > now()) then
      return jsonb_build_object('ok', false, 'reason',
        'that number is already in another live negotiation. Finish it first, or use a different number.');
    end if;
    update public.truce_parties set phone = c where id = pid;
  else
    update public.truce_parties set contact = c where id = pid;
  end if;
  return jsonb_build_object('ok', true, 'saved', c is not null, 'channel',
                            case when is_phone then 'sms' else 'email' end);
end $function$;

-- ── 5. the inbound door: a phone number becomes a party token ────────────────────────────────
create or replace function public.tr_party_by_phone(p_secret text, p_phone text)
returns jsonb language plpgsql stable security definer
set search_path to 'public', 'private', 'extensions' as $function$
declare r record;
begin
  perform private.require(p_secret);
  -- Only a LIVE thread deal. A settled, expired, withdrawn or instant-mode deal returns nothing,
  -- so an old number can never wake a finished negotiation, and the transport gets a clean "not
  -- one of ours" rather than a half-answer it has to interpret.
  select tp.token, tp.side, td.id as deal_id, td.subject, td.status, td.mode
    into r
    from public.truce_parties tp
    join public.truce_deals td on td.id = tp.deal_id
   where tp.phone = p_phone
     and td.mode = 'thread'
     and td.status in ('open','negotiating')
     and td.expires_at > now()
   order by td.created_at desc
   limit 1;
  if r.token is null then return jsonb_build_object('ok', false, 'reason', 'no live thread for that number'); end if;
  return jsonb_build_object('ok', true, 'token', r.token, 'side', r.side,
                            'deal_id', r.deal_id, 'subject', r.subject, 'status', r.status);
end $function$;

-- ── 6. one read the transport can act on, with no sealed number in it ────────────────────────
create or replace function public.tr_thread_state(p_secret text, p_deal uuid)
returns jsonb language plpgsql stable security definer
set search_path to 'public', 'private', 'extensions' as $function$
declare d public.truce_deals; msgs int; a_ready boolean; b_ready boolean; a_ph text; b_ph text;
begin
  perform private.require(p_secret);
  select * into d from public.truce_deals where id = p_deal;
  if d.id is null then return jsonb_build_object('ok', false, 'reason', 'unknown deal'); end if;
  select count(*) into msgs from public.truce_messages where deal_id = d.id;
  select (l.party_id is not null), tp.phone into a_ready, a_ph
    from public.truce_parties tp left join sealed.limits l on l.party_id = tp.id
   where tp.deal_id = d.id and tp.side = 'a';
  select (l.party_id is not null), tp.phone into b_ready, b_ph
    from public.truce_parties tp left join sealed.limits l on l.party_id = tp.id
   where tp.deal_id = d.id and tp.side = 'b';
  -- Deliberately no amounts, no targets, no limits. The transport never needs one and the fewer
  -- places a sealed figure can reach, the fewer places it can leak from.
  return jsonb_build_object(
    'ok', true, 'deal_id', d.id, 'mode', d.mode, 'status', d.status, 'subject', d.subject,
    'messages', msgs, 'settled_value', d.settled_value,
    'a', jsonb_build_object('limit_set', coalesce(a_ready,false), 'has_phone', a_ph is not null),
    'b', jsonb_build_object('limit_set', coalesce(b_ready,false), 'has_phone', b_ph is not null),
    'both_ready', coalesce(a_ready,false) and coalesce(b_ready,false));
end $function$;

-- Same posture as every other sv_/tr_ function here: no direct table rights, execute only.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname='public'
              and p.proname in ('tr_set_limit','tr_set_contact','tr_party_by_phone','tr_thread_state')
  loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('grant execute on function %s to anon, authenticated', f.sig);
  end loop;
end $$;

commit;
