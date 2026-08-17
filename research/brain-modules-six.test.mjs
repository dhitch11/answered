// brain-modules-six.test.mjs — triggers for the six modules added 2026-08-16.
//
// The reviewers proposed each trigger list and were then asked to attack their own proposal for
// false positives. Most of the QUIET cases below come from that attack, not from me, which is the
// point: the person who wrote a pattern is the worst judge of what it over-matches.
//
// A false negative here costs a caller knowledge that existed and is recoverable next turn. A false
// positive puts the WRONG knowledge in front of the model, and the model will use it — property
// advice on a homeowner's call, or seasonal urgency on a routine quote.

import { strict as assert } from 'node:assert';
import { MODULES, modulesFor } from '../netlify/functions/lib/brain-modules.mjs';
import { TEXT } from '../netlify/functions/lib/brain-text.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.error(`  FAIL  ${name}\n        ${e.message}`); }
};
const fires = (said, name) => modulesFor(said, new Set()).some((m) => m.name === name);

console.log('six new knowledge modules\n');

const SIX = ['money', 'scheduling', 'upset', 'seasonal', 'property', 'trades_two'];

for (const k of SIX) {
  t(`${k}: registered and non-empty`, () => {
    assert.ok(MODULES.some(([n]) => n === k), `${k} not in MODULES`);
    assert.ok(typeof TEXT[k] === 'string' && TEXT[k].length > 2500, `${k} text is ${TEXT[k]?.length}`);
  });
}

t('safety is still FIRST, ahead of all of them', () => {
  assert.equal(MODULES[0][0], 'safety');
});

// ── MUST FIRE ────────────────────────────────────────────────────────────────────────────────────
const FIRE = {
  money: ['how much to unclog a drain', 'whats your call out fee', 'can I get a quote',
          'just give me a ballpark', 'is this covered by insurance', 'that seems too expensive'],
  scheduling: ['can you book someone for tomorrow', 'when are you available', 'I need to schedule a visit',
               'the gate code is needed', 'nobody is home during the day', 'can you come out today'],
  upset: ['your guy never showed up', 'this is ridiculous', 'I want a refund',
          'its still not fixed after the third time', 'I want to speak to the owner', 'I will leave a bad review'],
  seasonal: ['everyone is busy this time of year', 'we got storm damage last night',
             'it leaks when it rains', 'first freeze is coming', 'this happens every winter'],
  property: ['I rent here and my landlord said to call', 'I am the property manager for the building',
             'I need a work order number', 'we are closing next week and the inspection report flagged it',
             'one of our rental properties has an issue'],
  trades_two: ['my refrigerator stopped cooling', 'the septic is backing up', 'I am locked out',
               'the pool pump quit', 'we have termites', 'a tree came down on the driveway'],
};
for (const [k, lines] of Object.entries(FIRE)) {
  for (const s of lines) t(`FIRES ${k}: ${s}`, () => assert.ok(fires(s, k), 'did not load'));
}

// ── MUST NOT FIRE. These are the reviewers' own false-positive predictions. ──────────────────────
const QUIET = {
  money: ['the water heater is leaking', 'can someone look at my furnace', 'my drain is slow'],
  scheduling: ['what do you charge', 'the outlet stopped working', 'do you service my area'],
  upset: ['the AC is not working', 'I need a quote on a new furnace', 'can you come look at the roof'],
  // 'season' is deliberately absent from the trigger: it fires on "wheat season" and similar.
  seasonal: ['wheat season is coming up', 'my drain is slow', 'can you replace a water heater',
             'I need a seasoning for the grill'],
  property: ['I own my home and need a plumber', 'my property line has a broken sprinkler',
             'the owner of the company called me back'],
  trades_two: ['my water heater is leaking', 'the furnace wont start', 'the toilet is running'],
};
for (const [k, lines] of Object.entries(QUIET)) {
  for (const s of lines) t(`QUIET ${k}: ${s}`, () => assert.ok(!fires(s, k), 'wrongly loaded'));
}

// ── POSITIVE CONTROLS ────────────────────────────────────────────────────────────────────────────
t('POSITIVE CONTROL — nonsense loads nothing at all', () => {
  assert.equal(modulesFor('zzzq wibble frobnicate', new Set()).length, 0);
});
t('POSITIVE CONTROL — each of the six can fire at least once', () => {
  for (const [k, lines] of Object.entries(FIRE)) {
    assert.ok(fires(lines[0], k), `${k} never fires; its QUIET tests are vacuous`);
  }
});

// ── the properties that make the loader safe ─────────────────────────────────────────────────────
t('append once per call, never per turn', () => {
  const loaded = new Set();
  assert.equal(modulesFor('how much to unclog a drain', loaded).filter((m) => m.name === 'money').length, 1);
  assert.equal(modulesFor('seriously how much', loaded).filter((m) => m.name === 'money').length, 0);
});
t('a hazard plus a price question loads safety FIRST', () => {
  const got = modulesFor('I smell gas, and how much do you charge', new Set()).map((m) => m.name);
  assert.ok(got.includes('safety') && got.includes('money'));
  assert.ok(got.indexOf('safety') < got.indexOf('money'), 'safety must land before money');
});
t('no module is so broad it fires on a bare greeting', () => {
  for (const s of ['hi', 'hello', 'good morning', 'is anyone there']) {
    assert.equal(modulesFor(s, new Set()).length, 0, `something fired on "${s}"`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
