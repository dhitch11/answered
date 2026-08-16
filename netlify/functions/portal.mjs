// portal.mjs : the customer portal. One job by link, every job by login.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT DAVID ORDERED, AND THE TWO RULINGS THAT DECIDED THE SHAPE
//
// The order: "Anytime we book them, it populates on our site in their customer portal, and that's
// where they access their booked meetings. It's also in our system so we can track it, but they
// can also get into it via a login."
//
// RULING ONE, ON CHANNELS: "There's a reason they're hiring us. It's because they don't answer the
// phone." Our customer is definitionally the person who does not pick up, so a CALL is the wrong
// default. Email is automatic and has no off switch. Text is a default the carrier is blocking.
// A call is opt-in and, by default, after hours only.
//
// RULING TWO, STANDING LAW: no gated processes, no lengthy processes, full usability. A login IS a
// gate. So the portal has to be useful BEFORE anyone signs in.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE ARCHITECTURE THAT FOLLOWS: LINK FIRST, LOGIN OPTIONAL
//
//   /j/<token>   ONE job, no password, no account. The token is the credential. This is the link
//                that goes in every notification, and it carries the DISPUTE control, which is
//                why it matters more than the login: while texting is carrier-blocked, this link
//                is the only place a customer can refuse a job we billed him for.
//   /portal      EVERY job, behind the session that already exists in lib/account-auth.mjs.
//                The login buys you the whole list, the settings and the calendar feed. Nothing
//                else. Losing it never costs you access to a job you were emailed.
//
// The pattern is proven twice in this codebase already: the Parley deal link, where the token IS
// the credential because a stranger will not open an account to settle an argument, and
// lib/account-auth.mjs, which stores only a sha256 of the emailed token so that a database read
// can never mint a session.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// FIVE THINGS THIS FILE DOES ON PURPOSE
//
// 1. THE GATE IS THE SERVER, NOT THE STYLESHEET. Nothing belonging to an account is put into a
//    string until readSession has returned an id. The estate has already paid for the other
//    approach: a CSS "PIN curtain" over bytes the server had already sent, 303,451 of them,
//    readable by any anonymous curl. If the bytes reach the browser, the page is public.
//
// 2. IT WORKS WITH JAVASCRIPT OFF. Every control is a form that posts and redirects. The only
//    script on any page here CREATES a copy button, so with scripting off no copy button exists,
//    rather than one that cannot copy.
//
// 3. IT READS `ok` OUT OF THE BODY, NOT OFF THE STATUS LINE. sv_job_void answers "no job with that
//    reference" with an HTTP 200 and {ok:false}. @LANE-JOBREC measured the same trap on
//    sv_job_create, where a refused write was reported to the caller as a success. A 200 from
//    PostgREST is a statement about HTTP, not about what happened.
//
// 4. IT NEVER RENDERS A CONTROL THAT CANNOT ACT. The call channel is gated on a live measurement
//    of whether this deploy can dial at all, and renders disabled with the reason in words when it
//    cannot. Today it cannot: ANSWERED_AUTOPILOT_KILL is set.
//
// 5. IT FAILS CLOSED, INCLUDING AT THE SEAM THAT DOES NOT EXIST YET. A second factor can be added
//    by changing one function and adding one page. If it is ever switched on before that page is
//    written, nobody gets a session, rather than everybody bypassing it.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// ★ config.path AT THE BOTTOM IS A LITERAL AND MUST STAY ONE. Netlify reads a v2 function's config
// export by static analysis at bundle time and does not execute the module, so a COMPUTED path
// array is silently dropped and the function falls back to its default route. That happened to
// answered-brain.mjs on 2026-08-14 and it took every call control off this site.

import {
  getAccount, consumeToken, startAccount, markTokenSent, STATE_TEXT, dbConfigured,
} from './lib/accounts.mjs';
import {
  readSession, mintSession, setCookie, clearCookie, readCookie, hashToken, mintLoginToken,
  configured as authConfigured, PRIVATE_HEADERS, html, json, slow, clientIp,
} from './lib/account-auth.mjs';
import { sendLoginLink, notifyOperator } from './lib/account-notify.mjs';
import * as jobs from './lib/jobs.mjs';
import * as ui from './lib/portal-ui.mjs';
import { smsStatus } from './lib/outbox.mjs';
import * as hs from './lib/hubspot-answered.mjs';

const JOB_LIMIT = 200;

