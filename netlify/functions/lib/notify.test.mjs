#!/usr/bin/env node
// notify.test.mjs — the preference model, the two signed links, and the calendar file.
//
// WHAT THIS SUITE IS FOR, AND WHAT IT DELIBERATELY IS NOT.
//
// It is NOT proof that the endpoints work. A green unit test is not evidence, and this repo has
// three separate incidents on record where both halves of a seam were individually correct and had
// never been run against each other. The serving-path checks live outside this file and are run
// against a real HTTP server.
//
// What this file DOES prove is the part that a request cannot: that the model is total (no input
// makes it throw or produce an undefined channel), that a forged token is refused for the four
// different reasons it can be forged, and that the .ics is parsed by two INDEPENDENT parsers that
// did not come from this codebase. A file I assert about myself is a file I graded myself on.
//
//   node netlify/functions/lib/notify.test.mjs
//
// The parsers are optional dev dependencies. When they are absent the suite says so out loud and
// counts it as a SKIP, never as a pass, because "we could not check" is not "it is fine".

import assert from 'node:assert/strict';
import * as np from './notify-prefs.mjs';

let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail += 1;
    failures.push([name, String((e && e.message) || e).split('\n')[0]]);
    console.log(`FAIL  ${name}\n      ${String((e && e.message) || e).split('\n').slice(0, 4).join('\n      ')}`);
  }
}
async function ta(name, fn) {
  try { await fn(); pass += 1; console.log(`PASS  ${name}`); }
  catch (e) {
    if (String((e && e.message) || e) === 'SKIP') {
      skip += 1;
      console.log(`SKIP  ${name}\n      the parser is not installed here, so this was NOT checked. That is not a pass.`);
      return;
    }
    fail += 1;
    failures.push([name, String((e && e.message) || e).split('\n')[0]]);
    console.log(`FAIL  ${name}\n      ${String((e && e.message) || e).split('\n').slice(0, 4).join('\n      ')}`);
  }
}
const skipped = (name, why) => { skip += 1; console.log(`SKIP  ${name}\n      ${why}`); };

const KEY = 'test-key-not-a-real-secret-0000000000';
const ENV = { ANSWERED_BOOKING_KEY: KEY, ANSWERED_CALENDAR_KEY: `${KEY}-cal` };

// ── the model is TOTAL ───────────────────────────────────────────────────────────────────────

console.log('\n── the preference model is total ─────────────────────────');

t('defaults are David\'s ruling: email on, sms on, call and voicemail off', () => {
  const d = np.defaults();
  for (const ek of np.EVENT_KEYS) {
    assert.equal(d.events[ek].email, true, `${ek}.email should default on`);
    assert.equal(d.events[ek].call, false, `${ek}.call should default off`);
    assert.equal(d.events[ek].voicemail, false, `${ek}.voicemail should default off`);
  }
  assert.equal(d.events['job.booked'].sms, true);
  assert.equal(d.events['daily.digest'].sms, false, 'a day of jobs is a list and a list does not fit in a text');
});

t('every junk input normalises to a complete object with no undefined channel', () => {
  const junk = [null, undefined, 0, '', 'nope', [], [1, 2], true, { events: 'no' },
    { events: { 'job.booked': null } }, { events: { 'not.an.event': { email: true } } },
    { to: { emails: 'a@b.co,a@b.co,c@d.co,e@f.co,g@h.co' } }, { calendar_epoch: -3 },
    { digest_hour: 99 }, { digest_hour: '7' }, { consent: { call: { on_at: 'not a date' } } }];
  for (const j of junk) {
    const p = np.normalize(j);
    for (const ek of np.EVENT_KEYS) {
      for (const ck of np.CHANNEL_KEYS) {
        assert.equal(typeof p.events[ek][ck], 'boolean', `${JSON.stringify(j)} -> ${ek}.${ck} is ${typeof p.events[ek][ck]}`);
      }
    }
    assert.ok(Number.isInteger(p.digest_hour) && p.digest_hour >= 0 && p.digest_hour <= 23);
    assert.ok(Number.isInteger(p.calendar_epoch) && p.calendar_epoch >= 0);
    assert.ok(Array.isArray(p.to.emails) && p.to.emails.length <= np.MAX_EXTRA_EMAILS);
  }
});

t('an unknown event key in stored prefs cannot add a channel or crash a read', () => {
  const p = np.normalize({ events: { 'evil.event': { email: true }, 'job.booked': { email: false } } });
  assert.equal(Object.keys(p.events).length, np.EVENT_KEYS.length);
  assert.equal(p.events['job.booked'].email, false, 'a real change must survive normalisation');
});

