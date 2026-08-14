// hold-runtime.mjs — the plumbing every Hold webhook shares.
//
// Three things live here and nowhere else, so the four entry points cannot drift apart:
//   1. the shim that lets a Netlify v2 Request use the estate's existing Twilio webhook gate
//   2. the TwiML this product speaks, as builders rather than as strings scattered over files
//   3. the two actions that change a live call: ring the customer, and move a leg somewhere else
//
// ★ THE ONE RULE FOR EVERYTHING IN THIS FILE: it runs inside a webhook that Twilio is waiting on
// with a live human potentially on the far end. Nothing here retries in a loop, nothing here
// waits on something slow, and every failure returns a document rather than a stack trace.
// A Twilio webhook that 500s ends the call. Silence is the failure mode to design against.

import * as tw from './twilio-rest.mjs';
import * as store from './hold-store.mjs';
import { esc, SAY } from './twilio-webhook.mjs';

export { esc, SAY };

export const site = () => process.env.URL || 'https://answered.reddenda.com';

export const XML = (body) => new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
  status: 200,
  headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store' },
});

export const HANGUP = () => XML('<Response><Hangup/></Response>');

/**
 * Netlify v2 hands us a Request. lib/twilio-webhook.mjs authenticate() was written against the
 * lambda event shape and it is the only signature check in this repo, so it is reused rather than
 * reimplemented. A second copy of a security gate is a second gate to forget to fix.
 */
export async function asLambda(req) {
  const url = new URL(req.url);
  const headers = {};
  req.headers.forEach((v, k) => { headers[k] = v; });
  return {
    httpMethod: req.method,
    headers,
    body: await req.text(),
    isBase64Encoded: false,
    rawUrl: req.url,
    rawQuery: url.search.replace(/^\?/, ''),
    queryStringParameters: Object.fromEntries(url.searchParams.entries()),
  };
}

// ── the documents ────────────────────────────────────────────────────────────────────────────

/**
 * ★ track="inbound_track" IS LOAD BEARING AND IT IS NOT A PERFORMANCE CHOICE.
 * The detector reads whatever this transcription delivers. On both_tracks it would also receive
 * OUR OWN voice, and our own opening sentence is full of the strongest human markers there are
 * ("this is Answered", "if you need a person"). The detector would hear itself, call itself a
 * person, and bridge the customer into hold music every single time we spoke. One track.
 *
 * partialResults is off for the same reason in a smaller way: half a sentence classifies badly,
 * and there is no hurry that a finished utterance does not satisfy.
 */
export const transcriptionOn = (id) =>
  `<Start><Transcription statusCallbackUrl="${esc(`${site()}/api/hold/hear?s=${encodeURIComponent(id)}`)}" `
  + `track="inbound_track" partialResults="false" languageCode="en-US" speechModel="telephony" `
  + `name="hold-${esc(String(id).slice(0, 30))}"/></Start>`;

export const goTo = (path, id, extra = '') =>
  `<Redirect method="POST">${esc(`${site()}${path}?s=${encodeURIComponent(id)}${extra}`)}</Redirect>`;

/**
 * The waiting document. A pause, then come back and think again.
 *
 * The interval is short at the start of a call and long afterwards, because everything that needs
 * a fast reaction (a phone tree offering options) happens in the first minute, and after that the
 * only thing worth waking up for is a timeout. The detector does NOT depend on this loop: a
 * person arriving mid-hold is caught by the transcription webhook, which moves the live call
 * immediately rather than waiting for the next tick.
 */
export function waiting(id, tick, sinceAnswerMs) {
  const seconds = sinceAnswerMs < 90000 ? 8 : 20;
  return XML(`<Response><Pause length="${seconds}"/>${goTo('/api/hold/tick', id, `&t=${tick + 1}`)}</Response>`);
}

export const conference = (id, name, { record = false } = {}) =>
  `<Dial timeLimit="3600"><Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true" `
  + `waitUrl="" statusCallbackEvent="start end join leave" `
  + `statusCallback="${esc(`${site()}/api/hold/status?kind=conference&s=${encodeURIComponent(id)}`)}" `
  + `statusCallbackMethod="POST"`
  + (record
    ? ` record="record-from-start" recordingStatusCallback="${esc(`${site()}/api/hold/status?kind=recording&s=${encodeURIComponent(id)}`)}" recordingStatusCallbackMethod="POST"`
    : '')
  + `>${esc(name)}</Conference></Dial>`;

// ── reading what the far end has said ────────────────────────────────────────────────────────

