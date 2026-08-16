// jobs.mjs : the customer's side of a booked job. Links, prices, channels, and the void.
//
// WHY THIS FILE EXISTS, IN ONE SENTENCE: a booked job is the only thing this company sells, so the
// customer has to be able to see one, check it, and refuse it, and none of those three should
// require a password.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE ARCHITECTURE, AND THE TWO RULINGS THAT FORCED IT
//
// 1. LINK FIRST, LOGIN OPTIONAL. David's standing law is no gated processes and no lengthy
//    processes. A login is a gate. So every notification carries a SIGNED LINK that opens that one
//    job with no account and no password, and the login exists only to see everything at once.
//    The token IS the credential, which is the same shape the Parley deal link already runs on.
//
// 2. A CALL IS THE WRONG DEFAULT. "There's a reason they're hiring us. It's because they don't
//    answer the phone." Our customer is definitionally the person who does not pick up, so the
//    default channels are EMAIL (automatic, not a toggle) and TEXT (a default that a carrier is
//    currently blocking). A phone call is opt-in and, by default, after hours only. That ordering
//    is not copy in this file, it is the shape of `account_notify` and of `notifyBooked` below.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THREE THINGS THIS FILE REFUSES TO DO
//
//   A. INVENT A JOB. Every value on a receipt comes from a row that a caller actually created.
//      Where a field was never captured, the reader is told it was never captured. There is no
//      sample job, no placeholder row and no demo customer anywhere in this lane.
//   B. PROMISE A TEXT. `notifyBooked` builds the SMS completely and hands it to lib/outbox.mjs,
//      which refuses to send while the A2P 10DLC campaign is unapproved and says so in words.
//      Turning texting on is a change to ANSWERED_SMS_ENABLED, not a change to this code.
//   C. RE-SUM MONEY THAT THE LEDGER ALREADY DECIDED. If a job carries a billing_event, the
//      receipt prints THAT, because it is the stored vetted figure. Only when no charge exists
//      does it print the published price, and then it says which one it is printing and why.

import crypto from 'node:crypto';
import * as bk from './booking.mjs';
import * as meter from './meter.mjs';
import * as out from './outbox.mjs';
import { rpc, dbConfigured } from './db.mjs';
import { accountForNumber } from './accounts.mjs';
// The facts that decide what a job IS and what it COSTS, settled once at creation. Owned by
// @LANE-JOBREC so the two lanes that met on this filename do not have to hold each other's file
// open. See the repair note on recordJob below for the four defects this import closes.
import * as facts_ from './job-facts.mjs';

export { dbConfigured };

// ── the signed link ──────────────────────────────────────────────────────────────────────────
//
// The receipt token is a CAPABILITY over one job reference. It deliberately does not carry the
// job's contents, unlike the /job/<token> link the homeowner gets, and the reason is the whole
// point of this surface: a receipt has to show the LIVE status. A job that was voided an hour ago
// must open as voided. A payload baked into a URL cannot do that, so this one names the row and
// the row is read on every open.
//
// ★ DOMAIN SEPARATION IS NOT DECORATION. The same HMAC key signs the homeowner's /job/ token, and
// those tokens are handed to members of the public. Mixing the two label spaces would let a
// homeowner's booking link be replayed as a contractor's receipt link, which carries a control
// that can void a charge. The label goes INSIDE the MAC input, so a token minted for one purpose
// cannot verify for another even with the key in hand.

const RECEIPT_LABEL = 'answered.receipt.v1';
const FEED_LABEL = 'answered.feed.v1';
const MAX_TOKEN_CHARS = 900;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const key = () => bk.signingKey();

/** No key means no links at all. An unsigned receipt link is a forged void with extra steps. */
export const canSign = () => Boolean(key());

const mac = (label, payload) =>
  b64u(crypto.createHmac('sha256', key()).update(`${label}|${payload}`).digest());

