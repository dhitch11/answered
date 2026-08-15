-- 20260815002456_admin_read_owner_notes_clipped
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- Read side for owner_notes_clipped, which answered-brain writes when an owner's instruction block
-- was too long to send whole. The write side is the voice lane's; this is the console's read.
--
-- Keyed by line_number because that is what the call knows. Joined to the account here so the
-- console can name the business rather than a phone number, and LEFT joined on purpose: a clipped
-- row whose line is not attached to any account is still a real event and must not disappear
-- because the join failed. An orphan is invisible to a query that walks the parent.
create or replace function public.sv_admin_notes_clipped(p_secret text, p_line text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v jsonb;
begin
  perform private.require(p_secret);
  select coalesce(jsonb_agg(to_jsonb(x) order by x.last_seen desc), '[]'::jsonb) into v
  from (
    select c.line_number, c.chars_sent, c.chars_kept, c.chars_dropped, c.times_seen, c.last_seen,
           a.id as account_id, a.business_name
      from public.owner_notes_clipped c
      left join public.account_numbers n on n.phone = c.line_number
      left join public.accounts a on a.id = n.account_id
     where p_line is null or c.line_number = p_line
  ) x;
  return jsonb_build_object('ok', true, 'rows', v, 'total', jsonb_array_length(v));
end $function$;

revoke all on function public.sv_admin_notes_clipped(text, text) from public;
revoke all on function public.sv_admin_notes_clipped(text, text) from authenticated;
grant execute on function public.sv_admin_notes_clipped(text, text) to anon;;
