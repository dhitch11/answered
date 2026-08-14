// hold-store.mjs — the Hold session record, the words the line actually speaks, and the receipt.
//
// Three jobs that belong together because they share one invariant: THE RECEIPT IS RENDERED FROM
// THE RECORD, and the record is written as the call happens. Nothing on the receipt is recomputed
// at render time from something plausible. If a clock is not on the row, the receipt says so
// rather than filling the gap.

import crypto from 'node:crypto';
import * as db from './db.mjs';
import { spokenNumber } from './scripts.mjs';
import { rate } from './meter.mjs';
import * as ledger from './ledger.mjs';

export const newToken = () => crypto.randomBytes(24).toString('hex'); // 192 bits, same as truce
export const TOKEN_RE = /^[0-9a-f]{48}$/;

// ── the record ───────────────────────────────────────────────────────────────────────────────
export const create   = (row) => db.rpc('sv_hold_create', { p_row: row });
export const patch    = (id, p) => db.rpc('sv_hold_update', { p_id: id, p_patch: p });
export const get      = (id, events = 200) => db.rpc('sv_hold_get', { p_id: id, p_events: events });
export const byCall   = (sid) => db.rpc('sv_hold_by_call', { p_call_sid: sid });
export const list     = (status = null, limit = 50) => db.rpc('sv_hold_list', { p_status: status, p_limit: limit });

/**
 * ★ AN EVENT WRITE THAT FAILS MUST NOT TAKE THE CALL DOWN WITH IT. Every one of these happens
 * inside a live Twilio webhook that has about ten seconds to return TwiML, and a person may be
 * on the far end of it. A logging failure is logged and swallowed; a failure that matters is
 * handled by its own caller.
 */
export async function event(id, kind, payload) {
  try { return await db.rpc('sv_hold_event', { p_id: id, p_kind: kind, p_payload: payload || {} }); }
  catch (e) { console.error(`hold event ${kind} failed:`, String(e.message).slice(0, 140)); return null; }
}

