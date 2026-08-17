// /api/call-me. ONE CLICK ACTIVATION: a person types their number, checks the
// consent box, and this places a REAL outbound call where the Answered setup
// voice walks them through switching their line on.
//
// THIS IS DIALER CODE, NOT A CONTACT FORM. Every line below is written on that
// footing. An outbound call carrying an artificial voice is FCC 24-17
// territory (an AI generated voice IS an "artificial voice" for 47 CFR
// 64.1200), so the consent record is the legal artifact and the call is only
// its consequence. The record is written BEFORE the dial, never after, and a
// store that cannot be written is a refusal, never a quiet dial.
//
// THE GATES, in the order they run. Cheap and certain first, vendor calls last.
//    0. paused          ANSWERED_CALLME_KILL stops every dial, everywhere
//    1. shape           POST, JSON, same origin, honeypot, body caps
//    2. consent         the flag AND the exact sentence we published
//    3. the number      NANP structure, then a known US area code
//    4. suppression     any "stop" ever recorded for this number, permanent
//    5. one per session the server derived session, 24 hours
//    6. one per number  24 hours, arbitrated so a double click cannot race
//    7. daily ceiling   an approximate spend cap, never called a measurement
//    8. quiet hours     8:00 to 21:00 in the local time of the area code
//    9. configured      every env this flow needs, named and checked
//   10. line health     ElevenLabs must be able to speak before we dial
//   11. line type       Twilio Lookup: mobile only, honest refusal otherwise
//   12. THE RECORD      the consent event is stored, then and only then
//   13. the dial        one call, five minute ceiling, no retries, ever
//
// NEVER A FALSE SUCCESS. Every refusal returns {ok:false, reason} with a plain
// sentence the front end can show a human, plus a machine "code". A refusal is
// logged with the same weight as a dial: the attempt log is the evidence the
// gates ran.
//
// WHY MOBILE ONLY. Consent is personal. An office landline is answered by
// whoever is nearest the phone, so the person who checked the box may not be
// the person who picks up, and a setup call is a conversation about their
// account. A landline gets an honest sentence and the demo number instead.
//
// WHY THE SETUP CALL WILL NOT FALL BACK TO THE DEMO AGENT. The demo agent is
// Riley, a receptionist for a clearly fictional plumbing shop. Pointing a real
// signup call at her would put a fabricated business in front of a customer.
// So ANSWERED_ONBOARD_AGENT_ID is REQUIRED: unset means this endpoint refuses
// honestly and /api/demo-health reports outbound red, which keeps the front
// end button from ever rendering. Nothing here degrades into the wrong voice.
//
// Env, by NAME only, all fail closed:
//   TWILIO_ACCOUNT_SID          the account the call is placed under
//   TWILIO_API_SID              Basic auth username (API key pair)
//   TWILIO_API_SECRET           Basic auth password
//   ANSWERED_DEMO_NUMBER        the caller ID, and the number we say out loud
//   ANSWERED_CALLME_FROM        optional override for the caller ID
//   ANSWERED_ONBOARD_AGENT_ID   the ElevenLabs setup agent. REQUIRED.
//   ANSWERED_EL_AGENT_ID        the demo agent. Read here ONLY to refuse if
//                               somebody points the two at the same id.
//   ELEVENLABS_API_KEY          health gate plus register-call
//   ANSWERED_CALLME_DAILY_CAP   optional, default 50
//   ANSWERED_CALLME_KILL        optional, any value pauses every dial
//   TWILIO_AUTH_TOKEN           optional today, and the day it lands the TwiML
//                               webhook upgrades to full signature validation
//                               with no code change (see lib/twilio-webhook)
//
// Routes, all three served by this one file:
//   POST /api/call-me           the JSON API the page calls
//   GET  /api/call-me           the consent sentence and whether the line is up
//   POST /api/call-me/twiml     Twilio asks what to say. Capability token only.
//   POST /api/call-me/status    Twilio reports how the call ended.

import crypto from 'node:crypto';
import { authenticate, XML, SAY, injectIntoResponse } from './lib/twilio-webhook.mjs';
import { isDown as providerIsDown, markUp as providerMarkUp } from './lib/provider-down.mjs';

// ── the published consent sentence ───────────────────────────────────────────
// THE SERVER OWNS THIS STRING. The front end must send back the exact sentence
// it rendered, and a mismatch is a refusal. A checkbox whose label has drifted
// from the sentence we can produce in a dispute is not a consent record, it is
// a guess, and the drift is silent unless something compares them.
const CONSENT_VERSION = '2026-08-14.1';
const CONSENT_TEXT =
  'Yes, call this number now. I agree Answered may call me at this number with an AI voice to help me set up. This is one call, not a list.';

// ── spoken copy. Everything the law needs, in the first breath ───────────────
// 47 CFR 64.1200(b): an artificial voice message identifies who is responsible
// at the start and gives a number to call back. California AB 2905: the AI
// voice is disclosed at the start. Both are satisfied before the agent speaks,
// by us, in a <Say> the vendor's document cannot skip.
const disclosure = (callback) =>
  `This is Answered, from Reddenda. You just asked us to call you, so here we are. `
  + `I am an A I voice. We will not call again unless you ask. `
  + (callback ? `Our number is ${spokenDigits(callback)} if you need us. ` : '');

const voicemailLine = (callback) =>
  `This is Answered, from Reddenda. You asked us to call about switching your line on. `
  + `We try once, and we will not call again. `
  + (callback ? `Our number is ${spokenDigits(callback)} when you are ready. ` : '')
  + `Thanks.`;

const brokenLine = (callback) =>
  `This is Answered, from Reddenda. You asked us to call you, and our setup line just failed on our end. `
  + `Sorry about that. `
  + (callback ? `Call us back at ${spokenDigits(callback)} when you are ready. ` : '')
  + `Goodbye.`;

/** Digits spaced so a text to speech voice reads a phone number, not a sum. */
function spokenDigits(e164) {
  return String(e164 || '').replace(/^\+1/, '').split('').join(' ');
}

// ── quiet hours ──────────────────────────────────────────────────────────────
// 8:00 to 21:00 in the local time where the number lives, every day of the
// week. The window is checked in EVERY zone the area code touches, so a split
// code can never be dialled at 07:40 on the wrong side of the line.
const QUIET_START_MIN = 8 * 60;
const QUIET_END_MIN = 21 * 60;

const ET = ['America/New_York'];
const CT = ['America/Chicago'];
const MT = ['America/Denver'];
const PT = ['America/Los_Angeles'];
const AZ = ['America/Phoenix', 'America/Denver']; // Arizona skips DST, the Navajo Nation does not
const ET_CT = ['America/New_York', 'America/Chicago'];
const CT_MT = ['America/Chicago', 'America/Denver'];
const MT_PT = ['America/Denver', 'America/Los_Angeles'];
const AK = ['America/Anchorage', 'America/Adak'];
const HI = ['Pacific/Honolulu'];
const PR = ['America/Puerto_Rico'];

// AN UNKNOWN AREA CODE IS A REFUSAL, NOT A GUESS. A new overlay we have not
// listed costs one honest "we could not tell what time it is where you are",
// which is the correct direction to be wrong in. Guessing costs a 7am phone
// call to a stranger who is asleep.
const AREA_ZONES = Object.create(null);
const zone = (zones, codes) => { for (const c of codes) AREA_ZONES[c] = zones; };

