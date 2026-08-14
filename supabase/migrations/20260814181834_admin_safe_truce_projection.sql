-- 20260814181834_admin_safe_truce_projection
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- For @ANSWERED-INTEL's /admin console.
--
-- An operator needs to run the business: which deals are open, which settled, what to bill, what to
-- refund. An operator does NOT need either party's sealed limit, and /truce Section 3 sells the
-- promise that nobody sees it. An admin console that could print both numbers would quietly make
-- that page a lie, and the person reading the console would never know they were the exception.
--
-- So the admin projection is built to be incapable of it rather than trusted not to do it. It
-- selects from truce_deals/parties/signatures and never joins sealed.limits at all. There is no
-- flag, no elevated role and no query string that turns the limits on.

create or replace function public.sv_truce_admin(p_secret text, p_limit int default 100)
returns jsonb language plpgsql stable security definer set search_path = public, private as $$
declare v jsonb;
begin
  perform private.require(p_secret);
  select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc), '[]'::jsonb) into v from (
    select d.id, d.subject, d.kind, d.status,
           d.settled_value, d.fee_cents, d.created_at, d.settled_at, d.expires_at,
           -- how far along, without any number either side sealed
           (select count(*) from public.truce_parties p where p.deal_id = d.id and p.limit_set_at is not null) as sides_ready,
           (select count(*) from public.truce_signatures g where g.deal_id = d.id) as signatures,
           (select count(*) from public.truce_messages m where m.deal_id = d.id) as messages,
           (select jsonb_agg(jsonb_build_object('side', p.side, 'role', p.role, 'name', p.display_name,
                    'joined', p.joined_at is not null, 'set_a_number', p.limit_set_at is not null,
                    'signed_at', p.signed_at) order by p.side)
              from public.truce_parties p where p.deal_id = d.id) as parties,
           -- billable only when BOTH sides signed a settled deal. "You pay only if you both sign it."
           (d.status = 'settled'
            and (select count(*) from public.truce_signatures g where g.deal_id = d.id) = 2) as billable
      from public.truce_deals d
     order by d.created_at desc
     limit least(coalesce(p_limit,100), 500)
  ) s;
  return v;
end $$;

revoke all on function public.sv_truce_admin(text,int) from public;
grant execute on function public.sv_truce_admin(text,int) to anon, authenticated;

comment on function public.sv_truce_admin(text,int) is
  'Admin projection for Truce. Deliberately never joins sealed.limits. If a future edit adds a limit '
  'to this function it breaks the promise /truce Section 3 is built on, and the test in '
  'research/truce.test.mjs will fail.';;
