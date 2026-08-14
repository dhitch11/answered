-- 20260814183248_admin_console_rpcs_reads
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- The console's reads. Every one is paginated and bounded at the database, because a console
-- built for hundreds of thousands of customers must never be able to ask for all of them.
-- Counts come back with the page so the UI never has to guess a total or say "many".

create or replace function public.sv_admin_overview(p_secret text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  perform private.require(p_secret);
  select jsonb_build_object(
    'at', now(),
    'accounts', jsonb_build_object(
      'total',        (select count(*) from public.accounts),
      'live',         (select count(*) from public.accounts where status = 'live'),
      'awaiting_line',(select count(*) from public.accounts where status = 'awaiting_line'),
      'configuring',  (select count(*) from public.accounts where status = 'configuring'),
      'ready',        (select count(*) from public.accounts where status = 'ready'),
      'draft',        (select count(*) from public.accounts where status = 'draft'),
      'paused',       (select count(*) from public.accounts where status = 'paused'),
      'closed',       (select count(*) from public.accounts where status = 'closed'),
      'new_7d',       (select count(*) from public.accounts where created_at > now() - interval '7 days'),
      'new_30d',      (select count(*) from public.accounts where created_at > now() - interval '30 days')
    ),
    'calls', jsonb_build_object(
      'total',        (select count(*) from public.calls),
      'placed',       (select count(*) from public.calls where placed),
      'refused',      (select count(*) from public.calls where not placed),
      'inbound',      (select count(*) from public.calls where direction = 'inbound'),
      'outbound',     (select count(*) from public.calls where direction = 'outbound'),
      'with_recording',(select count(*) from public.calls where recording_sid is not null),
      'attributed',   (select count(*) from public.calls where account_id is not null),
      'last_24h',     (select count(*) from public.calls where created_at > now() - interval '24 hours'),
      'last_7d',      (select count(*) from public.calls where created_at > now() - interval '7 days'),
      'last_at',      (select max(created_at) from public.calls)
    ),
    'billing', jsonb_build_object(
      'accounts',      (select count(*) from public.billing_accounts),
      'with_card',     (select count(*) from public.billing_accounts where card_on_file),
      'events',        (select count(*) from public.billing_events),
      'open_cents',    (select coalesce(sum(cents),0) from public.billing_events where state = 'open'),
      'paid_cents',    (select coalesce(sum(cents),0) from public.billing_events where state = 'paid'),
      'voided',        (select count(*) from public.billing_events where state = 'voided'),
      'invoices',      (select count(*) from public.billing_invoices),
      'refunds',       (select count(*) from public.billing_refunds),
      'refunded_cents',(select coalesce(sum(amount_cents),0) from public.billing_refunds
                         where status in ('succeeded','recorded_offline'))
    ),
    'events', jsonb_build_object(
      'total',   (select count(*) from public.app_events),
      'last_24h',(select count(*) from public.app_events where at > now() - interval '24 hours'),
      'last_at', (select max(at) from public.app_events),
      'attributed',(select count(*) from public.app_events where account_id is not null)
    ),
    'parley', jsonb_build_object(
      'deals',     (select count(*) from public.truce_deals),
      'settled',   (select count(*) from public.truce_deals where status = 'settled'),
      'no_overlap',(select count(*) from public.truce_deals where status = 'no_overlap'),
      'signatures',(select count(*) from public.truce_signatures)
    ),
    'pipeline', jsonb_build_object(
      'contacts',    (select count(*) from public.contacts),
      'suppressed',  (select count(*) from public.contacts where suppressed),
      'suppression_list',(select count(*) from public.suppression),
      'consent_rows',(select count(*) from public.consent),
      'lines',       (select count(*) from public.lines),
      'campaigns_running',(select count(*) from public.campaigns where status = 'running')
    ),
    'operators', jsonb_build_object(
      'total',   (select count(*) from public.admin_users),
      'active',  (select count(*) from public.admin_users where status = 'active'),
      'sessions_live',(select count(*) from public.admin_sessions
                        where revoked_at is null and expires_at > now())
    )
  ) into v;
  return v;
end $$;

-- The customer list. One row per business, carrying everything the list column needs so the UI
-- never fires a query per row.
create or replace function public.sv_admin_accounts(
  p_secret text, p_q text, p_status text, p_sort text, p_limit integer, p_offset integer
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb; n bigint; lim integer; off integer;
begin
  perform private.require(p_secret);
  lim := greatest(1, least(coalesce(p_limit, 50), 200));
  off := greatest(0, coalesce(p_offset, 0));

  select count(*) into n from public.accounts a
   where (p_status is null or a.status = p_status)
     and (p_q is null or p_q = '' or (
          a.business_name ilike '%'||p_q||'%' or a.owner_email ilike '%'||p_q||'%'
       or coalesce(a.owner_name,'') ilike '%'||p_q||'%'
       or coalesce(a.owner_phone,'') ilike '%'||p_q||'%'
       or a.id::text = p_q));

  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v from (
    select a.id, a.business_name, a.owner_email, a.owner_name, a.owner_phone, a.trade,
           a.status, a.timezone, a.created_at, a.email_verified_at, a.ready_at,
           a.requested_line_at, a.live_at, a.wanted_area_code,
           (select an.phone from public.account_numbers an
             where an.account_id = a.id and an.status = 'provisioned'
             order by an.provisioned_at limit 1)                       as phone,
           (select count(*) from public.calls c where c.account_id = a.id)        as calls,
           (select count(*) from public.calls c
             where c.account_id = a.id and c.recording_sid is not null)           as recordings,
           (select max(c.created_at) from public.calls c where c.account_id = a.id) as last_call_at,
           (select count(*) from public.app_events e where e.account_id = a.id)   as events,
           (select max(e.at) from public.app_events e where e.account_id = a.id)  as last_seen_at,
           b.account_key, b.plan, b.cap_cents, b.card_on_file, b.card_brand, b.card_last4,
           b.status                                                              as billing_status,
           coalesce(v2.charged_cents, 0)                                         as charged_cents,
           coalesce(v2.unbilled_cents, 0)                                        as unbilled_cents,
           coalesce(v2.credit_balance_cents, 0)                                  as credit_cents,
           coalesce(v2.refunded_cents, 0)                                        as refunded_cents
      from public.accounts a
      left join public.billing_accounts b   on b.account_id = a.id
      left join public.v_account_balance v2 on v2.billing_account_id = b.id
     where (p_status is null or a.status = p_status)
       and (p_q is null or p_q = '' or (
            a.business_name ilike '%'||p_q||'%' or a.owner_email ilike '%'||p_q||'%'
         or coalesce(a.owner_name,'') ilike '%'||p_q||'%'
         or coalesce(a.owner_phone,'') ilike '%'||p_q||'%'
         or a.id::text = p_q))
     order by
       case when coalesce(p_sort,'recent') = 'recent'  then a.created_at end desc nulls last,
       case when p_sort = 'oldest'                     then a.created_at end asc  nulls last,
       case when p_sort = 'name'                       then lower(a.business_name) end asc,
       a.created_at desc
     limit lim offset off
  ) x;

  return jsonb_build_object('total', n, 'limit', lim, 'offset', off, 'rows', v);
end $$;

-- One customer, everything an operator needs on one screen and nothing that belongs to another.
create or replace function public.sv_admin_account(p_secret text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.accounts%rowtype; b public.billing_accounts%rowtype; v jsonb;
begin
  perform private.require(p_secret);
  select * into a from public.accounts where id = p_id;
  if not found then return null; end if;
  select * into b from public.billing_accounts where account_id = p_id;

  select jsonb_build_object(
    'account', to_jsonb(a),
    'config',  (select to_jsonb(c) from public.account_config c where c.account_id = p_id),
    'config_versions', (select coalesce(jsonb_agg(jsonb_build_object(
                          'version', cv.version, 'author', cv.author, 'at', cv.at) order by cv.at desc), '[]'::jsonb)
                        from public.account_config_versions cv where cv.account_id = p_id),
    'numbers', (select coalesce(jsonb_agg(to_jsonb(an) order by an.provisioned_at desc), '[]'::jsonb)
                  from public.account_numbers an where an.account_id = p_id),
    'timeline',(select coalesce(jsonb_agg(jsonb_build_object(
                        'kind', ae.kind, 'payload', ae.payload, 'actor', ae.actor, 'at', ae.at)
                        order by ae.at desc), '[]'::jsonb)
                  from (select * from public.account_events where account_id = p_id
                         order by at desc limit 100) ae),
    'billing', case when b.id is null then null else jsonb_build_object(
        'account_key', b.account_key, 'plan', b.plan, 'cap_cents', b.cap_cents,
        'pending_cap_cents', b.pending_cap_cents, 'pending_cap_month', b.pending_cap_month,
        'status', b.status, 'card_on_file', b.card_on_file, 'card_brand', b.card_brand,
        'card_last4', b.card_last4, 'stripe_customer_id', b.stripe_customer_id,
        'quiet_notice_at', b.quiet_notice_at, 'created_at', b.created_at,
        'balance', (select to_jsonb(vb) from public.v_account_balance vb where vb.billing_account_id = b.id)
      ) end,
    'charges', case when b.id is null then '[]'::jsonb else
      (select coalesce(jsonb_agg(to_jsonb(e) order by e.occurred_at desc), '[]'::jsonb)
         from (select id, idem_key, kind, product, label, occurred_at, cycle_month,
                      gross_cents, cents, credit_applied_cents, credit_created_cents,
                      billable, rated_ok, counts_toward_cap, reason, state, voided_at,
                      void_reason, stripe_invoice_id
                 from public.billing_events where account_id = b.id
                order by occurred_at desc limit 200) e) end,
    'invoices', case when b.id is null then '[]'::jsonb else
      (select coalesce(jsonb_agg(to_jsonb(i) order by i.created_at desc), '[]'::jsonb)
         from public.billing_invoices i where i.account_id = b.id) end,
    'refunds', case when b.id is null then '[]'::jsonb else
      (select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc), '[]'::jsonb)
         from public.billing_refunds r where r.account_id = b.id) end,
    'calls', (select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at desc), '[]'::jsonb)
                from (select id, call_sid, direction, from_number, to_number, status,
                             answered_by, duration_seconds, recording_sid, recording_seconds,
                             summary, sentiment, disposition, placed, refused_reason,
                             cost_usd, created_at
                        from public.calls where account_id = p_id
                       order by created_at desc limit 100) c),
    'usage', (select jsonb_build_object(
                'calls_total',   count(*),
                'calls_30d',     count(*) filter (where created_at > now() - interval '30 days'),
                'calls_7d',      count(*) filter (where created_at > now() - interval '7 days'),
                'recordings',    count(*) filter (where recording_sid is not null),
                'talk_seconds',  coalesce(sum(duration_seconds), 0),
                'first_call_at', min(created_at), 'last_call_at', max(created_at))
                from public.calls where account_id = p_id),
    'events_recent', (select coalesce(jsonb_agg(jsonb_build_object(
                        'name', e.name, 'page', e.page, 'meta', e.meta, 'source', e.source, 'at', e.at)
                        order by e.at desc), '[]'::jsonb)
                        from (select * from public.app_events where account_id = p_id
                               order by at desc limit 100) e),
    'events_rollup', (select coalesce(jsonb_agg(jsonb_build_object(
                        'name', g.name, 'n', g.n, 'last_at', g.last_at) order by g.n desc), '[]'::jsonb)
                        from (select name, count(*) as n, max(at) as last_at
                                from public.app_events where account_id = p_id
                               group by name) g),
    'audit', (select coalesce(jsonb_agg(jsonb_build_object(
                'actor_email', au.actor_email, 'action', au.action, 'payload', au.payload,
                'result', au.result, 'at', au.at) order by au.at desc), '[]'::jsonb)
                from (select * from public.admin_audit
                       where target_kind = 'account' and target_id = p_id::text
                       order by at desc limit 50) au)
  ) into v;
  return v;
