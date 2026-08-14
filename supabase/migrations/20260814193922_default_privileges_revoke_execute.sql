-- 20260814193922_default_privileges_revoke_execute
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- Stop the hole from growing while the three lanes agree how to close the existing one.
--
-- ★ IN POSTGRES, A FUNCTION IS BORN `PUBLIC EXECUTE`. That is the opposite default from tables,
-- and it is why revoking `anon` on every TABLE in this database — which was done, and verified —
-- closed the wrong door. Every read and write here goes through SECURITY DEFINER RPCs, so the
-- function ACL *is* the perimeter, and it was wide open on 94 functions.
--
-- MEASURED, this run, with the publishable key alone and no secret:
--   POST /rest/v1/rpc/bl_void        -> HTTP 200. Security definer, no secret guard, sets
--                                       billing_events.state='voided'. Anonymous, unthrottled,
--                                       money-mutating, and it writes no admin_audit row.
--   bl_statement, tr_view, tr_leak_check, tr_sign, tr_terms, tr_set_limit -> all HTTP 200.
--   sv_admin_overview                -> 403 28000 unauthorized (private.require holds), but an
--                                       attacker may still hammer p_secret through PostgREST with
--                                       no rate limit, no lockout and no 600ms sleep.
--
-- THIS MIGRATION DELIBERATELY REVOKES NOTHING THAT EXISTS. Every sv_* call in this codebase runs
-- through lib/db.mjs, which authenticates to PostgREST as `anon` and passes the secret in the
-- body. A blanket REVOKE EXECUTE would therefore take the entire platform down, including two
-- other lanes' live products, and doing that unannounced is precisely the clobber the coordination
-- rules exist to prevent. The real fix is to move lib/db.mjs onto the service role first; that is
-- one line, it is another lane's file, and it is being coordinated.
--
-- What this DOES do is close the generator: any function created from now on is not automatically
-- executable by anon. The set of holes stops growing at 94 while we agree how to drain it.

alter default privileges in schema public
  revoke execute on functions from anon, authenticated;

alter default privileges in schema public
  revoke all on tables from anon, authenticated;

alter default privileges in schema public
  revoke all on sequences from anon, authenticated;

-- The same for the sealed schema, which today holds no grant to any role and must stay that way
-- even if someone later adds a function to it.
alter default privileges in schema sealed
  revoke execute on functions from anon, authenticated;
alter default privileges in schema sealed
  revoke all on tables from anon, authenticated;

-- consent_sources was created after the estate-wide table revoke ran, so it inherited the old
-- default and still carried anon SELECT/INSERT/UPDATE/DELETE/TRUNCATE. It holds 0 rows, so nothing
-- has leaked, and RLS is denying it — but that made RLS a single control on it, which is the exact
-- condition the earlier revoke removed everywhere else.
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('revoke all on public.%I from anon, authenticated', t.tablename);
  end loop;
end $$;;