function mintToken(label, prefix, claims) {
  if (!canSign()) throw new Error('jobs: no signing key (set ANSWERED_BOOKING_KEY)');
  const payload = b64u(Buffer.from(JSON.stringify(claims), 'utf8'));
  const token = `${prefix}.${payload}.${mac(label, payload)}`;
  if (token.length > MAX_TOKEN_CHARS) throw new Error(`jobs: token is ${token.length} characters, cap is ${MAX_TOKEN_CHARS}`);
  return token;
}

function readToken(label, prefix, token) {
  if (!canSign()) return null;
  const t = String(token || '');
  if (!t || t.length > MAX_TOKEN_CHARS) return null;
  const parts = t.split('.');
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  const [, payload, sig] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(sig)) return null;
  const want = Buffer.from(mac(label, payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' && claims.v === 1 ? claims : null;
  } catch { return null; }
}

/**
 * The link that goes in every notification.
 * @param {string} ref        jobs.job_ref
 * @param {string} [accountId] bind the receipt to the account that owned the job at mint time
 */
export const mintReceipt = (ref, accountId) => mintToken(RECEIPT_LABEL, 'r1', {
  v: 1, r: String(ref), ...(accountId ? { a: String(accountId) } : {}), i: Date.now(),
});

/** { r, a?, i } or null. Never throws. A forged token and a typo land in the same place. */
export const readReceipt = (token) => {
  const c = readToken(RECEIPT_LABEL, 'r1', token);
  return c && typeof c.r === 'string' && c.r ? c : null;
};

/**
 * The calendar feed key. A calendar app cannot carry a session cookie, so the URL is the
 * credential, exactly like Google Calendar's own secret address. It names an account and nothing
 * else: no customer names, no addresses, nothing that reads as data on its own.
 */
export const mintFeedKey = (accountId) => mintToken(FEED_LABEL, 'f1', { v: 1, a: String(accountId) });

export const readFeedKey = (token) => {
  const c = readToken(FEED_LABEL, 'f1', token);
  return c && /^[0-9a-f-]{36}$/i.test(String(c.a || '')) ? c.a : null;
};

export const siteOrigin = () => bk.siteOrigin();
export const receiptUrl = (token) => `${siteOrigin()}/j/${token}`;
export const feedUrl = (token) => `${siteOrigin()}/portal/feed.ics?k=${encodeURIComponent(token)}`;

// ── the rows ─────────────────────────────────────────────────────────────────────────────────
//
// Signatures verified against the live database on 2026-08-14 rather than against the handoff
// note, which described `sv_jobs_for_account(account_id)` with one argument. It takes three.

export const createJob = (row) => rpc('sv_job_create', { p_row: row });

export const jobsForAccount = (accountId, status = null, limit = 200) =>
  rpc('sv_jobs_for_account', { p_account_id: accountId, p_status: status, p_limit: limit });

export const jobByRef = (ref) => rpc('sv_job_by_ref', { p_ref: ref });

/**
 * ★ REPAIRED 2026-08-14 by @LANE-JOBREC. This was `rpc('sv_job_void', { p_reason: reason || '' })`,
 * a straight pass-through, and MEASURED against the live database an empty reason is ACCEPTED:
 * sv_job_void does `nullif(p_reason,'')` and voids the row anyway, leaving status='voided' with
 * void_reason NULL. A booking somebody was charged for, cancelled by nobody, for nothing.
 * portal.mjs never sends an empty reason, but a rule only one caller keeps is not a rule, so it is
 * enforced at the door now. The return shape is unchanged: portal.mjs's reads of `r.ok`,
 * `r.replay` and `r.error` all still work, and this no longer throws.
 */
export const voidJob = (ref, reason, actor) => facts_.voidChecked(ref, reason, actor);

export const notifyPrefs = (accountId) => rpc('sv_account_notify', { p_account_id: accountId });

export const saveNotifyPrefs = (accountId, patch, author) =>
  rpc('sv_account_notify_save', { p_account_id: accountId, p_patch: patch, p_author: author || 'owner' });

/**
 * The defaults, in code, for the one case the database cannot answer: it is unreachable. Printing
 * these while saying the account could not be read is honest; printing them as if they were the
 * customer's saved choices would not be, so every caller of this passes `stored:false` through to
 * the page and the page says so.
 */
