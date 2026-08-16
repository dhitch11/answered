// /api/sms-status — the webhook Twilio calls every time a message we sent changes state.
//
// ── WHY THIS EXISTS, AND WHY IT EXISTS BEFORE THE FIRST MESSAGE IS SENT ──────────────────────
//
// David's brief: "everything needs to be as premium and PROVEN to be premium and trustworthy as
// possible when it comes to texts and delivery." The operative word is PROVEN.
//
// Measured before this file existed: the messaging service's `status_callback` was NULL, and no
// endpoint in this codebase read a message status. `call-status.mjs` reads `CallStatus` and is
// voice only. `sms-inbound.mjs` reads inbound messages only. So the moment the A2P campaign
// cleared we would have begun sending messages we could not account for, and the honest answer to
// "did the contractor get it" would have been "we have no idea".
//
// This is the twin of the `/api/booking` defect: that one was a send that never happened. This
// would have been a delivery that was never recorded.
//
// ── ★ THE ONE RULE THIS FILE EXISTS TO ENFORCE ───────────────────────────────────────────────
//
//   `sent` AND `delivered` ARE DIFFERENT CLAIMS AND ARE NEVER COLLAPSED.
//
// `sent` means a carrier accepted the message. `delivered` means a handset receipt came back.
// **For US long code, many carriers do not return real delivery receipts at all.** So a message can
// sit at `sent` forever and be perfectly fine, or have been silently dropped, and those two look
// IDENTICAL from here. Any surface that renders `sent` as "delivered" is a machine that lies in
// precisely the register this estate is trusted not to.
//
// So `classify()` returns exactly one of three things and there is no fourth:
//
//   ACCEPTED   the carrier took it. We do NOT know it arrived.
//   CONFIRMED  a handset receipt came back. We know it arrived.
//   FAILED     it did not arrive, and we have the reason.
//
// A caller that wants a boolean has to choose which of those it means, which is the point.
//
// ── WHAT IT REFUSES TO DO ────────────────────────────────────────────────────────────────────
//
//  1. Trust the request. Fails CLOSED on a missing or wrong signature, copying `sms-inbound.mjs`
//     rather than `twilio-webhook.mjs`, which returns true when the token is unset. This endpoint
//     writes a permanent per-message record; an open version lets anyone forge a delivery.
//  2. Overwrite history. Every transition is APPENDED. A message that went queued -> sent ->
//     undelivered keeps all three, because the sequence is the evidence, not the last value.
//  3. Retry-storm. Always answers 200, even when it refuses to write, so Twilio does not queue
//     redeliveries against a rejection that will never change.

import crypto from 'node:crypto';
import * as blobs from '@netlify/blobs';

export const config = {
  // A LITERAL. Netlify reads this by static analysis at bundle time and silently drops a computed
  // value; this repo has a function that shipped a computed path and registered no routes at all.
  path: ['/api/sms-status'],
};

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const nowIso = () => new Date().toISOString();

/** Same store family as the rest of the estate. */
function msgStore(event) {
  if (typeof blobs.connectLambda === 'function') {
    try { blobs.connectLambda(event); } catch (e) { /* the first read or write is the verdict */ }
  }
  return blobs.getStore('messages');
}

/** E.164 for a US number, matching `normalizeUs` in call-me.mjs so the hashes agree estate-wide. */
function e164(raw) {
  const d = String(raw || '').replace(/\D+/g, '');
  if (d.length === 11 && d[0] === '1') return '+' + d;
  if (d.length === 10) return '+1' + d;
  if (String(raw || '').startsWith('+') && d.length >= 10) return '+' + d;
  return null;
}

// ── THE THREE STATES ─────────────────────────────────────────────────────────────────────────
// Twilio's status vocabulary, mapped deliberately rather than by prefix matching.
//
// `sent` sits in ACCEPTED on purpose and that is the whole design. It is the status most systems
// quietly render as a tick, and it is the one that means "we do not know".
const ACCEPTED_STATES = new Set(['accepted', 'scheduled', 'queued', 'sending', 'sent']);
const CONFIRMED_STATES = new Set(['delivered', 'read']);
const FAILED_STATES = new Set(['undelivered', 'failed', 'canceled']);

export function classify(status) {
  const s = String(status || '').toLowerCase();
  if (CONFIRMED_STATES.has(s)) return 'CONFIRMED';
  if (FAILED_STATES.has(s)) return 'FAILED';
  if (ACCEPTED_STATES.has(s)) return 'ACCEPTED';
  // An unknown status is NOT quietly treated as progress. It is recorded and called unknown, so a
  // new Twilio status value shows up as a question rather than silently becoming a success.
  return 'UNKNOWN';
}

