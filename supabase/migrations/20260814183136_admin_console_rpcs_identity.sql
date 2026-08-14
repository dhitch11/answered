-- 20260814183136_admin_console_rpcs_identity
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- sv_admin_* — the operator console's door into this database.
--
-- Same posture as every other sv_* in this schema: security definer, guarded by
-- private.require(p_secret), so the publishable key alone opens nothing. Written to match the
-- house style exactly rather than introduce a second convention.
--
-- ★ NOTHING HERE CAN REACH sealed.limits. Not by argument, not by flag, not by role. The Truce
-- privacy promise is enforced in the data model and an operator console that could print both
-- parties' sealed numbers would break /truce Section 3's headline claim from the inside. The
-- admin projection of a deal comes from sv_truce_admin, which never joins that table.

-- ── identity: lookup, login accounting, sessions ─────────────────────────────────────────────

create or replace function public.sv_admin_by_email(p_secret text, p_email text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare u public.admin_users%rowtype;
begin
  perform private.require(p_secret);
  select * into u from public.admin_users where lower(email) = lower(trim(p_email));
  if not found then return null; end if;
  return jsonb_build_object(
    'id', u.id, 'email', u.email, 'name', u.name, 'role', u.role, 'status', u.status,
    'password_hash', u.password_hash, 'must_change', u.must_change,
    'failed_count', u.failed_count, 'locked_until', u.locked_until,
    'locked', (u.locked_until is not null and u.locked_until > now())
  );
end $$;

-- Failure accounting lives in the database because a Netlify function has no memory between
-- invocations: an in-process counter would count to one forever and rate-limit nothing.
create or replace function public.sv_admin_login_attempt(
  p_secret text, p_admin_id uuid, p_ok boolean, p_ip text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare u public.admin_users%rowtype; v_lock timestamptz;
begin
  perform private.require(p_secret);
  if p_ok then
    update public.admin_users
       set failed_count = 0, locked_until = null, last_login_at = now(),
           last_login_ip = left(coalesce(p_ip,''), 60), updated_at = now()
     where id = p_admin_id returning * into u;
  else
    select * into u from public.admin_users where id = p_admin_id for update;
    if not found then return jsonb_build_object('ok', false); end if;
    -- 5 free, then escalating: 1, 5, 15, 60 minutes, capped. Slow enough to stop a script,
    -- short enough that a tired operator is not locked out of his own business overnight.
    v_lock := case
      when u.failed_count + 1 >= 9 then now() + interval '60 minutes'
      when u.failed_count + 1 >= 8 then now() + interval '15 minutes'
      when u.failed_count + 1 >= 7 then now() + interval '5 minutes'
      when u.failed_count + 1 >= 6 then now() + interval '1 minute'
      else null end;
    update public.admin_users
       set failed_count = u.failed_count + 1, locked_until = v_lock, updated_at = now()
     where id = p_admin_id returning * into u;
  end if;
  return jsonb_build_object('ok', true, 'failed_count', u.failed_count,
                            'locked_until', u.locked_until);
end $$;

create or replace function public.sv_admin_session_create(
  p_secret text, p_admin_id uuid, p_token_hash text, p_hours integer, p_ip text, p_ua text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.admin_sessions%rowtype;
begin
  perform private.require(p_secret);
  insert into public.admin_sessions (admin_id, token_hash, expires_at, ip, ua)
  values (p_admin_id, p_token_hash, now() + (coalesce(p_hours,12) || ' hours')::interval,
          left(coalesce(p_ip,''),60), left(coalesce(p_ua,''),300))
  returning * into s;
  return jsonb_build_object('id', s.id, 'expires_at', s.expires_at);
end $$;

-- The session CHECK is what makes revocation real. A bare signed cookie cannot be taken back
-- before it expires; a row can.
create or replace function public.sv_admin_session(p_secret text, p_token_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record;
begin
  perform private.require(p_secret);
  select s.id as sid, s.expires_at, s.revoked_at, u.id, u.email, u.name, u.role, u.status,
         u.must_change
    into r
    from public.admin_sessions s join public.admin_users u on u.id = s.admin_id
   where s.token_hash = p_token_hash;
  if not found then return null; end if;
  if r.revoked_at is not null then return jsonb_build_object('revoked', true); end if;
  if r.expires_at <= now() then return jsonb_build_object('expired', true); end if;
  if r.status <> 'active' then return jsonb_build_object('disabled', true); end if;
  update public.admin_sessions set last_seen_at = now() where id = r.sid;
  return jsonb_build_object('session_id', r.sid, 'admin_id', r.id, 'email', r.email,
                            'name', r.name, 'role', r.role, 'must_change', r.must_change,
                            'expires_at', r.expires_at);
end $$;

create or replace function public.sv_admin_session_revoke(
  p_secret text, p_token_hash text, p_all_for uuid
) returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  perform private.require(p_secret);
  if p_all_for is not null then
    update public.admin_sessions set revoked_at = now()
     where admin_id = p_all_for and revoked_at is null;
  else
    update public.admin_sessions set revoked_at = now()
     where token_hash = p_token_hash and revoked_at is null;
  end if;
  get diagnostics n = row_count;
  return n;
end $$;

-- Bootstrap is idempotent and REFUSES to overwrite an existing operator. A migration that can
-- silently reset the owner's password is a backdoor with good intentions.
create or replace function public.sv_admin_bootstrap(
  p_secret text, p_email text, p_hash text, p_name text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare u public.admin_users%rowtype;
begin
  perform private.require(p_secret);
  select * into u from public.admin_users where lower(email) = lower(trim(p_email));
  if found then
    return jsonb_build_object('created', false, 'id', u.id, 'email', u.email,
      'note', 'an operator with this email already exists and was not modified');
  end if;
  insert into public.admin_users (email, name, password_hash, role, status)
  values (lower(trim(p_email)), nullif(trim(coalesce(p_name,'')),''), p_hash, 'owner', 'active')
  returning * into u;
  return jsonb_build_object('created', true, 'id', u.id, 'email', u.email);
end $$;

create or replace function public.sv_admin_set_password(
  p_secret text, p_admin_id uuid, p_hash text
) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform private.require(p_secret);
  update public.admin_users
     set password_hash = p_hash, must_change = false, failed_count = 0,
         locked_until = null, updated_at = now()
   where id = p_admin_id;
  if not found then return jsonb_build_object('ok', false); end if;
  -- Every other session for this operator dies with the old password. A password change that
  -- leaves the attacker's session alive has changed nothing.
  update public.admin_sessions set revoked_at = now()
   where admin_id = p_admin_id and revoked_at is null;
  return jsonb_build_object('ok', true);
end $$;

-- ── the audit log ────────────────────────────────────────────────────────────────────────────
create or replace function public.sv_admin_audit(p_secret text, p_row jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  perform private.require(p_secret);
  insert into public.admin_audit (admin_id, actor_email, action, target_kind, target_id,
                                  payload, result, ip, ua)
  values (nullif(p_row->>'admin_id','')::uuid, p_row->>'actor_email', p_row->>'action',
          p_row->>'target_kind', p_row->>'target_id',
          coalesce(p_row->'payload','{}'::jsonb), p_row->>'result',
          left(coalesce(p_row->>'ip',''),60), left(coalesce(p_row->>'ua',''),300))
  returning id into v;
  return v;
end $$;

create or replace function public.sv_admin_audit_list(
  p_secret text, p_target_kind text, p_target_id text, p_limit integer, p_offset integer
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb; n bigint;
begin
  perform private.require(p_secret);
  select count(*) into n from public.admin_audit a
   where (p_target_kind is null or a.target_kind = p_target_kind)
     and (p_target_id  is null or a.target_id  = p_target_id);
  select coalesce(jsonb_agg(to_jsonb(x) order by x.at desc), '[]'::jsonb) into v from (
    select a.id, a.actor_email, a.action, a.target_kind, a.target_id, a.payload,
           a.result, a.ip, a.at
      from public.admin_audit a
     where (p_target_kind is null or a.target_kind = p_target_kind)
       and (p_target_id  is null or a.target_id  = p_target_id)
     order by a.at desc
     limit greatest(1, least(coalesce(p_limit,100), 500)) offset greatest(0, coalesce(p_offset,0))
  ) x;
  return jsonb_build_object('total', n, 'rows', v);
end $$;

-- ── events ───────────────────────────────────────────────────────────────────────────────────
create or replace function public.sv_admin_event(p_secret text, p_row jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  perform private.require(p_secret);
  insert into public.app_events (account_id, anon_id, session_id, name, page, meta, ua,
                                 ip_sha256, source)
  values (nullif(p_row->>'account_id','')::uuid, p_row->>'anon_id', p_row->>'session_id',
          p_row->>'name', p_row->>'page', coalesce(p_row->'meta','{}'::jsonb),
          left(coalesce(p_row->>'ua',''),400), p_row->>'ip_sha256',
          coalesce(p_row->>'source','web'))
  returning id into v;
  return v;
end $$;

-- Stitch anonymous pre-signup activity onto an account once the person identifies themselves.
create or replace function public.sv_admin_event_claim(
  p_secret text, p_anon_id text, p_account_id uuid
) returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  perform private.require(p_secret);
  update public.app_events set account_id = p_account_id
   where anon_id = p_anon_id and account_id is null;
  get diagnostics n = row_count;
  return n;
end $$;;
