// research/craft-floors.test.mjs — do the craft floors actually fire, and only when they should?
//
// These four floors stop the voice SOUNDING like a machine, which is a different failure from the
// safety floors above them and until 2026-08-16 was unguarded. Source: the phone-close doctrine in
// knowledge/19-communication-brain/15, which David made binding estate-wide and which states it
// governs voice-agent behaviour.
//
// Every case below is paired: one input that MUST trip it, one that MUST NOT. A floor that fires on
// everything is as useless as one that fires on nothing, and this estate has shipped both.
import assert from 'node:assert/strict';
import { PERSONAS, guardClause } from '../netlify/functions/lib/personas.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

// Scout is outbound and not frozen, so it carries the craft floors.
const p = PERSONAS.scout || PERSONAS.onboard || PERSONAS.customer;
const guard = (s) => guardClause(p, s, '', {});

console.log('\n── the monologue cap ──');

t('a 40+ word answer is stopped', () => {
  const long = 'So what we do here is we take a look at the whole situation and then we work through it with you step by step and make sure that everything is handled properly and completely from start to finish without any gaps at all whatsoever today';
  const r = guard(long);
  assert.equal(r.ok, false, `${long.split(/\s+/).length} words passed the cap`);
  assert.equal(r.by, 'monologue');
});

t('NEGATIVE CONTROL: a normal short answer passes', () => {
  const r = guard('Sure, what is the address?');
  assert.equal(r.ok, true, `a five-word answer was blocked by ${r.by}`);
});

t('a long ADDRESS read-back is not punished as padding', () => {
  // Content the caller needs, not a monologue. It must be under the cap on word count.
  const addr = 'Got it, four twenty one North Maple Street, apartment two B, Springfield.';
  const r = guard(addr);
  assert.equal(r.ok, true, `an address read-back was blocked by ${r.by}`);
});

console.log('\n── stacked questions ──');

t('two questions in one turn are stopped', () => {
  const r = guard('What is the address? And is it urgent?');
  assert.equal(r.ok, false);
  assert.equal(r.by, 'stacked-question');
});

t('NEGATIVE CONTROL: one question passes', () => {
  assert.equal(guard('What is the address?').ok, true);
});

console.log('\n── fake familiarity ──');

for (const s of ['Just checking in on that.', 'Touching base about your line.', 'Returning your call.', 'As we discussed last time.']) {
  t(`stopped: ${JSON.stringify(s)}`, () => {
    const r = guard(s);
    assert.equal(r.ok, false, 'invented shared history passed');
    assert.equal(r.by, 'fake-familiarity');
  });
}

t('NEGATIVE CONTROL: a genuine first-contact line passes', () => {
  assert.equal(guard('This is Thomas with Answered.').ok, true);
});

console.log('\n── the sales register ──');

for (const s of ['We have solutions for that.', 'This is a partnership opportunity.', 'Let me circle back.', 'It is best in class.']) {
  t(`stopped: ${JSON.stringify(s)}`, () => {
    const r = guard(s);
    assert.equal(r.ok, false, 'sales register passed');
    assert.equal(r.by, 'sales-register');
  });
}

t('NEGATIVE CONTROL: plain trade language passes', () => {
  assert.equal(guard('I can get someone out Tuesday morning.').ok, true);
});

console.log('\n── ORDER: safety must always beat craft ──');

t('an unsupported claim is caught as a SAFETY floor, never as monologue', () => {
  // Long AND false. The safety floor must win: the pivots differ, and the craft pivot would leave
  // the false claim standing. (scout's safety floor for this is 'claim', not riley's
  // 'unbooked-claim' — the personas carry different floors and the test must match the one it runs.)
  const s = 'We have helped hundreds of shops just like yours and on average they see a really significant improvement in the number of calls that they end up booking every single month after they start';
  const r = guard(s);
  assert.equal(r.ok, false, 'an unsupported claim passed entirely');
  assert.notEqual(r.by, 'monologue', 'a craft floor pre-empted a safety floor');
  assert.equal(r.by, 'claim');
});

console.log(`\n${fail ? 'FAILED' : 'PASSED'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
