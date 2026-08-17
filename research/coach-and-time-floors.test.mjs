// coach-and-time-floors.test.mjs — two floors added from LIVE measurement, not from review.
//
// Both were written in prose first, in the safety and scheduling knowledge modules, in plain
// language, and the model said the banned thing anyway on the production endpoint:
//
//   "Stop, turn off the water at the main shutoff valve right now."   (water heater burst)
//   "That is urgent and we can get someone out today."                (2 of 5 probe calls)
//
// The safety module uses a valve as its own example of what never to do. That is the lesson: a rule
// in the prompt is a preference, and the model reaches for the genuinely helpful thing under
// pressure. A rule that must hold is a floor.
//
// ★ WHY COACHING IS BANNED AT ALL, since "turn off your water" sounds like good advice: the voice
// cannot see the house. It does not know if the caller is standing in water beside a panel, whether
// the valve is seized, whether a ladder is involved, or whether the person can physically do it.
// Recognition and getting out of the way is the doctrine.

import { strict as assert } from 'node:assert';
import { PERSONAS, guardClause } from '../netlify/functions/lib/personas.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.error(`  FAIL  ${name}\n        ${e.message}`); }
};

const P = PERSONAS.customer;
const by = (text) => {
  const r = guardClause(P, text, ['89'], {});
  return r.ok ? null : r.by;
};

console.log('coach-action and time-promise floors\n');

for (const b of ['coach-action', 'time-promise']) {
  t(`${b} floor is registered on the customer line`, () => {
    assert.ok((P.outFloors || []).some((f) => f.by === b));
  });
  t(`${b} is question-aware`, () => {
    assert.equal((P.outFloors || []).find((f) => f.by === b).notQuestion, true,
      'floor fires on questions; asking is not instructing');
  });
}

// ── COACHING: caught. The first entry is verbatim from the live line. ────────────────────────────
for (const s of [
  'Stop, turn off the water at the main shutoff valve right now.',
  'Turn off the gas at the meter.',
  'Shut the water off under the sink.',
  'You need to flip the breaker.',
  'You should reset the breaker.',
  'Go and check the panel.',
  'Unplug it and see if that helps.',
  'Open a window and let it air out.',
  'Light the pilot again.',
  'Cut the power at the panel.',
]) t(`COACHING caught: ${s}`, () => assert.equal(by(s), 'coach-action', `got ${by(s)}`));

// ── TIMING: caught. First two are verbatim from the live line. ───────────────────────────────────
for (const s of [
  'That is urgent and we can get someone out today.',
  'We will get someone out there today.',
  'A tech can be out tomorrow.',
  'Someone will come out right away.',
  'We can have somebody out this afternoon.',
  'I will get a tech out to you first thing.',
]) t(`TIMING caught: ${s}`, () => assert.equal(by(s), 'time-promise', `got ${by(s)}`));

// ── ASKING IS NOT INSTRUCTING. A question about the same act must pass. ──────────────────────────
for (const s of [
  'Did you turn the water off?',
  'Have you shut the gas off?',
  'Is the breaker off?',
  'Can you get to the panel?',
  'Are you able to reach the shutoff?',
  'Is anyone able to come out today?',
]) t(`QUESTION passes: ${s}`, () => assert.equal(by(s), null, `wrongly caught by ${by(s)}`));

// ── the voice doing its actual job must not be touched ───────────────────────────────────────────
for (const s of [
  'You said you turned the water off, good.',
  'What is going on with the water heater?',
  'The call out fee is 89 dollars.',
  'Let me get the details down for the owner.',
  'Are you calling during business hours?',
  'That sounds like your main sewer line.',
  'I have got your address.',
]) t(`PASSES: ${s}`, () => assert.equal(by(s), null, `wrongly caught by ${by(s)}`));

// ── POSITIVE CONTROLS ────────────────────────────────────────────────────────────────────────────
t('POSITIVE CONTROL — both floors can fire', () => {
  assert.equal(by('Turn off the water at the main.'), 'coach-action');
  assert.equal(by('We can get someone out today.'), 'time-promise');
});
t('POSITIVE CONTROL — neither fires on ordinary speech', () => {
  assert.equal(by('What is going on over there?'), null);
});
t('the pivots offer something real instead of just refusing', () => {
  const c = (P.outFloors || []).find((f) => f.by === 'coach-action');
  const m = (P.outFloors || []).find((f) => f.by === 'time-promise');
  assert.match(c.pivot, /cannot see|get it to somebody/i);
  assert.match(m.pivot, /owner can tell you|details down/i);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