export const DEFAULT_PREFS = Object.freeze({
  stored: false, email_extra: [], sms_on: true, sms_to: null,
  call_on: false, call_after_hours_only: true, call_to: null,
});

// ── what a job is worth, and to whom ─────────────────────────────────────────────────────────

/**
 * The four pieces, quoted from /terms through lib/meter.mjs: "A job is booked when it has a name,
 * an address, a callback number and a confirmed window. Anything less is free."
 *
 * This is the single most useful thing on a receipt, because it is the definition the customer is
 * being billed against, checked against the row in front of him, with the missing ones named.
 */
export function fourPieces(job) {
  const j = job || {};
  const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';
  return [
    { key: 'name', label: 'A name', value: j.caller_name || '', ok: has(j.caller_name) },
    { key: 'address', label: 'An address', value: j.address || '', ok: has(j.address) },
    { key: 'callback', label: 'A callback number', value: j.callback || '', ok: has(j.callback) },
    {
      key: 'window',
      label: 'A confirmed window',
      value: j.window_start || '',
      ok: has(j.window_start) && has(j.window_end),
    },
  ];
}

/**
 * What this one job costs, and the sentence that explains it.
 *
 * ★ THE LEDGER WINS. `charge` arrives from sv_job_by_ref and is the stored, vetted figure that
 * billing actually recorded. When it exists this returns it verbatim. Only when it does not does
 * this fall back to the published price book, and then `source` says 'published' so the page can
 * say out loud that no charge is on the record yet. The two must never be printed as if they were
 * the same kind of fact.
 */
export function priceOf(job, charge) {
  const j = job || {};
  if (charge && Number.isFinite(Number(charge.cents))) {
    return {
      source: 'ledger',
      cents: Number(charge.cents),
      billable: Number(charge.cents) > 0,
      state: String(charge.state || ''),
      label: meter.CATALOG[charge.kind] ? meter.CATALOG[charge.kind].label : String(charge.kind || 'charge'),
      reason: String(charge.reason || ''),
      missing_pieces: [],
    };
  }

  const pieces = fourPieces(j);
  const evidence = {};
  for (const p of pieces) evidence[p.key] = p.ok ? (p.value || 'recorded') : '';
  const kind = j.after_hours ? 'booked_job_after_hours' : 'booked_job';
  const r = meter.rate({ kind, evidence, booked_at: j.created_at }, {});
  return {
    source: 'published',
    cents: r.cents,
    billable: Boolean(r.billable),
    state: '',
    label: r.label || '',
    reason: r.reason || '',
    missing_pieces: r.missing_pieces || [],
  };
}

export const usd = meter.usd;
export const CAP_CENTS = meter.DEFAULT_CAP_CENTS;

// ── time, said the way a person says it ──────────────────────────────────────────────────────

export const DEFAULT_TZ = bk.DEFAULT_TZ;

const usableZone = (tz) => {
  const z = String(tz || '').trim();
  if (!z) return '';
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }).format(new Date()); return z; } catch { return ''; }
};

const fmt = (date, tz, opts) => {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(date); }
  catch { return new Intl.DateTimeFormat('en-US', opts).format(date); }
};

/**
 * { day, window, zone, start, end, known } for a job's arrival window.
 *
 * `known:false` is a first class answer and it is common: a message taken at 2am often has no
 * agreed time yet. The page prints "no window was agreed" rather than inventing one, and the
 * price engine independently rates that job as free, because a window is one of the four pieces.
 */
export function windowParts(job, tz) {
  const zone = usableZone(tz) || usableZone((job && job.details && job.details.tz)) || DEFAULT_TZ;
  const s = job && job.window_start ? new Date(job.window_start) : null;
  const e = job && job.window_end ? new Date(job.window_end) : null;
  if (!s || Number.isNaN(s.getTime())) {
    return { known: false, day: '', window: '', zone: '', start: null, end: null };
  }
  const end = e && !Number.isNaN(e.getTime()) ? e : new Date(s.getTime() + 3600000);
  let abbr = '';
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(s);
    abbr = (p.find((x) => x.type === 'timeZoneName') || {}).value || '';
  } catch { abbr = ''; }
  return {
    known: true,
    day: fmt(s, zone, { weekday: 'long', month: 'long', day: 'numeric' }),
    window: `${fmt(s, zone, { hour: 'numeric', minute: '2-digit' })} to ${fmt(end, zone, { hour: 'numeric', minute: '2-digit' })}`,
    zone: abbr,
    start: s,
    end,
  };
}

