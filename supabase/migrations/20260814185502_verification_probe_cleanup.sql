-- 20260814185502_verification_probe_cleanup
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- sv_admin_purge_probe — removes a VERIFICATION PROBE account and nothing else.
--
-- This exists because the alternative is worse. To verify the customer drawer end to end I need a
-- real row moving through the real signup RPC, and a residue row would silently corrupt every
-- customer count on the console forever. So the probe is created, driven, and removed in one
-- cycle with the removal in a `finally`.
--
-- ★ IT IS SAFE BY CONSTRUCTION, NOT BY DISCIPLINE. It refuses any account whose owner_email is
-- not on the `.invalid` top-level domain. `.invalid` is reserved by RFC 2606 precisely so that it
-- can never be a real address, which means this function CANNOT delete a customer even if it is
-- called with a real account id, by a mistake, or by someone who should not have it. A guard that
-- depends on the caller being careful is not a guard.
--
-- It also refuses to touch an account that has any call, any billing row, or any provisioned
-- number attached, because those would be signs it is not a probe after all.

create or replace function public.sv_admin_purge_probe(p_secret text, p_account_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.accounts%rowtype; n_calls int; n_bill int; n_nums int;
begin
  perform private.require(p_secret);

  select * into a from public.accounts where id = p_account_id;
  if not found then return jsonb_build_object('ok', true, 'note', 'already gone'); end if;

  if a.owner_email !~* '\.invalid$' then
    return jsonb_build_object('ok', false,
      'error', 'refused: this function only removes verification probes on the reserved .invalid domain, and that account is not one');
  end if;

  select count(*) into n_calls from public.calls where account_id = p_account_id;
  select count(*) into n_bill  from public.billing_accounts where account_id = p_account_id;
  select count(*) into n_nums  from public.account_numbers where account_id = p_account_id;
  if n_calls > 0 or n_bill > 0 or n_nums > 0 then
    return jsonb_build_object('ok', false,
      'error', 'refused: that account has real activity attached',
      'calls', n_calls, 'billing', n_bill, 'numbers', n_nums);
  end if;

  delete from public.account_config_versions where account_id = p_account_id;
  delete from public.account_config          where account_id = p_account_id;
  delete from public.account_tokens          where account_id = p_account_id;
  delete from public.account_events          where account_id = p_account_id;
  delete from public.app_events              where account_id = p_account_id;
  delete from public.accounts                where id         = p_account_id;

  -- The audit trail of what an operator did to the probe is NOT deleted. It is append only by
  -- trigger, and a record of a verification run is worth keeping.
  return jsonb_build_object('ok', true, 'purged', p_account_id, 'email', a.owner_email);
end $$;;
