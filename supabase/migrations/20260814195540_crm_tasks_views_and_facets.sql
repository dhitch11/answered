-- 20260814195540_crm_tasks_views_and_facets
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- THE CRM LAYER for /admin, over 4,374 real classified contractor businesses.
--
-- ADDITIVE ONLY. `contacts` belongs to the outbound lane and is not altered here: it already
-- carries owner, tags, score, disposition, lane, consent and the enrichment columns. Everything
-- below is new tables and new read/write RPCs beside it.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ── tasks. A CRM without a next action is a spreadsheet. ─────────────────────────────────────
create table if not exists public.crm_tasks (
  id          uuid primary key default gen_random_uuid(),
  contact_id  uuid references public.contacts(id) on delete cascade,
  account_id  uuid references public.accounts(id) on delete cascade,
  title       text not null,
  body        text,
  due_at      timestamptz,
  status      text not null default 'open' check (status in ('open','done','cancelled')),
  priority    text not null default 'normal' check (priority in ('low','normal','high')),
  assignee    text,
  created_by  text,
  created_at  timestamptz not null default now(),
  done_at     timestamptz,
  done_by     text,
  constraint crm_tasks_has_a_subject check (contact_id is not null or account_id is not null)
);
comment on table public.crm_tasks is
  'An operator task against a contact or an account. The CHECK forbids a task attached to neither, because a task with no subject is a note that will never be found again.';
create index if not exists crm_tasks_open_idx    on public.crm_tasks (status, due_at) where status = 'open';
create index if not exists crm_tasks_contact_idx on public.crm_tasks (contact_id, created_at desc);
create index if not exists crm_tasks_account_idx on public.crm_tasks (account_id, created_at desc);

-- ── saved views. Filter state that survives a reload and can be shared. ──────────────────────
create table if not exists public.saved_views (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid references public.admin_users(id) on delete cascade,
  scope      text not null check (scope in ('contacts','calls','accounts','events','billing')),
  name       text not null,
  filters    jsonb not null default '{}'::jsonb,
  shared     boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  used_at    timestamptz
);
create unique index if not exists saved_views_name_uniq on public.saved_views (owner_id, scope, lower(name));
create index if not exists saved_views_scope_idx on public.saved_views (scope, sort_order);

alter table public.crm_tasks   enable row level security;
alter table public.saved_views enable row level security;
revoke all on public.crm_tasks, public.saved_views from anon, authenticated;
grant all on public.crm_tasks, public.saved_views to service_role;

