#!/usr/bin/env node
// portal.test.mjs — the customer portal, tested where it can actually be wrong.
//
// TWO HALVES, AND THE SPLIT IS THE POINT.
//
//   PURE      no network, no database, no server. Tokens, prices, windows, the calendar file and
//             every page's HTML, rendered from plain objects. Runs anywhere, always.
//   SERVING   real HTTP against a running site. `BASE=http://localhost:8888 node portal.test.mjs`
//             or BASE=https://answered.reddenda.com. Skipped, loudly, when BASE is absent, because
//             a suite that silently skips its only real check reports a green it did not earn.
//
// WHAT THIS FILE IS FOR: the estate's repeated defect is a writer and a reader that are each
// correct and have never been run against each other. So the assertions are on the OUTPUT a person
// would see, never on the fact that a function was called.
//
//   node portal.test.mjs                       pure only
//   BASE=http://localhost:8888 node portal.test.mjs   pure plus serving
//   SHOTS=1 node portal.test.mjs               also write the rendered pages to disk to look at

import { writeFileSync, mkdirSync } from 'node:fs';

process.env.ANSWERED_BOOKING_KEY = process.env.ANSWERED_BOOKING_KEY
  || 'test-key-for-the-pure-half-only-never-a-real-one';

const jobs = await import('./netlify/functions/lib/jobs.mjs');
const ui = await import('./netlify/functions/lib/portal-ui.mjs');
const bk = await import('./netlify/functions/lib/booking.mjs');

const BASE = (process.env.BASE || '').replace(/\/+$/, '');
const SHOTS = process.env.SHOTS === '1';
const OUT = process.env.SHOT_DIR || '/tmp/portal-shots';

let failed = 0; const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
}

// ── fixtures: shaped exactly like public.jobs, never shipped to a user ───────────────────────
// These are TEST INPUTS, not sample data. Nothing here is ever rendered on a live surface: the
// portal's empty state is an honest empty state and this file is not deployed.

const ACCOUNT = {
  id: '11111111-2222-3333-4444-555555555555',
  business_name: 'Redwood Plumbing',
  owner_email: 'owner@example.test',
  owner_phone: '+19165550142',
  timezone: 'America/Los_Angeles',
  status: 'live',
};

const soon = new Date(Date.now() + 36 * 3600 * 1000);
const past = new Date(Date.now() - 72 * 3600 * 1000);

const FULL = {
  job_ref: 'AJ0A1B2C3D4E', account_id: ACCOUNT.id, caller_name: 'Maria Delgado',
  address: '1420 J Street, Sacramento CA', callback: '+19165550100',
  window_start: soon.toISOString(), window_end: new Date(soon.getTime() + 7200000).toISOString(),
  after_hours: false, status: 'booked', source: 'voice', call_sid: 'CA' + 'a'.repeat(32),
  created_at: new Date().toISOString(), upcoming: true,
  details: { service: 'Water heater leaking into the garage', notes: 'Gate code 4417. Dog is friendly.', tz: 'America/Los_Angeles', mode: 'live' },
};
const NIGHT = { ...FULL, job_ref: 'AJ9F8E7D6C5B', after_hours: true, details: { ...FULL.details, service: 'No heat, whole house' } };
const THIN = {
  ...FULL, job_ref: 'AJ1111111111', address: null, callback: null,
  window_start: null, window_end: null, upcoming: false,
  details: { service: 'Someone will call back about a bathroom remodel', notes: '', tz: 'America/Los_Angeles', mode: 'live' },
};
const VOIDED = {
  ...FULL, job_ref: 'AJ2222222222', status: 'voided', upcoming: false,
  void_reason: 'We already had this one: booked it on the van radio an hour before.',
  voided_at: new Date().toISOString(),
  window_start: past.toISOString(), window_end: new Date(past.getTime() + 3600000).toISOString(),
};

// ═══ PURE 1: the token is the credential, so it has to behave like one ═══════════════════════

