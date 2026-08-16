// notify-prefs.mjs — what a customer wants to be told, how they want to be told it,
// and the sending that obeys that answer.
//
// WHY THE MODEL AND THE SENDER LIVE IN ONE FILE.
// A preference nobody is forced to consult is a settings screen, not a control. lib/outbox.mjs
// already paid for this lesson in the other direction: the do-not-contact check sits INSIDE sms()
// rather than in the caller, because "a check a caller can forget is not a control." The same
// argument applies here. deliver() is the only exported way to tell a customer anything, and it
// cannot run without resolving that customer's preferences first. There is no bypass to forget.
//
// ── DAVID'S RULING, WHICH IS THE WHOLE SHAPE OF THIS FILE ────────────────────────────────────
//
//   "There's a reason they're hiring us. It's because they don't answer the phone."
//
// Our customer is, by definition, the person who does not pick up. So a CALL is the wrong DEFAULT
// channel for this product, and that is not a technical opinion, it is who the buyer is. Email is
// on and automatic. Text is on in the model and dark in the world, because the carrier has not
// approved the campaign. Call and voicemail are OFF by default and have to be switched on
// deliberately, per event, because the channel that suits a burst pipe at two in the morning is
// not the channel that suits a Tuesday afternoon booking.
//
// ── THE FOUR THINGS THIS FILE REFUSES TO DO ──────────────────────────────────────────────────
//
// 1. CLAIM A CHANNEL THAT CANNOT DELIVER. Every channel reports `available` with a reason read
//    from the environment at request time, never from a stored flag, and a channel that is off
//    comes back `skipped:true` with the real sentence. Nothing here ever says a text arrived.
// 2. DIAL. Placing a call is the outbound lane's surface and it carries a compliance gate that
//    does not belong in a notification path. call and voicemail are modelled completely, carry a
//    consent stamp, and report available:false with the reason. Wiring a dialer in is one
//    function, and it is somebody else's function.
// 3. EMAIL A LINK IT HAS NOT PROVEN. The receipt link is minted, then fetched with a real GET
//    using the exact token about to be sent. 200 puts the button in the email. Anything else
//    sends the email complete and without a button, and says why in the delivery report. On
//    2026-08-14 /j/ was measured returning the static edge 404, which means it is not deployed.
// 4. INVENT A PRICE. The rating comes from lib/meter.mjs, the same engine that writes the
//    statement, so the email and the bill cannot disagree. When the caller has already rated the
//    event, that rating is printed verbatim. When it has not, the list price is printed with the
//    qualifier that the cap and any credit are applied on the statement.
//
// Secrets by env NAME only: ANSWERED_BOOKING_KEY, ANSWERED_COCKPIT_KEY, ANSWERED_CALENDAR_KEY,
// ANSWERED_ACCOUNT_KEY, RESEND_API_KEY, ANSWERED_SMS_*, ANSWERED_AUTOPILOT_KILL. None of them is
// logged, echoed, or written into a token payload.

import crypto from 'node:crypto';
import * as out from './outbox.mjs';
import { foldLine, prettyPhone, e164, siteOrigin, DEFAULT_TZ } from './booking.mjs';
import { rate, usd, DEFAULT_CAP_CENTS } from './meter.mjs';

export { siteOrigin, DEFAULT_TZ, usd };

// ── the vocabulary ───────────────────────────────────────────────────────────────────────────

/**
 * The four moments worth interrupting somebody for, in seventh-grade words, because these strings
 * are what a contractor reads on the settings screen. `why` is the argument for the default, not
 * a statistic: we have no customers to average, so nothing here claims what other people do.
 */
export const EVENTS = Object.freeze([
  {
    key: 'job.booked',
    label: 'A job gets booked',
    what: 'We answered, we got the name, the address, the callback number and a time, and it is on your calendar.',
    why: 'This is the one that pays for itself. It is also a charge on your bill, so the email doubles as the receipt.',
  },
  {
    key: 'job.after_hours',
    label: 'An after hours emergency',
    what: 'Somebody called outside your hours with something that will not wait.',
    why: 'This is the one where a call earns its place. A burst pipe at two in the morning is worth a ring, and a Tuesday booking is not.',
  },
  {
    key: 'daily.digest',
    label: 'The end of day summary',
    what: 'One message at the end of the day with everything the line took.',
    why: 'Routine news. It goes by email because it is a list, and a list does not fit in a text.',
  },
  {
    key: 'dispute.resolved',
    label: 'A charge you questioned gets settled',
    what: 'You pressed VOID or asked about a charge, and we finished looking at it.',
    why: 'It is about your money, so you hear about it whatever else you have switched off.',
  },
]);

export const EVENT_KEYS = Object.freeze(EVENTS.map((e) => e.key));

export const CHANNELS = Object.freeze([
  { key: 'email', label: 'Email', what: 'Lands in seconds, carries the whole job, and you can forward it.' },
  { key: 'sms', label: 'Text', what: 'A short message on your phone with the job and a link.' },
  { key: 'call', label: 'A phone call', what: 'We ring you and read it out.' },
  { key: 'voicemail', label: 'A voicemail', what: 'We leave a recorded message without waiting for you to pick up.' },
]);

export const CHANNEL_KEYS = Object.freeze(CHANNELS.map((c) => c.key));

/**
 * The defaults, which ARE the ruling. Email on everywhere. Text on everywhere except the end of
 * day summary, because a day's worth of jobs is a list and a list does not belong in a text.
 * Call and voicemail off everywhere.
 */
export const DEFAULT_EVENTS = Object.freeze({
  'job.booked': { email: true, sms: true, call: false, voicemail: false },
  'job.after_hours': { email: true, sms: true, call: false, voicemail: false },
  'daily.digest': { email: true, sms: false, call: false, voicemail: false },
  'dispute.resolved': { email: true, sms: true, call: false, voicemail: false },
});

/** Channels where switching ON is a decision with a legal trail, so we record who and when. */
export const CONSENTED_CHANNELS = Object.freeze(['call', 'voicemail']);

export const MAX_EXTRA_EMAILS = 3;

// ── the shape ────────────────────────────────────────────────────────────────────────────────

const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const clean = (s, cap) => String(s == null ? '' : s).replace(CTRL, '').replace(/\r\n?/g, '\n').trim().slice(0, cap);
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;.]+\.[^\s@,;]{2,}$/;
const isEmail = (s) => EMAIL_RE.test(String(s || '').trim());
const bool = (v, fallback) => {
  if (v === true || v === false) return v;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(s)) return s !== '' ? false : fallback;
  return fallback;
};

export function defaults() {
  const events = {};
  for (const k of EVENT_KEYS) events[k] = { ...DEFAULT_EVENTS[k] };
  return {
    v: 1,
    events,
    to: { emails: [], sms: '', call: '' },
    consent: { call: { on_at: null, by: '' }, voicemail: { on_at: null, by: '' } },
    digest_hour: 18,
    calendar_epoch: 0,
    updated_at: null,
    updated_by: '',
  };
}

