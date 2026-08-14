-- 20260814184112_record_call_carries_class
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- `lib/dial.mjs` now computes call_class at dial time, but sv_record_call never read it, so it
-- would have been dropped silently on the way in and every row would have read `unclassified`
-- while the code that computed it looked perfectly correct. Same shape as the answered_by bug:
-- a value produced in one place and never received in the other.
create or replace function public.sv_record_call(p_secret text, p_row jsonb)
returns uuid language plpgsql security definer set search_path = public, private as $$
declare v_id uuid;
begin
  perform private.require(p_secret);
  insert into public.calls (
    call_sid, conference_name, contact_id, campaign_id, line_id, direction,
    from_number, to_number, status, gate, operator, placed, refused_reason, call_class, queued_at
  ) values (
    nullif(p_row->>'call_sid',''), p_row->>'conference_name',
    (p_row->>'contact_id')::uuid, (p_row->>'campaign_id')::uuid, (p_row->>'line_id')::uuid,
    coalesce(p_row->>'direction','outbound'),
    p_row->>'from_number', p_row->>'to_number', p_row->>'status',
    p_row->'gate', p_row->>'operator',
    coalesce((p_row->>'placed')::boolean,false), p_row->>'refused_reason',
    p_row->>'call_class', now()
  )
  on conflict (call_sid) do update set
    status = excluded.status,
    call_class = coalesce(public.calls.call_class, excluded.call_class)
  returning id into v_id;

  if (p_row->>'contact_id') is not null and coalesce((p_row->>'placed')::boolean,false) then
    update public.contacts
       set call_count = call_count + 1,
           last_contacted_at = now(),
           first_contacted_at = coalesce(first_contacted_at, now()),
           disposition = case when disposition = 'new' then 'attempted' else disposition end
     where id = (p_row->>'contact_id')::uuid;
  end if;
  return v_id;
end $$;

revoke all on function public.sv_record_call(text, jsonb) from public;
grant execute on function public.sv_record_call(text, jsonb) to anon, authenticated;;