export const prettyPhone = bk.prettyPhone;
export const e164 = bk.e164;

/** Whether a job's window has already passed. Used for filtering, never for changing a price. */
export const isPast = (job) => {
  const w = job && (job.window_end || job.window_start);
  if (!w) return false;
  const t = new Date(w).getTime();
  return Number.isFinite(t) && t < Date.now();
};

// ── the void ─────────────────────────────────────────────────────────────────────────────────
//
// ★ A VOID IS A STATUS CHANGE WITH A REASON, NEVER A DELETE. sv_job_void sets the status, records
// the reason and the actor, and writes a crm_activity row. The job stays readable forever, which
// is the point: a customer who disputed a charge and a customer who never had the job both look
// identical in a table that deletes.
//
// ★ AND THE PROMISE STOPS EXACTLY WHERE THE CODE DOES. sv_job_void's own return note says the
// attached charge is voided separately through the billing ledger, and no trigger does it today
// (measured: zero triggers on public.jobs). So this lane emails a person, and the receipt says a
// person settles the charge. It does not say "you will not be charged", because nothing in this
// system would make that true.

export const VOID_REASONS = Object.freeze([
  { key: 'not_a_job', label: 'This was not a real job' },
  { key: 'duplicate', label: 'We already had this one' },
  { key: 'wrong_details', label: 'The details are wrong' },
  { key: 'customer_cancelled', label: 'The customer cancelled' },
  { key: 'outside_area', label: 'It is outside our area' },
  { key: 'not_our_work', label: 'It is not work we do' },
  { key: 'other', label: 'Something else' },
]);

export const voidReasonLabel = (k) => {
  const hit = VOID_REASONS.find((r) => r.key === k);
  return hit ? hit.label : '';
};

// ── the seam booking.mjs is waiting on ───────────────────────────────────────────────────────

/**
 * Turn a signed booking into a row in `jobs`, owned by the account whose LINE was dialled.
 *
 * lib/booking.mjs now carries `ln`, the number the caller actually rang, with a comment pointing
 * at this function. This is that function. One import and one call in netlify/functions/booking.mjs
 * fills every portal in the product:
 *
 *     import { recordJob } from './lib/jobs.mjs';
 *     const owned = await recordJob(job, token).catch((e) => ({ ok: false, reason: e.message }));
 *
 * ★ IT NEVER GUESSES AN OWNER. With no `ln`, or with a number no account owns, the job is recorded
 * with a null account_id and `owned:false` comes back. An unowned job is a true and useful state:
 * it exists, it is auditable, and it simply does not appear in anybody's portal. Guessing would
 * put one business's customer list in another business's login.
 */
