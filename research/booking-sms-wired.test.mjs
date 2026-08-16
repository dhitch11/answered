// research/booking-sms-wired.test.mjs
//
// ★ THE TEST THAT WOULD HAVE CAUGHT THE DEFECT.
//
// /api/booking reported `sms: {ok:false, skipped:true, reason: <the A2P sentence>}` in every
// response, and NOTHING EVER CALLED sms(). The value was hardcoded. It was true by luck — texting is
// off, so "skipped" was the right answer — and it would have stayed "skipped" forever after the
// carrier approved us, because no code path existed to change it.
//
// Every assertion here is on the SHAPE OF THE SOURCE rather than on a live response, because the
// handler needs a signed token, a database and Resend to run end to end. A structural test is weaker
// than an executed one and I am saying so rather than dressing it up — but it is strong enough to
// catch a hardcoded literal being reintroduced, which is the specific regression that matters.
import assert from 'node:assert/strict';
import fs from 'node:fs';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

const src = fs.readFileSync(new URL('../netlify/functions/booking.mjs', import.meta.url), 'utf8');

console.log('\n── the booking path must ATTEMPT the text, not assert about it ──');

t('booking.mjs actually calls out.sms', () => {
  assert.ok(/out\.sms\(/.test(src),
    'the live booking path contains no out.sms call, so approving the campaign would change nothing');
});

t('the response no longer hardcodes a skipped sms result', () => {
  assert.ok(!/sms:\s*\{\s*ok:\s*false,\s*skipped:\s*true,\s*reason:\s*SMS_TRUTH\s*\}/.test(src),
    'the hardcoded literal is back: the API is reporting on a channel it never attempted');
});

t('the response carries the real result variable', () => {
  assert.ok(/sms:\s*smsRes/.test(src), 'the response must return what the send path actually returned');
});

t('the send is awaited before the response is built', () => {
  const send = src.indexOf('out.sms(');
  const resp = src.indexOf('return json(201');
  assert.ok(send > 0 && send < resp, 'the text must be attempted before the response reports on it');
});

console.log('\n── who gets texted: the shop, never the homeowner ──');

t('the recipient is the SHOP phone, not the customer phone', () => {
  const m = src.match(/const to = bk\.e164\(job\.(\w+)/);
  assert.ok(m, 'could not find the recipient assignment');
  assert.equal(m[1], 'sp', `texting job.${m[1]} — the homeowner never consented to messages from us`);
});

t('a demo booking texts nobody', () => {
  assert.ok(/job\.m === 'demo'[\s\S]{0,120}skipped:\s*true/.test(src),
    'a demo booking must not send a real text');
});

t('the helper it calls actually exists', async () => {
  const bk = fs.readFileSync(new URL('../netlify/functions/lib/booking.mjs', import.meta.url), 'utf8');
  assert.ok(/export function e164/.test(bk),
    'bk.e164 does not exist, so every recipient would resolve undefined and silently skip forever');
});

console.log('\n── it must never be able to fail a booking that already happened ──');

t('the send is wrapped so a throw cannot 500 the response', () => {
  assert.ok(/\)\(\)\.catch\(/.test(src) || /\.catch\(\(e\) =>/.test(src),
    'an unguarded throw here would fail a booking the customer already has a link to');
});

console.log(`\n${fail ? 'FAILED' : 'PASSED'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
