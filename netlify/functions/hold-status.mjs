// hold-status.mjs — what Twilio tells us about the two legs and the room they meet in.
//
// Four kinds arrive here, told apart by ?kind= on the callback URL rather than by guessing from
// the body, because a conference event and a call event share field names and mean different
// things:
//
//   kind=target      the leg we placed to the line the customer named
//   kind=user        the leg we placed to the customer
//   kind=conference  join and leave events for the room
//   kind=recording   the recording of the conversation, once it exists
//
// ── THE THREE THINGS THIS FILE EXISTS FOR ────────────────────────────────────────────────────
//
//   THE REDIAL. /hold promises the errand survives "redials and reconnects" and that a redial is
//   not a second charge. Both halves are here: a target leg that ends without a person is dialled
//   again on the SAME session row, so there is still only one place a charge can ever be written.
//
//   THE BRIDGE. bridged_at is written from a conference participant-join event and from nowhere
//   else. It is the single fact that decides whether anything is billable, so it is only ever set
//   by Twilio telling us the customer is actually in the room. Setting it when we merely started
//   ringing them would bill for a connection that never happened.
//
//   THE ABANDON PATH. If the customer's leg fails, the person we reached is not left listening to
//   silence. Their leg is moved to an apology, out loud, and the session settles at no charge.

import { authenticate } from './lib/twilio-webhook.mjs';
import * as tw from './lib/twilio-rest.mjs';
import * as store from './lib/hold-store.mjs';
import * as rt from './lib/hold-runtime.mjs';

const PUBLIC_PATH = '/api/hold/status';
const OK = new Response('', { status: 204 });

const DEAD = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled']);

export default async (req) => {
  const event = await rt.asLambda(req);
  const gate = authenticate(event, PUBLIC_PATH);
  if (!gate.ok) return new Response(gate.reject.body || 'refused', { status: gate.reject.statusCode });

  const p = gate.params;
  const q = event.queryStringParameters || {};
  const id = String(q.s || '');
  const kind = String(q.kind || 'target');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return OK;

  const loaded = await store.get(id, 60).catch(() => null);
  if (!loaded || loaded.error || !loaded.session) return OK;
  const s = loaded.session;

  if (kind === 'conference') return onConference(s, p);
  if (kind === 'recording')  return onRecording(s, p);
  if (kind === 'user')       return onUserLeg(s, p);
  return onTargetLeg(s, p);
};

// ── the leg we placed to the line the customer named ─────────────────────────────────────────
async function onTargetLeg(s, p) {
  const status = String(p.CallStatus || '').toLowerCase();
  await store.event(s.id, 'target_leg', { status, sid: p.CallSid || null, duration: p.CallDuration || null });

  if (status === 'ringing' || status === 'initiated') {
    if (!s.dialed_at) await store.patch(s.id, { status: 'ringing', dialed_at: new Date().toISOString() });
    return OK;
  }
  if (!DEAD.has(status)) return OK;

  // The line hung up, or never answered. Everything below decides between trying again and
  // closing the errand.
  if (s.status === 'ended' || s.outcome) return OK;

  // If the two of them were connected, this is just the end of a finished conversation.
  if (s.bridged_at) {
    await store.settle({ ...s, ended_at: new Date().toISOString() }, { operator: 'hold-status' });
    return OK;
  }

  // If we had reached a person but never delivered our customer, that is its own outcome and it
  // is deliberately not billable. See the note in lib/hold-store.mjs settle().
  if (s.human_at) {
    await store.patch(s.id, { outcome_reason: 'we reached a person and could not get you onto the call' });
    await store.settle({ ...s, ended_at: new Date().toISOString() }, { operator: 'hold-status' });
    if (s.bridge_call_sid) await rt.endLeg(s.bridge_call_sid);
    return OK;
  }

  const attempts = Number(s.attempts || 0);
  const spent = s.dialed_at ? Date.now() - new Date(s.dialed_at).getTime() : 0;
  const canRetry = attempts + 1 < rt.maxAttempts() && spent < rt.maxHoldMs();

  if (!canRetry) {
    await store.event(s.id, 'no_human', { attempts: attempts + 1, status, minutes: Math.round(spent / 60000) });
    await store.patch(s.id, {
      outcome_reason: status === 'no-answer' ? 'nobody picked up' : `the line ended the call (${status})`,
    });
    await store.settle({ ...s, ended_at: new Date().toISOString() }, { operator: 'hold-status' });
    return OK;
  }

  // ★ THE REDIAL, AND WHY IT IS NOT A NEW SESSION. One errand, one row, one possible charge.
  // /hold says in the customer's own words: "If the line drops or the queue resets you, it starts
  // over. Redials are not a second charge." A new session row here would have quietly made every
  // reconnect billable.
  try {
    const from = process.env.CANARY_FROM_NUMBER || process.env.ANSWERED_DEMO_NUMBER;
    const call = await tw.createCall({
      To: s.target_phone,
      From: from,
      Url: `${rt.site()}/api/hold/voice?s=${encodeURIComponent(s.id)}`,
      Method: 'POST',
      StatusCallback: `${rt.site()}/api/hold/status?kind=target&s=${encodeURIComponent(s.id)}`,
      StatusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      StatusCallbackMethod: 'POST',
      Timeout: 40,
    });
    await store.patch(s.id, {
      call_sid: call.sid, attempts: attempts + 1, status: 'dialing',
      answered_at: null, announced_at: null, menu_depth: 0, digits_sent: [],
    });
    await store.event(s.id, 'redialled', { attempt: attempts + 1, call_sid: call.sid, after: status });
  } catch (e) {
    await store.event(s.id, 'redial_failed', { error: String(e.message).slice(0, 200) });
    await store.settle({ ...s, ended_at: new Date().toISOString() }, { operator: 'hold-status' });
  }
  return OK;
}