/**
 * Any input at all, including null, a string, or a half-written object from an older version,
 * becomes a complete valid preference object. Never throws. A field it cannot read falls back to
 * the default rather than to undefined, because an undefined channel reads as OFF downstream and
 * would silently stop telling somebody about their jobs.
 *
 * ★ THE COMPLETE OBJECT IS ALWAYS WHAT GETS WRITTEN BACK, and that is deliberate. This lane does
 * not know whether sv_account_save_config merges shallow or deep, and a partial patch behaves
 * differently under the two. A complete, fixed-shape object produces the same stored result under
 * either one, so the storage semantics cannot silently change the meaning of a saved setting.
 */
export function normalize(raw) {
  const d = defaults();
  const p = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  const src = p.events && typeof p.events === 'object' ? p.events : {};
  for (const ek of EVENT_KEYS) {
    const row = src[ek] && typeof src[ek] === 'object' ? src[ek] : {};
    for (const ck of CHANNEL_KEYS) d.events[ek][ck] = bool(row[ck], DEFAULT_EVENTS[ek][ck]);
  }

  const to = p.to && typeof p.to === 'object' ? p.to : {};
  const list = Array.isArray(to.emails) ? to.emails : (typeof to.emails === 'string' ? to.emails.split(/[,\s;]+/) : []);
  const seen = new Set();
  d.to.emails = [];
  for (const raw of list) {
    const addr = clean(raw, 200).toLowerCase();
    if (!isEmail(addr) || seen.has(addr)) continue;
    seen.add(addr);
    d.to.emails.push(addr);
    if (d.to.emails.length >= MAX_EXTRA_EMAILS) break;
  }
  d.to.sms = e164(to.sms);
  d.to.call = e164(to.call);

  const con = p.consent && typeof p.consent === 'object' ? p.consent : {};
  for (const ch of CONSENTED_CHANNELS) {
    const c = con[ch] && typeof con[ch] === 'object' ? con[ch] : {};
    const at = c.on_at ? new Date(c.on_at) : null;
    d.consent[ch] = {
      on_at: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null,
      by: clean(c.by, 200),
    };
  }

  const hr = Number(p.digest_hour);
  d.digest_hour = Number.isInteger(hr) && hr >= 0 && hr <= 23 ? hr : 18;

  const ep = Number(p.calendar_epoch);
  d.calendar_epoch = Number.isInteger(ep) && ep >= 0 && ep < 1e6 ? ep : 0;

  const up = p.updated_at ? new Date(p.updated_at) : null;
  d.updated_at = up && !Number.isNaN(up.getTime()) ? up.toISOString() : null;
  d.updated_by = clean(p.updated_by, 200);
  return d;
}

/**
 * Read prefs off whatever shape you have: the flat row sv_account_notify returns, or a whole
 * account row. Missing is not an error and never blocks a send.
 *
 * The `config.notify` branch is kept ONLY so `calendar_epoch` has a defined home the day a column
 * exists. Nothing is stored there today, and the measured reason is in the STORED_FIELDS note.
 */
export const prefsOf = (accountOrFlat) => {
  const o = accountOrFlat && typeof accountOrFlat === 'object' ? accountOrFlat : {};
  if ('sms_on' in o || 'call_on' in o || 'email_extra' in o) return fromStored(o);
  return normalize(o.config && o.config.notify);
};

/**
 * The customer's stored answer, fetched from the RPC that actually holds it.
 *
 * ★ deliver() calls this itself rather than trusting a caller to pass prefs, for the same reason
 * lib/outbox.mjs puts the do-not-contact check inside sms(). A read a caller can forget is a
 * setting a caller can ignore. A failure here degrades to the DEFAULTS with `stored:false`
 * attached, never to silence, because "we could not read your choice" must not become "you chose
 * nothing".
 */
export async function loadStoredPrefs(accountId) {
  try {
    const jobs = await import('./jobs.mjs');
    const flat = await jobs.notifyPrefs(accountId);
    if (flat && typeof flat === 'object') return { prefs: fromStored(flat), stored: flat.stored === true, reason: '' };
    return { prefs: defaults(), stored: false, reason: 'the database returned no notification settings for this account, so the defaults are in force' };
  } catch (e) {
    console.error(`notify: could not read stored prefs for ${accountId}: ${String((e && e.message) || e).slice(0, 160)}`);
    return { prefs: defaults(), stored: false, reason: 'your saved settings could not be read, so the defaults were used and you were still told' };
  }
}

/**
 * Apply changes and stamp consent. `changes` is { 'job.booked': { call: true }, ... } plus the
 * optional top-level fields. Returns { prefs, changed:[...], warnings:[...] }.
 *
 * ★ A CONSENT STAMP IS WRITTEN WHEN A CONSENTED CHANNEL GOES ON, AND IS NOT ERASED WHEN IT GOES
 * OFF ANYWHERE. A ringless voicemail drop is a call under the TCPA, so the fact that somebody
 * switched it on, and when, is a record about the past. It clears only when the channel is off for
 * every event, which is the moment it stops being a permission that anything can act on.
 */
export function applyChanges(current, changes = {}, actor = '') {
  const prefs = normalize(current);
  const before = JSON.parse(JSON.stringify(prefs.events));
  const changed = [];
  const refused = [];

  const ev = changes.events && typeof changes.events === 'object' ? changes.events : changes;
  for (const ek of EVENT_KEYS) {
    const row = ev && ev[ek] && typeof ev[ek] === 'object' ? ev[ek] : null;
    if (!row) continue;
    for (const ck of CHANNEL_KEYS) {
      if (!(ck in row)) continue;
      const next = bool(row[ck], prefs.events[ek][ck]);
      if (next !== prefs.events[ek][ck]) {
        prefs.events[ek][ck] = next;
        changed.push(`${ek}.${ck} ${next ? 'on' : 'off'}`);
      }
    }
  }

  if (changes.to && typeof changes.to === 'object') {
    const merged = normalize({ ...prefs, to: { ...prefs.to, ...changes.to } });
    if (JSON.stringify(merged.to) !== JSON.stringify(prefs.to)) changed.push('who it goes to');
    prefs.to = merged.to;
  }
  if ('digest_hour' in changes) {
    const hr = Number(changes.digest_hour);
    if (Number.isInteger(hr) && hr >= 0 && hr <= 23 && hr !== prefs.digest_hour) {
      prefs.digest_hour = hr;
      changed.push('the time the summary goes out');
    }
  }
  // ★ NOT A CONTROL TODAY, AND IT MUST NOT PRETEND TO BE ONE. See STORED_FIELDS below: the only
  // notification storage that exists is sv_account_notify_save, and it silently drops every key
  // outside its whitelist, `calendar_epoch` included. So bumping the number here would change a
  // value in memory, report "your old link stops working", and leave the old link working. The
  // token already carries the epoch, so the day a column exists this becomes one line.
  if (changes.rotate_calendar === true || changes.rotate_calendar === 'on') {
    refused.push('Replacing the calendar link is not switched on yet. There is nowhere to record that it was replaced, so nothing was changed and your current link still works.');
  }

  const now = new Date().toISOString();
  for (const ch of CONSENTED_CHANNELS) {
    const onNow = EVENT_KEYS.some((ek) => prefs.events[ek][ch]);
    const onBefore = EVENT_KEYS.some((ek) => before[ek][ch]);
    if (onNow && !onBefore) prefs.consent[ch] = { on_at: now, by: clean(actor, 200) };
    if (!onNow && onBefore) prefs.consent[ch] = { on_at: null, by: '' };
  }

  if (changed.length) {
    prefs.updated_at = now;
    prefs.updated_by = clean(actor, 200);
  }
  return { prefs, changed, refused, warnings: warningsFor(prefs) };
}