zone(ET, [
  '203', '475', '860', '959',                                              // CT
  '302',                                                                    // DE
  '202', '771',                                                             // DC
  '239', '305', '321', '352', '386', '407', '561', '645', '656', '689',     // FL east
  '727', '754', '772', '786', '813', '863', '904', '941', '954',
  '229', '404', '470', '478', '678', '706', '762', '770', '912', '943',     // GA
  '260', '317', '463', '574', '765',                                        // IN east
  '502', '606', '859',                                                      // KY east
  '207',                                                                    // ME
  '227', '240', '301', '410', '443', '667',                                 // MD
  '339', '351', '413', '508', '617', '774', '781', '857', '978',            // MA
  '231', '248', '269', '313', '517', '586', '616', '679', '734', '810',     // MI east
  '947', '989',
  '603',                                                                    // NH
  '201', '551', '609', '640', '732', '848', '856', '862', '908', '973',     // NJ
  '212', '315', '332', '347', '363', '516', '518', '585', '607', '631',     // NY
  '646', '680', '716', '718', '838', '845', '914', '917', '929', '934',
  '252', '336', '472', '704', '743', '828', '910', '919', '980', '984',     // NC
  '216', '220', '234', '283', '326', '330', '380', '419', '436', '440',     // OH
  '513', '567', '614', '740', '937',
  '215', '223', '267', '272', '412', '445', '484', '570', '582', '610',     // PA
  '717', '724', '814', '835', '878',
  '401',                                                                    // RI
  '803', '839', '843', '854', '864',                                        // SC
  '423', '865',                                                             // TN east
  '276', '434', '540', '571', '686', '703', '757', '804', '826', '948',     // VA
  '802',                                                                    // VT
  '304', '681',                                                             // WV
]);

zone(CT, [
  '205', '251', '256', '334', '483', '659', '938',                          // AL
  '327', '479', '501', '870',                                               // AR
  '217', '224', '309', '312', '331', '447', '464', '618', '630', '708',     // IL
  '730', '773', '779', '815', '847', '872',
  '219',                                                                    // IN northwest
  '319', '515', '563', '641', '712',                                        // IA
  '316', '913',                                                             // KS east
  '270', '364',                                                             // KY west
  '225', '318', '337', '457', '504', '985',                                 // LA
  '218', '320', '507', '612', '651', '763', '952',                          // MN
  '314', '417', '557', '573', '636', '660', '816', '975',                   // MO
  '228', '601', '662', '769',                                               // MS
  '402', '531',                                                             // NE east
  '405', '539', '572', '580', '918',                                        // OK
  '615', '629', '731', '901', '931',                                        // TN west
  '210', '214', '254', '281', '325', '346', '361', '409', '430', '432',     // TX
  '469', '512', '682', '713', '726', '737', '806', '817', '830', '832',
  '903', '936', '940', '945', '956', '972', '979',
  '262', '274', '353', '414', '534', '608', '715', '920',                   // WI
]);

zone(MT, [
  '303', '719', '720', '970', '983',                                        // CO
  '406',                                                                    // MT
  '505', '575',                                                             // NM
  '385', '435', '801',                                                      // UT
  '307',                                                                    // WY
  '915',                                                                    // TX far west
]);

zone(PT, [
  '209', '213', '279', '310', '323', '341', '350', '369', '408', '415',     // CA
  '424', '442', '510', '530', '559', '562', '619', '626', '628', '650',
  '657', '661', '669', '707', '714', '747', '760', '805', '818', '820',
  '831', '840', '858', '909', '916', '925', '949', '951',
  '702', '725',                                                             // NV south
  '503', '971',                                                             // OR west
  '206', '253', '360', '425', '509', '564',                                 // WA
]);

zone(AZ, ['480', '520', '602', '623', '928']);
zone(AK, ['907']);
zone(HI, ['808']);
zone(PR, ['787', '939', '340']);                                            // PR and USVI
zone(ET_CT, ['448', '850', '812', '930', '906']);                           // FL panhandle, IN south, MI upper
zone(CT_MT, ['620', '785', '308', '701', '605']);                           // KS, NE, ND, SD
zone(MT_PT, ['208', '986', '458', '541', '775']);                           // ID, OR east, NV north

/** Local wall clock minutes in an IANA zone at an instant. */
function localMinutes(tz, at) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(at).map((p) => [p.type, p.value]),
  );
  return (Number(parts.hour) % 24) * 60 + Number(parts.minute);
}

function insideWindow(zones, at) {
  for (const tz of zones) {
    const m = localMinutes(tz, at);
    if (m < QUIET_START_MIN || m >= QUIET_END_MIN) return { ok: false, tz, minutes: m };
  }
  return { ok: true };
}

// `secondsUntilOpen` lived here and computed how long a caller had to wait for the morning. It was
// removed with the refusal it served, on 2026-08-16. Leaving it would have been worse than useless:
// a live-looking helper named after a rule that no longer exists is how the next reader concludes
// the line still closes at night.

// ── small helpers ────────────────────────────────────────────────────────────
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const nowIso = () => new Date().toISOString();
const day = (d) => d.toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const json = (status, obj) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj),
});

const refuse = (code, reason, extra) => json(200, { ok: false, code, reason, ...(extra || {}) });

const lowerHeaders = (h) => {
  const out = {};
  for (const k in (h || {})) out[k.toLowerCase()] = h[k];
  return out;
};

function e164(raw) {
  const clean = String(raw || '').trim().replace(/[^+\d]/g, '');
  return /^\+\d{10,15}$/.test(clean) ? clean : null;
}

/**
 * US ten digit input in any shape a person types, out as +1XXXXXXXXXX.
 * Structure is checked here (N is 2 to 9, no N11), geography is checked by the
 * area code table, and reachability is checked by Twilio Lookup. Three separate
 * questions, three separate answers, none of them assumed from another.
 */
function normalizeUs(raw) {
  const digits = String(raw || '').replace(/\D+/g, '');
  let ten = null;
  if (digits.length === 10) ten = digits;
  else if (digits.length === 11 && digits[0] === '1') ten = digits.slice(1);
  if (!ten) return { ok: false, reason: 'We can only call a ten digit US number right now.' };
  if (!/^[2-9][0-8]\d[2-9]\d{6}$/.test(ten)) return { ok: false, reason: 'That does not look like a working US number.' };
  if (/^\d{3}[2-9]11/.test(ten)) return { ok: false, reason: 'That does not look like a working US number.' };
  return { ok: true, phone: '+1' + ten, area: ten.slice(0, 3) };
}

// ── the blob store. One store, "consent", and it fails LOUD ──────────────────
// Keys:
//   record/<phoneHash>/<epoch>-<rand>   the consent event. Append only.
//   last/<phoneHash>                    the 24 hour gate, with an arbitration nonce
//   session/<sessionHash>               the 24 hour session gate
//   stop/<phoneHash>                    permanent suppression, written by any stop
//   attempt/<date>/<epoch>-<rand>       every attempt, refusals included
//   count/<date>                        approximate daily ceiling counter
//   token/<token>                       one time capability for the TwiML webhook
//   bysid/<CallSid>                     the same token, found by call sid
//   health/probe                        written by /api/demo-health's outbound check
async function openStore(event) {
  const blobs = await import('@netlify/blobs');
  if (typeof blobs.connectLambda === 'function') {
    try { blobs.connectLambda(event); } catch (e) { /* the first read or write is the verdict */ }
  }
  return blobs.getStore('consent');
}

const HOURS_24 = 24 * 60 * 60 * 1000;
// How long a bare RESERVATION holds a number. Long enough to arbitrate a real double click, short
// enough that a reservation whose dial never happened does not cost somebody their whole day. The
// 24 hour cap applies only to a call that was actually placed.
const RESERVATION_GRACE_MS = 90 * 1000;

