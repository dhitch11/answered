// /api/call-status — every state change on every call, written to the spine.
//
// This is where ring time is measured. Twilio does not hand you "how long did it ring", so it is
// derived: the gap between the initiated event and the answered event. That single number is the
// answer-rate study's whole output, and it is why the status callback subscribes to `ringing`
// rather than just `completed`.
//
// Conference events land here too (kind=conference), which is how the cockpit knows an operator
// has joined, muted, or dropped without polling Twilio.

import { authenticate } from './lib/twilio-webhook.mjs';
import * as db from './lib/db.mjs';

const PUBLIC_PATH = '/api/call-status';
const OK = { statusCode: 204, body: '' };

// Twilio does not send ring duration. Hold the initiated timestamp per call in module memory,
// which survives within a warm instance, and fall back to the DB timestamps when it does not.
const started = new Map();

export const handler = async (event) => {
  const gate = authenticate(event, PUBLIC_PATH);
  if (!gate.ok) return gate.reject;

  const p = gate.params;
  const kind = (event.queryStringParameters || {}).kind || 'call';
  const sid = p.CallSid || p.ParentCallSid;

  try {
    if (kind === 'conference') {
      await db.addEvent(p.CallSid || p.ConferenceSid, `conference_${p.StatusCallbackEvent || 'event'}`, {
        conference_sid: p.ConferenceSid, friendly_name: p.FriendlyName,
        participant: p.CallSid, muted: p.Muted, coaching: p.Coaching, reason: p.Reason,
      });
      if (p.CallSid && p.ConferenceSid) {
        await db.updateCall(p.CallSid, { conference_sid: p.ConferenceSid });
      }
      return OK;
    }

    const status = String(p.CallStatus || '').toLowerCase();
    const now = new Date().toISOString();
    const patch = { status };

    if (status === 'initiated' || status === 'queued') {
      started.set(sid, Date.now());
      patch.started_at = now;
    }
    if (status === 'ringing' && !started.has(sid)) started.set(sid, Date.now());

    if (status === 'in-progress') {
      patch.answered_at = now;
      const t0 = started.get(sid);
      if (t0) patch.ring_seconds = Number(((Date.now() - t0) / 1000).toFixed(1));
    }

    if (status === 'completed' || status === 'busy' || status === 'no-answer'
      || status === 'failed' || status === 'canceled') {
      patch.ended_at = now;
      if (p.CallDuration) patch.duration_seconds = Number(p.CallDuration);
      started.delete(sid);
    }

    // AMD lands on whichever event completes it. Never overwrite a decided value with 'unknown'.
    if (p.AnsweredBy && p.AnsweredBy !== 'unknown') patch.answered_by = p.AnsweredBy;

    await db.updateCall(sid, patch);
    await db.addEvent(sid, `status_${status || 'unknown'}`, {
      answered_by: p.AnsweredBy, duration: p.CallDuration, to: p.To, from: p.From,
      sip_code: p.SipResponseCode, error: p.ErrorCode,
    });
  } catch (e) {
    // A webhook that 500s makes Twilio retry, which double-writes. Log and acknowledge.
    console.error('call-status write failed:', String(e.message).slice(0, 180));
  }
  return OK;
};
