-- 20260814183230_consent_bridge_no_dead_ends
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- ★ THE HURDLE THIS REMOVES, and it was invisible from every surface.
--
-- `call-me.mjs` captures explicit consent when a person taps "call me" and writes it to Netlify
-- Blobs. The dial gate reads `public.consent` in Postgres. The two never spoke. So a contractor
-- who typed their number, ticked the box, and asked us to ring them was STILL classified RED by
-- the gate — mobile, no consent on file — and the console would refuse to call the one person in
-- the corpus who had explicitly asked to be called.
--
-- Nobody would have seen it. The activation call still happened (call-me dials it itself), the
-- consent record still existed, and the refusal looked like correct compliance behaviour.
--
-- This is also the answer to "only 27.5% of contractors are dialable". That ceiling applies to
-- COLD calls only. Every number that taps a button is green, permanently, for that scope. The
-- reachable market is 27.5% cold PLUS everyone who ever raises a hand, and the job is to make
-- raising a hand cost one tap.

create or replace function public.sv_grant_consent(
  p_secret text,
  p_phone text,
  p_source text,
  p_evidence jsonb default '{}'::jsonb,
  p_scope text default 'research_call',
  p_written boolean default false,
  p_expires_at timestamptz default null,
  p_ip inet default null,
  p_user_agent text default null)
returns jsonb language plpgsql security definer set search_path = public, private as $$
declare v_id uuid; v_supp boolean;
begin
  perform private.require(p_secret);

  if p_phone is null or p_phone !~ '^\+1\d{10}$' then
    return jsonb_build_object('error', format('not a US E.164 number: %s', coalesce(p_phone,'null')));
  end if;
  if coalesce(trim(p_source),'') = '' then
    return jsonb_build_object('error','a consent record with no source is not evidence of anything');
  end if;

  -- ★ SUPPRESSION OUTRANKS CONSENT, ALWAYS AND IN BOTH DIRECTIONS. Someone who said stop and later
  -- submits a form has not un-said it. Recording consent for a suppressed number would let a web
  -- form quietly overturn a spoken opt-out, which is the worst failure this system could have.
  select exists (select 1 from public.suppression s where s.phone = p_phone) into v_supp;
  if v_supp then
    return jsonb_build_object('refused','this number is on the do-not-call list; consent cannot override it',
                              'phone_last4', right(p_phone,4));
  end if;

  insert into public.consent (phone, scope, written, source, evidence, ip, user_agent, expires_at)
  values (p_phone, coalesce(p_scope,'research_call'), coalesce(p_written,false), p_source,
          coalesce(p_evidence,'{}'::jsonb), p_ip, p_user_agent, p_expires_at)
  returning id into v_id;

  -- A number that raised its hand should also exist as a contact, so the console can see it and
  -- the funnel counts it. Nothing here overwrites a richer record that already exists.
  insert into public.contacts (phone, source, lane, disposition)
  values (p_phone, coalesce(p_source,'consent'), 'green', 'new')
  on conflict (phone) do update set lane = 'green', updated_at = now();

  return jsonb_build_object('ok', true, 'consent_id', v_id, 'phone_last4', right(p_phone,4), 'scope', coalesce(p_scope,'research_call'));
end $$;

revoke all on function public.sv_grant_consent(text,text,text,jsonb,text,boolean,timestamptz,inet,text) from public;
grant execute on function public.sv_grant_consent(text,text,text,jsonb,text,boolean,timestamptz,inet,text) to anon, authenticated;

-- Idempotency for the reconciler: one row per external record id, so replaying the blob store
-- cannot manufacture duplicate consent events.
create table if not exists public.consent_sources (
  external_id text primary key,
  consent_id  uuid references public.consent(id) on delete set null,
  synced_at   timestamptz not null default now()
);
alter table public.consent_sources enable row level security;

create or replace function public.sv_grant_consent_once(
  p_secret text, p_external_id text, p_phone text, p_source text,
  p_evidence jsonb default '{}'::jsonb, p_scope text default 'research_call',
  p_written boolean default false, p_granted_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public, private as $$
declare v jsonb; v_id uuid;
begin
  perform private.require(p_secret);
  if exists (select 1 from public.consent_sources where external_id = p_external_id) then
    return jsonb_build_object('ok', true, 'already', true);
  end if;

  v := public.sv_grant_consent(p_secret, p_phone, p_source, p_evidence, p_scope, p_written, null, null, null);
  if v ? 'error' or v ? 'refused' then return v; end if;

  v_id := (v->>'consent_id')::uuid;
  if p_granted_at is not null then
    update public.consent set granted_at = p_granted_at where id = v_id;
  end if;
  insert into public.consent_sources (external_id, consent_id) values (p_external_id, v_id)
  on conflict (external_id) do nothing;
  return v || jsonb_build_object('already', false);
end $$;

revoke all on function public.sv_grant_consent_once(text,text,text,text,jsonb,text,boolean,timestamptz) from public;
grant execute on function public.sv_grant_consent_once(text,text,text,text,jsonb,text,boolean,timestamptz) to anon, authenticated;;
