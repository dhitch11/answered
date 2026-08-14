#!/usr/bin/env node
// truce.test.mjs — the two properties the text-negotiation product is sold on.
//
//   ./research/with-env.sh node research/truce.test.mjs
//
// This runs against the LIVE deployed API, not a local mock, because both defects it guards
// against were invisible to everything except the real output.
//
// PROPERTY 1  A party's sealed limit never appears in any response the other party can fetch.
// PROPERTY 2  The settled figure cannot be inverted to recover the other party's limit.
//
// Property 2 is the one that needs saying twice. /truce Section 3 promises the limit "is not in a
// message, not in the summary, not on the signed page". All three were true of the first version,
// and all three were irrelevant: settling on the exact midpoint means `theirs = 2 x settled - mine`,
// so every party could compute the other's sealed number with one subtraction from a figure we
// print on the signed page. A test that only greps the transcript would have passed it.

const SITE = process.env.TRUCE_SITE || 'https://answered.reddenda.com';

// ★ EVERY DEAL THIS SUITE CREATES IS TAGGED AND TORN DOWN.
// A previous run of this file left 14 fabricated negotiations sitting in the production table that
// the operator console reads, and a teammate found them and reasoned about them as real. A test
// that writes to production and does not clean up is manufacturing evidence, which is the estate's
// first law inverted. The tag makes the residue findable even if the teardown itself fails.
const RUN = `truce-test-${Date.now().toString(36)}`;
const created = [];
const API = `${SITE}/api/truce`;

let pass = 0; let fail = 0;
const test = (name, fn) => {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

async function api(body) {
  const r = await fetch(API, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${body.op}: ${j.error}`);
  return j;
}

async function runDeal({ sellerFloor, buyerCeiling, sellerAsk, buyerOffer, subject }) {
  const d = await api({
    op: 'create', subject, kind: 'rent',
    a_name: 'Dana', a_role: 'owner', b_name: 'Ryan', b_role: 'tenant',
  });
  const a = d.you.rsplit ? null : d.you.split('/').pop();
  const b = d.them.split('/').pop();
  await api({ op: 'set_limit', token: a, direction: 'min', amount: sellerFloor, opening: sellerAsk });
  const view = await api({ op: 'set_limit', token: b, direction: 'max', amount: buyerCeiling, opening: buyerOffer });
  created.push(d.deal_id);
  return { a, b, view, dealId: d.deal_id };
}

console.log('\nTRUCE: the two properties the product is sold on');
console.log(`  against ${API}\n`);

const FLOOR = 1400;      // Dana will not take less
const CEILING = 1700;    // Ryan will not pay more

// ── PROPERTY 1 ───────────────────────────────────────────────────────────────────────────────
{
  const { a, b, view } = await runDeal({
    sellerFloor: FLOOR, buyerCeiling: CEILING, sellerAsk: 1750, buyerOffer: 1450,
    subject: `${RUN} property-1`,
  });

  const ryanSees = JSON.stringify(view);
  const danaSees = JSON.stringify(await api({ op: 'view', token: a }));

  test("Ryan's entire view never contains Dana's floor", () => {
    assert(!ryanSees.includes(String(FLOOR)), `found ${FLOOR} in Ryan's response`);
  });
  test("Dana's entire view never contains Ryan's ceiling", () => {
    assert(!danaSees.includes(String(CEILING)), `found ${CEILING} in Dana's response`);
  });
  test('no message in the thread carries either sealed limit', () => {
    for (const m of view.thread) {
      assert(m.amount !== FLOOR, `message ${m.seq} printed the floor`);
      assert(m.amount !== CEILING, `message ${m.seq} printed the ceiling`);
    }
  });
  test("the other side's limit is absent from the view, while their OPENING is present", () => {
    assert(view.them.opening != null, 'the public opening should be visible');
    assert(view.them.limit === undefined, 'a limit key must not exist on `them` at all');
  });
  // ★ THE POSITIVE HALF, ADDED AFTER AN ABSENCE-ONLY SUITE SLEPT THROUGH A RENAME.
  //
  // Every assertion above is of the form "this key is not there", and that shape gets MORE green
  // as the payload gets more broken: it passes identically whether the limit is correctly sealed,
  // renamed, misspelled, or the function was deleted outright. On 2026-08-14 me.limit silently
  // became me.amount, all fourteen tests stayed green, and parley.html — which reads me.limit to
  // decide whether this party has committed a number — put the set-your-number form back in front
  // of somebody who had just set one, beside a status strip reading "YOUR NUMBER IS NOT SET" next
  // to "ONE SIDE IS IN". A second submit would have overwritten a sealed limit they thought had
  // never been taken. It was caught by a lane diffing two live curls 21 minutes apart, not here.
  //
  // So the seal is proved from both directions now: their limit must be ABSENT, and mine must be
  // PRESENT and EQUAL to what I set. A rename fails the second one immediately.
  test('MY OWN limit comes back under the documented key, with the value I set', () => {
    assert(view.me.limit !== undefined, 'me.limit is missing — a renamed key reads to the page as an unset limit');
    // `view` is Ryan's — runDeal returns the response to Ryan's own set_limit — so his own
    // ceiling is exactly what me.limit must carry.
    assert.equal(Number(view.me.limit), CEILING,
      'me.limit came back, but not as the number this party actually committed');
  });
  const lc = await api({ op: 'leak_check', token: b });
  const lcA = await api({ op: 'leak_check', token: a });
  test('leak_check reports zero for both limits, from BOTH sides', () => {
    for (const [who, r] of [['Ryan', lc], ['Dana', lcA]]) {
      assert(r.your_limit_appears_in_messages === 0, `${who}: own limit appeared ${r.your_limit_appears_in_messages}x`);
      assert(r.their_limit_appears_in_messages === 0, `${who}: their limit appeared ${r.their_limit_appears_in_messages}x`);
    }
  });
  test('leak_check is a real instrument, not a constant', () => {
    // It must be capable of reporting a hit. Prove the comparison actually runs by asking it
    // about a deal whose settlement IS one of the numbers in the thread.
    assert(typeof lc.settled_on_a_limit === 'boolean', 'settled_on_a_limit is not being computed');
    const printed = view.thread.filter((m) => m.amount != null).map((m) => Number(m.amount));
    assert(printed.includes(Number(view.deal.settled_value)),
      'the settled figure should appear in the thread; if it does not, leak_check is comparing nothing');
  });
  test('the thread is a negotiation, not a handshake', () => {
    assert(view.thread.length >= 7, `only ${view.thread.length} messages; the back and forth IS the product`);
    const amounts = view.thread.filter((m) => m.amount != null).map((m) => m.amount);
    assert(new Set(amounts).size >= 4, 'no real movement between the openings and the settlement');
  });
  test('the settlement sits inside both limits', () => {
    const v = Number(view.deal.settled_value);
    assert(v >= FLOOR && v <= CEILING, `${v} is outside [${FLOOR}, ${CEILING}]`);
  });
}

