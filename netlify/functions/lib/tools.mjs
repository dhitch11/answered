// tools.mjs — what the voice is allowed to DO, as opposed to what it is allowed to say.
//
// Everything else in this codebase is a guard on language. This file is the first thing that lets a
// persona reach out and change the world mid call, so it is written to the opposite instinct from a
// prompt: nothing here trusts the model, and every field the model hands over is treated as a claim
// that has to survive a check before it becomes a row.
//
// ★ THE THREE THINGS THE MODEL IS NOT ALLOWED TO DECIDE, AND WHY EACH ONE IS A SERVER CONSTANT.
//   1. WHICH SHOP.  A language model that can name the business can book somebody else's job. The
//      demo line is Cedar Ridge Plumbing and Air, always, and the constant lives here, not in a
//      prompt where a caller could argue with it.
//   2. DEMO OR LIVE. `mode` is pinned to 'demo' for the demo line. A caller who says "make it real"
//      cannot promote a pretend booking into one somebody drives to.
//   3. WHAT TIME.  This is the important one. Riley has exactly three visit windows and they are
//      words, not timestamps. If the model were asked for an ISO instant it would invent one, and a
//      hallucinated date is not a typo: it is a van at the wrong house on the wrong day. So the tool
//      takes an ENUM of the three windows Riley is allowed to offer, and the SERVER does the
//      calendar arithmetic. The model cannot express a fourth window because the schema has no way
//      to say one.
//
// ★ THE PLACEHOLDER FLOOR IS NOT PARANOIA, IT IS THE MOST LIKELY FAILURE.
// The characteristic failure of a booking agent is not refusing to book. It is booking with
// "123 Main Street", "N/A", "the customer", or "unknown" in a slot the caller never filled, because
// the schema said the field was required and the model would rather satisfy a schema than admit a
// gap. Every one of those reads as a real booking downstream. So a value that looks invented is
// rejected the same way an empty one is, and the tool answers with the sentence that sends Riley
// back to ask for the missing thing instead of writing a lie down.
//
// No env reads, no network, no clock beyond the one it is handed. Everything here is testable
// without a phone.

import { e164 } from './booking.mjs';
import { createHash } from 'node:crypto';

export const BOOK_TOOL = 'book_job';

// ── the three windows, and nothing else ─────────────────────────────────────────────────────────
// These are the SAME three windows RILEY_SPEC offers, in the same words. personas.test.mjs asserts
// that: if somebody edits one and not the other, the voice would offer a time the tool cannot book.
export const WINDOWS = {
  tuesday_8am:   { day: 2, hour: 8,  minute: 0,  spoken: 'Tuesday at eight in the morning' },
  tuesday_130pm: { day: 2, hour: 13, minute: 30, spoken: 'Tuesday at one thirty in the afternoon' },
  wednesday_9am: { day: 3, hour: 9,  minute: 0,  spoken: 'Wednesday at nine in the morning' },
};
export const WINDOW_KEYS = Object.keys(WINDOWS);
export const SHOP_TZ = 'America/Los_Angeles';
export const DEMO_SHOP = 'Cedar Ridge Plumbing and Air';
export const VISIT_MINUTES = 60;

// A window that starts in the next half hour is not a window, it is a surprise. Anything closer
// than this rolls to the following week.
const MIN_LEAD_MS = 30 * 60 * 1000;

/** Minutes east of UTC for a zone at a given instant. Uses the platform's own tz database. */
function offsetMinutes(ts, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ts)).map((x) => [x.type, x.value]),
  );
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return (asUTC - ts) / 60000;
}

/**
 * The instant at which a given wall-clock time happens in a zone.
 *
 * ★ WHY THE LOOP, AND WHY IT IS VERIFIED RATHER THAN TRUSTED. Converting a wall clock to an instant
 * is a fixed point problem: you need the zone's offset to pick the instant, and you need the
 * instant to know the offset. One correction lands it in every normal case; two settles the hour
 * on either side of a DST change. But on the spring-forward morning some wall clocks DO NOT EXIST,
 * and no number of iterations conjures one. So the result is FORMATTED BACK and compared. A caller
 * of this function gets an instant that really is that clock time in that zone, or null. It never
 * gets a silent hour of drift, which is exactly what a van arriving at seven for an eight o'clock
 * job looks like from the inside.
 */