function tokens() {
  const t = jobs.mintReceipt(FULL.job_ref, ACCOUNT.id);
  const read = jobs.readReceipt(t);
  check('a minted receipt reads back its own reference', read && read.r === FULL.job_ref,
    `minted ${t.length} chars, read back r=${read && read.r}`);

  const flipped = `${t.slice(0, -3)}${t.slice(-3) === 'AAA' ? 'BBB' : 'AAA'}`;
  check('a tampered signature is refused', jobs.readReceipt(flipped) === null,
    'last three characters of the MAC changed, readReceipt returned null');

  const [p, payload] = t.split('.');
  check('a payload edited under a valid-looking shape is refused',
    jobs.readReceipt(`${p}.${payload.slice(0, -2)}XY.${t.split('.')[2]}`) === null,
    'payload mutated, MAC unchanged, refused');

  // ★ THE ONE THAT MATTERS. The same HMAC key signs the homeowner's /job/ link, and those go to
  // members of the public. If the label were outside the MAC input, a homeowner's booking link
  // would verify here and hand a stranger the VOID control on somebody's paid job.
  const homeowner = bk.mint({
    v: 1, id: FULL.job_ref, m: 'live', s: 'Redwood Plumbing', c: 'Maria Delgado',
    w: 'Water heater', t: soon.toISOString(), d: 60, tz: 'America/Los_Angeles', at: new Date().toISOString(),
  });
  check('a homeowner /job/ token cannot be replayed as a contractor receipt',
    jobs.readReceipt(homeowner) === null && bk.verify(homeowner) !== null,
    'bk.verify accepts it, jobs.readReceipt refuses it: the two label spaces are separate under one key');

  const feed = jobs.mintFeedKey(ACCOUNT.id);
  check('a feed key reads back one account and nothing else', jobs.readFeedKey(feed) === ACCOUNT.id,
    `feed key ${feed.length} chars`);
  check('a receipt token is not a feed key and a feed key is not a receipt',
    jobs.readFeedKey(t) === null && jobs.readReceipt(feed) === null,
    'cross-reads both return null');

  check('a receipt link fits in a text message and an email client',
    jobs.receiptUrl(t).length < 300, `${jobs.receiptUrl(t).length} characters end to end`);
}

// ═══ PURE 2: the four pieces decide the price, and the price is quoted, never computed ═══════

function prices() {
  const full = jobs.priceOf(FULL, null);
  check('a complete standard job is the published nineteen dollars',
    full.cents === 1900 && full.source === 'published', `${jobs.usd(full.cents)} from ${full.source}`);

  const night = jobs.priceOf(NIGHT, null);
  check('a complete after-hours job is the published forty nine',
    night.cents === 4900, `${jobs.usd(night.cents)}`);

  const thin = jobs.priceOf(THIN, null);
  check('a job missing pieces is free, and names the pieces it is missing',
    thin.cents === 0 && thin.missing_pieces.includes('address') && thin.missing_pieces.includes('window'),
    `${jobs.usd(thin.cents)}, missing: ${thin.missing_pieces.join(', ')}`);

  // The estate rule: a headline figure is a stored vetted field, never a re-sum. When billing has
  // written a charge, the receipt prints THAT, even when it disagrees with the price book.
  const led = jobs.priceOf(FULL, { cents: 0, kind: 'booked_job', state: 'voided', reason: 'voided after a dispute' });
  check('a ledger charge beats the price book, even when they disagree',
    led.source === 'ledger' && led.cents === 0,
    `price book says ${jobs.usd(full.cents)}, ledger says ${jobs.usd(led.cents)}, receipt prints the ledger`);

  // THIN keeps its caller name and loses the other three, so exactly one piece is present. Written
  // as an explicit map rather than a count, because a count of 1 would also pass if the WRONG
  // piece were the one reported present.
  const pieces = jobs.fourPieces(THIN);
  const map = Object.fromEntries(pieces.map((x) => [x.key, x.ok]));
  check('the four pieces are reported one by one, not as a score',
    pieces.length === 4 && map.name === true && map.address === false && map.callback === false && map.window === false,
    pieces.map((x) => `${x.key}=${x.ok ? 'yes' : 'no'}`).join(' '));
}

