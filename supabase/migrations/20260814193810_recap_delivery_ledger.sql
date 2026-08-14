-- 20260814193810_recap_delivery_ledger
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- The delivery ledger for call recaps. Additive: nothing existing is dropped, renamed or redefined.
--
-- WHY A TABLE AND NOT A MAP IN MEMORY. Duplicate suppression for the recap used to live in a
-- Map inside one warm function instance, which meant a cold start or a second container sent the
-- same transcript twice. Worse, the reverse failure was invisible: nothing anywhere recorded that
-- a transcript HAD been delivered, so "did the shop ever get this call?" had no answer.
--
-- The claim is race free (insert ... on conflict do nothing) and it is NOT a permanent lock: a
-- claim that was never settled goes stale after ten minutes and a later attempt takes it over, so
-- a crash between claiming and sending can never silently cost a shop its transcript. A row that
-- FAILED is re-claimable for the same reason. Only 'sent' and 'skipped' are terminal.

create table if not exists public.recap_deliveries (
  id              uuid primary key default gen_random_uuid(),
  spine_key       text not null,
  conversation_id text,
  channel         text not null check (channel in ('email', 'sms', 'webhook')),
  status          text not null default 'claimed' check (status in ('claimed', 'sent', 'failed', 'skipped')),
  target          text,
  provider_id     text,
  reason          text,
  lines           integer,
  attempts        integer not null default 1,
  claimed_at      timestamptz not null default now(),
  settled_at      timestamptz,
  constraint recap_deliveries_key_channel unique (spine_key, channel)
);

create index if not exists recap_deliveries_claimed_at_idx on public.recap_deliveries (claimed_at desc);

alter table public.recap_deliveries enable row level security;
revoke all on public.recap_deliveries from anon, authenticated;

create or replace function public.sv_recap_claim(
  p_secret text, p_key text, p_channel text, p_conversation_id text default null
) returns jsonb
  language plpgsql security definer set search_path to 'public', 'private'
as $function$
declare v_row public.recap_deliveries; v_claimed boolean := false;
begin
  perform private.require(p_secret);
  if p_key is null or p_key = '' then
    raise exception 'sv_recap_claim needs a spine key' using errcode = '22023';
  end if;

  insert into public.recap_deliveries (spine_key, conversation_id, channel)
  values (p_key, p_conversation_id, p_channel)
  on conflict (spine_key, channel) do nothing
  returning * into v_row;

  if found then
    v_claimed := true;
  else
    update public.recap_deliveries
       set claimed_at = now(), attempts = attempts + 1, status = 'claimed',
           conversation_id = coalesce(conversation_id, p_conversation_id)
     where spine_key = p_key and channel = p_channel
       and (status = 'failed' or (status = 'claimed' and claimed_at < now() - interval '10 minutes'))
    returning * into v_row;
    if found then
      v_claimed := true;
    else
      select * into v_row from public.recap_deliveries
       where spine_key = p_key and channel = p_channel;
    end if;
  end if;

  return jsonb_build_object('claimed', v_claimed, 'row', to_jsonb(v_row));
end $function$;

create or replace function public.sv_recap_settle(
  p_secret text, p_key text, p_channel text, p_status text,
  p_target text default null, p_provider_id text default null,
  p_reason text default null, p_lines integer default null
) returns jsonb
  language plpgsql security definer set search_path to 'public', 'private'
as $function$
declare v_row public.recap_deliveries;
begin
  perform private.require(p_secret);
  update public.recap_deliveries
     set status = p_status, target = p_target, provider_id = p_provider_id,
         reason = p_reason, lines = coalesce(p_lines, lines), settled_at = now()
   where spine_key = p_key and channel = p_channel
  returning * into v_row;
  return to_jsonb(v_row);
end $function$;

create or replace function public.sv_recap_deliveries(p_secret text, p_key text)
  returns jsonb
  language plpgsql stable security definer set search_path to 'public', 'private'
as $function$
declare v jsonb;
begin
  perform private.require(p_secret);
  select coalesce(jsonb_agg(to_jsonb(r) order by r.claimed_at desc), '[]'::jsonb) into v
    from public.recap_deliveries r where r.spine_key = p_key;
  return v;
end $function$;;
