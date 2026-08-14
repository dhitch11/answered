// /api/notify — how a customer says what they want to be told, and the door that tells them.
//
// ── THE RULE THAT SHAPES THIS FILE: A LOGIN IS A GATE, SO THE USEFUL PART COMES FIRST ────────
//
// GET /api/notify with no session is a 200, not a 401. It answers with the whole model: the four
// things we tell people about, the four channels, what the defaults are, which channels can
// actually deliver today and why the others cannot. None of that belongs to anybody, so none of it
// needs a password, and a page can show a contractor exactly how this works before he has typed an
// email address. Signing in ADDS his own settings, his calendar link and his warnings. It does not
// unlock the explanation.
//
// ── THE THREE DOORS ──────────────────────────────────────────────────────────────────────────
//
//   GET  /api/notify        the model. Public. Adds this account's settings when signed in.
//   POST /api/notify        save settings. Session only. Works with JavaScript off.
//   POST /api/notify/send   tell a customer something. Operator or agent credential only.
//
// ── WHY THE SEND DOOR TAKES A BEARER AND NOT A COOKIE ────────────────────────────────────────
//
// A session proves a person is signed in to their own account. It does not prove the thing being
// announced actually happened. Only the systems that booked the job know that, and they hold a
// secret, so lib/bearer.mjs is the check. A cookie here would let anybody who signed in send
// themselves a booking confirmation for a job that does not exist, which is the same class of
// defect as a fabricated row, just delivered by email.
//
// ── WHAT THIS ENDPOINT WILL NOT DO ───────────────────────────────────────────────────────────
//
// It will not report a channel as sent when it was not. It will not present texting as an option
// that promises delivery while the carrier campaign is unapproved. It will not dial. And it will
// not save a setting and then quietly do something else: the response to a save carries the PLAN
// that setting produces, so an owner can see the consequence in the same round trip.

import {
  EVENTS, CHANNELS, EVENT_KEYS, CHANNEL_KEYS, DEFAULT_EVENTS,
  applyChanges, warningsFor, channelAvailability, plan,
  calendarToken, calendarUrl, webcalUrl,
  deliver, SMS_TRUTH, capSentence, MONTHLY_CAP_CENTS, usd,
  fromStored, toStored, whatPersisted, defaults, STORED_FIELDS, UNSTORED,
} from './lib/notify-prefs.mjs';
import { getAccount, dbConfigured } from './lib/accounts.mjs';
// ★ THE PREFERENCES LIVE HERE, AND I LEARNED THAT BY MEASURING, NOT BY READING.
// This endpoint first stored them as `config.notify` through sv_account_save_config. Against the
// live database that RPC keeps a whitelist and silently DROPS anything outside it: the save
// returned 200 with the full account row and a read back showed the field had never existed, while
// a control write to greeting_name in the same script persisted. sv_account_notify_save is the one
// that holds notification settings, @LANE-JOBREC owns it, and the portal already writes it. One
// birth, so the settings page and the send path cannot disagree about what a customer chose.
import { notifyPrefs, saveNotifyPrefs } from './lib/jobs.mjs';
import { readSession, readCookie, configured as authConfigured, PRIVATE_HEADERS } from './lib/account-auth.mjs';
import { authorize } from './lib/bearer.mjs';

const MAX_BODY = 32 * 1024;

const json = (status, obj, extra = {}) => new Response(JSON.stringify(obj, null, 2), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...PRIVATE_HEADERS, ...extra },
});

const seeOther = (location, extra = {}) => new Response(null, {
  status: 303,
  headers: { Location: location, ...PRIVATE_HEADERS, ...extra },
});

/**
 * A redirect target a stranger supplied is an open redirect unless it is checked. Path only, one
 * leading slash, nothing that could start a new origin.
 */
function safeRedirect(raw, fallback = '/account') {
  const s = String(raw || '').trim();
  if (!s.startsWith('/') || s.startsWith('//') || s.includes('\\')) return fallback;
  if (/[\u0000-\u001F\u007F]/.test(s)) return fallback;
  return s.slice(0, 300);
}