t('extra emails are deduped, validated and capped', () => {
  const p = np.normalize({ to: { emails: ['A@B.co', 'a@b.co', 'not-an-email', 'c@d.co', 'e@f.co', 'g@h.co'] } });
  assert.deepEqual(p.to.emails, ['a@b.co', 'c@d.co', 'e@f.co']);
});

t('a phone that is not a phone becomes empty, never a half number', () => {
  assert.equal(np.normalize({ to: { sms: '555' } }).to.sms, '');
  assert.equal(np.normalize({ to: { sms: '(916) 350-4869' } }).to.sms, '+19163504869');
});

// ── consent ──────────────────────────────────────────────────────────────────────────────────

console.log('\n── consent is stamped, and it is a record about the past ──');

t('switching a call on stamps who and when; switching it off anywhere else does not clear it', () => {
  const a = np.applyChanges(np.defaults(), { events: { 'job.after_hours': { call: true } } }, 'owner@shop.com');
  assert.ok(a.prefs.consent.call.on_at, 'no consent stamp was written');
  assert.equal(a.prefs.consent.call.by, 'owner@shop.com');
  const b = np.applyChanges(a.prefs, { events: { 'job.booked': { call: true } } }, 'owner@shop.com');
  assert.equal(b.prefs.consent.call.on_at, a.prefs.consent.call.on_at, 'the original stamp must not be rewritten');
});

t('consent clears only when the channel is off for every event', () => {
  const a = np.applyChanges(np.defaults(), { events: { 'job.after_hours': { call: true }, 'job.booked': { call: true } } }, 'o@s.com');
  const b = np.applyChanges(a.prefs, { events: { 'job.after_hours': { call: false } } }, 'o@s.com');
  assert.ok(b.prefs.consent.call.on_at, 'still on for job.booked, so consent still stands');
  const c = np.applyChanges(b.prefs, { events: { 'job.booked': { call: false } } }, 'o@s.com');
  assert.equal(c.prefs.consent.call.on_at, null, 'off everywhere means the permission is gone');
});

t('a change that changes nothing reports nothing changed', () => {
  const r = np.applyChanges(np.defaults(), { events: { 'job.booked': { email: true } } }, 'o@s.com');
  assert.deepEqual(r.changed, []);
});

t('replacing the calendar link REFUSES, because there is nowhere to record that it happened', () => {
  // MEASURED 2026-08-14 against the live database: sv_account_notify_save keeps a whitelist and
  // silently drops calendar_epoch, so a bump would change memory, report success, and leave the
  // old link working. A control that cannot act must not render as a control.
  const r = np.applyChanges(np.defaults(), { rotate_calendar: true }, 'o@s.com');
  assert.equal(r.prefs.calendar_epoch, 0, 'nothing may change while nothing can be recorded');
  assert.deepEqual(r.changed, []);
  assert.equal(r.refused.length, 1);
  assert.match(r.refused[0], /not switched on yet/i);
});

t('the flat row the database stores projects into the per event matrix faithfully', () => {
  const off = np.fromStored({ sms_on: false, call_on: false, email_extra: [], stored: true });
  for (const ek of np.EVENT_KEYS) {
    assert.equal(off.events[ek].email, true, 'email is automatic and is never a toggle');
    assert.equal(off.events[ek].sms, false);
    assert.equal(off.events[ek].call, false);
    assert.equal(off.events[ek].voicemail, false, 'nothing can leave a voicemail, so it is never on');
  }
  const afterOnly = np.fromStored({ sms_on: true, call_on: true, call_after_hours_only: true, stored: true });
  assert.equal(afterOnly.events['job.after_hours'].call, true, 'the 2am burst pipe is the one a call is for');
  assert.equal(afterOnly.events['job.booked'].call, false, 'a Tuesday booking is not');
  const always = np.fromStored({ sms_on: true, call_on: true, call_after_hours_only: false, stored: true });
  assert.equal(always.events['job.booked'].call, true);
});

t('the matrix goes back down to the six fields the database actually keeps, and nothing else', () => {
  const p = np.fromStored({ sms_on: true, call_on: true, call_after_hours_only: true, email_extra: ['a@b.co'], sms_to: '+19165550100', stored: true });
  const patch = np.toStored(p);
  for (const k of Object.keys(patch)) {
    assert.ok(np.STORED_FIELDS.includes(k), `${k} is not a field a round trip proved persists, so sending it would be a silent no-op`);
  }
  assert.equal(patch.call_on, true);
  assert.equal(patch.call_after_hours_only, true);
  const round = np.fromStored({ ...patch, stored: true });
  assert.deepEqual(round.events, p.events, 'a save then a read must give back the same matrix');
});

