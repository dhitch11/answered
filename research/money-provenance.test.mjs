// money-provenance.test.mjs — a caller's own phone number must not license a price.
//
// ═══ THE DEFECT ═══
//
// `/trust` says, in its own words: "The guardrail that matters most. It will never quote a price."
// That sentence was FALSE in the commonest situation on an inbound call. Measured on the shipped
// guard by @LANE-FOOTER, with positive controls:
//
//   "My water heater is leaking"  ->  "The visit is 350."   BLOCKED
//   "My number is 916 350 4869"   ->  "The visit is 350."   ALLOWED, spoken as fact
//
// `numberSet` records every digit run the caller said plus consecutive concatenations, so one phone
// number contributes {916, 916350, 9163504869, 350, 3504869, 4869} — and the guard then admitted
// any of those in any role. Giving a callback number is the single most common thing a caller does,
// so the guard was weakest on nearly every real call.
//
// ★ IT WAS A DOCUMENTED, KNOWN HOLE. personas.mjs said so above `badNumeral`: "a digit-run the
// caller genuinely spoke is still allowed in any role ... Distinguishing a price from a phone
// fragment needs semantic role, which this guard does not have." So the live defect was never the
// gap on its own — it was an absolute public promise sitting on top of a gap the code admitted to.
// A known limitation plus an unqualified claim is how a true note becomes a false statement.
//
// THE FIX, which is the semantic role that comment asked for, is two ideas:
//   1. PROVENANCE — the owner's figures (from the notes) may be quoted as facts about the business;
//      the caller's may be read back and nothing else.
//   2. ROLE — in a price-shaped clause only the owner's figures are admissible. Everywhere else the
//      caller's own numbers still pass, so read-backs, times, addresses and counts are untouched.

import { strict as assert } from 'node:assert';
import { PERSONAS, contextDigits, guardClause } from '../netlify/functions/lib/personas.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.error(`  FAIL  ${name}\n        ${e.message}`); }
};
const verdict = (pid, texts, sys, out) => {
  const p = PERSONAS[pid];
  const g = guardClause(p, out, contextDigits(p, texts, sys), {});
  return g.ok ? 'allowed' : `blocked:${g.by}`;
};
const PHONE = ['My number is 916 350 4869'];

console.log('money provenance and role\n');

// ── the defect itself, both fragments ────────────────────────────────────────────────────────────
t('★ a price built from a caller phone fragment is REFUSED', () => {
  assert.match(verdict('riley', PHONE, '', 'The visit is 350.'), /^blocked/);
});
t('★ and from any other fragment of the same number', () => {
  for (const out of ['It runs 4869 for the trip.', 'The call-out is 916.', 'Our rate is 3504869.']) {
    assert.match(verdict('riley', PHONE, '', out), /^blocked/, out);
  }
});
t('POSITIVE CONTROL — with no number given at all it was always blocked', () => {
  assert.match(verdict('riley', ['leaking heater'], '', 'The visit is 350.'), /^blocked/);
});

// ── what must NOT regress: the caller's numbers in every honest role ─────────────────────────────
t('a READ-BACK still works, spaced and grouped', () => {
  assert.equal(verdict('riley', PHONE, '', 'Let me read that back, 916 350 4869.'), 'allowed');
  assert.equal(verdict('riley', PHONE, '', 'I have you at 9163504869.'), 'allowed');
});
t("the caller's time, count and address still pass", () => {
  assert.equal(verdict('riley', ['come at 7:30'], '', 'Okay, 7:30.'), 'allowed');
  assert.equal(verdict('riley', ['3 units are down'], '', 'All 3 units, got it.'), 'allowed');
  assert.equal(verdict('riley', ['I am at 1420 Pine'], '', 'Got it, 1420 Pine.'), 'allowed');
});
t('an invented number is still refused', () => {
  assert.match(verdict('riley', PHONE, '', 'We have 12 trucks out today.'), /^blocked/);
});

// ── the business line: the OWNER's price is quotable, the caller's is not ────────────────────────
t("the owner's written price IS quotable", () => {
  assert.equal(verdict('customer', ['what do you charge'], 'Diagnostic visit is 350.', 'The visit is 350.'), 'allowed');
});
t('★ but a caller fragment is NOT, even on the business line', () => {
  assert.match(verdict('customer', PHONE, 'Diagnostic visit is 275.', 'The visit is 350.'), /^blocked/);
});
t('the business line still reads back the caller', () => {
  assert.equal(verdict('customer', PHONE, 'Visit is 275.', 'Let me read that back, 916 350 4869.'), 'allowed');
});

// ── the money-WORD path is owner-only and needs no role test ─────────────────────────────────────
t('spelled money on a caller fragment is refused', () => {
  assert.match(verdict('riley', PHONE, '', 'It is three fifty dollars.'), /^blocked/);
});
t('riley may never quote a price at all, which is what /trust promises', () => {
  // riley reads no owner notes by design (its ctx takes one argument and cannot widen), so its
  // owner set is always empty and every price-shaped clause with a figure is refused.
  for (const out of ['The visit is 350.', 'That runs 89 dollars.', 'Our fee is 120.', 'The diagnostic is 99.']) {
    assert.match(verdict('riley', PHONE, 'Visit is 350.', out), /^blocked/, out);
  }
});

// ── a limitation kept honest rather than hidden ──────────────────────────────────────────────────
t('KNOWN GAP, pre-existing and fails CLOSED: "three fifty" composes to 53, not 350', () => {
  // composeNumberWords sums word values, so "three fifty" is 3+50. Colloquially it is 350. The
  // effect is that an owner who wrote 350 gets a PIVOT when the voice says "three fifty dollars"
  // rather than a false price. Verified pre-existing by stashing this change and re-running.
  // Recorded as a test so the direction is deliberate: refusing a true price is a quality cost,
  // saying a false one is a safety cost, and this errs on the safe side.
  assert.match(verdict('customer', ['how much'], 'Visit is 350 dollars.', 'It is three fifty dollars.'), /^blocked/);
});

// ── POSITIVE CONTROLS on the machinery itself ────────────────────────────────────────────────────
t('POSITIVE CONTROL — the price-shape test can be false', () => {
  // If everything were price-shaped, every read-back above would "pass" for the wrong reason.
  assert.equal(verdict('riley', ['my number is 5551234'], '', 'Reading that back, 5551234.'), 'allowed');
});
t('POSITIVE CONTROL — the owner set can actually license something', () => {
  // If owner digits never licensed anything, the customer cases would pass by blanket refusal.
  assert.equal(verdict('customer', ['how much'], 'The fee is 89.', 'The fee is 89.'), 'allowed');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
