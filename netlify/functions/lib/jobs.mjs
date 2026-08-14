// lib/jobs.mjs — the single door to the JOB RECORD: the queryable, joined copy of a booked job.
//
// WHY THIS FILE EXISTS. Until today a booked job went to three places and belonged to nobody: a
// blob, an email, and a HubSpot note. All three worked. None of them could answer the one question
// the customer portal is built to answer, which is "show me MY jobs". That is the same orphan
// defect this estate already found one layer up in billing, where a panel printed "No billing
// accounts yet, this is a measured zero" underneath a tile reading "97 charges, $492 open": the
// charges existed, they just had no parent, so the query that walked the parent could not see them.
//
// THE SHAPE, AND WHY IT IS THIS SHAPE:
//
//   THE RAW LOG IS THE SOURCE OF TRUTH.        /api/booking writes the blob and sends the email.
//   THE JOB ROW IS THE SECOND WRITE.           It is deliberately NON-FATAL. A database outage may
//                                              never fail a booking the customer has already been
//                                              told about. This is the event-collector contract,
//                                              applied to the artifact the whole product points at.
//   THE LINK IS NOT A DATABASE READ.           /job/<signed token> already carries the whole job
//                                              inside the URL and reads nothing (see lib/booking).
//                                              This file adds a SECOND, shorter link, /j/<token>,
//                                              which resolves a job BY REFERENCE so the portal can
//                                              show live status, a void, a reschedule. The two are
//                                              different tools: the booking token is a snapshot the
//                                              customer can open forever, the job token is a key to
//                                              the living record.
//
// TWO REFUSALS THAT ARE NOT NEGOTIABLE:
//
//   1. NOTHING HERE FABRICATES A ROW. If the database is unreachable, unconfigured, or refuses the
//      write, every reader returns an HONEST EMPTY STATE that says WHY, and `measured` is false. A
//      caller can always tell "we asked and the answer was zero" from "we could not ask". Those are
//      different facts and this estate has already shipped a page that confused them.
//   2. `after_hours` IS WRITTEN ONCE, AT CREATION, AS A FACT. It decides whether the booking is
//      rated at $19 or $49 (lib/meter.mjs CATALOG.booked_job / booked_job_after_hours). Recomputing
//      it at read time would silently restate a bill somebody already paid, because an owner can
//      edit his posted hours tomorrow. So it is measured against the hours that were in force at the
//      moment of booking and then frozen, and the basis for the measurement is stored beside it.
//
// Env by NAME only: ANSWERED_JOB_KEY (preferred) | ANSWERED_BOOKING_KEY | ANSWERED_COCKPIT_KEY for
// the link signature, and ANSWERED_DB_* for the record itself. Deliberately NEVER
// ANSWERED_BRAIN_SECRET: that one is pasted into a third party's dashboard, and anyone holding it
// could mint a link to any customer's job. Same reasoning as lib/booking.mjs, same refusal.

import crypto from 'node:crypto';
import { rpc, dbConfigured } from './db.mjs';

export { dbConfigured };

// ── the values the database will actually accept ─────────────────────────────────────────────
//
// ★ MEASURED, NOT ASSUMED. `jobs_source_check` is CHECK (source IN ('voice','form','operator','api'))
// and `jobs_status_check` is CHECK (status IN ('booked','voided','completed','no_show','rescheduled')).
// /api/booking accepts a FREE-TEXT `source` field and defaults it to 'api', so a caller posting
// source:"elevenlabs" or source:"demo-line" would have failed the insert with a constraint
// violation, and it would have failed as an HTTP 200 with ok:false, which is the quietest possible
// way for a write to not happen. The raw string the caller sent is kept in `details.source_raw`, so
// nothing is lost by categorising it.

export const SOURCES = Object.freeze(['voice', 'form', 'operator', 'api']);
export const STATUSES = Object.freeze(['booked', 'voided', 'completed', 'no_show', 'rescheduled']);

const VOICE_WORDS = /voice|call|phone|agent|elevenlabs|twilio|inbound|line|riley/i;
const FORM_WORDS = /form|web|site|page|widget|chat/i;
const OPERATOR_WORDS = /operator|admin|console|cockpit|manual|human|staff/i;

