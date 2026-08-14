-- 20260814200216_crm_outreach_log_and_preflight
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- OUTREACH. Call, text or email any lead from the record it belongs to — and, before any of
-- those, an honest answer about whether we are actually allowed to.
--
-- ★ THE DESIGN PRINCIPLE: THE BUTTON KNOWS BEFORE YOU PRESS IT.
-- Two of these three channels cannot legally or technically act on most leads today. Cold calling
-- a mobile without consent is refused, SMS is blocked at the carrier because the A2P campaign was
-- rejected, and the do-not-call gate is shut until a registry snapshot exists. A console that
-- renders three identical buttons and fails after the click is worse than useless: it teaches an
-- operator that the product is broken, when in fact the product is obeying the law.
--
-- So every channel reports, per contact, one of: READY (and it will really send), BLOCKED (with
-- the specific reason, in words an operator can act on), or NEEDS (a named thing that would
-- unblock it). A control that cannot act never renders as though it can.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

create table if not exists public.crm_messages (
  id            uuid primary key default gen_random_uuid(),
  contact_id    uuid references public.contacts(id) on delete set null,
  account_id    uuid references public.accounts(id) on delete set null,
  channel       text not null check (channel in ('email','sms','call','note')),
  direction     text not null default 'outbound' check (direction in ('outbound','inbound')),
  to_addr       text,
  from_addr     text,
  subject       text,
  body          text,
  template      text,
  provider      text,
  provider_id   text,
  status        text not null default 'queued'
                check (status in ('queued','sent','delivered','opened','clicked','bounced','complained','failed','blocked')),
  failure_reason text,
  meta          jsonb not null default '{}'::jsonb,
  ai_assisted   boolean not null default false,
  ai_model      text,
  sent_by       text,
  created_at    timestamptz not null default now(),
  sent_at       timestamptz,
  updated_at    timestamptz not null default now()
);
comment on table public.crm_messages is
  'Every message this company sends or receives on any channel, with the record it belongs to. A blocked attempt is recorded with status=blocked and its reason, because "we did not contact them, and here is why" is evidence an operator and a regulator both need.';
create index if not exists crm_messages_contact_idx on public.crm_messages (contact_id, created_at desc);
create index if not exists crm_messages_account_idx on public.crm_messages (account_id, created_at desc);
create index if not exists crm_messages_status_idx  on public.crm_messages (status, created_at desc);
create index if not exists crm_messages_channel_idx on public.crm_messages (channel, created_at desc);
create unique index if not exists crm_messages_provider_uniq on public.crm_messages (provider, provider_id)
  where provider_id is not null;

create table if not exists public.crm_templates (
  id         uuid primary key default gen_random_uuid(),
  key        text not null,
  version    integer not null default 1,
  channel    text not null check (channel in ('email','sms')),
  name       text not null,
  subject    text,
  body       text not null,
  variables  text[] not null default '{}',
  active     boolean not null default true,
  created_by text,
  created_at timestamptz not null default now()
);
create unique index if not exists crm_templates_key_ver on public.crm_templates (key, version);
comment on column public.crm_templates.variables is
  'Every variable the body references. Rendering FAILS LOUDLY on a missing one rather than sending "Hi {{first_name}}", which is the single most common way a CRM embarrasses a company in public.';

alter table public.crm_messages  enable row level security;
alter table public.crm_templates enable row level security;
revoke all on public.crm_messages, public.crm_templates from anon, authenticated;
grant all  on public.crm_messages, public.crm_templates to service_role;

