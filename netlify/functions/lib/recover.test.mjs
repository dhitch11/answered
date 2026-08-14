// recover.test.mjs — the deterministic half of Recover, exercised with real inputs.
//
// The promise parser and the never-threaten floor are the two places where being wrong is
// expensive and silent: a misread date is a call to somebody who asked not to be called until
// Friday, and a sentence that slips the floor is 1692e(5). Neither failure announces itself, so
// both are asserted here against the exact shapes Twilio speech recognition actually returns.
//
//   node --test netlify/functions/lib/recover.test.mjs
//
// ★ IT LIVES IN lib/ AND THAT IS NOT A STYLE CHOICE. Netlify treats every top-level file in
// netlify/functions/ as a function, and a function called "recover.test" has a dot in its name,
// which the deploy API rejects with a 422 that names no file: "Incorrect function names." It fails
// the ENTIRE build, for every lane, not just the test. personas.test.mjs is in lib/ for the same
// reason. Found by deploying, because nothing local catches it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  opening, debtStatement, VOICEMAIL, floorCheck, isStop, isDispute, isWrongNumber, saidYes, saidNo,
  parseAmountCents, parseDate, extractPromise, spokenMoney, spokenNumber,
} from './recover-script.mjs';
import { callingWindow, zonesFor, insideWindow, STATE_ZONES } from './hours.mjs';

// ── the locked opening ───────────────────────────────────────────────────────────────────────
test('the first sentence is the locked one and it names the creditor', () => {
  const line = opening({ businessName: 'Rivera Plumbing', callbackNumber: '+19165550123', debtorName: 'Sam Okafor' });
  assert.ok(line.startsWith('This is an A I assistant calling for Rivera Plumbing.'), line);
  assert.match(line, /recorded/);
  assert.match(line, /transcribing/);
  assert.match(line, /9 1 6, 5 5 5, 0 1 2 3/);
});

test('the opening says nothing about a debt, because we do not know who picked up', () => {
  const line = opening({ businessName: 'Rivera Plumbing', callbackNumber: '+19165550123', debtorName: 'Sam Okafor' });
  assert.doesNotMatch(line, /invoice|owe|owed|balance|debt|pay|past due|\$/i);
});

test('a call with no creditor name cannot be opened at all', () => {
  assert.throws(() => opening({ businessName: '', callbackNumber: '+19165550123' }), /name of the business/);
});

test('a voicemail names no debt, because a machine is not the debtor', () => {
  const vm = VOICEMAIL({ businessName: 'Rivera Plumbing', callbackNumber: '+19165550123', debtorName: 'Sam' });
  assert.doesNotMatch(vm, /invoice|owe|debt|balance|past due|collect/i);
  assert.match(vm, /^This is an A I assistant calling for Rivera Plumbing\./);
});

test('the debt statement carries the amount from the record, spoken as money', () => {
  const s = debtStatement({ businessName: 'Rivera Plumbing', amountCents: 119300, invoiceNumber: '4821', jobDescription: 'water heater replacement', issuedAt: '2026-06-30' });
  assert.match(s, /1,193 dollars/);
  assert.match(s, /water heater replacement/);
});

// ── the never-threaten floor ─────────────────────────────────────────────────────────────────
test('the floor catches every shape of threat we have promised never to make', () => {
  const forbidden = [
    'We may have to take legal action on this.',
    'This could end up in court.',
    'I will have to send this to collections.',
    'This will go on your credit report.',
    'We can put a lien on the property.',
    'Our attorney will be in touch.',
    'There will be a late fee if you wait.',
    'You have to pay today.',
    'There will be consequences.',
    'You owe $1,193.',
    'That is 1193 dollars outstanding.',
  ];
  for (const t of forbidden) {
    const v = floorCheck(t);
    assert.equal(v.ok, false, `NOT CAUGHT: ${t}`);
  }
});

test('the floor lets ordinary human acknowledgement through', () => {
  for (const t of [
    'I hear you, that sounds like a rough month.',
    'Totally understand, thanks for being straight with me.',
    'No problem at all, I appreciate you picking up.',
    'That makes sense.',
  ]) assert.equal(floorCheck(t).ok, true, `WRONGLY BLOCKED: ${t}`);
});

// ── stop, and dispute, which are different ───────────────────────────────────────────────────
test('a stop is heard in every shape somebody actually says it', () => {
  for (const t of ['stop calling me', 'Stop.', 'take me off your list', 'do not call this number again',
    'quit calling', 'lose my number', 'leave me alone', 'please stop']) {
    assert.equal(isStop(t), true, `MISSED STOP: ${t}`);
  }
});

test('a contractor describing their day is not a stop', () => {
  // The exact failure lib/scripts.mjs measured on a live call: a bare \bstop\b suppressed somebody
  // for answering the question they were asked.
  for (const t of ['we stop taking calls at six', 'the truck stopped working', 'I stop by on Fridays']) {
    assert.equal(isStop(t), false, `FALSE STOP: ${t}`);
  }
});