/**
 * Turn whatever the caller claimed into one of the four values the column allows, keeping the raw
 * claim. A booking that carries a call sid came off a phone call by definition, and that beats any
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

/** Wall-clock weekday key and minutes-past-midnight in one Intl pass. Throws on an unusable zone. */
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
 * weekends" at $49 and never publishes a cutoff, so this module does not invent one, exactly as
 * lib/meter.mjs refuses to invent the Recover day-bands it was never given. The only non-arbitrary
 * definition available is the hours the business wrote down itself in account_config.hours, and
 * that is the one used here.
 *
 * ★ WHEN IT CANNOT BE ESTABLISHED, IT IS FALSE. No account, no posted hours, or a timezone this
 * platform cannot format in, and the answer is `determined:false, after_hours:false`. That is the
 * same direction lib/meter.mjs already takes in writing: "an unproved upgrade must fall toward the
 * customer, not toward us." Undercharging on an unknown is a cost. Overcharging on a guess is a
 * bill nobody can defend.
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

  // A day with no spans is a day the business posted as closed. That is a determined fact, not a
  // missing one, and it is the whole reason a Sunday booking costs more.
  if (!spans || !spans.length) {
    return {
      after_hours: true,
      determined: true,
      basis: `booked at ${local}, and this business posts ${day} as closed`,
      tz: zone,
      local,
    };
  }

  for (const span of spans) {
    const open = hhmm(Array.isArray(span) ? span[0] : null);
    const close = hhmm(Array.isArray(span) ? span[1] : null);
    if (open === null || close === null) continue;      // an unreadable span proves nothing
    const inside = close > open
      ? (minutes >= open && minutes < close)
      : (minutes >= open || minutes < close);           // a span that crosses midnight: 22:00-02:00
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

// ── the per-job link: the token IS the credential ────────────────────────────────────────────
//
// The same pattern as the Parley deal link (netlify/functions/truce.mjs) and for the same reason
// David gave: no gated processes, no lengthy processes. A notification carries a link that opens
// THAT job with no password and no account. A login exists only to see everything at once.
//
// THE KEY IS DOMAIN-SEPARATED, DELIBERATELY. The signing key is not used raw: it is run through
// HMAC with a fixed label to derive a subkey used for nothing else. So even when the base secret is
// shared with another surface, a job link can never be replayed as a session cookie and a session
// cookie can never be replayed as a job link. lib/account-auth.mjs refuses to share a key across a
// trust boundary; this achieves the same separation without needing a new environment variable.
//
// THE TOKEN IS DETERMINISTIC ON THE REFERENCE, ON PURPOSE. A job has ONE link, forever. Resend the
// email, text it later, print it on the invoice: same URL. A random per-send token would mean a
// customer holding two emails sees two different links to the same job and cannot tell which is
// real, and it would mean storing a credential in a database, which lib/account-auth.mjs exists to
// avoid. Nothing is stored: the link is recomputed from the reference and the key on every read.

const LINK_VERSION = 'j1';
const LINK_LABEL = 'answered:job-link:v1';
export const MAX_REF_CHARS = 64;

function baseSecret() {
  for (const name of ['ANSWERED_JOB_KEY', 'ANSWERED_BOOKING_KEY', 'ANSWERED_COCKPIT_KEY']) {
    const v = String(process.env[name] || '').trim();
    if (v) return { key: v, name };
  }
  return { key: '', name: '' };
}

/** Which env var is signing job links, by NAME. Useful in a health probe; never returns a value. */
export const linkKeyName = () => baseSecret().name;
export const canLink = () => Boolean(baseSecret().key);

const subkey = () => {
  const { key } = baseSecret();
  if (!key) return null;
  return crypto.createHmac('sha256', key).update(LINK_LABEL).digest();
};

const refOk = (ref) => /^[A-Za-z0-9._-]{4,64}$/.test(String(ref || ''));

/**
 * A signed, stable link token for one job reference, or '' when no key is configured.
 * Returning '' rather than throwing is deliberate: a missing link must degrade the notification to
 * "call us and quote job AJ...", never fail the booking.
 */
export function linkToken(ref) {
  const k = subkey();
  if (!k || !refOk(ref)) return '';
  const payload = Buffer.from(String(ref), 'utf8').toString('base64url');
  const mac = crypto.createHmac('sha256', k).update(`${LINK_VERSION}|${payload}`).digest('base64url').slice(0, 43);
  return `${LINK_VERSION}.${payload}.${mac}`;
}

/** The job reference this token proves, or null. Never throws, never partially trusts. */
export function readLinkToken(token) {
  const k = subkey();
  if (!k) return null;
  const t = String(token || '');
  if (!t || t.length > 256) return null;
  const parts = t.split('.');
  if (parts.length !== 3 || parts[0] !== LINK_VERSION) return null;
  const [, payload, sig] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(sig)) return null;
  const want = Buffer.from(crypto.createHmac('sha256', k).update(`${LINK_VERSION}|${payload}`).digest('base64url').slice(0, 43));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  let ref = '';
  try { ref = Buffer.from(payload, 'base64url').toString('utf8'); } catch { return null; }
  return refOk(ref) ? ref : null;
}

