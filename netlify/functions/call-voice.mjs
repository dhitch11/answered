// /api/call-voice — the TwiML for every OUTBOUND call this system places.
//
// Twilio runs answering-machine detection before it asks for this document, so AnsweredBy is
// already decided by the time we are called and we can branch on it honestly:
//
//   human            speak the locked opening, then the mode's body
//   machine_end_*    leave one short honest message, promise not to call again, hang up
//   fax / unknown    hang up without speaking
//
// Live transcription is started first, non-blocking, so the cockpit sees words appear while the
// call is still running, and so the stop-word detector in /api/call-transcription is listening
// from the first syllable rather than from whenever a turn completes.
//
// MODES
//   measure    the answer-rate study: disclosure, thanks, out. Asks for nothing.
//   discovery  disclosure, one question about the past, then the free-week offer.
//   conference drop the callee into a named conference (operator dial, and the destination a
//              live AI call is redirected into when an operator takes it over).

import { authenticate, XML, SAY, esc, origin, transcriptionStart, injectIntoResponse } from './lib/twilio-webhook.mjs';
import { SCRIPTS } from './lib/scripts.mjs';
import * as db from './lib/db.mjs';

const PUBLIC_PATH = '/api/call-voice';
const EL_KEY = () => (process.env.ELEVENLABS_API_KEY || '').trim();
const RESEARCH_AGENT = () => (process.env.ANSWERED_RESEARCH_AGENT_ID || '').trim();

const HANGUP = '<Response><Hangup/></Response>';

async function log(callSid, kind, payload) {
  try { await db.addEvent(callSid, kind, payload); } catch (e) {
    console.error('call-voice log failed:', String(e.message).slice(0, 140));
  }
}

/** Bridge to an ElevenLabs research agent, with live transcription spliced into their TwiML. */
async function elBridge(base, p, mode) {
  const agent = RESEARCH_AGENT();
  if (!agent || !EL_KEY()) return null;
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/convai/twilio/register-call', {
      method: 'POST',
      headers: { 'xi-api-key': EL_KEY(), 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ agent_id: agent, from_number: p.From || '', to_number: p.To || '', direction: 'outbound' }),
    });
    const twiml = await r.text();
    if (!r.ok || !/<Response/i.test(twiml)) throw new Error(`register-call ${r.status}`);
    return injectIntoResponse(twiml, transcriptionStart(base, { callSid: p.CallSid, mode }));
  } catch (e) {
    console.error('call-voice: EL bridge failed, falling back to the local turn loop:', String(e.message).slice(0, 140));
    return null;
  }
}

export const handler = async (event) => {
  const gate = authenticate(event, PUBLIC_PATH);
  if (!gate.ok) return gate.reject;

  const p = gate.params;
  const q = event.queryStringParameters || {};
  const mode = (q.mode || 'measure').toLowerCase();
  const base = origin(event);
  const answeredBy = String(p.AnsweredBy || 'unknown');

  await log(p.CallSid, 'twiml_requested', { mode, answeredBy, to: p.To, from: p.From });

  // ── machine ────────────────────────────────────────────────────────────────────────────────
  if (answeredBy.startsWith('machine')) {
    // Only speak after a detected end-of-greeting. Talking over someone's outgoing message
    // produces a voicemail that is half a sentence, which is worse than silence.
    if (answeredBy === 'machine_end_beep' || answeredBy === 'machine_end_silence' || answeredBy === 'machine_end_other') {
      return XML(`<Response>${SAY(SCRIPTS.voicemail.text())}<Hangup/></Response>`);
    }
    return XML(HANGUP);
  }
  if (answeredBy === 'fax') return XML(HANGUP);

  // ── conference: operator dial, and the takeover destination ────────────────────────────────
  if (mode === 'conference') {
    const name = q.conf || `ans-${p.CallSid}`;
    return XML(
      `<Response>`
      + transcriptionStart(base, { callSid: p.CallSid, mode })
      + `<Dial><Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="false" `
      + `statusCallbackEvent="start end join leave" statusCallback="${esc(`${base}/api/call-status?kind=conference`)}" `
      + `statusCallbackMethod="POST" record="record-from-start" `
      + `recordingStatusCallback="${esc(`${base}/api/call-recording`)}">${esc(name)}</Conference></Dial></Response>`,
    );
  }

  // ── discovery: a real conversation ─────────────────────────────────────────────────────────
  if (mode === 'discovery') {
    const bridged = await elBridge(base, p, mode);
    if (bridged) { await log(p.CallSid, 'bridged', { vendor: 'elevenlabs' }); return XML(bridged); }

    // Local turn loop. Slower than a streaming bridge, fully under our control, and it works
    // with no vendor configured at all. A two minute research call does not need barge-in.
    const s = SCRIPTS.discovery;
    return XML(
      `<Response>`
      + transcriptionStart(base, { callSid: p.CallSid, mode })
      + `<Gather input="speech" speechTimeout="auto" timeout="${s.listenSeconds}" `
      + `action="${esc(`${base}/api/call-turn?mode=discovery&turn=1`)}" method="POST" `
      + `actionOnEmptyResult="true" language="en-US">`
      + SAY(s.open())
      + `</Gather></Response>`,
    );
  }

  // ── measure: the answer-rate study ─────────────────────────────────────────────────────────
  const s = SCRIPTS.measure;
  return XML(
    `<Response>`
    + transcriptionStart(base, { callSid: p.CallSid, mode })
    + `<Gather input="speech" speechTimeout="auto" timeout="${s.listenSeconds}" `
    + `action="${esc(`${base}/api/call-turn?mode=measure&turn=1`)}" method="POST" `
    + `actionOnEmptyResult="true" language="en-US">`
    + SAY(s.open())
    + `</Gather></Response>`,
  );
};
