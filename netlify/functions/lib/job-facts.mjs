// lib/job-facts.mjs — the facts a job row must carry, decided ONCE, at creation, with reasoning.
//
// WHY THIS IS ITS OWN FILE AND NOT PART OF lib/jobs.mjs.
// Two lanes built the seam between /api/booking and the `jobs` table on the same afternoon and both
// landed on the same filename. lib/jobs.mjs is the PORTAL lane's surface: receipts, calendar feeds,
// notification channels, the void reasons a customer picks from. This file is the RECORD lane's:
// the small set of values that decide what a job IS and what it COSTS, which have to be settled
// before the row is written and must never be re-derived afterwards. Splitting them means neither
// lane has to hold the other's file open, and the seam between us is one import.
//
// THREE FACTS LIVE HERE, AND EACH ONE IS HERE FOR A MEASURED REASON:
//
//   1. `source`   The column has CHECK (source IN ('voice','form','operator','api')). /api/booking
//                 takes FREE TEXT and defaults it to 'api'. Measured: a booking posted with
//                 source:"lane-jobrec-baseline" sends that string straight at the constraint, and
//                 PostgREST answers the violation as an HTTP 200 with ok:false, which is the
//                 quietest way in this codebase for a write to not happen. The raw claim is kept.
//
//   2. `after_hours`  This decides $19 or $49 (lib/meter.mjs CATALOG.booked_job /
//                 booked_job_after_hours). lib/booking.mjs `normalize()` NEVER SETS IT, so any
//                 caller reading `job.after_hours` off a normalised booking reads undefined and
//                 writes `false` every single time, forever, and the after-hours price could never
//                 be recorded at all. It is computed here, from the owner's own posted hours, on
//                 the owner's own clock, and then frozen.
//
//   3. the owner  A job belongs to whoever owns the LINE that was dialled, never the customer's
//                 number. Null is allowed and common. Null that nobody notices is not: an unowned
//                 job is invisible to sv_jobs_for_account, which walks account_id, so this file
//                 names the orphan at the moment it is created rather than letting somebody find it
//                 later underneath a confident empty state.
//
// NOTHING HERE FABRICATES. Where a fact cannot be established it says so in words and falls to the
// answer that costs the customer less, which is the direction lib/meter.mjs already publishes:
// "an unproved upgrade must fall toward the customer, not toward us."

import { rpc, dbConfigured } from './db.mjs';

export { dbConfigured };

// ── the values the database will actually accept ─────────────────────────────────────────────
// Measured against production 2026-08-14, not read off a handoff note:
//   jobs_source_check  CHECK (source = ANY (ARRAY['voice','form','operator','api']))
//   jobs_status_check  CHECK (status = ANY (ARRAY['booked','voided','completed','no_show','rescheduled']))

export const SOURCES = Object.freeze(['voice', 'form', 'operator', 'api']);
export const STATUSES = Object.freeze(['booked', 'voided', 'completed', 'no_show', 'rescheduled']);

// ★ WORD BOUNDARIES, NOT SUBSTRINGS, AND THIS IS NOT PEDANTRY. The first version matched bare
// substrings, so the very first booking I sent through production, tagged
// source:"lane-jobrec-baseline", was categorised 'voice' because "base_line_" contains "line". The
// same bug reads "online form" as voice, "callback widget" as voice, and "decline" as voice. A
// mislabelled source is a job filed under the wrong channel forever, and channel is how this
// company will decide where its bookings actually come from.
const VOICE_WORDS = /\b(voice|call|phone|agent|elevenlabs|twilio|inbound|riley)\b/i;
const FORM_WORDS = /\b(form|web|website|site|page|widget|chat)\b/i;
const OPERATOR_WORDS = /\b(operator|admin|console|cockpit|manual|human|staff)\b/i;

/**
 * Turn whatever the caller claimed into one of the four values the column allows, keeping the raw
 * claim. A booking carrying a call sid came off a phone call by definition, and that beats any
 * label a caller typed.
 */