async function logAttempt(store, row) {
  const key = `attempt/${day(new Date())}/${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  try { await store.setJSON(key, row); } catch (e) {
    // A dial that happened and was not logged is worse than a dial refused, so
    // this shouts. It never changes the verdict: the verdict is already decided.
    console.error('CALL-ME: attempt log write failed:', String(e && e.message).slice(0, 160));
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// THE API. POST places the call, GET publishes the sentence and the readiness.
// ═════════════════════════════════════════════════════════════════════════════
async function handleApi(event) {
  const headers = lowerHeaders(event.headers);

  if (event.httpMethod === 'GET') return handleGet(event);
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { Allow: 'GET, POST' }, body: 'Method not allowed' };
  }

  // ── 0. paused ──────────────────────────────────────────────────────────────
  if ((process.env.ANSWERED_CALLME_KILL || '').trim()) {
    console.error('CALL-ME: ANSWERED_CALLME_KILL is set; refusing every dial.');
    return refuse('paused', 'Setup calls are paused right now. Call the demo line instead.');
  }

  // ── 1. shape ───────────────────────────────────────────────────────────────
  // Same origin only. This does not stop curl, and it is not pretending to:
  // it stops a browser on another site from spending our dials for us.
  const origin = String(headers.origin || '');
  if (origin) {
    let oh = '';
    try { oh = new URL(origin).host; } catch (e) { oh = 'unparseable'; }
    if (oh !== String(headers.host || '')) {
      return refuse('bad_origin', 'That request did not come from our site.');
    }
  }
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  if (raw.length > 8000) return refuse('too_big', 'That request was too large to read.');
  let body;
  try { body = JSON.parse(raw || '{}'); } catch (e) { return refuse('bad_json', 'We could not read that request.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return refuse('bad_json', 'We could not read that request.');
  }
  if (body['bot-field']) {
    // A filled honeypot is a bot. It is refused with the same words a person
    // would see, because telling a bot which check caught it teaches the next one.
    return refuse('unavailable', 'We could not set that call up right now.');
  }

  const track = String(body.track == null ? '' : body.track).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  const ua = String(headers['user-agent'] || '').slice(0, 400);
  const ip = String(headers['x-nf-client-connection-ip'] || headers['client-ip'] || headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ipHash = ip ? sha(ip) : '';
  // THE SESSION IS DERIVED SERVER SIDE. A session id posted by the client is a
  // number the client chooses, so it is not a control at all: clearing it is a
  // page refresh. The connecting IP plus the user agent is the only session
  // identity this endpoint can actually hold somebody to.
  const sessionHash = sha(`${ipHash}|${ua}`);
  const page = String(headers.referer || '').slice(0, 300);

  let store;
  try {
    store = await openStore(event);
  } catch (e) {
    // NO CONSENT RECORD, NO DIAL. This is the whole rule, and it is why a store
    // that will not open refuses instead of dialling on a promise to log later.
    console.error('CALL-ME DOWN: consent store would not open:', String(e && e.message).slice(0, 160));
    return refuse('store_open', 'We could not open the consent store. Nothing was set up. (ref: store-open)');
  }

  // ── the stop action. Suppression is permanent and it is written first ──────
  if (body.stop === true) {
    const s = normalizeUs(body.phone);
    if (!s.ok) return refuse('bad_number', s.reason);
    const h = sha(s.phone);
    try {
      await store.setJSON(`stop/${h}`, { at: nowIso(), source: 'website', phone_last4: s.phone.slice(-4) });
    } catch (e) {
      console.error('CALL-ME: suppression write failed:', String(e && e.message).slice(0, 160));
      return refuse('store_down', 'We could not record that right now. Please email info@reddenda.com.');
    }
    await logAttempt(store, { at: nowIso(), outcome: 'stop', phone_sha256: h, ip_sha256: ipHash, ua, track });
    return json(200, { ok: true, code: 'stopped', reason: 'Done. We will not call that number.' });
  }

  // ── 2. consent ─────────────────────────────────────────────────────────────
  // The flag and the sentence are two separate facts and both are required. A
  // true flag with drifted text means the page is showing words we cannot
  // stand behind, and that is exactly the state worth failing on.
  if (body.consent !== true) {
    return refuse('no_consent', 'Please check the box that says we can call you.');
  }
  const given = String(body.consent_text == null ? '' : body.consent_text).replace(/\s+/g, ' ').trim();
  if (given !== CONSENT_TEXT) {
    console.error('CALL-ME: consent sentence mismatch. The page and the server disagree on the wording.');
    return refuse('consent_text_mismatch', 'We could not set that call up right now. Please try again in a minute.');
  }

  // ── 3. the number ──────────────────────────────────────────────────────────
  const n = normalizeUs(body.phone);
  if (!n.ok) return refuse('bad_number', n.reason);
  const phone = n.phone;
  const phoneHash = sha(phone);
  const zones = AREA_ZONES[n.area];
  if (!zones) {
    return refuse('unknown_area', 'We could not tell what time it is where that number lives, so we did not call.');
  }

  const deny = async (code, reason, extra) => {
    await logAttempt(store, {
      at: nowIso(), outcome: 'refused', code, phone_sha256: phoneHash, phone_last4: phone.slice(-4),
      area: n.area, ip_sha256: ipHash, session_sha256: sessionHash, ua, track, page,
    });
    return refuse(code, reason, extra);
  };

  // ── 4. suppression ─────────────────────────────────────────────────────────
  try {
    const stopped = await store.get(`stop/${phoneHash}`, { type: 'json' });
    if (stopped) return deny('suppressed', 'That number asked us to stop, so we will not call it.');
  } catch (e) {
    console.error('CALL-ME: suppression read failed:', String(e && e.message).slice(0, 160));
    return deny('store_stop_read', 'We could not check the do-not-call list, so we did not place a call. (ref: stop-read)');
  }

  // ── 5. one per session — REMOVED 2026-08-16 on David's instruction ─────────
  //
  // This blocked a BROWSER for 24 hours after one request. David, verbatim: "What if they want to
  // show their co-worker and get verification that it's cool, or their wife? I don't think we should
  // gate this until we have a lot of people signed up, so just remove the gate on it."
  //
  // He is right, and the gate was worse than tight: it protected nobody. A per-browser limit does
  // not protect the person being CALLED, which is the only party who needs protecting here. It only
  // stopped the person sitting at the keyboard from demonstrating the product, which is the single
  // thing we most want them to do right now. Somebody wanting to show a colleague is the best
  // outcome this page has, and we were refusing it.
  //
  // It is gone, not loosened. The session key is still WRITTEN below, because the arbitration nonce
  // uses it to settle two simultaneous clicks, but nothing reads it as a limit any more.
  //
  // ★ WHAT STILL PROTECTS THE CALLEE, and must not be removed with it: the per-NUMBER limit below
  // (loosened, not deleted) and the global daily ceiling. Those exist because the person whose phone
  // rings did not necessarily type their own number in, and an unlimited dialer pointed at a
  // stranger is harassment with our caller ID on it.

  // ── 6. one per number, 24 hours ────────────────────────────────────────────
  let lastRec;
  try {
    lastRec = await store.get(`last/${phoneHash}`, { type: 'json' });
  } catch (e) {
    console.error('CALL-ME: rate read failed:', String(e && e.message).slice(0, 160));
    return deny('store_rate_read', 'We could not check the recent calls for this number, so we did not place one. (ref: rate-read)');
  }
  // ★ THE CAP COUNTS CALLS THAT HAPPENED, NOT RESERVATIONS THAT DID NOT, 2026-08-16.
  //
  // The reservation two hundred lines below writes this same key with outcome 'reserved' BEFORE the
  // dial, so that a second click can be arbitrated. When the dial then did not happen, for any
  // reason, the number was left holding a `last/` record and this gate locked it out for a full DAY
  // for a call nobody ever received. That is what happened to the first real hero click: the
  // arbitration read failed on eventual consistency, no call was placed, and the number was still
  // burned for 24 hours.
  //
  // A reservation is evidence that a request STARTED, not that a phone rang. It gets a short grace
  // window, long enough to arbitrate a genuine double click and nowhere near long enough to punish
  // somebody for our own failure. Only 'placed' earns the 24 hours.
  // ★ A FEW PER DAY, NOT ONE. David 2026-08-16: "I like the idea of not letting people do it over
  // and over again, but I would say we should let them do it a few times."
  //
  // One a day was a demo killer. A person tries it, it works, they want to show somebody, and we
  // refuse them for a day. The limit now counts PLACED calls in a rolling 24 hours and allows
  // several, which covers showing a colleague and a spouse and still stops a number being dialled
  // fifty times by somebody who does not own it.
  const lastAt = lastRec && Date.parse(lastRec.at || '');
  const placed = lastRec && lastRec.outcome === 'placed';
  const perNumber = Math.max(1, Number(process.env.ANSWERED_CALLME_PER_NUMBER_DAY || 5));
  const recent = Array.isArray(lastRec && lastRec.placed_at)
    ? lastRec.placed_at.filter((t) => Number.isFinite(Date.parse(t)) && Date.now() - Date.parse(t) < HOURS_24)
    : (placed && Number.isFinite(lastAt) && Date.now() - lastAt < HOURS_24 ? [lastRec.at] : []);

  if (recent.length >= perNumber) {
    const oldest = Math.min(...recent.map((t) => Date.parse(t)));
    const wait = Math.ceil((HOURS_24 - (Date.now() - oldest)) / 1000);
    return deny('called_today', `We have already called that number ${recent.length} times today. That is the ceiling we hold ourselves to.`, { retry_after_seconds: wait });
  }
  // A bare RESERVATION still gets its short grace, so two clicks in the same breath are arbitrated
  // and a reservation whose dial never happened costs 90 seconds rather than a day.
  if (!placed && Number.isFinite(lastAt) && Date.now() - lastAt < RESERVATION_GRACE_MS) {
    const wait = Math.ceil((RESERVATION_GRACE_MS - (Date.now() - lastAt)) / 1000);
    return deny('in_flight', 'We are already setting up a call to that number. Give it a moment, and try again if nothing arrives.', { retry_after_seconds: wait });
  }

  // ── 7. daily ceiling ───────────────────────────────────────────────────────
  // An approximate ceiling on spend and blast radius, not a measurement. Two
  // requests in the same instant can both read the same count, so this is
  // never reported as a number of calls placed. It is only ever a brake.
  const cap = Number(process.env.ANSWERED_CALLME_DAILY_CAP || 50);
  const countKey = `count/${day(new Date())}`;
  let count = 0;
  try {
    const c = await store.get(countKey, { type: 'json' });
    count = Number(c && c.n) || 0;
  } catch (e) {
    console.error('CALL-ME: daily count read failed:', String(e && e.message).slice(0, 160));
    return deny('store_count_read', 'We could not read the call count for today, so we did not place a call. (ref: count-read)');
  }
  if (count >= cap) {
    console.error(`CALL-ME: daily ceiling reached (${count} of ${cap}); refusing until tomorrow.`);
    return deny('daily_cap', 'We have hit our limit of setup calls for today. Call the demo line any time.');
  }

  // ── 8. the clock. NOT A GATE ON THIS PATH. ─────────────────────────────────
  //
  // ★ REMOVED AS A REFUSAL 2026-08-16, ON DAVID'S INSTRUCTION AND ON THE LAW.
  //
  // This used to refuse outside 08:00-21:00 local and tell the person to come back in the morning.
  // A business owner who is awake at midnight, has just typed their own number in, and pressed a
  // button that says call me now, is the single most motivated person who will ever touch this
  // product. Turning them away is not caution, it is refusing money from somebody standing at the
  // till. Trade contractors keep exactly these hours: the 2am burst-pipe story is on our own
  // homepage, and we were closed for it.
  //
  // ── WHY THIS IS LAWFUL, AND WHY IT DOES NOT GENERALISE ──────────────────────
  //
  // TCPA quiet hours (47 CFR 64.1200(c)(1)) restrict TELEPHONE SOLICITATIONS to 8am-9pm local. A
  // telephone solicitation is defined at 64.1200(f)(15) and it EXPRESSLY EXCLUDES a call made to a
  // person "with that person's prior express invitation or permission."
  //
  // This call is the textbook case of that exclusion, on four counts, all of which are properties of
  // THIS path and not of calling in general:
  //   1. The called party typed their own number. We did not source it.
  //   2. They ticked a consent box whose text is served from the server and recorded verbatim, and
  //      which says in terms that we may call that number now with an AI voice.
  //   3. It is a call to THEMSELVES, not to a third party.
  //   4. It is dialled inline, in the same request, seconds after the invitation. Nothing queues,
  //      so the permission cannot go stale between the asking and the ringing. If a future change
  //      ever puts a queue between consent and dial, THIS EXEMPTION WEAKENS AND THIS COMMENT IS THE
  //      thing to re-read.
  //
  // ── WHAT DID NOT CHANGE, AND MUST NOT ──────────────────────────────────────
  //
  // ★ COLD OUTBOUND STILL HAS ITS CALLING WINDOW AND IT IS NOT NEGOTIABLE. That path lives in
  // lib/hours.mjs and dials people who never asked us for anything, which IS solicitation, so 8-9
  // local plus the FDCPA windows still bind there. The two gates were always separate functions;
  // this edit touches only the one on the path where the person is calling us to themselves.
  // Every other gate on this path is untouched: suppression, one-per-number, one-per-session, the
  // daily ceiling, consent recorded before the dial, and the do-not-call check.
  //
  // The local time is still COMPUTED, because knowing it is useful and because a future reader
  // deserves to see that the removal was a decision rather than an oversight. It is telemetry now.
  const at = new Date();
  const win = insideWindow(zones, at);
  if (!win.ok) {
    console.log(`CALL-ME: dialling at ${win.minutes != null ? Math.floor(win.minutes / 60) : '?'}:00 local `
      + `(${win.tz || 'unknown zone'}), outside 8-21. Proceeding: this is a callback the person `
      + 'requested seconds ago, which is not a telephone solicitation.');
  }

  // ── 9. configured ──────────────────────────────────────────────────────────
  const cfg = outboundConfig();
  if (!cfg.ok) {
    console.error('CALL-ME NOT CONFIGURED:', cfg.reason);
    return deny('not_configured', 'Our setup line is not switched on right now. Call the demo line and we will do it live.');
  }
  if (phone === cfg.from) {
    return deny('self_call', 'That is our own number. Try the number you want us to call you on.');
  }

  // ── 10. line health ────────────────────────────────────────────────────────
  if (!(await elHealthy())) {
    console.error('CALL-ME: ElevenLabs is unhealthy or unreachable; refusing to dial into a voice that cannot speak.');
    return deny('voice_down', 'Our setup voice is down right now, so we did not call. Please try again later.');
  }

  // ── 11. line type ──────────────────────────────────────────────────────────
  const look = await lookupLine(phone);
  if (!look.landed) {
    return deny('lookup_failed', 'We could not check that number, so we did not call. Please try again in a minute.');
  }
  if (look.valid !== true) {
    return deny('bad_number', 'That number does not look like a working number.');
  }
  if (look.country && !['US', 'PR', 'VI'].includes(look.country)) {
    return deny('not_us', 'We can only call US numbers right now.');
  }
  if (look.lineType === 'landline') {
    return deny('landline', 'That is a landline, and we only place setup calls to a mobile. Call the demo line from any phone instead.');
  }
  if (look.lineType !== 'mobile') {
    return deny('not_mobile', 'We can only place setup calls to a mobile number. Call the demo line from any phone instead.');
  }

  // ── 12. THE RECORD, before the dial ────────────────────────────────────────
  const recordKey = `record/${phoneHash}/${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const consentRecord = {
    at: nowIso(),
    scope: 'one setup call, requested now',        // never a blanket marketing consent
    method: 'checkbox on answered.reddenda.com',
    consent_version: CONSENT_VERSION,
    consent_text: CONSENT_TEXT,                     // the exact sentence shown
    phone_sha256: phoneHash,
    phone_last4: phone.slice(-4),
    area: n.area,
    ip_sha256: ipHash,                              // the raw IP is never stored
    ua,
    page,
    track,
    session_sha256: sessionHash,
    line_type: look.lineType,
    carrier: look.carrier || null,
    call_sid: null,                                 // filled in below once Twilio answers
  };
  try {
    await store.setJSON(recordKey, consentRecord);
  } catch (e) {
    console.error('CALL-ME DOWN: consent record write failed, so no call is placed:', String(e && e.message).slice(0, 160));
    return deny('store_record_write', 'We could not write your consent record, so no call was placed. (ref: record-write)');
  }

  // ── 12b. TELL THE DIAL GATE, or the person who just said yes stays RED ──────
  // Measured seam (@ANSWERED-RESEARCH, 2026-08-14): this function wrote consent
  // to Blobs while the outbound gate reads public.consent in Postgres, so the
  // one person in the corpus who explicitly asked to be called was still
  // classified "mobile, no consent on file" and refused. Both halves worked;
  // the seam between them was never asserted on, and the refusal looked exactly
  // like correct compliance behaviour.
  //
  // The blob record stays the legal artifact (it holds the exact sentence and
  // the version). This grant is the OPERATIONAL twin so another system can act
  // on it. sv_grant_consent refuses outright for any number ever suppressed, so
  // a web form can never overturn a spoken stop: that rule lives in the
  // database, not in this file. Failure here is loud and NEVER blocks the call
  // the visitor asked for, because their consent is already recorded above.
  const dbUrl = (process.env.ANSWERED_DB_URL || '').replace(/\/+$/, '');
  const dbAnon = process.env.ANSWERED_DB_ANON;
  const dbSecret = process.env.ANSWERED_DB_SECRET;
  if (dbUrl && dbAnon && dbSecret) {
    try {
      const gr = await fetch(dbUrl + '/rest/v1/rpc/sv_grant_consent', {
        method: 'POST',
        headers: {
          apikey: dbAnon,
          Authorization: 'Bearer ' + dbAnon,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          p_secret: dbSecret,
          p_phone: phone,
          p_source: 'one-click activation',
          p_written: true,
          p_scope: 'research_call',
          p_evidence: {
            consent_text: CONSENT_TEXT,
            consent_version: CONSENT_VERSION,
            page,
            track,
            record_key: recordKey,
          },
        }),
        signal: AbortSignal.timeout(2500),
      });
      if (!gr.ok) {
        console.error('CALL-ME: consent grant to the dial gate returned', gr.status, '(the call still proceeds; the blob record stands)');
      }
    } catch (e) {
      console.error('CALL-ME: consent grant to the dial gate failed:', String(e && e.message).slice(0, 160), '(the call still proceeds)');
    }
  } else {
    console.error('CALL-ME: ANSWERED_DB_* not set, so the dial gate will not see this consent. The blob record stands.');
  }

  // Reserve the number and the session BEFORE dialling, and arbitrate the race.
  // Blobs has no lock, so two clicks in the same instant both write and then
  // both read back: only the writer whose nonce survived proceeds. The loser is
  // refused honestly. This is arbitration, not a mutex, and it is documented as
  // such: it makes a double dial very unlikely, it does not make it impossible.
  const nonce = crypto.randomUUID();
  try {
    await store.setJSON(`last/${phoneHash}`, { at: nowIso(), nonce, record: recordKey, outcome: 'reserved' });
    await store.setJSON(`session/${sessionHash}`, { at: nowIso(), nonce });
  } catch (e) {
    console.error('CALL-ME: reservation write failed:', String(e && e.message).slice(0, 160));
    return deny('store_reservation_write', 'We could not reserve this number, so no call was placed. (ref: reservation-write)');
  }
  await sleep(150);
  try {
    // ★ STRONGLY CONSISTENT, AND THIS IS THE WHOLE BUG, 2026-08-16.
    //
    // Netlify Blobs is EVENTUALLY consistent by default. This read happens 150ms after the write
    // above, so on a first click with no competing request the read came back stale or empty, the
    // nonce did not match, and the request was refused as if it had lost a race it was never in.
    // The dial below never ran. David clicked the hero button once and got "that call is already
    // on its way" for a call that was never placed.
    //
    // The arbitration logic was right. The read was lying to it. answered-canary.mjs already reads
    // its own write with { consistency: 'strong' } for exactly this reason; this file used it in
    // zero of ten reads.
    //
    // ★ A RACE ARBITRATOR THAT READS EVENTUALLY-CONSISTENT STORAGE DOES NOT ARBITRATE A RACE. It
    // reports one at random, and the failure is invisible in every test that writes and reads in
    // separate requests.
    const back = await store.get(`last/${phoneHash}`, { type: 'json', consistency: 'strong' });
    if (!back || back.nonce !== nonce) {
      // ★ AND THE MESSAGE MUST NOT CLAIM A CALL IS COMING. Nothing has been dialled at this point.
      // The old wording ("already on its way") plus the old code (`called_today`, which this is not,
      // it is the race-loser path) told the caller a call was on the way when none existed, which is
      // the one thing this product must never do. If a genuine second click loses the race, the
      // FIRST click's call really is coming, so the honest sentence covers both readings without
      // promising anything this request caused.
      return deny('race_lost', 'Another request for this number is being handled right now. If no call arrives in a minute, try again.');
    }
  } catch (e) {
    // ★ THE ARBITRATION IS THE ONE CHECK HERE THAT FAILS OPEN, and that is deliberate.
    //
    // Every other store failure above refuses, correctly: without the suppression list we might call
    // somebody who asked us to stop, and without the rate record we might call somebody twenty times.
    // Those are refusals that protect a person.
    //
    // This one protects nothing except against a double dial, and by the time we reach it the
    // reservation has ALREADY been written successfully. We hold the nonce. The only thing this read
    // adds is knowing whether somebody else clicked in the same 150ms. A strongly-consistent read is
    // slower than a default one and can time out under load, so making the whole call depend on it
    // trades a rare double dial for a certain, total outage of the button, which is exactly what
    // David has been hitting all evening.
    //
    // So: log it loudly, and proceed. The worst case is one extra call to a number whose owner just
    // asked to be called twice. The alternative failure mode is nobody ever gets called at all.
    console.error('CALL-ME: reservation read back failed, PROCEEDING on the nonce we already wrote:', String(e && e.message).slice(0, 160));
  }

  // ── 13. the dial ───────────────────────────────────────────────────────────
  // A capability token, not a guessable URL. Twilio is handed a one time link
  // and the TwiML endpoint refuses anything else, so the webhook is not open to
  // anyone who has read our AccountSid off a support thread.
  const token = crypto.randomBytes(24).toString('hex');
  try {
    await store.setJSON(`token/${token}`, {
      at: nowIso(), phone_sha256: phoneHash, phone_last4: phone.slice(-4), record: recordKey, call_sid: null,
    });
  } catch (e) {
    console.error('CALL-ME: token write failed:', String(e && e.message).slice(0, 160));
    return deny('store_token_write', 'We could not create the call token, so no call was placed. (ref: token-write)');
  }

  // The kill switch is asserted a second time, here, at the moment of the dial.
  // Every other gate above is a decision about this request; this one is a
  // decision about the whole system, and it is the last thing that runs.
  if ((process.env.ANSWERED_CALLME_KILL || '').trim()) {
    console.error('CALL-ME: kill switch set between the gates and the dial; not dialling.');
    return deny('paused', 'Setup calls are paused right now. Call the demo line instead.');
  }

  const base = siteBase(event);
  let call;
  try {
    call = await createCall({
      To: phone,
      From: cfg.from,
      Url: `${base}/api/call-me/twiml?t=${token}`,
      Method: 'POST',
      // FIVE MINUTES, HARD. A setup conversation that has not finished in five
      // minutes needs a person, not more minutes of an AI voice.
      TimeLimit: 300,
      Timeout: 30,
      // NO RETRIES, EVER. Twilio does not retry on its own, and nothing in this
      // file re-dials: the 24 hour key above is written BEFORE the dial and is
      // never cleared on failure. A failed call costs one missed conversation.
      // A retry loop costs a person their afternoon.
      MachineDetection: 'DetectMessageEnd',
      MachineDetectionTimeout: 12,
      AsyncAmd: 'false',
      Record: 'false',
      StatusCallback: `${base}/api/call-me/status?t=${token}`,
      StatusCallbackEvent: ['completed'],
      StatusCallbackMethod: 'POST',
    });
  } catch (e) {
    const msg = String(e && e.message).slice(0, 200);
    console.error('CALL-ME: the dial failed:', msg);
    await logAttempt(store, {
      at: nowIso(), outcome: 'dial_failed', code: 'dial_failed', error: msg,
      phone_sha256: phoneHash, phone_last4: phone.slice(-4), area: n.area,
      ip_sha256: ipHash, session_sha256: sessionHash, ua, track, page, record: recordKey,
    });
    // The 24 hour reservation stays. See above: no retries, ever.
    return refuse('dial_failed', 'We could not place that call just now. Call the demo line and we will do it live.');
  }

  // Bind the record, the token and the call together, all three ways round, so
  // a complaint can be answered from any one of them.
  const bind = async () => {
    consentRecord.call_sid = call.sid;
    await store.setJSON(recordKey, consentRecord);
    await store.setJSON(`token/${token}`, {
      at: nowIso(), phone_sha256: phoneHash, phone_last4: phone.slice(-4), record: recordKey, call_sid: call.sid,
    });
    await store.setJSON(`bysid/${call.sid}`, { token, record: recordKey, phone_sha256: phoneHash });
    // ★ CARRY THE PLACED-CALL TIMESTAMPS FORWARD. The per-number ceiling counts calls that actually
    // happened inside a rolling 24 hours, so this list is the only thing that makes it work. Without
    // it every write would reset the count to one and the ceiling would never be reached. Trimmed to
    // the window on write so the record cannot grow without bound.
    const prior = Array.isArray(lastRec && lastRec.placed_at) ? lastRec.placed_at : (lastRec && lastRec.outcome === 'placed' && lastRec.at ? [lastRec.at] : []);
    const placedAt = [...prior, nowIso()]
      .filter((t) => Number.isFinite(Date.parse(t)) && Date.now() - Date.parse(t) < HOURS_24)
      .slice(-20);
    await store.setJSON(`last/${phoneHash}`, { at: nowIso(), nonce, record: recordKey, outcome: 'placed', call_sid: call.sid, placed_at: placedAt });
    await store.setJSON(countKey, { n: count + 1, at: nowIso() });
  };
  try { await bind(); } catch (e) {
    // The phone is already ringing. This is a logging failure, and it is loud,
    // but it can never turn a placed call into a reported failure.
    console.error('CALL-ME: post dial binding failed (the call IS placed):', String(e && e.message).slice(0, 160));
  }

  // ── WARM THE BRAIN, because we know a conversation is about to start ───────
  //
  // ★ MEASURED 2026-08-16 through the live endpoint: 7.89s COLD, 1.90s warm. That eight seconds is
  // not spread across a call, it lands entirely on the FIRST turn, which is the first thing a new
  // customer ever hears: silence. Inside a call the container stays warm because ElevenLabs hits it
  // every turn, so the cold start hits precisely the moment that matters most and never shows up
  // again for the rest of the conversation.
  //
  // ★ WHY HERE AND NOT A SCHEDULED FUNCTION. A cron keep-warm burns invocations around the clock to
  // catch a handful of calls, and this estate has already measured that frequent deploys starve
  // low-frequency scheduled functions to the point of never running. Here we have something a cron
  // never has: certain knowledge that a conversation begins in about ten seconds, because we just
  // dialled it. The ring gives us the warm-up window for free.
  //
  // ★ IT IS FIRE AND FORGET, AND MUST STAY THAT WAY. The phone is already ringing. Nothing below
  // this line may delay, fail, or alter a call that is already placed, so there is no await on the
  // response and every outcome is swallowed. {"describe":true} returns the persona registry without
  // spending a single model token, so warming costs nothing but the container.
  try {
    const brainSecret = (process.env.ANSWERED_BRAIN_SECRET || '').trim();
    if (brainSecret) {
      const warmUrl = `${base}/api/answered-brain/onboard`;
      fetch(warmUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${brainSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ describe: true }),
        signal: AbortSignal.timeout(4000),
      }).catch(() => { /* a cold brain is slow, never broken; this is an optimisation only */ });
    }
  } catch (e) { /* unreachable in practice, and still not allowed to matter */ }

  await logAttempt(store, {
    at: nowIso(), outcome: 'placed', call_sid: call.sid, status: call.status,
    phone_sha256: phoneHash, phone_last4: phone.slice(-4), area: n.area,
    ip_sha256: ipHash, session_sha256: sessionHash, ua, track, page, record: recordKey,
  });

  return json(200, {
    ok: true,
    code: 'calling',
    reason: 'Calling you now. Pick up and we will get you set up.',
  });
}