/*
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ★ REPAIRED 2026-08-14 by @LANE-JOBREC, ADDITIVELY. Everything above and below is the portal
 *   lane's; this function now delegates its FACTS to lib/job-facts.mjs. Four defects, all silent,
 *   all measured against the live schema rather than inferred:
 *
 *   1. `source: j.src || 'voice'` fed FREE TEXT at a CHECK constraint. `jobs_source_check` allows
 *      only voice|form|operator|api, and /api/booking's `src` is whatever the caller typed
 *      (measured live: "lane-jobrec-baseline"). The violation comes back as an HTTP 200 with
 *      ok:false, so the row silently never existed. Now categorised, with the raw claim kept in
 *      details.source_raw so nothing is lost.
 *
 *   2. `after_hours: Boolean(j.after_hours)` read a field lib/booking.mjs normalize() NEVER SETS.
 *      It was therefore false on every job ever written, so the $49 after-hours price could not be
 *      recorded at all. It is now a measured fact against the owner's posted hours, on the owner's
 *      own clock, frozen at creation, with the reasoning stored beside it.
 *
 *   3. `trade: j.trade || null` read another field normalize() never sets. The trade comes from
 *      the account.
 *
 *   4. `const saved = await createJob(row); return { ok: true, ... }` reported SUCCESS for a
 *      refused write, because sv_job_create answers its refusals with HTTP 200 and {ok:false}.
 *      `landed` is now read out of the body.
 *
 *   The return shape is unchanged and additive: ok / owned / account_id / job / receipt / reason
 *   all still mean what they meant. `recordBooking` is exported as an alias at the end of this
 *   file because netlify/functions/booking.mjs was committed calling that name.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
export async function recordJob(job, token) {
  // ★ EVERY RETURN PATH CARRIES THE SAME KEYS. A function whose shape changes with its outcome
  // makes its caller read `undefined` on exactly the paths that matter most, which is how
  // booking.mjs came to fire its "no owning account" warning on every booking today.
  const bail = (reason) => ({
    ok: false, landed: false, replay: false, owned: false, account_id: null, job: null,
    receipt: '', reason, orphan_warning: reason,
    after_hours: false, after_hours_determined: false, after_hours_basis: reason,
    after_hours_tz: '', after_hours_tz_source: '', source: '', source_raw: '',
    billable_pieces_missing: [], billable_note: '',
  });
  if (!dbConfigured()) return bail('the jobs database is not configured on this deploy, so this booking has no queryable record and will not appear in any portal');
  const j = job || {};
  if (!j.id) return bail('a job needs its reference before it can be recorded');

  const facts = await facts_.factsFor(j);
  const row = { ...facts.row };
  // The homeowner's snapshot link, which is the portal lane's field and stays theirs.
  row.details = { ...row.details, customer_link: token ? bk.jobUrl(token) : '' };

  const saved = await facts_.createChecked(row);
  const owned = Boolean(facts.account.account_id);

  // An unowned job is invisible to sv_jobs_for_account, which walks account_id. Say it at the
  // moment it is created rather than letting somebody find it later underneath a confident empty
  // state, which is the orphan defect that already cost this estate a billing panel.
  if (saved.landed && !owned) console.warn(`jobs.recordJob ${j.id}: recorded with NO OWNING ACCOUNT. ${facts.account.reason}`);

  return {
    ok: saved.ok,
    landed: saved.landed,
    replay: saved.replay,
    owned,
    account_id: facts.account.account_id,
    job: saved.job,
    receipt: canSign() ? receiptUrl(mintReceipt(j.id, facts.account.account_id || undefined)) : '',
    reason: saved.ok
      ? (owned ? saved.reason : 'no account owns the number this call came in on, so the job is recorded unowned')
      : saved.reason,
    orphan_warning: owned ? '' : `This job has no owning account, so it will not appear in any customer portal: ${facts.account.reason}`,
    after_hours: facts.after_hours.after_hours,
    after_hours_determined: facts.after_hours.determined,
    after_hours_basis: facts.after_hours.basis,
    after_hours_tz: facts.after_hours.tz,
    after_hours_tz_source: facts.tz_source,
    source: facts.source.source,
    source_raw: facts.source.source_raw,
    billable_pieces_missing: facts.pieces,
    billable_note: facts.pieces.length
      ? `Missing ${facts.pieces.join(', ')}. A job is booked when it has a name, an address, a callback number and a confirmed window, so this one is free.`
      : 'All four pieces recorded.',
  };
}

/**
 * The name netlify/functions/booking.mjs imports. Two lanes built this seam on the same afternoon
 * and published two names for it; both resolve to one implementation so neither caller can break.
 */
export const recordBooking = recordJob;

// ── telling the customer ─────────────────────────────────────────────────────────────────────

