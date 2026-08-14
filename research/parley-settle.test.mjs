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

/** A fresh deal with known sealed limits. Seller will not take under FLOOR; buyer will not pay over CEILING. */
async function deal({ floor, ceiling, label }) {
  const c = await rpc('sv_truce_create', {
    p_subject: `${RUN} ${label}`, p_kind: 'other',
    p_a_name: 'Dana', p_a_role: 'seller', p_b_name: 'Ryan', p_b_role: 'buyer',
  });
  if (!c.body || !c.body.deal_id) throw new Error(`could not create a deal: ${JSON.stringify(c.body).slice(0, 160)}`);
  created.push({ id: c.body.deal_id });
  await rpc('tr_set_limit', { p_token: c.body.a_token, p_direction: 'min', p_amount: floor, p_opening: floor * 1.25 });
  await rpc('tr_set_limit', { p_token: c.body.b_token, p_direction: 'max', p_amount: ceiling, p_opening: ceiling * 0.8 });
  return c.body;
}

const FLOOR = 8000;      // Dana will not take less
const CEILING = 12000;   // Ryan will not pay more

console.log(`\nADVERSARIAL: tr_agent_settle — the guard between a persuaded agent and somebody's money`);
console.log(`  run tag ${RUN}\n`);

// ── 1. THE POSITIVE CONTROL. Without this the whole file proves nothing. ─────────────────────
{
  const d = await deal({ floor: FLOOR, ceiling: CEILING, label: 'positive-control' });
  const s = await rpc('tr_agent_settle', { p_deal: d.deal_id, p_side: 'a', p_amount: 10000 });
  test('POSITIVE CONTROL: a legitimate figure inside both limits IS accepted', () => {
    if (!(s.body && s.body.ok)) {
      throw new Error(`the guard refused a lawful settlement, so every refusal below is meaningless: ${JSON.stringify(s.body).slice(0, 200)}`);
    }
    if (Number(s.body.settled_value) !== 10000) throw new Error(`settled at ${s.body.settled_value}, expected 10000`);
  });
}

// ── 2. Below the seller's floor, from the seller's own side. The core attack. ─────────────────
{
  const d = await deal({ floor: FLOOR, ceiling: CEILING, label: 'below-floor' });
  const cases = [7999, 6500, 1, 0.01, 0];
  for (const amount of cases) {
    const s = await rpc('tr_agent_settle', { p_deal: d.deal_id, p_side: 'a', p_amount: amount });
    test(`the seller's agent CANNOT settle at ${amount}, under a floor of ${FLOOR}`, () => {
      if (s.body && s.body.ok) throw new Error(`ACCEPTED ${amount} below the floor — this binds a party to a number they refused`);
    });
  }
}

// ── 3. Above the buyer's ceiling, from the buyer's side. The mirror attack. ───────────────────
{
  const d = await deal({ floor: FLOOR, ceiling: CEILING, label: 'above-ceiling' });
  for (const amount of [12001, 20000, 1e9]) {
    const s = await rpc('tr_agent_settle', { p_deal: d.deal_id, p_side: 'b', p_amount: amount });
    test(`the buyer's agent CANNOT settle at ${amount}, over a ceiling of ${CEILING}`, () => {
      if (s.body && s.body.ok) throw new Error(`ACCEPTED ${amount} above the ceiling`);
    });
  }
}

// ── 4. A side settling past the OTHER party's limit. A seller agreeing 13000 is not "generous". ─
{
  const d = await deal({ floor: FLOOR, ceiling: CEILING, label: 'past-counterparty' });
  const s = await rpc('tr_agent_settle', { p_deal: d.deal_id, p_side: 'a', p_amount: 13000 });
  test('the seller CANNOT settle above the BUYER\'s sealed ceiling either', () => {
    if (s.body && s.body.ok) throw new Error('accepted a figure the counterparty had refused; the guard must read BOTH limits, not just the caller\'s');
  });
}

// ── 5. Malformed and hostile inputs. None may resolve to a binding number. ────────────────────
{
  const d = await deal({ floor: FLOOR, ceiling: CEILING, label: 'malformed' });
  const hostile = [
    ['negative', -10000], ['null', null], ['a string', '10000'],
    ['NaN-ish text', 'ten thousand'], ['scientific notation under the floor', 1e-3],
  ];
  for (const [label, amount] of hostile) {
    const s = await rpc('tr_agent_settle', { p_deal: d.deal_id, p_side: 'a', p_amount: amount });
    test(`hostile input rejected: ${label}`, () => {
      // A string that Postgres coerces to a lawful numeric may legitimately be accepted; what must
      // never happen is a BINDING settlement outside the limits, or a crash that leaves the deal
      // in a half-written state.
      if (s.body && s.body.ok) {
        const v = Number(s.body.settled_value);
        if (!Number.isFinite(v) || v < FLOOR || v > CEILING) {
          throw new Error(`bound the deal to ${s.body.settled_value} from input ${JSON.stringify(amount)}`);
        }
      }
      if (s.status >= 500) throw new Error(`a ${s.status} on hostile input; the guard should refuse, not fall over`);
    });
  }
}

// ── 6. A settled deal must not be silently re-settled at a worse number. ─────────────────────
{
  const d = await deal({ floor: FLOOR, ceiling: CEILING, label: 'no-overwrite' });
  const first = await rpc('tr_agent_settle', { p_deal: d.deal_id, p_side: 'a', p_amount: 11000 });
  const second = await rpc('tr_agent_settle', { p_deal: d.deal_id, p_side: 'a', p_amount: 8100 });
  const view = await rpc('tr_view', { p_token: d.a_token });
  test('a second settle does not overwrite the first at a worse figure', () => {
    if (!(first.body && first.body.ok)) throw new Error('the setup settlement was refused, so this case proves nothing');
    const now = Number(view.body && view.body.deal && view.body.deal.settled_value);
    if (now !== 11000) throw new Error(`settled_value moved from 11000 to ${now}; a closed deal was reopened`);
  });
}

// ── 7. THE PRIVACY PROPERTY MUST SURVIVE A SETTLEMENT. ───────────────────────────────────────
{
  const d = await deal({ floor: FLOOR, ceiling: CEILING, label: 'seal-after-settle' });
  await rpc('tr_agent_settle', { p_deal: d.deal_id, p_side: 'a', p_amount: 9500 });
  const ryan = await rpc('tr_view', { p_token: d.b_token });
  const dana = await rpc('tr_view', { p_token: d.a_token });
  test('settling does not leak either sealed limit to the other party', () => {
    const r = JSON.stringify(ryan.body); const n = JSON.stringify(dana.body);
    if (r.includes(String(FLOOR))) throw new Error(`Ryan's payload contains Dana's floor ${FLOOR}`);
    if (n.includes(String(CEILING))) throw new Error(`Dana's payload contains Ryan's ceiling ${CEILING}`);
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
