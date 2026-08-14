-- 20260814203414_schema_dump_rpcs
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- SCHEMA EXPORT. The whole database definition, readable from outside it.
--
-- ★ WHY THIS EXISTS. Every table, every function body, every policy and every grant in this
-- system lived in exactly one place: a hosted Postgres created yesterday. `git ls-files '*.sql'`
-- returned a single unrelated file against 50+ applied migrations. The RPC bodies ARE the security
-- model — `private.require`, the sealed-limit projection, the refund guards — and none of it was
-- recoverable from the repository. A restore would have depended entirely on the vendor's own
-- migration table surviving, which is a backup strategy only in the sense that a coin toss is a
-- decision procedure.
--
-- TWO EXPORTS, DELIBERATELY, BECAUSE THEY ANSWER DIFFERENT QUESTIONS:
--   sv_admin_migrations       the exact statements that were applied, in order. The history.
--   sv_admin_schema_snapshot  what is actually in the database RIGHT NOW. The truth.
-- They diverge the moment anyone runs SQL outside a migration, which is exactly when you need to
-- know. Dumping only the history would have recorded our intentions; dumping only the snapshot
-- would have lost how we got here.
--
-- ★ STRUCTURE ONLY. NO ROW DATA, EVER. Nothing here selects from a business table, so a schema
-- export can never become a customer data export by accident. `private.app_secret` holds a hash
-- and is excluded from the body dump for the same reason.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

create or replace function public.sv_admin_migrations(p_secret text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  perform private.require(p_secret);
  select coalesce(jsonb_agg(jsonb_build_object(
           'version', m.version, 'name', m.name, 'statements', to_jsonb(m.statements)
         ) order by m.version), '[]'::jsonb)
    into v
    from supabase_migrations.schema_migrations m;
  return v;
end $$;

create or replace function public.sv_admin_schema_snapshot(p_secret text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  perform private.require(p_secret);

  select jsonb_build_object(
    'taken_at', now(),
    'postgres', current_setting('server_version'),

    'schemas', (select coalesce(jsonb_agg(nspname order by nspname), '[]'::jsonb)
                  from pg_namespace
                 where nspname not like 'pg_%' and nspname <> 'information_schema'),

    'tables', (select coalesce(jsonb_agg(t order by t->>'schema', t->>'name'), '[]'::jsonb) from (
        select jsonb_build_object(
          'schema', c.table_schema, 'name', c.table_name,
          'rls', (select relrowsecurity from pg_class pc
                    join pg_namespace pn on pn.oid = pc.relnamespace
                   where pn.nspname = c.table_schema and pc.relname = c.table_name),
          'comment', obj_description(format('%I.%I', c.table_schema, c.table_name)::regclass, 'pg_class'),
          'columns', (select jsonb_agg(jsonb_build_object(
                        'name', k.column_name, 'type', k.data_type,
                        'nullable', (k.is_nullable = 'YES'), 'default', k.column_default,
                        'comment', col_description(format('%I.%I', k.table_schema, k.table_name)::regclass,
                                                   k.ordinal_position))
                        order by k.ordinal_position)
                      from information_schema.columns k
                     where k.table_schema = c.table_schema and k.table_name = c.table_name)
        ) as t
        from information_schema.tables c
       where c.table_schema in ('public','sealed','private','quarantine')
         and c.table_type = 'BASE TABLE') s),

    'views', (select coalesce(jsonb_agg(jsonb_build_object(
                'schema', schemaname, 'name', viewname, 'definition', definition)
                order by schemaname, viewname), '[]'::jsonb)
                from pg_views where schemaname in ('public','sealed','private')),

    'functions', (select coalesce(jsonb_agg(jsonb_build_object(
                    'schema', n.nspname, 'name', p.proname,
                    'args', pg_get_function_identity_arguments(p.oid),
                    'returns', pg_get_function_result(p.oid),
                    'security_definer', p.prosecdef,
                    'config', to_jsonb(p.proconfig),
                    'acl', to_jsonb(p.proacl::text[]),
                    'comment', obj_description(p.oid, 'pg_proc'),
                    'definition', pg_get_functiondef(p.oid))
                    order by n.nspname, p.proname), '[]'::jsonb)
                    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname in ('public','sealed','private')
                     and p.prokind = 'f'),

    'indexes', (select coalesce(jsonb_agg(jsonb_build_object(
                  'schema', schemaname, 'table', tablename, 'name', indexname, 'definition', indexdef)
                  order by schemaname, tablename, indexname), '[]'::jsonb)
                  from pg_indexes where schemaname in ('public','sealed','private','quarantine')),

    'constraints', (select coalesce(jsonb_agg(jsonb_build_object(
                      'schema', n.nspname, 'table', rel.relname, 'name', con.conname,
                      'type', con.contype, 'definition', pg_get_constraintdef(con.oid))
                      order by n.nspname, rel.relname, con.conname), '[]'::jsonb)
                      from pg_constraint con
                      join pg_class rel on rel.oid = con.conrelid
                      join pg_namespace n on n.oid = rel.relnamespace
                     where n.nspname in ('public','sealed','private')),

    'triggers', (select coalesce(jsonb_agg(jsonb_build_object(
                   'schema', n.nspname, 'table', c.relname, 'name', t.tgname,
                   'definition', pg_get_triggerdef(t.oid))
                   order by n.nspname, c.relname, t.tgname), '[]'::jsonb)
                   from pg_trigger t
                   join pg_class c on c.oid = t.tgrelid
                   join pg_namespace n on n.oid = c.relnamespace
                  where not t.tgisinternal and n.nspname in ('public','sealed','private')),

    'policies', (select coalesce(jsonb_agg(jsonb_build_object(
                   'schema', schemaname, 'table', tablename, 'name', policyname,
                   'command', cmd, 'roles', to_jsonb(roles),
                   'using', qual, 'check', with_check)
                   order by schemaname, tablename, policyname), '[]'::jsonb)
                   from pg_policies where schemaname in ('public','sealed','private')),

    -- The grants are part of the security model and were the subject of a real defect, so they
    -- are exported rather than assumed to be defaults.
    'grants', (select coalesce(jsonb_agg(jsonb_build_object(
                 'schema', table_schema, 'table', table_name, 'grantee', grantee,
                 'privileges', privs) order by table_schema, table_name, grantee), '[]'::jsonb)
                 from (select table_schema, table_name, grantee,
                              string_agg(distinct privilege_type, ',' order by privilege_type) as privs
                         from information_schema.role_table_grants
                        where table_schema in ('public','sealed','private','quarantine')
                          and grantee in ('anon','authenticated','service_role','PUBLIC')
                        group by 1,2,3) g),

    'sequences', (select coalesce(jsonb_agg(jsonb_build_object(
                    'schema', sequence_schema, 'name', sequence_name) order by sequence_name), '[]'::jsonb)
                    from information_schema.sequences
                   where sequence_schema in ('public','sealed','private')),

    'extensions', (select coalesce(jsonb_agg(jsonb_build_object(
                     'name', extname, 'version', extversion) order by extname), '[]'::jsonb)
                     from pg_extension)
  ) into v;

  return v;
end $$;

comment on function public.sv_admin_schema_snapshot(text) is
  'Structure only, never row data. Exports what is actually in the database now, as distinct from sv_admin_migrations which exports what was applied. They diverge the moment anyone runs SQL outside a migration, which is exactly when you need to know.';;
