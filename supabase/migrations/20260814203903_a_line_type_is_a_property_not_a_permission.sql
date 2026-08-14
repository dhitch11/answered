-- 20260814203903_a_line_type_is_a_property_not_a_permission
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- ★ A LINE TYPE IS A PROPERTY OF A PHONE NUMBER. PERMISSION IS A CONCLUSION ABOUT A MOMENT.
--
-- I shipped a defect this afternoon and a review pass caught it. The Leads list computed
--     ai_dialable := line_type in ('landline','fixedVoip')
-- and rendered it as a chip labelled "AI-callable lines" with a "callable" pill on 1,212 rows.
-- Meanwhile sv_crm_outreach_state — the per-record authority the drawer actually uses — returns
-- call.ok = FALSE for every contact in this database, because dnc_registry has zero rows and the
-- registry scrub is a condition precedent.
--
-- So the list said 1,212 were callable and the record said none were. Two surfaces of one console
-- disagreeing, and the list is the one an operator plans a shift from. It is the same shape as the
-- billing panel that printed "no billing accounts" above "97 charges", and I wrote both.
--
-- THE FIX IS NOT A BETTER LABEL, IT IS THE RIGHT NOUN. The column is renamed to what it actually
-- measures — the line is a fixed business line — and a SECOND field is added that carries the real
-- permission, computed from the same gate the record view uses. The list and the record now read
-- the same authority, so they cannot drift apart again.

create or replace function public.sv_admin_contact_facets(p_secret text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_dnc jsonb; v_gate_open boolean;
begin
  perform private.require(p_secret);

  begin
    v_dnc := public.sv_dnc_readiness(p_secret);
  exception when others then
    v_dnc := jsonb_build_object('scrub_ready', false, 'procedures_ready', false);
  end;
  -- The same condition the per-record preflight applies. One authority, two surfaces.
  v_gate_open := coalesce((v_dnc->>'scrub_ready')::boolean, false)
             and coalesce((v_dnc->>'procedures_ready')::boolean, false);

  return jsonb_build_object(
    'total',        (select count(*) from public.contacts),
    -- A PROPERTY of the number. Renamed from ai_dialable, which read as permission.
    'fixed_line',   (select count(*) from public.contacts
                      where line_type in ('landline','fixedVoip')),
    -- The PERMISSION, right now. Zero while the registry is unloaded, and that is correct.
    'callable_now', case when v_gate_open
                      then (select count(*) from public.contacts
                             where line_type in ('landline','fixedVoip')
                               and not coalesce(suppressed, false))
                      else 0 end,
    'callable_blocked_because',
      case when v_gate_open then null
           when not coalesce((v_dnc->>'scrub_ready')::boolean, false)
             then 'The national do-not-call registry has never been loaded, so no number can be proven absent from it. Until then nothing is cold-callable, whatever its line type.'
           else 'The written do-not-call procedures required by 47 CFR 64.1200(d) are not all in place.' end,
    'emailable_now',(select count(*) from public.contacts
                      where email is not null and not coalesce(suppressed, false)),
    'textable_line',(select count(*) from public.contacts
                      where line_type in ('mobile','nonFixedVoip')),
    'suppressed',   (select count(*) from public.contacts where coalesce(suppressed,false)),
    'enriched',     (select count(*) from public.contacts where enriched_at is not null),
    'with_email',   (select count(*) from public.contacts where email is not null),
    'with_website', (select count(*) from public.contacts where website is not null),
    'websites_unread', (select count(*) from public.contacts
                         where website is not null and enriched_at is null),
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

-- ★ DROP THE OVERLOAD. Two live functions shared the name sv_admin_contacts: one taking 14
-- arguments and one taking 15. PostgREST picks by the argument set it is given, so a caller that
-- omitted p_has_email silently executed the OLDER body, with a different filter set and a
-- different count. It worked today by luck. An overload is a coin flip that does not appear in a
-- diff, and the losing side of it is a wrong number on a screen.
drop function if exists public.sv_admin_contacts(
  text, text, text, text, text, text, text, text, text, boolean, boolean, text, integer, integer);

comment on function public.sv_admin_contact_facets(text) is
  'fixed_line is a PROPERTY of the phone number. callable_now is a PERMISSION and is computed from the same do-not-call gate the per-record preflight uses, so the list and the record cannot drift apart. They did: the list once claimed 1,212 callable while every record said none were.';;