const seeOther = (to, extra = {}) =>
  new Response('', { status: 303, headers: { Location: to, ...PRIVATE_HEADERS, ...extra } });

const notAllowed = (allow) =>
  new Response('Method not allowed\n', { status: 405, headers: { Allow: allow, 'Content-Type': 'text/plain; charset=utf-8', ...PRIVATE_HEADERS } });

async function readBody(req) {
  const ct = (req.headers.get('content-type') || '').toLowerCase();
  const raw = await req.text().catch(() => '');
  if (ct.includes('application/json')) { try { return JSON.parse(raw || '{}'); } catch { return {}; } }
  const out = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

const looksLikeEmail = (s) => /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(String(s || '').trim());

/** Control characters, written as escapes so this file stays plain ASCII that grep can read. */
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// ── view models ──────────────────────────────────────────────────────────────────────────────
//
// The renderer is given finished sentences and never a raw row, so that every "what if this field
// is missing" decision is made once, here, next to the data, instead of being re-decided inside a
// template where a `||` quietly invents a value.

const fmtDate = (v, tz) => {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz || jobs.DEFAULT_TZ, weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    }).format(d);
  } catch { return d.toISOString().slice(0, 16).replace('T', ' '); }
};

/** A job row, plus every string the receipt needs, with nothing invented for a missing field. */
function viewJob(row, account) {
  const tz = (account && account.timezone) || (row.details && row.details.tz) || jobs.DEFAULT_TZ;
  return {
    ...row,
    when: jobs.windowParts(row, tz),
    callbackPretty: row.callback ? jobs.prettyPhone(row.callback) : '',
    bookedOn: fmtDate(row.created_at, tz) || 'not recorded',
    voidedOn: row.voided_at ? fmtDate(row.voided_at, tz) : '',
    reasons: jobs.VOID_REASONS,
  };
}

/**
 * The price, turned into the two sentences a person can check.
 *
 * `pieces` is attached only when there is no ledger charge, because the four-pieces test is how
 * the PUBLISHED price is decided. Printing it beside a figure the ledger already settled would
 * invite an argument with a number this page did not compute.
 */
function viewPrice(row, charge) {
  const p = jobs.priceOf(row, charge);
  return {
    ...p,
    money: jobs.usd(p.cents),
    capText: jobs.usd(jobs.CAP_CENTS).replace('.00', ''),
    pieces: p.source === 'published' ? jobs.fourPieces(row) : null,
  };
}

function viewRow(row, account) {
  const tz = (account && account.timezone) || jobs.DEFAULT_TZ;
  const w = jobs.windowParts(row, tz);
  const p = jobs.priceOf(row, null);
  let token = '';
  try { token = jobs.mintReceipt(row.job_ref, account.id); } catch { token = ''; }
  return {
    token,
    job_ref: row.job_ref,
    service: (row.details && row.details.service) || 'A job',
    caller_name: row.caller_name || '',
    address: row.address || '',
    status: row.status,
    after_hours: Boolean(row.after_hours),
    upcoming: Boolean(row.upcoming),
    whenShort: w.known ? fmtDate(row.window_start, tz) : 'No window agreed',
    priceShort: row.status === 'voided' ? 'Voided' : (p.cents > 0 ? jobs.usd(p.cents) : 'Free'),
    freeReason: row.status !== 'voided' && p.cents === 0 && p.missing_pieces && p.missing_pieces.length
      ? `no ${p.missing_pieces[0]}` : '',
  };
}

const ym = (d, tz) => {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).format(new Date(d)); }
  catch { return String(new Date(d).toISOString().slice(0, 7)); }
};

/**
 * This month, at published prices, and labelled as exactly that.
 *
 * ★ IT IS NOT A BILL AND THE PANEL SAYS SO. The billing ledger is the vetted source and it applies
 * the monthly cap and any credit; this is arithmetic over the rows on this page. The estate's rule
 * is that a headline figure is a stored vetted field and never a client-side re-sum, so this one
 * is never presented as a headline: it sits under "This month" with a sentence saying what it is
 * and what it is not, and it can only ever be higher than the bill, never lower.
 */
function viewMonth(rows, account) {
  const tz = (account && account.timezone) || jobs.DEFAULT_TZ;
  const now = ym(new Date(), tz);
  const mine = rows.filter((r) => r.status !== 'voided' && ym(r.created_at, tz) === now);
  if (!mine.length) return { countable: false };
  let cents = 0; let billable = 0; let free = 0;
  for (const r of mine) {
    const p = jobs.priceOf(r, null);
    cents += p.cents;
    if (p.cents > 0) billable += 1; else free += 1;
  }
  return {
    countable: true,
    total: jobs.usd(cents),
    billable,
    free,
    cap: jobs.usd(jobs.CAP_CENTS).replace('.00', ''),
  };
}