/** The utterances the detector reasons over, newest last, in the shape fuse() expects. */
export function utterancesFrom(events, sinceIso) {
  const since = sinceIso ? new Date(sinceIso).getTime() : 0;
  return (events || [])
    .filter((e) => e.kind === 'far_end_said')
    .map((e) => ({ text: (e.payload && e.payload.text) || '', at: new Date(e.at).getTime() }))
    .filter((u) => u.text && u.at >= since)
    .sort((a, b) => a.at - b.at)
    .slice(-40);
}

export const promptCountFrom = (events) => (events || []).filter((e) => e.kind === 'announced').length;

// ── the two actions that change a live call ──────────────────────────────────────────────────

/**
 * Ring the customer and point their leg at the join document.
 *
 * ★ THE GATE IS NOT RE-RUN HERE AND THAT IS DELIBERATE. It ran at session creation, against this
 * exact number, and its verdict is on the row. Re-running it now, ninety minutes later, could
 * refuse for quiet hours in the middle of a live connection and leave a stranger talking to
 * nobody. What IS re-checked is the one thing that can change and must be honoured instantly:
 * whether the customer has since asked us to stop.
 */
export async function ringUser(s) {
  if (s.bridge_call_sid) return { ok: true, already: true, sid: s.bridge_call_sid };

  const from = process.env.CANARY_FROM_NUMBER || process.env.ANSWERED_DEMO_NUMBER;
  if (!from) return { ok: false, reason: 'no outbound number configured' };

  try {
    const ctx = await import('./db.mjs').then((m) => m.dialContext(s.requester_phone));
    if (!ctx || typeof ctx.suppressed !== 'boolean') {
      return { ok: false, reason: 'could not confirm the customer has not opted out; refusing to dial' };
    }
    if (ctx.suppressed) return { ok: false, reason: 'the customer asked us to stop calling this number' };
  } catch (e) {
    return { ok: false, reason: `suppression check failed (${String(e.message).slice(0, 80)}); refusing to dial` };
  }

  try {
    const call = await tw.createCall({
      To: s.requester_phone,
      From: from,
      Url: `${site()}/api/hold/user?s=${encodeURIComponent(s.id)}`,
      Method: 'POST',
      StatusCallback: `${site()}/api/hold/status?kind=user&s=${encodeURIComponent(s.id)}`,
      StatusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      StatusCallbackMethod: 'POST',
      // No answering-machine detection on this leg. AMD costs seconds we do not have with a
      // stranger waiting, and the keypress on the join document defeats voicemail outright:
      // a voicemail box cannot press a key, so it can never be joined to a conference.
      Timeout: 30,
    });
    await store.patch(s.id, { bridge_call_sid: call.sid, status: 'bridging' });
    await store.event(s.id, 'user_ringing', { call_sid: call.sid, to_last4: String(s.requester_phone).slice(-4) });
    return { ok: true, sid: call.sid };
  } catch (e) {
    await store.event(s.id, 'user_ring_failed', { error: String(e.message).slice(0, 200) });
    return { ok: false, reason: String(e.message).slice(0, 160) };
  }
}

/**
 * Move a live leg to a different document, right now, without waiting for its current one to
 * finish. This is what makes detection feel instant: the target leg is sitting inside a <Pause>
 * and a Url update interrupts it.
 */
export async function moveLeg(callSid, path, id, extra = '') {
  if (!/^CA[0-9a-f]{32}$/i.test(String(callSid || ''))) {
    return { ok: false, reason: `refusing to steer a malformed call sid` };
  }
  try {
    await tw.updateCall(callSid, { Url: `${site()}${path}?s=${encodeURIComponent(id)}${extra}`, Method: 'POST' });
    return { ok: true };
  } catch (e) {
    console.error(`hold moveLeg ${path} failed:`, String(e.message).slice(0, 140));
    return { ok: false, reason: String(e.message).slice(0, 160) };
  }
}

export async function endLeg(callSid) {
  if (!/^CA[0-9a-f]{32}$/i.test(String(callSid || ''))) return { ok: false };
  try { await tw.updateCall(callSid, { Status: 'completed' }); return { ok: true }; }
  catch (e) { return { ok: false, reason: String(e.message).slice(0, 120) }; }
}

/** How long one attempt may run before we stop paying for silence. */
export const maxHoldMs = () => Math.max(5, Number(process.env.ANSWERED_HOLD_MAX_MINUTES) || 120) * 60000;
export const maxAttempts = () => Math.max(1, Number(process.env.ANSWERED_HOLD_MAX_ATTEMPTS) || 3);