t('whatPersisted names the fields a 200 quietly threw away', () => {
  const asked = { sms_on: false, calendar_epoch: 3 };
  const got = { sms_on: false, stored: true };
  const r = np.whatPersisted(asked, got);
  assert.deepEqual(r.kept, ['sms_on']);
  assert.deepEqual(r.dropped, ['calendar_epoch'], 'a dropped field must be named, because the RPC returns 200 either way');
  assert.equal(r.stored, true);
});

// ── availability and the plan ────────────────────────────────────────────────────────────────

console.log('\n── what can actually deliver, and what the plan says ──────');

t('sms is dark and says why; call and voicemail are unavailable and say why', () => {
  const a = np.channelAvailability({ RESEND_API_KEY: 'x' });
  assert.equal(a.sms.available, false, 'the A2P campaign is not approved, so sms must not be available');
  assert.match(a.sms.reason, /A2P|approved|carrier/i);
  assert.equal(a.call.available, false);
  assert.equal(a.voicemail.available, false);
  assert.ok(a.call.reason.length > 20, 'a refusal with no sentence is a shrug');
});

t('email availability is read from the environment, not from a stored flag', () => {
  assert.equal(np.channelAvailability({ RESEND_API_KEY: '' }).email.available, false);
  assert.equal(np.channelAvailability({ RESEND_API_KEY: 'k' }).email.available, true);
});

t('the plan separates "you switched it off" from "we cannot"', () => {
  const p = np.normalize({ events: { 'job.booked': { email: false, sms: true } } });
  const decided = np.plan(p, 'job.booked', np.channelAvailability({ RESEND_API_KEY: 'k' }));
  const email = decided.skipped.find((s) => s.channel === 'email');
  const sms = decided.skipped.find((s) => s.channel === 'sms');
  assert.equal(email.off_by_choice, true);
  assert.equal(sms.off_by_choice, false, 'sms is on in the prefs and off in the world; that is not a choice');
});

t('switching every channel off produces a loud warning, not a silent override', () => {
  const p = np.normalize({ events: { 'job.booked': { email: false, sms: false, call: false, voicemail: false } } });
  const w = np.warningsFor(p, np.channelAvailability({ RESEND_API_KEY: 'k' }));
  const hit = w.find((x) => x.event === 'job.booked');
  assert.ok(hit, 'no warning was produced for an event nobody will hear about');
  assert.equal(hit.severity, 'high');
  const still = np.plan(p, 'job.booked', np.channelAvailability({ RESEND_API_KEY: 'k' }));
  assert.deepEqual(still.deliver, [], 'the owner\'s choice must be obeyed, not overridden');
});

t('sms-only is warned about, because sms cannot deliver today', () => {
  const p = np.normalize({ events: { 'job.booked': { email: false, sms: true } } });
  const w = np.warningsFor(p, np.channelAvailability({ RESEND_API_KEY: 'k' }));
  assert.ok(w.find((x) => x.event === 'job.booked'), 'a plan whose only channel is dark must warn');
});

// ── the two signed links ─────────────────────────────────────────────────────────────────────

console.log('\n── the tokens refuse for every reason they can be wrong ───');

const JOB = { job_ref: 'AJ0001', account_id: '11111111-1111-1111-1111-111111111111' };

t('a receipt token round trips and carries the reference, not the job', () => {
  const tok = np.receiptToken(JOB, ENV);
  assert.ok(tok.startsWith('r1.'), 'the prefix the /j/ verifier expects');
  const read = np.readReceiptToken(tok, ENV);
  assert.equal(read.ref, 'AJ0001');
  assert.equal(read.account_id, JOB.account_id);
  assert.ok(!tok.includes('AJ0001'), 'the payload is base64url, so the raw ref is not sitting in the URL');
});

t('a tampered payload, a tampered signature, a truncation and a rotated key are all refused', () => {
  const tok = np.receiptToken(JOB, ENV);
  const [v, payload, sig] = tok.split('.');
  assert.equal(np.readReceiptToken(`${v}.${payload}x.${sig}`, ENV), null, 'tampered payload accepted');
  assert.equal(np.readReceiptToken(`${v}.${payload}.${sig}x`, ENV), null, 'tampered signature accepted');
  assert.equal(np.readReceiptToken(tok.slice(0, tok.length - 6), ENV), null, 'truncated token accepted');
  assert.equal(np.readReceiptToken(tok, { ANSWERED_BOOKING_KEY: 'a-different-key' }), null, 'token from another key accepted');
  assert.equal(np.readReceiptToken(tok, {}), null, 'with no key at all this must fail closed');
  assert.equal(np.readReceiptToken('', ENV), null);
  assert.equal(np.readReceiptToken('v2.abc.def', ENV), null, 'an unknown version accepted');
});

