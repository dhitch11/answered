// /api/call-transcription — live words off the wire, and the stop-word tripwire.
//
// Two jobs, and the second one is the important one.
//
//   1. Write each utterance to transcript_lines so the cockpit can render a live transcript.
//      Partials update in place on (call_sid, seq, track); the final supersedes them.
//
//   2. WATCH FOR STOP, ON EVERY TRACK, ON EVERY CALL, INCLUDING CALLS WHERE NOBODY ASKED A
//      QUESTION. A person who says "take me off your list" three seconds into the opening, while
//      an AI is still talking, has opted out. If the only stop detector lives in the turn handler
//      then that person is only heard when a <Gather> happens to complete, and on a call they
//      hang up on, that is never. So the detector lives here, on the raw stream, and it fires
//      before the sentence has finished.
//
// A stop suppresses the number, ends the live call, and marks the contact. All three, in that
// order, because the suppression must be durable even if the hangup fails.

import { authenticate } from './lib/twilio-webhook.mjs';
import { isStop } from './lib/scripts.mjs';

import * as twilio from './lib/twilio-rest.mjs';
import * as db from './lib/db.mjs';

// Accumulated OUR-side speech per call, so the disclosure is judged on the wire and not on the
// script. Module state is per-instance and that is fine: a miss leaves disclosure_verified null,
// which reads as "nobody checked", never as "disclosed".
const spokenByUs = new Map();

const PUBLIC_PATH = '/api/call-transcription';
const OK = { statusCode: 204, body: '' };

// Twilio sends sequence ids per track; keep partials from colliding across tracks.
const trackOf = (t) => (t === 'inbound_track' ? 'them' : t === 'outbound_track' ? 'us' : (t || 'unknown'));

export const handler = async (event) => {
  const gate = authenticate(event, PUBLIC_PATH);
  if (!gate.ok) return gate.reject;

  const p = gate.params;
  const q = event.queryStringParameters || {};
  const sid = q.sid || p.CallSid;
  // A call sid reaches twilio.updateCall(), which builds a REST path carrying the account's API
  // credentials. Anything that is not a well-formed CallSid does not get to travel there.
  if (!/^CA[0-9a-f]{32}$/i.test(String(sid || ''))) {
    console.error('call-transcription: refusing a malformed call sid');
    return OK;
  }
  const kind = String(p.TranscriptionEvent || '');

  if (kind !== 'transcription-content') {
    if (kind === 'transcription-error') {
      console.error('transcription error', p.TranscriptionErrorCode, 'call', sid);
      try { await db.addEvent(sid, 'transcription_error', { code: p.TranscriptionErrorCode }); } catch { /* noop */ }
    }
    return OK;
  }

  let data = {};
  try { data = JSON.parse(p.TranscriptionData || '{}'); } catch { /* keep going with an empty payload */ }
  const text = String(data.transcript || '').trim();
  if (!text) return OK;

  const speaker = trackOf(p.Track);
  const isFinal = String(p.Final || '').toLowerCase() === 'true' || !p.Stability;
  const seq = Number(p.SequenceId || 0);

  try {
    await db.addTranscript(sid, [{
      seq, track: p.Track, speaker, text,
      confidence: data.confidence ?? null, is_final: isFinal,
    }]);
  } catch (e) {
    console.error('transcript write failed:', String(e.message).slice(0, 140));
  }

  // ── DID WE ACTUALLY SAY IT? ─────────────────────────────────────────────────────────────────
  // ★ The disclosure was once present in the script, complete in the obligations list, approved by
  // scriptSatisfies() and findable by grep, while the entire spoken output of a real call was the
  // word "Hi". Only the transcript knew. So this reads our own track and confirms all four
  // obligations reached the wire, and it can report FALSE.
  if (speaker === 'us') {
    const acc = (spokenByUs.get(sid) || '') + ' ' + text;
    spokenByUs.set(sid, acc.slice(-2000));
    const heard = {
      identified: /this is answered/i.test(acc),
      ai_disclosed: /\ba\.? ?i\b|artificial intelligence/i.test(acc),
      recording_announced: /recorded/i.test(acc),
      callback_given: /\d\s\d\s\d|\d{3}[ -]?\d{3}[ -]?\d{4}/.test(acc),
    };
    const all = Object.values(heard).every(Boolean);
    if (all) {
      try {
        await db.updateCall(sid, {
          disclosure_verified: true,
          disclosure_evidence: { ...heard, verified_from: 'transcript', at: new Date().toISOString() },
        });
        spokenByUs.set(sid, 'DONE');
      } catch (e) { console.error('disclosure verify write failed:', String(e.message).slice(0, 120)); }
    }
  }

  // ── the tripwire ────────────────────────────────────────────────────────────────────────────
  // Only what THEY said can opt them out. Our own track saying the word "stop" must never
  // suppress the person we are talking to.
  if (speaker === 'them' && isStop(text)) {
    // ★ Twilio's transcription-content payload carries NO To and NO From. This block used to read
    // p.To and p.From, got undefined for both, and called db.suppress(undefined) — which
    // JSON.stringify silently dropped, so the RPC ran without a phone number and the do-not-call
    // list stayed empty. The hangup still happened, the event still logged, the call row still
    // read do_not_call, so the console showed a clean opt-out while the next batch redialled the
    // person who asked us to stop. The number travels on the callback URL now, with a live lookup
    // as the fallback, and a missing number is a loud failure rather than a quiet no-op.
    let number = q.to && q.to !== process.env.ANSWERED_DEMO_NUMBER ? q.to : null;
    if (!number) {
      try { const c = await twilio.getCall(sid); number = c.to || c.from || null; }
      catch (e) { console.error('could not resolve the number to suppress:', String(e.message).slice(0, 120)); }
    }
    if (!number) {
      console.error(`STOP heard on ${sid} but NO NUMBER could be resolved. Not suppressed. This needs a human.`);
      try { await db.addEvent(sid, 'stop_unresolved', { text, speaker }); } catch { /* noop */ }
    } else {
      console.error(`STOP heard on ${sid}: "${text.slice(0, 80)}" — suppressing ${number}`);
      // ★ 64.1200(d)(3) requires the request to be RECORDED AT THE TIME IT IS MADE, with the words
      // used, alongside the ten-business-day deadline. Suppressing without recording honours the
      // person but produces no evidence that we did, and the evidence is the half a regulator asks
      // for. sv_dnc_request does both in one transaction and honours immediately.
      try {
        await db.rpc('sv_dnc_request', {
          p_phone: number, p_channel: 'call',
          p_heard_as: text.slice(0, 200), p_call_sid: sid, p_by: 'transcription-tripwire',
        });
      } catch (e) {
        console.error('DNC request write FAILED, falling back to bare suppression:', String(e.message).slice(0, 140));
        try { await db.suppress(number, `said "${text.slice(0, 120)}" during call ${sid}`, 'transcription-tripwire'); }
        catch (e2) { console.error('suppression ALSO FAILED:', String(e2.message).slice(0, 140)); }
      }
    }
    try { await db.addEvent(sid, 'stop_detected', { text, speaker }); } catch { /* noop */ }
    try {
      await twilio.updateCall(sid, { Status: 'completed' });
    } catch (e) { console.error('could not end call after stop:', String(e.message).slice(0, 140)); }
    try { await db.updateCall(sid, { disposition: 'do_not_call', outcome: { stopped: true, heard: text } }); } catch { /* noop */ }
  }

  return OK;
};