/** Why this account has no jobs, chosen from its real state. Never one sentence for every case. */
function emptyWhy(account) {
  const s = account.status;
  if (s === 'live') return 'Your line is on and nobody has called it yet, or nobody who called wanted to book. This is the true count, not a page that has not loaded.';
  if (s === 'awaiting_line') return 'You have asked for a number and a person is still setting it up by hand. Until that number exists there is no line for anyone to ring, so there is nothing here yet.';
  if (s === 'ready') return 'Your rules are finished but you have not asked for a phone number yet, so there is no line for anyone to ring. Ask for one on your account page.';
  if (s === 'paused') return 'Your line is paused, so nothing is answering and nothing is being booked.';
  if (s === 'closed') return 'This account is closed and the number is released, so nothing can be booked.';
  return 'Your rules are not finished yet, so your line cannot answer a call, which means there is nothing to book. Finish them on your account page.';
}

// ── the session ──────────────────────────────────────────────────────────────────────────────

/**
 * THE SEAM FOR A SECOND FACTOR, and the only place a session cookie is ever minted.
 *
 * The plan David's ruling makes possible: we can place a phone call to the business line today,
 * so the natural second factor is a code read out on that line. Adding it means changing this one
 * function to return { required: true, kind: 'voice' } and writing one challenge page. Nothing
 * above or below has to move, because every path that grants access already comes through here.
 *
 * ★ IT FAILS CLOSED AT THE HALF-BUILT STATE. If a future lane switches this on before the
 * challenge page exists, `grant` refuses and nobody gets in. The other direction, waving everyone
 * through because the challenge is missing, is how a second factor becomes a comment.
 */
async function secondFactor(_account) {
  return { required: false, kind: '', why: 'no second factor is switched on for this account' };
}

async function grant(account, to) {
  const sf = await secondFactor(account);
  if (sf.required) {
    console.error(`portal: a second factor (${sf.kind}) is required but no challenge is implemented; refusing to mint a session`);
    return html(503, ui.downPage(`a second factor is switched on but its challenge page does not exist yet`, 'Signing in'));
  }
  return seeOther(to, { 'Set-Cookie': setCookie(mintSession(account.id)) });
}

// ── /j/<token> : one job, no login ───────────────────────────────────────────────────────────

async function receipt(req, url, path) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return notAllowed('GET, HEAD');
  if (!jobs.canSign()) return html(503, ui.downPage('no signing key is set on this deploy, so a job link cannot be checked for forgery', 'Job links'));

  // A splat, not `/j/:token`, because a token carries dots and whether a `:param` matches a dotted
  // value is a property of the router rather than of this code. job.mjs made the same call for the
  // same reason. The handler parses the path itself, so nothing depends on a captured parameter.
  const m = /^\/j\/([^/]+)$/.exec(path);
  const token = m ? decodeURIComponent(m[1]) : '';
  const claims = token ? jobs.readReceipt(token) : null;
  // A forged token, a tampered one, a truncated one and a typo all land here, and the response
  // says nothing about which. There is no oracle for someone probing signatures.
  if (!claims) return html(404, ui.notFoundPage());

  if (!dbConfigured()) return html(503, ui.downPage('the jobs database is not configured on this deploy', 'This job page'));

  let found;
  try { found = await jobs.jobByRef(claims.r); } catch (e) {
    console.error(`portal receipt: read failed for ${claims.r}: ${String(e.message).slice(0, 160)}`);
    return html(502, ui.downPage('we could not read this job just now', 'This job page'));
  }
  if (!found || !found.job) return html(404, ui.notFoundPage());

  // The token names an account; the row names an account. If they disagree the link is not for
  // this job any more, and showing it anyway would be showing one business another's customer.
  if (claims.a && found.job.account_id && String(claims.a) !== String(found.job.account_id)) {
    console.error(`portal receipt: token/account mismatch on ${claims.r}`);
    return html(404, ui.notFoundPage());
  }

  const flashes = {
    ok: { kind: 'ok', title: 'Voided', text: 'The job is marked voided and your reason is on the record. A person picks this up and settles the charge on the billing side.' },
    replay: { kind: 'ok', title: 'Already voided', text: 'This job was already voided, so nothing changed. The record still shows the first reason given.' },
    err: { kind: 'err', title: 'That did not go through', text: 'Nothing changed and the job is still booked. Try again, and if it keeps failing reply to the email this link came in.' },
    reason: { kind: 'err', title: 'Pick a reason', text: 'A void needs a reason, because a reason with no words is a number nobody can act on.' },
  };

  return html(200, ui.receiptPage({
    job: viewJob(found.job, found.account),
    account: found.account,
    call: viewCall(found.call, found.account),
    price: viewPrice(found.job, found.charge),
    token,
    flash: flashes[url.searchParams.get('v')] || null,
  }));
}