// ── THE CROSS-LANE CONTRACT, WHICH IS THE ONLY THING THAT PROVES THE LINK OPENS ──────────────
//
// This lane MINTS the receipt link that goes in every email. portal.mjs SERVES /j/<token> and
// verifies it with lib/jobs.mjs `readReceipt`. Two modules, two authors, one URL. Nothing else in
// either lane's tests can see the seam between them: this file can mint a perfect token and
// jobs.mjs can verify a perfect token and the product can still be broken, because a lane only
// ever tests its own half.
//
// On 2026-08-14 that is exactly what had happened. This test is the control that would have caught
// it on the first run, so it asserts the property that actually matters to a customer: a token
// minted HERE is readable THERE, and a token minted THERE is readable HERE.
await ta('a receipt token this lane mints is one the live /j/ verifier accepts, and the reverse', async () => {
  let jobs;
  try { jobs = await import('./jobs.mjs'); } catch { throw new Error('SKIP'); }

  const prev = process.env.ANSWERED_BOOKING_KEY;
  process.env.ANSWERED_BOOKING_KEY = ENV.ANSWERED_BOOKING_KEY;
  try {
    // mint HERE, read THERE. This is the direction a customer's emailed link travels.
    const mine = np.receiptToken(JOB, ENV);
    const theirs = jobs.readReceipt(mine);
    assert.ok(theirs, 'lib/jobs.mjs readReceipt REFUSED a token this lane minted, so every emailed /j/ link would 404');
    assert.equal(theirs.r, 'AJ0001');
    assert.equal(theirs.a, JOB.account_id, 'the account binding must survive the crossing');

    // mint THERE, read HERE. Anything jobs.mjs already handed out has to keep working.
    const t2 = jobs.mintReceipt('AJ0002', JOB.account_id);
    const back = np.readReceiptToken(t2, ENV);
    assert.ok(back, 'a token minted by lib/jobs.mjs was refused here');
    assert.equal(back.ref, 'AJ0002');
    assert.equal(back.account_id, JOB.account_id);

    // POSITIVE CONTROL: the verifier is actually checking, not waving things through.
    assert.equal(jobs.readReceipt(`${mine}x`), null, 'jobs.readReceipt accepted a tampered token, so the pass above proves nothing');

    // domain separation survives too: a feed token must not open a job.
    assert.equal(np.readReceiptToken(jobs.mintFeedKey(JOB.account_id), ENV), null, 'a feed key verified as a receipt');
  } finally {
    if (prev === undefined) delete process.env.ANSWERED_BOOKING_KEY;
    else process.env.ANSWERED_BOOKING_KEY = prev;
  }
});

t('with no signing key at all, nothing is minted; an unsigned link is a forgery surface', () => {
  assert.equal(np.receiptToken(JOB, {}), '');
  assert.equal(np.calendarToken('an-id', 0, {}), '');
});

t('a calendar token round trips, and an epoch behind the stored one is detectable', () => {
  const tok = np.calendarToken(JOB.account_id, 0, ENV);
  const read = np.readCalendarToken(tok, ENV);
  assert.equal(read.account_id, JOB.account_id);
  assert.equal(read.epoch, 0);
  const rotated = np.readCalendarToken(np.calendarToken(JOB.account_id, 1, ENV), ENV);
  assert.equal(rotated.epoch, 1, 'the epoch is what makes replace-my-link a real control');
  assert.notEqual(np.calendarToken(JOB.account_id, 0, ENV), np.calendarToken(JOB.account_id, 1, ENV));
});

t('the .ics suffix is stripped before the signature is checked, so the real URL verifies', () => {
  const tok = np.calendarToken(JOB.account_id, 0, ENV);
  assert.ok(np.readCalendarToken(`${tok}.ics`, ENV), 'the address a person actually subscribes to must verify');
  assert.ok(np.readCalendarToken(`${tok}.ICS`, ENV), 'a client that upper-cases the suffix must still verify');
});

t('a receipt token cannot be replayed as a calendar token, or the other way round', () => {
  const r = np.receiptToken(JOB, ENV);
  const c = np.calendarToken(JOB.account_id, 0, ENV);
  assert.equal(np.readCalendarToken(r, ENV), null);
  assert.equal(np.readReceiptToken(c, ENV), null);
});

t('the webcal address is the https one with the scheme swapped, and nothing else', () => {
  const tok = np.calendarToken(JOB.account_id, 0, ENV);
  const https = np.calendarUrl(tok);
  const webcal = np.webcalUrl(tok);
  assert.equal(webcal, https.replace(/^https?:/, 'webcal:'));
  assert.ok(webcal.endsWith('.ics'));
});

// ── money ────────────────────────────────────────────────────────────────────────────────────

