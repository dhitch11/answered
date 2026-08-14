// /api/call-recording — the recording landed. Store the pointer, not the audio.
//
// The mp3 stays in Twilio's storage and the cockpit streams it through /api/recording, which
// authenticates with the API key server-side. That way a recording URL is never a bearer token:
// pasting one into a browser without the operator cookie gets a 401, not a customer's voice.

import { authenticate } from './lib/twilio-webhook.mjs';
import * as db from './lib/db.mjs';

const PUBLIC_PATH = '/api/call-recording';
const OK = { statusCode: 204, body: '' };

export const handler = async (event) => {
  const gate = authenticate(event, PUBLIC_PATH);
  if (!gate.ok) return gate.reject;

  const p = gate.params;
  const sid = p.CallSid;
  const status = String(p.RecordingStatus || '');

  try {
    if (status === 'completed' && p.RecordingSid) {
      await db.updateCall(sid, {
        recording_sid: p.RecordingSid,
        recording_seconds: p.RecordingDuration ? Number(p.RecordingDuration) : null,
        // Deliberately our own gated route, never Twilio's URL.
        recording_url: `/api/recording?sid=${encodeURIComponent(p.RecordingSid)}`,
      });
    }
    await db.addEvent(sid, `recording_${status || 'event'}`, {
      recording_sid: p.RecordingSid, duration: p.RecordingDuration, channels: p.RecordingChannels,
    });
  } catch (e) {
    console.error('call-recording write failed:', String(e.message).slice(0, 160));
  }
  return OK;
};