/**
 * Can this deploy place a phone call at all? Measured from the environment, no network calls, so
 * it is safe to render into a settings page.
 *
 * ★ THIS IS WHY THE CALL TOGGLE IS ALLOWED TO EXIST. A control that cannot act must never render
 * as if it can. The estate has already paid for that lesson twice, with a play button over a
 * missing mp4 and with a dial control that survived a dead line. So the settings page asks this
 * function and renders the call option disabled, with the reason in words, whenever it says no.
 * When @ANSWERED-RESEARCH lifts ANSWERED_AUTOPILOT_KILL the control turns itself on with no deploy.
 */
export function callChannelStatus() {
  const killed = String(process.env.ANSWERED_AUTOPILOT_KILL || '').trim() !== '';
  const creds = Boolean(process.env.TWILIO_API_SID && process.env.TWILIO_API_SECRET && process.env.TWILIO_ACCOUNT_SID);
  // ★ DELIBERATELY NOT ANSWERED_DEMO_NUMBER. That line answers as Riley, the public demo
  // receptionist. Using it as the caller ID for a customer's private booking call would mean the
  // number in his recent-calls list, the one he rings back at 2am, is a demo. An explicit
  // notify-from or nothing.
  const from = String(process.env.ANSWERED_NOTIFY_FROM || process.env.ANSWERED_SMS_FROM || '').trim();
  let reason = '';
  if (killed) reason = 'Calling is switched off on this deploy, so nothing can dial. That is a safety switch an operator sets, not a fault with your account.';
  else if (!creds) reason = 'The phone credentials are not set on this deploy, so nothing can dial.';
  else if (!from) reason = 'We do not have a number to call you from yet, so nothing can dial. Setting one up is a step a person does by hand.';
  return { ready: !killed && creds && Boolean(from), killed, has_credentials: creds, from, reason };
}

/** Does this job qualify for a call under the customer's own rule? */
export function wantsCall(job, prefs) {
  const p = prefs || DEFAULT_PREFS;
  if (!p.call_on) return { want: false, why: 'a call is switched off for this account' };
  if (p.call_after_hours_only && !(job && job.after_hours)) {
    return { want: false, why: 'this account only wants a call after hours, and this job was booked in normal hours' };
  }
  return { want: true, why: '' };
}

const lines = (job, account, url, price) => {
  const w = windowParts(job, account && account.timezone);
  const service = (job.details && job.details.service) || 'a job';
  return {
    what: service,
    who: job.caller_name || 'no name was given',
    where: job.address || 'no address was given',
    call: job.callback || '',
    when: w.known ? `${w.day}, ${w.window}${w.zone ? ` ${w.zone}` : ''}` : 'no window was agreed on the call',
    money: price.cents > 0 ? usd(price.cents) : 'nothing',
    url,
  };
};

/**
 * Tell the business a job was booked, on the channels it actually asked for.
 *
 * Returns one result per channel, each saying what happened, because a fan-out that reports a
 * single boolean is how a silently dead channel survives for months. Email is awaited and is the
 * one that decides `ok`. The others are reported and never fatal.
 */