-- ── the preflight ────────────────────────────────────────────────────────────────────────────
-- Everything the DATABASE knows about whether we may contact this person. The function layer adds
-- what only the runtime knows (is the mail key set, is the A2P campaign approved, is the autopilot
-- kill switch on) and merges the two.
create or replace function public.sv_crm_outreach_state(p_secret text, p_contact_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c        public.contacts%rowtype;
  v_supp   public.suppression%rowtype;
  v_cons   integer;
  v_dnc    jsonb;
  v_call_ok boolean;
  v_call_why text;
begin
  perform private.require(p_secret);
  select * into c from public.contacts where id = p_contact_id;
  if c.id is null then return null; end if;

  select * into v_supp from public.suppression where phone = c.phone;
  select count(*) into v_cons from public.consent
   where phone = c.phone and (expires_at is null or expires_at > now());

  begin
    v_dnc := public.sv_dnc_readiness(p_secret);
  exception when others then
    v_dnc := jsonb_build_object('scrub_ready', false, 'procedures_ready', false,
                                'error', 'do-not-call readiness could not be read');
  end;

  -- The call decision, in priority order, most absolute first. An unanswerable question is a
  -- refusal, never a permission.
  if c.suppressed or v_supp.phone is not null then
    v_call_ok := false;
    v_call_why := 'This number is on our suppression list' ||
      coalesce(': ' || coalesce(c.suppressed_reason, v_supp.reason), '') ||
      '. It is never called again, by anyone, for any reason.';
  elsif c.line_type is null then
    v_call_ok := false;
    v_call_why := 'We have never established what kind of line this is. The gate treats an unanswerable question as a refusal, so run a line-type lookup first.';
  elsif v_cons > 0 then
    v_call_ok := true;
    v_call_why := 'There is a consent record on file for this number, so this is a consented call regardless of line type.';
  elsif c.line_type in ('mobile','nonFixedVoip') then
    v_call_ok := false;
    v_call_why := 'This is a ' || c.line_type || '. An AI voice may not cold-call it without prior express consent. A person may dial and speak to it, which is a different call class and is not available from this console yet.';
  elsif c.line_type = 'tollFree' then
    v_call_ok := false;
    v_call_why := 'Toll free numbers are not dialled: the called party pays.';
  elsif not coalesce((v_dnc->>'scrub_ready')::boolean, false) then
    v_call_ok := false;
    v_call_why := 'The national do-not-call registry has never been loaded, so we cannot prove this number is not on it. That is a condition precedent, not a formality.';
  elsif not coalesce((v_dnc->>'procedures_ready')::boolean, false) then
    v_call_ok := false;
    v_call_why := 'The written do-not-call procedures required by 47 CFR 64.1200(d) are not all in place.';
  else
    v_call_ok := true;
    v_call_why := 'Verified fixed business line, not suppressed, scrubbed against a current registry snapshot.';
  end if;

  return jsonb_build_object(
    'contact_id', c.id,
    'name', c.name,
    'phone', c.phone,
    'email', c.email,
    'line_type', c.line_type,
    'lane', c.lane,
    'suppressed', (c.suppressed or v_supp.phone is not null),
    'consent_records', v_cons,
    'dnc', v_dnc,
    'call',  jsonb_build_object('ok', v_call_ok, 'why', v_call_why,
             'class', case when v_cons > 0 then 'consented'
                           when c.line_type in ('landline','fixedVoip') then 'ai_cold'
                           else null end),
    'email_db', jsonb_build_object(
       'ok', (c.email is not null and not (c.suppressed or v_supp.phone is not null)),
       'why', case when c.email is null
                   then 'We hold no email address for this business. OpenStreetMap does not carry them, so this is an honest absence rather than a gap in the record.'
                   when (c.suppressed or v_supp.phone is not null)
                   then 'This contact asked not to be contacted. Suppression covers every channel, not only the phone.'
                   else 'A business email is on file and this contact is not suppressed.' end),
    'sms_db', jsonb_build_object(
       'ok', (c.phone is not null and c.line_type in ('mobile','nonFixedVoip')
              and not (c.suppressed or v_supp.phone is not null)),
       'why', case when (c.suppressed or v_supp.phone is not null)
                   then 'This contact asked not to be contacted.'
                   when c.line_type not in ('mobile','nonFixedVoip')
                   then 'A ' || coalesce(c.line_type,'unknown') || ' line does not receive text messages.'
                   else 'The number can receive texts.' end),
    'counts', jsonb_build_object(
      'messages', (select count(*) from public.crm_messages m where m.contact_id = c.id),
      'calls',    (select count(*) from public.calls cl where cl.contact_id = c.id),
      'last_contacted_at', c.last_contacted_at)
  );
end $$;

-- ── the send log write ───────────────────────────────────────────────────────────────────────
create or replace function public.sv_crm_message(p_secret text, p_row jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.crm_messages%rowtype;
begin
  perform private.require(p_secret);
  insert into public.crm_messages (
    contact_id, account_id, channel, direction, to_addr, from_addr, subject, body, template,
    provider, provider_id, status, failure_reason, meta, ai_assisted, ai_model, sent_by, sent_at
  ) values (
    nullif(p_row->>'contact_id','')::uuid, nullif(p_row->>'account_id','')::uuid,
    p_row->>'channel', coalesce(nullif(p_row->>'direction',''),'outbound'),
    nullif(p_row->>'to_addr',''), nullif(p_row->>'from_addr',''),
    nullif(p_row->>'subject',''), nullif(p_row->>'body',''), nullif(p_row->>'template',''),
    nullif(p_row->>'provider',''), nullif(p_row->>'provider_id',''),
    coalesce(nullif(p_row->>'status',''),'queued'), nullif(p_row->>'failure_reason',''),
    coalesce(p_row->'meta','{}'::jsonb), coalesce((p_row->>'ai_assisted')::boolean,false),
    nullif(p_row->>'ai_model',''), nullif(p_row->>'sent_by',''),
    case when (p_row->>'status') in ('sent','delivered') then now() end
  ) returning * into r;

  -- Every message is also a timeline entry, so one feed answers "what has happened with this
  -- business" without an operator having to know which table to look in.
  insert into public.crm_activity (contact_id, account_id, kind, title, body, payload, source, actor,
                                   ref_kind, ref_id)
  values (r.contact_id, r.account_id, r.channel,
          case r.status
            when 'blocked' then 'Blocked ' || r.channel || ': ' || coalesce(r.failure_reason,'no reason recorded')
            when 'failed'  then 'Failed ' || r.channel || ': ' || coalesce(r.failure_reason,'no reason recorded')
            else initcap(r.direction) || ' ' || r.channel ||
                 coalesce(' — ' || r.subject, coalesce(' to ' || r.to_addr, '')) end,
          left(coalesce(r.body,''), 2000), coalesce(p_row->'meta','{}'::jsonb),
          coalesce(r.provider,'console'), r.sent_by, 'crm_message', r.id::text);

  if r.status in ('sent','delivered') and r.contact_id is not null then
    update public.contacts
       set last_contacted_at = now(),
           first_contacted_at = coalesce(first_contacted_at, now()),
           updated_at = now()
     where id = r.contact_id;
  end if;

  return jsonb_build_object('ok', true, 'message', to_jsonb(r));
end $$;

create or replace function public.sv_crm_message_status(
  p_secret text, p_provider text, p_provider_id text, p_status text, p_reason text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.crm_messages%rowtype;
begin
  perform private.require(p_secret);
  update public.crm_messages
     set status = p_status, failure_reason = nullif(p_reason,''), updated_at = now()
   where provider = p_provider and provider_id = p_provider_id
  returning * into r;
  if r.id is null then return jsonb_build_object('ok', false, 'error', 'no such message'); end if;

  -- A hard bounce or a spam complaint suppresses the contact automatically. Continuing to email
  -- someone whose mailbox rejected us, or who marked us as spam, is how a sending domain dies.
  if p_status in ('bounced','complained') and r.contact_id is not null then
    update public.contacts
       set suppressed = true,
           suppressed_reason = 'email ' || p_status,
           suppressed_at = now(), updated_at = now()
     where id = r.contact_id and not suppressed;
    insert into public.crm_activity (contact_id, kind, title, source, ref_kind, ref_id)
    values (r.contact_id, 'suppression',
            'Suppressed automatically after an email ' || p_status, 'system', 'crm_message', r.id::text);
  end if;
  return jsonb_build_object('ok', true, 'message', to_jsonb(r));
end $$;

-- ── the unified timeline read ────────────────────────────────────────────────────────────────
create or replace function public.sv_crm_timeline(
  p_secret text, p_contact_id uuid, p_account_id uuid, p_limit integer, p_before timestamptz
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  perform private.require(p_secret);
  select coalesce(jsonb_agg(to_jsonb(x) order by x.at desc), '[]'::jsonb) into v from (
    select a.id, a.kind, a.title, a.body, a.source, a.actor, a.ref_kind, a.ref_id, a.at, a.payload
      from public.crm_activity a
     where ((p_contact_id is not null and a.contact_id = p_contact_id)
         or (p_account_id is not null and a.account_id = p_account_id))
       and (p_before is null or a.at < p_before)
     order by a.at desc
     limit greatest(1, least(coalesce(p_limit, 100), 300))
  ) x;
  return v;
end $$;;