// ── the storage that actually exists, measured rather than assumed ───────────────────────────
//
// ★ THIS BLOCK IS HERE BECAUSE I GOT IT WRONG AND THE DATABASE TOLD ME SO.
// I stored these preferences as `config.notify` through sv_account_save_config. Measured against
// the live database on 2026-08-14: that RPC keeps a WHITELIST and silently drops anything outside
// it. `notify` was dropped, the call returned 200 with the whole account row, and a read back
// showed `config.notify` undefined, while a control write to `greeting_name` in the same script
// persisted. A settings screen on top of that would have told a contractor his choice was saved
// every time and changed nothing, forever, with no error anywhere.
//
// So the authority is sv_account_notify / sv_account_notify_save, which @LANE-JOBREC built and
// which the portal already writes. These six fields are the ones a round trip proved persist:
export const STORED_FIELDS = Object.freeze(['sms_on', 'sms_to', 'call_on', 'call_to', 'call_after_hours_only', 'email_extra']);

// And these are the ones this model can express that the storage cannot hold yet. They are not
// hidden: every read reports them so a page can say which switches are real.
export const UNSTORED = Object.freeze({
  per_event: 'Choosing different channels for different kinds of news is not saved yet. There is one setting for texts and one for calls, and they apply to every kind of news.',
  voicemail: 'Leaving a voicemail is not a setting yet, because nothing can leave one yet.',
  digest: 'The end of day summary is not a setting yet. It goes by email.',
  calendar_epoch: 'Replacing your calendar link is not saved yet, so the link you have is the link you keep.',
});

/**
 * The flat row sv_account_notify returns, projected into the per event matrix this file speaks.
 * The projection is deterministic and it is faithful: one text switch and one call switch, exactly
 * as they are stored, plus the after hours rule the customer set. Nothing here invents a
 * preference the customer never expressed.
 */
export function fromStored(flat) {
  const f = flat && typeof flat === 'object' ? flat : {};
  const p = defaults();
  const smsOn = f.sms_on !== false;
  const callOn = f.call_on === true;
  const afterOnly = f.call_after_hours_only !== false;
  for (const ek of EVENT_KEYS) {
    p.events[ek].email = true;                       // automatic, never a toggle. David's ruling.
    p.events[ek].sms = smsOn;
    p.events[ek].call = callOn && (afterOnly ? ek === 'job.after_hours' : true);
    p.events[ek].voicemail = false;                  // no storage, and nothing to deliver it
  }
  p.to.emails = Array.isArray(f.email_extra) ? f.email_extra.map((x) => String(x || '')).filter(Boolean).slice(0, MAX_EXTRA_EMAILS) : [];
  p.to.sms = e164(f.sms_to) || '';
  p.to.call = e164(f.call_to) || '';
  p.updated_at = f.updated_at || null;
  p.updated_by = f.updated_by || '';
  p.stored = f.stored === true;
  p.call_after_hours_only = afterOnly;
  return p;
}

/** The matrix, back down into the six fields the database will actually keep. */
export function toStored(prefs) {
  const p = normalize(prefs);
  const anyCall = EVENT_KEYS.some((ek) => p.events[ek].call);
  const onlyAfterHours = anyCall && !EVENT_KEYS.some((ek) => ek !== 'job.after_hours' && p.events[ek].call);
  return {
    sms_on: EVENT_KEYS.some((ek) => p.events[ek].sms),
    call_on: anyCall,
    call_after_hours_only: anyCall ? onlyAfterHours : true,
    email_extra: p.to.emails,
    ...(p.to.sms ? { sms_to: p.to.sms } : {}),
    ...(p.to.call ? { call_to: p.to.call } : {}),
  };
}

/**
 * What a save actually kept, read back out of the database's own answer rather than out of what we
 * sent it. Anything requested that did not come back is reported by name. This exists because the
 * failure it catches is invisible: the RPC returns 200 either way.
 */
export function whatPersisted(requested, returned) {
  const kept = [];
  const dropped = [];
  const r = returned && typeof returned === 'object' ? returned : {};
  for (const [k, v] of Object.entries(requested || {})) {
    const got = r[k];
    const same = JSON.stringify(got) === JSON.stringify(v);
    (same ? kept : dropped).push(k);
  }
  return { kept, dropped, stored: r.stored === true };
}

/**
 * The honest consequences of a configuration, in the customer's words. This is NOT an override.
 * An owner is allowed to switch everything off; he is not allowed to do it without being told what
 * it means. The portal renders these; nothing here silently protects him from his own setting.
 */
export function warningsFor(prefs, availability = channelAvailability()) {
  const p = normalize(prefs);
  const w = [];
  for (const e of EVENTS) {
    const on = CHANNEL_KEYS.filter((ck) => p.events[e.key][ck]);
    const live = on.filter((ck) => availability[ck] && availability[ck].available);
    if (!on.length) {
      w.push({
        event: e.key,
        severity: 'high',
        text: `You have switched off every way of being told when ${lower(e.label)}. Nothing will reach you about it.`,
      });
    } else if (!live.length) {
      w.push({
        event: e.key,
        severity: 'high',
        text: `The only ways you asked to be told when ${lower(e.label)} are ${andList(on.map(labelOf))}, and none of those can deliver today. ${availability[on[0]].reason}`,
      });
    }
  }
  return w;
}

