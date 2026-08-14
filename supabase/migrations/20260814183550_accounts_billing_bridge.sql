-- 20260814183550_accounts_billing_bridge
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- The billing lane (billing/001_billing_ledger.sql) built public.billing_accounts, keyed by a
-- text account_key. This spine keys a customer by uuid. Two customer tables is how a business
-- ends up billed under one identity and answered under another.
--
-- The bridge is placed HERE, on this lane's table, deliberately: writing a column into another
-- lane's schema mid-build is the kind of silent edit HARD RULE 0 exists to stop. This side can be
-- pointed at theirs with one call and nothing of theirs changes.
--
-- The contract, posted to .terminal-claims.md: public.accounts.id is the customer's identity, and
-- billing_accounts.account_key for an Answered customer should be the text of that uuid.

alter table public.accounts add column if not exists billing_account_key text;
create index if not exists accounts_billing_key_idx on public.accounts (billing_account_key);
comment on column public.accounts.billing_account_key is
  'Points at public.billing_accounts.account_key. Null means this business has no billing record yet, which is the true state for every account until the billing lane creates one.';

create or replace function public.sv_account_link_billing(
  p_secret text, p_account_id uuid, p_billing_account_key text)
returns jsonb
language plpgsql security definer set search_path to 'public','private'
as $$
begin
  perform private.require(p_secret);
  update public.accounts
     set billing_account_key = nullif(trim(p_billing_account_key),''), updated_at = now()
   where id = p_account_id;
  if not found then return jsonb_build_object('ok', false, 'why', 'no such account'); end if;
  insert into public.account_events (account_id, kind, payload, actor)
    values (p_account_id, 'billing_linked', jsonb_build_object('account_key', p_billing_account_key), 'system');
  return jsonb_build_object('ok', true, 'account', private.account_json(p_account_id));
end $$;;