export function normalizeSource(raw, { hasCallSid = false } = {}) {
  const s = String(raw == null ? '' : raw).trim().slice(0, 120);
  const lower = s.toLowerCase();
  if (SOURCES.includes(lower)) return { source: lower, source_raw: s, categorised: false };
  if (hasCallSid) return { source: 'voice', source_raw: s, categorised: true };
  if (VOICE_WORDS.test(lower)) return { source: 'voice', source_raw: s, categorised: true };
  if (FORM_WORDS.test(lower)) return { source: 'form', source_raw: s, categorised: true };
  if (OPERATOR_WORDS.test(lower)) return { source: 'operator', source_raw: s, categorised: true };
  return { source: 'api', source_raw: s, categorised: Boolean(s) };
}

// ── after hours, decided once, with its reasoning attached ────────────────────────────────────

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Wall-clock weekday key and minutes past midnight in one Intl pass. Throws on an unusable zone. */
function localDayMinutes(tz, at) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(at).map((p) => [p.type, p.value]),
  );
  const day = String(parts.weekday || '').slice(0, 3).toLowerCase();
  const minutes = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
  return { day, minutes };
}

const hhmm = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return Number.isFinite(v) && v >= 0 && v <= 1440 ? v : null;
};

const clock = (mins) => {
  const h24 = Math.floor(mins / 60) % 24;
  const mm = String(mins % 60).padStart(2, '0');
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${mm}${h24 >= 12 ? 'pm' : 'am'}`;
};

/**
 * Was this booking taken outside the hours the OWNER posted for his own business?
 *
 * ★ THE THRESHOLD IS THE OWNER'S, NOT OURS. /terms prices "a job booked after hours, nights and
 * weekends" at $49 and publishes no cutoff anywhere, so this module does not invent one, exactly as
 * lib/meter.mjs refuses to invent the Recover day-bands it was never given. The only non-arbitrary
 * definition available is the hours the business wrote down itself in account_config.hours.
 *
 * ★ WHEN IT CANNOT BE ESTABLISHED IT IS FALSE, AND `determined` SAYS SO. No account, no posted
 * hours, or a timezone this platform cannot format in, and the answer is the cheaper one.
 * Undercharging on an unknown is a cost. Overcharging on a guess is a bill nobody can defend.
 *
 * @returns {{after_hours:boolean, determined:boolean, basis:string, tz:string, local:string}}
 */
export function afterHoursFact({ at = new Date(), tz = 'America/Los_Angeles', hours = null } = {}) {
  const when = at instanceof Date ? at : new Date(at);
  const zone = String(tz || '').trim() || 'America/Los_Angeles';
  const undetermined = (basis) => ({ after_hours: false, determined: false, basis, tz: zone, local: '' });

  if (Number.isNaN(when.getTime())) return undetermined('the booking carried no usable timestamp, so after hours could not be established and it is recorded as standard hours');
  if (!hours || typeof hours !== 'object' || Array.isArray(hours)) {
    return undetermined('this business has not posted its hours, so after hours could not be established and it is recorded as standard hours');
  }

  let day; let minutes;
  try { ({ day, minutes } = localDayMinutes(zone, when)); }
  catch { return undetermined(`"${zone}" is not a timezone this platform recognises, so after hours could not be established and it is recorded as standard hours`); }

  if (!DAY_KEYS.includes(day)) return undetermined('the local weekday could not be read, so after hours could not be established and it is recorded as standard hours');

  const spans = Array.isArray(hours[day]) ? hours[day] : null;
  const local = `${clock(minutes)} ${zone}`;

  // A day with no spans is a day the business posted as CLOSED. That is a determined fact, not a
  // missing one, and it is the whole reason a Sunday call costs more than a Tuesday one.
  if (!spans || !spans.length) {
    return { after_hours: true, determined: true, basis: `booked at ${local}, and this business posts ${day} as closed`, tz: zone, local };
  }

  for (const span of spans) {
    const open = hhmm(Array.isArray(span) ? span[0] : null);
    const close = hhmm(Array.isArray(span) ? span[1] : null);
    if (open === null || close === null) continue;        // an unreadable span proves nothing
    const inside = close > open
      ? (minutes >= open && minutes < close)
      : (minutes >= open || minutes < close);             // a span crossing midnight: 22:00 to 02:00
    if (inside) {
      return {
        after_hours: false,
        determined: true,
        basis: `booked at ${local}, inside this business's posted ${day} hours of ${clock(open)} to ${clock(close)}`,
        tz: zone,
        local,
      };
    }
  }

  const readable = spans
    .map((s) => (hhmm(s && s[0]) !== null && hhmm(s && s[1]) !== null ? `${clock(hhmm(s[0]))} to ${clock(hhmm(s[1]))}` : null))
    .filter(Boolean);
  if (!readable.length) return undetermined(`this business's posted ${day} hours could not be read, so after hours could not be established and it is recorded as standard hours`);

  return {
    after_hours: true,
    determined: true,
    basis: `booked at ${local}, outside this business's posted ${day} hours of ${readable.join(' and ')}`,
    tz: zone,
    local,
  };
}