// ── can this line ACTUALLY place a call, or are the keys merely present? ─────
//
// ★ THIS EXISTS BECAUSE `ready` WAS A LIE AND THE HERO IS BUILT ON IT.
//
// outboundConfig() checks that env vars are SET. That is a configuration check, and it was being
// reported to the page as `ready: true — "The setup line is up."` while Twilio returned 401 to
// every request on this account, including a plain account read. Measured 2026-08-15.
//
// A visitor would have typed their number, ticked a legal consent box, watched a button say
// "Calling you now", and no phone would ever have rung. On this estate the rule is that A CONTROL
// WHICH CANNOT ACT MUST NOT RENDER, and a hero CTA promising a call it cannot place is the worst
// version of breaking it, because the visitor has already given us their number and their consent.
//
// PRESENCE OF A CREDENTIAL IS NOT THE ABILITY TO USE IT. So this asks the provider.
//
// It is CACHED and it BACKS OFF, because a vendor fetch per page view is a self-inflicted outage —
// this repo took its whole site down today with exactly that shape in an edge function, where a
// per-request health call blew the execution budget and every page returned 500.
//
// And the 401 sentence is deliberately careful: Twilio returns the SAME 401 for an unfunded or
// suspended account as for a wrong key, so this reports what is observed and refuses to diagnose
// which. Naming the wrong cause sends someone to rotate a key that was never broken.
const CALL_READY_TTL_MS = 120_000;
const CALL_READY_DOWN_BACKOFF_MS = 15 * 60_000;
let callReadyCache = { at: 0, value: null };

