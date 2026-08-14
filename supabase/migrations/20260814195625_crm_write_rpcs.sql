-- 20260814195625_crm_write_rpcs
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- CRM writes. Every one is a single statement so it cannot half-apply, and every one returns a
-- MEASURED count of what it actually changed rather than reporting success.

create or replace function public.sv_admin_contact_update(
  p_secret text, p_id uuid, p_patch jsonb, p_actor text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.contacts%rowtype;
begin
  perform private.require(p_secret);

  -- An operator may set exactly these. Everything else on the row is measured from a source
  -- (line_type from a carrier lookup, lane from the gate) and must not be typed over by hand:
  -- a hand-edited lane would be a compliance decision made in a text box.
  update public.contacts set
    disposition = coalesce(nullif(p_patch->>'disposition',''), disposition),
    owner       = case when p_patch ? 'owner' then nullif(p_patch->>'owner','') else owner end,
    score       = case when p_patch ? 'score' then (p_patch->>'score')::int else score end,
    tags        = case when p_patch ? 'tags'
                       then coalesce((select array_agg(t) from jsonb_array_elements_text(p_patch->'tags') t), '{}')
                       else tags end,
    contact_name= case when p_patch ? 'contact_name' then nullif(p_patch->>'contact_name','') else contact_name end,
    contact_role= case when p_patch ? 'contact_role' then nullif(p_patch->>'contact_role','') else contact_role end,
    email       = case when p_patch ? 'email' then nullif(p_patch->>'email','') else email end,
    updated_at  = now()
  where id = p_id
  returning * into c;

  if not found then return jsonb_build_object('ok', false, 'error', 'no such contact'); end if;
  return jsonb_build_object('ok', true, 'contact', to_jsonb(c));
end $$;

-- Bulk. ONE statement over the SAME filter the operator was looking at, so "select all matching"
-- means the filter, not a list of ids the client happened to have on screen. Returns the real
-- number of rows changed; a caller that assumes its own selection count is how a bulk action
-- silently half-applies.
create or replace function public.sv_admin_contacts_bulk(
  p_secret text, p_ids uuid[], p_action text, p_value text, p_actor text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare n integer := 0;
begin
  perform private.require(p_secret);
  if p_ids is null or array_length(p_ids, 1) is null then
    return jsonb_build_object('ok', false, 'error', 'nothing was selected');
  end if;
  if array_length(p_ids, 1) > 5000 then
    return jsonb_build_object('ok', false, 'error',
      'that is more than 5,000 rows in one action. Narrow the filter or do it in passes, so a mistake is recoverable.');
  end if;

  if p_action = 'disposition' then
    update public.contacts set disposition = p_value, updated_at = now()
     where id = any(p_ids) and disposition is distinct from p_value;
    get diagnostics n = row_count;

  elsif p_action = 'owner' then
    update public.contacts set owner = nullif(p_value,''), updated_at = now()
     where id = any(p_ids) and owner is distinct from nullif(p_value,'');
    get diagnostics n = row_count;

  elsif p_action = 'tag_add' then
    update public.contacts set tags = array(select distinct unnest(tags || array[p_value])), updated_at = now()
     where id = any(p_ids) and not (tags @> array[p_value]);
    get diagnostics n = row_count;

  elsif p_action = 'tag_remove' then
    update public.contacts set tags = array_remove(tags, p_value), updated_at = now()
     where id = any(p_ids) and tags @> array[p_value];
    get diagnostics n = row_count;

  elsif p_action = 'suppress' then
    -- Suppression is a compliance act, so it writes the durable suppression ledger too, not just
    -- a flag on the row. The ledger is what the dial gate reads.
    update public.contacts set suppressed = true, suppressed_reason = coalesce(nullif(p_value,''),'operator'),
           suppressed_at = now(), disposition = 'do_not_call', updated_at = now()
     where id = any(p_ids) and not suppressed;
    get diagnostics n = row_count;
    insert into public.suppression (phone, reason, source)
      select c.phone, coalesce(nullif(p_value,''),'operator'), 'admin console'
        from public.contacts c where c.id = any(p_ids)
      on conflict (phone) do nothing;

  else
    return jsonb_build_object('ok', false, 'error', 'unknown bulk action: ' || coalesce(p_action,'(none)'));
  end if;

  return jsonb_build_object('ok', true, 'action', p_action, 'value', p_value,
    'selected', array_length(p_ids, 1), 'changed', n,
    'unchanged', array_length(p_ids, 1) - n,
    'note', case when n < array_length(p_ids,1)
                 then 'Rows that already had this value were left alone and are counted as unchanged.'
                 else null end);
end $$;

-- ── notes ────────────────────────────────────────────────────────────────────────────────────
create or replace function public.sv_admin_note_add(
  p_secret text, p_contact_id uuid, p_call_sid text, p_body text, p_author text, p_pinned boolean
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.notes%rowtype;
begin
  perform private.require(p_secret);
  if coalesce(trim(p_body),'') = '' then
    return jsonb_build_object('ok', false, 'error', 'an empty note helps nobody');
  end if;
  insert into public.notes (contact_id, call_sid, body, author, pinned)
  values (p_contact_id, nullif(p_call_sid,''), trim(p_body), coalesce(p_author,'operator'), coalesce(p_pinned,false))
  returning * into r;
  return jsonb_build_object('ok', true, 'note', to_jsonb(r));
end $$;

create or replace function public.sv_admin_note_pin(p_secret text, p_id uuid, p_pinned boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.notes%rowtype;
begin
  perform private.require(p_secret);
  update public.notes set pinned = coalesce(p_pinned,false) where id = p_id returning * into r;
  if not found then return jsonb_build_object('ok', false, 'error', 'no such note'); end if;
  return jsonb_build_object('ok', true, 'note', to_jsonb(r));
end $$;

-- ── tasks ────────────────────────────────────────────────────────────────────────────────────
create or replace function public.sv_admin_task_add(
  p_secret text, p_row jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.crm_tasks%rowtype;
begin
  perform private.require(p_secret);
  if coalesce(trim(p_row->>'title'),'') = '' then
    return jsonb_build_object('ok', false, 'error', 'a task needs a title');
  end if;
  insert into public.crm_tasks (contact_id, account_id, title, body, due_at, priority, assignee, created_by)
  values (nullif(p_row->>'contact_id','')::uuid, nullif(p_row->>'account_id','')::uuid,
          trim(p_row->>'title'), nullif(p_row->>'body',''),
          case when (p_row->>'due_at') is not null then (p_row->>'due_at')::timestamptz end,
          coalesce(nullif(p_row->>'priority',''),'normal'), nullif(p_row->>'assignee',''),
          nullif(p_row->>'created_by',''))
  returning * into r;
  return jsonb_build_object('ok', true, 'task', to_jsonb(r));
end $$;

create or replace function public.sv_admin_task_set(
  p_secret text, p_id uuid, p_status text, p_actor text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.crm_tasks%rowtype;
begin
  perform private.require(p_secret);
  if p_status not in ('open','done','cancelled') then
    return jsonb_build_object('ok', false, 'error', 'unknown task status');
  end if;
  update public.crm_tasks
     set status = p_status,
         done_at = case when p_status = 'done' then now() else null end,
         done_by = case when p_status = 'done' then p_actor else null end
   where id = p_id returning * into r;
  if not found then return jsonb_build_object('ok', false, 'error', 'no such task'); end if;
  return jsonb_build_object('ok', true, 'task', to_jsonb(r));
end $$;

create or replace function public.sv_admin_tasks(
  p_secret text, p_status text, p_assignee text, p_limit integer
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  perform private.require(p_secret);
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v from (
    select t.id, t.title, t.body, t.due_at, t.status, t.priority, t.assignee, t.created_by,
           t.created_at, t.done_at, t.contact_id, t.account_id,
           c.name as contact_name, c.phone as contact_phone,
           a.business_name as account_name,
           (t.status = 'open' and t.due_at is not null and t.due_at < now()) as overdue
      from public.crm_tasks t
      left join public.contacts c on c.id = t.contact_id
      left join public.accounts a on a.id = t.account_id
     where (p_status is null or t.status = p_status)
       and (p_assignee is null or t.assignee = p_assignee)
     order by (t.status = 'open') desc, t.due_at asc nulls last, t.created_at desc
     limit greatest(1, least(coalesce(p_limit, 200), 500))
  ) x;
  return v;
end $$;

-- ── saved views ──────────────────────────────────────────────────────────────────────────────
create or replace function public.sv_admin_views(p_secret text, p_owner uuid, p_scope text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  perform private.require(p_secret);
  select coalesce(jsonb_agg(to_jsonb(x) order by x.sort_order, x.created_at), '[]'::jsonb) into v from (
    select id, scope, name, filters, shared, sort_order, created_at, used_at,
           (owner_id = p_owner) as mine
      from public.saved_views
     where (p_scope is null or scope = p_scope)
       and (owner_id = p_owner or shared)
  ) x;
  return v;
end $$;

create or replace function public.sv_admin_view_save(
  p_secret text, p_owner uuid, p_scope text, p_name text, p_filters jsonb, p_shared boolean
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.saved_views%rowtype;
begin
  perform private.require(p_secret);
  if coalesce(trim(p_name),'') = '' then
    return jsonb_build_object('ok', false, 'error', 'a view needs a name');
  end if;
  insert into public.saved_views (owner_id, scope, name, filters, shared)
  values (p_owner, p_scope, trim(p_name), coalesce(p_filters,'{}'::jsonb), coalesce(p_shared,false))
  on conflict (owner_id, scope, lower(name))
    do update set filters = excluded.filters, shared = excluded.shared
  returning * into r;
  return jsonb_build_object('ok', true, 'view', to_jsonb(r));
end $$;

create or replace function public.sv_admin_view_delete(p_secret text, p_owner uuid, p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  perform private.require(p_secret);
  delete from public.saved_views where id = p_id and owner_id = p_owner;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', n > 0, 'deleted', n,
    'error', case when n = 0 then 'that view does not exist, or it belongs to another operator' end);
end $$;;