export async function notifyBooked({ job, account, prefs, receipt }) {
  const p = prefs || DEFAULT_PREFS;
  const token = receipt || (canSign() ? mintReceipt(job.job_ref, account && account.id) : '');
  const url = token ? receiptUrl(token) : '';
  const price = priceOf(job, null);
  const L = lines(job, account, url, price);

  // ── EMAIL: automatic, and deliberately not a preference ───────────────────────────────────
  const to = [account && account.owner_email, ...(Array.isArray(p.email_extra) ? p.email_extra : [])]
    .map((s) => String(s || '').trim()).filter((s) => s.includes('@'));

  const rows = [
    ['What', L.what],
    ['When', L.when],
    ['Who', L.who],
    ['Where', L.where],
    ['Call them on', L.call || 'no callback number was given'],
    ['What it costs you', price.cents > 0 ? usd(price.cents) : 'nothing, and the page says why'],
    ['Job number', job.job_ref],
  ];

  const emailRes = await out.email({
    to,
    subject: `Job booked: ${L.what} for ${L.who}`,
    html: out.shell({
      title: 'A job was booked on your line.',
      intro: `We answered your phone and booked this. Open it to check it, and to say no if it is wrong.`,
      rows,
      cta: url ? { href: url, label: 'Open this job' } : null,
      footer: 'The link opens without a password. If anything on it is wrong, there is a button on that page that voids the job and tells us why.',
    }),
    text: [
      'A job was booked on your line.',
      '',
      ...rows.map(([k, v]) => `${k}: ${v}`),
      '',
      url ? `Open it: ${url}` : '',
      'The link opens without a password. If anything is wrong, void it on that page and tell us why.',
    ].filter(Boolean).join('\n'),
  });

  // ── TEXT: built in full, dark behind the carrier ──────────────────────────────────────────
  // Nothing about this path is a stub. outbox.sms does the suppression check, picks the sender,
  // and refuses while ANSWERED_SMS_ENABLED is off, with the A2P sentence as the reason.
  const smsTo = e164(p.sms_to || (account && account.owner_phone) || '');
  const smsRes = p.sms_on === false
    ? { ok: false, skipped: true, reason: 'this account switched text messages off' }
    : await out.sms({
      to: smsTo,
      transactional: true,
      body: `Answered booked you a job. ${L.what} for ${L.who}. ${L.when}. ${url}`,
    });

  // ── CALL: opt-in, and gated on whether a call can happen at all ───────────────────────────
  const want = wantsCall(job, p);
  const gate = callChannelStatus();
  const callRes = !want.want
    ? { ok: false, skipped: true, reason: want.why }
    : !gate.ready
      ? { ok: false, skipped: true, reason: gate.reason }
      : await callBooked({ job, account, prefs: p, url });

  return {
    ok: emailRes.ok,
    receipt: url,
    channels: { email: { ...emailRes, to }, sms: smsRes, call: callRes },
  };
}

/**
 * Place the opt-in call. Reached only when callChannelStatus().ready is true, which today it is
 * not, because ANSWERED_AUTOPILOT_KILL is set on this project.
 *
 * ★ THE WORDS ARE SPOKEN BEFORE ANY <Gather> EXISTS ON THE DOCUMENT. @ANSWERED-RESEARCH measured
 * the failure this avoids: a <Say> nested inside a <Gather> is silenced the instant the other
 * party speaks, and their entire spoken output on a real call was the word "Hi" while the AI
 * disclosure and the recording notice never happened. Everything that must be heard here is in
 * bare <Say> elements and there is no <Gather> in the document at all.
 */
export async function callBooked({ job, account, prefs, url }) {
  const to = e164((prefs && prefs.call_to) || (account && account.owner_phone) || '');
  if (!to) return { ok: false, skipped: true, reason: 'no number to call you on is on file' };

  // Do not contact, fail closed, exactly as the text path does it.
  try {
    const db = await import('./db.mjs');
    const ctx = await db.dialContext(to);
    if (ctx && ctx.suppressed) return { ok: false, skipped: true, suppressed: true, reason: 'this number is on the do-not-contact list, so nothing was dialled' };
  } catch (e) {
    return { ok: false, skipped: true, reason: 'the do-not-contact list could not be read, so nothing was dialled' };
  }

  const gate = callChannelStatus();
  if (!gate.ready) return { ok: false, skipped: true, reason: gate.reason };

  try {
    const twilio = await import('./twilio-rest.mjs');
    const call = await twilio.createCall({
      To: to,
      From: gate.from,
      // ★ A SIGNED CAPABILITY, NOT A BARE REFERENCE. lib/twilio-webhook.mjs degrades to an
      // AccountSid cross-check when TWILIO_AUTH_TOKEN is absent. ★ CORRECTED 2026-08-16: the token
      // is NOT absent on this project — measured on production, a wrong-signed POST is refused with
      // "signature mismatch" by a verifier that fails closed, which is only possible if it is set.
      // The receipt-token design below stands on its own as defence in depth.
      // so Twilio's own signature cannot guard this URL. A receipt token can: only this server
      // holds the key that mints one, and the endpoint refuses anything else.
      Url: `${siteOrigin()}/api/portal/job-call?k=${encodeURIComponent(mintReceipt(job.job_ref, account && account.id))}`,
      Method: 'GET',
      Timeout: 20,
      MachineDetection: 'Enable',
    });
    return { ok: true, sid: call.sid, status: call.status || '', to, note: 'Twilio accepted the call. Acceptance is not an answer.' };
  } catch (e) {
    const why = String((e && e.message) || e).slice(0, 200);
    console.error(`jobs: booked-call failed: ${why}`);
    return { ok: false, reason: why };
  }
}