async function callReadiness({ maxAgeMs = CALL_READY_TTL_MS, event } = {}) {
  const cfg = outboundConfig();
  if (!cfg.ok) {
    // A configuration failure is certain and free. Never spend a vendor round trip to confirm it.
    return { ok: false, state: 'unconfigured', why: 'The setup line is not switched on right now.', detail: cfg.reason };
  }

  // ★ THE SHARED BREAKER OUTRANKS THIS FUNCTION'S OWN OPINION.
  //
  // Other surfaces latch `provider-down` when the carrier hard-refuses, and they were latched while
  // this endpoint kept answering ready:true. Publishing the more optimistic of two instruments is
  // how a hero comes to paint a control over a dead line. If anything on this estate has seen a
  // hard refusal inside the window, this says so too.
  // ★ EVIDENCE BEATS MEMORY, AND THE FIRST VERSION OF THIS HAD IT BACKWARDS.
  //
  // The breaker was consulted and allowed to END the check. That is right for avoiding a pointless
  // round trip while a provider is genuinely down, and it is wrong the moment the provider comes
  // back: a latch that never re-tests turns a recovery into a prolonged outage of the honest
  // signal. Measured today. The credentials were replaced with working ones, Lookup started
  // returning 200 to a direct call, and this endpoint went on reporting provider_unavailable
  // because it asked the memory and never let the evidence update it.
  //
  // So a latched breaker now costs one probe rather than short-circuiting. If the probe SUCCEEDS,
  // the marker is cleared and every other surface reading that breaker recovers with it. If it
  // fails, the latch stands and nothing is lost but one request.
  //
  // The asymmetry is deliberate: a breaker exists to stop hammering a dead provider, and one probe
  // per cache window is not hammering. What it buys is that recovery is automatic instead of
  // waiting out a window that has nothing to do with the provider's actual state.
  let wasLatched = false;
  try {
    const down = await providerIsDown('twilio', event);
    if (down) wasLatched = down;
  } catch (e) { /* a breaker we cannot read is not a green light, but it is not a red one either */ }

  const ttl = (callReadyCache.value && callReadyCache.value.state === 'provider_unavailable')
    ? CALL_READY_DOWN_BACKOFF_MS : maxAgeMs;
  if (callReadyCache.value && Date.now() - callReadyCache.at < ttl) return callReadyCache.value;

  const sid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  let value;
  try {
    // ★ PROBE THE CAPABILITY THE FLOW ACTUALLY USES, NOT A NEIGHBOURING ONE.
    //
    // This read an ACCOUNT, which proves the credentials authenticate and proves nothing about the
    // dial path. Gate 11 calls Lookup, and Lookup was returning 401 while the account read returned
    // 200, so this reported "the setup line is up" while every real number would have been refused
    // with lookup_failed. The form was painted over a line that could not complete a call, which is
    // the exact rule it was written to uphold.
    //
    // Measured on the live site: a valid number came back "We could not check that number, so we
    // did not call." That is indistinguishable from a fictional number being correctly rejected,
    // which is why it was misread for an hour.
    //
    // Lookup on the site's OWN number: a real request against the real API, on a number we already
    // publish, so it costs nothing private and answers the only question that matters.
    const probeNumber = (process.env.ANSWERED_DEMO_NUMBER || '').trim();
    const r = probeNumber
      ? await fetch(`https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(probeNumber)}`, {
          headers: { Authorization: twilioAuthHeader() },
          signal: AbortSignal.timeout(5000),
        })
      : await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
          headers: { Authorization: twilioAuthHeader() },
          signal: AbortSignal.timeout(5000),
        });
    if (r.status === 401 || r.status === 403) {
      value = { ok: false, state: 'provider_unavailable',
        why: 'The setup line cannot place calls right now.',
        detail: 'Twilio is rejecting every request on this account, including a plain account read. '
              + 'Twilio returns the same error for a suspended or unfunded account as for a bad key, '
              + 'so this does not say which. Check the account balance and status first, then the key.' };
    } else if (!r.ok) {
      value = { ok: false, state: 'provider_unavailable',
        why: 'The setup line cannot place calls right now.',
        detail: 'Twilio answered ' + r.status + ' to a plain account read.' };
    } else {
      const j = await r.json().catch(() => ({}));
      // Only the ACCOUNT response carries a status field; a Lookup 200 is itself the proof.
      const status = probeNumber ? '' : String(j.status || '').toLowerCase();
      // An account can authenticate and still be suspended or closed, and a suspended account
      // cannot dial. Asking only "did the credential work" would pass one that cannot make a call.
      if (status && status !== 'active') {
        value = { ok: false, state: 'account_' + status,
          why: 'The setup line cannot place calls right now.',
          detail: 'The Twilio account authenticates but reads status "' + status + '".' };
      } else {
        value = { ok: true, state: 'live', why: 'The setup line is up.' };
        if (wasLatched) {
          // The provider answered. Clear the latch so every other surface reading this breaker
          // recovers too, rather than each one waiting out its own window.
          await providerMarkUp('twilio', event).catch(() => {});
          console.log('call-me: twilio answered a live probe while the breaker was latched ('
            + wasLatched.minutes + ' minutes); breaker cleared for every surface.');
        }
      }
    }
  } catch (e) {
    value = { ok: false, state: 'provider_unavailable',
      why: 'The setup line cannot place calls right now.',
      detail: 'Twilio did not answer a plain account read: ' + String((e && e.message) || e).slice(0, 120) };
  }
  callReadyCache = { at: Date.now(), value };
  return value;
}

