-- 20260814183331_admin_console_rpcs_actions
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- The operator's WRITE actions. Every one of these moves money, changes what a customer is
-- allowed to do, or both, so every one is idempotent, records who did it, and refuses rather
-- than guesses.

-- A refund is recorded BEFORE Stripe is called, in 'pending', keyed on idem_key. If the network
-- dies between the two, the row is the evidence that a refund was attempted, and the unique index
-- means the retry cannot refund twice. A refund written only after success is a refund you cannot
-- reconcile when success is exactly what you failed to observe.
create or replace function public.sv_admin_refund_open(p_secret text, p_row jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
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
end $$;

create or replace function public.sv_admin_refund_settle(
  p_secret text, p_id uuid, p_status text, p_stripe_refund_id text, p_failure text
) returns jsonb language plpgsql security definer set search_path = public as $$
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
end $$;

-- Status is a ladder with real-world meaning attached to each rung, so the console may not set
-- 'live' by hand: /terms and the accounts lane both promise that nothing sets live except an
-- explicit assignment of a real number, and a console that could type it would make that a lie.
create or replace function public.sv_admin_account_status(
  p_secret text, p_id uuid, p_status text, p_actor text, p_reason text
) returns jsonb language plpgsql security definer set search_path = public as $$
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
end $$;

-- The cap is the customer's spending ceiling. /terms promises a cap never moves inside a cycle
-- the customer is already standing in, so a raise lands on pending_cap_cents for next cycle.
-- A LOWER cap may take effect immediately, because lowering it can only ever protect them.
create or replace function public.sv_admin_set_cap(
  p_secret text, p_account_key text, p_cap_cents integer, p_actor text
) returns jsonb language plpgsql security definer set search_path = public as $$
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
end $$;

-- Link an existing billing account to its customer. Closes the two-identity gap for any row a
-- lane created before the foreign key existed.
create or replace function public.sv_admin_link_billing(
  p_secret text, p_account_id uuid, p_account_key text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare b public.billing_accounts%rowtype;
begin
  perform private.require(p_secret);
  update public.billing_accounts set account_id = p_account_id
   where account_key = p_account_key returning * into b;
  if not found then return jsonb_build_object('ok', false, 'error', 'no such billing account'); end if;
  return jsonb_build_object('ok', true, 'billing', to_jsonb(b));
end $$;

-- Attribute a call to the customer it belongs to. Used by the dial and inbound paths, and by an
-- operator repairing an old row.
create or replace function public.sv_admin_attribute_call(
  p_secret text, p_call_sid text, p_account_id uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.calls%rowtype;
begin
  perform private.require(p_secret);
  update public.calls set account_id = p_account_id where call_sid = p_call_sid returning * into c;
  if not found then return jsonb_build_object('ok', false, 'error', 'no such call'); end if;
  return jsonb_build_object('ok', true, 'call_id', c.id, 'account_id', c.account_id);
end $$;

-- Backfill: attribute every unattributed call whose dialled number belongs to an account.
-- Returns the count so the console reports a measured number, never an assumed one.
create or replace function public.sv_admin_attribute_backfill(p_secret text)
returns jsonb language plpgsql security definer set search_path = public as $$
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
end $$;;