/**
 * The words that call speaks. Bare <Say> only, disclosure first, no <Gather> anywhere.
 * Exported so it can be asserted on directly: the estate's rule is to assert WHERE the words sit,
 * not merely that they exist somewhere in the file.
 */
export function jobCallTwiml(job, account) {
  const w = windowParts(job, account && account.timezone);
  const service = (job && job.details && job.details.service) || 'a job';
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  const say = [
    'This is an automated call from Answered. You are listening to a recorded assistant, not a person.',
    `A job was booked on your line. ${service}, for ${job.caller_name || 'a caller who did not give a name'}.`,
    w.known ? `The window is ${w.day}, ${w.window}.` : 'No window was agreed on the call.',
    job.address ? `The address is ${job.address}.` : 'No address was given.',
    'The full details and a button to cancel it are in the email and text we just sent you.',
    'You asked us to call you about booked jobs. You can switch that off in your portal at any time. Goodbye.',
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${
    say.map((s) => `  <Say voice="Polly.Matthew">${esc(s)}</Say>`).join('\n')
  }\n  <Hangup/>\n</Response>\n`;
}

// ── the calendar feed ────────────────────────────────────────────────────────────────────────

const icsEsc = (s) => String(s == null ? '' : s)
  .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/**
 * Every booked job on one account as a subscribable calendar.
 *
 * Voided jobs are included with STATUS:CANCELLED rather than dropped, because a calendar that
 * silently loses an event leaves a stale copy on the phone forever. CANCELLED is how a calendar
 * app is told to take it off the day.
 */
export function feedIcs(jobs, account) {
  const list = Array.isArray(jobs) ? jobs : [];
  const name = (account && account.business_name) || 'Answered';
  const head = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Answered//Booked jobs//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEsc(`${name} jobs`)}`,
    'X-PUBLISHED-TTL:PT30M',
    'REFRESH-INTERVAL;VALUE=DURATION:PT30M',
  ];
  const body = [];
  for (const j of list) {
    const w = windowParts(j, account && account.timezone);
    if (!w.known) continue;   // an event with no time is not an event; it stays on the web page
    const service = (j.details && j.details.service) || 'Job';
    const voided = j.status === 'voided';
    body.push(
      'BEGIN:VEVENT',
      `UID:${icsEsc(j.job_ref)}@answered.reddenda.com`,
      `DTSTAMP:${stamp(j.created_at || new Date())}`,
      `DTSTART:${stamp(w.start)}`,
      `DTEND:${stamp(w.end)}`,
      `SUMMARY:${icsEsc(`${voided ? 'VOIDED: ' : ''}${service}${j.caller_name ? ` for ${j.caller_name}` : ''}`)}`,
      `DESCRIPTION:${icsEsc([
        `Booked by Answered. Job ${j.job_ref}.`,
        j.caller_name ? `Who: ${j.caller_name}` : '',
        j.callback ? `Call them on: ${prettyPhone(j.callback)}` : 'No callback number was given.',
        j.address ? `Where: ${j.address}` : 'No address was given.',
        (j.details && j.details.notes) ? `Notes: ${j.details.notes}` : '',
        voided ? `This job was voided${j.void_reason ? `: ${j.void_reason}` : ''}.` : '',
      ].filter(Boolean).join('\n'))}`,
      j.address ? `LOCATION:${icsEsc(j.address)}` : '',
      `STATUS:${voided ? 'CANCELLED' : 'CONFIRMED'}`,
      'SEQUENCE:0',
      'TRANSP:OPAQUE',
      'END:VEVENT',
    );
  }
  const all = [...head, ...body.filter(Boolean), 'END:VCALENDAR'];
  return `${all.map(bk.foldLine).join('\r\n')}\r\n`;
}
