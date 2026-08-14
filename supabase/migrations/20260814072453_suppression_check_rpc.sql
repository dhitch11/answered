-- 20260814072453_suppression_check_rpc
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- The gate needs to ask "is this number suppressed" on the dial path itself.
-- Without this the console loaded an EMPTY suppression set into the gate, so the one check that
-- must never be skippable was decorative on every manual dial. The DB knew; the gate did not ask.

create or replace function public.sv_dial_context(p_secret text, p_phone text)
returns jsonb language plpgsql stable security definer set search_path = public, private as $$
declare v jsonb;
begin
  perform private.require(p_secret);
  select jsonb_build_object(
    'phone', p_phone,
    'suppressed', exists (select 1 from public.suppression s where s.phone = p_phone)
                  or exists (select 1 from public.contacts c where c.phone = p_phone and c.suppressed),
    'contact', (select to_jsonb(c) from public.contacts c where c.phone = p_phone),
    'calls_30d', (
      select count(*) from public.calls k
       where k.to_number = p_phone and k.placed
         and k.created_at > now() - interval '30 days'
    ),
    'consent', (
      select to_jsonb(x) from public.consent x
       where x.phone = p_phone
         and x.scope = 'research_call'
         and (x.expires_at is null or x.expires_at > now())
       order by x.granted_at desc limit 1
    )
  ) into v;
  return v;
end $$;

revoke all on function public.sv_dial_context(text, text) from public;
grant execute on function public.sv_dial_context(text, text) to anon, authenticated;;