const wantsJson = (req) => {
  const a = String(req.headers.get('accept') || '');
  const c = String(req.headers.get('content-type') || '');
  return a.includes('application/json') || c.includes('application/json');
};

async function readBody(req) {
  const ct = String(req.headers.get('content-type') || '');
  let raw = '';
  try { raw = await req.text(); } catch { return { __error: 'The request body could not be read.' }; }
  if (raw.length > MAX_BODY) return { __error: `The body is over the ${MAX_BODY} byte cap.` };
  if (ct.includes('application/json')) {
    try { return raw ? JSON.parse(raw) : {}; } catch { return { __error: 'The body says it is JSON and it is not.' }; }
  }
  // form encoded, which is what a page with no JavaScript sends
  const out = {};
  for (const [k, v] of new URLSearchParams(raw)) {
    if (k in out) out[k] = Array.isArray(out[k]) ? [...out[k], v] : [out[k], v];
    else out[k] = v;
  }
  return out;
}

/**
 * A checkbox that is OFF sends nothing at all, so a form post cannot be read as "the keys present
 * are the changes". Every form that saves settings must declare which switches it is showing, in
 * a `fields` list, and every switch in that list which did not arrive is OFF. Without this, a
 * contractor unticking a box saves nothing and the page cheerfully tells him it saved.
 */
function changesFromForm(body) {
  const declared = String(body.fields || '').split(/[,\s]+/).filter(Boolean);
  const events = {};
  const setOne = (name, on) => {
    const i = name.lastIndexOf('.');
    if (i < 0) return;
    const ev = name.slice(0, i);
    const ch = name.slice(i + 1);
    if (!EVENT_KEYS.includes(ev) || !CHANNEL_KEYS.includes(ch)) return;
    events[ev] = events[ev] || {};
    events[ev][ch] = on;
  };
  for (const name of declared) setOne(name, false);
  for (const key of Object.keys(body)) {
    if (key === 'fields' || key === 'redirect_to') continue;
    if (key.includes('.')) setOne(key, true);
  }
  const changes = { events };
  if ('digest_hour' in body) changes.digest_hour = body.digest_hour;
  if ('rotate_calendar' in body) changes.rotate_calendar = true;
  if ('extra_emails' in body) changes.to = { emails: String(body.extra_emails || '') };
  if ('sms_to' in body) changes.to = { ...(changes.to || {}), sms: body.sms_to };
  if ('call_to' in body) changes.to = { ...(changes.to || {}), call: body.call_to };
  return changes;
}

/** The part of the answer that belongs to nobody, so it needs no password. */
function publicModel() {
  const availability = channelAvailability();
  return {
    ok: true,
    signed_in: false,
    what_we_tell_you_about: EVENTS,
    how_we_can_tell_you: CHANNELS.map((c) => ({
      ...c,
      available: availability[c.key].available,
      reason: availability[c.key].reason,
    })),
    defaults: DEFAULT_EVENTS,
    the_rule: 'Email is on and it is automatic. Text is on in your settings and switched off in the world, because the carriers have not approved our messaging program yet. A phone call is off unless you switch it on, because most people who hire us hire us for exactly one reason: they do not answer the phone.',
    texting: SMS_TRUTH,
    money: { job: usd(1900), after_hours: usd(4900), cap: usd(MONTHLY_CAP_CENTS), cap_sentence: capSentence() },
  };
}