function viewCall(call, account) {
  if (!call || (!call.call_sid && !call.summary)) return null;
  const tz = (account && account.timezone) || jobs.DEFAULT_TZ;
  const secs = Number(call.duration_seconds);
  return {
    ...call,
    whenText: call.created_at ? `The call came in ${fmtDate(call.created_at, tz)}` : '',
    lengthText: Number.isFinite(secs) && secs > 0
      ? `It lasted ${Math.floor(secs / 60)} minutes ${secs % 60} seconds`.replace('1 minutes', '1 minute')
      : '',
  };
}

// ── POST /api/portal/void : the dispute ──────────────────────────────────────────────────────

async function voidJob(req) {
  if (req.method !== 'POST') return notAllowed('POST');
  if (!jobs.canSign()) return html(503, ui.downPage('no signing key is set on this deploy', 'Voiding a job'));
  if (!dbConfigured()) return html(503, ui.downPage('the jobs database is not configured on this deploy', 'Voiding a job'));

  const f = await readBody(req);
  const token = String(f.t || '');
  const claims = jobs.readReceipt(token);
  if (!claims) return html(404, ui.notFoundPage());

  const back = `/j/${encodeURIComponent(token)}`;
  const reasonKey = String(f.reason || '');
  const label = jobs.voidReasonLabel(reasonKey);
  if (!label) return seeOther(`${back}?v=reason`);

  // Control characters out, newlines and tabs kept: a note typed on a phone has newlines in it,
  // and this string is read back inside an email body and inside a HubSpot note.
  const note = String(f.note || '').replace(CTRL, '').trim().slice(0, 500);
  const reasonText = note ? `${label}: ${note}` : label;

  let r;
  try { r = await jobs.voidJob(claims.r, reasonText, 'customer'); } catch (e) {
    console.error(`portal void: rpc failed for ${claims.r}: ${String(e.message).slice(0, 160)}`);
    return seeOther(`${back}?v=err`);
  }
  // ★ The body decides, not the status line. sv_job_void answers an unknown reference with a 200.
  if (!r || r.ok !== true) {
    console.error(`portal void: refused for ${claims.r}: ${(r && r.error) || 'no reason given'}`);
    return seeOther(`${back}?v=err`);
  }
  if (r.replay === true) return seeOther(`${back}?v=replay`);

  // A void that lands only in a table nobody watches is not a dispute. sv_job_void does NOT touch
  // the attached charge (measured: no trigger on public.jobs, and the function's own note says the
  // charge is settled separately in the billing ledger), so a person has to be told. This is the
  // only thing that makes the promise on the receipt true.
  tellSomebody(r.job, claims, reasonText).catch((e) =>
    console.error(`portal void: the job voided but nobody was told: ${String(e.message).slice(0, 160)}`));

  return seeOther(`${back}?v=ok`);
}

