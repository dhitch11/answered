-- 20260814183413_billing_statement_token_without_pgcrypto
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- gen_random_bytes lives in the `extensions` schema on Supabase, and this function pins
-- search_path to 'public','private' for safety, so the call resolved to nothing and every account
-- creation died with 42883. The failure was loud and immediate, which is the good kind, but the
-- fix should not be to widen search_path just to reach one function: gen_random_uuid() is in core
-- Postgres, is CSPRNG-backed, and two of them concatenated give 64 hex characters, 128 bits of
-- randomness, which is the same order as the truce party token this is modelled on.
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
     set business_name = coalesce(nullif(trim(excluded.business_name),''), public.billing_accounts.business_name),
         email         = coalesce(nullif(excluded.email,''), public.billing_accounts.email),
         phone         = coalesce(excluded.phone, public.billing_accounts.phone)
  returning * into a;
  return jsonb_build_object('id', a.id, 'account_key', a.account_key,
                            'statement_token', a.statement_token, 'cap_cents', a.cap_cents,
                            'plan', a.plan, 'stripe_customer_id', a.stripe_customer_id);
end $$;;
