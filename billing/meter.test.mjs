// meter.test.mjs — the rating engine against the published terms, including every path that must
// produce a zero or a refusal. Run: node billing/meter.test.mjs
//
// The tests that matter here are the negative ones. A pricing engine that gets $19 right and
// silently bills a booking with no address is not a pricing engine, it is a leak.

import assert from 'node:assert/strict';
import { rate, CATALOG, DEFAULT_CAP_CENTS, RECOVER_BANDS, usd } from '../netlify/functions/lib/meter.mjs';

let pass = 0; let fail = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

const GOOD = { name: 'Dana Reyes', address: '414 Mill St', callback: '+19165550183', window: 'Thu 8-10am' };
const STD = { plan: 'standard', cap_cents: DEFAULT_CAP_CENTS, month_charged_cents: 0, first_hold_used: true };

console.log('\nthe published price book');
t('every price matches the terms table', () => {
  assert.equal(CATALOG.line_month.cents, 0);
  assert.equal(CATALOG.booked_job.cents, 1900);
  assert.equal(CATALOG.booked_job_after_hours.cents, 4900);
  assert.equal(CATALOG.hold_gov.cents, 2000);
  assert.equal(CATALOG.hold_commercial.cents, 1000);
  assert.equal(CATALOG.hold_no_human.cents, 0);
  assert.equal(CATALOG.autopilot_invoice_paid.cents, 1900);
  assert.equal(CATALOG.quiet_line_month.cents, 3900);
  assert.equal(CATALOG.parley_settled.cents, 2900);
  assert.equal(DEFAULT_CAP_CENTS, 54900);
});
t('the recover bands are 10/15/20 standard and 8/13/18 subscriber', () => {
  assert.deepEqual(RECOVER_BANDS.newer, { standard: 0.10, subscriber: 0.08 });
  assert.deepEqual(RECOVER_BANDS.most, { standard: 0.15, subscriber: 0.13 });
  assert.deepEqual(RECOVER_BANDS.oldest, { standard: 0.20, subscriber: 0.18 });
});

console.log('\nthe list is closed');
t('an event that is not on the published list is refused, not zero-rated', () => {
  const r = rate({ kind: 'voicemail_taken' }, STD);
  assert.equal(r.ok, false);
  assert.equal(r.cents, 0);
  assert.match(r.reason, /not on the published list/);
});
t('an empty kind is refused', () => {
  assert.equal(rate({}, STD).ok, false);
});
t('per minute is refused by name, with the promise quoted back', () => {
  const r = rate({ kind: 'per_minute' }, STD);
  assert.equal(r.ok, false);
  assert.equal(r.refused_shape, true);
  assert.match(r.reason, /no per minute price/);
});
t('per call and subscription are refused too', () => {
  assert.equal(rate({ kind: 'per_call' }, STD).ok, false);
  assert.equal(rate({ kind: 'subscription' }, STD).ok, false);
  assert.equal(rate({ kind: 'setup_fee' }, STD).ok, false);
});

console.log('\nthe definition everything hangs on');
t('all four pieces bills $19', () => {
  const r = rate({ kind: 'booked_job', evidence: GOOD }, STD);
  assert.equal(r.cents, 1900);
  assert.equal(r.billable, true);
});
for (const piece of ['name', 'address', 'callback', 'window']) {
  t(`missing ${piece} is free, and says which piece`, () => {
    const ev = { ...GOOD, [piece]: '' };
    const r = rate({ kind: 'booked_job', evidence: ev }, STD);
    assert.equal(r.cents, 0);
    assert.equal(r.billable, false);
    assert.deepEqual(r.missing_pieces, [piece]);
  });
}
t('whitespace is not a value', () => {
  const r = rate({ kind: 'booked_job', evidence: { ...GOOD, address: '   ' } }, STD);
  assert.equal(r.cents, 0);
});
t('no evidence at all is free, never billed', () => {
  const r = rate({ kind: 'booked_job' }, STD);
  assert.equal(r.cents, 0);
  assert.equal(r.missing_pieces.length, 4);
});
t('a caller who hangs up costs nothing however long it ran', () => {
  const r = rate({ kind: 'booked_job', evidence: { name: 'unknown caller' }, duration_seconds: 900 }, STD);
  assert.equal(r.cents, 0);
});

console.log('\nafter hours');
t('after hours with a recorded time bills $49', () => {
  const r = rate({ kind: 'booked_job_after_hours', evidence: GOOD, booked_at: '2026-08-14T04:10:00Z' }, STD);
  assert.equal(r.cents, 4900);
});
t('after hours with no recorded time falls back to $19, never up', () => {
  const r = rate({ kind: 'booked_job_after_hours', evidence: GOOD }, STD);
  assert.equal(r.cents, 1900);
  assert.equal(r.kind, 'booked_job');
  assert.match(r.reason, /billed at the standard price/);
});