test('a dispute is not a stop and never writes a suppression', () => {
  for (const t of ['I already paid that', 'I dispute this', 'that is not my bill', 'I never hired them',
    'the work was never finished', 'talk to my lawyer']) {
    assert.equal(isDispute(t), true, `MISSED DISPUTE: ${t}`);
  }
  assert.equal(isStop('I already paid that'), false);
});

test('a wrong number is its own verdict, not a dispute of the debt', () => {
  // ★ THE DEFECT THIS TEST EXISTS FOR, found by driving a live call rather than by reading code:
  // "no, wrong number" matched the dispute list, so a perfectly valid invoice was frozen as
  // "disputed" and the number that reaches nobody stayed on it. No debt detail leaked, which is
  // exactly why nothing downstream would ever have flagged it.
  for (const t of ['no, wrong number', 'you have the wrong number', 'wrong person',
    'there is no Sam here', 'never heard of him', 'nobody here by that name']) {
    assert.equal(isWrongNumber(t), true, `MISSED WRONG NUMBER: ${t}`);
    assert.equal(isDispute(t), false, `STILL FILED AS A DISPUTE: ${t}`);
  }
});

test('a real dispute is still a dispute, and is not a wrong number', () => {
  for (const t of ['I already paid that', 'that is the wrong amount', 'the work was never finished']) {
    assert.equal(isDispute(t), true, t);
    assert.equal(isWrongNumber(t), false, t);
  }
});

test('identity is only confirmed on a real yes', () => {
  for (const t of ['yes', 'yeah this is him', 'speaking', "that's me"]) assert.equal(saidYes(t), true, t);
  for (const t of ['no', 'wrong number', 'he does not live here', 'she is not here']) assert.equal(saidNo(t), true, t);
  assert.equal(saidYes('uhh who is this'), false);
});

// ── the amount ───────────────────────────────────────────────────────────────────────────────
test('an amount is read the way people say it, and a date is never mistaken for one', () => {
  assert.equal(parseAmountCents('I can do $500', 119300).cents, 50000);
  assert.equal(parseAmountCents('I can send 500 dollars', 119300).cents, 50000);
  assert.equal(parseAmountCents('five hundred dollars', 119300).cents, 50000);
  assert.equal(parseAmountCents('I will pay the whole thing', 119300).cents, 119300);
  assert.equal(parseAmountCents('let me do half', 119300).cents, 59650);
  // ★ THE EXPENSIVE MISREAD. "the 15th" is a day. Reading it as fifteen dollars would put a $15
  // promise against an $1,193 invoice and nobody downstream would ever question it.
  assert.equal(parseAmountCents('I will pay on the 15th', 119300).cents, null);
  assert.equal(parseAmountCents('Friday works', 119300).cents, null);
});

// ── the date, in the debtor's own week ───────────────────────────────────────────────────────
const AT = (isoUtc) => new Date(isoUtc);

test('a weekday resolves forward, in the debtor timezone', () => {
  // 2026-08-14 is a Friday. "Thursday" from a Friday is six days out.
  const r = parseDate('I can do it Thursday', { timezone: 'America/Los_Angeles', now: AT('2026-08-14T18:00:00Z') });
  assert.equal(r.iso, '2026-08-20');
});

test('the same weekday spoken on that weekday means the NEXT one, never today', () => {
  const r = parseDate('Friday', { timezone: 'America/Los_Angeles', now: AT('2026-08-14T18:00:00Z') });
  assert.equal(r.iso, '2026-08-21');
});

test('next friday is a week further out than friday', () => {
  const a = parseDate('friday', { timezone: 'America/Los_Angeles', now: AT('2026-08-14T18:00:00Z') }).iso;
  const b = parseDate('next friday', { timezone: 'America/Los_Angeles', now: AT('2026-08-14T18:00:00Z') }).iso;
  assert.equal(a, '2026-08-21');
  assert.equal(b, '2026-08-28');
});

test('the timezone is the debtor own, so a late call does not roll their date forward', () => {
  // 2026-08-15 04:30 UTC is still Friday the 14th at 21:30 in Los Angeles.
  const pacific = parseDate('tomorrow', { timezone: 'America/Los_Angeles', now: AT('2026-08-15T04:30:00Z') });
  const eastern = parseDate('tomorrow', { timezone: 'America/New_York', now: AT('2026-08-15T04:30:00Z') });
  assert.equal(pacific.iso, '2026-08-15');
  assert.equal(eastern.iso, '2026-08-16');
  assert.notEqual(pacific.iso, eastern.iso);
});

