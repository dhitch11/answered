-- 20260814184640_billing_partial_upsert_must_not_erase_the_name
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- A PARTIAL UPSERT WAS RENAMING A REAL ACCOUNT TO "unnamed account".
--
-- The DO UPDATE read `excluded.business_name`, which is not the caller's input: it is the value
-- the INSERT would have written, and the INSERT had already coalesced a missing name to the
-- literal 'unnamed account'. So `nullif(trim(excluded.business_name), '')` was never null, the
-- guard never fired, and any caller that upserted with only an account_key and an email wiped the
-- business name off the account. Measured on qa-lane-billing: created as "QA, lane billing. Not a
-- customer.", and the customer's own statement was headed "unnamed account" a few calls later.
--
-- The fix is to read the CALLER'S value, p_row->>'business_name', which really is null when the
-- caller did not send one. Same for the plan and the cap, which had the same shape of bug waiting:
-- an upsert omitting them would have quietly reset a subscriber to standard and a moved cap back
-- to $549, and the terms promise a cap never moves without the customer.
create or replace function public.sv_bill_account(p_secret text, p_row jsonb)
returns jsonb language plpgsql security definer set search_path to 'public','private' as $$
declare a public.billing_accounts;
begin
  perform private.require(p_secret);
  insert into public.billing_accounts (account_key, business_name, email, phone, plan, cap_cents, statement_token)
  values (
    lower(trim(p_row->>'account_key')),
    coalesce(nullif(trim(p_row->>'business_name'),''), 'unnamed account'),
    lower(trim(p_row->>'email')),
    nullif(p_row->>'phone',''),
    coalesce(nullif(p_row->>'plan',''), 'standard'),
    coalesce((p_row->>'cap_cents')::int, 54900),
    replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
  )
  on conflict (account_key) do update
     set business_name = coalesce(nullif(trim(p_row->>'business_name'),''), public.billing_accounts.business_name),
         email         = coalesce(nullif(lower(trim(p_row->>'email')),''), public.billing_accounts.email),
         phone         = coalesce(nullif(p_row->>'phone',''), public.billing_accounts.phone),
         plan          = coalesce(nullif(p_row->>'plan',''), public.billing_accounts.plan)
  returning * into a;
  return jsonb_build_object('id', a.id, 'account_key', a.account_key,
                            'statement_token', a.statement_token, 'cap_cents', a.cap_cents,
                            'plan', a.plan, 'stripe_customer_id', a.stripe_customer_id);
end $$;;
