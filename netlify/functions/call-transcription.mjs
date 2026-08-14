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

const PUBLIC_PATH = '/api/call-transcription';
const OK = { statusCode: 204, body: '' };

// Twilio sends sequence ids per track; keep partials from colliding across tracks.
const trackOf = (t) => (t === 'inbound_track' ? 'them' : t === 'outbound_track' ? 'us' : (t || 'unknown'));

export const handler = async (event) => {
  const gate = authenticate(event, PUBLIC_PATH);
  if (!gate.ok) return gate.reject;

  const p = gate.params;
  const sid = (event.queryStringParameters || {}).sid || p.CallSid;
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

  // ── the tripwire ────────────────────────────────────────────────────────────────────────────
  // Only what THEY said can opt them out. Our own track saying the word "stop" must never
  // suppress the person we are talking to.
  if (speaker === 'them' && isStop(text)) {
    const number = p.To && p.To !== process.env.ANSWERED_DEMO_NUMBER ? p.To : p.From;
    console.error(`STOP heard on ${sid}: "${text.slice(0, 80)}" — suppressing ${number}`);
    try {
      await db.suppress(number, `said "${text.slice(0, 120)}" during call ${sid}`, 'transcription-tripwire');
    } catch (e) { console.error('suppression write FAILED:', String(e.message).slice(0, 140)); }
    try { await db.addEvent(sid, 'stop_detected', { text, speaker }); } catch { /* noop */ }
    try {
      await twilio.updateCall(sid, { Status: 'completed' });
    } catch (e) { console.error('could not end call after stop:', String(e.message).slice(0, 140)); }
    try { await db.updateCall(sid, { disposition: 'do_not_call', outcome: { stopped: true, heard: text } }); } catch { /* noop */ }
  }

  return OK;
};