export function siteOrigin() {
  const raw = String(process.env.ANSWERED_SITE_URL || process.env.URL || 'https://answered.reddenda.com').trim();
  return raw.replace(/\/+$/, '');
}

/** The living-record link for a job, or '' when it cannot be signed. */
export function jobLink(ref) {
  const t = linkToken(ref);
  return t ? `${siteOrigin()}/j/${t}` : '';
}

// ── who this job belongs to ───────────────────────────────────────────────────────────────────

/**
 * Resolve the owning account from the number that was DIALLED, never the customer's number.
 *
 * ★ NULL IS AN ANSWER, AND IT IS ALLOWED. The demo line is owned by no account, and a booking taken
 * on it must still be recorded. What is NOT allowed is a null that nobody notices: an unassigned
 * job is invisible to sv_jobs_for_account, which walks account_id, so this returns `reason` and the
 * caller reports it. That is the orphan defect, named at the point where it is created rather than
 * discovered later underneath a confident empty state.
 */
export async function resolveAccount(lineNumber) {
  const phone = String(lineNumber || '').trim();
  if (!/^\+\d{8,15}$/.test(phone)) {
    return { account_id: null, business_name: '', config: null, reason: 'no usable line number on this booking, so it could not be matched to an account' };
  }
  if (!dbConfigured()) {
    return { account_id: null, business_name: '', config: null, reason: 'the account directory is not reachable from this deploy (ANSWERED_DB_* not set), so this booking could not be matched to an account' };
  }
  try {
    const acct = await rpc('sv_account_for_number', { p_phone: phone });
    if (!acct || !acct.id) {
      return { account_id: null, business_name: '', config: null, reason: `no live account owns ${phone}, so this job is recorded without an owner and will not appear in any customer portal` };
    }
    return {
      account_id: String(acct.id),
      business_name: String(acct.business_name || ''),
      trade: String(acct.trade || ''),
      config: (acct.config && typeof acct.config === 'object') ? acct.config : null,
      reason: '',
    };
  } catch (e) {
    return { account_id: null, business_name: '', config: null, reason: `the account directory could not be read (${String((e && e.message) || e).slice(0, 120)}), so this booking could not be matched to an account` };
  }
}

// ── the four doors ────────────────────────────────────────────────────────────────────────────
//
// ★ EVERY ONE OF THESE RPCs ANSWERS HTTP 200 WHEN IT REFUSES. Measured against production:
// sv_job_create with no job_ref returns 200 {"ok":false,"error":"a job needs a reference the
// customer can quote back"}, and sv_job_void on a missing reference returns 200 {"ok":false,...}.
// A caller that trusts the status code reports a write that never happened, which is defect two in
// seams.test.mjs wearing different clothes. So every function below reads the body's own `ok`.

const short = (e) => String((e && e.message) || e).slice(0, 160);

/**
 * Write the queryable copy of a booked job. NON-FATAL BY CONTRACT: the caller has already told a
 * customer a van is coming, and no database may take that back.
 *
 * @returns {{ok:boolean, landed:boolean, replay:boolean, job:object|null, reason:string}}
 *   landed=true means a row exists in the database with this reference, whether this call created
 *   it or found it. replay=true means it already existed, which is the correct answer to a retry.
 */
export async function create(row) {
  const ref = String((row && row.job_ref) || '').trim();
  if (!refOk(ref)) {
    console.error('jobs.create: refusing to write a job with no usable reference');
    return { ok: false, landed: false, replay: false, job: null, reason: 'a job needs a reference the customer can quote back, and this one had none' };
  }
  if (!dbConfigured()) {
    console.error(`jobs.create ${ref}: NOT RECORDED. ANSWERED_DB_* is not configured on this deploy, so the booking exists only in the raw log and the email.`);
    return { ok: false, landed: false, replay: false, job: null, reason: 'the job record is not reachable from this deploy (ANSWERED_DB_* not set), so the booking exists only in the raw log and the email' };
  }

  // Only send keys that carry a value. The RPC casts window_start/window_end straight to
  // timestamptz and account_id/contact_id/call_id straight to uuid, so an empty string is a cast
  // error that would take the whole write down, and a null is a field that is honestly absent.
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
      console.error(`jobs.create ${ref}: REFUSED by sv_job_create: ${why}`);
      return { ok: false, landed: false, replay: false, job: null, reason: why };
    }
    const job = (res.job && typeof res.job === 'object') ? res.job : null;
    if (res.replay) console.warn(`jobs.create ${ref}: already recorded, returning the existing row (idempotent on job_ref)`);
    return {
      ok: true,
      landed: true,
      replay: Boolean(res.replay),
      job,
      reason: res.replay ? 'this job was already recorded, so the existing row was returned rather than a second one created' : 'recorded',
    };
  } catch (e) {
    console.error(`jobs.create ${ref}: NOT RECORDED. ${short(e)} — the booking succeeded and exists in the raw log and the email; the queryable copy did not land.`);
    return { ok: false, landed: false, replay: false, job: null, reason: short(e) };
  }
}