// ── who this job belongs to ───────────────────────────────────────────────────────────────────

/**
 * Resolve the owning account from the number that was DIALLED, never the customer's number.
 * Returns a null account and a REASON, never a throw and never a guess.
 */
export async function resolveAccount(lineNumber) {
  const phone = String(lineNumber || '').trim();
  const none = (reason) => ({ account_id: null, business_name: '', trade: '', timezone: '', config: null, reason });

  if (!/^\+\d{8,15}$/.test(phone)) return none('no usable line number on this booking, so it could not be matched to an account');
  if (!dbConfigured()) return none('the account directory is not reachable from this deploy (ANSWERED_DB_* not set), so this booking could not be matched to an account');

  try {
    const acct = await rpc('sv_account_for_number', { p_phone: phone });
    if (!acct || !acct.id) {
      return none(`no live account owns ${phone}, so this job is recorded without an owner and will not appear in any customer portal`);
    }
    return {
      account_id: String(acct.id),
      business_name: String(acct.business_name || ''),
      trade: String(acct.trade || ''),
      // ★ THE BUSINESS'S OWN CLOCK, AND IT IS NOT A DETAIL. account_config.hours is wall-clock text
      // the owner typed, "07:00" to "17:00", and wall-clock text means nothing until you say whose
      // clock. Reading it in the CALLER's timezone would bill a Los Angeles plumber's customer $49
      // for a 5pm booking placed from New York, with the shop plainly open. accounts.timezone is
      // the shop's clock and it is the only correct one to read posted hours in.
      timezone: String(acct.timezone || ''),
      config: (acct.config && typeof acct.config === 'object') ? acct.config : null,
      reason: '',
    };
  } catch (e) {
    return none(`the account directory could not be read (${String((e && e.message) || e).slice(0, 120)}), so this booking could not be matched to an account`);
  }
}

// ── the write, with the one check that makes it a write ───────────────────────────────────────

const short = (e) => String((e && e.message) || e).slice(0, 160);
const refOk = (ref) => /^[A-Za-z0-9._-]{4,64}$/.test(String(ref || ''));

/**
 * Call sv_job_create AND READ ITS ANSWER.
 *
 * ★ MEASURED AGAINST PRODUCTION: every refusal from these RPCs is an HTTP 200.
 *     sv_job_create {}                  -> 200 {"ok":false,"error":"a job needs a reference ..."}
 *     sv_job_void   (missing ref)       -> 200 {"ok":false,"error":"no job with that reference"}
 *   A caller that trusts `rpc()` resolving reports a write that never happened. That is defect two
 *   in seams.test.mjs wearing different clothes: the endpoint answered cheerfully and the queryable
 *   table stayed empty forever while the site looked healthy. So `landed` here means a row exists,
 *   and it is derived from the BODY, never from the absence of a throw.
 *
 * @returns {{ok:boolean, landed:boolean, replay:boolean, job:object|null, reason:string}}
 */
