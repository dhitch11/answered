-- 20260814195904_crm_intake_immutability_is_about_the_payload
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- The first version of this trigger refused every UPDATE, including the one sv_crm_capture makes
-- against its own row a few statements later to record which contact the payload resolved to.
-- Every capture failed with P0001 "crm_intake_raw is append only". Caught immediately because the
-- test asserted on the returned contact_id rather than on the 200.
--
-- ★ THE LESSON IS ABOUT WHAT IMMUTABILITY IS FOR. The thing that must never change is the
-- EVIDENCE: the payload as it arrived, its source, and when. The LINKAGE — which contact it
-- resolved to, what it matched on, whether it created a record — is a conclusion drawn afterwards
-- and is exactly the kind of thing that gets filled in later, or corrected when a merge happens.
-- Freezing the conclusion alongside the evidence protected nothing and broke the writer.
--
-- So: payload, source, external_id and at are immutable and any attempt to change them raises.
-- The link columns may be written. DELETE is still refused outright.

create or replace function public.crm_intake_append_only()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'crm_intake_raw is append only: DELETE is not permitted';
  end if;

  if new.payload     is distinct from old.payload
     or new.source      is distinct from old.source
     or new.external_id is distinct from old.external_id
     or new.at          is distinct from old.at then
    raise exception
      'crm_intake_raw: payload, source, external_id and at are immutable. Only the resolution columns (contact_id, account_id, matched_on, created, note) may be written.';
  end if;

  return new;
end $$;

drop trigger if exists crm_intake_no_mutate on public.crm_intake_raw;
create trigger crm_intake_no_mutate
  before update or delete on public.crm_intake_raw
  for each row execute function public.crm_intake_append_only();

comment on function public.crm_intake_append_only() is
  'Protects the evidence, not the conclusion. The payload as it arrived is immutable; which contact it resolved to may be written and rewritten, because that is a judgement that can be corrected by a later merge.';;