/** The customer's own door. Takes the session token, never the estate secret. */
export async function view(token) {
  const url = process.env.ANSWERED_DB_URL;
  const anon = process.env.ANSWERED_DB_ANON;
  if (!url || !anon) throw new Error('db not configured');
  const res = await fetch(`${url}/rest/v1/rpc/hd_view`, {
    method: 'POST',
    headers: { apikey: anon, Authorization: `Bearer ${anon}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_token: token }),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`hd_view ${res.status}`);
  return text ? JSON.parse(text) : null;
}

// ── what the line says when it reaches a person ──────────────────────────────────────────────
//
// ★ FOUR OBLIGATIONS, IN THE FIRST SENTENCES, AND THEY DO NOT COME OFF.
//   1. who is responsible for the call        47 CFR 64.1200(b)(1)
//   2. a callback number                      47 CFR 64.1200(b)(2)
//   3. that the voice is AI                   FCC 24-17 posture, Cal. AB 2905
//   4. that the call is recorded, and that    every state, because we do not check where the
//      software is listening to it            person who picked up is sitting
//
// ★ AND ONE MORE THING THIS SCRIPT DOES THAT THE OUTBOUND ONE DOES NOT: it names the person we
// are calling FOR. A stranger picking up a queue is entitled to know whose business this is
// before they say anything about an account, and "I am calling for Maria Delgado about her claim"
// is also the fastest way to get the call moving.
//
// The sentence order is not decorative. Everything legally required is said BEFORE the case is
// stated, because the case is the part a busy agent will interrupt.

const CALLBACK = () => process.env.ANSWERED_DEMO_NUMBER || '';

export function opening(s) {
  const cb = spokenNumber(CALLBACK());
  const who = String(s.requester_name || '').trim();
  const label = String(s.target_label || '').trim();
  return [
    'Hi there.',
    who ? `This is Answered, calling for ${who}.` : 'This is Answered, calling for one of our customers.',
    "I'm an A I voice, this call is recorded, and software is transcribing it as we speak.",
    cb ? `If you need a person on our side, the number is ${cb}.` : '',
    who
      ? `${who} asked us to wait on hold${label ? ` with ${label}` : ''} so they didn't have to.`
      : `Our customer asked us to wait on hold${label ? ` with ${label}` : ''} so they didn't have to.`,
  ].filter(Boolean).join(' ');
}

/** The case, in the customer's own words. Never invented, never padded. */
export function theCase(s) {
  const reason = String(s.reason || '').trim();
  const ref = String(s.reference || '').trim();
  const bits = [];
  if (reason) bits.push(`Here's what it's about: ${reason}.`);
  if (ref) bits.push(`The reference number is ${ref.split('').join(' ')}.`);
  return bits.join(' ');
}

/** Said when we are already ringing the customer. The four seconds the page promises. */
export const bridgeTail = () =>
  "I'm ringing them in right now. Give me about five seconds and they'll be right with you. Thanks for waiting.";

/**
 * Said when we THINK a person picked up but are not sure. This doubles as the detector's
 * confirmation step, which is why it asks a question a recording cannot answer.
 */
export const probeTail = () =>
  "Is there a person on the line? If you say yes, I'll bring my customer straight on.";

/** Said when we reached a person and could not get our own customer on the phone. */
export const sorryTail = () =>
  "I'm sorry, I couldn't get them onto the call just now, so I won't hold you up. We'll try again. Thanks very much for your time.";

/** Said to our own customer when their phone rings. */
export function userGreeting(s) {
  const label = String(s.target_label || 'the line you asked us to call').trim();
  return `This is Answered. We have a person on the line at ${label}. Connecting you now.`;
}

// ── the two clocks ───────────────────────────────────────────────────────────────────────────
const ms = (a, b) => {
  const x = a ? new Date(a).getTime() : null;
  const y = b ? new Date(b).getTime() : null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return Math.max(0, y - x);
};

export function clocks(s, now = new Date()) {
  const end = s.ended_at || now.toISOString();
  return {
    // Everything from the moment we dialled to the moment a person was on the line. This is the
    // number the customer did not have to live through.
    machine_wait_ms: ms(s.dialed_at, s.human_at || end),
    // Everything the customer personally spent on the phone. Zero unless they were bridged.
    user_wait_ms: s.bridged_at ? ms(s.bridged_at, end) : 0,
  };
}

export function humanTime(msValue) {
  if (msValue == null) return null;
  const t = Math.max(0, Math.round(msValue / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

export const usd = (cents) => (cents == null ? null : `$${(cents / 100).toFixed(2)}`);

// ── settling the errand ──────────────────────────────────────────────────────────────────────
//
// ★ THE ONE CONDITION THAT DECIDES WHETHER ANYTHING IS CHARGED: were the two of them actually on
// the call together. Not "did we reach a person". /terms says a connection "means a human on the
// line who can act on your case", and a human we reached but never handed to the customer is not
// that. So `bridged_at` is the trigger, and it is only ever written by a conference join event.
//
// ★ AND THE GAP I AM NOT PAPERING OVER: when we reach a person and then cannot get the customer
// on the phone, the published price list has NO row for it. lib/meter.mjs is deliberately closed
// and refuses any kind that is not on the list, which is the correct design. Rating it as
// `hold_no_human` would put the words "Hold reached nobody" on a bill for a session where we
// plainly did reach somebody, and a false label on a bill is worse than a missing line. So that
// outcome writes NO billing event at all, records why on the session, and the receipt says in
// plain words that it is on us. @LANE-BILLING: this is the one shape the catalog cannot express.

export function outcomeOf(s) {
  if (s.bridged_at) return { outcome: 'connected', kind: s.line_class === 'gov' ? 'hold_gov' : 'hold_commercial' };
  if (s.human_at) return { outcome: 'human_not_connected', kind: null };
  if (s.status === 'refused') return { outcome: 'refused', kind: null };
  if (s.outcome === 'cancelled') return { outcome: 'cancelled', kind: null };
  return { outcome: 'no_human', kind: 'hold_no_human' };
}

const REASON = {
  connected: null, // the meter writes this one
  human_not_connected: 'We reached a person but could not get you onto the call, so there is no charge. That one is on us.',
  no_human: 'Nobody ever picked up, so the price is $0, however long we waited.',
  cancelled: 'You called this one off, so there is no charge.',
  refused: 'We never placed the call, so there is nothing to charge for.',
};

/**
 * Close the session: work out what happened, meter it if the price book has a row for it, and
 * write the answer onto the record so the receipt has one source.
 */
export async function settle(session, { operator = 'hold-runtime' } = {}) {
  const s = session;
  const { outcome, kind } = outcomeOf(s);
  const c = clocks(s);
  const base = {
    status: 'ended',
    outcome,
    ended_at: s.ended_at || new Date().toISOString(),
    machine_wait_ms: c.machine_wait_ms || 0,
    user_wait_ms: c.user_wait_ms || 0,
  };

  if (!kind) {
    const patched = await patch(s.id, { ...base, charge_kind: null, charge_cents: 0, charge_gross_cents: 0, charge_reason: REASON[outcome] });
    await event(s.id, 'settled', { outcome, charged_cents: 0, reason: REASON[outcome], operator });
    return { session: patched, rating: null, outcome };
  }

  // An account is required to record anything. A Hold customer arrives with no account at all, so
  // one is created keyed on the email they gave, which is also how they reach their statement.
  let key = s.account_key;
  try {
    if (!key) {
      const em = String(s.requester_email || '').trim().toLowerCase();
      key = em || `hold-${String(s.requester_phone || '').replace(/\D/g, '')}`;
      await ledger.account({
        account_key: key,
        business_name: s.requester_name || 'Hold customer',
        email: em || `${key}@no-email.invalid`,
        phone: s.requester_phone,
      });
      await patch(s.id, { account_key: key });
    }
  } catch (e) {
    console.error('hold settle: could not reach a billing account:', String(e.message).slice(0, 160));
    await event(s.id, 'settle_error', { stage: 'account', error: String(e.message).slice(0, 200) });
  }

  // Rate first so the receipt has an answer even if the ledger write fails. The ledger's number
  // is the authoritative one when both land; a preview that disagrees is recorded, never hidden.
  const evidence = {
    line_class: s.line_class, line_class_source: s.line_class_source,
    target_label: s.target_label, call_sid: s.call_sid, bridge_call_sid: s.bridge_call_sid,
    human_at: s.human_at, bridged_at: s.bridged_at,
  };
  let rating = null;
  let recorded = null;
  try {
    recorded = await ledger.meterAndRecord(key, {
      kind,
      idem_key: s.call_sid || `hold-${s.id}`,
      occurred_at: s.bridged_at || s.ended_at || new Date().toISOString(),
      evidence,
    });
    rating = recorded.rating;
  } catch (e) {
    console.error('hold settle: ledger write failed:', String(e.message).slice(0, 160));
    await event(s.id, 'settle_error', { stage: 'ledger', error: String(e.message).slice(0, 200) });
    // The price book is pure, so a rating is still honest even when the ledger is unreachable.
    // It is marked as un-recorded so nobody mistakes it for a line on a bill.
    rating = rate({ kind, evidence }, {});
  }

  // ★ THE NUMBER AND THE SENTENCE HAVE TO COME FROM THE SAME PLACE, AND THEY DID NOT.
  // The amount was taken from the ledger, which is authoritative, while the explanation was taken
  // from the local preview. On a replay those two disagree by construction: the ledger returns the
  // ORIGINAL free event while a fresh preview, run after the free first hold has been spent, says
  // ten dollars. Measured on a re-run, the receipt printed "$0.00" directly above "A live person
  // was reached on a commercial line. One price, the whole errand.", which reads like a bill. A
  // recorded reason always wins over a previewed one.
  const cents = recorded ? recorded.cents : (rating && typeof rating.cents === 'number' ? rating.cents : 0);
  const reason = (recorded && recorded.reason) || (rating ? rating.reason : REASON[outcome]);
  const patched = await patch(s.id, {
    ...base,
    charge_kind: kind,
    charge_cents: cents,
    charge_gross_cents: rating ? rating.gross_cents || 0 : 0,
    charge_reason: reason,
    bill_event_id: recorded && recorded.id ? recorded.id : null,
  });
  await event(s.id, 'settled', {
    outcome, kind, charged_cents: cents,
    gross_cents: rating ? rating.gross_cents : null,
    reason,
    replay: Boolean(recorded && recorded.replay),
    // Kept, not hidden. A preview taken after the free hold was spent SHOULD disagree with a
    // replayed original, and that disagreement is the ledger doing its job.
    preview_disagreed: Boolean(recorded && rating && recorded.cents !== rating.cents),
    recorded_in_ledger: Boolean(recorded), operator,
  });
  return { session: patched, rating, recorded, outcome };
}

/**
 * The Hold Receipt, as an object. One shape, rendered by the customer page, the operator page and
 * anything else that ever needs it, so those three can never drift into telling different stories.
 */
export function receipt(s, events = []) {
  const c = clocks(s);
  const menus = events.filter((e) => e.kind === 'digit_sent');
  const heard = events.filter((e) => e.kind === 'far_end_said');
  return {
    line_called: s.target_label,
    number_called: s.target_phone,
    reason: s.reason,
    reference_on_file: Boolean(s.reference) || s.reference === 'on file',
    menu_depth: Number(s.menu_depth || 0),
    keys_pressed: menus.map((e) => (e.payload && e.payload.digit) || null).filter(Boolean),
    attempts: Number(s.attempts || 0),
    machine_wait: humanTime(c.machine_wait_ms),
    machine_wait_ms: c.machine_wait_ms,
    your_wait: humanTime(c.user_wait_ms),
    your_wait_ms: c.user_wait_ms,
    human_reached_at: s.human_at || null,
    connected_at: s.bridged_at || null,
    outcome: s.outcome || (s.status === 'ended' ? 'ended' : s.status),
    charged: usd(s.charge_cents),
    charged_cents: s.charge_cents,
    list_price: usd(s.charge_gross_cents),
    charge_reason: s.charge_reason,
    line_class: s.line_class,
    line_class_source: s.line_class_source,
    recording_seconds: s.recording_seconds || null,
    has_recording: Boolean(s.has_recording || s.recording_sid),
    // The words the far end actually said, which is the evidence behind every state above.
    heard: heard.map((e) => ({ at: e.at, text: (e.payload && e.payload.text) || '', state: (e.payload && e.payload.state) || null })),
  };
}
