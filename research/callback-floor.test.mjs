// callback-floor.test.mjs — the promise that a human will ring the caller back.
//
// WHY THIS FLOOR EXISTS, measured 2026-08-16. Six knowledge modules were drafted independently by
// six different writers and adversarially reviewed. FIVE of the six broke the same rule, in eleven
// separate places: they had the voice promise the caller a callback. That is not five mistakes. It
// is one rule with nothing enforcing it. "I'll have them call you back" is the humane thing to say,
// it is what a good human receptionist says, and both a writer and a model reach for it by default.
//
// The existing CONTACT_MSG_RE floor did NOT catch any of it. Measured: it passes "I will have them
// call you back", "someone will call you back today" and "they will get back to you shortly", while
// correctly catching text, email and "reach out". Text and voice are different promises.
//
// ★ THE FLOOR IS CONDITIONAL, because the persona rule is conditional. The voice MAY say the owner
// will call back WHEN THE OWNER'S NOTES SAY THAT IS WHAT HAPPENS. A blanket ban would make the voice
// worse on every business that does return calls, which is most of them. So the floor is skipped
// only when the notes actually authorize it, and with no state it runs at full strength.

import { strict as assert } from 'node:assert';
import { PERSONAS, guardClause } from '../netlify/functions/lib/personas.mjs';
import { notesAuthorizeCallback } from '../netlify/functions/answered-brain.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.error(`  FAIL  ${name}\n        ${e.message}`); }
};

const P = PERSONAS.customer;
// ctxDigits carries the numbers already said on the call. Supplied here so the pre-existing numeral
// floor does not fire on an address and get mistaken for this one.
const caught = (text, state) => {
  const r = guardClause(P, text, ['14', '30', '555', '0100'], state || {});
  return r.ok ? null : r.by;
};

console.log('callback floor\n');

t('the floor is registered on the customer persona', () => {
  assert.ok((P.outFloors || []).some((f) => f.by === 'callback-promise'));
});
t('it is conditional, not absolute', () => {
  const f = (P.outFloors || []).find((x) => x.by === 'callback-promise');
  assert.equal(f.unlessCallbackOk, true, 'floor is absolute; it would break every business that does call back');
});
t('its pivot takes a number instead of promising a call', () => {
  const f = (P.outFloors || []).find((x) => x.by === 'callback-promise');
  assert.match(f.pivot, /take your number/i);
});

// ── NOTES SILENT: every one of these must be caught ──────────────────────────────────────────────
// The first entry is the exact sentence from the drafted `money` module that slipped through the
// first version of this pattern, because its subject sits in an earlier clause.
for (const s of [
  'Let me get your details and have them call you with a number.',
  'I will have them call you back.',
  'I will have the owner call you.',
  "I'll have someone call you back.",
  'Someone will call you back today.',
  'They will get back to you shortly.',
  'The owner will call you this afternoon.',
  'You will get a call this afternoon.',
  'Expect a call from the owner.',
  'We will call you when we know more.',
  'I will ask them to ring you.',
]) {
  t(`CAUGHT (notes silent): ${s}`, () => assert.equal(caught(s), 'callback-promise', 'not caught'));
}

// ── MUST STILL PASS: the voice doing its actual job ──────────────────────────────────────────────
for (const s of [
  'I will put your details in front of the owner.',
  'I have written that down for the owner.',
  'Let me take your number and get this to the right person.',
  'What is the best number to reach you on?',
  'The owner handles the scheduling.',
  'I have got your address as 14 Oak Street.',
  'Can I get your name and number?',
]) {
  t(`PASSES: ${s}`, () => assert.equal(caught(s), null, `wrongly caught by ${caught(s)}`));
}

// ── NOTES AUTHORIZE IT: the same sentences must now pass ─────────────────────────────────────────
for (const s of [
  'I will have them call you back.',
  'Someone will call you back today.',
  'The owner will call you this afternoon.',
]) {
  t(`PASSES when notes authorize: ${s}`, () => assert.equal(caught(s, { callbackOk: true }), null));
}

t('missing state runs the floor at FULL STRENGTH, never permissive', () => {
  assert.equal(guardClause(P, 'I will have them call you back.', [], undefined).ok, false);
  assert.equal(guardClause(P, 'I will have them call you back.', [], null).ok, false);
  assert.equal(guardClause(P, 'I will have them call you back.', [], {}).ok, false);
});

// ── the notes reader, both directions ────────────────────────────────────────────────────────────
for (const s of [
  'Bright Plumbing. Hours 8-5. After hours we call back the next morning.',
  'The owner will call back within the hour.',
  'We return all calls same day.',
  'Calls are returned by end of day.',
  'Somebody calls back within 30 minutes during business hours.',
]) t(`notes AUTHORIZE: ${s.slice(0, 46)}`, () => assert.equal(notesAuthorizeCallback(s), true));

for (const s of [
  'Bright Plumbing and Heating. Hours 8 to 5 Monday to Friday.',
  'After hours goes to voicemail.',            // where a call LANDS, not a promise to return it
  'Call us on 555 0100 for emergencies.',      // instruction to the CALLER, opposite direction
  'Do not call the owner cell.',               // a prohibition containing the word call
  'We do drains, water heaters and gas lines.',
  '',
  null,
  undefined,
]) t(`notes do NOT authorize: ${String(s).slice(0, 46)}`, () => assert.equal(notesAuthorizeCallback(s), false));

// ── POSITIVE CONTROLS ────────────────────────────────────────────────────────────────────────────
t('POSITIVE CONTROL — the floor can fire', () => {
  assert.equal(caught('I will have them call you back.'), 'callback-promise');
});
t('POSITIVE CONTROL — the floor can stay quiet', () => {
  assert.equal(caught('Can I get your name and number?'), null);
});
t('POSITIVE CONTROL — notesAuthorizeCallback can return both values', () => {
  assert.equal(notesAuthorizeCallback('We return all calls same day.'), true);
  assert.equal(notesAuthorizeCallback('Hours 8 to 5.'), false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
