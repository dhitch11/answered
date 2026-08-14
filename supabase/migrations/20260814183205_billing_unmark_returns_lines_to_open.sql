-- 20260814183205_billing_unmark_returns_lines_to_open
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- A discarded draft must give its lines back.
--
-- Without this, sv_bill_mark(...,'invoiced') was a one-way door: throw the draft away in Stripe and
-- the ledger still believed those outcomes were on an invoice, so the next close would skip them
-- and the customer would never be billed for work that really happened. The lines would sit in
-- 'invoiced' pointing at an invoice id that no longer exists anywhere.
--
-- Deliberately refuses to touch a PAID or VOIDED line. A paid line going back to open would
-- re-bill somebody, and a voided line coming back to life is the exact thing VOID promises never
-- happens.
create or replace function public.sv_bill_unmark(p_secret text, p_invoice_id text)
returns integer language plpgsql security definer set search_path to 'public','private' as $$
declare n integer;
begin
  perform private.require(p_secret);
  if p_invoice_id is null or p_invoice_id = '' then raise exception 'sv_bill_unmark needs an invoice id'; end if;
  update public.billing_events
     set state = 'open', stripe_invoice_id = null, stripe_invoice_item_id = null
   where stripe_invoice_id = p_invoice_id and state = 'invoiced';
  get diagnostics n = row_count;
  return n;
end $$;;