export async function createChecked(row) {
  const ref = String((row && row.job_ref) || '').trim();
  if (!refOk(ref)) {
    console.error('job-facts.createChecked: refusing to write a job with no usable reference');
    return { ok: false, landed: false, replay: false, job: null, reason: 'a job needs a reference the customer can quote back, and this one had none' };
  }
  if (!dbConfigured()) {
    console.error(`job-facts.createChecked ${ref}: NOT RECORDED. ANSWERED_DB_* is not configured on this deploy, so the booking exists only in the raw log and the email.`);
    return { ok: false, landed: false, replay: false, job: null, reason: 'the job record is not reachable from this deploy (ANSWERED_DB_* not set), so the booking exists only in the raw log and the email' };
  }

  // Only send keys that carry a value. sv_job_create casts window_start/window_end straight to
  // timestamptz and account_id/contact_id/call_id straight to uuid, so an empty string is a cast
  // error that takes the whole write down, while an absent key is a field honestly left null.
  const payload = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (v === null || v === undefined || v === '') continue;
    payload[k] = v;
  }
  payload.job_ref = ref;
  if (!SOURCES.includes(payload.source)) payload.source = 'api';
  payload.after_hours = payload.after_hours === true;

  try {
    const res = await rpc('sv_job_create', { p_row: payload });
    if (!res || res.ok !== true) {
      const why = (res && res.error) || 'the database refused the write without saying why';
      console.error(`job-facts.createChecked ${ref}: REFUSED by sv_job_create: ${why}`);
      return { ok: false, landed: false, replay: false, job: null, reason: why };
    }
    if (res.replay) console.warn(`job-facts.createChecked ${ref}: already recorded, returning the existing row (sv_job_create is idempotent on job_ref)`);
    return {
      ok: true,
      landed: true,
      replay: Boolean(res.replay),
      job: (res.job && typeof res.job === 'object') ? res.job : null,
      reason: res.replay ? 'this job was already recorded, so the existing row was returned rather than a second one created' : 'recorded',
    };
  } catch (e) {
    console.error(`job-facts.createChecked ${ref}: NOT RECORDED. ${short(e)} — the booking itself succeeded and exists in the raw log and the email; the queryable copy did not land.`);
    return { ok: false, landed: false, replay: false, job: null, reason: short(e) };
  }
}

/**
 * Void a job, with the one condition the product publishes about voids.
 *
 * ★ A VOID IS A STATUS CHANGE WITH A REASON, NEVER A DELETE, AND "WITH A REASON" IS THE HALF THAT
 * WAS NOT ENFORCED. MEASURED against the live database: `sv_job_void` does
 * `nullif(p_reason,'')`, so an empty reason is accepted and the row lands with `status='voided'`
 * and `void_reason = NULL`. A booking somebody was charged for, cancelled by nobody, for nothing.
 * The portal's own handler is careful and never sends an empty reason, but the LIBRARY door was
 * open to every other caller, and a rule that only one caller keeps is not a rule. It is refused
 * here, at the door, before the request is made.
 *
 * Returns the RPC's own body shape ({ok, replay, job, note} or {ok:false, error}) because
 * netlify/functions/portal.mjs reads `r.ok`, `r.replay` and `r.error` off it. It never throws.
 */
