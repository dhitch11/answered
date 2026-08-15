-- 20260814234047_split_legacy_concatenated_suppression_reasons
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- Fixing the writer does nothing for rows already written. Every suppression row created before
-- the split still carries "do-not-call request: <a stranger's speech>" in `reason`, which is the
-- field the console renders as OUR determination. Backfill splits them into the two columns so the
-- history matches the contract, rather than leaving a class of rows that quietly still blend.
--
-- Only rows matching the exact prefix the old writer produced are touched, and the operation is
-- idempotent: a row already split has no prefix to strip.
update public.suppression
   set heard_as = coalesce(heard_as, substring(reason from length('do-not-call request: ') + 1)),
       reason   = 'do-not-call request'
 where reason like 'do-not-call request: %';

-- Remove the hostile probe I inserted while verifying the fix. Test data in a production table is
-- the thing this estate has been bitten by twice, and writing a card about it does not exempt me.
delete from public.suppression where phone = '+15005550593';
delete from public.dnc_requests  where phone = '+15005550593';;
