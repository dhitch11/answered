-- 20260814194248_recover_tcpa_consent_basis_and_call_token
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- ★ THE TCPA COLUMN THAT DECIDES WHETHER THIS CALL MAY BE PLACED AT ALL.
--
-- FCC 24-17 (Feb 2024) settles that an AI-generated voice IS an "artificial voice" for 47 U.S.C.
-- 227(b). 227(b)(1)(A)(iii) makes an artificial-voice call to a WIRELESS number unlawful without the
-- called party's prior express consent, and Barr v. AAPC (2020) struck the government-debt carve-out,
-- so there is no debt exemption to stand on.
--
-- The consent that exists here is real but NARROW: the FCC's 2008 Declaratory Ruling (23 FCC Rcd 559)
-- holds that a wireless number the debtor themselves gave to the creditor IN CONNECTION WITH THE
-- TRANSACTION carries prior express consent for calls about that debt. That is a FACT ABOUT ONE
-- INVOICE, not a posture, so it is a column with a source and a date. An invoice that cannot say
-- where the number came from does not get an artificial-voice call to a mobile. It gets a refusal.
alter table public.recover_invoices
  add column if not exists debtor_line_type  text,
  add column if not exists debtor_lookup_ok  boolean,
  add column if not exists debtor_lookup_at  timestamptz,
  add column if not exists consent_basis     text,
  add column if not exists number_source     text,
  add column if not exists number_given_at   timestamptz;

comment on column public.recover_invoices.consent_basis is
  'Why an artificial voice may lawfully call this number. provided_in_transaction = the debtor gave this number to the business in connection with the job (FCC 2008 Declaratory Ruling, 23 FCC Rcd 559). estate_qa_line = a line this estate owns, used for proving the runtime, never a consumer. Anything else, or null, refuses a mobile.';

-- The capability token for the TwiML webhook, stored as a hash so a database read cannot mint a call.
alter table public.recover_calls
  add column if not exists token_sha256 text,
  add column if not exists call_class   text;

create or replace function public.sv_recover_bind_call(p_secret text, p_id uuid, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path to 'public','private' as $$
declare c public.recover_calls%rowtype;
begin
  perform private.require(p_secret);
  update public.recover_calls set
    call_sid       = coalesce(p_patch->>'call_sid', call_sid),
    placed         = coalesce((p_patch->>'placed')::boolean, placed),
    status         = coalesce(p_patch->>'status', status),
    token_sha256   = coalesce(p_patch->>'token_sha256', token_sha256),
    call_class     = coalesce(p_patch->>'call_class', call_class),
    refused_reason = coalesce(p_patch->>'refused_reason', refused_reason),
    outcome        = outcome || coalesce(p_patch->'outcome','{}'::jsonb)
   where id = p_id returning * into c;
  if not found then return jsonb_build_object('error','no such call row'); end if;
  if c.placed then
    update public.recover_invoices
       set first_call_at = coalesce(first_call_at, now()), last_contact_at = now()
     where id = c.invoice_id;
  end if;
  return to_jsonb(c);
end $$;

-- The webhook's door: hand it the row id and the token, get back everything the call needs to speak,
-- and nothing at all if the token is wrong. The comparison happens in the database so a wrong token
-- cannot even learn that the row exists.
create or replace function public.sv_recover_call_context(p_secret text, p_id uuid, p_token_sha256 text)
returns jsonb language plpgsql stable security definer set search_path to 'public','private' as $$
declare c public.recover_calls%rowtype; i public.recover_invoices%rowtype;
begin
  perform private.require(p_secret);
  select * into c from public.recover_calls where id = p_id;
  if not found then return jsonb_build_object('error','no such call'); end if;
  if c.token_sha256 is null or c.token_sha256 <> p_token_sha256 then
    return jsonb_build_object('error','token mismatch');
  end if;
  select * into i from public.recover_invoices where id = c.invoice_id;
  return jsonb_build_object('call', to_jsonb(c), 'invoice', to_jsonb(i),
                            'balance_cents', i.amount_cents - i.paid_cents);
end $$;;
