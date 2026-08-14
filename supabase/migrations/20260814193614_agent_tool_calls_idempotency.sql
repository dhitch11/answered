-- 20260814193614_agent_tool_calls_idempotency
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- @LANE-BOOK 2026-08-14. ADDITIVE ONLY: one new table, two new security-definer RPCs.
-- Nothing existing is dropped, renamed or redefined.
--
-- WHY THIS EXISTS. The voice can now book a job. ElevenLabs retries a server tool that times out,
-- and a language model can decide to call the same tool twice in one breath. Either one books the
-- same visit twice, sends the shop two vans, and bills twice. A module-scope cache in a serverless
-- function is not an answer: the retry frequently lands on a different instance. The claim has to
-- be atomic and it has to be somewhere both instances can see, so it is a unique index.
--
-- THE STALE-CLAIM RULE IS THE PART THAT IS EASY TO GET WRONG. If a run dies after claiming and
-- before settling, a naive unique key wedges that booking FOREVER: every retry is told "already
-- running" and the customer is never booked. So a claim older than 90 seconds that never settled
-- is taken over by the next caller. A duplicate job is recoverable by a phone call. A job that was
-- never written down is the failure this whole product exists to prevent.

create table if not exists public.agent_tool_calls (
  id           bigserial primary key,
  idem_key     text        not null unique,
  tool         text        not null,
  conversation text,
  call_sid     text,
  args         jsonb       not null default '{}'::jsonb,
  status       text        not null default 'running',
  result       jsonb,
  created_at   timestamptz not null default now(),
  settled_at   timestamptz
);

comment on table public.agent_tool_calls is
  'One row per mid-call tool ACTION taken by a voice agent. idem_key is the atomic claim: a retried tool call finds the row and replays the stored result instead of acting twice. @LANE-BOOK 2026-08-14.';

create index if not exists agent_tool_calls_created_idx on public.agent_tool_calls (created_at desc);
create index if not exists agent_tool_calls_conv_idx    on public.agent_tool_calls (conversation);

alter table public.agent_tool_calls enable row level security;
revoke all on public.agent_tool_calls from anon, authenticated;
revoke all on sequence public.agent_tool_calls_id_seq from anon, authenticated;

-- Claim the key, or report who already holds it. Atomic: the unique index is the lock.
create or replace function public.sv_tool_claim(
  p_secret text, p_key text, p_tool text, p_conversation text, p_call_sid text, p_args jsonb
) returns jsonb
language plpgsql security definer set search_path to 'public', 'private' as $$
declare v public.agent_tool_calls;
begin
  perform private.require(p_secret);
  if coalesce(p_key,'') = '' then
    raise exception 'sv_tool_claim: refusing to claim an empty key';
  end if;

  insert into public.agent_tool_calls (idem_key, tool, conversation, call_sid, args)
  values (p_key, p_tool, nullif(p_conversation,''), nullif(p_call_sid,''), coalesce(p_args,'{}'::jsonb))
  on conflict (idem_key) do nothing
  returning * into v;
  if found then
    return jsonb_build_object('claimed', true, 'id', v.id, 'replay', false);
  end if;

  -- somebody holds it. A settled holder is replayed; an abandoned one is taken over.
  update public.agent_tool_calls
     set created_at = now(), args = coalesce(p_args, args), status = 'running'
   where idem_key = p_key
     and status = 'running'
     and created_at < now() - interval '90 seconds'
  returning * into v;
  if found then
    return jsonb_build_object('claimed', true, 'id', v.id, 'replay', false, 'took_over', true);
  end if;

  select * into v from public.agent_tool_calls where idem_key = p_key;
  return jsonb_build_object(
    'claimed', false, 'id', v.id, 'replay', true,
    'status', v.status, 'result', v.result,
    'held_for_seconds', round(extract(epoch from (now() - v.created_at)))
  );
end $$;

create or replace function public.sv_tool_settle(
  p_secret text, p_key text, p_status text, p_result jsonb
) returns jsonb
language plpgsql security definer set search_path to 'public', 'private' as $$
declare v public.agent_tool_calls;
begin
  perform private.require(p_secret);
  update public.agent_tool_calls
     set status = coalesce(nullif(p_status,''),'done'), result = p_result, settled_at = now()
   where idem_key = p_key
  returning * into v;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no claim with that key');
  end if;
  return jsonb_build_object('ok', true, 'id', v.id, 'status', v.status);
end $$;

revoke all on function public.sv_tool_claim(text,text,text,text,text,jsonb)  from anon, authenticated, public;
revoke all on function public.sv_tool_settle(text,text,text,jsonb)           from anon, authenticated, public;
grant execute on function public.sv_tool_claim(text,text,text,text,text,jsonb) to service_role;
grant execute on function public.sv_tool_settle(text,text,text,jsonb)         to service_role;;
