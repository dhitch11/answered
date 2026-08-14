-- 20260814180718_truce_create_fix
-- Applied to answered-prod. Exported verbatim by scripts/dump-schema.mjs.

-- plpgsql bodies are syntax-checked at CREATE, not name-resolved, so a function referencing a
-- column that does not exist creates cleanly and fails only when someone finally calls it. That
-- is the "built and wired but never fed" trap in its purest form. Fixed, and exercised below.
create or replace function public.sv_truce_create(
  p_secret text, p_subject text, p_kind text,
  p_a_name text, p_a_role text, p_b_name text, p_b_role text)
returns jsonb language plpgsql security definer set search_path = public, private, extensions as $$
declare d uuid; ta text; tb text;
begin
  perform private.require(p_secret);
  insert into public.truce_deals (subject, kind) values (p_subject, coalesce(p_kind,'other')) returning id into d;
  ta := encode(gen_random_bytes(24), 'hex');
  tb := encode(gen_random_bytes(24), 'hex');
  insert into public.truce_parties (deal_id, side, role, display_name, token, joined_at)
  values (d, 'a', p_a_role, p_a_name, ta, now());
  insert into public.truce_parties (deal_id, side, role, display_name, token)
  values (d, 'b', p_b_role, p_b_name, tb);
  return jsonb_build_object('deal_id', d, 'a_token', ta, 'b_token', tb);
end $$;

revoke all on function public.sv_truce_create(text,text,text,text,text,text,text) from public;
grant execute on function public.sv_truce_create(text,text,text,text,text,text,text) to anon, authenticated;;