// ── the leg we placed to our own customer ────────────────────────────────────────────────────
async function onUserLeg(s, p) {
  const status = String(p.CallStatus || '').toLowerCase();
  await store.event(s.id, 'user_leg', { status, sid: p.CallSid || null });

  if (!DEAD.has(status)) return OK;
  if (s.bridged_at) return OK;          // they were connected; this is the normal end
  if (s.status === 'ended' || s.outcome) return OK;

  // ★ NOBODY IS LEFT TALKING TO AN EMPTY ROOM. We reached a person, promised them our customer,
  // and could not deliver. Their leg is moved to a spoken apology rather than simply hung up on,
  // because they gave up a queue position to answer us.
  await store.event(s.id, 'bridge_failed', { user_status: status });
  if (s.call_sid) {
    const moved = await rt.moveLeg(s.call_sid, '/api/hold/sorry', s.id, `&why=${encodeURIComponent(status)}`);
    if (!moved.ok) await rt.endLeg(s.call_sid);
  }
  await store.patch(s.id, {
    outcome_reason: status === 'no-answer'
      ? 'we reached a person and your phone did not answer'
      : `we reached a person and could not connect you (${status})`,
  });
  await store.settle({ ...s, ended_at: new Date().toISOString() }, { operator: 'hold-status' });
  return OK;
}

// ── the room ─────────────────────────────────────────────────────────────────────────────────
async function onConference(s, p) {
  const ev = String(p.StatusCallbackEvent || '');
  const sid = String(p.CallSid || '');
  await store.event(s.id, 'conference', { event: ev, call_sid: sid || null, conference_sid: p.ConferenceSid || null });

  if (ev === 'participant-join') {
    const patch = { conference_name: s.conference_name || p.FriendlyName || null };
    // The customer arriving in the room is the ONE fact that makes this errand billable.
    if (sid && sid === s.bridge_call_sid && !s.bridged_at) {
      patch.bridged_at = new Date().toISOString();
      patch.status = 'bridged';
      await store.event(s.id, 'connected', {
        conference: p.FriendlyName || null,
        waited_ms: s.dialed_at ? Date.now() - new Date(s.dialed_at).getTime() : null,
      });
    }
    await store.patch(s.id, patch);
    return OK;
  }

  if (ev === 'conference-end' || ev === 'participant-leave') {
    if (ev === 'conference-end' && s.status !== 'ended' && !s.outcome) {
      await store.settle({ ...s, ended_at: new Date().toISOString() }, { operator: 'hold-status' });
    }
  }
  return OK;
}

async function onRecording(s, p) {
  const sid = String(p.RecordingSid || '');
  if (!sid) return OK;
  await store.patch(s.id, {
    recording_sid: sid,
    recording_seconds: Number(p.RecordingDuration || 0) || null,
    // Stored as the Twilio resource path, never a public URL. Playback goes through an
    // authenticated operator route, so a receipt link can never hand out the audio.
    recording_url: `Recordings/${sid}`,
  });
  await store.event(s.id, 'recording_ready', { sid, seconds: Number(p.RecordingDuration || 0) || null });
  return OK;
}

export const config = { path: ['/api/hold/status'] };