/**
 * Every job for one account, newest first.
 *
 * ★ `measured` IS THE WHOLE POINT OF THIS RETURN SHAPE. `measured:true, count:0` means we asked the
 * database and it said zero, which is a true statement a portal may print as "no jobs yet".
 * `measured:false` means we could not ask, and a portal that prints "no jobs yet" on that is lying
 * to a customer whose jobs exist. This estate has already shipped that page once.
 */
export async function listForAccount(accountId, { status = null, limit = 200 } = {}) {
  const id = String(accountId || '').trim();
  const empty = (reason) => ({ ok: false, measured: false, count: 0, jobs: [], reason });

  if (!/^[0-9a-f-]{36}$/i.test(id)) return empty('that is not an account id, so no jobs were looked up');
  if (!dbConfigured()) return empty('the job record is not reachable from this deploy, so we cannot say whether there are jobs. This is not the same as having none.');

  const st = status && STATUSES.includes(String(status)) ? String(status) : null;
  try {
    const rows = await rpc('sv_jobs_for_account', {
      p_account_id: id,
      p_status: st,
      p_limit: Math.max(1, Math.min(Number(limit) || 200, 500)),
    });
    const jobs = Array.isArray(rows) ? rows : [];
    return {
      ok: true,
      measured: true,
      count: jobs.length,
      jobs,
      reason: jobs.length ? '' : 'we asked and this account has no jobs recorded yet',
    };
  } catch (e) {
    console.error(`jobs.listForAccount ${id}: read failed: ${short(e)}`);
    return empty(`the job record could not be read (${short(e)}), so we cannot say whether there are jobs`);
  }
}

/**
 * One job by its reference, with whatever the database can join to it: the owning account, the call
 * it came from, and the charge attached to it. `found:false` is not an error.
 */
export async function byRef(ref) {
  const r = String(ref || '').trim();
  const miss = (reason, found = false) => ({ ok: false, found, job: null, account: null, call: null, charge: null, reason });

  if (!refOk(r)) return miss('that is not a job reference');
  if (!dbConfigured()) return miss('the job record is not reachable from this deploy, so this job could not be looked up');

  try {
    const res = await rpc('sv_job_by_ref', { p_ref: r });
    if (!res || !res.job) return { ok: true, found: false, job: null, account: null, call: null, charge: null, reason: 'no job is recorded under that reference' };
    return {
      ok: true,
      found: true,
      job: res.job,
      account: res.account || null,
      call: res.call || null,
      charge: res.charge || null,
      reason: '',
    };
  } catch (e) {
    console.error(`jobs.byRef ${r}: read failed: ${short(e)}`);
    return miss(`the job record could not be read (${short(e)})`);
  }
}

/**
 * Void a job. A VOID IS A STATUS CHANGE WITH A REASON, NEVER A DELETE: the row stays, the reason
 * stays, and who did it stays, because a job somebody was charged for is evidence and evidence is
 * not deleted. The charge attached to it is voided separately through the billing ledger so the two
 * facts stay independently auditable, and sv_job_void says so in its own note.
 */
export async function voidJob(ref, reason, actor) {
  const r = String(ref || '').trim();
  if (!refOk(r)) return { ok: false, job: null, reason: 'that is not a job reference' };
  if (!dbConfigured()) return { ok: false, job: null, reason: 'the job record is not reachable from this deploy, so nothing was voided' };
  const why = String(reason || '').trim().slice(0, 500);
  if (!why) return { ok: false, job: null, reason: 'a void needs a reason, because a status change nobody can explain is worse than the booking it replaced' };

  try {
    const res = await rpc('sv_job_void', { p_ref: r, p_reason: why, p_actor: String(actor || 'customer').slice(0, 60) });
    if (!res || res.ok !== true) {
      const err = (res && res.error) || 'the database refused the void without saying why';
      console.error(`jobs.voidJob ${r}: REFUSED: ${err}`);
      return { ok: false, job: null, reason: err };
    }
    return { ok: true, replay: Boolean(res.replay), job: res.job || null, reason: String(res.note || 'voided') };
  } catch (e) {
    console.error(`jobs.voidJob ${r}: failed: ${short(e)}`);
    return { ok: false, job: null, reason: short(e) };
  }
}