async function tellSomebody(job, claims, reasonText) {
  let account = null;
  if (job.account_id) { try { account = await getAccount(job.account_id); } catch { account = null; } }
  const who = account ? `${account.business_name} <${account.owner_email}>` : 'an account we could not read';

  await notifyOperator({
    subject: `ACTION NEEDED: a customer voided job ${job.job_ref}`,
    replyTo: account ? account.owner_email : undefined,
    lines: [
      'ACTION NEEDED: a customer voided a booked job from the link in their notification. The job row is',
      'already marked voided. The CHARGE attached to it is not: sv_job_void does not touch billing_events,',
      'so a person settles it in the ledger. That is what the receipt promises and it is a manual step.',
      '',
      `Job: ${job.job_ref}`,
      `Business: ${who}`,
      `Reason given: ${reasonText}`,
      `Voided at: ${job.voided_at || 'now'}`,
      `Charge attached: ${job.billing_event_id ? job.billing_event_id : 'none recorded against this job'}`,
      '',
      'Nothing was refunded automatically and nothing was deleted. The job is readable at its receipt link.',
    ],
  });

  if (account && account.owner_email) {
    await hs.record({
      email: account.owner_email,
      product: 'answered',
      source: 'portal job dispute',
      noteTitle: `Job ${job.job_ref} voided by the customer`,
      noteBody: `<p>The customer voided this job from the link in their booking notification.</p>`
        + `<p>Reason given: ${hsEsc(reasonText)}</p>`
        + `<p>Job ${hsEsc(job.job_ref)}. Charge attached: ${job.billing_event_id ? hsEsc(job.billing_event_id) : 'none recorded'}. `
        + `The job row is voided; the charge is settled by hand in the billing ledger.</p>`,
      taskSubject: `Settle the charge on voided job ${job.job_ref}`,
      taskBody: `Reason: ${reasonText}. Voiding the job does not void the charge, so check billing_events for this job and settle it.`,
    });
  }
}

const hsEsc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── /portal : every job, behind the session ──────────────────────────────────────────────────

async function console_(req, url, accountId) {
  let account;
  try { account = await getAccount(accountId); } catch (e) {
    console.error(`portal: account read failed: ${String(e.message).slice(0, 160)}`);
    return html(502, ui.downPage('we could not read your account just now', 'Your portal'));
  }
  if (!account) return html(200, ui.loginPage({ flash: { kind: 'err', text: 'Sign in again.' } }), { 'Set-Cookie': clearCookie() });

  let rows = [];
  let jobsError = false;
  try {
    const got = await jobs.jobsForAccount(accountId, null, JOB_LIMIT);
    rows = Array.isArray(got) ? got : [];
  } catch (e) {
    // An honest failure, not an empty list. A read that threw and a real zero look identical on a
    // page that renders both as "no jobs", and one of them is a lie.
    console.error(`portal: jobs read failed for ${accountId}: ${String(e.message).slice(0, 160)}`);
    jobsError = true;
  }

  const filter = ['all', 'upcoming', 'done', 'voided'].includes(url.searchParams.get('show') || '')
    ? url.searchParams.get('show') : 'all';

  const live = rows.filter((r) => r.status !== 'voided');
  const counts = {
    all: rows.length,
    upcoming: live.filter((r) => r.upcoming).length,
    done: live.filter((r) => !r.upcoming).length,
    voided: rows.filter((r) => r.status === 'voided').length,
  };
  const shown = filter === 'all' ? rows
    : filter === 'voided' ? rows.filter((r) => r.status === 'voided')
      : filter === 'upcoming' ? live.filter((r) => r.upcoming)
        : live.filter((r) => !r.upcoming);

  let prefs = { ...jobs.DEFAULT_PREFS, owner_email: account.owner_email, owner_phone: account.owner_phone };
  try {
    const got = await jobs.notifyPrefs(accountId);
    if (got) prefs = got;
  } catch (e) {
    console.error(`portal: notify prefs read failed: ${String(e.message).slice(0, 160)}`);
  }

  const state = STATE_TEXT[account.status] || STATE_TEXT.configuring;
  let feed = { url: '' };
  try { feed = { url: jobs.feedUrl(jobs.mintFeedKey(accountId)) }; } catch { feed = { url: '' }; }

  const saved = url.searchParams.get('saved');
  const flash = saved === '1' ? { kind: 'ok', title: 'Saved', text: 'That is how we tell you from now on. It takes effect on the next job we book.' }
    : saved === 'phone' ? { kind: 'err', title: 'Check that number', text: 'We could not read that as a phone number, so nothing was changed. Ten digits is enough.' }
      : saved === 'error' ? { kind: 'err', title: 'That did not save', text: 'Nothing changed. Try again in a minute.' }
        : null;

  return html(200, ui.portalPage({
    account,
    state: { ...state, emptyWhy: emptyWhy(account) },
    jobs: shown.map((r) => viewRow(r, account)),
    counts,
    filter,
    month: viewMonth(rows, account),
    prefs: {
      ...prefs,
      owner_email: prefs.owner_email || account.owner_email,
      sms_to_pretty: prefs.sms_to ? jobs.prettyPhone(prefs.sms_to) : '',
      owner_phone_pretty: account.owner_phone ? jobs.prettyPhone(account.owner_phone) : '',
    },
    gates: { sms: smsStatus(), call: jobs.callChannelStatus() },
    feed,
    flash,
    jobsError,
  }));
}