console.log('\n── the price comes from the billing engine, not from here ─');

const FULL = {
  job_ref: 'AJ0002', caller_name: 'Sam Okafor', address: '12 Elm St', callback: '+19165550100',
  window_start: new Date(Date.now() + 86400000).toISOString(),
};

t('a complete job in standard hours is the list price', () => {
  const p = np.priceFor({ ...FULL, after_hours: false });
  assert.equal(p.amount, '$19.00');
  assert.equal(p.billable, true);
});

t('a complete job after hours is the higher price', () => {
  const p = np.priceFor({ ...FULL, after_hours: true, created_at: new Date().toISOString() });
  assert.equal(p.amount, '$49.00');
});

t('a job missing a piece is FREE, and the email says which piece, because the statement will', () => {
  const p = np.priceFor({ ...FULL, address: '', after_hours: false });
  assert.equal(p.amount, '$0.00');
  assert.equal(p.billable, false);
  assert.match(p.reason, /missing address/i);
});

t('a rating the caller already computed is printed verbatim, so the email and the bill agree', () => {
  const p = np.priceFor(FULL, { rating: { cents: 0, reason: 'Your bookings reached the $549 cap this cycle, so this booking is free.', billable: false } });
  assert.equal(p.amount, '$0.00');
  assert.equal(p.list_only, false);
  assert.match(p.reason, /cap/);
});

// ── RFC 5545 ─────────────────────────────────────────────────────────────────────────────────

console.log('\n── the calendar file, checked against the specification ──');

const rows = [
  { ...FULL, trade: 'Plumbing', status: 'booked', created_at: new Date().toISOString(), after_hours: false,
    window_end: new Date(Date.now() + 86400000 + 3600000).toISOString(), source: 'the demo line' },
  { job_ref: 'AJ0003', caller_name: 'Ana, Ruiz; Jr', address: '9 Oak Ave, Apt 3; rear', trade: 'HVAC',
    callback: '+19165550101', window_start: new Date(Date.now() + 172800000).toISOString(),
    window_end: null, after_hours: true, created_at: new Date().toISOString(), status: 'booked' },
  { job_ref: 'AJ0004', caller_name: 'Kai Nakamura', address: 'Straße 5, Café München, 100 Läng Avenue Boulevard Extension North', trade: 'Electrical',
    callback: '+19165550102', window_start: new Date(Date.now() + 259200000).toISOString(),
    window_end: new Date(Date.now() + 259200000 + 5400000).toISOString(), created_at: new Date().toISOString(),
    status: 'void', void_reason: 'The customer called back and cancelled', voided_at: new Date().toISOString() },
];

const feed = np.calendarFeed(rows, { name: 'Rivera Plumbing, Air; jobs', description: 'Every job Answered books.' });

t('every line ends CRLF, including the last one', () => {
  assert.ok(feed.endsWith('\r\n'), 'the file must end with CRLF');
  const lf = feed.split('\n').length - 1;
  const crlf = feed.split('\r\n').length - 1;
  assert.equal(lf, crlf, `${lf - crlf} bare LFs found; a bare LF is the commonest reason a feed half parses`);
});

t('no line exceeds 75 OCTETS, and folding happened on a code point boundary', () => {
  for (const line of feed.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `line is ${Buffer.byteLength(line, 'utf8')} octets: ${line.slice(0, 40)}`);
  }
  // Unfolded, the UTF-8 must still be valid: a fold made by character count breaks a multi byte
  // sequence and produces a file Apple Calendar refuses without ever saying why.
  const unfolded = feed.replace(/\r\n[ \t]/g, '');
  assert.ok(unfolded.includes('Straße'), 'a multi byte street name did not survive folding');
  assert.ok(unfolded.includes('München'), 'a multi byte city name did not survive folding');
});

t('commas and semicolons in real text are escaped, and colons are NOT', () => {
  const unfolded = feed.replace(/\r\n[ \t]/g, '');
  assert.ok(unfolded.includes('Ana\\, Ruiz\\; Jr'), 'a comma or a semicolon in a name was not escaped');
  assert.ok(unfolded.includes('X-WR-CALNAME:Rivera Plumbing\\, Air\\; jobs'));
  assert.ok(/DTSTART:\d{8}T\d{6}Z/.test(unfolded), 'a colon inside a property value must not be escaped');
});

t('there is NO METHOD property, because a subscription is not an iTIP message', () => {
  assert.ok(!/^METHOD:/m.test(feed.replace(/\r\n/g, '\n')), 'METHOD on a subscribed feed makes Outlook treat it as a message');
});

