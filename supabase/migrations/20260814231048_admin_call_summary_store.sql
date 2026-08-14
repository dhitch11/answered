-- 20260814231048_admin_call_summary_store
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- Store a call summary produced by a model, together with WHICH model produced it and what it cost.
--
-- The model attribution is not decoration. A summary in a database with no provenance is a claim
-- with no author: six months from now nobody can tell whether an operator wrote it, a flagship model
-- wrote it, or a cheap fallback wrote it after the primary 400'd. This estate has already had a
-- live phone line silently running on backup models for exactly that reason, invisible because the
-- output looked fine.
--
-- ai_notes carries the structured result verbatim, so the prose summary can always be checked
-- against the fields it was derived from.
create or replace function public.sv_admin_call_summary(p_secret text, p_call_sid text, p_row jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_id uuid;
begin
  perform private.require(p_secret);

  update public.calls
     set summary   = nullif(p_row->>'summary',''),
         sentiment = nullif(p_row->>'sentiment',''),
         ai_notes  = p_row - 'summary' - 'sentiment'
   where call_sid = p_call_sid
   returning id into v_id;

  -- An UPDATE that matched nothing must say so. A silent zero-row update reads to the caller as
  -- success and is how a console ends up displaying a summary that was never stored.
  if v_id is null then
    return jsonb_build_object('ok', false, 'reason', 'no call has that sid');
  end if;

  insert into public.crm_activity (contact_id, account_id, kind, title, body, payload, source, actor,
                                   ref_kind, ref_id)
  select c.contact_id, c.account_id, 'call',
         'Call summarised by ' || coalesce(p_row->>'model','an unnamed model'),
         left(coalesce(p_row->>'summary',''), 2000),
         p_row, 'admin-console', nullif(p_row->>'actor',''), 'call', p_call_sid
    from public.calls c where c.id = v_id;

  return jsonb_build_object('ok', true, 'call_id', v_id);
end;
$function$;

revoke all on function public.sv_admin_call_summary(text, text, jsonb) from public;
revoke all on function public.sv_admin_call_summary(text, text, jsonb) from authenticated;
grant execute on function public.sv_admin_call_summary(text, text, jsonb) to anon;;