// ── POST /api/portal/settings ────────────────────────────────────────────────────────────────

async function saveSettings(req, accountId) {
  if (req.method !== 'POST') return notAllowed('POST');
  const f = await readBody(req);

  const extras = String(f.email_extra || '').split(/[,;\s]+/).map((s) => s.trim())
    .filter((s) => looksLikeEmail(s)).slice(0, 5);

  const patch = {
    email_extra: extras,
    sms_on: Boolean(f.sms_on),
  };

  // ★ A DISABLED CONTROL IS A CONTROL THE FORM NEVER SHOWED, AND THE SAME RULE APPLIES TO IT.
  // The two call checkboxes render `disabled` whenever this deploy cannot dial, and a disabled
  // control is not submitted, so `Boolean(f.call_on)` read false for a box the customer could see
  // sitting there CHECKED. Every save made while calling is switched off therefore rewrote
  // call_after_hours_only from true to false: the one preference that carries David's ruling that
  // a call is for a two in the morning emergency and not for routine news, destroyed by somebody
  // adding an office email address. MEASURED in a real browser, gate red vs gate green:
  //   red   -> email_extra=&sms_on=1&sms_to=                            (both call fields absent)
  //   green -> email_extra=&sms_on=1&sms_to=&call_on=1&call_after_hours_only=1
  //
  // So the form now SAYS when it rendered that block as editable, and only then are its checkboxes
  // read. An unchecked box still turns the setting off, because the marker is present whenever the
  // box was real. A caller that omits the marker leaves both fields exactly as they were.
  if (Object.prototype.hasOwnProperty.call(f, 'call_editable')) {
    patch.call_on = Boolean(f.call_on);
    patch.call_after_hours_only = Boolean(f.call_after_hours_only);
  }

  // ★ ONLY THE FIELDS THIS FORM ACTUALLY RENDERED. sv_account_notify_save is a patch, and it keeps
  // any key the caller omits, but that protection is worthless if the caller always sends every
  // key. The settings form does not render `call_to`, so sending it unconditionally would send
  // null and silently wipe a number the customer set somewhere else. A form must never blank a
  // field it never showed.
  //
  // A number we cannot read is refused rather than stored: a malformed number is a notification
  // that silently goes nowhere, which is worse than a visible refusal.
  for (const field of ['sms_to', 'call_to']) {
    if (!Object.prototype.hasOwnProperty.call(f, field)) continue;
    const s = String(f[field] == null ? '' : f[field]).trim();
    if (!s) { patch[field] = null; continue; }
    const e = jobs.e164(s);
    if (!e) return seeOther('/portal?saved=phone');
    patch[field] = e;
  }

  try { await jobs.saveNotifyPrefs(accountId, patch, 'owner'); } catch (e) {
    console.error(`portal: settings save failed: ${String(e.message).slice(0, 160)}`);
    return seeOther('/portal?saved=error');
  }
  return seeOther('/portal?saved=1');
}

// ── /portal/feed.ics : the calendar ──────────────────────────────────────────────────────────

