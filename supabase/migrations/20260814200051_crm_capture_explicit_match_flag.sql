-- 20260814200051_crm_capture_explicit_match_flag
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- sv_crm_capture, corrected.
--
-- ★ THE BUG, AND IT IS A GOOD ONE. This function relied on PL/pgSQL's implicit `FOUND` to decide
-- whether it had matched an existing contact. But `FOUND` is set by ANY statement that touches
-- rows, and the very first thing this function does is
--
--     insert into crm_intake_raw (...) returning id into v_raw_id;
--
-- which sets FOUND = true. So `if not found then <look up by email>` was false, the lookup never
-- ran, `if not found then <create>` was also false, and control fell into the ELSE branch which
-- updated `where id = c.id` with an empty record. Two different symptoms from one cause:
--   - an email-only capture crashed with 23502 on crm_identities.contact_id, because c.id was null
--   - a capture with no phone and no email returned ok:true with every field null, instead of the
--     refusal it was written to give
--
-- Both were caught because the test asserted on `matched_on` and on the refusal, rather than on
-- the 200. A test that checked only the status code would have passed on a function that silently
-- matched nothing and created nothing.
--
-- FIX: an explicit v_hit boolean, set only by the lookups themselves. FOUND is never read.

create or replace function public.sv_crm_capture(p_secret text, p_row jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c         public.contacts%rowtype;
  v_phone   text;
  v_email   text;
  v_source  text;
  v_matched text;
  v_created boolean := false;
  v_hit     boolean := false;   -- never FOUND: see the note above
  v_raw_id  bigint;
  v_title   text;
begin
  perform private.require(p_secret);
  v_source := coalesce(nullif(trim(p_row->>'source'), ''), 'unknown');

  insert into public.crm_intake_raw (source, external_id, payload)
  values (v_source, nullif(p_row->>'external_id',''), p_row)
  returning id into v_raw_id;

  v_phone := nullif(regexp_replace(coalesce(p_row->>'phone',''), '[^0-9+]', '', 'g'), '');
  if v_phone is not null and v_phone !~ '^\+' and length(v_phone) = 10 then
    v_phone := '+1' || v_phone;
  elsif v_phone is not null and v_phone !~ '^\+' and length(v_phone) = 11 and left(v_phone,1) = '1' then
    v_phone := '+' || v_phone;
  end if;
  if v_phone is not null and v_phone !~ '^\+\d{8,15}$' then v_phone := null; end if;

  v_email := nullif(lower(trim(coalesce(p_row->>'email',''))), '');
  if v_email is not null and position('@' in v_email) < 2 then v_email := null; end if;

  if v_phone is not null then
    select * into c from public.contacts where phone = v_phone limit 1;
    if c.id is not null then v_hit := true; v_matched := 'phone'; end if;
  end if;
  if not v_hit and v_email is not null then
    select * into c from public.contacts where lower(email) = v_email limit 1;
    if c.id is not null then v_hit := true; v_matched := 'email'; end if;
  end if;
  if not v_hit and nullif(p_row->>'contact_id','') is not null then
    select * into c from public.contacts where id = (p_row->>'contact_id')::uuid limit 1;
    if c.id is not null then v_hit := true; v_matched := 'contact_id'; end if;
  end if;

  if not v_hit then
    if v_phone is null and v_email is null then
      update public.crm_intake_raw
         set note = 'refused: no usable phone or email to identify this record'
       where id = v_raw_id;
      return jsonb_build_object('ok', false, 'raw_id', v_raw_id, 'created', false,
        'error', 'a new CRM record needs at least a usable phone or an email. The payload is kept in crm_intake_raw so nothing is lost.');
    end if;
    insert into public.contacts (
      phone, name, trade, state, city, street, website, source, source_id,
      contact_name, contact_role, email, linkedin_url, disposition, owner, tags,
      first_seen_via, intake_count
    ) values (
      coalesce(v_phone, 'email:' || v_email),
      nullif(trim(coalesce(p_row->>'name','')), ''),
      nullif(p_row->>'trade',''), nullif(upper(p_row->>'state'),''), nullif(p_row->>'city',''),
      nullif(p_row->>'street',''), nullif(p_row->>'website',''),
      v_source, nullif(p_row->>'external_id',''),
      nullif(p_row->>'contact_name',''), nullif(p_row->>'contact_role',''),
      v_email, nullif(p_row->>'linkedin_url',''),
      coalesce(nullif(p_row->>'disposition',''), 'new'),
      nullif(p_row->>'owner',''),
      coalesce((select array_agg(t) from jsonb_array_elements_text(p_row->'tags') t), '{}'),
      v_source, 1
    ) returning * into c;
    v_created := true; v_matched := 'created';
  else
    update public.contacts set
      name         = coalesce(name, nullif(trim(coalesce(p_row->>'name','')),'')),
      trade        = coalesce(trade, nullif(p_row->>'trade','')),
      state        = coalesce(state, nullif(upper(p_row->>'state'),'')),
      city         = coalesce(city, nullif(p_row->>'city','')),
      street       = coalesce(street, nullif(p_row->>'street','')),
      website      = coalesce(website, nullif(p_row->>'website','')),
      contact_name = coalesce(contact_name, nullif(p_row->>'contact_name','')),
      contact_role = coalesce(contact_role, nullif(p_row->>'contact_role','')),
      email        = coalesce(email, v_email),
      linkedin_url = coalesce(linkedin_url, nullif(p_row->>'linkedin_url','')),
      tags         = array(select distinct unnest(
                        tags || coalesce((select array_agg(t) from jsonb_array_elements_text(p_row->'tags') t), '{}'))),
      intake_count = intake_count + 1,
      updated_at   = now()
    where id = c.id returning * into c;
  end if;

  update public.crm_intake_raw
     set contact_id = c.id, matched_on = v_matched, created = v_created
   where id = v_raw_id;

  if v_phone is not null then
    insert into public.crm_identities (contact_id, kind, value, source, verified)
    values (c.id, 'phone', v_phone, v_source, true) on conflict do nothing;
  end if;
  if v_email is not null then
    insert into public.crm_identities (contact_id, kind, value, source)
    values (c.id, 'email', v_email, v_source) on conflict do nothing;
  end if;
  if nullif(p_row->>'website','') is not null then
    insert into public.crm_identities (contact_id, kind, value, source)
    values (c.id, 'website', p_row->>'website', v_source) on conflict do nothing;
  end if;
  if nullif(p_row->>'external_id','') is not null then
    insert into public.crm_identities (contact_id, kind, value, label, source)
    values (c.id, 'external', p_row->>'external_id', v_source, v_source) on conflict do nothing;
  end if;

  v_title := coalesce(nullif(p_row->>'title',''),
    case when v_created then 'First seen via ' || v_source else 'Seen again via ' || v_source end);
  insert into public.crm_activity (contact_id, account_id, kind, title, body, payload, source, actor,
                                   ref_kind, ref_id)
  values (c.id, nullif(p_row->>'account_id','')::uuid,
          coalesce(nullif(p_row->>'kind',''), 'intake'), v_title,
          nullif(p_row->>'body',''), p_row, v_source, nullif(p_row->>'actor',''),
          nullif(p_row->>'ref_kind',''), nullif(p_row->>'ref_id',''));

  return jsonb_build_object(
    'ok', true, 'contact_id', c.id, 'created', v_created, 'matched_on', v_matched,
    'raw_id', v_raw_id, 'intake_count', c.intake_count, 'phone', c.phone, 'name', c.name);
end $$;;