export function zonedInstant(y, m, d, hh, mm, tz) {
  const wall = Date.UTC(y, m - 1, d, hh, mm, 0);
  let ts = wall;
  for (let i = 0; i < 4; i += 1) {
    const next = wall - offsetMinutes(ts, tz) * 60000;
    if (next === ts) break;
    ts = next;
  }
  const back = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(ts)).map((x) => [x.type, x.value]),
  );
  const same = +back.year === y && +back.month === m && +back.day === d
    && (+back.hour % 24) === hh && +back.minute === mm;
  return same ? new Date(ts) : null;
}

/** Which weekday is it, right now, in the shop's zone? 0 = Sunday. */
function zoneParts(now, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const p = Object.fromEntries(f.map((x) => [x.type, x.value]));
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { y: +p.year, m: +p.month, d: +p.day, dow };
}

/**
 * The next real instant for one of Riley's three windows. Walks forward a day at a time in the
 * shop's own zone rather than adding milliseconds, because adding 24 hours across a DST boundary
 * moves the wall clock by an hour and would book the visit at seven or nine.
 *
 * @returns {{ok:true, startsAt:string, spoken:string} | {ok:false, error:string}}
 */
export function nextWindow(key, now = new Date()) {
  const w = WINDOWS[key];
  if (!w) return { ok: false, error: `not one of the visit windows: ${WINDOW_KEYS.join(', ')}` };
  const base = zoneParts(now, SHOP_TZ);
  for (let add = 0; add <= 21; add += 1) {
    // step the CALENDAR date, then ask the zone what instant that clock time is
    const probe = new Date(Date.UTC(base.y, base.m - 1, base.d + add, 12, 0, 0));
    const p = zoneParts(probe, SHOP_TZ);
    if (p.dow !== w.day) continue;
    const at = zonedInstant(p.y, p.m, p.d, w.hour, w.minute, SHOP_TZ);
    if (!at) continue; // a wall clock that does not exist that day; take the next one
    if (at.getTime() - now.getTime() < MIN_LEAD_MS) continue;
    return { ok: true, startsAt: at.toISOString(), spoken: w.spoken };
  }
  return { ok: false, error: 'no occurrence of that window inside three weeks' };
}

// ── the placeholder floor ───────────────────────────────────────────────────────────────────────
// Values a model reaches for when it has nothing. Anchored, so a real "Nathan" is not caught by
// "n/a" and a real "Unknown Road" is not caught by "unknown".
const PLACEHOLDER = [
  /^n\/?a\.?$/i, /^none$/i, /^null$/i, /^undefined$/i, /^unknown$/i, /^not (?:given|provided|stated|specified|available|sure)$/i,
  /^tbd$/i, /^to be (?:determined|confirmed|provided)$/i, /^pending$/i, /^x+$/i, /^\?+$/i, /^-+$/i, /^\.+$/i,
  /^(?:the )?(?:customer|caller|client|user|person)$/i, /^same as above$/i, /^see notes?$/i, /^no (?:name|address|number)$/i,
  /^(?:john|jane) (?:q\.? )?doe$/i, /^test(?: (?:user|customer|name))?$/i, /^example$/i, /^placeholder$/i,
  /^\[.*\]$/, /^<.*>$/, /^\{\{.*\}\}$/,
];
// The single most likely invented address in the English language, plus its neighbours.
const FAKE_STREET = /^\s*(?:123|1234)\s+(?:main|any|elm|first|test|example)\s?(?:st|street|ave|avenue|rd|road|ln|lane|dr|drive)?\b/i;

const isPlaceholder = (s) => PLACEHOLDER.some((re) => re.test(String(s).trim()));

// Control characters out, whitespace collapsed. Same posture as lib/booking's `clean`, minus the
// newline carve-out: nothing a voice agent hands over has a deliberate line break in it.
const CTRL = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');
const tidy = (s, cap) => String(s == null ? '' : s)
  .replace(CTRL, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, cap);

/**
 * Turn what the model handed over into a bookable job, or into the honest reasons why it is not one.
 *
 * The failure mode this is written against is NOT a malformed request. It is a beautifully formed
 * one with an invented field in it. Every check below is either "did the caller actually say this"
 * or "is this shaped like something a model produces when the caller did not".
 *
 * @returns {{ok:true, clean:object} | {ok:false, missing:string[], problems:string[]}}
 */