async function feed(req, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return notAllowed('GET, HEAD');
  const plain = (status, body) => new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
  });

  // A calendar app cannot carry a cookie, so the key in the URL is the credential. It is signed,
  // it names one account, and it carries no data of its own.
  const accountId = jobs.readFeedKey(url.searchParams.get('k') || '');
  if (!accountId) return plain(404, 'That calendar address is not valid.\n');
  if (!dbConfigured()) return plain(503, 'The calendar feed is not available on this deploy.\n');

  let account = null;
  let rows = [];
  try {
    account = await getAccount(accountId);
    rows = (await jobs.jobsForAccount(accountId, null, JOB_LIMIT)) || [];
  } catch (e) {
    console.error(`portal feed: read failed: ${String(e.message).slice(0, 160)}`);
    return plain(502, 'We could not read your jobs just now.\n');
  }
  if (!account) return plain(404, 'That calendar address is not valid.\n');

  return new Response(jobs.feedIcs(rows, account), {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8; method=PUBLISH',
      'Content-Disposition': `inline; filename="answered-jobs.ics"`,
      'Cache-Control': 'no-store, private',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// ── the door ─────────────────────────────────────────────────────────────────────────────────

/**
 * The same answer every time, on purpose. New address, known address, throttled, send failed for a
 * reason we will not explain: one page, one message. An endpoint that answers differently for an
 * address that exists is a way to ask us who our customers are.
 *
 * The ONE thing it will not paper over is a send that failed, because a page saying "check your
 * email" while nothing was sent is the worst outcome available here.
 */
async function login(req) {
  if (req.method !== 'POST') return notAllowed('POST');
  if (!(process.env.RESEND_API_KEY || '').trim()) {
    return html(503, ui.downPage('RESEND_API_KEY is not set, so no sign-in link can be sent', 'Signing in'));
  }

  const f = await readBody(req);
  const email = String(f.email || '').trim().toLowerCase().slice(0, 200);
  if (!looksLikeEmail(email)) {
    await slow(300);
    return html(400, ui.loginPage({ flash: { kind: 'err', title: 'Check the address', text: 'That does not look like an email address.' } }));
  }

  const { raw, hash } = mintLoginToken();
  const origin = process.env.URL || new URL(req.url).origin;

  let r;
  try {
    r = await startAccount({ email, tokenHash: hash, ttlMinutes: 20, ip: clientIp(req), ua: (req.headers.get('user-agent') || '').slice(0, 300) });
  } catch (e) {
    const msg = String((e && e.message) || e);
    // "business name required" means this address has no account here. Saying so out loud would
    // turn this box into a customer-list oracle, so it lands on the same page as everything else,
    // whose wording already covers it.
    if (/business name required/i.test(msg)) { await slow(400); return html(200, ui.sentPage()); }
    console.error(`portal login: db refused: ${msg.slice(0, 160)}`);
    return html(502, ui.downPage('the account database refused the request', 'Signing in'));
  }

  if (!r.ok && r.throttled) { await slow(400); return html(200, ui.sentPage()); }

  const account = r.account;
  const sent = await sendLoginLink({
    email,
    businessName: account.business_name,
    url: `${origin}/portal/enter?t=${encodeURIComponent(raw)}`,
    isNew: r.created,
  });
  if (!sent.ok) {
    console.error(`portal login: link NOT sent (${sent.why}) ${sent.detail || ''}`);
    return html(502, ui.downPage(sent.why, 'Signing in'));
  }
  // Counted only once it has actually left the building. A token row is written before the send is
  // attempted, so counting issued tokens let five failed sends fill the budget and answered the
  // sixth attempt with "check your email" without trying to send anything at all.
  await markTokenSent(hash).catch((e) => console.error(`portal login: sent but not marked: ${String(e.message).slice(0, 140)}`));

  await slow(200);
  return html(200, ui.sentPage());
}

async function enter(req, url) {
  if (req.method !== 'GET') return notAllowed('GET');
  const t = url.searchParams.get('t') || '';
  if (!t) return html(400, ui.loginPage({ flash: { kind: 'err', title: 'That link is incomplete', text: 'It is missing its code. Ask for a new one.' } }));
  await slow(250);

  let r;
  try { r = await consumeToken(hashToken(t), clientIp(req)); } catch (e) {
    console.error(`portal enter: consume failed: ${String(e.message).slice(0, 160)}`);
    return html(502, ui.downPage('we could not sign you in just now', 'Signing in'));
  }
  // Used, expired, or never real. All three get the same answer on purpose.
  if (!r || !r.ok) {
    return html(401, ui.loginPage({ flash: { kind: 'err', title: 'That link has stopped working', text: 'Links work once and last twenty minutes. Ask for a new one and it will be waiting.' } }));
  }
  return grant(r.account, '/portal');
}

// ── the call this deploy cannot place yet ────────────────────────────────────────────────────

/**
 * The TwiML for the opt-in "call me when a job is booked" channel.
 *
 * ★ AUTHENTICATED BY OUR OWN SIGNATURE, NOT BY TWILIO'S. lib/twilio-webhook.mjs degrades to an
 * AccountSid cross-check when TWILIO_AUTH_TOKEN is absent.
 *
 * ★ CORRECTED 2026-08-16: THIS COMMENT USED TO SAY THE TOKEN "IS ABSENT ON THIS PROJECT". IT IS NOT.
 * Measured on production, twice, by two lanes independently. A correctly signed POST to
 * /api/sms-inbound is accepted and logged; the identical body with a wrong signature is refused with
 * "signature mismatch". That verifier FAILS CLOSED on a missing token, so a mismatch refusal can only
 * happen if the token is present. The claim was stale, and it was load-bearing: it convinced a
 * careful research agent, with three file citations, that our whole proof layer would refuse every
 * write. When a code comment disagrees with a measurement, the comment is the suspect.
 *
 * The receipt-token design below is UNCHANGED and still correct — it is defence in depth, not a
 * workaround for a missing token. So the URL carries a receipt token this server minted, and
 * nothing without the HMAC key can produce one. The AccountSid is still checked when Twilio sends
 * it, as a second lock rather than the only one.
 */
async function jobCall(req, url) {
  if (req.method !== 'GET' && req.method !== 'POST') return notAllowed('GET, POST');
  const xml = (status, body) => new Response(body, {
    status, headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store' },
  });
  const hangup = (why) => xml(200, `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Say voice="Polly.Matthew">${why}</Say>\n  <Hangup/>\n</Response>\n`);

  const claims = jobs.readReceipt(url.searchParams.get('k') || '');
  if (!claims) return xml(403, '<?xml version="1.0" encoding="UTF-8"?>\n<Response><Hangup/></Response>\n');

  const acc = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const given = url.searchParams.get('AccountSid') || '';
  if (acc && given && given !== acc) return xml(403, '<?xml version="1.0" encoding="UTF-8"?>\n<Response><Hangup/></Response>\n');

  if (!dbConfigured()) return hangup('We cannot read that job right now. Sorry about that.');
  let found;
  try { found = await jobs.jobByRef(claims.r); } catch { found = null; }
  if (!found || !found.job) return hangup('We could not find that job. Nothing has changed.');

  return xml(200, jobs.jobCallTwiml(found.job, found.account));
}

// ── the router ───────────────────────────────────────────────────────────────────────────────

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/portal';

  // ── open by design: the link IS the credential, so these run before any session lookup ─────
  if (path.startsWith('/j/')) return receipt(req, url, path);
  if (path === '/api/portal/void') return voidJob(req);
  if (path === '/portal/feed.ics') return feed(req, url);
  if (path === '/api/portal/job-call') return jobCall(req, url);

  // Everything below this line needs the account spine to exist at all.
  if (!dbConfigured()) return html(503, ui.downPage('the account database is not configured on this deploy', 'The portal'));
  if (!authConfigured()) return html(503, ui.downPage('ANSWERED_ACCOUNT_KEY is not set on this deploy, so no session can be signed', 'The portal'));

  if (path === '/portal/login') {
    if (req.method !== 'GET') return notAllowed('GET');
    // Already signed in? Do not make somebody sign in twice to see a page they can already see.
    if (readSession(readCookie(req.headers))) return seeOther('/portal');
    return html(200, ui.loginPage({}));
  }
  if (path === '/api/portal/login') return login(req);
  if (path === '/portal/enter') return enter(req, url);
  if (path === '/portal/signout') {
    if (req.method !== 'POST') return seeOther('/portal');
    return seeOther('/portal/login', { 'Set-Cookie': clearCookie() });
  }

  // ── THE GATE. Nothing above has touched an account; nothing below runs without a session. ──
  const accountId = readSession(readCookie(req.headers));
  if (!accountId) {
    if (path.startsWith('/api/')) return json(401, { ok: false, error: 'sign in first' });
    // The whole anonymous response is the sign-in page. No account bytes are serialized, because
    // none have been read. This is the property to measure with an anonymous curl, and it is
    // measured in portal.test.mjs by byte count and by string search.
    return html(200, ui.loginPage({}));
  }

  if (path === '/api/portal/settings') return saveSettings(req, accountId);
  if (path === '/portal') {
    if (req.method !== 'GET') return notAllowed('GET');
    return console_(req, url, accountId);
  }

  return json(404, { ok: false, error: 'no such path' });
};

// ★ LITERAL. Never a function call, never a spread, never a computed array. Netlify reads this by
// static analysis at bundle time without executing the module, so a computed value registers no
// routes at all and the function answers only at its default /.netlify/functions/ URL, which is
// the exact failure that took every call control off this site on 2026-08-14.
//
// `/j/*` is a splat because a receipt token carries dots.
// No block for any of these belongs in netlify.toml: declaring a custom path REMOVES the default
// route, so a forced redirect pointing at /.netlify/functions/portal would shadow a live route
// with a dead target.
export const config = {
  path: [
    '/portal',
    '/portal/login',
    '/portal/enter',
    '/portal/signout',
    '/portal/feed.ics',
    '/j/*',
    '/api/portal/login',
    '/api/portal/void',
    '/api/portal/settings',
    '/api/portal/job-call',
  ],
};
