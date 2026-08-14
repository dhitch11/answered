-- 20260814193825_recover_runtime_rpcs
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- ── RECOVER RPCs ────────────────────────────────────────────────────────────────────────────
-- Same door as everything else: security definer, private.require(secret), RLS untouched.

create or replace function public.sv_recover_upsert_invoice(p_secret text, p_row jsonb)
returns jsonb language plpgsql security definer set search_path to 'public','private' as $$
declare v public.recover_invoices%rowtype; existing public.recover_invoices%rowtype; v_band text;
begin
  perform private.require(p_secret);

  select * into existing from public.recover_invoices
   where account_key = lower(trim(p_row->>'account_key'))
     and invoice_number = trim(p_row->>'invoice_number')
   for update;

  v_band := coalesce(p_row->>'band', existing.band);

  -- ★ THE PRICE CANNOT MOVE AFTER WE HAVE DIALLED. /terms promises the band is shown before the
  -- first call; a band edited afterwards would make that promise unfalsifiable.
  if found and existing.first_call_at is not null and v_band is distinct from existing.band then
    return jsonb_build_object('error',
      'this invoice has already been called on band "' || existing.band ||
      '", and the band cannot change after the first call');
  end if;

  if found then
    update public.recover_invoices set
      business_name    = coalesce(p_row->>'business_name', business_name),
      business_phone   = coalesce(p_row->>'business_phone', business_phone),
      amount_cents     = coalesce((p_row->>'amount_cents')::int, amount_cents),
      issued_at        = coalesce((p_row->>'issued_at')::date, issued_at),
      due_at           = coalesce((p_row->>'due_at')::date, due_at),
      job_description  = coalesce(p_row->>'job_description', job_description),
      job_address      = coalesce(p_row->>'job_address', job_address),
      job_completed_on = coalesce((p_row->>'job_completed_on')::date, job_completed_on),
      debtor_name      = coalesce(p_row->>'debtor_name', debtor_name),
      debtor_phone     = coalesce(p_row->>'debtor_phone', debtor_phone),
      debtor_state     = coalesce(p_row->>'debtor_state', debtor_state),
      debtor_timezone  = coalesce(p_row->>'debtor_timezone', debtor_timezone),
      debtor_zone_source = coalesce(p_row->>'debtor_zone_source', debtor_zone_source),
      -- A band change BEFORE the first call restamps when it was shown, because that is when it
      -- was shown. Carrying the old timestamp forward would be a fabricated disclosure date.
      band             = v_band,
      band_shown_at    = case when v_band is distinct from existing.band then now() else band_shown_at end,
      fee_mode         = coalesce(p_row->>'fee_mode', fee_mode),
      fee_mode_reason  = coalesce(p_row->>'fee_mode_reason', fee_mode_reason),
      account_id       = coalesce((p_row->>'account_id')::uuid, account_id)
     where id = existing.id returning * into v;
    return jsonb_build_object('created', false, 'invoice', to_jsonb(v));
  end if;

  insert into public.recover_invoices (
    account_key, account_id, business_name, business_phone, invoice_number, amount_cents,
    issued_at, due_at, job_description, job_address, job_completed_on,
    debtor_name, debtor_phone, debtor_state, debtor_timezone, debtor_zone_source,
    band, band_shown_at, fee_mode, fee_mode_reason)
  values (
    lower(trim(p_row->>'account_key')), (p_row->>'account_id')::uuid,
    p_row->>'business_name', p_row->>'business_phone', trim(p_row->>'invoice_number'),
    (p_row->>'amount_cents')::int, (p_row->>'issued_at')::date, (p_row->>'due_at')::date,
    p_row->>'job_description', p_row->>'job_address', (p_row->>'job_completed_on')::date,
    p_row->>'debtor_name', p_row->>'debtor_phone', p_row->>'debtor_state',
    p_row->>'debtor_timezone', p_row->>'debtor_zone_source',
    p_row->>'band', coalesce((p_row->>'band_shown_at')::timestamptz, now()),
    coalesce(p_row->>'fee_mode','contingency'), p_row->>'fee_mode_reason')
  returning * into v;
  return jsonb_build_object('created', true, 'invoice', to_jsonb(v));
