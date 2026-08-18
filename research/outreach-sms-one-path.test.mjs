// research/outreach-sms-one-path.test.mjs
//
// ★ THE TEST THAT WOULD HAVE CAUGHT IT, AND THE ONE THAT KEEPS IT FROM COMING BACK.
//
// `outreach.sendSms()` — the admin console's "Send a text" button — had its OWN Twilio POST
// instead of going through `outbox.sms()`, the path every message this account has actually
// delivered uses. Two implementations of one thing, drifted apart, and every difference was a
// defect on the outreach side:
//
//   1. NO SUPPRESSION CHECK. outbox.sms() reads the do-not-contact list and fails CLOSED when it
//      cannot be read. outreach checked nothing, so the console could text somebody who had
//      already replied STOP. Statutory consequence, and the quietest of the three failures:
//      nothing errors, no status goes red, the message simply goes.
//   2. NO MessagingServiceSid. Always a bare `From`. Every delivered message on this account
//      carries mg=MGab661e…; the single bare-From send in the log failed 30008. A bare From on an
//      A2P-registered brand is unregistered traffic and carriers drop it.
//   3. FELL BACK TO THE PUBLIC DEMO LINE. With ANSWERED_SMS_FROM unset — its state in production —
//      the fallback was ANSWERED_DEMO_NUMBER, the number strangers call to hear the demo, placed
//      into a named contractor's SMS thread. jobs.mjs already refuses that substitution for voice.
//
// `crm_messages` held 0 rows, ever, which is why none of this had surfaced: the button had never
// been pressed. It was armed and wrong, waiting.
//
// WHY THESE ASSERTIONS ARE STRUCTURAL, said plainly rather than dressed up: executing sendSms()
// requires Twilio credentials, the database and a real recipient, and the only honest end-to-end
// proof of "it refuses a suppressed number" would be attempting to text a real person. A source
// test is weaker than an executed one. It is strong enough for the regression that matters here —
// somebody reintroducing a direct Twilio POST on this path — and that is the whole claim.
//
// Each assertion carries a POSITIVE CONTROL: a string that SHOULD match, proving the pattern is
// capable of matching at all. A regex that silently stopped matching would otherwise read as a
// pass forever. (This estate has shipped a guard that was a tautology and a blur-detector that
// read 0 in both states.)
import assert from 'node:assert/strict';
import fs from 'node:fs';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

const outreach = fs.readFileSync(new URL('../netlify/functions/lib/outreach.mjs', import.meta.url), 'utf8');
const outbox = fs.readFileSync(new URL('../netlify/functions/lib/outbox.mjs', import.meta.url), 'utf8');

// the body of sendSms only, so an assertion about "this function" cannot be satisfied by some
// other function in the same file that happens to contain the string.
const smsBodyRaw = (() => {
  const i = outreach.indexOf('export async function sendSms');
  assert.ok(i > -1, 'sendSms is gone from outreach.mjs — this test is testing nothing');
  const j = outreach.indexOf('\nexport ', i + 10);
  return outreach.slice(i, j === -1 ? outreach.length : j);
})();

// ★ STRIP COMMENTS BEFORE ASSERTING ON CODE. My first version of this file asserted that
//   ANSWERED_DEMO_NUMBER does not appear in sendSms — and it FAILED, because the explanation
//   directly above the function names the defect it is explaining. The test was reading my own
//   prose as the thing it was testing. A comment describing a bug is not the bug, and a checker
//   that cannot tell them apart will fail forever on well-documented code, or worse, pass because
//   somebody deleted the comment.
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
const smsBody = stripComments(smsBodyRaw);

console.log('\n── there is ONE sms send path, and the admin button uses it ──');

t('POSITIVE CONTROL: the sendSms body was actually located', () => {
  assert.ok(smsBody.length > 200 && /sendSms/.test(smsBody),
    'the slice is empty or wrong, so every assertion below is vacuous');
});

t('POSITIVE CONTROL: comment stripping works and did not eat the code', () => {
  assert.ok(!/FELL BACK TO THE PUBLIC DEMO LINE/.test(smsBody),
    'comments are not being stripped, so the assertions below read prose instead of code');
  assert.ok(/recordBlocked/.test(smsBody),
    'comment stripping removed real code — the assertions below are now testing a mangled body');
});

t('POSITIVE CONTROL: the direct-Twilio pattern CAN match', () => {
  const TWILIO_RE = /api\.twilio\.com[^\n]*Messages\.json/;
  assert.ok(TWILIO_RE.test("fetch('https://api.twilio.com/2010-04-01/Accounts/x/Messages.json')"),
    'the pattern used by the direct-POST assertion cannot match even a literal direct POST, so '
    + 'that assertion can never fail and proves nothing');
});

t('sendSms delegates to outbox', () => {
  assert.ok(/outbox\.sms\(|from '\.\/outbox\.mjs'|import\('\.\/outbox\.mjs'\)/.test(smsBody),
    'the admin text path no longer goes through outbox.sms(), so it has its own send again');
});

t('sendSms does NOT POST to Twilio directly', () => {
  assert.ok(!/api\.twilio\.com[^\n]*Messages\.json/.test(smsBody),
    'a direct Twilio Messages.json POST is back on this path: it will bypass the suppression '
    + 'check and the messaging service, exactly as before');
});

t('sendSms does not fall back to the public demo number', () => {
  assert.ok(!/ANSWERED_DEMO_NUMBER/.test(smsBody),
    'the demo receptionist line is a sender fallback again: it would appear in a contractor thread');
});

console.log('\n── the properties that must live in the ONE path ──');

t('outbox.sms checks the do-not-contact list', () => {
  assert.ok(/suppressed/.test(outbox) && /dialContext|suppression/.test(outbox),
    'the single send path no longer consults the suppression list');
});

t('outbox.sms fails CLOSED when the list cannot be read', () => {
  assert.ok(/could not be (read|checked)[^\n]*nothing was sent|not a cleared number/.test(outbox),
    'an unreadable suppression list no longer refuses the send — an unchecked number is being '
    + 'treated as a cleared number');
});

t('outbox.sms prefers MessagingServiceSid over a bare From', () => {
  assert.ok(/MessagingServiceSid/.test(outbox),
    'the messaging service is gone: sends will go out as unregistered bare-From traffic');
});

console.log('\n── a refusal must be recorded, not dropped ──');

t('a skipped send is written to the CRM as blocked', () => {
  assert.ok(/skipped/.test(smsBody) && /recordBlocked/.test(smsBody),
    'refusals are being dropped again. crm_messages read 0 rows for weeks partly because not '
    + 'even blocked rows were landing, so "nothing was sent" and "nothing was attempted" looked '
    + 'identical from the database');
});

t('the row carries the provider status, not a bare "sent"', () => {
  assert.ok(/provider_status/.test(smsBody),
    'Twilio queued/accepted is being recorded as plain "sent". Acceptance is not delivery: the '
    + 'carrier rejection for an unregistered campaign arrives later on the status callback');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