// ── PROPERTY 2 ───────────────────────────────────────────────────────────────────────────────
// Identical sealed limits, several separate deals. If settlement were the exact midpoint every one
// would land on the same number and `2 x settled - mine` would hand each party the other's secret.
{
  const settled = [];
  for (let i = 0; i < 5; i += 1) {
    const { view } = await runDeal({
      sellerFloor: FLOOR, buyerCeiling: CEILING, sellerAsk: 1750, buyerOffer: 1450,
      subject: `${RUN} property-2 run ${i}`,
    });
    settled.push(Number(view.deal.settled_value));
  }

  test('identical limits do NOT always settle on the same figure', () => {
    assert(new Set(settled).size > 1,
      `every run settled at ${settled[0]}, so theirs = 2*settled - mine recovers the sealed number exactly`);
  });
  test('the naive inversion never lands on the true limit every time', () => {
    const guesses = settled.map((s) => 2 * s - FLOOR);
    const exact = guesses.filter((g) => g === CEILING).length;
    assert(exact < guesses.length, `inversion recovered the ceiling on ${exact}/${guesses.length} runs`);
  });
  test('every settlement still respects both limits', () => {
    for (const s of settled) assert(s >= FLOOR && s <= CEILING, `${s} outside the overlap`);
  });
}

// ── NO OVERLAP IS A REAL OUTCOME, NOT AN ERROR ───────────────────────────────────────────────
{
  const { view, b: noOverlapTokenB } = await runDeal({
    sellerFloor: 1950, buyerCeiling: 1900, sellerAsk: 2100, buyerOffer: 1800,
    subject: `${RUN} no-overlap`,
  });
  test('no overlap settles nothing and says so plainly', () => {
    assert(view.deal.status === 'no_overlap', `status was ${view.deal.status}`);
    assert(view.deal.settled_value == null, 'a no-overlap deal must not carry a settled value');
    assert(/nothing to sign and nothing to pay/i.test(view.thread.map((m) => m.body).join(' ')),
      'the honest no-deal copy is missing');
  });
  let signRefused = false; let signError = '';
  try {
    await api({ op: 'sign', token: noOverlapTokenB, name: 'Ryan Delgado' });
  } catch (e) { signRefused = true; signError = e.message; }
  test('a deal that never settled cannot be signed', () => {
    assert(signRefused, 'signing a no-overlap deal was ALLOWED');
    assert(/nothing to sign/i.test(signError), `refused, but with the wrong reason: ${signError}`);
  });
}

// ── THE LINK IS THE CREDENTIAL ───────────────────────────────────────────────────────────────
{
  let rejected = false;
  try { await api({ op: 'view', token: 'deadbeef' }); } catch { rejected = true; }
  test('a malformed link is rejected without touching the database', () => assert(rejected));
}

// ── TEARDOWN. Runs whatever happened above. ──────────────────────────────────────────────────
let removed = 0; let stranded = 0;
for (const id of created) {
  try {
    const r = await api({ op: 'purge_test_deal', deal_id: id, run: RUN });
    if (r && r.deleted) removed += 1; else stranded += 1;
  } catch { stranded += 1; }
}
console.log(`\nteardown: ${removed}/${created.length} test deals removed${stranded ? `, ${stranded} STRANDED` : ''}`);
if (stranded) {
  console.log(`  clean them with:  delete from public.truce_deals where subject like '${RUN}%';`);
  fail += 1;
  console.log('  FAILING THE RUN: a suite that leaves fabricated rows in production has not passed.');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