end $$;

-- Calls and recordings, filterable, with the account joined so the list can say who it belongs to.
create or replace function public.sv_admin_calls(
  p_secret text, p_account uuid, p_q text, p_direction text, p_recorded boolean,
  p_limit integer, p_offset integer
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb; n bigint; lim integer; off integer;
begin
  perform private.require(p_secret);
  lim := greatest(1, least(coalesce(p_limit, 50), 200));
  off := greatest(0, coalesce(p_offset, 0));

  select count(*) into n from public.calls c
   where (p_account is null or c.account_id = p_account)
     and (p_direction is null or c.direction = p_direction)
     and (p_recorded is null or (c.recording_sid is not null) = p_recorded)
     and (p_q is null or p_q = '' or c.call_sid = p_q or c.from_number ilike '%'||p_q||'%'
          or c.to_number ilike '%'||p_q||'%' or coalesce(c.summary,'') ilike '%'||p_q||'%');

  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v from (
    select c.id, c.call_sid, c.account_id, a.business_name, c.contact_id, ct.name as contact_name,
           c.direction, c.from_number, c.to_number, c.status, c.answered_by,
           c.duration_seconds, c.recording_sid, c.recording_seconds, c.summary, c.sentiment,
           c.disposition, c.placed, c.refused_reason, c.cost_usd, c.created_at,
           (select count(*) from public.transcript_lines t where t.call_sid = c.call_sid) as transcript_lines
      from public.calls c
      left join public.accounts a on a.id = c.account_id
      left join public.contacts ct on ct.id = c.contact_id
     where (p_account is null or c.account_id = p_account)
       and (p_direction is null or c.direction = p_direction)
       and (p_recorded is null or (c.recording_sid is not null) = p_recorded)
       and (p_q is null or p_q = '' or c.call_sid = p_q or c.from_number ilike '%'||p_q||'%'
            or c.to_number ilike '%'||p_q||'%' or coalesce(c.summary,'') ilike '%'||p_q||'%')
     order by c.created_at desc
     limit lim offset off
  ) x;
  return jsonb_build_object('total', n, 'limit', lim, 'offset', off, 'rows', v);
end $$;

create or replace function public.sv_admin_call(p_secret text, p_call_sid text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  perform private.require(p_secret);
  select jsonb_build_object(
    'call', (select to_jsonb(c) from public.calls c where c.call_sid = p_call_sid),
    'account', (select jsonb_build_object('id', a.id, 'business_name', a.business_name,
                                          'owner_email', a.owner_email)
                  from public.calls c join public.accounts a on a.id = c.account_id
                 where c.call_sid = p_call_sid),
    'transcript', (select coalesce(jsonb_agg(jsonb_build_object(
                     'seq', t.seq, 'speaker', t.speaker, 'text', t.text,
                     'is_final', t.is_final, 'at', t.at) order by t.seq, t.id), '[]'::jsonb)
                     from public.transcript_lines t where t.call_sid = p_call_sid),
    'events', (select coalesce(jsonb_agg(jsonb_build_object(
                 'kind', e.kind, 'payload', e.payload, 'at', e.at) order by e.at), '[]'::jsonb)
                 from public.call_events e where e.call_sid = p_call_sid)
  ) into v;
  return v;
end $$;

-- Behavioural analytics, aggregated in the database. The console never pulls raw rows to count
-- them: at hundreds of thousands of customers that is the difference between a page and an outage.
create or replace function public.sv_admin_events(
  p_secret text, p_account uuid, p_name text, p_since timestamptz, p_limit integer, p_offset integer
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb; n bigint; lim integer; off integer; since timestamptz;
begin
  perform private.require(p_secret);
  lim := greatest(1, least(coalesce(p_limit, 100), 500));
  off := greatest(0, coalesce(p_offset, 0));
  since := coalesce(p_since, now() - interval '30 days');

  select count(*) into n from public.app_events e
   where e.at >= since and (p_account is null or e.account_id = p_account)
     and (p_name is null or e.name = p_name);

  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v from (
    select e.id, e.name, e.page, e.meta, e.source, e.at, e.account_id, e.anon_id,
           a.business_name
      from public.app_events e
      left join public.accounts a on a.id = e.account_id
     where e.at >= since and (p_account is null or e.account_id = p_account)
       and (p_name is null or e.name = p_name)
     order by e.at desc limit lim offset off
  ) x;

  return jsonb_build_object(
    'total', n, 'limit', lim, 'offset', off, 'since', since, 'rows', v,
    'by_name', (select coalesce(jsonb_agg(jsonb_build_object(
                  'name', g.name, 'n', g.n, 'accounts', g.accts, 'last_at', g.last_at)
                  order by g.n desc), '[]'::jsonb)
                from (select name, count(*) as n, count(distinct account_id) as accts,
                             max(at) as last_at
                        from public.app_events where at >= since
                         and (p_account is null or account_id = p_account)
                       group by name) g),
    'by_day', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'n', d.n)
                 order by d.day), '[]'::jsonb)
               from (select date_trunc('day', at)::date as day, count(*) as n
                       from public.app_events where at >= since
                        and (p_account is null or account_id = p_account)
                      group by 1) d)
  );
end $$;

-- Parley, through the projection that cannot reach a sealed limit.
create or replace function public.sv_admin_parley(p_secret text, p_limit integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  perform private.require(p_secret);
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb) into v from (
    select d.id, d.subject, d.kind, d.status, d.settled_value, d.fee_cents,
           d.created_at, d.settled_at, d.expires_at,
           (select count(*) from public.truce_parties p where p.deal_id = d.id and p.joined_at is not null) as joined,
           (select count(*) from public.truce_parties p where p.deal_id = d.id and p.limit_set_at is not null) as ready,
           (select count(*) from public.truce_signatures s where s.deal_id = d.id) as signatures,
           (select count(*) from public.truce_messages m where m.deal_id = d.id) as messages,
           (d.status = 'settled'
             and (select count(*) from public.truce_signatures s where s.deal_id = d.id) >= 2) as billable
      from public.truce_deals d
     order by d.created_at desc
     limit greatest(1, least(coalesce(p_limit, 100), 500))
  ) x;
  return v;
end $$;;