/** Everything above, plus what belongs to this account. */
function privateModel(account, prefs, storedFlag, note) {
  const availability = channelAvailability();
  const plans = {};
  for (const k of EVENT_KEYS) plans[k] = plan(prefs, k, availability);
  const token = calendarToken(account.id, prefs.calendar_epoch);
  return {
    ...publicModel(),
    signed_in: true,
    account: {
      id: account.id,
      business_name: account.business_name || '',
      owner_email: account.owner_email || '',
      owner_phone: account.owner_phone || '',
      status: account.status || '',
    },
    prefs,
    stored: storedFlag === true,
    // ★ WHICH SWITCHES ARE REAL. The storage keeps six fields and drops the rest without an error,
    // so a page that renders every switch in the model would be rendering controls that cannot
    // act. These two lists let it render only the ones that can.
    settings_that_save: STORED_FIELDS,
    settings_not_saved_yet: UNSTORED,
    ...(note ? { note } : {}),
    plan: plans,
    warnings: warningsFor(prefs, availability),
    calendar: token
      ? {
        url: calendarUrl(token),
        webcal: webcalUrl(token),
        how: 'Paste that address into Google Calendar, Apple Calendar or Outlook as a subscription. Your jobs show up in the calendar you already use, and you do not have to install anything.',
        refresh: 'Calendars check it about once an hour, so it is the durable copy. Email is the one that reaches you in seconds.',
        can_replace: false,
        can_replace_reason: UNSTORED.calendar_epoch,
        note: 'Anyone with this address can read your jobs, so treat it like a key. Replacing it is not switched on yet, so do not paste it anywhere you would not paste a password.',
      }
      : { url: '', webcal: '', reason: 'No calendar signing key is configured on this deploy, so no feed address could be made. Set ANSWERED_CALENDAR_KEY or ANSWERED_BOOKING_KEY.' },
  };
}

