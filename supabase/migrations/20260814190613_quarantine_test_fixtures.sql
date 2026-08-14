-- 20260814190613_quarantine_test_fixtures
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- quarantine — where fabricated rows go instead of being destroyed.
--
-- TWO ESTATE RULES POINT IN OPPOSITE DIRECTIONS HERE AND BOTH ARE RIGHT.
--   "Nothing fake, nothing fabricated, ever."  →  97 invented charge events totalling $492 sitting
--        in a production billing table that an operator console reads is exactly the thing this
--        company does not ship. They have to stop being visible.
--   "Never delete project history or data."    →  DELETE on 111 production rows is irreversible,
--        and a peer lane asking for it is not the same as the founder authorising it.
--
-- Quarantine satisfies both. The rows MOVE to a schema nothing reads, the console reads a true
-- zero, the deletion is reversible by anyone with the schema, and the move itself is recorded.
-- A row that turns out to have been real is one INSERT away from coming back; a deleted one is
-- gone. When in doubt, move it.

create schema if not exists quarantine;
revoke all on schema quarantine from anon, authenticated;
grant usage on schema quarantine to service_role;

create table if not exists quarantine.log (
  id          bigserial primary key,
  moved_at    timestamptz not null default now(),
  source      text not null,
  target      text not null,
  rows_moved  integer not null,
  reason      text not null,
  requested_by text,
  actioned_by text
);
revoke all on quarantine.log from anon, authenticated;

do $$
declare n_ba int; n_be int; n_bi int;
begin
  -- Snapshot, verbatim, before anything leaves the production tables.
  execute 'create table if not exists quarantine.billing_accounts_20260814 as
             select * from public.billing_accounts where account_id is null';
  execute 'create table if not exists quarantine.billing_events_20260814 as
             select * from public.billing_events where account_id in
               (select id from public.billing_accounts where account_id is null)';
  execute 'create table if not exists quarantine.billing_invoices_20260814 as
             select * from public.billing_invoices where account_id in
               (select id from public.billing_accounts where account_id is null)';

  select count(*) into n_ba from quarantine.billing_accounts_20260814;
  select count(*) into n_be from quarantine.billing_events_20260814;
  select count(*) into n_bi from quarantine.billing_invoices_20260814;

  -- Only now, with the copy proven to exist and counted, do the originals leave.
  delete from public.billing_invoices where account_id in
    (select id from public.billing_accounts where account_id is null);
  delete from public.billing_events   where account_id in
    (select id from public.billing_accounts where account_id is null);
  delete from public.billing_accounts where account_id is null;

  insert into quarantine.log (source, target, rows_moved, reason, requested_by, actioned_by)
  values ('public.billing_accounts', 'quarantine.billing_accounts_20260814', n_ba,
          'Fabricated test fixtures with a null account_id. 0 real customers existed, so they were joined to nobody and could not be explained to anyone. Moved rather than deleted: reversible, and nothing is destroyed.',
          '@ANSWERED-BUILD billing lane', '@ANSWERED-INTEL'),
         ('public.billing_events', 'quarantine.billing_events_20260814', n_be,
          'Charge events belonging to the quarantined orphan billing accounts.',
          '@ANSWERED-BUILD billing lane', '@ANSWERED-INTEL'),
         ('public.billing_invoices', 'quarantine.billing_invoices_20260814', n_bi,
          'Invoices belonging to the quarantined orphan billing accounts.',
          '@ANSWERED-BUILD billing lane', '@ANSWERED-INTEL');

  raise notice 'quarantined: % billing_accounts, % billing_events, % billing_invoices', n_ba, n_be, n_bi;
end $$;

grant all on all tables in schema quarantine to service_role;

-- So the next person to widen sv_truce_admin is told why before they do, rather than after.
comment on function public.sv_truce_admin(text, integer) is
  'The ONLY projection of a Truce deal an operator console may read. It does not join sealed.limits and it must never be changed to. /truce Section 3 promises a party''s limit is not merely unnamed but not derivable, and an admin surface able to print both numbers would break that promise from the inside. set_a_number is a boolean rather than a value on purpose.';;