/** GET: the sentence the page must render, and whether the line can take a call. */
async function handleGet(event) {
  const r = await callReadiness({ event });
  return json(200, {
    ok: true,
    consent_version: CONSENT_VERSION,
    consent_text: CONSENT_TEXT,
    // Measured against the provider, not inferred from the environment.
    ready: r.ok,
    state: r.state,
    reason: r.why,
    detail: r.detail || null,
  });
}

// ── configuration, read once, in one place ───────────────────────────────────
function outboundConfig() {
  const need = ['TWILIO_ACCOUNT_SID', 'TWILIO_API_SID', 'TWILIO_API_SECRET', 'ELEVENLABS_API_KEY'];
  const missing = need.filter((k) => !(process.env[k] || '').trim());
  const from = e164(process.env.ANSWERED_CALLME_FROM || process.env.ANSWERED_DEMO_NUMBER);
  const agent = (process.env.ANSWERED_ONBOARD_AGENT_ID || '').trim();
  const demoAgent = (process.env.ANSWERED_EL_AGENT_ID || '').trim();
  if (missing.length) return { ok: false, reason: 'env not set: ' + missing.join(', ') };
  if (!from) return { ok: false, reason: 'ANSWERED_DEMO_NUMBER is not E.164' };
  if (!agent) return { ok: false, reason: 'ANSWERED_ONBOARD_AGENT_ID is not set' };
  // The demo agent introduces herself as a fictional plumbing shop. If the two
  // ids are ever pointed at each other, a real customer gets that voice on a
  // real signup call, so this refuses rather than sounds plausible.
  if (demoAgent && agent === demoAgent) {
    return { ok: false, reason: 'ANSWERED_ONBOARD_AGENT_ID equals the demo agent id; the setup call would be answered by the demo persona' };
  }
  return { ok: true, from, agent };
}

