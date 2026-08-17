// crisis-floor.test.mjs — the hard floor that ENDS the call.
//
// CRISIS_RE is not a prompt instruction. It short-circuits the model entirely and hangs up, so it is
// the one pattern here where both failure directions cost something real:
//
//   a MISS  -> somebody in a house with a gas leak keeps talking to a booking voice
//   a FALSE POSITIVE -> a paying customer asking about a gas furnace gets hung up on
//
// Measured 2026-08-16, the original caught 6 of 17 natural hazard phrasings. Three bugs, one family:
// it assumed a single word order ("I smell gas" but not "a gas smell"), required adjacency ("water
// pouring" but not "water IS pouring"), and omitted the ways people describe a leak before they have
// concluded it is one (rotten eggs, sulfur, a burning smell).
//
// These tests read the regex off the SHIPPED persona objects, never a copy pasted into the test. A
// test that re-declares the pattern it is checking cannot catch a change to the real one.

import { strict as assert } from 'node:assert';
import { PERSONAS } from '../netlify/functions/lib/personas.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.error(`  FAIL  ${name}\n        ${e.message}`); }
};

// ★ inBranches, NOT outFloors. This distinction cost me a crashed test run and is worth stating:
// `outFloors` guard what THOMAS says (a price he was not given, a booking he did not make);
// `inBranches` match what the CALLER says and route the turn. CRISIS_RE reads the caller's words,
// so it is an in-branch. Looking for it on outFloors finds nothing on all four personas, which
// reads exactly like "there is no crisis floor" rather than "you looked in the wrong array".
const personaList = Object.values(PERSONAS);
const crisisOf = (p) => (p.inBranches || []).find((f) => f.by === 'crisis');

console.log('crisis floor\n');

t('every persona carries a crisis floor', () => {
  for (const p of personaList) {
    assert.ok(crisisOf(p), `persona ${p.id} has no crisis floor`);
  }
});
t('every crisis floor ends the call', () => {
  for (const p of personaList) {
    assert.equal(crisisOf(p).end, true, `persona ${p.id} crisis floor does not end the call`);
  }
});
t('all personas share one crisis pattern (one place to fix, not four)', () => {
  const src = new Set(personaList.map((p) => String(crisisOf(p).re)));
  assert.equal(src.size, 1, `found ${src.size} different crisis patterns across personas`);
});

const RE = crisisOf(personaList[0]).re;
const hits = (s) => RE.test(s);

// ── MUST END THE CALL. All 17 were checked against the pre-fix pattern; 11 failed then. ──────────
const HAZARD = [
  'I smell gas',
  'there is a gas smell by the water heater',   // word order — missed before
  'it smells like gas in here',
  'smells like rotten eggs in the basement',    // absent before
  'theres a sulfur smell near the furnace',     // absent before
  'the carbon monoxide alarm is going off',
  'my CO detector keeps chirping',
  'the house is on fire',
  'something smells like burning',              // absent before
  'theres a burning smell from the panel',      // absent before
  'the outlet is sparking',                     // needed from/out-of before
  'the breaker sparked at me',                  // absent before
  'smoke is coming from the vent',              // adjacency — missed before
  'theres smoke in the utility room',           // absent before
  'it shocked me when I touched the panel',     // absent before
  'water is pouring through the ceiling',       // adjacency — missed before
  'my basement is flooding right now',
];
for (const s of HAZARD) t(`ENDS CALL: ${s}`, () => assert.ok(hits(s), 'crisis floor did not fire'));

// ── MUST NOT END THE CALL. These are ordinary paid work on a trades line. ────────────────────────
const ROUTINE = [
  'I want a quote on replacing my gas furnace',
  'can you run a gas line to the patio',
  'the gas fireplace needs servicing',
  'my gas bill is high this month',
  'can you install a smoke detector in the hallway',  // smoke must never match bare
  'I need a smoke alarm put in upstairs',
  'the pilot light sparks when it lights',            // a furnace working correctly
  'my yard floods when it rains',
  'the water heater is leaking a little',
  'I need a new breaker panel quote',
  'can you book a drain cleaning',
  'the AC stopped cooling',
  'we want an outlet added in the garage',
];
for (const s of ROUTINE) t(`KEEPS CALL: ${s}`, () => assert.ok(!hits(s), 'crisis floor hung up on routine work'));

// ── POSITIVE CONTROLS: prove this file can fail ──────────────────────────────────────────────────
t('POSITIVE CONTROL — pattern does not match arbitrary text', () => {
  assert.ok(!hits('zzzq wibble frobnicate'), 'pattern matches everything; every KEEPS CALL test is vacuous');
});
t('POSITIVE CONTROL — pattern matches something', () => {
  assert.ok(hits('I smell gas'), 'pattern matches nothing; every ENDS CALL test is vacuous');
});

// ── the three specific bugs, pinned so they cannot silently return ───────────────────────────────
t('REGRESSION: word order — noun-first gas smell', () => {
  assert.ok(hits('a gas smell'), 'noun-first phrasing regressed');
  assert.ok(hits('I smell gas'), 'verb-first phrasing regressed');
});
t('REGRESSION: adjacency — a copula between subject and verb', () => {
  assert.ok(hits('water is pouring'), 'copula adjacency regressed');
  assert.ok(hits('smoke is coming'), 'copula adjacency regressed');
});
t('REGRESSION: smoke never matches bare, or a detector install ends the call', () => {
  assert.ok(!hits('smoke'), 'bare smoke matches');
  assert.ok(!hits('smoke detector'), 'smoke detector matches');
});
t('REGRESSION: sparks need an electrical noun', () => {
  assert.ok(!hits('the pilot light sparks when it lights'), 'bare spark matches');
  assert.ok(hits('the outlet is sparking'), 'electrical spark missed');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