end $$;

-- The whole record: the invoice, every attempt, every promise, every dollar that landed.
create or replace function public.sv_recover_get(p_secret text, p_id uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public','private' as $$
declare v jsonb;
begin
  perform private.require(p_secret);
  select jsonb_build_object(
    'invoice', to_jsonb(i),
    'balance_cents', i.amount_cents - i.paid_cents,
    'calls', coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at desc)
                         from public.recover_calls c where c.invoice_id = i.id), '[]'::jsonb),
    'promises', coalesce((select jsonb_agg(to_jsonb(p) order by p.captured_at desc)
                         from public.recover_promises p where p.invoice_id = i.id), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(to_jsonb(y) order by y.landed_at desc)
                         from public.recover_payments y where y.invoice_id = i.id), '[]'::jsonb)
  ) into v from public.recover_invoices i where i.id = p_id;
  return coalesce(v, jsonb_build_object('error','no such invoice'));
end $$;

-- The facts the dial gate needs, counted in the database rather than trusted from a caller.
create or replace function public.sv_recover_gate_facts(p_secret text, p_id uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public','private' as $$
declare i public.recover_invoices%rowtype; v jsonb;
begin
  perform private.require(p_secret);
  select * into i from public.recover_invoices where id = p_id;
  if not found then return jsonb_build_object('error','no such invoice'); end if;
  select jsonb_build_object(
    'invoice', to_jsonb(i),
    'balance_cents', i.amount_cents - i.paid_cents,
    'placed_today', (select count(*) from public.recover_calls c
                      where c.invoice_id = i.id and c.placed and c.created_at > now() - interval '1 day'),
    'placed_7d',    (select count(*) from public.recover_calls c
                      where c.invoice_id = i.id and c.placed and c.created_at > now() - interval '7 days'),
    'placed_total', (select count(*) from public.recover_calls c where c.invoice_id = i.id and c.placed),
    'conversations_total', (select count(*) from public.recover_calls c
                      where c.invoice_id = i.id and c.identity_confirmed),
    'suppressed', exists (select 1 from public.suppression s where s.phone = i.debtor_phone)
                  or exists (select 1 from public.contacts c where c.phone = i.debtor_phone and c.suppressed),
    'open_promise', (select to_jsonb(p) from public.recover_promises p
                      where p.invoice_id = i.id and p.kept is null
                      order by p.captured_at desc limit 1)
  ) into v;
  return v;
end $$;

create or replace function public.sv_recover_log_call(p_secret text, p_row jsonb)
returns jsonb language plpgsql security definer set search_path to 'public','private' as $$
declare c public.recover_calls%rowtype;
begin
  perform private.require(p_secret);
  insert into public.recover_calls (
    invoice_id, call_sid, placed, refused_reason, gate, opening_spoken,
    from_number, to_number, status, disposition)
  values (
    (p_row->>'invoice_id')::uuid, p_row->>'call_sid',
    coalesce((p_row->>'placed')::boolean,false), p_row->>'refused_reason',
    coalesce(p_row->'gate','{}'::jsonb), p_row->>'opening_spoken',
    p_row->>'from_number', p_row->>'to_number', p_row->>'status', p_row->>'disposition')
  returning * into c;

  -- first_call_at is stamped ONLY by a call that was actually placed. meter.mjs compares it to
  -- band_shown_at, so letting a refusal stamp it would fabricate a disclosure ordering.
  if c.placed then
    update public.recover_invoices
       set first_call_at   = coalesce(first_call_at, now()),
           last_contact_at = now()
     where id = c.invoice_id;
  end if;
  return to_jsonb(c);
end $$;

create or replace function public.sv_recover_update_call(p_secret text, p_call_sid text, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path to 'public','private' as $$
declare c public.recover_calls%rowtype;
begin
  perform private.require(p_secret);
  update public.recover_calls set
    status             = coalesce(p_patch->>'status', status),
    answered_by        = coalesce(p_patch->>'answered_by', answered_by),
    duration_seconds   = coalesce((p_patch->>'duration_seconds')::int, duration_seconds),
    disposition        = coalesce(p_patch->>'disposition', disposition),
    identity_confirmed = coalesce((p_patch->>'identity_confirmed')::boolean, identity_confirmed),
    outcome            = outcome || coalesce(p_patch->'outcome','{}'::jsonb),
    ended_at           = coalesce((p_patch->>'ended_at')::timestamptz, ended_at)
   where call_sid = p_call_sid returning * into c;
  if not found then return jsonb_build_object('error','no such call'); end if;

  -- A confirmed identity means a real conversation happened about this debt. That timestamp is
  -- what the 7-day cooldown counts from, so it is written here and nowhere else.
  if c.identity_confirmed then
    update public.recover_invoices
       set last_conversation_at = now(), last_contact_at = now()
     where id = c.invoice_id;
  end if;
  return to_jsonb(c);
end $$;

create or replace function public.sv_recover_promise(p_secret text, p_row jsonb)
returns jsonb language plpgsql security definer set search_path to 'public','private' as $$
declare p public.recover_promises%rowtype;
begin
  perform private.require(p_secret);
  insert into public.recover_promises (invoice_id, call_sid, amount_cents, promised_for, spoken_text, method)
  values ((p_row->>'invoice_id')::uuid, p_row->>'call_sid', (p_row->>'amount_cents')::int,
          (p_row->>'promised_for')::date, p_row->>'spoken_text',
          coalesce(p_row->>'method','spoken_on_call'))
  returning * into p;

  -- The page promises "Thursday's follow up happens without you". next_action_at is that promise,
  -- as a column: nothing dials this invoice again until the day after the date they gave.
  update public.recover_invoices
     set status = case when status in ('open','promised') then 'promised' else status end,
         last_conversation_at = now(),
         last_contact_at = now(),
         next_action_at = (p.promised_for + 1)::timestamptz
   where id = p.invoice_id;
  return to_jsonb(p);
end $$;

create or replace function public.sv_recover_stop(p_secret text, p_id uuid, p_reason text, p_call_sid text, p_kind text)
returns jsonb language plpgsql security definer set search_path to 'public','private' as $$
declare i public.recover_invoices%rowtype;
begin
  perform private.require(p_secret);
  update public.recover_invoices
     set status = case when p_kind = 'dispute' then 'disputed' else 'stopped' end,
         stop_reason = p_reason,
         next_action_at = null,
         last_contact_at = now()
   where id = p_id returning * into i;
  if not found then return jsonb_build_object('error','no such invoice'); end if;

  -- A stop is a fact about the NUMBER, not about this invoice, so it is written to the estate-wide
  -- suppression list too. A dispute is not: it stops this debt, and says nothing about the person.
  if p_kind <> 'dispute' and i.debtor_phone ~ '^\+\d{8,15}$' then
    insert into public.suppression (phone, reason, source)
    values (i.debtor_phone, coalesce(p_reason,'stop requested on a recover call'), 'recover')
    on conflict (phone) do nothing;
  end if;
  return to_jsonb(i);
end $$;

create or replace function public.sv_recover_payment(p_secret text, p_row jsonb)
returns jsonb language plpgsql security definer set search_path to 'public','private' as $$
declare i public.recover_invoices%rowtype; y public.recover_payments%rowtype;
        v_promise public.recover_promises%rowtype; v_placed int; v_conv int;
begin
  perform private.require(p_secret);
  select * into i from public.recover_invoices where id = (p_row->>'invoice_id')::uuid for update;
  if not found then return jsonb_build_object('error','no such invoice'); end if;

  select * into y from public.recover_payments where idem_key = p_row->>'idem_key';
  if not found then
    insert into public.recover_payments (invoice_id, amount_cents, landed_at, source, reference, recorded_by, idem_key)
    values (i.id, (p_row->>'amount_cents')::int,
            coalesce((p_row->>'landed_at')::timestamptz, now()),
            coalesce(p_row->>'source','operator_confirmed'), p_row->>'reference',
            p_row->>'recorded_by', p_row->>'idem_key')
    returning * into y;

    update public.recover_invoices
       set paid_cents = paid_cents + y.amount_cents,
           status = case when paid_cents + y.amount_cents >= amount_cents then 'paid' else status end
     where id = i.id returning * into i;
  end if;

  select * into v_promise from public.recover_promises
   where invoice_id = i.id and captured_at <= y.landed_at order by captured_at desc limit 1;
  select count(*) into v_placed from public.recover_calls where invoice_id = i.id and placed;
  select count(*) into v_conv   from public.recover_calls where invoice_id = i.id and identity_confirmed;

  return jsonb_build_object(
    'replay', (p_row->>'idem_key') is not null and y.created_at < now() - interval '1 second',
    'payment', to_jsonb(y),
    'invoice', to_jsonb(i),
    'balance_cents', i.amount_cents - i.paid_cents,
    'placed_calls', v_placed,
    'conversations', v_conv,
    -- Everything meter.mjs needs to rate this, read from the record rather than passed in by a caller.
    'meter_inputs', jsonb_build_object(
      'recovered_cents', y.amount_cents,
      'band', i.band,
      'band_shown_at', i.band_shown_at,
      'first_call_at', i.first_call_at,
      'last_contact_at', i.last_contact_at,
      'landed_at', y.landed_at,
      'fee_mode', i.fee_mode),
    -- ★ SPOKEN IS NOT WRITTEN. /terms extends the window only "by a date the payer promised IN
    -- WRITING". A promise captured from speech is returned here for the operator to see, and it is
    -- deliberately NOT offered to the meter as promised_by. See the note in netlify/functions/recover.mjs.
    'spoken_promise', case when v_promise.id is null then null else to_jsonb(v_promise) end
  );
end $$;

create or replace function public.sv_recover_payment_rated(p_secret text, p_payment_id uuid, p_rating jsonb, p_billing_event uuid)
returns jsonb language plpgsql security definer set search_path to 'public','private' as $$
declare y public.recover_payments%rowtype;
begin
  perform private.require(p_secret);
  update public.recover_payments set fee_rated = p_rating, billing_event_id = p_billing_event
   where id = p_payment_id returning * into y;
  if not found then return jsonb_build_object('error','no such payment'); end if;
  return to_jsonb(y);
end $$;

create or replace function public.sv_recover_board(p_secret text, p_account_key text, p_status text, p_limit integer, p_offset integer)
returns jsonb language plpgsql stable security definer set search_path to 'public','private' as $$
declare v jsonb;
begin
  perform private.require(p_secret);
  select jsonb_build_object(
    'totals', (select jsonb_build_object(
        'invoices', count(*),
        'open_cents', coalesce(sum(amount_cents - paid_cents) filter (where status in ('open','promised')),0),
        'recovered_cents', coalesce(sum(paid_cents),0),
        'stopped', count(*) filter (where status = 'stopped'),
        'disputed', count(*) filter (where status = 'disputed'))
      from public.recover_invoices
      where (p_account_key is null or account_key = lower(p_account_key))),
    'invoices', coalesce((select jsonb_agg(x order by x->>'created_at' desc) from (
        select jsonb_build_object(
          'id', i.id, 'account_key', i.account_key, 'business_name', i.business_name,
          'invoice_number', i.invoice_number, 'amount_cents', i.amount_cents,
          'paid_cents', i.paid_cents, 'balance_cents', i.amount_cents - i.paid_cents,
          'debtor_name', i.debtor_name, 'debtor_phone', i.debtor_phone, 'debtor_state', i.debtor_state,
          'band', i.band, 'fee_mode', i.fee_mode, 'status', i.status,
          'issued_at', i.issued_at, 'first_call_at', i.first_call_at,
          'last_contact_at', i.last_contact_at, 'next_action_at', i.next_action_at,
          'created_at', i.created_at,
          'calls_placed', (select count(*) from public.recover_calls c where c.invoice_id = i.id and c.placed),
          'calls_refused', (select count(*) from public.recover_calls c where c.invoice_id = i.id and not c.placed),
          'promises', (select count(*) from public.recover_promises p where p.invoice_id = i.id)
        ) as x
        from public.recover_invoices i
        where (p_account_key is null or i.account_key = lower(p_account_key))
          and (p_status is null or i.status = p_status)
        order by i.created_at desc
        limit coalesce(p_limit,50) offset coalesce(p_offset,0)) s), '[]'::jsonb)
  ) into v;
  return v;
end $$;;