const siteBase = (event) => {
  const h = lowerHeaders(event.headers);
  return (process.env.URL || (h.host ? `https://${h.host}` : 'https://answered.reddenda.com')).replace(/\/+$/, '');
};

// ── vendors ──────────────────────────────────────────────────────────────────
function twilioAuthHeader() {
  const sid = (process.env.TWILIO_API_SID || '').trim();
  const secret = (process.env.TWILIO_API_SECRET || '').trim();
  return 'Basic ' + Buffer.from(`${sid}:${secret}`).toString('base64');
}

async function createCall(params) {
  const account = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => form.append(k, String(x)));
    else form.set(k, String(v));
  }
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(account)}/Calls.json`, {
    method: 'POST',
    headers: { Authorization: twilioAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(10000),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch (e) { j = null; }
  if (!r.ok || !j || !j.sid) throw new Error(`twilio ${r.status}: ${(j && j.message) || text.slice(0, 160)}`);
  return j;
}

/**
 * Twilio Lookup v2 with line type intelligence. Reports landed separately from
 * the answer: a lookup that timed out is landed=false, and a lookup that never
 * landed has told us nothing at all, least of all that a number is safe to dial.
 */
async function lookupLine(phone) {
  try {
    const r = await fetch(
      `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(phone)}?Fields=line_type_intelligence`,
      { headers: { Authorization: twilioAuthHeader() }, signal: AbortSignal.timeout(6000) },
    );
    if (!r.ok) {
      console.error('CALL-ME: lookup returned', r.status);
      return { landed: false };
    }
    const j = await r.json();
    const lti = j.line_type_intelligence || {};
    if (lti.error_code) {
      console.error('CALL-ME: lookup carried error_code', lti.error_code);
      return { landed: false };
    }
    return {
      landed: true,
      valid: j.valid === true,
      country: j.country_code || null,
      lineType: lti.type || null,
      carrier: lti.carrier_name || null,
    };
  } catch (e) {
    console.error('CALL-ME: lookup failed:', String(e && e.message).slice(0, 160));
    return { landed: false };
  }
}

/** Fails CLOSED. An account that cannot speak must never be dialled into. */
async function elHealthy() {
  const key = (process.env.ELEVENLABS_API_KEY || '').trim();
  if (!key) return false;
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
      headers: { 'xi-api-key': key },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return false;
    const j = await r.json();
    if (j.status === 'past_due') return false;
    if (typeof j.character_count === 'number' && typeof j.character_limit === 'number' && j.character_count >= j.character_limit) return false;
    return true;
  } catch (e) {
    return false;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// THE TwiML WEBHOOK. What the person hears when they pick up.
// ═════════════════════════════════════════════════════════════════════════════
function tokenOf(event) {
  const q = event.queryStringParameters || {};
  if (q.t) return String(q.t);
  try { return new URL(event.rawUrl).searchParams.get('t') || ''; } catch (e) { return ''; }
}

async function handleTwiml(event) {
  const gate = authenticate(event, '/api/call-me/twiml');
  if (!gate.ok) return gate.reject;
  const p = gate.params;
  const callback = e164(process.env.ANSWERED_DEMO_NUMBER);

  // The capability token is the real authenticator here. The AccountSid check
  // inside authenticate() is an integrity cross check and nothing more, so a
  // request with no valid token is refused even though it came from Twilio.
  let store;
  let rec = null;
  const token = tokenOf(event);
  try {
    store = await openStore(event);
    // ★ STRONGLY CONSISTENT for the same reason as the arbitration read-back above. This token is
    // written moments before Twilio is asked to dial, and Twilio hits this webhook a second or two
    // later. An eventually-consistent read can miss a write that recent, and the failure is the
    // worst-looking one the product has: the phone rings, the caller says hello, and the TwiML
    // endpoint refuses because it cannot find a token that exists. Silence on a call the customer
    // asked for is worse than no call at all.
    if (token) rec = await store.get(`token/${token}`, { type: 'json', consistency: 'strong' });
    if (!rec && p.CallSid) {
      const bysid = await store.get(`bysid/${p.CallSid}`, { type: 'json', consistency: 'strong' });
      if (bysid && bysid.token) rec = await store.get(`token/${bysid.token}`, { type: 'json', consistency: 'strong' });
    }
  } catch (e) {
    console.error('CALL-ME TwiML: store read failed:', String(e && e.message).slice(0, 160));
    return XML(`<Response>${SAY(brokenLine(callback))}<Hangup/></Response>`);
  }
  if (!rec) {
    console.error('CALL-ME TwiML: no capability record for this request; refusing.');
    return { statusCode: 403, body: 'no token' };
  }
  const age = Date.now() - Date.parse(rec.at || '');
  if (!Number.isFinite(age) || age > 10 * 60 * 1000) {
    console.error('CALL-ME TwiML: capability token is stale; refusing.');
    return { statusCode: 403, body: 'stale token' };
  }
  if (rec.call_sid && p.CallSid && rec.call_sid !== p.CallSid) {
    console.error('CALL-ME TwiML: token presented for a different call sid; refusing.');
    return { statusCode: 403, body: 'wrong call' };
  }

  const answeredBy = String(p.AnsweredBy || 'unknown');

  // A voicemail gets one short honest message and nothing else. Talking over
  // somebody's outgoing greeting leaves half a sentence, which is worse than
  // silence, so only a detected end of greeting speaks.
  if (answeredBy.startsWith('machine')) {
    if (answeredBy === 'machine_end_beep' || answeredBy === 'machine_end_silence' || answeredBy === 'machine_end_other') {
      return XML(`<Response>${SAY(voicemailLine(callback))}<Hangup/></Response>`);
    }
    return XML('<Response><Hangup/></Response>');
  }
  if (answeredBy === 'fax') return XML('<Response><Hangup/></Response>');

  const cfg = outboundConfig();
  if (!cfg.ok) {
    console.error('CALL-ME TwiML: not configured at answer time:', cfg.reason);
    return XML(`<Response>${SAY(brokenLine(callback))}<Hangup/></Response>`);
  }
  // ★ THE elHealthy() PRE-FLIGHT WAS REMOVED FROM THIS PATH, 2026-08-16, after a real call.
  //
  // David's phone rang, he answered, and heard "our setup process failed on our end" in a stock
  // Twilio voice instead of his own. No ElevenLabs conversation was ever created. Both this check
  // and register-call below produce that identical sentence, so the message could not tell us which
  // one fired, and both the API key and register-call tested healthy minutes later.
  //
  // What this pre-check actually did was make TWO sequential vendor round-trips on the answer path,
  // each with a 5 second timeout, inside a webhook Netlify kills at 10 seconds and a human is
  // holding a silent phone through. It could spend five seconds discovering something register-call
  // would have told us for free, and its own transient failure spoke the apology on a call that
  // would otherwise have worked.
  //
  // ★ REGISTER-CALL IS THE HEALTH CHECK. It is the operation we actually need; if ElevenLabs is
  // down, out of quota, or past due, it fails and we speak the honest line then. A pre-flight that
  // can only ever agree with the real call, at the cost of doubling the latency and doubling the
  // chance of a spurious failure, is not a safety net. It is a second thing to go wrong.
  //
  // elHealthy() is still used by the health gate, where its cost is paid off the call path.

  try {
    const r = await fetch('https://api.elevenlabs.io/v1/convai/twilio/register-call', {
      method: 'POST',
      headers: { 'xi-api-key': (process.env.ELEVENLABS_API_KEY || '').trim(), 'Content-Type': 'application/json' },
      // A hung vendor must never become unbounded silence in somebody's ear.
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        agent_id: cfg.agent,
        from_number: p.From || cfg.from,
        to_number: p.To || '',
        direction: 'outbound',
      }),
    });
    const twiml = await r.text();
    if (!r.ok || !/<Response/i.test(twiml)) throw new Error(`register-call ${r.status}`);
    // THE DISCLOSURE IS OURS, NOT THE VENDOR'S. Every word after the bridge
    // comes out of a document we did not author, so the identification and the
    // AI disclosure go in front of it, where nothing can skip them.
    return XML(injectIntoResponse(twiml, SAY(disclosure(callback))));
  } catch (e) {
    console.error('CALL-ME TwiML: register-call failed:', String(e && e.message).slice(0, 160));
    return XML(`<Response>${SAY(brokenLine(callback))}<Hangup/></Response>`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// THE STATUS WEBHOOK. How the call ended, written next to why it was allowed.
// ═════════════════════════════════════════════════════════════════════════════
async function handleStatus(event) {
  const gate = authenticate(event, '/api/call-me/status');
  if (!gate.ok) return gate.reject;
  const p = gate.params;
  try {
    const store = await openStore(event);
    await logAttempt(store, {
      at: nowIso(),
      outcome: 'ended',
      call_sid: p.CallSid || null,
      status: p.CallStatus || null,
      duration_seconds: Number(p.CallDuration || 0) || 0,
      answered_by: p.AnsweredBy || null,
    });
    if (p.CallSid) {
      const bysid = await store.get(`bysid/${p.CallSid}`, { type: 'json' });
      if (bysid && bysid.record) {
        const rec = await store.get(bysid.record, { type: 'json' });
        if (rec) {
          rec.ended = { at: nowIso(), status: p.CallStatus || null, duration_seconds: Number(p.CallDuration || 0) || 0 };
          await store.setJSON(bysid.record, rec);
        }
      }
    }
  } catch (e) {
    console.error('CALL-ME status: could not record the outcome:', String(e && e.message).slice(0, 160));
  }
  // Twilio does not read this body; it only needs a 200 so it stops asking.
  return { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: 'ok' };
}

// ── the front door ───────────────────────────────────────────────────────────
function roleOf(event) {
  const q = event.queryStringParameters || {};
  let path = String(event.path || '');
  try { path = new URL(event.rawUrl).pathname || path; } catch (e) { /* event.path stands */ }
  const p = path.replace(/\/+$/, '');
  if (p.endsWith('/twiml') || q.twiml) return 'twiml';
  if (p.endsWith('/status') || q.status) return 'status';

  // FALLBACK, AND ONLY A FALLBACK. If a rewrite ever hands this function the
  // internal function path instead of the public one, a Twilio webhook would
  // fall through to the JSON API, get a JSON parse error back, and the person
  // who picked up would hear silence. So a form POST carrying an AccountSid
  // and a CallSid is recognised as Twilio by its shape as well as its path.
  const h = lowerHeaders(event.headers);
  if (event.httpMethod === 'POST' && String(h['content-type'] || '').includes('application/x-www-form-urlencoded')) {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
    if (/(^|&)AccountSid=AC/.test(raw) && /(^|&)CallSid=CA/.test(raw)) {
      const ended = /(^|&)CallDuration=/.test(raw)
        || /(^|&)CallStatus=(completed|busy|failed|no-answer|canceled)(&|$)/.test(raw);
      console.error('CALL-ME: a Twilio webhook arrived without its public path; routed by shape to ' + (ended ? 'status' : 'twiml') + '.');
      return ended ? 'status' : 'twiml';
    }
  }
  return 'api';
}

export const handler = async (event) => {
  const role = roleOf(event);
  try {
    if (role === 'twiml') return await handleTwiml(event);
    if (role === 'status') return await handleStatus(event);
    return await handleApi(event);
  } catch (e) {
    // Nothing reaches here that has not already been refused, but if it does,
    // it is refused honestly rather than answered with a cheerful 200.
    console.error('CALL-ME unhandled:', String(e && e.stack || e).slice(0, 400));
    if (role === 'twiml') {
      return XML(`<Response>${SAY(brokenLine(e164(process.env.ANSWERED_DEMO_NUMBER)))}<Hangup/></Response>`);
    }
    return json(500, { ok: false, code: 'error', reason: 'Something broke on our side. Please try again in a minute.' });
  }
};