export function normalizeBooking(raw, now = new Date()) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const missing = [];
  const problems = [];

  const name = tidy(a.customer_name ?? a.name, 120);
  if (!name) missing.push('their name');
  else if (isPlaceholder(name) || !/[A-Za-z]/.test(name) || name.length < 2) {
    problems.push('customer_name does not look like a name the caller said');
    missing.push('their name');
  }

  const address = tidy(a.address ?? a.service_address, 240);
  if (!address) missing.push('the address');
  else if (isPlaceholder(address) || FAKE_STREET.test(address) || address.length < 6 || !/[A-Za-z]/.test(address)) {
    problems.push('address does not look like an address the caller said');
    missing.push('the address');
  }

  const phoneRaw = tidy(a.callback_number ?? a.customer_phone ?? a.phone, 40);
  const phone = e164(phoneRaw);
  if (!phoneRaw) missing.push('a callback number');
  else if (!phone) {
    problems.push('callback_number is not a phone number this server can dial');
    missing.push('a callback number');
  } else if (/^\+1(\d)\1{9}$/.test(phone) || phone === '+15551234567' || /^\+1555/.test(phone)) {
    // 555 numbers and ten identical digits are what gets invented, never what gets said
    problems.push('callback_number looks invented rather than spoken');
    missing.push('a callback number');
  }

  const service = tidy(a.service ?? a.reason ?? a.job, 200);
  if (!service) missing.push('what the visit is for');
  else if (isPlaceholder(service) || service.length < 3) {
    problems.push('service does not look like something the caller described');
    missing.push('what the visit is for');
  }

  const windowKey = tidy(a.window ?? a.visit_window ?? a.slot, 40).toLowerCase().replace(/[\s-]+/g, '_');
  let when = null;
  if (!windowKey) missing.push('which of the three windows they want');
  else {
    when = nextWindow(windowKey, now);
    if (!when.ok) {
      problems.push(`window: ${when.error}`);
      missing.push('which of the three windows they want');
      when = null;
    }
  }

  const notes = tidy(a.notes, 700);

  if (missing.length || problems.length) return { ok: false, missing, problems };

  return {
    ok: true,
    clean: {
      customer_name: name,
      address,
      customer_phone: phone,
      service,
      window: windowKey,
      starts_at: when.startsAt,
      spoken_window: when.spoken,
      notes: isPlaceholder(notes) ? '' : notes,
    },
  };
}

/**
 * The idempotency key. A retried tool call has to land on the same string or it books twice.
 *
 * Built from the FACTS OF THE JOB, not from a request id, because the two duplicate-shaped events
 * we actually face produce different request ids and identical facts: ElevenLabs retrying a webhook
 * that timed out, and a model deciding to call the tool a second time to be helpful.
 *
 * ★ AND THE FACTS ARE THE AUTHORITY HERE, NOT THE CONVERSATION ID, WHICH IS MEASURED AND NOT HOPED.
 * Two real ElevenLabs conversations were driven through the live runtime on 2026-08-14 and the
 * webhook body arrived with NO conversation_id both times, even though the field is declared on the
 * tool and the bridge injects it. Three documented shapes for binding it as a platform dynamic
 * variable were tried against the vendor API and all three were refused 422. So the id is mixed in
 * WHEN it turns up and the key is complete without it. That is the right way round: a key that
 * depended on the vendor supplying an id would have silently degraded to no protection at all on
 * exactly the path that matters, and the second of those two conversations is the proof it does
 * not, because it replayed instead of booking a second van.
 */
export function idemKey(clean, conversationId) {
  const canon = [
    BOOK_TOOL,
    String(conversationId || 'no-conversation'),
    clean.customer_name.toLowerCase(),
    clean.customer_phone,
    clean.address.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
    clean.service.toLowerCase(),
    clean.starts_at,
  ].join('|');
  return createHash('sha256').update(canon).digest('hex');
}

// ── the tool, described twice, from one source ──────────────────────────────────────────────────
// The vendor needs a JSON Schema and Anthropic needs an input_schema. They are the same object with
// different key names, so it is written once. A tool the model can see but the webhook cannot parse
// is the seam every integration rots at.

const PARAMS = {
  customer_name:   { type: 'string', description: 'The caller\'s name, exactly as they said it. Never guess it, never fill it in.' },
  address:         { type: 'string', description: 'The service address the caller said out loud, as close to their words as you can. Never invent a street.' },
  callback_number: { type: 'string', description: 'The phone number the caller gave for the tech to reach them. Read it back before you use it. Never use the number you think they are calling from.' },
  service:         { type: 'string', description: 'What the visit is for, in the caller\'s own words, for example "water heater is leaking".' },
  window:          { type: 'string', enum: WINDOW_KEYS, description: 'Which of the three visit windows the caller agreed to. tuesday_8am is Tuesday at eight in the morning, tuesday_130pm is Tuesday at one thirty in the afternoon, wednesday_9am is Wednesday at nine in the morning. There are no other windows.' },
  notes:           { type: 'string', description: 'Anything else the caller said that the tech should know. Optional. Leave it out rather than filling it.' },
  conversation_id: { type: 'string', description: 'Set by the phone system when it has one. Leave it out. Never ask the caller about it.' },
};
const REQUIRED = ['customer_name', 'address', 'callback_number', 'service', 'window'];