test('day of month, month and day, relative weeks, and the end of the month', () => {
  const now = AT('2026-08-14T18:00:00Z');
  const tz = 'America/Los_Angeles';
  assert.equal(parseDate('on the 20th', { timezone: tz, now }).iso, '2026-08-20');
  assert.equal(parseDate('the 3rd', { timezone: tz, now }).iso, '2026-09-03');   // already past in August
  assert.equal(parseDate('September 3rd', { timezone: tz, now }).iso, '2026-09-03');
  assert.equal(parseDate('in two weeks', { timezone: tz, now }).iso, '2026-08-28');
  assert.equal(parseDate('end of the month', { timezone: tz, now }).iso, '2026-08-31');
  assert.equal(parseDate('tomorrow', { timezone: tz, now }).iso, '2026-08-15');
});

test('payday is not a date and is never turned into one', () => {
  assert.equal(parseDate('when I get paid', { timezone: 'America/Los_Angeles', now: AT('2026-08-14T18:00:00Z') }).iso, null);
});

// ── the promise ──────────────────────────────────────────────────────────────────────────────
const NOW = AT('2026-08-14T18:00:00Z');
const TZ = 'America/Los_Angeles';

test('a real promise is captured with its amount, its date and the words they used', () => {
  const r = extractPromise('Yeah I can get you the whole eleven ninety three on Thursday', { balanceCents: 119300, timezone: TZ, now: NOW });
  assert.ok(r.promise, r.reason);
  assert.equal(r.promise.promised_for, '2026-08-20');
  assert.equal(r.promise.spoken_text, 'Yeah I can get you the whole eleven ninety three on Thursday');
});

test('willingness with no date is NOT a promise, it is a question we still have to ask', () => {
  const r = extractPromise('Yeah I will take care of it', { balanceCents: 119300, timezone: TZ, now: NOW });
  assert.equal(r.promise, null);
  assert.equal(r.needs_date, true);
});

test('a partial payment promise keeps the amount they actually said', () => {
  const r = extractPromise('I can send $500 on Monday', { balanceCents: 119300, timezone: TZ, now: NOW });
  assert.equal(r.promise.amount_cents, 50000);
  assert.equal(r.promise.promised_for, '2026-08-17');
});

test('no amount named means the whole balance, never zero', () => {
  const r = extractPromise('I will pay it Friday', { balanceCents: 119300, timezone: TZ, now: NOW });
  assert.equal(r.promise.amount_cents, 119300);
});

test('an unrelated sentence produces no promise at all', () => {
  const r = extractPromise('who is this again', { balanceCents: 119300, timezone: TZ, now: NOW });
  assert.equal(r.promise, null);
  assert.equal(r.needs_date, false);
});

// ── the calling window, in the debtor local time ─────────────────────────────────────────────
test('the state the work was done in beats the area code, because a mobile travels', () => {
  // A New York number on a job in California: the window must follow California.
  const z = zonesFor({ state: 'CA', phone: '+12125550123' });
  assert.equal(z.source, 'state');
  assert.deepEqual(z.zones, ['America/Los_Angeles']);
});

test('a split state is only open when it is open on both sides of the line', () => {
  assert.deepEqual(STATE_ZONES.FL, ['America/New_York', 'America/Chicago']);
  // 2026-08-14 12:30 UTC is 08:30 Eastern and 07:30 Central. Florida must be SHUT.
  const at = AT('2026-08-14T12:30:00Z');
  assert.equal(insideWindow(STATE_ZONES.FL, at).ok, false);
  assert.equal(insideWindow(['America/New_York'], at).ok, true);
});

test('an unknown location is a refusal, never a default', () => {
  const w = callingWindow({ state: 'ZZ', phone: '+19995550123', at: AT('2026-08-14T18:00:00Z') });
  assert.equal(w.ok, false);
  assert.equal(w.code, 'unknown_zone');
  assert.match(w.reason, /do not guess/);
});

test('inside and outside the 8 to 9 window, in their time', () => {
  // 15:00 UTC = 08:00 Pacific exactly, the first legal minute.
  assert.equal(callingWindow({ state: 'CA', at: AT('2026-08-14T15:00:00Z') }).ok, true);
  // 14:59 UTC = 07:59 Pacific.
  const early = callingWindow({ state: 'CA', at: AT('2026-08-14T14:59:00Z') });
  assert.equal(early.ok, false);
  assert.equal(early.code, 'outside_window');
  assert.ok(early.retry_after_seconds > 0);
  // 04:00 UTC = 21:00 Pacific, the first minute that is too late.
  assert.equal(callingWindow({ state: 'CA', at: AT('2026-08-15T04:00:00Z') }).ok, false);
});

test('money and phone numbers are spoken, never printed', () => {
  assert.equal(spokenMoney(119300), '1,193 dollars');
  assert.equal(spokenMoney(50050), '500 dollars and 50 cents');
  assert.equal(spokenNumber('+19165550123'), '9 1 6, 5 5 5, 0 1 2 3');
});
