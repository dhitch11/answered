-- 20260814183549_billing_fix_null_at_and_non_capped_charge
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- TWO DEFECTS, BOTH FOUND BY RUNNING THE THING RATHER THAN READING IT.
--
-- (1) AN EXPLICIT NULL IS NOT AN ABSENT ARGUMENT, AND A SQL DEFAULT ONLY COVERS THE ABSENT ONE.
--     The caller passes p_at: null whenever an event carries no occurred_at, which is the common
--     case. `p_at timestamptz default now()` never fired, so p_at was NULL, so
--     date_trunc('month', NULL) was NULL, so `cycle_month = NULL` matched no rows, so
--     month_charged_cents came back 0 on every single call. The cap preview therefore believed it
--     had a full $549 of headroom on every event, forever. The bill itself was still correct only
--     because sv_bill_record recomputes the clamp under its own lock and coalesces properly, which
--     is exactly why that redundancy exists. Measured on the qa account: the ledger clamped a
--     booking to $12.00 at the boundary while the engine's stored reason said the plain
--     "A job booked in standard hours", with no mention of a cap.
--
-- (2) A NON-CAPPED EVENT WAS RECORDED AT ITS LIST PRICE, NOT AT WHAT THE METER SAID TO CHARGE.
--     For anything outside the cap the function did `v_cents := v_gross`, which is right for a
--     recover share and wrong for every event whose rated price differs from its list price. The
--     free first hold has gross $20.00 and a rated price of $0.00, so the customer's first hold,
--     the one promised free in writing so they can see a receipt before they ever pay for one, was
--     recorded as a $20.00 charge. Two holds cost $40.00 instead of $20.00.
--     The fix keeps gross_cents as the list price for the statement to show, and takes the amount
--     to charge from charge_cents.

create or replace function public.sv_bill_context(p_secret text, p_account_key text, p_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path to 'public','private' as $$
declare a public.billing_accounts; v_at timestamptz; v_cycle date; v_charged int; v_credit int; v_holds int; v_months jsonb;
begin
  perform private.require(p_secret);
  select * into a from public.billing_accounts where account_key = lower(trim(p_account_key));
  if not found then return jsonb_build_object('error','unknown account'); end if;
  v_at    := coalesce(p_at, now());
  v_cycle := date_trunc('month', v_at)::date;

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
       and state <> 'voided' and occurred_at >= v_at - interval '90 days'
     group by 1) s;

  return jsonb_build_object(
    'account_id', a.id, 'plan', a.plan,
    'cap_cents', case when a.pending_cap_month is not null and a.pending_cap_month <= v_cycle
                      then a.pending_cap_cents else a.cap_cents end,
    'cycle', v_cycle,
    'month_charged_cents', v_charged,
    'quiet_credit_cents', greatest(0, v_credit),
    'first_hold_used', v_holds > 0,
    'quiet_notice_at', a.quiet_notice_at,
    'bookings_last_90d', coalesce(v_months, '[]'::jsonb),
    'statement_token', a.statement_token,
    'stripe_customer_id', a.stripe_customer_id,
    'card_on_file', a.card_on_file);
end $$;

create or replace function public.sv_bill_record(p_secret text, p_account_key text, p_row jsonb)
returns jsonb language plpgsql security definer set search_path to 'public','private' as $$
declare
  a public.billing_accounts; e public.billing_events;
  v_cycle date; v_at timestamptz; v_charged int; v_credit int; v_cap int;
  v_gross int; v_charge int; v_room int; v_after_cap int; v_cap_applied int; v_credit_used int; v_cents int;
  v_counts boolean; v_creates int;
begin
  perform private.require(p_secret);
  select * into a from public.billing_accounts where account_key = lower(trim(p_account_key)) for update;
  if not found then raise exception 'unknown account %', p_account_key; end if;

  v_at    := coalesce((p_row->>'occurred_at')::timestamptz, now());
  v_cycle := date_trunc('month', v_at)::date;

  if a.pending_cap_month is not null and a.pending_cap_month <= v_cycle then
    update public.billing_accounts
       set cap_cents = a.pending_cap_cents, pending_cap_cents = null, pending_cap_month = null
     where id = a.id returning * into a;
  end if;
  v_cap := a.cap_cents;

  select * into e from public.billing_events
   where account_id = a.id and idem_key = p_row->>'idem_key';
  if found then
    return jsonb_build_object('replay', true, 'id', e.id, 'cents', e.cents, 'state', e.state,
                              'billable', e.billable, 'reason', e.reason, 'cycle_month', e.cycle_month);
  end if;

  v_gross   := coalesce((p_row->>'gross_cents')::int, 0);
  -- What the engine says to charge, which is not always the list price. Falls back to the list
  -- price only when the caller did not say, so an old caller cannot silently start billing zero.
  v_charge  := coalesce((p_row->>'charge_cents')::int, v_gross);
  v_counts  := coalesce((p_row->>'counts_toward_cap')::boolean, false);
  v_creates := coalesce((p_row->>'credit_created_cents')::int, 0);

  if v_counts then
    select coalesce(sum(cents),0) into v_charged from public.billing_events
     where account_id = a.id and cycle_month = v_cycle and state <> 'voided' and counts_toward_cap;
    v_room       := greatest(0, v_cap - v_charged);
    v_after_cap  := least(v_charge, v_room);
    v_cap_applied:= v_charge - v_after_cap;

    select coalesce(sum(credit_created_cents),0) - coalesce(sum(credit_applied_cents),0) into v_credit
      from public.billing_events where account_id = a.id and state <> 'voided';
    v_credit_used := least(greatest(0, v_credit), v_after_cap);
    v_cents := v_after_cap - v_credit_used;
  else
    v_cap_applied := 0; v_credit_used := 0; v_cents := v_charge;
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
end $$;;
