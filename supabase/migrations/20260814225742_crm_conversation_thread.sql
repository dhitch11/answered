-- 20260814225742_crm_conversation_thread
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- A conversation is not a timeline. The timeline answers "what has happened to this business",
-- mixing notes, tasks, field edits and calls. A THREAD answers a different question: "what have we
-- actually said to each other, and what did they say back". An operator about to send a text needs
-- the second one, and today the console can only render the first.
--
-- This reads crm_messages directly, both directions, newest LAST so it reads like a conversation
-- rather than a log. Blocked and failed sends are included on purpose: a message we were not allowed
-- to send is part of the history of this relationship, and hiding it would make the thread lie by
-- omission about why nothing was heard back.
create or replace function public.sv_crm_thread(p_secret text, p_contact_id uuid, p_limit int default 200)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rows jsonb;
  v_total int;
  v_counts jsonb;
begin
  perform private.require(p_secret);

  select count(*) into v_total from public.crm_messages where contact_id = p_contact_id;

  -- Per-channel, per-direction and per-status counts, so the header can state what is in the thread
  -- without the client re-deriving it from a windowed list. A count computed from a page of 200 is
  -- a different number from the truth and would silently disagree with itself on the 201st message.
  select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) into v_counts from (
    select channel || '_' || direction as k, count(*) as n
      from public.crm_messages where contact_id = p_contact_id
     group by 1
    union all
    select 'status_' || status, count(*)
      from public.crm_messages where contact_id = p_contact_id
     group by 1
  ) s;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at asc), '[]'::jsonb) into v_rows
    from (
      select id, channel, direction, to_addr, from_addr, subject, body, status, failure_reason,
             provider, provider_id, ai_assisted, ai_model, sent_by, sent_at, created_at, meta
        from public.crm_messages
       where contact_id = p_contact_id
       order by created_at desc
       limit greatest(1, least(coalesce(p_limit, 200), 500))
    ) t;

  return jsonb_build_object(
    'ok', true,
    'contact_id', p_contact_id,
    'total', v_total,
    'returned', jsonb_array_length(v_rows),
    -- The client must never infer "this is everything" from a full page. Say it explicitly.
    'truncated', v_total > jsonb_array_length(v_rows),
    'counts', v_counts,
    'messages', v_rows
  );
end;
$function$;

-- Postgres grants EXECUTE to PUBLIC on every new function by default, which is how 94 definer
-- functions on this database ended up anon-executable. Strip the default, then grant back only the
-- one role the function runtime actually authenticates as.
revoke all on function public.sv_crm_thread(text, uuid, int) from public;
revoke all on function public.sv_crm_thread(text, uuid, int) from authenticated;
grant execute on function public.sv_crm_thread(text, uuid, int) to anon;;