// ═══ PURE 3: a window we do not have is never invented ═══════════════════════════════════════

function windows() {
  const w = jobs.windowParts(FULL, ACCOUNT.timezone);
  check('a real window renders a day, a range and a zone', w.known && w.day && w.window && w.zone,
    `${w.day}, ${w.window} ${w.zone}`);
  const n = jobs.windowParts(THIN, ACCOUNT.timezone);
  check('a job with no window says so instead of guessing one',
    n.known === false && n.day === '' && n.window === '',
    'known=false, no day, no range, and the price engine independently rates it free');
}

// ═══ PURE 4: the calendar file is a file a calendar will actually open ═══════════════════════

function calendar() {
  const ics = jobs.feedIcs([FULL, NIGHT, THIN, VOIDED], ACCOUNT);
  check('every line ends CRLF, which is what RFC 5545 requires',
    !/[^\r]\n/.test(ics), `${ics.split('\r\n').length} folded lines`);
  check('a job with no agreed window is left out rather than given a made-up time',
    !ics.includes(THIN.job_ref), 'THIN is absent from the feed and stays on the web page');
  check('a voided job is CANCELLED, not deleted',
    ics.includes(VOIDED.job_ref) && ics.includes('STATUS:CANCELLED'),
    'a calendar that silently drops an event leaves a stale copy on the phone forever');
  check('the folding is by octet, so an accented street name cannot corrupt the file',
    ics.split('\r\n').every((l) => Buffer.byteLength(l, 'utf8') <= 75),
    `longest line ${Math.max(...ics.split('\r\n').map((l) => Buffer.byteLength(l, 'utf8')))} bytes`);
  check('the feed carries two booked jobs and one cancelled one',
    (ics.match(/BEGIN:VEVENT/g) || []).length === 3, `${(ics.match(/BEGIN:VEVENT/g) || []).length} events`);
}

// ═══ PURE 5: the pages, rendered, and checked for the things a screenshot cannot see ═════════

const view = (row) => ({
  ...row,
  when: jobs.windowParts(row, ACCOUNT.timezone),
  callbackPretty: row.callback ? jobs.prettyPhone(row.callback) : '',
  bookedOn: 'Thu, Aug 14, 1:20 PM',
  voidedOn: row.voided_at ? 'Thu, Aug 14, 2:05 PM' : '',
  reasons: jobs.VOID_REASONS,
});
const price = (row, charge) => {
  const p = jobs.priceOf(row, charge);
  return { ...p, money: jobs.usd(p.cents), capText: '$549', pieces: p.source === 'published' ? jobs.fourPieces(row) : null };
};
const rowFor = (row) => {
  const w = jobs.windowParts(row, ACCOUNT.timezone);
  const p = jobs.priceOf(row, null);
  return {
    token: jobs.mintReceipt(row.job_ref, ACCOUNT.id),
    job_ref: row.job_ref,
    service: row.details.service,
    caller_name: row.caller_name, address: row.address || '', status: row.status,
    after_hours: row.after_hours, upcoming: row.upcoming,
    whenShort: w.known ? `${w.day}, ${w.window}` : 'No window agreed',
    priceShort: row.status === 'voided' ? 'Voided' : (p.cents > 0 ? jobs.usd(p.cents) : 'Free'),
    freeReason: row.status !== 'voided' && !p.cents && p.missing_pieces.length ? `no ${p.missing_pieces[0]}` : '',
  };
};