console.log('\nthe cap');
t('a booking under the cap bills in full', () => {
  const r = rate({ kind: 'booked_job', evidence: GOOD }, { ...STD, month_charged_cents: 10000 });
  assert.equal(r.cents, 1900);
  assert.equal(r.cap_applied_cents, 0);
});
t('a booking at the cap is free', () => {
  const r = rate({ kind: 'booked_job', evidence: GOOD }, { ...STD, month_charged_cents: 54900 });
  assert.equal(r.cents, 0);
  assert.equal(r.billable, false);
  assert.match(r.reason, /reached the \$549 cap/);
});
t('THE BOUNDARY: the bill stops AT $549, it does not step over it', () => {
  // $540.00 already charged, a $19 booking arrives. The naive reading bills $19 and lands the
  // month at $559, which makes the headline "Your bill stops at $549" false.
  const r = rate({ kind: 'booked_job', evidence: GOOD }, { ...STD, month_charged_cents: 54000 });
  assert.equal(r.cents, 900, 'the charge is clamped to the room left under the cap');
  assert.equal(r.cap_applied_cents, 1000);
  assert.equal(54000 + r.cents, 54900);
});
t('an after hours booking is clamped by the same cap', () => {
  const r = rate({ kind: 'booked_job_after_hours', evidence: GOOD, booked_at: '2026-08-14T04:10:00Z' },
    { ...STD, month_charged_cents: 53000 });
  assert.equal(r.cents, 1900);
  assert.equal(r.cap_applied_cents, 3000);
});
t('a lowered cap is honoured', () => {
  const r = rate({ kind: 'booked_job', evidence: GOOD }, { ...STD, cap_cents: 10000, month_charged_cents: 10000 });
  assert.equal(r.cents, 0);
});
t('hold, recover and autopilot are outside the cap, as the terms scope it to bookings', () => {
  const at = { ...STD, month_charged_cents: 54900 };
  assert.equal(rate({ kind: 'hold_gov' }, at).cents, 2000);
  assert.equal(rate({ kind: 'autopilot_invoice_paid', paid_at: '2026-08-14' }, at).cents, 1900);
});

console.log('\nhold');
t('the first hold ever is free', () => {
  const r = rate({ kind: 'hold_gov' }, { ...STD, first_hold_used: false });
  assert.equal(r.cents, 0);
  assert.equal(r.first_hold, true);
});
t('a government line is $20 and a commercial line is $10', () => {
  assert.equal(rate({ kind: 'hold_gov' }, STD).cents, 2000);
  assert.equal(rate({ kind: 'hold_commercial' }, STD).cents, 1000);
});
t('reaching nobody is $0 however long it waited', () => {
  const r = rate({ kind: 'hold_no_human', held_seconds: 14400 }, STD);
  assert.equal(r.cents, 0);
  assert.equal(r.billable, false);
});

