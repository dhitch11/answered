-- 20260814201339_account_notify_channels
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- account_notify: how a business wants to be told that a job was booked.
--
-- DAVID'S RULING, ENCODED AS SHAPE RATHER THAN AS COPY (2026-08-14):
-- "There's a reason they're hiring us. It's because they don't answer the phone."
-- Our customer is definitionally the person who does not pick up, so a CALL is the wrong
-- default. Email is automatic, text is a default, a call is opt-in and earns its place at 2am.
--
-- THREE THINGS THIS TABLE SAYS BY EXISTING THE WAY IT DOES:
--   1. THERE IS NO email_on COLUMN. Email is not a toggle. A customer cannot switch off the only
--      channel that delivers today, because then a booked job would reach nobody at all.
--   2. sms_on DEFAULTS TO TRUE. Text is a default channel that is blocked by a CARRIER, not by the
--      customer's preference. A2P 10DLC is still in review, so nothing sends; the day it clears,
--      every account already says yes and no data migration is needed. The switch is config.
--   3. call_on DEFAULTS TO FALSE and call_after_hours_only DEFAULTS TO TRUE. Opt-in, and even
--      once opted in it is the emergency channel by default, not the routine one.

create table if not exists public.account_notify (
  account_id            uuid primary key references public.accounts(id) on delete cascade,
  email_extra           text[]      not null default '{}',   -- owner_email ALWAYS gets it; these are extra
  sms_on                boolean     not null default true,
  sms_to                text,                                -- null means "use accounts.owner_phone"
  call_on               boolean     not null default false,
  call_after_hours_only boolean     not null default true,
  call_to               text,
  updated_at            timestamptz not null default now(),
  updated_by            text
);

alter table public.account_notify enable row level security;
revoke all on public.account_notify from anon, authenticated;

-- The defaults are returned even when no row exists, so a customer who has never opened the
-- settings page is shown the policy actually in force rather than an error or a blank.
create or replace function public.sv_account_notify(p_secret text, p_account_id uuid)
returns jsonb
language plpgsql stable security definer set search_path to 'public', 'private'
as $$
declare n public.account_notify%rowtype; a public.accounts%rowtype;
begin
  perform private.require(p_secret);
  select * into a from public.accounts where id = p_account_id;
  if a.id is null then return null; end if;
  select * into n from public.account_notify where account_id = p_account_id;
  return jsonb_build_object(
    'stored',                n.account_id is not null,
    'owner_email',           a.owner_email,
    'owner_phone',           a.owner_phone,
    'email_extra',           coalesce(n.email_extra, '{}'::text[]),
    'sms_on',                coalesce(n.sms_on, true),
    'sms_to',                coalesce(n.sms_to, a.owner_phone),
    'call_on',               coalesce(n.call_on, false),
    'call_after_hours_only', coalesce(n.call_after_hours_only, true),
    'call_to',               coalesce(n.call_to, a.owner_phone),
    'updated_at',            n.updated_at,
    'updated_by',            n.updated_by);
end $$;

-- A patch, not a replace: a key the caller did not send keeps its current value, so a form that
-- renders three fields can never blank a fourth it never showed. Booleans are read explicitly
-- rather than with coalesce(nullif(...)), because `false` is a value a customer chose and
-- nullif would erase it.
create or replace function public.sv_account_notify_save(p_secret text, p_account_id uuid, p_patch jsonb, p_author text)
returns jsonb
language plpgsql security definer set search_path to 'public', 'private'
as $$
declare cur jsonb;
begin
  perform private.require(p_secret);
  if not exists (select 1 from public.accounts where id = p_account_id) then
    raise exception 'no such account' using errcode = '22023';
  end if;

  cur := public.sv_account_notify(p_secret, p_account_id);

  insert into public.account_notify as n
    (account_id, email_extra, sms_on, sms_to, call_on, call_after_hours_only, call_to, updated_at, updated_by)
  values (
    p_account_id,
    case when p_patch ? 'email_extra'
         then coalesce((select array_agg(btrim(x)) from jsonb_array_elements_text(p_patch->'email_extra') x
                         where btrim(x) <> ''), '{}'::text[])
         else (cur->>'email_extra')::text[] end,
    case when p_patch ? 'sms_on' then (p_patch->>'sms_on')::boolean else (cur->>'sms_on')::boolean end,
    case when p_patch ? 'sms_to' then nullif(btrim(p_patch->>'sms_to'),'') else cur->>'sms_to' end,
    case when p_patch ? 'call_on' then (p_patch->>'call_on')::boolean else (cur->>'call_on')::boolean end,
    case when p_patch ? 'call_after_hours_only' then (p_patch->>'call_after_hours_only')::boolean
         else (cur->>'call_after_hours_only')::boolean end,
    case when p_patch ? 'call_to' then nullif(btrim(p_patch->>'call_to'),'') else cur->>'call_to' end,
    now(), coalesce(nullif(p_author,''), 'owner'))
  on conflict (account_id) do update set
    email_extra           = excluded.email_extra,
    sms_on                = excluded.sms_on,
    sms_to                = excluded.sms_to,
    call_on               = excluded.call_on,
    call_after_hours_only = excluded.call_after_hours_only,
    call_to               = excluded.call_to,
    updated_at            = now(),
    updated_by            = excluded.updated_by;

  insert into public.account_events (account_id, kind, payload, actor)
  values (p_account_id, 'notify_saved',
          jsonb_build_object('fields', (select jsonb_agg(k) from jsonb_object_keys(p_patch) k)),
          coalesce(nullif(p_author,''), 'owner'));

  return public.sv_account_notify(p_secret, p_account_id);
end $$;

revoke all on function public.sv_account_notify(text, uuid) from public, anon, authenticated;
revoke all on function public.sv_account_notify_save(text, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.sv_account_notify(text, uuid) to anon, authenticated;
grant execute on function public.sv_account_notify_save(text, uuid, jsonb, text) to anon, authenticated;;