const labelOf = (k) => (CHANNELS.find((c) => c.key === k) || { label: k }).label.toLowerCase();
const lower = (s) => String(s).charAt(0).toLowerCase() + String(s).slice(1);
const andList = (xs) => (xs.length <= 1 ? (xs[0] || '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

// ── what can actually deliver, right now ─────────────────────────────────────────────────────

export const CALL_OFF_REASON =
  'We do not place calls from notifications. Ringing you is a different system with its own rules about consent and recording, and it is not wired into this one. You can switch this on now and it starts working the day it is.';

export const VOICEMAIL_OFF_REASON =
  'We do not leave voicemails from notifications yet. Dropping a recorded message counts as a phone call under the federal rules, so it runs through the calling system, not this one. You can switch it on now and it starts working the day it is.';

/**
 * Measured from process.env INSIDE the running function, never from a control-plane listing.
 * RESEND_API_KEY on this project is context scoped: `netlify env:list` cannot see it and reported
 * it absent while it was working. A listing is not a measurement.
 */
export function channelAvailability(env = process.env) {
  const hasResend = Boolean(String(env.RESEND_API_KEY || '').trim());
  const s = out.smsStatus();
  const killed = /^(1|true|yes|on)$/i.test(String(env.ANSWERED_AUTOPILOT_KILL || '').trim());
  const dialSuffix = killed ? ' Outbound calling is also switched off on this deploy.' : '';
  return {
    email: {
      available: hasResend,
      dark: false,
      reason: hasResend ? '' : 'Email is not configured on this deploy, so nothing can be sent.',
    },
    sms: {
      available: s.ready,
      dark: !s.enabled,
      reason: s.ready ? '' : s.reason,
    },
    call: { available: false, dark: true, reason: CALL_OFF_REASON + dialSuffix },
    voicemail: { available: false, dark: true, reason: VOICEMAIL_OFF_REASON + dialSuffix },
  };
}

/**
 * What WILL happen for one event, before anything is sent. Separating the plan from the send is
 * what lets the settings screen tell the truth without sending anything to find out.
 */
export function plan(prefs, eventKey, availability = channelAvailability()) {
  const p = normalize(prefs);
  const row = p.events[eventKey];
  if (!row) return { event: eventKey, deliver: [], skipped: [], unknown_event: true };
  const deliver = [];
  const skipped = [];
  for (const ck of CHANNEL_KEYS) {
    if (!row[ck]) { skipped.push({ channel: ck, reason: 'You have this one switched off.', off_by_choice: true }); continue; }
    const a = availability[ck];
    if (!a || !a.available) { skipped.push({ channel: ck, reason: a ? a.reason : 'unknown channel', off_by_choice: false }); continue; }
    deliver.push(ck);
  }
  return { event: eventKey, deliver, skipped };
}

// ── the two signed links ─────────────────────────────────────────────────────────────────────
//
// Both follow lib/booking.mjs exactly: v.payload.mac, HMAC-SHA256, base64url, constant-time
// compare, fail closed with no key. The receipt key is deliberately the SAME key family as
// booking's so one rotation covers every job link a customer holds. The calendar key is allowed
// its own, because a calendar URL lives in somebody's phone for years and a job link lives for
// days, and two lifetimes that different should be rotatable apart.

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function receiptKey(env = process.env) {
  const own = String(env.ANSWERED_BOOKING_KEY || '').trim();
  if (own) return own;
  const fallback = String(env.ANSWERED_COCKPIT_KEY || '').trim();
  if (fallback) return fallback;
  return '';
}

export function calendarKey(env = process.env) {
  const own = String(env.ANSWERED_CALENDAR_KEY || '').trim();
  if (own) return own;
  return receiptKey(env);
}

const macWith = (key, payload) => b64u(crypto.createHmac('sha256', key).update(payload).digest());

const sameMac = (want, got) => {
  const a = Buffer.from(String(want));
  const b = Buffer.from(String(got));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/**
 * The credential that opens ONE job with no password and no account, which is the Parley pattern
 * and the reason a login is optional. It is a REFERENCE, not a copy: the jobs row is the truth and
 * this only proves you are allowed to read it. That is the opposite of lib/booking.mjs's
 * self-contained token, and both are right for their case. A self-contained token cannot show a
 * job that was voided after it was sent; a reference can, and a void must reach the person.
 *
 * ★ THE FORMAT IS NOT MINE TO CHOOSE, AND MEASURING THAT COST THIS LANE ITS ONLY REAL DEFECT.
 * This file originally minted `v1.<payload>.<HMAC(payload)>`. The route that actually SERVES
 * /j/<token> is portal.mjs, and it verifies with lib/jobs.mjs `readReceipt`, which expects
 * `r1.<payload>.<HMAC("answered.receipt.v1|" + payload)>`. Measured on 2026-08-14, in process:
 * `jobs.readReceipt(receiptToken(job))` returned **null**, so every receipt link this lane emailed
 * would have been refused by /j/ as a forgery the day portal.mjs deployed. The probe in deliver()
 * would have caught it and quietly shipped every email with no button, which is the failure that
 * looks like success: all 52 tests green, all channels reporting ok, and the "link first, login
 * optional" architecture delivering zero working links.
 *
 * So the SCHEME here is jobs.mjs's scheme, byte for byte, including the label inside the MAC input
 * (domain separation: a receipt token cannot verify as a feed token even with the key in hand) and
 * its 900 character cap (so a token one side mints is never one the other side rejects on length).
 * It is reimplemented rather than imported for ONE reason: these functions take an injected `env`,
 * which is what lets the tests prove they FAIL CLOSED with a rotated key and with no key at all,
 * and jobs.mjs reads process.env directly. The anti-drift control is therefore not an import, it is
 * a contract test that mints with each module and reads with the other, in BOTH directions. If
 * @LANE-JOBREC ever changes the format, that test fails loudly instead of a link going dark.
 */
const RECEIPT_LABEL = 'answered.receipt.v1';
const MAX_TOKEN_CHARS = 900;

const macLabeled = (key, label, payload) =>
  b64u(crypto.createHmac('sha256', key).update(`${label}|${payload}`).digest());

export function receiptToken(job, env = process.env) {
  const key = receiptKey(env);
  if (!key) return '';
  const ref = clean(job && (job.job_ref || job.ref || job.id), 64);
  const acct = clean(job && (job.account_id || job.account), 64);
  if (!ref) return '';
  const payload = b64u(Buffer.from(JSON.stringify({
    v: 1, r: ref, ...(acct ? { a: acct } : {}), i: Date.now(),
  }), 'utf8'));
  const token = `r1.${payload}.${macLabeled(key, RECEIPT_LABEL, payload)}`;
  return token.length > MAX_TOKEN_CHARS ? '' : token;
}

/**
 * The job reference this token proves, or null. Never throws, never partially trusts.
 * Reads the same `r1` scheme lib/jobs.mjs `readReceipt` reads, so a token minted by either module
 * verifies in both. The return shape stays this lane's ({ ref, account_id, minted_at }) because
 * callers here depend on it; `i` is a millisecond stamp, so it is converted rather than echoed.
 */
export function readReceiptToken(token, env = process.env) {
  const key = receiptKey(env);
  if (!key) return null;
  const t = String(token || '');
  if (!t || t.length > MAX_TOKEN_CHARS) return null;
  const parts = t.split('.');
  if (parts.length !== 3 || parts[0] !== 'r1') return null;
  const [, payload, sig] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(sig)) return null;
  if (!sameMac(macLabeled(key, RECEIPT_LABEL, payload), sig)) return null;
  try {
    const o = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!o || o.v !== 1 || !o.r) return null;
    const stamp = Number(o.i);
    return {
      ref: String(o.r),
      account_id: String(o.a || ''),
      minted_at: Number.isFinite(stamp) && stamp > 0 ? new Date(stamp).toISOString() : '',
    };
  } catch { return null; }
}

export const receiptUrl = (token, env = process.env) => `${siteOrigin()}/j/${token}`;

/**
 * The calendar subscription credential. It carries the account and an EPOCH, and the serving path
 * refuses a token whose epoch is behind the stored one. That is what makes "replace my calendar
 * link" a real control: a feed URL carries customers' names, addresses and phone numbers, and a
 * URL that leaks with no way to kill it is a permanent leak.
 */
export function calendarToken(accountId, epoch = 0, env = process.env) {
  const key = calendarKey(env);
  if (!key || !accountId) return '';
  const payload = b64u(Buffer.from(JSON.stringify({ v: 1, a: String(accountId), e: Number(epoch) || 0 }), 'utf8'));
  return `c1.${payload}.${macWith(key, payload)}`;
}

export function readCalendarToken(token, env = process.env) {
  const key = calendarKey(env);
  if (!key) return null;
  const t = String(token || '').replace(/\.ics$/i, '');
  if (!t || t.length > 2000) return null;
  const parts = t.split('.');
  if (parts.length !== 3 || parts[0] !== 'c1') return null;
  const [, payload, sig] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(sig)) return null;
  if (!sameMac(macWith(key, payload), sig)) return null;
  try {
    const o = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!o || o.v !== 1 || !o.a) return null;
    return { account_id: String(o.a), epoch: Number(o.e) || 0 };
  } catch { return null; }
}