console.log('\nrecover');
const REC = {
  kind: 'recover_landed', recovered_cents: 1000000, band: 'most',
  band_shown_at: '2026-07-01T00:00:00Z', first_call_at: '2026-07-02T00:00:00Z',
  last_contact_at: '2026-07-20T00:00:00Z', landed_at: '2026-07-30T00:00:00Z',
};
t('15% of $10,000 recovered is $1,500', () => {
  const r = rate(REC, STD);
  assert.equal(r.cents, 150000);
  assert.equal(usd(r.cents), '$1500.00');
});
t('a subscriber pays 13% on the same band', () => {
  const r = rate(REC, { ...STD, plan: 'subscriber' });
  assert.equal(r.cents, 130000);
});
t('newer is 10 and 8, oldest is 20 and 18', () => {
  assert.equal(rate({ ...REC, band: 'newer' }, STD).cents, 100000);
  assert.equal(rate({ ...REC, band: 'newer' }, { ...STD, plan: 'subscriber' }).cents, 80000);
  assert.equal(rate({ ...REC, band: 'oldest' }, STD).cents, 200000);
  assert.equal(rate({ ...REC, band: 'oldest' }, { ...STD, plan: 'subscriber' }).cents, 180000);
});
t('nothing landed means nothing owed', () => {
  assert.equal(rate({ ...REC, recovered_cents: 0 }, STD).ok, false);
  assert.equal(rate({ ...REC, recovered_cents: 0 }, STD).cents, 0);
});
t('NO INVENTED BAND: an event with no band is refused, not defaulted to 15%', () => {
  const r = rate({ ...REC, band: undefined }, STD);
  assert.equal(r.ok, false);
  assert.equal(r.cents, 0);
  assert.match(r.reason, /will not pick one for you/);
});
t('a band shown AFTER the first call is refused', () => {
  const r = rate({ ...REC, band_shown_at: '2026-07-05T00:00:00Z' }, STD);
  assert.equal(r.ok, false);
  assert.match(r.reason, /after the first call/);
});
t('a band never shown at all is refused', () => {
  assert.equal(rate({ ...REC, band_shown_at: null }, STD).ok, false);
});
t('money that lands outside the 30 day window is the customer\'s alone', () => {
  const r = rate({ ...REC, landed_at: '2026-09-01T00:00:00Z' }, STD);
  assert.equal(r.cents, 0);
  assert.equal(r.billable, false);
  assert.match(r.reason, /yours alone/);
});
t('a written promise covers a late landing', () => {
  const r = rate({ ...REC, landed_at: '2026-09-01T00:00:00Z', promised_by: '2026-09-05T00:00:00Z' }, STD);
  assert.equal(r.cents, 150000);
});
t('a promise that the payment also missed does not rescue the fee', () => {
  const r = rate({ ...REC, landed_at: '2026-09-10T00:00:00Z', promised_by: '2026-09-05T00:00:00Z' }, STD);
  assert.equal(r.cents, 0);
});
t('rounding is to the cent, on the recovered amount', () => {
  const r = rate({ ...REC, recovered_cents: 33333 }, STD); // $333.33 at 15% = $50.00 (49.9995)
  assert.equal(r.cents, 5000);
});

console.log('\nautopilot');
t('autopilot bills $19 only when the invoice was paid', () => {
  assert.equal(rate({ kind: 'autopilot_invoice_paid', paid_at: '2026-08-14' }, STD).cents, 1900);
  assert.equal(rate({ kind: 'autopilot_invoice_paid' }, STD).ok, false);
});

console.log('\nthe quiet line');
const QUIET = { kind: 'quiet_line_month', occurred_at: '2026-08-14T00:00:00Z' };
const QACC = { ...STD, bookings_last_90d: [1, 0, 2], quiet_notice_at: '2026-08-01T00:00:00Z' };
t('a quiet line bills $39 and creates the same credit', () => {
  const r = rate(QUIET, QACC);
  assert.equal(r.cents, 3900);
  assert.equal(r.creates_credit_cents, 3900);
});
t('a line that booked three in any month inside 90 days is not quiet', () => {
  const r = rate(QUIET, { ...QACC, bookings_last_90d: [1, 3, 0] });
  assert.equal(r.cents, 0);
  assert.match(r.reason, /not a quiet line/);
});
t('no 90 day record means the rate does not exist', () => {
  assert.equal(rate(QUIET, { ...QACC, bookings_last_90d: [1, 0] }).ok, false);
});
t('NO NOTICE, NO CHARGE: the terms promise writing before the first $39', () => {
  const r = rate(QUIET, { ...QACC, quiet_notice_at: null });
  assert.equal(r.ok, false);
  assert.equal(r.cents, 0);
  assert.match(r.reason, /told in writing/);
});
t('a notice dated after the charge does not count', () => {
  const r = rate(QUIET, { ...QACC, quiet_notice_at: '2026-08-20T00:00:00Z' });
  assert.equal(r.ok, false);
});
t('quiet credit comes back against a booking, to the cent', () => {
  const r = rate({ kind: 'booked_job', evidence: GOOD }, { ...STD, quiet_credit_cents: 3900 });
  assert.equal(r.cents, 0);
  assert.equal(r.credit_applied_cents, 1900);
});
t('partial credit is spent, not wasted', () => {
  const r = rate({ kind: 'booked_job', evidence: GOOD }, { ...STD, quiet_credit_cents: 500 });
  assert.equal(r.cents, 1400);
  assert.equal(r.credit_applied_cents, 500);
});

console.log('\nparley');
t('a settled parley is $29', () => {
  assert.equal(rate({ kind: 'parley_settled', settled_at: '2026-08-14' }, STD).cents, 2900);
});
t('a parley that did not settle is refused', () => {
  assert.equal(rate({ kind: 'parley_settled' }, STD).ok, false);
});

console.log('\nthe line itself');
t('having Answered on the line is $0 in any month at any volume', () => {
  const r = rate({ kind: 'line_month', calls: 4000 }, STD);
  assert.equal(r.cents, 0);
  assert.equal(r.billable, false);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
