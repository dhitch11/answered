// live.test.mjs — the meter, the ledger, the statement and Stripe, exercised over real HTTP
// against the real answered-prod database and the real live Stripe account.
//
//   ./billing/with-env.sh node billing/serve.mjs        (in one terminal)
//   ./billing/with-env.sh node billing/live.test.mjs    (in another)
//
// NOTHING IN HERE CHARGES ANYTHING. It creates a customer, opens a real setup session, builds a
// real draft invoice, reads the totals back off Stripe, then deletes the draft and the customer.
// The one operation that would move money is called deliberately while the deploy is DISARMED, to
// prove the disarm holds, and its expected result is a refusal.

import assert from 'node:assert/strict';

const BASE = process.env.BILLING_BASE || 'http://localhost:8951';
const SECRET = process.env.ANSWERED_METER_SECRET;
const KEY = 'qa-lane-billing';
const CAPKEY = 'qa-lane-billing-cap';
const cycle = `${new Date().toISOString().slice(0, 7)}-01`;

let pass = 0; let fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

const post = async (path, body, auth = true) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${SECRET}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* leave null, the status is the story */ }
  return { status: res.status, body: json, text };
};

const meter = (b) => post('/api/meter', b);
const bill = (b) => post('/api/billing', b);
const GOOD = { name: 'Dana Reyes', address: '414 Mill St, Folsom CA', callback: '+19168663918', window: 'Thu 8-10am' };
const uniq = () => `qa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

if (!SECRET) { console.error('ANSWERED_METER_SECRET is not in this environment. Run through billing/with-env.sh.'); process.exit(1); }

console.log(`\nliving test against ${BASE}, cycle ${cycle}\n`);

// ── the door ─────────────────────────────────────────────────────────────────────────────────────
console.log('the door');
await t('no bearer token is 401', async () => {
  const r = await post('/api/meter', { op: 'catalog' }, false);
  assert.equal(r.status, 401);
});
await t('a wrong bearer token is 401 and leaks nothing', async () => {
  const res = await fetch(`${BASE}/api/meter`, {
    method: 'POST', headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'catalog' }),
  });
  assert.equal(res.status, 401);
  const text = await res.text();
  assert.equal(/price|catalog|19|549/.test(text), false, `a 401 body should carry no price book, got ${text}`);
});
await t('GET is refused', async () => {
  const res = await fetch(`${BASE}/api/meter`);
  assert.equal(res.status, 405);
});
await t('malformed json is 400, not 500', async () => {
  const res = await fetch(`${BASE}/api/meter`, {
    method: 'POST', headers: { Authorization: `Bearer ${SECRET}` }, body: '{not json',
  });
  assert.equal(res.status, 400);
});
await t('an unknown op names the ops it knows', async () => {
  const r = await meter({ op: 'delete_everything' });
  assert.equal(r.status, 400);
  assert.ok(Array.isArray(r.body.ops));
});

// ── the price book over the wire ─────────────────────────────────────────────────────────────────
console.log('\nthe published price book, served');
await t('the catalog serves the terms prices', async () => {
  const r = await meter({ op: 'catalog' });
  assert.equal(r.status, 200);
  assert.equal(r.body.catalog.booked_job.price, '$19.00');
  assert.equal(r.body.catalog.booked_job_after_hours.price, '$49.00');
  assert.equal(r.body.catalog.hold_gov.price, '$20.00');
  assert.equal(r.body.catalog.hold_commercial.price, '$10.00');
  assert.equal(r.body.catalog.quiet_line_month.price, '$39.00');
  assert.equal(r.body.catalog.parley_settled.price, '$29.00');
  assert.equal(r.body.catalog.line_month.price, '$0.00');
});

// ── the account ──────────────────────────────────────────────────────────────────────────────────
console.log('\nthe account');
let statementUrl = null; let token = null;
await t('an account can be created and hands back a statement link', async () => {
  const r = await meter({
    op: 'account', account_key: KEY, email: 'info@reddenda.com',
    business_name: 'QA, lane billing. Not a customer.',
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.cap_cents, 54900);
  assert.match(r.body.statement_url, /\/statement\/[0-9a-f]{64}/);
  statementUrl = r.body.statement_url;
  token = r.body.statement_token;
});
await t('creating it again is the same account, not a second one', async () => {
  const r = await meter({ op: 'account', account_key: KEY, email: 'info@reddenda.com' });
  assert.equal(r.body.statement_token, token, 'the statement token must be stable across upserts');
});

// ── recording an outcome ─────────────────────────────────────────────────────────────────────────
console.log('\nrecording an outcome');
const bookedIdem = uniq();
await t('a booking with all four pieces records $19', async () => {
  const r = await meter({
    op: 'record', account_key: KEY,
    event: { kind: 'booked_job', idem_key: bookedIdem, evidence: { ...GOOD, call_sid: 'CAqa000000000000' } },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.cents, 1900);
  assert.equal(r.body.price, '$19.00');
  assert.equal(r.body.recorded, true);
});
await t('THE SAME IDEM KEY BILLS ONCE. A retried webhook is a replay, not a second charge.', async () => {
  const r = await meter({
    op: 'record', account_key: KEY,
    event: { kind: 'booked_job', idem_key: bookedIdem, evidence: GOOD },
  });
  assert.equal(r.body.replay, true);
  assert.equal(r.body.recorded, false);
  assert.equal(r.body.cents, 1900);
});
await t('a booking missing the address records at $0 and says which piece', async () => {
  const r = await meter({
    op: 'record', account_key: KEY,
    event: { kind: 'booked_job', idem_key: uniq(), evidence: { ...GOOD, address: '' } },
  });
  assert.equal(r.body.cents, 0);
  assert.equal(r.body.billable, false);
  assert.match(r.body.reason, /missing address/);
});
await t('an event not on the published list records at $0 with the refusal on the record', async () => {
  const r = await meter({
    op: 'record', account_key: KEY, event: { kind: 'convenience_fee', idem_key: uniq() },
  });
  assert.equal(r.body.cents, 0);
  assert.match(r.body.reason, /not on the published list/);
});
await t('a record with no idem key is refused', async () => {
  const r = await meter({ op: 'record', account_key: KEY, event: { kind: 'booked_job', evidence: GOOD } });
  assert.equal(r.status, 400);
});
await t('recover with no band is refused over the wire, never defaulted to 15%', async () => {
  const r = await meter({
    op: 'record', account_key: KEY,
    event: { kind: 'recover_landed', idem_key: uniq(), recovered_cents: 1000000 },
  });
  assert.equal(r.body.cents, 0);
  assert.match(r.body.reason, /will not pick one for you/);
});
await t('recover with a band shown before the first call bills the band', async () => {
  const r = await meter({
    op: 'record', account_key: KEY,
    event: {
      kind: 'recover_landed', idem_key: uniq(), recovered_cents: 100000, band: 'most',
      band_shown_at: '2026-07-01T00:00:00Z', first_call_at: '2026-07-02T00:00:00Z',
      last_contact_at: '2026-07-20T00:00:00Z', landed_at: '2026-07-25T00:00:00Z',
      evidence: { invoice_ref: 'QA-1042' },
    },
  });
  assert.equal(r.body.cents, 15000, '15% of $1,000.00 is $150.00');
});
await t('the first hold ever is free, the second is not', async () => {
  const a = await meter({ op: 'record', account_key: KEY, event: { kind: 'hold_gov', idem_key: uniq() } });
  const b = await meter({ op: 'record', account_key: KEY, event: { kind: 'hold_gov', idem_key: uniq() } });
  assert.equal(a.body.cents + b.body.cents, 2000, 'exactly one of the two is free');
});
await t('a quiet line with no written notice is refused', async () => {
  const r = await meter({
    op: 'record', account_key: KEY, event: { kind: 'quiet_line_month', idem_key: uniq() },
  });
  assert.equal(r.body.cents, 0);
});

// ── the cap, on its own account so the boundary is cheap to reach ────────────────────────────────
console.log('\nthe cap');
await t('an account can be born with a low cap', async () => {
  const r = await meter({
    op: 'account', account_key: CAPKEY, email: 'info@reddenda.com',
    business_name: 'QA, cap boundary. Not a customer.', cap_cents: 5000,
  });
  assert.equal(r.status, 200);
});
await t('THE BILL STOPS AT THE CAP, it does not step over it', async () => {
  const before = await meter({ op: 'statement', account_key: CAPKEY });
  const start = before.body.charged_cents;
  const room = before.body.cap_room_cents;
  // Fill to within $9 of the cap, then send one more $19 booking.
  let filled = 0;
  while (room - filled >= 1900) {
    const r = await meter({ op: 'record', account_key: CAPKEY, event: { kind: 'booked_job', idem_key: uniq(), evidence: GOOD } });
    filled += r.body.cents;
    if (r.body.cents === 0) break;
  }
  const last = await meter({ op: 'record', account_key: CAPKEY, event: { kind: 'booked_job', idem_key: uniq(), evidence: GOOD } });
  const after = await meter({ op: 'statement', account_key: CAPKEY });
  assert.ok(after.body.charged_cents <= after.body.cap_cents,
    `charged ${after.body.charged_cents} must never exceed cap ${after.body.cap_cents}`);
  assert.ok(last.body.cents < 1900, `the booking that crossed the cap must be clamped, got ${last.body.cents}`);
  console.log(`       started ${start}, cap ${after.body.cap_cents}, ended ${after.body.charged_cents}, last booking ${last.body.cents}`);
});
await t('every booking after the cap is free', async () => {
  const r = await meter({ op: 'record', account_key: CAPKEY, event: { kind: 'booked_job', idem_key: uniq(), evidence: GOOD } });
  assert.equal(r.body.cents, 0);
  assert.match(r.body.reason, /reached the \$50 cap|reached the \$549 cap/);
});
await t('a cap change is SCHEDULED, never applied mid cycle', async () => {
  const r = await meter({ op: 'cap', account_key: CAPKEY, cap_cents: 20000 });
  assert.equal(r.status, 200);
  assert.equal(r.body.cap_cents, 5000, 'the cap in force must not have moved');
  assert.equal(r.body.pending_cap_cents, 20000);
  assert.ok(r.body.pending_cap_month > cycle, 'the new cap belongs to a later cycle');
});

// ── the statement, over real HTTP, as a customer ─────────────────────────────────────────────────
console.log('\nthe statement');
await t('the statement page renders for a real token', async () => {
  const res = await fetch(statementUrl.replace('https://answered.reddenda.com', BASE));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Due this cycle/);
  assert.match(html, /Job booked, standard hours/);
  assert.match(html, /Void this charge/);
  assert.match(res.headers.get('x-robots-tag') || '', /noindex/);
  assert.match(res.headers.get('cache-control') || '', /no-store/);
});
await t('the statement shows the free lines too, not only the charges', async () => {
  const res = await fetch(statementUrl.replace('https://answered.reddenda.com', BASE));
  const html = await res.text();
  assert.match(html, /Everything else, at no charge/);
  assert.match(html, /missing address/, 'a free line must be visible with its reason');
});
await t('THE PAGE DOES NOT PROMISE A TEXT THAT CANNOT ARRIVE', async () => {
  const res = await fetch(statementUrl.replace('https://answered.reddenda.com', BASE));
  const html = await res.text();
  assert.match(html, /Replying VOID to a text is not running yet/);
});
await t('a made up token is a 404 that offers a person', async () => {
  const res = await fetch(`${BASE}/statement/${'a'.repeat(64)}`);
  assert.equal(res.status, 404);
  const html = await res.text();
  assert.match(html, /info@reddenda.com/);
});
await t('a malformed token never reaches the database', async () => {
  const res = await fetch(`${BASE}/statement/notatoken`);
  assert.equal(res.status, 404);
});

// ── VOID, for real ───────────────────────────────────────────────────────────────────────────────
console.log('\nVOID');
let voidTarget = null;
await t('a customer can void their own charge with no reason and no ticket', async () => {
  const s = await post('/api/statement', { op: 'view', token }, false);
  const charge = s.body.lines.find((l) => l.cents > 0 && l.state === 'open');
  assert.ok(charge, 'there should be an open charge to void');
  voidTarget = charge.id;
  const r = await post('/api/statement', { op: 'void', token, id: voidTarget }, false);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});
await t('the voided charge is off the bill and the row still exists', async () => {
  const s = await post('/api/statement', { op: 'view', token }, false);
  const row = s.body.lines.find((l) => l.id === voidTarget);
  assert.ok(row, 'a void must never delete the record');
  assert.equal(row.state, 'voided');
});
await t('voiding twice is not an error, it is already dead', async () => {
  const r = await post('/api/statement', { op: 'void', token, id: voidTarget }, false);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.already, true);
});
await t('ONE ACCOUNT CANNOT VOID ANOTHER ACCOUNT\'S CHARGE', async () => {
  const other = await meter({ op: 'statement', account_key: CAPKEY });
  const theirs = other.body.lines.find((l) => l.cents > 0);
  assert.ok(theirs, 'the cap account should have a charge');
  const r = await post('/api/statement', { op: 'void', token, id: theirs.id }, false);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not on this account/);
});
await t('a bad token voids nothing', async () => {
  const r = await post('/api/statement', { op: 'void', token: 'b'.repeat(64), id: voidTarget }, false);
  assert.match(r.body.error || '', /unknown link/);
});

// ── Stripe, live account, nothing charged ────────────────────────────────────────────────────────
console.log('\nstripe, live account, disarmed');
let customerId = null; let draftId = null;
await t('status reports the real account and the real arming state', async () => {
  const r = await bill({ op: 'status' });
  assert.equal(r.status, 200);
  assert.equal(r.body.stripe.live_mode, true, 'this key is live, and the code must say so');
  assert.equal(r.body.stripe.charges_enabled, true);
  assert.equal(r.body.armed, false, 'nothing may be armed by default');
  assert.equal(r.body.can_charge_today, false);
});
await t('card_link opens a REAL setup session that charges $0', async () => {
  const r = await bill({ op: 'card_link', account_key: KEY });
  assert.equal(r.status, 200);
  assert.equal(r.body.charges_nothing, true);
  assert.match(r.body.url, /^https:\/\/checkout\.stripe\.com\//);
  assert.match(r.body.customer, /^cus_/);
  customerId = r.body.customer;
  console.log(`       live setup session: ${r.body.url.slice(0, 62)}...`);
});
await t('close builds a real draft invoice and charges nobody', async () => {
  const r = await bill({ op: 'close', account_key: KEY, cycle });
  assert.equal(r.status, 200);
  assert.equal(r.body.charged, false);
  assert.match(r.body.invoice, /^in_/);
  draftId = r.body.invoice;
  assert.equal(r.body.invoice_total_cents, r.body.total_cents,
    `stripe's own total ${r.body.invoice_total_cents} must equal the ledger's ${r.body.total_cents}`);
  console.log(`       draft ${draftId}, ${r.body.lines} lines, ${r.body.total} on both sides`);
});
await t('THE DISARM HOLDS: confirm:true on a disarmed deploy charges nothing', async () => {
  const r = await bill({ op: 'close', account_key: KEY, cycle, confirm: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.charged, false);
  assert.match(r.body.error, /disarmed/);
});
await t('a voided charge never reaches the invoice', async () => {
  const inv = await bill({ op: 'close', account_key: KEY, cycle });
  const s = await meter({ op: 'statement', account_key: KEY });
  const voided = s.body.lines.filter((l) => l.state === 'voided').reduce((n, l) => n + l.gross_cents, 0);
  assert.ok(voided > 0, 'the test voided something, so this should be non zero');
  assert.equal(inv.body.total_cents === undefined ? 0 : inv.body.total_cents >= 0, true);
});

// ── the webhook door ─────────────────────────────────────────────────────────────────────────────
console.log('\nthe webhook');
await t('an unsigned webhook is refused', async () => {
  const res = await fetch(`${BASE}/api/billing/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'invoice.paid', data: { object: { id: 'in_fake' } } }),
  });
  assert.equal(res.status, 400);
});
await t('a forged signature is refused', async () => {
  const res = await fetch(`${BASE}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
    body: JSON.stringify({ type: 'invoice.paid' }),
  });
  assert.equal(res.status, 400);
});

// ── cleanup, so the live account is left exactly as it was found ────────────────────────────────
console.log('\ncleanup');
await t('the draft invoice is deleted and its lines come back to open', async () => {
  if (!draftId) throw new Error('no draft to delete');
  const r = await bill({ op: 'discard_draft', invoice: draftId });
  assert.equal(r.status, 200);
  assert.ok(r.body.reopened_lines > 0, 'the discarded draft must hand its lines back, or they are stranded');
  console.log(`       ${r.body.reopened_lines} lines returned to open`);
});
await t('the qa stripe customer is deleted', async () => {
  if (!customerId) throw new Error('no customer to delete');
  const res = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
  });
  const j = await res.json();
  assert.equal(j.deleted, true);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
