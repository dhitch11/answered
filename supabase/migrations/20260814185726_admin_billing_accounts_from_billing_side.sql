-- 20260814185726_admin_billing_accounts_from_billing_side
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- sv_admin_billing_accounts — the billing list, driven FROM the billing table.
--
-- ★ WHY THIS EXISTS, AND IT IS A REAL DEFECT THAT SHIPPED FOR TWENTY MINUTES.
-- The first version of the Billing panel built its list by iterating CUSTOMERS and keeping the
-- ones that had a billing record. With 0 customers and 14 billing accounts in this database, the
-- panel rendered "No billing accounts yet. This is a measured zero." directly underneath a tile
-- reading "97 charges recorded, $492.00 open". Two numbers on one screen, contradicting each
-- other, and the honest-empty-state copy made the wrong one look considered.
--
-- The panel whose whole job is to surface billing records that are NOT joined to a customer was
-- structurally incapable of seeing them, because it started from the join it was meant to audit.
-- An orphan is invisible to a query that walks the parent.
--
-- So this walks billing_accounts and LEFT JOINs the customer. An unlinked row now appears and is
-- labelled, which is the only way an operator ever finds out it exists.

create or replace function public.sv_admin_billing_accounts(
  p_secret text, p_q text, p_limit integer, p_offset integer
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb; n bigint; lim integer; off integer;
begin
  perform private.require(p_secret);
  lim := greatest(1, least(coalesce(p_limit, 100), 500));
  off := greatest(0, coalesce(p_offset, 0));

  select count(*) into n from public.billing_accounts b
   where (p_q is null or p_q = '' or b.business_name ilike '%'||p_q||'%'
          or b.email ilike '%'||p_q||'%' or b.account_key ilike '%'||p_q||'%');

  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v from (
    select b.id                as billing_account_id,
           b.account_id,
           b.account_key,
           coalesce(a.business_name, b.business_name) as business_name,
           b.email, b.plan, b.cap_cents, b.status,
           b.card_on_file, b.card_brand, b.card_last4, b.stripe_customer_id,
           b.created_at,
           (a.id is not null)  as linked,
           coalesce(v2.charged_cents, 0)        as charged_cents,
           coalesce(v2.unbilled_cents, 0)       as unbilled_cents,
           coalesce(v2.paid_cents, 0)           as paid_cents,
           coalesce(v2.credit_balance_cents, 0) as credit_balance_cents,
           coalesce(v2.refunded_cents, 0)       as refunded_cents,
           coalesce(v2.event_count, 0)          as charges,
           v2.last_event_at
      from public.billing_accounts b
      left join public.accounts a          on a.id = b.account_id
      left join public.v_account_balance v2 on v2.billing_account_id = b.id
     where (p_q is null or p_q = '' or b.business_name ilike '%'||p_q||'%'
            or b.email ilike '%'||p_q||'%' or b.account_key ilike '%'||p_q||'%')
     order by coalesce(v2.last_event_at, b.created_at) desc
     limit lim offset off
  ) x;

  return jsonb_build_object(
    'total', n, 'limit', lim, 'offset', off, 'rows', v,
    -- Surfaced as its own figure so the console can state it plainly rather than making an
    -- operator count coloured pills.
    'orphans', (select count(*) from public.billing_accounts where account_id is null));
end $$;;