// ── the one function /api/booking calls ───────────────────────────────────────────────────────

/**
 * Take a normalised booking (lib/booking.mjs `job`) and make it a joined, queryable job row.
 *
 * Everything decided here is decided ONCE and stored: which account owns it, whether it was after
 * hours and why, and which of the four source categories it belongs to. Nothing is derived later.
 *
 * @param {object} job   the object lib/booking.mjs normalize() produced
 * @returns {Promise<object>}  a delivery report, never a throw
 */
export async function recordBooking(job) {
  if (!job || typeof job !== 'object') {
    return { ok: false, landed: false, reason: 'no job was passed to the recorder' };
  }

  // The number that was DIALLED. An explicit line number beats the shop's published number, because
  // on a real Answered line they are usually the same and where they differ the explicit one is the
  // one a caller actually rang.
  const line = String(job.ln || job.sp || '');
  const acct = await resolveAccount(line);

  const bookedAt = job.at ? new Date(job.at) : new Date();
  const ah = afterHoursFact({ at: bookedAt, tz: job.tz, hours: acct.config && acct.config.hours });
  const src = normalizeSource(job.src, { hasCallSid: Boolean(job.cs) });

  const startsAt = job.t ? new Date(job.t) : null;
  const endsAt = (startsAt && !Number.isNaN(startsAt.getTime()))
    ? new Date(startsAt.getTime() + (Number(job.d) || 60) * 60000)
    : null;

  const res = await create({
    job_ref: job.id,
    account_id: acct.account_id,
    caller_name: job.c,
    address: job.a,
    callback: job.cp,
    window_start: startsAt && !Number.isNaN(startsAt.getTime()) ? startsAt.toISOString() : null,
    window_end: endsAt ? endsAt.toISOString() : null,
    trade: acct.trade || '',
    after_hours: ah.after_hours,
    source: src.source,
    call_sid: job.cs,
    details: {
      // The audit trail for every decision above, so a bill can be explained a year from now
      // without re-deriving anything from fields that will have changed by then.
      mode: job.m === 'live' ? 'live' : 'demo',
      after_hours_determined: ah.determined,
      after_hours_basis: ah.basis,
      booked_at: bookedAt.toISOString(),
      tz: ah.tz,
      source_raw: src.source_raw,
      source_categorised: src.categorised,
      shop_name: job.s,
      shop_phone: job.sp,
      line_number: line,
      customer_email: job.ce,
      service: job.w,
      minutes: Number(job.d) || null,
      notes: job.n,
      account_match: acct.account_id ? 'matched on the dialled number' : (acct.reason || 'not matched'),
    },
  });

  // The four pieces lib/meter.mjs requires before a booking is billable at all. Reported here so an
  // operator can see WHY a job was free without opening the ledger. /terms: "Anything less is free.
  // That is the whole definition."
  const pieces = {
    name: Boolean(job.c), address: Boolean(job.a), callback: Boolean(job.cp),
    window: Boolean(startsAt && !Number.isNaN(startsAt.getTime())),
  };
  const missingPieces = Object.entries(pieces).filter(([, v]) => !v).map(([k]) => k);

  const link = jobLink(job.id);

  return {
    ok: res.ok,
    landed: res.landed,
    replay: res.replay,
    reason: res.reason,
    job_ref: job.id,
    account_id: acct.account_id,
    account_matched: Boolean(acct.account_id),
    orphan_warning: acct.account_id
      ? ''
      : `This job has no owning account, so it will NOT appear in any customer portal: ${acct.reason}`,
    after_hours: ah.after_hours,
    after_hours_determined: ah.determined,
    after_hours_basis: ah.basis,
    source: src.source,
    source_raw: src.source_raw,
    billable_pieces_missing: missingPieces,
    billable_note: missingPieces.length
      ? `Missing ${missingPieces.join(', ')}. A job is booked when it has a name, an address, a callback number and a confirmed window, so this one is free.`
      : 'All four pieces recorded.',
    link: link || '',
    link_note: link ? '' : 'no signing key is configured, so this job has no portal link. Set ANSWERED_JOB_KEY.',
  };
}
