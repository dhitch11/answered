// tools.test.mjs — the floors under the ACTION, asserted. Run it with:
//
//   node netlify/functions/lib/tools.test.mjs
//
// No network, no keys, no phone. The clock is injected, /api/booking is stubbed, and the handler
// is driven through its real default export.
//
// ★ EVERY FLOOR IS TESTED TWICE, ONCE TO FIRE AND ONCE TO STAY QUIET, for the same reason
// personas.test.mjs says so: a validator that rejects everything passes a fire-only suite and
// makes the product unable to book. Half the assertions below are REAL bookings that must sail
// straight through, including the awkward ones: an apostrophe in a name, a rural route with no
// street number, a two word service.

import assert from 'node:assert/strict';
import * as T from './tools.mjs';

let pass = 0;
let fail = 0;
const failures = [];
const t = (name, fn) => { try { fn(); pass += 1; } catch (e) { fail += 1; failures.push(name + '\n    ' + String(e.message).split('\n')[0]); } };
const at = async (name, fn) => { try { await fn(); pass += 1; } catch (e) { fail += 1; failures.push(name + '\n    ' + String(e.message).split('\n')[0]); } };

// Composed from parts rather than from a formatted string, because the separator between the
// weekday and the time is a locale detail that changed under us once already and is not the fact
// under test. This asserts the FACT: which day, which hour, which minute, in the shop's own zone.
const wall = (iso, tz = T.SHOP_TZ) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.hour}:${p.minute} ${p.dayPeriod}`;
};

const GOOD = {
  customer_name: "Dana O'Whitfield",
  address: '4412 Fair Oaks Boulevard, Sacramento',
  callback_number: '(916) 866-3918',
  service: 'water heater is leaking',
  window: 'tuesday_8am',
};

// ── 1. THE CLOCK ────────────────────────────────────────────────────────────
// A hallucinated date is not a typo. It is a van at the wrong house.

t('each window lands on the weekday and wall clock riley says out loud', () => {
  const now = new Date('2026-08-14T19:00:00Z'); // a Friday
  assert.equal(wall(T.nextWindow('tuesday_8am', now).startsAt), 'Tue 8:00 AM');
  assert.equal(wall(T.nextWindow('tuesday_130pm', now).startsAt), 'Tue 1:30 PM');
  assert.equal(wall(T.nextWindow('wednesday_9am', now).startsAt), 'Wed 9:00 AM');
});

t('the spoken phrase and the instant are the same fact', () => {
  const now = new Date('2026-08-14T19:00:00Z');
  assert.equal(T.nextWindow('tuesday_130pm', now).spoken, 'Tuesday at one thirty in the afternoon');
  assert.equal(T.nextWindow('wednesday_9am', now).spoken, 'Wednesday at nine in the morning');
});

t('the wall clock survives BOTH sides of a daylight saving change', () => {
  // Adding 24 hours across a transition moves the clock by an hour, which would
  // book the visit at seven or at nine. Walking the calendar does not.
  const beforeFall = new Date('2026-10-30T19:00:00Z');  // PDT, before the November change
  const afterFall = new Date('2026-11-06T19:00:00Z');   // PST, after it
  assert.equal(wall(T.nextWindow('tuesday_8am', beforeFall).startsAt), 'Tue 8:00 AM');
  assert.equal(wall(T.nextWindow('tuesday_8am', afterFall).startsAt), 'Tue 8:00 AM');
  const beforeSpring = new Date('2026-03-05T19:00:00Z'); // PST
  const afterSpring = new Date('2026-03-12T19:00:00Z');  // PDT
  assert.equal(wall(T.nextWindow('wednesday_9am', beforeSpring).startsAt), 'Wed 9:00 AM');
  assert.equal(wall(T.nextWindow('wednesday_9am', afterSpring).startsAt), 'Wed 9:00 AM');
});

t('a wall clock that does not exist returns null instead of an hour of drift', () => {
  // 2:30 in the morning on the spring-forward Sunday never happens in Los Angeles.
  assert.equal(T.zonedInstant(2026, 3, 8, 2, 30, T.SHOP_TZ), null);
  // and the hour either side of it does
  assert.ok(T.zonedInstant(2026, 3, 8, 1, 30, T.SHOP_TZ) instanceof Date);
  assert.ok(T.zonedInstant(2026, 3, 8, 3, 30, T.SHOP_TZ) instanceof Date);
});

t('a window is never booked in the past, and never inside the next half hour', () => {
  // Tuesday 07:59 Pacific: the eight o'clock window is one minute away.
  const nearly = new Date('2026-08-18T14:59:00Z');
  const got = T.nextWindow('tuesday_8am', nearly);
  assert.ok(new Date(got.startsAt).getTime() - nearly.getTime() > 6 * 24 * 3600e3,
    'a window one minute out must roll to next week, not be sold as available');
  // and mid morning on the Tuesday itself, the afternoon window is still today
  const midMorning = new Date('2026-08-18T16:00:00Z');
  assert.equal(new Date(T.nextWindow('tuesday_130pm', midMorning).startsAt).toISOString(), '2026-08-18T20:30:00.000Z');
});

t('there is no fourth window, and asking for one is an honest refusal', () => {
  assert.deepEqual(T.WINDOW_KEYS, ['tuesday_8am', 'tuesday_130pm', 'wednesday_9am']);
  for (const bad of ['friday_8am', 'tuesday_9am', 'TUESDAY', '', 'null', 'asap']) {
    const r = T.nextWindow(bad, new Date('2026-08-14T19:00:00Z'));
    assert.equal(r.ok, false, bad);
  }
});

// ── 2. THE PLACEHOLDER FLOOR ────────────────────────────────────────────────
// The characteristic failure of a booking agent is not refusing to book. It is
// booking with a field the caller never said.

t('a real booking sails straight through', () => {
  const r = T.normalizeBooking(GOOD, new Date('2026-08-14T19:00:00Z'));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.clean.customer_phone, '+19168663918');
  assert.equal(r.clean.customer_name, "Dana O'Whitfield");
  assert.equal(r.clean.spoken_window, 'Tuesday at eight in the morning');
});

t('the awkward but real ones are not mistaken for invented ones', () => {
  const ok = [
    { ...GOOD, customer_name: 'Bo Ng' },
    { ...GOOD, address: 'Rural Route 2, Box 14, Herald' },
    { ...GOOD, address: 'the blue house on Vernon past the water tower' },
    { ...GOOD, customer_name: 'Unknowski' },          // starts with a placeholder word
    { ...GOOD, service: 'no heat' },
    { ...GOOD, callback_number: '+1 916 866 3918' },
    { ...GOOD, notes: 'dog in the yard, gate code is the last four of the phone' },
  ];
  for (const c of ok) {
    const r = T.normalizeBooking(c, new Date('2026-08-14T19:00:00Z'));
    assert.equal(r.ok, true, JSON.stringify(c) + ' -> ' + JSON.stringify(r.missing || r.problems));
  }
});

t('the invented ones are refused, and named', () => {
  const cases = [
    [{ ...GOOD, customer_name: 'Unknown' }, 'their name'],
    [{ ...GOOD, customer_name: 'the customer' }, 'their name'],
    [{ ...GOOD, customer_name: 'John Doe' }, 'their name'],
    [{ ...GOOD, customer_name: '' }, 'their name'],
    [{ ...GOOD, address: '123 Main St' }, 'the address'],
    [{ ...GOOD, address: '123 Main Street, Springfield' }, 'the address'],
    [{ ...GOOD, address: 'N/A' }, 'the address'],
    [{ ...GOOD, address: 'TBD' }, 'the address'],
    [{ ...GOOD, address: '[address]' }, 'the address'],
    [{ ...GOOD, callback_number: 'unknown' }, 'a callback number'],
    [{ ...GOOD, callback_number: '555-123-4567' }, 'a callback number'],
    [{ ...GOOD, callback_number: '111 111 1111' }, 'a callback number'],
    [{ ...GOOD, callback_number: '12' }, 'a callback number'],
    [{ ...GOOD, service: 'n/a' }, 'what the visit is for'],
    [{ ...GOOD, window: 'friday_8am' }, 'which of the three windows they want'],
    [{ ...GOOD, window: '' }, 'which of the three windows they want'],
  ];
  for (const [input, expect] of cases) {
    const r = T.normalizeBooking(input, new Date('2026-08-14T19:00:00Z'));
    assert.equal(r.ok, false, JSON.stringify(input));
    assert.ok(r.missing.includes(expect), JSON.stringify(input) + ' -> ' + JSON.stringify(r.missing));
  }
});

t('a placeholder in an OPTIONAL field is dropped, not refused', () => {
  const r = T.normalizeBooking({ ...GOOD, notes: 'N/A' }, new Date('2026-08-14T19:00:00Z'));
  assert.equal(r.ok, true);
  assert.equal(r.clean.notes, '', 'an invented note must not travel to the shop as a real one');
});

t('every missing field is reported at once, so riley asks once and not four times', () => {
  const r = T.normalizeBooking({ window: 'tuesday_8am' }, new Date('2026-08-14T19:00:00Z'));
  assert.equal(r.ok, false);
  assert.equal(r.missing.length, 4);
  const said = T.RESULTS.missing(r.missing);
  assert.ok(said.startsWith('NOT BOOKED'), said);
  assert.ok(said.includes('and'), 'the list has to read like a sentence: ' + said);
});

// ── 3. IDEMPOTENCY ──────────────────────────────────────────────────────────

t('the same job produces the same key, and a different job does not', () => {
  const a = T.normalizeBooking(GOOD, new Date('2026-08-14T19:00:00Z')).clean;
  const b = T.normalizeBooking({ ...GOOD, callback_number: '916-866-3918' }, new Date('2026-08-14T19:00:00Z')).clean;
  assert.equal(T.idemKey(a, 'conv_1'), T.idemKey(b, 'conv_1'), 'the same number typed differently is the same job');
  assert.notEqual(T.idemKey(a, 'conv_1'), T.idemKey(a, 'conv_2'), 'two conversations are two jobs');
  const other = T.normalizeBooking({ ...GOOD, window: 'wednesday_9am' }, new Date('2026-08-14T19:00:00Z')).clean;
  assert.notEqual(T.idemKey(a, 'conv_1'), T.idemKey(other, 'conv_1'), 'a different window is a different visit');
  assert.match(T.idemKey(a, 'conv_1'), /^[0-9a-f]{64}$/);
});

t('a missing conversation id still produces a usable key', () => {
  const a = T.normalizeBooking(GOOD, new Date('2026-08-14T19:00:00Z')).clean;
  assert.equal(T.idemKey(a, ''), T.idemKey(a, null), 'no id is one bucket, not a random one');
  assert.notEqual(T.idemKey(a, ''), T.idemKey(a, 'conv_1'));
});

// ── 4. WHAT THE MODEL IS TOLD, AND WHAT THE VENDOR IS TOLD ──────────────────

t('the vendor schema and the model schema are the same schema', () => {
  const el = T.elToolConfig({ url: 'https://x/api/answered-tool?tool=book_job', headers: { Authorization: 'Bearer x' } });
  const an = T.anthropicTool();
  assert.equal(el.name, an.name);
  assert.deepEqual(Object.keys(el.api_schema.request_body_schema.properties), Object.keys(an.input_schema.properties));
  assert.deepEqual(el.api_schema.request_body_schema.required, an.input_schema.required);
  assert.deepEqual(an.input_schema.properties.window.enum, T.WINDOW_KEYS);
  assert.equal(el.api_schema.method, 'POST');
  assert.ok(el.api_schema.request_headers.Authorization, 'the tool must carry a credential');
});

t('every sentence the tool speaks back is safe for the voice to repeat', () => {
  const all = [
    T.RESULTS.booked('Tuesday at eight in the morning'),
    T.RESULTS.replayed('Wednesday at nine in the morning'),
    T.RESULTS.missing(['their name', 'the address']),
    T.RESULTS.failed,
  ];
  for (const line of all) {
    assert.ok(!/[0-9]/.test(line), 'a digit here comes back out of the numeral firewall as a pivot: ' + line);
    assert.ok(!/[$]|dollars?|bucks/i.test(line), 'price floor: ' + line);
    assert.ok(!/\b(?:monday|thursday|friday|saturday|sunday)\b/i.test(line), 'day floor: ' + line);
    assert.ok(!/call you back|text you|email you/i.test(line), 'contact floor: ' + line);
    assert.ok(!/—|–/.test(line), 'no em dashes in net new copy: ' + line);
  }
});

t('wasBooked reads the verdict and not the vocabulary', () => {
  // Every failure sentence also contains the word booked. A substring test
  // would read all of them as successes and never offer a second attempt.
  assert.equal(T.wasBooked(T.RESULTS.booked('Tuesday at eight in the morning')), true);
  assert.equal(T.wasBooked(T.RESULTS.replayed('Tuesday at eight in the morning')), true);
  assert.equal(T.wasBooked(T.RESULTS.missing(['the address'])), false);
  assert.equal(T.wasBooked(T.RESULTS.failed), false);
  assert.equal(T.wasBooked(''), false);
  assert.equal(T.wasBooked(null), false);
});

// ── 5. THE ENDPOINT, THROUGH ITS REAL DEFAULT EXPORT ────────────────────────

process.env.ANSWERED_BOOKING_SECRET = 'tool-test-secret';
process.env.ANSWERED_SITE_URL = 'https://answered.test';
process.env.ANSWERED_DEMO_NUMBER = '+19163504869';
delete process.env.ANSWERED_COCKPIT_KEY;
delete process.env.ANSWERED_BRAIN_SECRET;
delete process.env.ANSWERED_DB_URL;      // idempotency degrades to best effort, loudly
delete process.env.ANSWERED_DB_ANON;
delete process.env.ANSWERED_DB_SECRET;

let BOOKING_CALLS = [];
let BOOKING_REPLY = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('/api/booking')) {
    BOOKING_CALLS.push({ url: u, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(BOOKING_REPLY.body), {
      status: BOOKING_REPLY.status, headers: { 'content-type': 'application/json' },
    });
  }
  return realFetch(url, init);
};

const tool = (await import('../answered-tool.mjs')).default;
const call = (body, { auth = 'tool-test-secret', method = 'POST', path = '/api/answered-tool?tool=book_job' } = {}) =>
  tool(new Request('https://answered.test' + path, {
    method,
    headers: auth ? { 'content-type': 'application/json', authorization: 'Bearer ' + auth } : { 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {}),
  }));

const OK_BOOKING = { status: 201, body: { ok: true, id: 'AJTESTTEST', url: 'https://answered.test/job/v1.x.y', mode: 'demo' } };

await at('an anonymous request books nothing', async () => {
  const r = await call(GOOD, { auth: null });
  assert.equal(r.status, 401);
  assert.equal(BOOKING_CALLS.length, 0);
});

await at('a wrong credential books nothing', async () => {
  const r = await call(GOOD, { auth: 'not-the-secret' });
  assert.equal(r.status, 401);
  assert.equal(BOOKING_CALLS.length, 0);
});

await at('GET is refused and says how to use it', async () => {
  const r = await call(null, { method: 'GET' });
  assert.equal(r.status, 405);
  assert.ok((await r.json()).how.includes('book_job'));
});

await at('a tool this server does not have is a 404, not a shrug', async () => {
  const r = await call(GOOD, { path: '/api/answered-tool?tool=cancel_job' });
  assert.equal(r.status, 404);
  assert.equal(BOOKING_CALLS.length, 0);
});

await at('a real booking reaches /api/booking with the shop pinned by the SERVER', async () => {
  BOOKING_CALLS = []; BOOKING_REPLY = OK_BOOKING;
  const r = await call({ ...GOOD, shop_name: 'Not This Shop', mode: 'live', starts_at: '2030-01-01T00:00:00Z' });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.ok, true);
  assert.equal(j.booked, true);
  assert.equal(j.job_id, 'AJTESTTEST');
  assert.equal(BOOKING_CALLS.length, 1);
  const sent = BOOKING_CALLS[0].body;
  // the three things the model is not allowed to decide
  assert.equal(sent.shop_name, T.DEMO_SHOP, 'the model must not be able to name the shop');
  assert.equal(sent.mode, 'demo', 'the model must not be able to promote a demo booking to a real one');
  assert.equal(wall(sent.starts_at), 'Tue 8:00 AM', 'the model must not be able to name a date');
  assert.equal(sent.customer_phone, '+19168663918');
  assert.equal(sent.tz, T.SHOP_TZ);
  assert.equal(sent.minutes, T.VISIT_MINUTES);
  assert.ok(/^Bearer /.test(BOOKING_CALLS[0].headers.Authorization));
  // and the sentence handed back to the voice carries no digits at all
  assert.ok(!/[0-9]/.test(j.result), j.result);
  assert.ok(j.result.startsWith('BOOKED.'));
});

await at('a missing field books NOTHING and tells riley exactly what to ask for', async () => {
  BOOKING_CALLS = []; BOOKING_REPLY = OK_BOOKING;
  const r = await call({ ...GOOD, address: '' });
  const j = await r.json();
  assert.equal(r.status, 200, 'a 4xx here makes the vendor invent its own sentence for the caller');
  assert.equal(j.ok, false);
  assert.equal(j.booked, false);
  assert.equal(BOOKING_CALLS.length, 0, 'nothing may reach the booking endpoint');
  assert.ok(j.still_needed.includes('the address'));
  assert.ok(j.result.startsWith('NOT BOOKED'), j.result);
});

await at('an invented address books NOTHING', async () => {
  BOOKING_CALLS = []; BOOKING_REPLY = OK_BOOKING;
  const j = await (await call({ ...GOOD, address: '123 Main Street' })).json();
  assert.equal(j.booked, false);
  assert.equal(BOOKING_CALLS.length, 0);
});

await at('a booking endpoint that refuses is never dressed up as a booking', async () => {
  BOOKING_CALLS = [];
  BOOKING_REPLY = { status: 502, body: { ok: false, error: 'The job was not booked, because the shop could not be told about it.' } };
  const j = await (await call(GOOD)).json();
  assert.equal(j.ok, false);
  assert.equal(j.booked, false);
  assert.equal(j.upstream_status, 502);
  assert.ok(j.result.startsWith('NOT BOOKED.'), j.result);
  assert.ok(!/\bbooked\b/i.test(j.result.split('.')[0].replace(/^NOT BOOKED/, '')), j.result);
});

await at('a 201 that does not say ok is not a booking either', async () => {
  BOOKING_CALLS = [];
  BOOKING_REPLY = { status: 201, body: { id: 'AJWHATEVER' } }; // no ok:true
  const j = await (await call(GOOD)).json();
  assert.equal(j.booked, false, 'a status code is not a verdict; the body is');
});

await at('no credential configured is a refusal, never an open door', async () => {
  const keep = process.env.ANSWERED_BOOKING_SECRET;
  delete process.env.ANSWERED_BOOKING_SECRET;
  try {
    const r = await call(GOOD, { auth: keep });
    assert.equal(r.status, 503);
  } finally { process.env.ANSWERED_BOOKING_SECRET = keep; }
});

await at('the parameters may arrive nested, the way some vendors send them', async () => {
  BOOKING_CALLS = []; BOOKING_REPLY = OK_BOOKING;
  const j = await (await call({ parameters: GOOD, conversation_id: 'conv_nested' })).json();
  assert.equal(j.booked, true);
  assert.equal(BOOKING_CALLS.length, 1);
});

await at('the tool name may arrive in the PATH as well as the query', async () => {
  BOOKING_CALLS = []; BOOKING_REPLY = OK_BOOKING;
  const j = await (await call(GOOD, { path: '/api/answered-tool/book_job' })).json();
  assert.equal(j.booked, true);
});

await at('a spine that is down degrades idempotency LOUDLY and still books the job', async () => {
  BOOKING_CALLS = []; BOOKING_REPLY = OK_BOOKING;
  const j = await (await call(GOOD)).json();
  assert.equal(j.booked, true);
  assert.equal(j.idempotency, 'best effort',
    'a job that was never written down is worse than a job written down twice, and the response says which happened');
});

// ── report ──────────────────────────────────────────────────────────────────
console.log('\ntools: ' + pass + ' passed, ' + fail + ' failed');
for (const f of failures) console.log('  FAIL  ' + f);
process.exit(fail ? 1 : 0);