/**
 * A human sentence that cannot overstate what we know. Every surface in the estate should render
 * from this rather than writing its own, so the wording cannot drift from the evidence.
 */
export function deliverySentence(state, errorCode) {
  switch (state) {
    case 'CONFIRMED': return 'Confirmed on the handset.';
    case 'FAILED': return errorCode ? `Did not arrive. Carrier reason ${errorCode}.` : 'Did not arrive.';
    case 'ACCEPTED': return 'Accepted by the carrier. Not confirmed on the handset.';
    default: return 'Status not recognised. Recorded, not interpreted.';
  }
}

/** Twilio's signature scheme. FAILS CLOSED — see the header. */
function verify(shim, params) {
  const token = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  if (!token) return { ok: false, why: 'TWILIO_AUTH_TOKEN is not set, so this webhook cannot verify Twilio and will not write' };
  const sig = (shim.headers['x-twilio-signature'] || '').trim();
  if (!sig) return { ok: false, why: 'no X-Twilio-Signature header' };

  const proto = shim.headers['x-forwarded-proto'] || 'https';
  const host = shim.headers.host || '';
  const url = `${proto}://${host}${shim.path}`;
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  const want = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');

  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, why: 'signature mismatch' };
  return { ok: true };
}

const ok = () => new Response('', { status: 200, headers: { 'Cache-Control': 'no-store' } });

export default async function handler(req, context) {
  const event = context && context.event ? context.event : null;

  let params = {};
  try {
    params = Object.fromEntries(new URLSearchParams(await req.text()));
  } catch (e) {
    console.error('sms-status: unreadable body:', String(e && e.message).slice(0, 120));
    return ok();
  }

  const headers = {};
  req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const shim = { headers, path: new URL(req.url).pathname };

  const v = verify(shim, params);
  if (!v.ok) {
    console.error('sms-status: REFUSED, ' + v.why + '. Nothing was recorded.');
    return ok();
  }

  const sid = String(params.MessageSid || params.SmsSid || '').trim();
  if (!sid) {
    console.error('sms-status: verified request carried no MessageSid; recorded nothing.');
    return ok();
  }

  const status = String(params.MessageStatus || params.SmsStatus || '').toLowerCase();
  const state = classify(status);
  const errorCode = params.ErrorCode ? String(params.ErrorCode) : null;
  const to = e164(params.To);

  const entry = {
    at: nowIso(),
    status,
    state,
    errorCode,
    // The channel that actually carried it. RCS falls back to SMS silently, so without this we
    // could not tell a branded RCS delivery from a plain one, and "we sent it over RCS" would be
    // an assumption rather than a record.
    channel: params.MessagingServiceSid ? 'messaging-service' : 'direct',
    from: params.From || null,
    segments: params.NumSegments || null,
    price: params.Price || null,
  };

  const store = msgStore(event);
  let record;
  try {
    record = (await store.get(sid, { type: 'json' })) || null;
  } catch (e) {
    record = null;
  }

  if (!record) {
    record = {
      sid,
      // Hashed with the SAME function `sms-inbound.mjs` and `call-me.mjs` use, so the suppression
      // store and this store agree about who a person is. Two hashing schemes would disagree and
      // nobody would notice until an audit.
      toHash: to ? sha(to) : null,
      toLast4: to ? to.slice(-4) : null,
      firstSeen: entry.at,
      history: [],
    };
  }

  // APPEND. The sequence is the evidence; the last value alone is not.
  record.history.push(entry);
  record.lastSeen = entry.at;
  record.state = state;
  record.status = status;
  record.errorCode = errorCode;
  // Once a handset receipt has ever arrived, that fact is permanent. A later status must not be
  // able to un-prove a delivery that genuinely happened.
  record.everConfirmed = record.everConfirmed || state === 'CONFIRMED';

  try {
    await store.setJSON(sid, record);
  } catch (e) {
    console.error(`sms-status: could not persist ${sid}: ${String(e && e.message).slice(0, 140)}`);
    return ok();
  }

  // Quiet on ordinary progress, loud on a failure, because a log that narrates every queued->sent
  // transition is a log nobody reads on the day one of them fails.
  if (state === 'FAILED') {
    console.error(`sms-status: ${sid} FAILED to ${record.toLast4 || '????'} — ${deliverySentence(state, errorCode)}`);
  } else if (state === 'UNKNOWN') {
    console.error(`sms-status: ${sid} returned an unrecognised status "${status}". Recorded, not interpreted.`);
  }

  return ok();
}