export const calendarUrl = (token) => `${siteOrigin()}/api/calendar/${token}.ics`;

/**
 * The same URL with the scheme calendar apps register for. Tapping a webcal:// link on an iPhone
 * opens Calendar with the subscription sheet already filled in, which is the difference between a
 * feature somebody uses and a URL they are asked to copy.
 */
export const webcalUrl = (token) => calendarUrl(token).replace(/^https?:/, 'webcal:');

// ── proving a link before we send it ─────────────────────────────────────────────────────────

const probeCache = new Map();

/**
 * Fetch the link we are about to put in an email and see whether it answers.
 *
 * ★ THIS IS NOT PARANOIA, IT IS THE HOUSE LESSON. On 2026-08-05 this estate shipped a homepage
 * play button over an mp4 that was gitignored: the control rendered, it could not act, and every
 * check passed. A receipt button that 404s is the same defect wearing a different hat, and it is
 * worse here because the customer has already been told the job is booked.
 *
 * Cached by ROUTE for `ttlMs`. Pass ttlMs:0 to prove the exact token, which is what the send path
 * does: one extra request per notification, and in exchange every link we email has been fetched.
 */
export async function probeLink(url, { ttlMs = 0, timeoutMs = 4000 } = {}) {
  let cacheKey = '';
  if (ttlMs > 0) {
    try { cacheKey = new URL(url).pathname.split('/').slice(0, 2).join('/'); } catch { cacheKey = ''; }
    const hit = probeCache.get(cacheKey);
    if (hit && Date.now() - hit.at < ttlMs) return { ...hit.result, cached: true };
  }
  let result;
  try {
    const r = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': 'Answered-LinkCheck/1.0', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    result = r.status === 200
      ? { ok: true, status: 200, reason: '' }
      : {
        ok: false,
        status: r.status,
        reason: `The job page answered ${r.status}, so no link was included rather than a link that does not open.`,
      };
  } catch (e) {
    result = {
      ok: false,
      status: 0,
      reason: `The job page could not be reached to check it (${String((e && e.message) || e).slice(0, 80)}), so no link was included.`,
    };
  }
  if (ttlMs > 0 && cacheKey) probeCache.set(cacheKey, { at: Date.now(), result });
  return { ...result, cached: false };
}

// ── money ────────────────────────────────────────────────────────────────────────────────────

export const MONTHLY_CAP_CENTS = DEFAULT_CAP_CENTS;

/**
 * What this job costs, said the way the statement will say it.
 *
 * A caller that has already metered the event passes its rating straight through, so the email and
 * the ledger print the same sentence. A caller that has not gets the LIST price from the same
 * engine, plus the qualifier, because this path cannot see how much of the cap is already spent
 * and a number that ignores the cap is a number that can be wrong in the customer's favour and
 * still be wrong.
 */
export function priceFor(job, { rating = null, account = {} } = {}) {
  if (rating && typeof rating === 'object' && typeof rating.cents === 'number') {
    return {
      cents: rating.cents,
      amount: usd(rating.cents),
      reason: String(rating.reason || ''),
      list_only: false,
      billable: Boolean(rating.billable),
    };
  }
  const after = job && job.after_hours === true;
  const evidence = {
    name: job && job.caller_name,
    address: job && job.address,
    callback: job && job.callback,
    window: job && (job.window_start || job.window),
  };
  const r = rate(
    {
      kind: after ? 'booked_job_after_hours' : 'booked_job',
      evidence,
      booked_at: after ? (job && (job.created_at || job.window_start)) || new Date().toISOString() : undefined,
    },
    account,
  );
  if (!r.ok) return null;
  return {
    cents: r.cents,
    amount: usd(r.cents),
    reason: r.reason,
    list_only: true,
    billable: Boolean(r.billable),
    missing_pieces: r.missing_pieces || [],
  };
}

export const capSentence = () => `Your bill for jobs stops at ${usd(MONTHLY_CAP_CENTS)} in a month, however many come in.`;

// ── time, said the way a person says it ──────────────────────────────────────────────────────

const fmt = (date, tz, opts) => {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(date); }
  catch { return new Intl.DateTimeFormat('en-US', opts).format(date); }
};

/** { day, window, zone } for a job row, or null when there is no usable start. */
export function whenOf(job, tz = DEFAULT_TZ) {
  const s = job && job.window_start ? new Date(job.window_start) : null;
  if (!s || Number.isNaN(s.getTime())) return null;
  const e = job && job.window_end ? new Date(job.window_end) : null;
  const hasEnd = e && !Number.isNaN(e.getTime()) && e.getTime() > s.getTime();
  let zone = '';
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(s);
    zone = (parts.find((x) => x.type === 'timeZoneName') || {}).value || '';
  } catch { zone = ''; }
  return {
    day: fmt(s, tz, { weekday: 'long', month: 'long', day: 'numeric' }),
    window: hasEnd
      ? `${fmt(s, tz, { hour: 'numeric', minute: '2-digit' })} to ${fmt(e, tz, { hour: 'numeric', minute: '2-digit' })}`
      : fmt(s, tz, { hour: 'numeric', minute: '2-digit' }),
    zone,
    has_end: Boolean(hasEnd),
    start: s,
    end: hasEnd ? e : null,
  };
}