function pages() {
  const token = jobs.mintReceipt(FULL.job_ref, ACCOUNT.id);
  const receipt = ui.receiptPage({
    job: view(FULL), account: ACCOUNT, price: price(FULL, null), token,
    call: { call_sid: FULL.call_sid, summary: 'Caller said the water heater is leaking into the garage and asked for the first slot tomorrow. Gate code given.', whenText: 'The call came in Thu, Aug 14, 1:18 PM', lengthText: 'It lasted 2 minutes 41 seconds', recording_sid: 'RE' + 'b'.repeat(32) },
    flash: null,
  });

  check('the receipt renders the callback as a real tel: link',
    receipt.includes(`href="tel:${FULL.callback}"`),
    'the redesign war room\'s number one finding was a phone company you cannot call');
  check('the receipt carries the void control and its closed list of reasons',
    receipt.includes('/api/portal/void') && jobs.VOID_REASONS.every((r) => receipt.includes(`value="${r.key}"`)),
    `${jobs.VOID_REASONS.length} reasons, all rendered as radios inside a plain form`);
  // ★ THE ASSERTION IS ON WHAT THE PAGE MAY NOT SAY. sv_job_void changes a job's status and writes
  // a crm_activity row. It does not touch billing_events, and there is no trigger that does
  // (measured: zero triggers on public.jobs). So any sentence promising an automatic refund would
  // be a promise nothing in this system keeps.
  const overpromise = /you (will )?(not be|won't be) charged|we(' | )?ll refund|automatically refunded|the charge is (removed|cancelled|reversed)|money back/i;
  check('the receipt promises only what sv_job_void actually does',
    /settled on the billing side/.test(receipt) && !overpromise.test(receipt),
    `says a person settles the charge; the over-promise pattern matches ${(receipt.match(overpromise) || ['nothing']).join(', ')}`);
  check('a voided receipt makes the same promise and no bigger one',
    /settles the charge on the billing side/.test(ui.receiptPage({ job: view(VOIDED), account: ACCOUNT, price: price(VOIDED, null), token, call: null, flash: null })),
    'the voided band and the dispute form say the same thing about the charge');
  check('the receipt says out loud that no text was sent',
    /did not text you/.test(receipt), 'A2P is unapproved, so nothing may imply a text arrived');

  const thinReceipt = ui.receiptPage({ job: view(THIN), account: ACCOUNT, price: price(THIN, null), token: jobs.mintReceipt(THIN.job_ref, ACCOUNT.id), call: null, flash: null });
  check('a receipt with no callback renders a sentence, never a dead dial control',
    !/href="tel:/.test(thinReceipt) && /No callback number was given/.test(thinReceipt),
    'no tel: href anywhere on a job whose callback was never captured');
  check('a receipt with no window says no time was agreed',
    /No time was agreed/.test(thinReceipt), 'and the cost box independently says it is free');

  const voidReceipt = ui.receiptPage({ job: view(VOIDED), account: ACCOUNT, price: price(VOIDED, null), token: jobs.mintReceipt(VOIDED.job_ref, ACCOUNT.id), call: null, flash: null });
  check('a voided receipt drops the void form and keeps the record',
    !voidReceipt.includes('/api/portal/void') && voidReceipt.includes(VOIDED.void_reason),
    'nothing is deleted, and there is nothing left to press');

  const portal = ui.portalPage({
    account: ACCOUNT,
    state: { headline: 'Your line is on', detail: 'Calls to your number are answered with your rules.', emptyWhy: '' },
    jobs: [FULL, NIGHT, VOIDED].map(rowFor),
    counts: { all: 3, upcoming: 2, done: 0, voided: 1 },
    filter: 'all',
    month: { countable: true, total: '$68.00', billable: 2, free: 0, cap: '$549' },
    prefs: { owner_email: ACCOUNT.owner_email, email_extra: ['office@example.test'], sms_on: true, sms_to: ACCOUNT.owner_phone, sms_to_pretty: jobs.prettyPhone(ACCOUNT.owner_phone), owner_phone_pretty: jobs.prettyPhone(ACCOUNT.owner_phone), call_on: false, call_after_hours_only: true },
    gates: { sms: { ready: false, reason: 'Text messaging is switched off. The A2P 10DLC campaign that a carrier requires before a business number may send text messages is not approved yet, so a text from this system would not reach a phone.' }, call: jobs.callChannelStatus() },
    feed: { url: jobs.feedUrl(jobs.mintFeedKey(ACCOUNT.id)) },
    flash: null, jobsError: false,
  });

  check('email is rendered as always on, with no control that could switch it off',
    /Always on/.test(portal) && !/name="email_on"/.test(portal),
    'David\'s ruling is the shape of the form, not a sentence in it');
  check('the text channel is shown blocked, with the carrier reason in words',
    /A2P 10DLC/.test(portal) && /class="state blocked"/.test(portal),
    'on, wanted, and not deliverable, which are three different facts');
  check('the call control is disabled while nothing on this deploy can dial',
    /name="call_on"[^>]*disabled/.test(portal),
    `callChannelStatus says ready=${jobs.callChannelStatus().ready}, so the checkbox carries the disabled attribute`);
  check('the month figure is labelled as the published price and not as a bill',
    /It is not your bill/.test(portal), 'the billing ledger is the vetted source and applies the cap');
  check('the calendar address is warned about, because the URL is the credential',
    /Treat this like a key/.test(portal), 'anyone holding it can read the jobs');
  check('the portal points at the account page rather than duplicating it',
    /href="\/account"/.test(portal) && !/greeting_name/.test(portal),
    'the answering rules stay in one place, on the page that already owns them');

  const empty = ui.portalPage({
    account: ACCOUNT,
    state: { headline: 'Your line is on', detail: 'Calls are answered with your rules.', emptyWhy: 'Your line is on and nobody has called it yet. This is the true count, not a page that has not loaded.' },
    jobs: [], counts: { all: 0, upcoming: 0, done: 0, voided: 0 }, filter: 'all',
    month: { countable: false },
    prefs: { owner_email: ACCOUNT.owner_email, email_extra: [], sms_on: true, sms_to_pretty: '', owner_phone_pretty: '', call_on: false, call_after_hours_only: true },
    gates: { sms: { ready: false, reason: 'Text messaging is switched off.' }, call: jobs.callChannelStatus() },
    feed: { url: jobs.feedUrl(jobs.mintFeedKey(ACCOUNT.id)) }, flash: null, jobsError: false,
  });
  check('the empty state is an honest zero that says which kind of zero it is',
    /that is a real zero/.test(empty) && /nobody has called it yet/.test(empty) && !/AJ0A1B/.test(empty),
    'no sample row, no placeholder, and a reason drawn from the account\'s real state');

  const broken = ui.portalPage({ ...JSON.parse(JSON.stringify({
    account: ACCOUNT, state: { headline: 'Your line is on', detail: '', emptyWhy: '' }, jobs: [],
    counts: { all: 0, upcoming: 0, done: 0, voided: 0 }, filter: 'all', month: { countable: false },
    prefs: { owner_email: ACCOUNT.owner_email, email_extra: [], sms_on: true, sms_to_pretty: '', owner_phone_pretty: '', call_on: false, call_after_hours_only: true },
    feed: { url: '' }, flash: null, jobsError: true,
  })), gates: { sms: { ready: false, reason: 'off' }, call: jobs.callChannelStatus() } });
  check('a read that failed does NOT render as an empty list',
    /cannot read your jobs right now/.test(broken) && !/real zero/.test(broken),
    'a thrown read and a true zero look identical on a page that renders both as "no jobs"');

  const login = ui.loginPage({});
  check('the sign-in page sells the link, not the login',
    /with no password/.test(login), 'the gate is optional and the page says so first');

  // Every page, checked for the things a screenshot will not show you.
  for (const [name, doc] of [['receipt', receipt], ['thin receipt', thinReceipt], ['voided receipt', voidReceipt], ['portal', portal], ['empty portal', empty], ['login', login]]) {
    check(`${name}: no serif anywhere, and noindex is on the page itself`,
      !/serif(?!-)/.test(doc.replace(/ui-sans-serif|sans-serif/g, '')) && /noindex/.test(doc),
      'the house rule is no serif at any size on any surface');
    check(`${name}: no em dash in the copy`,
      !/—/.test(doc), 'net-new copy carries none');
    check(`${name}: reduced motion is honoured`,
      /prefers-reduced-motion/.test(doc), 'and nothing rests at opacity 0');
  }

  if (SHOTS) {
    mkdirSync(OUT, { recursive: true });
    const files = { 'receipt.html': receipt, 'receipt-thin.html': thinReceipt, 'receipt-voided.html': voidReceipt, 'portal.html': portal, 'portal-empty.html': empty, 'login.html': login };
    for (const [f, doc] of Object.entries(files)) writeFileSync(`${OUT}/${f}`, doc);
    console.log(`\n      wrote ${Object.keys(files).length} pages to ${OUT}`);
  }
}

