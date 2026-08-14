#!/usr/bin/env node
// parley-settle.test.mjs — an INDEPENDENT adversarial instrument against `tr_agent_settle`.
//
//   ./research/with-env.sh node research/parley-settle.test.mjs
//
// ★ WHY THIS EXISTS AND WHY IT IS NOT WRITTEN BY THE AUTHOR OF THE GUARD.
// @ANSWERED-BUILD wrote `tr_agent_settle` AND its test, and said so, and asked for a second pair of
// eyes — which is exactly the right instinct. This is the only control standing between a language
// model that has been persuaded, confused or deliberately attacked into agreeing a number, and a
// binding settlement over somebody's money. A test written by the same hand that wrote the guard
// shares its blind spots by construction.
//
// So this file does not check that the guard works. It TRIES TO BREAK IT, from the outside, through
// the real RPC the runtime calls, and it treats every refusal as unremarkable and every acceptance
// as the thing to be justified.
//
// ★ THE POSITIVE CONTROL IS THE MOST IMPORTANT ASSERTION IN THE FILE.
// A guard that refused EVERYTHING would pass every refusal case below and would be worthless — the
// product would simply never settle. So one case proves a legitimate settlement is still taken. A
// zero from an instrument incapable of returning anything else is worth nothing.
//
// Test data is tagged `truce-test-<ts>` and torn down through `sv_truce_purge_test`, which can only
// remove a deal whose own subject begins with the run tag. The suite FAILS if anything is stranded,
// because this estate has twice had fabricated negotiations left in a production table and reasoned
// about as real.

const URL_ = process.env.ANSWERED_DB_URL;
const ANON = process.env.ANSWERED_DB_ANON;
const SECRET = process.env.ANSWERED_DB_SECRET;
if (!URL_ || !ANON || !SECRET) {
  console.error('Run through research/with-env.sh.');
  process.exit(1);
}

let pass = 0; let fail = 0;
const test = (name, fn) => {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

async function rpc(fn, args = {}) {
  const res = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_secret: SECRET, ...args }),
  });
  const t = await res.text();
  let body = null;
  try { body = t ? JSON.parse(t) : null; } catch { body = t; }
  return { status: res.status, body };
}

const RUN = `truce-test-${Date.now()}`;
const created = [];

/**
 * A fresh deal with BOTH sealed limits actually in place.
 *
 * ★ THIS HELPER ONCE PRODUCED A CONFIDENT FALSE FINDING, AND THE LESSON IS THE MOST VALUABLE THING
 * IN THIS FILE. It called `tr_set_limit` twice and checked NEITHER RESPONSE. Meanwhile
 * `sv_truce_create` had been hardened to stop handing the creator both tokens — a correct security
 * fix — so it now returns `a_token, b_claim, deal_id` and NO `b_token`. My `c.body.b_token` was
 * therefore `undefined`, `JSON.stringify` DROPPED the key entirely, PostgREST answered
 * `404 PGRST202`, and the buyer's limit was never set.
 *
 * The consequence was not one wrong test. Every case below ran against a deal with ONE sealed limit,
 * so the sixteen refusals that passed were largely testing nothing, and the single "failure" was
 * reported to another lane as a defect in THEIR money guard. It was my setup. A test whose SETUP
 * fails silently does not merely lose coverage — it manufactures findings, and confident ones,
 * because the assertions still run and still look meaningful.
 *
 * So setup is now ASSERTED, loudly, and the suite refuses to run a case it could not stage. The
 * `undefined`-key trap is the same one this estate has already been bitten by twice.
 */
async function deal({ floor, ceiling, label }) {
  const c = await rpc('sv_truce_create', {
    p_subject: `${RUN} ${label}`, p_kind: 'other',
    p_a_name: 'Dana', p_a_role: 'seller', p_b_name: 'Ryan', p_b_role: 'buyer',
  });
  if (!c.body || !c.body.deal_id) throw new Error(`could not create a deal: ${JSON.stringify(c.body).slice(0, 200)}`);
  created.push({ id: c.body.deal_id });

  // The creator is deliberately NOT given the other side's token. Redeem the claim code the way a
  // real counterparty does, so the harness exercises the same door the product does.
  if (!c.body.a_token) throw new Error('sv_truce_create returned no a_token');
  if (!c.body.b_claim) throw new Error('sv_truce_create returned no b_claim; the setup path has changed again');
  const claimed = await rpc('tr_claim', { p_code: c.body.b_claim });
  const bToken = claimed.body && (claimed.body.token || claimed.body.b_token);
  if (!bToken) throw new Error(`could not redeem b_claim: ${JSON.stringify(claimed.body).slice(0, 200)}`);

  const setA = await rpc('tr_set_limit', { p_token: c.body.a_token, p_direction: 'min', p_amount: floor, p_opening: floor * 1.25 });
  if (setA.status !== 200 || (setA.body && setA.body.error)) {
    throw new Error(`seller limit NOT set (${setA.status}): ${JSON.stringify(setA.body).slice(0, 200)}`);
  }
  const setB = await rpc('tr_set_limit', { p_token: bToken, p_direction: 'max', p_amount: ceiling, p_opening: ceiling * 0.8 });
  if (setB.status !== 200 || (setB.body && setB.body.error)) {
    throw new Error(`buyer limit NOT set (${setB.status}): ${JSON.stringify(setB.body).slice(0, 200)}`);
  }

  // Prove BOTH limits landed before any assertion is allowed to depend on them.
  const view = await rpc('tr_view', { p_token: c.body.a_token });
  const them = view.body && view.body.them;
  if (!them || them.has_set_limit !== true) {
    throw new Error(`the counterparty has no sealed limit after setup; every case would be vacuous. them=${JSON.stringify(them)}`);
  }
  return { ...c.body, b_token: bToken, view: view.body };
}