export const BOOK_DESCRIPTION = [
  'Write the visit onto the shop\'s schedule. This is the only thing on this call that actually books anything:',
  'until it answers, nothing is on the calendar and nothing has been sent to anyone.',
  'Call it ONCE, the moment you have all five of: the caller\'s name, the service address, a callback number,',
  'what the visit is for, and which of the three windows they agreed to. Do not call it before you have all five,',
  'and do not fill a gap in yourself: if something is missing, ask the caller for it instead.',
  'Do not tell the caller they are booked until this has answered. It answers in a couple of seconds.',
].join(' ');

/** The ElevenLabs webhook server-tool config. */
export function elToolConfig({ url, headers, timeoutSecs = 20 }) {
  return {
    type: 'webhook',
    name: BOOK_TOOL,
    description: BOOK_DESCRIPTION,
    response_timeout_secs: timeoutSecs,
    api_schema: {
      url,
      method: 'POST',
      request_headers: headers,
      request_body_schema: {
        type: 'object',
        description: 'Everything the shop needs to put a visit on the calendar.',
        properties: PARAMS,
        required: REQUIRED,
      },
    },
  };
}

/** The same tool in Anthropic's shape, for the reasoning chain inside the bridge. */
export function anthropicTool(description) {
  return {
    name: BOOK_TOOL,
    description: description || BOOK_DESCRIPTION,
    input_schema: { type: 'object', properties: PARAMS, required: REQUIRED },
  };
}

// ── what the tool says back ─────────────────────────────────────────────────────────────────────
// These strings are read by the MODEL and then spoken in its own words, so they are written for a
// listener twice removed. Two rules, both learned from Riley's own floors:
//   NO DIGITS. The numeral firewall blocks any digit the caller did not say first, so a job number
//   or a date in this string comes back out of the guard as a pivot mid sentence.
//   NO PROMISE. Riley's contact floor blocks "someone will call you back", correctly, because on
//   the demo line nobody will. So the failure line offers another try, not a callback.
export const RESULTS = {
  booked: (spokenWindow) => [
    `BOOKED. It is written down and the shop has it, for ${spokenWindow}.`,
    'Tell the caller it is on the schedule, say the day and time back in words, and close warmly.',
    'Do not read out a job number, a date, or any other number.',
  ].join(' '),

  replayed: (spokenWindow) => [
    `ALREADY BOOKED. This same visit is already on the schedule for ${spokenWindow}, from a moment ago.`,
    'Nothing was booked twice. Confirm the window to the caller once, in words, and move on.',
  ].join(' '),

  missing: (missing) => [
    'NOT BOOKED, because something is still missing:',
    `${listOf(missing)}.`,
    'Ask the caller for it in one short question, then call this again. Do not say the visit is booked.',
    'Do not fill the gap in yourself.',
  ].join(' '),

  failed: [
    'NOT BOOKED. The scheduling system refused it and nothing was written down.',
    'Tell the caller plainly that it did not go through on your end and that nothing is booked,',
    'and offer to take it from the top. Do not say it is booked. Do not promise anyone will call them back.',
  ].join(' '),
};

/**
 * Did a tool answer already say the visit is on the schedule?
 *
 * The bridge asks this to decide whether to offer the booking tool again on a later turn. It reads
 * the FIRST WORDS of the answer rather than searching for "booked" anywhere in it, because every
 * failure sentence above also contains that word ("NOT BOOKED", "Do not say it is booked"), and a
 * substring test would read every one of them as a success. That inversion would have offered no
 * second attempt to a caller whose first attempt failed.
 */
export const wasBooked = (text) => /^\s*(?:ALREADY BOOKED|BOOKED)\./.test(String(text || ''));

/** "their name, the address and a callback number" — plain, no serial comma drama. */
export function listOf(items) {
  const a = items.filter(Boolean);
  if (!a.length) return 'something';
  if (a.length === 1) return a[0];
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}
