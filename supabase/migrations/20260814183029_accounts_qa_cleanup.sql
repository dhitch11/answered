-- 20260814183029_accounts_qa_cleanup
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- The verification harness signs a business up for real, dials it, and then has to leave nothing
-- behind: an operator console listing a business that does not exist is exactly the fabricated
-- data this estate refuses.
--
-- This is the only destructive function in the accounts spine and it is deliberately incapable of
-- touching a customer. It deletes one account and only if its owner address is the harness sink.
-- A wrong id does nothing. There is no general delete, on purpose.

create or replace function public.sv_qa_delete_account(p_secret text, p_account_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public','private'
as $$
declare v_email text; v_name text;
begin
  perform private.require(p_secret);
  select owner_email, business_name into v_email, v_name from public.accounts where id = p_account_id;
  if not found then return jsonb_build_object('ok', true, 'deleted', false, 'why', 'no such account'); end if;
  if lower(v_email) <> 'delivered@resend.dev' then
    return jsonb_build_object('ok', false, 'deleted', false, 'why', 'that is not a harness account');
  end if;
  delete from public.accounts where id = p_account_id;
  return jsonb_build_object('ok', true, 'deleted', true, 'business', v_name);
end $$;;