const FLOOR = 8000;      // Dana will not take less
const CEILING = 12000;   // Ryan will not pay more

console.log(`\nADVERSARIAL: tr_agent_settle — the guard between a persuaded agent and somebody's money`);
console.log(`  run tag ${RUN}\n`);

/**
 * ★ ASSERT ON THE OUTCOME, NEVER ON THE RETURN FLAG. This is the second correction this file has
 * needed and it is the more subtle one.
 *
 * When both limits are sealed the ENGINE settles the deal on its own, so every later
 * `tr_agent_settle` is answered `{ok:true, already:true, settled_value:<the real one>}` — an
 * idempotent acknowledgement, NOT an acceptance of the number that was asked for. Reading `ok`
 * produced TEN confident false failures in a row, on top of the one already reported to another
 * lane, all of them claiming a guard had bound somebody to 6500 or 0 or 20000 when the settled
 * value had never moved a cent.
 *
 * The only honest question is: DID THE BINDING FIGURE BECOME THE ATTACKED NUMBER? So that is what
 * gets asserted, read back from the deal itself rather than from the call that attacked it.
 */
async function boundValue(token) {
  const v = await rpc('tr_view', { p_token: token });
  return v.body && v.body.deal ? Number(v.body.deal.settled_value) : null;
}

// ── 1. THE POSITIVE CONTROL. Without this the whole file proves nothing. ─────────────────────
{
  const d = await deal({ floor: FLOOR, ceiling: CEILING, label: 'positive-control' });
  const bound = await boundValue(d.a_token);
  test('POSITIVE CONTROL: two sealed limits with an overlap DO produce a binding settlement', () => {
    if (!Number.isFinite(bound)) throw new Error('no settlement at all, so every refusal below is meaningless');
    if (bound < FLOOR || bound > CEILING) throw new Error(`settled at ${bound}, outside [${FLOOR}, ${CEILING}]`);
  });
}

// ── 2. No attacked figure may ever BECOME the binding number. ────────────────────────────────
{
  const d = await deal({ floor: FLOOR, ceiling: CEILING, label: 'attacks' });
  const before = await boundValue(d.a_token);
  const attacks = [
    ['a', 7999], ['a', 6500], ['a', 1], ['a', 0.01], ['a', 0],
    ['b', 12001], ['b', 20000], ['b', 1e9], ['a', 13000],
    ['a', -10000], ['a', null], ['a', '10000'], ['a', 'ten thousand'], ['a', 1e-3],
  ];
  for (const [side, amount] of attacks) {
    const s = await rpc('tr_agent_settle', { p_deal: d.deal_id, p_side: side, p_amount: amount });
    const after = await boundValue(d.a_token);
    test(`side ${side} settling ${JSON.stringify(amount)} does not move the binding figure`, () => {
      if (s.status >= 500) throw new Error(`a ${s.status}; the guard should refuse, not fall over`);
      // The ONLY honest question: did the binding figure MOVE? An equality check against the
      // attacked number is a false positive whenever the attack happens to name the figure the
      // engine had already settled on legitimately — which "10000" did, because the midpoint of
      // [8000, 12000] is 10000. That produced a fourth false failure in this file. Movement is the
      // property; coincidence is not evidence.
      if (after !== before) throw new Error(`the binding figure moved ${before} -> ${after} on an attack of ${amount}`);
    });
  }
}

// ── 3. THE REAL HOLE @ANSWERED-BUILD FOUND: nobody is bound to a number they never said. ─────
{
  const c = await rpc('sv_truce_create', {
    p_subject: `${RUN} unsealed-counterparty`, p_kind: 'other',
    p_a_name: 'Dana', p_a_role: 'seller', p_b_name: 'Ryan', p_b_role: 'buyer',
  });
  created.push({ id: c.body.deal_id });
  await rpc('tr_set_limit', { p_token: c.body.a_token, p_direction: 'min', p_amount: FLOOR, p_opening: 10000 });
  // Ryan seals NOTHING — the normal conversational flow, where the person who receives a link just
  // haggles by text. This is where the guard had nothing to check against.
  const s = await rpc('tr_agent_settle', { p_deal: c.body.deal_id, p_side: 'a', p_amount: 13000 });
  const v = await rpc('tr_view', { p_token: c.body.a_token });
  test('an UNSEALED counterparty cannot be bound to a figure they never said', () => {
    const bound = v.body && v.body.deal ? v.body.deal.settled_value : null;
    if (s.body && s.body.ok && !s.body.already && Number(bound) === 13000) {
      throw new Error('bound Ryan to 13000, which he never uttered and never sealed');
    }
  });
}

// ── teardown, and the suite fails if anything survives it ────────────────────────────────────
let stranded = 0;
for (const c of created) {
  const p = await rpc('sv_truce_purge_test', { p_deal: c.id, p_run: RUN });
  if (!(p.body && p.body.deleted)) stranded += 1;
}
test('every test deal is torn down; nothing is left in a production table', () => {
  if (stranded) throw new Error(`${stranded} test deal(s) stranded under tag ${RUN} — purge them by hand`);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
