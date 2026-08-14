-- 20260814191032_dial_context_carries_the_dnc_answer
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- A fresh registry snapshot is worth nothing unless the gate consults it for THIS number. The dial
-- context now carries the answer, and it is a THREE-STATE answer on purpose:
--   true  → listed, refuse
--   false → checked against a fresh snapshot and not listed
--   null  → could not answer (no snapshot, or the snapshot is stale)
-- null must never read as "not listed". The gate treats it as a refusal, same as every other
-- unanswerable question in this system.
create or replace function public.sv_dial_context(p_secret text, p_phone text)
returns jsonb language plpgsql stable security definer set search_path = public, private as $$
declare v jsonb; fresh uuid;
begin
  perform private.require(p_secret);

  select id into fresh from public.dnc_snapshots
   where notes = 'complete' and downloaded_at > now() - interval '31 days'
   order by downloaded_at desc limit 1;

  select jsonb_build_object(
    'phone', p_phone,
    'suppressed', exists (select 1 from public.suppression s where s.phone = p_phone)
                  or exists (select 1 from public.contacts c where c.phone = p_phone and c.suppressed),
    'dnc_listed', case when fresh is null then null
                       else exists (select 1 from public.dnc_registry r
                                     where r.phone = p_phone and r.snapshot_id = fresh) end,
    'dnc_snapshot_fresh', fresh is not null,
    'contact', (select to_jsonb(c) from public.contacts c where c.phone = p_phone),
    'calls_30d', (
      select count(*) from public.calls k
       where k.to_number = p_phone and k.placed
         and k.created_at > now() - interval '30 days'
    ),
    'consent', (
      select to_jsonb(x) from public.consent x
       where x.phone = p_phone and x.scope = 'research_call'
         and (x.expires_at is null or x.expires_at > now())
       order by x.granted_at desc limit 1
    )
  ) into v;
  return v;
end $$;

revoke all on function public.sv_dial_context(text, text) from public;
grant execute on function public.sv_dial_context(text, text) to anon, authenticated;;