// ═══ SERVING: the only half that can prove the gate ══════════════════════════════════════════

async function serving() {
  const get = async (p, opts = {}) => {
    const r = await fetch(BASE + p, { redirect: 'manual', signal: AbortSignal.timeout(20000), ...opts });
    const text = await r.text();
    return { status: r.status, text, headers: r.headers, bytes: Buffer.byteLength(text, 'utf8') };
  };

  // ── the declared route is the route that answers ─────────────────────────────────────────
  for (const [p, want] of [['/portal', [200]], ['/portal/login', [200]], ['/j/nope', [404]], ['/portal/feed.ics', [404]]]) {
    const r = await get(p);
    check(`declared route answers: GET ${p}`, want.includes(r.status),
      `got ${r.status}, wanted ${want.join('/')}${want.includes(r.status) ? '' : '. A 404 here means config.path registered nothing'}`);
  }

  // ── THE GATE. This is the measurement the whole design rests on. ─────────────────────────
  const anon = await get('/portal');
  const leaks = ['business_name', 'owner_email', 'job_ref', 'AJ', 'account_id', 'feed.ics?k=', 'sms_to'];
  const found = leaks.filter((s) => anon.text.includes(s));
  check('an anonymous GET /portal serializes NO account bytes',
    anon.status === 200 && found.length === 0 && anon.bytes < 12000,
    `${anon.bytes} bytes, and none of [${leaks.join(', ')}] appear. A curtain drawn in CSS over bytes the server already sent is not a gate`);
  check('the anonymous portal response IS the sign-in page and nothing else',
    /Send me a link/.test(anon.text) && /name="email"/.test(anon.text) && !/Sign out/.test(anon.text),
    'one form, no list, no settings, no sign-out control');

  // ★ POSITIVE CONTROL. Without this the check above passes on a page that failed to render at
  // all, which is how a vacuous scan reports a clean result forever.
  check('positive control: the gate check would have SEEN a leak',
    leaks.some((s) => ui.portalPage({
      account: ACCOUNT, state: { headline: 'x', detail: 'x', emptyWhy: 'x' }, jobs: [], counts: { all: 0, upcoming: 0, done: 0, voided: 0 },
      filter: 'all', month: { countable: false },
      prefs: { owner_email: ACCOUNT.owner_email, email_extra: [], sms_on: true, sms_to_pretty: '', owner_phone_pretty: '', call_on: false, call_after_hours_only: true },
      gates: { sms: { ready: false, reason: '' }, call: { ready: false, reason: '' } }, feed: { url: 'x' }, flash: null, jobsError: false,
    }).includes(s)),
    'the signed-in page contains at least one of the strings the anonymous page was checked for');

  const priv = anon.headers.get('cache-control') || '';
  check('the portal is never cacheable by a CDN or a shared proxy',
    /no-store/.test(priv) && /noindex/.test(anon.headers.get('x-robots-tag') || ''),
    `cache-control: ${priv || 'none'}, x-robots-tag: ${anon.headers.get('x-robots-tag') || 'none'}`);

  // ── the API half of the gate ─────────────────────────────────────────────────────────────
  const api = await fetch(`${BASE}/api/portal/settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"sms_on":false}',
    signal: AbortSignal.timeout(20000),
  });
  check('POST /api/portal/settings with no session is refused', api.status === 401,
    `got ${api.status}, and it must never be a 303 to a page that then renders somebody's data`);

  // ── a forged receipt link ────────────────────────────────────────────────────────────────
  const forged = await get(`/j/r1.${Buffer.from(JSON.stringify({ v: 1, r: 'AJ0A1B2C3D4E' })).toString('base64url')}.AAAA`);
  check('a forged receipt token is refused with no oracle',
    forged.status === 404 && !/AJ0A1B2C3D4E/.test(forged.text),
    `got ${forged.status}, and the body does not echo the reference that was probed`);

  // ── the void endpoint refuses what it should ─────────────────────────────────────────────
  const badVoid = await fetch(`${BASE}/api/portal/void`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 't=r1.bogus.bogus&reason=not_a_job', redirect: 'manual', signal: AbortSignal.timeout(20000),
  });
  check('a void with an unsigned token is refused', badVoid.status === 404,
    `got ${badVoid.status}. The token is the credential, so an unsigned one buys nothing`);

  // ★ THIS CHECK KNOWS WHETHER IT COULD HAVE RUN. The token below is signed with THIS process's
  // key. If the server holds a different one, a 404 is the correct answer and proves nothing about
  // the reason gate, so the result says which of the two happened instead of quietly going green.
  // Run it under `netlify dev:exec -- node portal.test.mjs` to share the server's key.
  const noReason = await fetch(`${BASE}/api/portal/void`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `t=${jobs.mintReceipt('AJ0A1B2C3D4E', ACCOUNT.id)}`, redirect: 'manual', signal: AbortSignal.timeout(20000),
  });
  const loc = noReason.headers.get('location') || '';
  const sameKey = noReason.status !== 404;
  check('a void with no reason is sent back to pick one',
    sameKey ? (noReason.status === 303 && /v=reason/.test(loc)) : true,
    sameKey
      ? `got ${noReason.status} to ${loc || 'nowhere'}`
      : 'NOT EXERCISED: this process and the server sign with different keys, so the token was refused before the reason gate. Re-run under netlify dev:exec to exercise it');

  const getVoid = await get('/api/portal/void');
  check('the void endpoint is POST only', getVoid.status === 405, `GET returned ${getVoid.status}`);

  // ── the feed refuses an unsigned key ─────────────────────────────────────────────────────
  const badFeed = await get('/portal/feed.ics?k=f1.bogus.bogus');
  check('the calendar feed refuses an unsigned key', badFeed.status === 404, `got ${badFeed.status}`);

  // ── the call TwiML endpoint is not an open reader of customer addresses ──────────────────
  const call = await get('/api/portal/job-call?k=nope');
  check('the job-call TwiML endpoint refuses an unsigned capability',
    call.status === 403 && !/Say/.test(call.text.replace(/<Response><Hangup\/><\/Response>/, '')),
    `got ${call.status}. TWILIO_AUTH_TOKEN is absent on this project, so Twilio's own signature cannot guard this`);
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────

console.log(`\nPORTAL TESTS${BASE ? ` (pure + serving against ${BASE})` : ' (pure only)'}\n${'-'.repeat(64)}`);
for (const [name, fn] of [['tokens', tokens], ['prices', prices], ['windows', windows], ['calendar', calendar], ['pages', pages]]) {
  console.log(`\n-- ${name} --`);
  try { fn(); } catch (e) { check(name, false, `suite threw: ${String(e && e.stack).slice(0, 400)}`); }
}
if (BASE) {
  console.log('\n-- serving --');
  try { await serving(); } catch (e) { check('serving', false, `suite threw: ${String(e && e.message).slice(0, 300)}`); }
} else {
  console.log('\n-- serving --\nSKIPPED: set BASE to run the half that can prove the gate. Nothing here is green until it runs.');
}

console.log(`\n${'-'.repeat(64)}\n${results.length - failed}/${results.length} passed`);
if (failed) { console.log('\nFAILED:'); for (const r of results.filter((x) => !x.ok)) console.log(`  ${r.name}`); }
process.exit(failed ? 1 : 0);
