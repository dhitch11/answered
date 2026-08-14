// GET /api/calendar/<token>.ics — an account's jobs, in the calendar they already use.
//
// This is the integration nobody has to write. A contractor pastes one address into Google
// Calendar, Apple Calendar or Outlook, and every job the line books shows up beside his kid's
// soccer game, on the phone in his pocket, with no app, no account and no OAuth screen. The token
// in the path IS the credential, which is the same pattern as the Parley deal link and the reason
// this works without a login.
//
// ── THE ONE THING ABOUT A FEED THAT IS NOT LIKE ANY OTHER ENDPOINT ───────────────────────────
//
// AN EMPTY 200 IS NOT A NEUTRAL ANSWER. IT IS A DELETE.
//
// Every other surface in this repo can degrade to an honest empty state, and should. A calendar
// subscription cannot. When Google or Apple fetches this feed and gets a valid calendar with no
// events in it, that is not "we do not know yet": it is an instruction, and the client obeys it by
// removing every event it previously held. So this file draws a line that the rest of the estate
// does not have to:
//
//   the account genuinely has no jobs        200, a valid empty VCALENDAR. True, and safe.
//   the jobs could not be READ               503, never a 200. The client keeps what it has.
//   the RPC does not exist yet               503, with that as the stated reason.
//   the token is forged, or replaced         404. Nothing is served and nothing is deleted.
//
// The honest empty state for a feed is a 503 when we do not know, and an empty calendar only when
// we know it is empty. Those are two different sentences and this file says whichever one is true.
//
// ── WHAT MAKES A FEED PARSE EVERYWHERE, AND WHY EACH ONE MATTERS ─────────────────────────────
//
// CRLF on every line including the last, folding at 75 OCTETS on a code point boundary, no METHOD
// property (that is iTIP, and a subscription is not a message), UTC times with a trailing Z so no
// VTIMEZONE block is needed, TEXT values escaping backslash semicolon comma and newline and
// nothing else, REFRESH-INTERVAL for the clients that read RFC 7986 and X-PUBLISHED-TTL for the
// ones that do not. All of that lives in lib/notify-prefs.mjs so the single-job file that
// lib/booking.mjs writes and this whole-account feed cannot drift apart.
//
// ── A VOID STAYS ─────────────────────────────────────────────────────────────────────────────
//
// A voided job is served as STATUS:CANCELLED with the reason, never dropped. Dropping it leaves a
// stale copy on the phone of the person who subscribed, which is the one outcome a cancellation
// must not produce.

import crypto from 'node:crypto';
import {
  readCalendarToken, calendarKey, prefsOf, calendarFeed, jobEvent, receiptToken, receiptUrl,
  probeLink, priceFor, siteOrigin, DEFAULT_TZ,
} from './lib/notify-prefs.mjs';
import { getAccount, dbConfigured } from './lib/accounts.mjs';
// ★ THE JOBS READER IS IMPORTED, NOT REWRITTEN, AND IT COST ME A MEASUREMENT TO LEARN WHY.
// I coded `rpc('sv_jobs_for_account', { p_account_id })` from the handoff note. Against the live
// database that returns PostgREST's PGRST202, because the function takes THREE arguments
// (p_account_id, p_status, p_limit) and PostgREST resolves a function by name AND parameter list.
// My 503 then blamed a missing table for what was a wrong call. @LANE-JOBREC's lib/jobs.mjs owns
// this door and already carries the correction, so this reads through it: one birth, no drift.
import { jobsForAccount } from './lib/jobs.mjs';

const MAX_EVENTS = 2000;

const HEADERS = {
  'Content-Type': 'text/calendar; charset=utf-8',
  'Content-Disposition': 'inline; filename="answered-jobs.ics"',
  // `private` keeps it out of every shared cache; `no-cache` still lets the subscriber's own
  // client revalidate with If-None-Match, which is how a calendar app polls politely.
  'Cache-Control': 'private, no-cache, max-age=0',
  'Netlify-CDN-Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

/**
 * Errors are text/plain, never a calendar. A client handed a 404 shows the subscriber an error and
 * keeps the events it has. A client handed an empty calendar deletes them, so an error must never
 * wear a calendar's content type.
 */
const problem = (status, text, extra = {}) => new Response(`${text}\n`, {
  status,
  headers: {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'private, no-store',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Referrer-Policy': 'no-referrer',
    ...extra,
  },
});

/** Whatever the RPC hands back, as an array. Never invents a row, never throws on a shape. */
function asJobs(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.jobs)) return raw.jobs;
  if (raw && Array.isArray(raw.rows)) return raw.rows;
  if (raw && typeof raw === 'object' && raw.job_ref) return [raw];
  return [];
}