-- ── the list ─────────────────────────────────────────────────────────────────────────────────
-- Server-side everything. At 4,374 rows OFFSET is fine; the shape below is the one that still
-- works at 400,000 because the filter and the count run in the database and only one page of rows
-- is ever serialised.
create or replace function public.sv_admin_contacts(
  p_secret text, p_q text, p_lane text, p_disposition text, p_state text, p_trade text,
  p_line_type text, p_owner text, p_tag text, p_suppressed boolean, p_dialable boolean,
  p_sort text, p_limit integer, p_offset integer
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb; n bigint; lim integer; off integer;
begin
  perform private.require(p_secret);
  lim := greatest(1, least(coalesce(p_limit, 50), 200));
  off := greatest(0, coalesce(p_offset, 0));

  create temp table if not exists _f on commit drop as select 1;

  with base as (
    select c.* from public.contacts c
     where (p_lane        is null or c.lane = p_lane)
       and (p_disposition is null or c.disposition = p_disposition)
       and (p_state       is null or c.state = p_state)
       and (p_trade       is null or c.trade = p_trade)
       and (p_line_type   is null or c.line_type = p_line_type)
       and (p_owner       is null or c.owner = p_owner)
       and (p_tag         is null or c.tags @> array[p_tag])
       and (p_suppressed  is null or c.suppressed = p_suppressed)
       -- "dialable" is the lawful-to-AI-cold-call pool: a verified fixed business line.
       and (p_dialable    is null or (c.line_type in ('landline','fixedVoip')) = p_dialable)
       and (p_q is null or p_q = '' or (
              c.name    ilike '%'||p_q||'%' or c.phone   ilike '%'||p_q||'%'
           or c.city    ilike '%'||p_q||'%' or c.website ilike '%'||p_q||'%'
           or c.street  ilike '%'||p_q||'%' or c.id::text = p_q))
  )
  select count(*) into n from base;

  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v from (
    select c.id, c.name, c.phone, c.trade, c.state, c.city, c.website, c.line_type, c.carrier,
           c.lane, c.lane_reasons, c.disposition, c.owner, c.tags, c.score, c.suppressed,
           c.suppressed_reason, c.call_count, c.first_contacted_at, c.last_contacted_at,
           c.created_at, c.contact_name, c.contact_role, c.email, c.linkedin_url, c.enriched_at,
           (c.line_type in ('landline','fixedVoip')) as ai_dialable,
           (select count(*) from public.notes nt where nt.contact_id = c.id)      as note_count,
           (select count(*) from public.crm_tasks t
             where t.contact_id = c.id and t.status = 'open')                     as open_tasks,
           (select max(cl.created_at) from public.calls cl where cl.contact_id = c.id) as last_call_at
      from public.contacts c
     where (p_lane        is null or c.lane = p_lane)
       and (p_disposition is null or c.disposition = p_disposition)
       and (p_state       is null or c.state = p_state)
       and (p_trade       is null or c.trade = p_trade)
       and (p_line_type   is null or c.line_type = p_line_type)
       and (p_owner       is null or c.owner = p_owner)
       and (p_tag         is null or c.tags @> array[p_tag])
       and (p_suppressed  is null or c.suppressed = p_suppressed)
       and (p_dialable    is null or (c.line_type in ('landline','fixedVoip')) = p_dialable)
       and (p_q is null or p_q = '' or (
              c.name    ilike '%'||p_q||'%' or c.phone   ilike '%'||p_q||'%'
           or c.city    ilike '%'||p_q||'%' or c.website ilike '%'||p_q||'%'
           or c.street  ilike '%'||p_q||'%' or c.id::text = p_q))
     order by
       case when coalesce(p_sort,'recent') = 'recent' then c.created_at end desc nulls last,
       case when p_sort = 'name'   then lower(c.name) end asc  nulls last,
       case when p_sort = 'score'  then c.score end desc nulls last,
       case when p_sort = 'calls'  then c.call_count end desc nulls last,
       case when p_sort = 'touched' then c.last_contacted_at end desc nulls last,
       c.created_at desc
     limit lim offset off
  ) x;

  return jsonb_build_object('total', n, 'limit', lim, 'offset', off, 'rows', v);
end $$;

-- ── the facets. Counted in the database so filter chips carry real numbers, never guesses. ──
create or replace function public.sv_admin_contact_facets(p_secret text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform private.require(p_secret);
  return jsonb_build_object(
    'total',       (select count(*) from public.contacts),
    'ai_dialable', (select count(*) from public.contacts where line_type in ('landline','fixedVoip')),
    'suppressed',  (select count(*) from public.contacts where suppressed),
    'enriched',    (select count(*) from public.contacts where enriched_at is not null),
    'with_email',  (select count(*) from public.contacts where email is not null),
    'with_website',(select count(*) from public.contacts where website is not null),
    'lane',        (select coalesce(jsonb_agg(jsonb_build_object('k', coalesce(lane,'none'), 'n', n) order by n desc), '[]'::jsonb)
                      from (select lane, count(*) n from public.contacts group by 1) s),
    'disposition', (select coalesce(jsonb_agg(jsonb_build_object('k', disposition, 'n', n) order by n desc), '[]'::jsonb)
                      from (select disposition, count(*) n from public.contacts group by 1) s),
    'line_type',   (select coalesce(jsonb_agg(jsonb_build_object('k', coalesce(line_type,'unknown'), 'n', n) order by n desc), '[]'::jsonb)
                      from (select line_type, count(*) n from public.contacts group by 1) s),
    'trade',       (select coalesce(jsonb_agg(jsonb_build_object('k', trade, 'n', n) order by n desc), '[]'::jsonb)
                      from (select trade, count(*) n from public.contacts where trade is not null group by 1 order by 2 desc limit 24) s),
    'state',       (select coalesce(jsonb_agg(jsonb_build_object('k', state, 'n', n) order by n desc), '[]'::jsonb)
                      from (select state, count(*) n from public.contacts where state is not null group by 1 order by 2 desc limit 60) s),
    'owner',       (select coalesce(jsonb_agg(jsonb_build_object('k', owner, 'n', n) order by n desc), '[]'::jsonb)
                      from (select owner, count(*) n from public.contacts where owner is not null group by 1) s)
  );
end $$;

-- ── one contractor, everything ──────────────────────────────────────────────────────────────
create or replace function public.sv_admin_contact(p_secret text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.contacts%rowtype;
begin
  perform private.require(p_secret);
  select * into c from public.contacts where id = p_id;
  if not found then return null; end if;

  return jsonb_build_object(
    'contact', to_jsonb(c) || jsonb_build_object('ai_dialable', (c.line_type in ('landline','fixedVoip'))),
    'calls', (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb) from (
        select id, call_sid, direction, status, answered_by, duration_seconds, recording_sid,
               summary, sentiment, disposition, placed, refused_reason, call_class,
               ai_speaking, ai_listening, disclosure_verified, created_at
          from public.calls where contact_id = p_id order by created_at desc limit 50) x),
    'notes', (select coalesce(jsonb_agg(to_jsonb(x) order by x.pinned desc, x.at desc), '[]'::jsonb) from (
        select id, body, author, pinned, at, call_sid from public.notes
         where contact_id = p_id order by pinned desc, at desc limit 100) x),
    'tasks', (select coalesce(jsonb_agg(to_jsonb(x) order by
                (x.status='open') desc, x.due_at asc nulls last), '[]'::jsonb) from (
        select id, title, body, due_at, status, priority, assignee, created_by, created_at,
               done_at, done_by
          from public.crm_tasks where contact_id = p_id order by created_at desc limit 100) x),
    'consent', (select coalesce(jsonb_agg(to_jsonb(x) order by x.granted_at desc), '[]'::jsonb) from (
        select scope, written, source, granted_at, expires_at from public.consent
         where phone = c.phone) x),
    'suppression', (select to_jsonb(s) from public.suppression s where s.phone = c.phone),
    'audit', (select coalesce(jsonb_agg(jsonb_build_object(
        'actor_email', a.actor_email, 'action', a.action, 'payload', a.payload, 'at', a.at)
        order by a.at desc), '[]'::jsonb)
        from (select * from public.admin_audit
               where target_kind = 'contact' and target_id = p_id::text
               order by at desc limit 50) a)
  );
end $$;;