// ── the handler ──────────────────────────────────────────────────────────────────────────────

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/api/notify';

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { Allow: 'GET, POST, OPTIONS', ...PRIVATE_HEADERS } });
  }

  // ── the send door ──────────────────────────────────────────────────────────────────────────
  if (path === '/api/notify/send') {
    if (req.method !== 'POST') {
      return json(405, {
        ok: false,
        error: 'POST only.',
        how: 'POST /api/notify/send with Authorization: Bearer <secret> and { event, account_id, job } where event is one of ' + EVENT_KEYS.join(', ') + '.',
      });
    }
    const auth = authorize(Object.fromEntries(req.headers.entries()));
    if (!auth.ok) return json(auth.status, { ok: false, error: auth.message });

    const body = await readBody(req);
    if (body.__error) return json(400, { ok: false, error: body.__error });

    if (!dbConfigured()) {
      return json(503, {
        ok: false,
        error: 'The account database is not configured on this deploy, so there is nobody to look up and nothing was sent.',
      });
    }

    const accountId = String(body.account_id || (body.job && body.job.account_id) || '').trim();
    if (!accountId) {
      return json(422, { ok: false, error: 'account_id is required, either on the body or on the job. Nothing is sent to a guess.' });
    }

    let account;
    try { account = await getAccount(accountId); } catch (e) {
      console.error(`notify send: account read failed: ${String((e && e.message) || e).slice(0, 200)}`);
      return json(502, { ok: false, error: 'That account could not be read, so nothing was sent.' });
    }
    if (!account || !account.id) {
      return json(404, { ok: false, error: 'There is no account with that id, so nothing was sent.' });
    }

    const report = await deliver({
      event: body.event,
      account,
      job: body.job || null,
      jobs: body.jobs || null,
      payload: body.payload || null,
      rating: body.rating || null,
      actor: `bearer:${auth.as}`,
      probeReceipt: body.probe_receipt !== false,
    });

    if (report.error) return json(422, { ok: false, ...report });
    // 200 whether or not a channel landed, because the report is the answer and it is honest in
    // both directions. A 502 here would hide WHICH channel failed behind a status code.
    return json(200, { ok: report.ok, authorized_by: auth.as, ...report });
  }

  if (path !== '/api/notify') return json(404, { ok: false, error: 'no such path' });

  // ── the model, public half ─────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    if (!authConfigured() || !dbConfigured()) {
      return json(200, {
        ...publicModel(),
        signed_in: false,
        settings_available: false,
        reason: 'Accounts are not switched on for this deploy, so nothing can be saved yet. What is above is still what we do.',
      });
    }
    const accountId = readSession(readCookie(req.headers));
    if (!accountId) return json(200, { ...publicModel(), settings_available: true });

    let account;
    try { account = await getAccount(accountId); } catch (e) {
      console.error(`notify: account read failed: ${String((e && e.message) || e).slice(0, 200)}`);
      return json(200, {
        ...publicModel(),
        settings_available: true,
        reason: 'We could not read your settings just now. Nothing is lost and nothing changed. Try again in a minute.',
      });
    }
    if (!account || !account.id) return json(200, { ...publicModel(), settings_available: true });

    let flat = null;
    let note = '';
    try { flat = await notifyPrefs(accountId); } catch (e) {
      console.error(`notify: prefs read failed: ${String((e && e.message) || e).slice(0, 200)}`);
      note = 'We could not read your saved settings just now, so what is shown below is the default. Nothing has changed.';
    }
    const prefs = flat ? fromStored(flat) : defaults();
    return json(200, privateModel(account, prefs, Boolean(flat && flat.stored), note));
  }

  // ── saving ─────────────────────────────────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    return json(405, { ok: false, error: 'GET to read this, POST to change it.' });
  }
  if (!authConfigured() || !dbConfigured()) {
    return json(503, { ok: false, error: 'Accounts are not switched on for this deploy, so there is nothing to save to.' });
  }

  const accountId = readSession(readCookie(req.headers));
  if (!accountId) {
    return json(401, {
      ok: false,
      error: 'Sign in first. Changing what we send you is the one thing here that needs to know who you are.',
      where: '/account',
    });
  }

  const body = await readBody(req);
  if (body.__error) return json(400, { ok: false, error: body.__error });
  const asForm = !wantsJson(req);
  const back = safeRedirect(body.redirect_to, '/account');

  let account;
  try { account = await getAccount(accountId); } catch (e) {
    console.error(`notify save: account read failed: ${String((e && e.message) || e).slice(0, 200)}`);
    return asForm ? seeOther(`${back}?notify=error`) : json(502, { ok: false, error: 'We could not read your account, so nothing was changed.' });
  }
  if (!account || !account.id) {
    return asForm ? seeOther(`${back}?notify=error`) : json(401, { ok: false, error: 'Sign in again.' });
  }

  const changes = asForm ? changesFromForm(body) : (body.changes || body);
  const { prefs, changed, warnings } = applyChanges(prefsOf(account), changes, account.owner_email || 'owner');

  if (!changed.length) {
    return asForm
      ? seeOther(`${back}?notify=nochange`)
      : json(200, { ok: true, changed: [], prefs, warnings, note: 'Nothing was different, so nothing was written.' });
  }

  // ★ THE COMPLETE OBJECT GOES BACK, NEVER A PARTIAL ONE. This lane does not know whether the
  // save RPC merges shallow or deep, and the two behave differently on a partial patch. A whole,
  // fixed-shape object produces the same stored result either way, so the storage semantics cannot
  // silently change what a saved setting means.
  let updated;
  try { updated = await saveConfig(accountId, { notify: prefs }, account.owner_email || 'owner'); } catch (e) {
    console.error(`notify save failed: ${String((e && e.message) || e).slice(0, 200)}`);
    return asForm
      ? seeOther(`${back}?notify=error`)
      : json(502, { ok: false, error: 'That did not save. Nothing changed. Try again.' });
  }

  // Read the answer back out of what the database returned, never out of what we sent it. A save
  // that silently dropped a field would otherwise be reported as a save that worked.
  const stored = prefsOf(updated && updated.id ? updated : account);
  const availability = channelAvailability();
  const plans = {};
  for (const k of EVENT_KEYS) plans[k] = plan(stored, k, availability);

  if (asForm) return seeOther(`${back}?notify=saved`);
  return json(200, {
    ok: true,
    changed,
    prefs: stored,
    plan: plans,
    warnings: warningsFor(stored, availability),
    matches_request: JSON.stringify(stored.events) === JSON.stringify(prefs.events),
  });
};

export const config = { path: ['/api/notify', '/api/notify/send'] };