t('the calendar carries both the RFC 7986 names and the X- names every client actually reads', () => {
  for (const k of ['NAME:', 'X-WR-CALNAME:', 'DESCRIPTION:', 'X-WR-CALDESC:', 'X-WR-TIMEZONE:',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H', 'CALSCALE:GREGORIAN', 'VERSION:2.0']) {
    assert.ok(feed.includes(k), `missing ${k}`);
  }
});

t('a job with no end time gets NO invented DTEND', () => {
  const one = np.calendarFeed([rows[1]], { name: 'x', description: 'y' });
  assert.ok(one.includes('DTSTART:'), 'a start is required');
  assert.ok(!one.includes('DTEND:'), 'an hour nobody agreed to must not appear in a customer calendar');
  const unfolded = one.replace(/\r\n[ \t]/g, '');
  assert.match(unfolded, /Only a start time was captured/);
});

t('a VOID is CANCELLED and stays in the feed, carrying the reason', () => {
  const unfolded = feed.replace(/\r\n[ \t]/g, '');
  assert.ok(unfolded.includes('STATUS:CANCELLED'), 'a voided job must be served cancelled');
  assert.ok(unfolded.includes('SUMMARY:CANCELLED: '), 'the summary must say it too, for a client that ignores STATUS');
  assert.ok(unfolded.includes('The customer called back and cancelled'));
  assert.ok(unfolded.includes('UID:AJ0004@answered.reddenda.com'), 'a cancelled job must keep its UID or the client cannot match it');
  assert.ok(/SEQUENCE:1/.test(unfolded), 'a cancellation is an update, so the sequence has to move');
});

t('a cancelled job carries no alarm, because nobody should be reminded to drive there', () => {
  const one = np.calendarFeed([rows[2]], { name: 'x', description: 'y' });
  assert.ok(!one.includes('BEGIN:VALARM'), 'a cancelled job must not ring an alarm');
});

t('an account with no jobs produces a VALID EMPTY calendar, not a broken one', () => {
  const empty = np.calendarFeed([], { name: 'Nobody jobs', description: 'No jobs yet.' });
  assert.ok(empty.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(empty.trimEnd().endsWith('END:VCALENDAR'));
  assert.ok(!empty.includes('BEGIN:VEVENT'), 'an empty calendar must not carry an invented placeholder event');
});

t('a job with no usable start time is dropped rather than given a made up one', () => {
  const bad = np.calendarFeed([{ job_ref: 'AJ9', caller_name: 'x', window_start: null }], { name: 'n', description: 'd' });
  assert.ok(!bad.includes('BEGIN:VEVENT'));
  assert.equal(np.jobEvent({ job_ref: 'AJ9', window_start: 'not a date' }), null);
  assert.equal(np.jobEvent({ window_start: new Date().toISOString() }), null, 'no reference means no UID means no event');
});

t('control characters cannot reach the file, because one vertical tab makes it unparseable', () => {
  const nasty = np.calendarFeed([{ ...FULL, job_ref: 'AJ5', caller_name: 'Bad\u000BName\u0000Here', trade: 'X', created_at: new Date().toISOString() }], { name: 'n', description: 'd' });
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(nasty), 'a control character survived into the calendar file');
  assert.ok(nasty.replace(/\r\n[ \t]/g, '').includes('BadNameHere'));
});

// ── two independent parsers, neither of them ours ────────────────────────────────────────────

console.log('\n── parsed by parsers that did not come from this codebase ─');

const PARSER_DIR = process.env.ICAL_PARSER_DIR || '/private/tmp/claude-501/-Users-user/096baddc-185f-4c0b-9cb5-d2f26cdf54b2/scratchpad/node_modules';

await ta('Mozilla ical.js parses the feed and reads back what we put in', async () => {
  let ICAL;
  try { ICAL = (await import(`${PARSER_DIR}/ical.js/dist/ical.js`)).default; }
  catch { try { ICAL = (await import('ical.js')).default; } catch { ICAL = null; } }
  if (!ICAL) throw new Error('SKIP');
  const comp = new ICAL.Component(ICAL.parse(feed));
  assert.equal(comp.name, 'vcalendar');
  assert.equal(comp.getFirstPropertyValue('version'), '2.0');
  assert.equal(comp.getFirstPropertyValue('method'), null, 'a subscription feed must carry no METHOD');
  const events = comp.getAllSubcomponents('vevent');
  assert.equal(events.length, 3, `expected 3 events, ical.js found ${events.length}`);
  const byUid = {};
  for (const e of events) byUid[e.getFirstPropertyValue('uid')] = e;
  const a = byUid['AJ0002@answered.reddenda.com'];
  assert.ok(a, 'the first job did not survive the round trip');
  assert.equal(a.getFirstPropertyValue('location'), '12 Elm St');
  assert.equal(a.getFirstPropertyValue('status'), 'CONFIRMED');
  assert.ok(a.getFirstPropertyValue('dtstart').isDate === false);
  const b = byUid['AJ0003@answered.reddenda.com'];
  assert.equal(b.getFirstPropertyValue('summary').startsWith('After hours: '), true);
  assert.equal(b.getFirstPropertyValue('dtend'), null, 'no end time was recorded, so none may be reported');
  assert.equal(b.getFirstPropertyValue('location'), '9 Oak Ave, Apt 3; rear', 'the parser must UNescape back to the exact original');
  const c = byUid['AJ0004@answered.reddenda.com'];
  assert.equal(c.getFirstPropertyValue('status'), 'CANCELLED');
  assert.ok(String(c.getFirstPropertyValue('description')).includes('The customer called back and cancelled'));
  assert.ok(String(c.getFirstPropertyValue('location')).includes('Straße'), 'the multi byte address did not survive unfolding');
});

await ta('POSITIVE CONTROL: the parser rejects a broken calendar, so a pass above means something', async () => {
  // A parser that accepts anything proves nothing about the file we hand it. This check exists
  // because "a probe that never landed cannot prove a gate works": the three malformed files below
  // are each broken in a way our generator could plausibly produce, and all three must be refused.
  let ICAL;
  try { ICAL = (await import(`${PARSER_DIR}/ical.js/dist/ical.js`)).default; }
  catch { try { ICAL = (await import('ical.js')).default; } catch { ICAL = null; } }
  if (!ICAL) throw new Error('SKIP');
  const mustFail = [
    ['a component that begins and never ends', 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nEND:VCALENDAR\r\n'],
    ['a line with no property name', 'BEGIN:VCALENDAR\r\nthis is not a calendar at all\r\nEND:VCALENDAR\r\n'],
    ['a DTSTART that is not a date', 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//x//EN\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTAMP:20260814T000000Z\r\nDTSTART:NOTADATE\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'],
  ];
  for (const [what, text] of mustFail) {
    let threw = false;
    try { const c = new ICAL.Component(ICAL.parse(text)); c.getAllSubcomponents('vevent').map((e) => e.getFirstPropertyValue('dtstart')); }
    catch { threw = true; }
    assert.ok(threw, `ical.js ACCEPTED ${what}, so it cannot be trusted to have checked ours`);
  }
});

await ta('node-ical, a second independent parser, agrees', async () => {
  let ical;
  try { ical = (await import(`${PARSER_DIR}/node-ical/node-ical.js`)).default; }
  catch { try { ical = (await import('node-ical')).default; } catch { ical = null; } }
  if (!ical) throw new Error('SKIP');
  const data = ical.sync.parseICS(feed);
  const events = Object.values(data).filter((x) => x.type === 'VEVENT');
  assert.equal(events.length, 3, `node-ical found ${events.length} events`);
  const ana = events.find((e) => String(e.uid).startsWith('AJ0003'));
  assert.ok(ana, 'node-ical did not find the job with a semicolon in the name');
  assert.ok(String(ana.summary).includes('Ana, Ruiz; Jr'), `unescaped summary was "${ana.summary}"`);
  const cancelled = events.find((e) => String(e.uid).startsWith('AJ0004'));
  assert.equal(String(cancelled.status), 'CANCELLED');
  const first = events.find((e) => String(e.uid).startsWith('AJ0002'));
  assert.ok(first.start instanceof Date && !Number.isNaN(first.start.getTime()), 'a start time that is not a date is not a start time');
  assert.ok(first.end instanceof Date, 'the job WITH an end time must parse one');
});

// ── the whole feed at scale ──────────────────────────────────────────────────────────────────

t('a thousand jobs still folds inside 75 octets on every line', () => {
  const many = [];
  for (let i = 0; i < 1000; i += 1) {
    many.push({
      job_ref: `AJ${String(i).padStart(6, '0')}`,
      caller_name: `Customer ${i}, of ${i} Ünïcode Street; Apt ${i}`,
      address: `${i} Very Long Street Name That Goes On And On, Suite ${i}, Some City, CA 95814`,
      trade: 'Plumbing', callback: '+19165550100',
      window_start: new Date(Date.now() + i * 3600000).toISOString(),
      window_end: new Date(Date.now() + i * 3600000 + 3600000).toISOString(),
      created_at: new Date().toISOString(), status: 'booked',
    });
  }
  const big = np.calendarFeed(many, { name: 'Many', description: 'Many jobs.' });
  for (const line of big.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `a line at scale is ${Buffer.byteLength(line, 'utf8')} octets`);
  }
  assert.equal((big.match(/BEGIN:VEVENT/g) || []).length, 1000);
});

// ── the send path refuses honestly ───────────────────────────────────────────────────────────

console.log('\n── the send path refuses honestly and never half claims ───');

await ta('an unknown event is refused by name, and nothing is sent', async () => {
  const r = await np.deliver({ event: 'made.up', account: { id: 'a', owner_email: 'x@y.co' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /not one of the four/);
});

await ta('with no account there is nobody to tell, and it says so', async () => {
  const r = await np.deliver({ event: 'job.booked', account: null });
  assert.equal(r.ok, false);
  assert.match(r.error, /no account/i);
});

await ta('every channel appears in the report, whether or not it did anything', async () => {
  const r = await np.deliver({
    event: 'job.booked',
    account: { id: 'a', owner_email: 'nobody@example.invalid', business_name: 'Test' },
    job: FULL,
    probeReceipt: false,
    env: { RESEND_API_KEY: '' },
  });
  for (const ck of np.CHANNEL_KEYS) {
    assert.ok(r.channels[ck], `${ck} is missing from the report entirely`);
    assert.equal(typeof r.channels[ck].reason, 'string');
    assert.ok(r.channels[ck].reason.length > 0, `${ck} reported nothing and gave no reason`);
  }
  assert.equal(r.ok, false, 'nothing delivered, so the envelope must not say ok');
});

await ta('a digest with nothing in it sends nothing, and says that is why', async () => {
  const r = await np.deliver({ event: 'daily.digest', account: { id: 'a', owner_email: 'x@y.co' }, jobs: [] });
  assert.equal(r.ok, false);
  assert.equal(r.skipped_all, true);
  assert.match(r.reason, /nothing to summarise/i);
});

await ta('a link that does not answer is left out, and the report says which status it got', async () => {
  const r = await np.deliver({
    event: 'job.booked',
    account: { id: 'a', owner_email: 'nobody@example.invalid', business_name: 'Test' },
    job: FULL,
    probeReceipt: true,
    env: { RESEND_API_KEY: '' },
  });
  assert.ok(r.receipt, 'no receipt report at all');
  assert.equal(r.receipt.included, false, 'a link nobody proved must not be included');
  assert.ok(String(r.receipt.reason).length > 10);
});

// ── the words themselves ─────────────────────────────────────────────────────────────────────

console.log('\n── the copy obeys the house rules ────────────────────────');

t('no em dash appears in anything a customer reads', () => {
  const strings = [
    ...np.EVENTS.flatMap((e) => [e.label, e.what, e.why]),
    ...np.CHANNELS.flatMap((c) => [c.label, c.what]),
    np.SMS_TRUTH, np.capSentence(), np.CALL_OFF_REASON, np.VOICEMAIL_OFF_REASON,
    ...Object.values(np.channelAvailability({ RESEND_API_KEY: '' })).map((a) => a.reason),
    ...np.warningsFor(np.normalize({ events: { 'job.booked': { email: false, sms: false } } })).map((w) => w.text),
  ];
  for (const s of strings) {
    assert.ok(!String(s).includes('—'), `em dash in customer copy: ${String(s).slice(0, 70)}`);
  }
});

t('nothing anywhere claims a text was delivered', () => {
  const m = np.renderJobBooked({
    job: FULL, account: { business_name: 'Rivera' },
    price: np.priceFor(FULL), receipt: '', when: np.whenOf(FULL), afterHours: false,
  });
  assert.match(m.text, /did not text you/i);
  assert.ok(!/we texted|text sent|sent you a text/i.test(m.html));
});

t('an email with no working link is still complete on its own', () => {
  const m = np.renderJobBooked({
    job: FULL, account: { business_name: 'Rivera' },
    price: np.priceFor(FULL), receipt: '', when: np.whenOf(FULL), afterHours: false,
  });
  for (const needle of ['Sam Okafor', '12 Elm St', '(916) 555-0100', 'AJ0002']) {
    assert.ok(m.text.includes(needle), `the email is not complete without a link: missing ${needle}`);
  }
  assert.ok(m.html.includes('There is nothing you have to click'));
});

t('a job missing a piece says so in the email, in the same words the bill uses', () => {
  const job = { ...FULL, address: '' };
  const m = np.renderJobBooked({
    job, account: { business_name: 'Rivera' },
    price: np.priceFor(job), receipt: '', when: np.whenOf(job), afterHours: false,
  });
  assert.match(m.text, /missing an address/i);
  assert.match(m.text, /free until/i);
});

console.log(`\n${'─'.repeat(58)}`);
console.log(`${pass} passed, ${fail} failed, ${skip} skipped`);
if (failures.length) {
  console.log('\nFAILED:');
  for (const [n, d] of failures) console.log(`  ${n}\n    ${d}`);
}
process.exit(fail ? 1 : 0);