/**
 * PostgREST answers a call to a function it does not have with a 404 carrying PGRST202, and
 * lib/db.mjs turns that into a thrown Error whose message begins "db <fn> 404". Telling that apart
 * from a database that is down matters, because they are different sentences to an operator and
 * the same 503 to a calendar client.
 */
function whyUnreadable(e) {
  const m = String((e && e.message) || e);
  if (/\b404\b/.test(m) || /PGRST202/.test(m)) {
    // PGRST202 means PostgREST found no function matching that NAME AND THAT ARGUMENT LIST, so it
    // covers both "the jobs table is not deployed yet" and "this code called it wrongly". Saying
    // only the first would be blaming the database for what might be ours. The console line below
    // carries the raw error for whoever has to tell the two apart.
    return 'This feed could not read the jobs list from the database. Nothing has been lost and nothing has been removed from your calendar. Your calendar will try again shortly.';
  }
  if (/\b40[13]\b/.test(m)) {
    return 'This feed is not allowed to read the jobs table on this database right now.';
  }
  return 'The jobs could not be read just now. Nothing has been removed from your calendar. Your calendar will try again shortly.';
}

export default async (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return problem(405, 'This address only answers GET. It is a calendar feed, not an API.', { Allow: 'GET, HEAD' });
  }

  // ★ THE TOKEN IS THE LAST PATH SEGMENT, NOT WHATEVER FOLLOWS A PREFIX I ASSUMED.
  // Two things make prefix stripping the wrong instrument here. A platform is free to rewrite the
  // path it hands a function, and MEASURED on 2026-08-14 in this repo: when a function behind a
  // splat answers 404, Netlify re-runs the request as a static asset lookup and my own route
  // matches every retry in the chain, so this handler is invoked again with `<token>.ics.html`,
  // `<token>.ics.htm`, `<token>.ics/index.html` and `<token>.ics/index.htm`. All four must refuse,
  // and the LAST one's body is what the caller actually receives, which is a trap for anyone
  // debugging a 404 here. Reading the last segment refuses the two carrying an extra path segment
  // outright, and the suffixed pair fail the token check as five dot separated parts instead of
  // three. Nothing mangled can be mistaken for a valid subscription.
  const url = new URL(req.url);
  let raw = '';
  try { raw = decodeURIComponent(url.pathname); } catch { raw = ''; }
  raw = raw.replace(/\/+$/, '').split('/').pop() || '';
  if (!raw || raw === 'calendar') {
    return problem(404, 'This address needs the private calendar link from your account. Sign in at /account to get yours.');
  }

  if (!calendarKey()) {
    console.error('calendar: no signing key configured (ANSWERED_CALENDAR_KEY or ANSWERED_BOOKING_KEY), so no feed can be verified');
    return problem(503, 'Calendar feeds are switched off on this deploy because no signing key is configured. Nothing has been removed from your calendar.', { 'Retry-After': '3600' });
  }

  const claim = readCalendarToken(raw);
  if (!claim) {
    // A forged token, a truncated one, and one minted under a rotated key all land here on
    // purpose. Saying which would tell somebody guessing how close they got.
    return problem(404, 'That calendar link does not work. If you replaced it, use the new one from your account. Nothing has been removed from the calendar you already have.');
  }

  if (!dbConfigured()) {
    console.error('calendar: ANSWERED_DB_* is not configured, so jobs cannot be read');
    return problem(503, 'This feed cannot reach the jobs database right now. Nothing has been removed from your calendar. Your calendar will try again shortly.', { 'Retry-After': '600' });
  }

  let account;
  try { account = await getAccount(claim.account_id); } catch (e) {
    console.error(`calendar: account read failed: ${String((e && e.message) || e).slice(0, 200)}`);
    return problem(503, 'This feed could not check who it belongs to. Nothing has been removed from your calendar. Your calendar will try again shortly.', { 'Retry-After': '600' });
  }
  if (!account || !account.id) {
    return problem(404, 'That calendar link does not point at an account any more.');
  }

  // ── revocation. The owner replaced the link, so the old one stops working. ─────────────────
  const prefs = prefsOf(account);
  if (Number(claim.epoch) !== Number(prefs.calendar_epoch)) {
    return problem(404, 'This calendar link was replaced. Sign in at /account and subscribe to the new one. Nothing has been removed from the calendar you already have.');
  }

  // ── the jobs. An unreadable answer is a 503, never an empty calendar. ──────────────────────
  let rows;
  try {
    rows = asJobs(await jobsForAccount(account.id, null, MAX_EVENTS));
  } catch (e) {
    const why = whyUnreadable(e);
    console.error(`calendar: sv_jobs_for_account failed for ${account.id}: ${String((e && e.message) || e).slice(0, 200)}`);
    return problem(503, why, { 'Retry-After': '900' });
  }

  const usable = rows.filter((j) => j && j.window_start && !Number.isNaN(new Date(j.window_start).getTime()) && (j.job_ref || j.id));
  const untimed = rows.length - usable.length;
  const shown = usable
    .slice()
    .sort((a, b) => new Date(b.window_start) - new Date(a.window_start))
    .slice(0, MAX_EVENTS);

  // ── the receipt link, proven once per feed rather than once per event ──────────────────────
  //
  // The same rule as the send path: a link that does not open is worse than no link. One GET
  // against the real route, cached for ten minutes per container, decides it for the whole file.
  let receiptsWork = false;
  if (shown.length) {
    const sample = receiptToken({ ...shown[0], account_id: account.id });
    if (sample) {
      const probe = await probeLink(receiptUrl(sample), { ttlMs: 10 * 60 * 1000 });
      receiptsWork = probe.ok;
    }
  }

  const events = [];
  for (const j of shown) {
    let receipt = '';
    if (receiptsWork) {
      const t = receiptToken({ ...j, account_id: account.id });
      if (t) receipt = receiptUrl(t);
    }
    const price = priceFor({ ...j }, { account: {} });
    const lines = jobEvent(j, { origin: siteOrigin(), receipt, price });
    if (lines) events.push(...lines);
  }

  const biz = String(account.business_name || '').trim();
  const name = biz ? `${biz} jobs` : 'Answered jobs';
  const desc = [
    biz ? `Every job Answered books for ${biz}.` : 'Every job Answered books for you.',
    'A cancelled job stays here marked cancelled, so it never quietly disappears off your phone.',
    untimed > 0
      ? `${untimed} ${untimed === 1 ? 'job is' : 'jobs are'} not shown because no time was recorded on ${untimed === 1 ? 'it' : 'them'}. ${untimed === 1 ? 'It is' : 'They are'} on your account page.`
      : '',
    shown.length < usable.length
      ? `Showing the most recent ${MAX_EVENTS} of ${usable.length}.`
      : '',
  ].filter(Boolean).join(' ');

  const tz_ = (account.config && account.config.timezone) || DEFAULT_TZ;
  const body = calendarFeed(null, {
    name,
    description: desc,
    tz: tz_,
    refresh: 'PT1H',
    events,
  });

  // ── the validator, and why it is NOT a hash of the body ────────────────────────────────────
  //
  // ★ MEASURED 2026-08-14, over real HTTP: two identical requests one second apart returned two
  // different ETags and the same 4,313 bytes of meaning. The diff was 22 lines, every one of them
  // receipt token material, because lib/jobs.mjs `mintReceipt` stamps `i: Date.now()` into each
  // token. Hashing the body therefore produced a validator that could NEVER match, so every
  // If-None-Match got a 200 and every subscribed calendar re-downloaded the whole feed on every
  // poll, forever, per subscriber. The 304 branch below was unreachable code wearing the costume
  // of an optimisation.
  //
  // The ETag is declared WEAK, and RFC 7232 says a weak validator means SEMANTICALLY EQUIVALENT,
  // not byte identical. A fresh opaque credential is not a change in meaning: the same jobs, the
  // same times, the same statuses. So the validator is computed over what the subscriber would
  // actually see change, and a rotating token no longer counts as news. This is the correct use of
  // a weak validator rather than a way around one.
  const semantic = JSON.stringify([
    name, desc, tz_, 'PT1H', receiptsWork, untimed, usable.length,
    shown.map((j) => [
      j.job_ref || j.id, j.status || '', j.window_start || '', j.window_end || '',
      j.caller_name || '', j.address || '', j.callback || '', j.trade || '',
      j.after_hours === true, j.void_reason || '', j.voided_at || '', j.created_at || '',
    ]),
  ]);
  const etag = `W/"${crypto.createHash('sha1').update(semantic).digest('base64url').slice(0, 27)}"`;
  const counted = {
    'X-Answered-Jobs-Total': String(rows.length),
    'X-Answered-Jobs-Shown': String(shown.length),
    'X-Answered-Jobs-Untimed': String(untimed),
    ETag: etag,
  };

  if (String(req.headers.get('if-none-match') || '').includes(etag)) {
    return new Response(null, { status: 304, headers: { ...HEADERS, ...counted } });
  }
  if (req.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: { ...HEADERS, ...counted, 'Content-Length': String(Buffer.byteLength(body, 'utf8')) },
    });
  }
  return new Response(body, { status: 200, headers: { ...HEADERS, ...counted } });
};

export const config = { path: '/api/calendar/*' };