// ── RFC 5545 ─────────────────────────────────────────────────────────────────────────────────
//
// THREE DETAILS THAT DECIDE WHETHER A CALENDAR OPENS THE FILE OR SILENTLY REFUSES IT:
//
//   CRLF everywhere, including after the last line. A bare LF is the single most common reason a
//   feed half parses.
//
//   Folding at 75 OCTETS, not 75 characters, on a code point boundary. One accented street name
//   folded by character count produces a byte sequence that is not valid UTF-8. foldLine in
//   lib/booking.mjs already does this correctly and is imported rather than rewritten.
//
//   NO `METHOD:` PROPERTY ON A SUBSCRIPTION FEED. METHOD is an iTIP field (RFC 5546). A file
//   carrying METHOD:PUBLISH is a message ABOUT events; a subscribed calendar is a collection OF
//   them. Outlook in particular treats the two differently, and the single-job attachment that
//   lib/booking.mjs writes is the case where METHOD is correct. This is not.
//
// TIMES ARE UTC WITH A TRAILING Z, DELIBERATELY. The alternative is TZID plus a VTIMEZONE block
// carrying the full daylight-saving rules, which is a large amount of generated code whose bugs
// appear twice a year at 2am. UTC is unambiguous, every client converts it to the reader's own
// zone, and X-WR-TIMEZONE tells the client which zone the calendar thinks in.

export const icsEsc = (s) => String(s == null ? '' : s)
  .replace(CTRL, '')
  .replace(/\\/g, '\\\\')
  .replace(/;/g, '\\;')
  .replace(/,/g, '\\,')
  .replace(/\r?\n/g, '\\n');

export const icsStamp = (d) => {
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return null;
  return t.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
};

export const ICS_PRODID = '-//Answered//Job feed//EN';

/**
 * One job row as a VEVENT.
 *
 * ★ A VOID IS A STATUS CHANGE AND IT STAYS IN THE FEED AS `STATUS:CANCELLED`. Dropping the event
 * instead would leave a stale copy on the phone of the person who subscribed, which is the one
 * outcome a cancellation must not produce. SEQUENCE goes to 1 so a client that has already seen
 * the event knows this is an update to it and not a different one.
 *
 * ★ NO DTEND IS INVENTED. RFC 5545 3.6.1 says a VEVENT with a DATE-TIME DTSTART and no DTEND ends
 * at the same instant, so leaving it out is a defined, honest zero length. Writing DTEND as start
 * plus an hour would be this system promising the customer an hour nobody agreed to.
 */
