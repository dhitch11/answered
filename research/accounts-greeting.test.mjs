// accounts-greeting.test.mjs — the inbound business-line greeting, checked against the PAGE that
// sells it, not against a string I retyped into an assertion.
//
// ═══ WHY THIS FILE PARSES HTML INSTEAD OF ASSERTING A LITERAL ═══
//
// The defect this pins was not a bug in a function. Both halves were internally fine. `/recording`
// told customers "Every call our AI is on says two things in its first sentence: that you are
// talking to an AI, and that the call is recorded," and `renderGreeting()` said neither. Nothing
// connected them, so nothing could notice. Two lanes found it by reading, an hour apart, and only
// because ANSWERED_CUSTOMER_AGENT_ID happened to be unset was it still dormant.
//
// A test that hardcodes the expected greeting would have passed on the day the page was written
// and every day after. So this reads recording.html, extracts the promise, and checks the greeting
// against it. Change either one alone and this goes red. That is the entire point: the promise and
// the code are now the same fact measured in two places.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { renderGreeting } from '../netlify/functions/lib/accounts.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.error(`  FAIL  ${name}\n        ${e.message}`); }
};

console.log('inbound greeting vs the /recording promise\n');

// ── the page, as a customer reads it ─────────────────────────────────────────────────────────────
const pageText = (() => {
  const raw = readFileSync(new URL('../recording.html', import.meta.url), 'utf8');
  return raw
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;|&rsquo;/g, "'")
    .replace(/\s+/g, ' ');
})();

// ★ THE PROMISE IS LOAD-BEARING, SO ITS ABSENCE IS A FAILURE, NOT A SKIP. If someone rewrites the
// page and the sentence goes away, this test must not quietly start passing on an empty premise.
t('the page still makes the promise this test enforces', () => {
  assert.match(pageText, /first sentence/i, 'recording.html no longer says "first sentence"');
  assert.match(pageText, /talking to an AI/i, 'recording.html no longer promises AI disclosure');
  assert.match(pageText, /the call is recorded/i, 'recording.html no longer promises a recording notice');
});

// ── the greeting, sentence by sentence ───────────────────────────────────────────────────────────
// Split only where a period is followed by whitespace. "Acme Plumbing Co., this is..." does not
// split, because the template puts a comma there; that is checked below rather than assumed.
const firstSentence = (s) => String(s).split(/(?<=[.!?])\s+/)[0];

const mk = (config) => ({ id: 'acct_test', business_name: 'Bright Plumbing and Heating', config });
const SAYS = 'Bright Plumbing and Heating';

const VARIANTS = {
  'named':                mk({ business_says: SAYS, greeting_name: 'Thomas' }),
  'unnamed':              mk({ business_says: SAYS }),
  'falls back to business_name': mk({}),
  'name with an initial': mk({ business_says: SAYS, greeting_name: 'J T' }),
  'business name ending in an abbreviation': mk({ business_says: 'Acme Plumbing Co.', greeting_name: 'Thomas' }),
};

for (const [label, acct] of Object.entries(VARIANTS)) {
  const g = renderGreeting(acct);
  t(`${label}: renders`, () => assert.ok(g && g.length > 20, `got ${JSON.stringify(g)}`));
  t(`${label}: FIRST SENTENCE discloses the AI`, () => {
    assert.match(firstSentence(g), /\bAI assistant\b/i, `first sentence was: "${firstSentence(g)}"`);
  });
  t(`${label}: FIRST SENTENCE discloses the recording`, () => {
    assert.match(firstSentence(g), /\brecorded\b/i, `first sentence was: "${firstSentence(g)}"`);
  });
  // ★ The estate's own legal work puts the biggest exposure on the AI that LISTENS, not the one
  // that talks: Cal. Penal Code 632.7 has no confidential-communication element and reaches any
  // call involving a cell phone (Smith v. LoanMe (2021) 11 Cal.5th 183), and Ribas v. Clark (1985)
  // 38 Cal.3d 355 found liability against a listener who never spoke. "Recorded" names the wrong
  // object on its own. The sentence has to name the second auditor.
  t(`${label}: names the second auditor, not just the recorder`, () => {
    assert.match(firstSentence(g), /\btranscrib/i, `first sentence was: "${firstSentence(g)}"`);
  });
  t(`${label}: names the business`, () => assert.ok(/Bright Plumbing|Acme Plumbing/.test(g), g));
  t(`${label}: hands the turn back with a question`, () => assert.ok(g.trim().endsWith('?'), g));
  t(`${label}: no em dash, no digits`, () => {
    assert.ok(!g.includes('—'), 'em dash in net-new copy');
    assert.ok(!/\d/.test(g), 'a digit a voice would read as a quantity');
  });
}

t('an account with no config gets no greeting, rather than a greeting about nobody', () => {
  assert.equal(renderGreeting({ id: 'x', business_name: 'X' }), null);
  assert.equal(renderGreeting(null), null);
});

// ── POSITIVE CONTROLS ────────────────────────────────────────────────────────────────────────────
// A test that cannot fail is not a test. These prove each check can go red, using the exact wording
// that shipped before the fix.
t('POSITIVE CONTROL — the pre-fix greeting FAILS the first-sentence check', () => {
  const before = 'Thanks for calling Bright Plumbing and Heating, this is Thomas, an AI assistant. How can I help?';
  assert.doesNotMatch(firstSentence(before), /\brecorded\b/i,
    'the check cannot distinguish the broken greeting from the fixed one');
});
t('POSITIVE CONTROL — disclosure moved to sentence two FAILS', () => {
  const secondPlace = 'Thanks for calling Bright Plumbing. I am an AI assistant and this call is recorded. How can I help?';
  assert.doesNotMatch(firstSentence(secondPlace), /\bAI assistant\b/i,
    'the sentence splitter is not splitting; every first-sentence check above is vacuous');
});
t('POSITIVE CONTROL — the splitter really splits', () => {
  assert.equal(firstSentence('One. Two. Three.'), 'One.');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