export async function voidChecked(ref, reason, actor) {
  const r = String(ref || '').trim();
  if (!refOk(r)) return { ok: false, error: 'that is not a job reference' };

  const why = String(reason || '').trim().slice(0, 500);
  if (!why) {
    console.error(`job-facts.voidChecked ${r}: REFUSED, a void with no reason is not a void`);
    return { ok: false, error: 'a void needs a reason, because a status change nobody can explain is worse than the booking it replaced' };
  }
  if (!dbConfigured()) return { ok: false, error: 'the job record is not reachable from this deploy, so nothing was voided' };

  try {
    const res = await rpc('sv_job_void', { p_ref: r, p_reason: why, p_actor: String(actor || 'customer').slice(0, 60) });
    if (!res || res.ok !== true) console.error(`job-facts.voidChecked ${r}: REFUSED: ${(res && res.error) || 'no reason given'}`);
    return res || { ok: false, error: 'the database refused the void without saying why' };
  } catch (e) {
    console.error(`job-facts.voidChecked ${r}: failed: ${short(e)}`);
    return { ok: false, error: short(e) };
  }
}

// ── the one call the booking path makes ───────────────────────────────────────────────────────

/**
 * Everything that has to be TRUE about a job before its row is written, settled in one place.
 *
 * @param {object} job  the object lib/booking.mjs normalize() produced
 * @returns {Promise<{row:object, account:object, after_hours:object, source:object, pieces:string[]}>}
 */
export async function factsFor(job) {
  const j = job && typeof job === 'object' ? job : {};

  // The number that was DIALLED. An explicit line number beats the shop's published number: on a
  // real Answered line they are usually the same, and where they differ the explicit one is the
  // number a caller actually rang.
  const line = String(j.ln || j.sp || '');
  const account = await resolveAccount(line);

  const bookedAt = j.at ? new Date(j.at) : new Date();
  const hoursTz = account.timezone || j.tz || '';
  const tzSource = account.timezone
    ? 'the business timezone on the account'
    : (j.tz ? 'the timezone that came in on the booking' : 'the default timezone');
  const after = afterHoursFact({ at: bookedAt, tz: hoursTz, hours: account.config && account.config.hours });
  const source = normalizeSource(j.src, { hasCallSid: Boolean(j.cs) });

  const start = j.t ? new Date(j.t) : null;
  const startOk = start && !Number.isNaN(start.getTime());
  const end = startOk ? new Date(start.getTime() + (Number(j.d) || 60) * 60000) : null;

  // The four pieces lib/meter.mjs requires before a booking is billable at all.
  // /terms: "Anything less is free. That is the whole definition."
  const pieces = Object.entries({
    name: Boolean(j.c), address: Boolean(j.a), callback: Boolean(j.cp), window: Boolean(startOk),
  }).filter(([, v]) => !v).map(([k]) => k);

  const row = {
    job_ref: j.id,
    account_id: account.account_id,
    caller_name: j.c || null,
    address: j.a || null,
    callback: j.cp || null,
    window_start: startOk ? start.toISOString() : null,
    window_end: end ? end.toISOString() : null,
    trade: account.trade || j.trade || null,
    after_hours: after.after_hours,
    source: source.source,
    call_sid: j.cs || null,
    status: 'booked',
    details: {
      // The audit trail for every decision above, so a bill can be explained a year from now
      // without re-deriving it from fields that will have changed by then.
      mode: j.m === 'live' ? 'live' : 'demo',
      after_hours_determined: after.determined,
      after_hours_basis: after.basis,
      booked_at: bookedAt.toISOString(),
      tz: after.tz,
      tz_source: tzSource,
      caller_tz: j.tz || '',
      source_raw: source.source_raw,
      source_categorised: source.categorised,
      shop_name: j.s || '',
      shop_phone: j.sp || '',
      line_number: line,
      customer_email: j.ce || '',
      service: j.w || '',
      minutes: Number(j.d) || null,
      notes: j.n || '',
      billable_pieces_missing: pieces,
      account_match: account.account_id ? 'matched on the dialled number' : (account.reason || 'not matched'),
    },
  };

  return { row, account, after_hours: after, source, pieces, tz_source: tzSource };
}