export function jobEvent(job, { origin = siteOrigin(), receipt = '', price = null } = {}) {
  const start = job && job.window_start ? new Date(job.window_start) : null;
  if (!start || Number.isNaN(start.getTime())) return null;
  const end = job && job.window_end ? new Date(job.window_end) : null;
  const hasEnd = end && !Number.isNaN(end.getTime()) && end.getTime() > start.getTime();

  const ref = String(job.job_ref || job.id || '').trim();
  if (!ref) return null;
  const voided = String(job.status || '').toLowerCase() === 'void'
    || String(job.status || '').toLowerCase() === 'voided'
    || Boolean(job.voided_at);

  const who = String(job.caller_name || '').trim();
  const trade = String(job.trade || '').trim();
  const head = trade ? `${trade} for ${who || 'a caller'}` : (who ? `Job for ${who}` : 'Job');
  const summary = `${voided ? 'CANCELLED: ' : ''}${job.after_hours === true ? 'After hours: ' : ''}${head}`;

  const desc = [
    who ? `Caller: ${who}` : '',
    job.callback ? `Callback: ${prettyPhone(e164(job.callback) || job.callback)}` : 'No callback number was captured on this call.',
    job.address ? `Address: ${job.address}` : 'No address was captured on this call.',
    trade ? `Work: ${trade}` : '',
    job.after_hours === true ? 'This came in after hours.' : '',
    hasEnd ? '' : 'Only a start time was captured, so this shows with no end time rather than an hour nobody agreed to.',
    price ? `Price: ${price.amount}. ${price.reason}` : '',
    voided ? `VOIDED${job.void_reason ? `: ${job.void_reason}` : ''}. Nothing is owed on this one.` : '',
    `Job number: ${ref}`,
    job.source ? `Came from: ${job.source}` : '',
    receipt ? `Job page: ${receipt}` : '',
    'Booked by Answered.',
  ].filter(Boolean).join('\n');

  const lines = [
    'BEGIN:VEVENT',
    `UID:${icsEsc(ref)}@answered.reddenda.com`,
    `DTSTAMP:${icsStamp(job.created_at || new Date())}`,
    `DTSTART:${icsStamp(start)}`,
    hasEnd ? `DTEND:${icsStamp(end)}` : '',
    `SUMMARY:${icsEsc(summary)}`,
    `DESCRIPTION:${icsEsc(desc)}`,
    job.address ? `LOCATION:${icsEsc(job.address)}` : '',
    receipt ? `URL:${icsEsc(receipt)}` : '',
    trade ? `CATEGORIES:${icsEsc(trade)}` : '',
    `STATUS:${voided ? 'CANCELLED' : 'CONFIRMED'}`,
    `SEQUENCE:${voided ? 1 : 0}`,
    `LAST-MODIFIED:${icsStamp(job.voided_at || job.created_at || new Date())}`,
    'TRANSP:OPAQUE',
    ...(voided ? [] : [
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${icsEsc(`${head}${job.address ? ` at ${job.address}` : ''}`)}`,
      'TRIGGER:-PT60M',
      'END:VALARM',
    ]),
    'END:VEVENT',
  ].filter(Boolean);
  return lines;
}

/**
 * A whole subscribable calendar. `jobs` may be empty, and an empty calendar is a valid calendar
 * and a true statement. It is NOT what to serve when the jobs could not be read: see calendar.mjs
 * for why an unknown answer must be a 503 and never an empty 200.
 */
export function calendarFeed(jobs, { name, description, tz = DEFAULT_TZ, refresh = 'PT1H', origin = siteOrigin(), events = null } = {}) {
  const body = events || (Array.isArray(jobs) ? jobs : [])
    .map((j) => jobEvent(j, { origin }))
    .filter(Boolean)
    .flat();

  const head = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${ICS_PRODID}`,
    'CALSCALE:GREGORIAN',
    `NAME:${icsEsc(name)}`,
    `X-WR-CALNAME:${icsEsc(name)}`,
    `DESCRIPTION:${icsEsc(description)}`,
    `X-WR-CALDESC:${icsEsc(description)}`,
    `X-WR-TIMEZONE:${icsEsc(tz)}`,
    `REFRESH-INTERVAL;VALUE=DURATION:${refresh}`,
    `X-PUBLISHED-TTL:${refresh}`,
  ];
  const all = [...head, ...body, 'END:VCALENDAR'];
  return `${all.map(foldLine).join('\r\n')}\r\n`;
}

// ── the messages ─────────────────────────────────────────────────────────────────────────────
//
// Every one of these is written for a person holding a phone in a truck. Short sentences, the
// number first, and a text/plain twin on every email because that is what is readable at arm's
// length and what keeps us out of a spam folder.

export const SMS_TRUTH = 'We did not text you about this. Text messaging is not switched on yet, so email is the channel that actually delivers.';

const money = (price) => {
  if (!price) return '';
  if (!price.billable) return `${price.amount}. ${price.reason}`;
  return price.list_only
    ? `${price.amount}. ${price.reason} Your statement is where your cap and any credit get applied.`
    : `${price.amount}. ${price.reason}`;
};

function jobRows(job, when, price) {
  const rows = [];
  if (when) rows.push(['When', `${when.day}, ${when.window}${when.zone ? ` ${when.zone}` : ''}`]);
  if (job.caller_name) rows.push(['Who called', job.caller_name]);
  if (job.callback) rows.push(['Callback', prettyPhone(e164(job.callback) || job.callback)]);
  if (job.address) rows.push(['Where', job.address]);
  if (job.trade) rows.push(['Work', job.trade]);
  if (price) rows.push(['This one costs', money(price)]);
  rows.push(['Job number', String(job.job_ref || job.id || '')]);
  return rows;
}

export function renderJobBooked({ job, account, price, receipt, when, afterHours }) {
  const biz = String((account && account.business_name) || 'your business');
  const who = String(job.caller_name || 'a caller').trim();
  const head = afterHours ? 'An after hours call turned into a job.' : 'A call turned into a job.';
  const rows = jobRows(job, when, price);
  const missing = [];
  if (!job.callback) missing.push('a callback number');
  if (!job.address) missing.push('an address');
  const gap = missing.length
    ? `<p style="margin:0 0 14px;padding:11px 13px;background:#FFF8D6;border-left:3px solid #0B0C0E;font-size:14px">This one is missing ${andList(missing)}. A job needs a name, an address, a callback number and a time before it can cost you anything, so this one is free until it has them.</p>`
    : '';
  const callBack = job.callback
    ? `<p style="margin:0 0 6px">Call them back: <a href="tel:${out.esc(e164(job.callback) || job.callback)}" style="color:#0B0C0E"><b>${out.esc(prettyPhone(e164(job.callback) || job.callback))}</b></a></p>`
    : '';

  return {
    subject: `${afterHours ? 'After hours: ' : 'Booked: '}${job.trade ? `${job.trade} ` : ''}for ${who}${when ? `, ${when.day} ${when.window}` : ''}`,
    html: out.shell({
      title: head,
      intro: `<b>${out.esc(biz)}</b> has a new booking. Everything we got is below.`,
      rows,
      body: gap + callBack,
      cta: receipt ? { href: receipt, label: 'Open the job' } : null,
      footer: `${out.esc(capSentence())}<br>${out.esc(SMS_TRUTH)}<br>Answered${receipt ? '' : '<br>This email is the whole job. There is nothing you have to click.'}`,
    }),
    text: [
      head,
      '',
      ...rows.map(([k, v]) => `${k}: ${v}`),
      ...(missing.length ? ['', `This one is missing ${andList(missing)}, so it is free until it has them.`] : []),
      ...(receipt ? ['', `Open the job: ${receipt}`] : []),
      '',
      capSentence(),
      SMS_TRUTH,
    ].join('\n'),
    sms: [
      `${afterHours ? 'AFTER HOURS. ' : ''}New job: ${job.trade || 'work'} for ${who}`,
      when ? `${when.day}, ${when.window}` : '',
      job.callback ? prettyPhone(e164(job.callback) || job.callback) : '',
      job.address || '',
      receipt || '',
    ].filter(Boolean).join('\n').slice(0, 480),
  };
}

export function renderDigest({ jobs, account, when, receiptFor }) {
  const biz = String((account && account.business_name) || 'your business');
  const n = jobs.length;
  const lines = jobs.map((j) => {
    const w = whenOf(j, (account && account.config && account.config.timezone) || DEFAULT_TZ);
    return `${w ? `${w.day}, ${w.window}` : 'no time recorded'}: ${j.trade || 'work'} for ${j.caller_name || 'a caller'}${j.address ? `, ${j.address}` : ''}`;
  });
  const rows = jobs.slice(0, 20).map((j) => {
    const w = whenOf(j, (account && account.config && account.config.timezone) || DEFAULT_TZ);
    return [w ? w.window : 'no time', `${j.trade || 'work'} for ${j.caller_name || 'a caller'}`];
  });
  return {
    subject: `${n} ${n === 1 ? 'job' : 'jobs'} booked today for ${biz}`,
    html: out.shell({
      title: `${n} ${n === 1 ? 'job' : 'jobs'} today.`,
      intro: 'Here is what the line took while you were working.',
      rows,
      body: n > 20 ? `<p style="margin:0 0 10px">Showing the first 20 of ${n}. The rest are on your calendar.</p>` : '',
      footer: `${out.esc(capSentence())}<br>${out.esc(SMS_TRUTH)}<br>Answered`,
    }),
    text: [`${n} ${n === 1 ? 'job' : 'jobs'} booked today for ${biz}.`, '', ...lines, '', capSentence(), SMS_TRUTH].join('\n'),
    sms: `${n} ${n === 1 ? 'job' : 'jobs'} booked today for ${biz}.`,
  };
}

export function renderDispute({ payload, account }) {
  const headline = String((payload && payload.headline) || 'We finished looking at a charge you questioned.');
  const detail = String((payload && payload.detail) || '');
  const rows = [];
  if (payload && payload.ref) rows.push(['Job number', String(payload.ref)]);
  if (payload && payload.outcome) rows.push(['Outcome', String(payload.outcome)]);
  if (payload && typeof payload.amount_cents === 'number') rows.push(['Amount', usd(payload.amount_cents)]);
  return {
    subject: headline.slice(0, 120),
    html: out.shell({
      title: headline,
      intro: detail ? out.esc(detail) : '',
      rows,
      footer: `${out.esc(SMS_TRUTH)}<br>Answered`,
    }),
    text: [headline, '', detail, '', ...rows.map(([k, v]) => `${k}: ${v}`), '', SMS_TRUTH].filter(Boolean).join('\n'),
    sms: `${headline}${payload && payload.ref ? ` (job ${payload.ref})` : ''}`.slice(0, 320),
  };
}

// ── the send path ────────────────────────────────────────────────────────────────────────────

const okReport = (extra = {}) => ({ ok: false, skipped: true, reason: '', ...extra });

/**
 * Tell one customer about one thing, over every channel they asked for that can actually deliver.
 *
 * THE CONTRACT: every channel appears in the result whether or not it did anything, and a channel
 * that did nothing says which of the two kinds of nothing it was. `off_by_choice:true` means the
 * owner switched it off. `off_by_choice:false` means we could not, and the reason is the real
 * sentence, never a shrug. Nothing here reports ok:true for something that did not happen.
 *
 * `ok` on the envelope means AT LEAST ONE CHANNEL ACTUALLY DELIVERED. A notification nobody
 * received is not a successful notification, whatever the status code says.
 */
export async function deliver({
  event,
  account,
  prefs = null,
  job = null,
  jobs = null,
  payload = null,
  rating = null,
  actor = 'system',
  probeReceipt = true,
  env = process.env,
} = {}) {
  const started = Date.now();
  const eventKey = String(event || '');
  const report = {
    ok: false,
    event: eventKey,
    account_id: (account && account.id) || null,
    channels: {},
    receipt: null,
    price: null,
    crm: okReport({ reason: 'not attempted' }),
    ms: 0,
  };
  for (const ck of CHANNEL_KEYS) report.channels[ck] = okReport({ reason: 'not attempted' });

  if (!EVENT_KEYS.includes(eventKey)) {
    report.error = `"${eventKey || '(none)'}" is not one of the four things this system tells anybody about: ${EVENT_KEYS.join(', ')}.`;
    report.ms = Date.now() - started;
    return report;
  }
  if (!account || !account.id) {
    report.error = 'There is no account to notify, so nothing was sent.';
    report.ms = Date.now() - started;
    return report;
  }

  let p;
  if (prefs) {
    p = prefsOf(prefs);
  } else {
    const loaded = await loadStoredPrefs(account.id);
    p = loaded.prefs;
    report.prefs_stored = loaded.stored;
    if (loaded.reason) report.prefs_note = loaded.reason;
  }
  const availability = channelAvailability(env);
  const decided = plan(p, eventKey, availability);
  report.plan = decided;
  for (const s of decided.skipped) {
    report.channels[s.channel] = okReport({ reason: s.reason, off_by_choice: s.off_by_choice });
  }

  const tz = (account.config && account.config.timezone) || DEFAULT_TZ;
  const when = job ? whenOf(job, tz) : null;
  const afterHours = eventKey === 'job.after_hours' || (job && job.after_hours === true);

  // ── the receipt link, minted and then PROVEN ────────────────────────────────────────────────
  let receipt = '';
  if (job) {
    const token = receiptToken({ ...job, account_id: job.account_id || account.id }, env);
    if (!token) {
      report.receipt = { url: '', included: false, reason: 'No signing key is configured, so no job link was minted. Set ANSWERED_BOOKING_KEY.' };
    } else {
      const url = receiptUrl(token, env);
      if (!probeReceipt) {
        receipt = url;
        report.receipt = { url, included: true, checked: false, reason: 'The link was not checked on this call.' };
      } else {
        const probe = await probeLink(url, { ttlMs: 0 });
        if (probe.ok) {
          receipt = url;
          report.receipt = { url, included: true, checked: true, status: probe.status, reason: '' };
        } else {
          report.receipt = { url: '', included: false, checked: true, status: probe.status, reason: probe.reason };
        }
      }
    }
  }

  // ── money ──────────────────────────────────────────────────────────────────────────────────
  const price = job && (eventKey === 'job.booked' || eventKey === 'job.after_hours')
    ? priceFor({ ...job, after_hours: afterHours }, { rating, account: account.billing || {} })
    : null;
  report.price = price;

  // ── the words ──────────────────────────────────────────────────────────────────────────────
  let msg;
  if (eventKey === 'daily.digest') {
    const list = Array.isArray(jobs) ? jobs : [];
    if (!list.length) {
      report.skipped_all = true;
      report.reason = 'Nothing was booked in the window, so there was nothing to summarise and no message was sent.';
      for (const ck of CHANNEL_KEYS) {
        report.channels[ck] = okReport({ reason: report.reason, off_by_choice: false });
      }
      report.ms = Date.now() - started;
      return report;
    }
    msg = renderDigest({ jobs: list, account });
  } else if (eventKey === 'dispute.resolved') {
    msg = renderDispute({ payload, account });
  } else {
    if (!job) {
      report.error = 'A booked job notification needs the job, and none was passed.';
      report.ms = Date.now() - started;
      return report;
    }
    msg = renderJobBooked({ job, account, price, receipt, when, afterHours });
  }
  report.subject = msg.subject;

  // ── deliver ────────────────────────────────────────────────────────────────────────────────
  const jobs_ = [];

  if (decided.deliver.includes('email')) {
    const to = [String(account.owner_email || '').trim(), ...p.to.emails].filter((s) => s && s.includes('@'));
    if (!to.length) {
      report.channels.email = okReport({ reason: 'This account has no email address on it, so there was nowhere to send it.', off_by_choice: false });
    } else {
      jobs_.push((async () => {
        const r = await out.email({ to, subject: msg.subject, html: msg.html, text: msg.text });
        report.channels.email = r.ok
          ? { ok: true, skipped: false, reason: '', id: r.id, to: r.to }
          : okReport({ ok: false, skipped: Boolean(r.skipped), reason: r.reason || 'email failed', off_by_choice: false });
      })());
    }
  }

  if (decided.deliver.includes('sms')) {
    const to = p.to.sms || e164(account.owner_phone);
    if (!to) {
      report.channels.sms = okReport({ reason: 'This account has no mobile number on it, so there was nowhere to text.', off_by_choice: false });
    } else {
      jobs_.push((async () => {
        const r = await out.sms({ to, body: msg.sms, transactional: true });
        report.channels.sms = r.ok
          ? { ok: true, skipped: false, reason: '', id: r.id, status: r.status, note: r.note }
          : okReport({ ok: false, skipped: Boolean(r.skipped), reason: r.reason, off_by_choice: false });
      })());
    }
  }

  // call and voicemail never reach here: channelAvailability() marks both unavailable, so plan()
  // puts them in `skipped` with the reason. This branch exists so that the day a dialer is wired
  // in, the seam is visible and nobody has to guess where it goes.
  for (const ch of ['call', 'voicemail']) {
    if (decided.deliver.includes(ch)) {
      report.channels[ch] = okReport({ reason: `${ch} was planned but this path does not dial. Nothing was attempted.`, off_by_choice: false });
    }
  }

  await Promise.all(jobs_);

  report.ok = CHANNEL_KEYS.some((ck) => report.channels[ck].ok);

  // ── rule 6: a send that does not log is a bug ──────────────────────────────────────────────
  if (report.ok && account.owner_email) {
    try {
      const hub = await import('./hubspot-answered.mjs');
      const landed = CHANNEL_KEYS.filter((ck) => report.channels[ck].ok);
      const r = await hub.record({
        email: account.owner_email,
        product: 'answered',
        source: `notify/${eventKey}`,
        phone: account.owner_phone || undefined,
        noteTitle: msg.subject,
        noteBody: [
          `Answered told this customer about: ${eventKey}`,
          `Delivered by: ${landed.join(', ') || 'nothing'}`,
          job ? `Job: ${job.job_ref || job.id || ''}` : '',
          price ? `Priced: ${price.amount}. ${price.reason}` : '',
          receipt ? `Job page: ${receipt}` : 'No job link was included, because the receipt page did not answer.',
        ].filter(Boolean).join('\n'),
      });
      report.crm = (r.errors && r.errors.length)
        ? { ok: false, skipped: false, reason: r.errors.join('; ').slice(0, 240), contact: r.contact ? r.contact.id : null }
        : { ok: true, skipped: false, reason: '', contact: r.contact ? r.contact.id : null };
    } catch (e) {
      report.crm = okReport({ ok: false, skipped: false, reason: String((e && e.message) || e).slice(0, 200) });
    }
  } else if (!report.ok) {
    report.crm = okReport({ reason: 'Nothing was delivered, so there was nothing to log.' });
  }

  report.ms = Date.now() - started;
  return report;
}
