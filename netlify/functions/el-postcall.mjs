// POST /api/el-postcall — ElevenLabs hands us the call after it ends, and we turn it into a recap.
//
// This is the transcript delivery path for the line that actually works today: the inbound demo
// number, answered by the ConvAI agent as Riley. When a conversation finishes, ElevenLabs POSTs
// the whole thing here (transcript, duration, the caller's number, its own summary), and this
// forwards it into the same recap flow the outbound side uses. One recap format, one channel,
// one place where the copy about texting lives.
//
// ★ THE SIGNATURE IS CHECKED, AND IT FAILS CLOSED. An unauthenticated webhook that emails an
// operator is a way for a stranger to put words in a transcript and have the shop read them as if
// a customer said them. ElevenLabs signs with `ElevenLabs-Signature: t=<unix>,v0=<hex>` over
// `${t}.${rawBody}`. Three things this checks that a naive implementation skips:
//   1. The RAW body, byte for byte, before any JSON.parse. Re-serializing changes key order and
//      whitespace, and every signature fails for reasons nobody can find.
//   2. A constant-time compare, on equal-length buffers.
//   3. The timestamp, against a 30 minute window, so yesterday's captured payload cannot be
//      replayed today.
// With ELEVENLABS_WEBHOOK_SECRET unset this returns 503 and refuses everything. It never accepts
// an unsigned payload "for now".
//
// OPERATOR STEP THIS NEEDS, AND IT IS NOT DONE YET: in the ElevenLabs dashboard, set the agent's
// post-call webhook to https://answered.reddenda.com/api/el-postcall and copy the signing secret
// into ELEVENLABS_WEBHOOK_SECRET on the Netlify site. Until both exist, this endpoint is live and
// correctly refusing, which is the honest state, not a broken one.

import crypto from 'node:crypto';
import { deliverRecap } from './recap.mjs';

const MAX_BODY = 2 * 1024 * 1024;
const TOLERANCE_MS = 30 * 60 * 1000;

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
});

export function checkSignature(header, rawBody, secret, now = Date.now()) {
  if (!secret) return { ok: false, status: 503, why: 'ELEVENLABS_WEBHOOK_SECRET is not set, so this endpoint cannot verify anything and is refusing every request.' };
  const h = String(header || '');
  if (!h) return { ok: false, status: 401, why: 'no ElevenLabs-Signature header' };

  const parts = Object.fromEntries(h.split(',').map((p) => {
    const i = p.indexOf('=');
    return i < 0 ? [p.trim(), ''] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  }));
  const t = parts.t;
  const given = parts.v0 || parts.v1;
  if (!t || !given || !/^\d+$/.test(t)) return { ok: false, status: 401, why: 'signature header is malformed' };

  const ageMs = Math.abs(now - Number(t) * 1000);
  if (ageMs > TOLERANCE_MS) return { ok: false, status: 401, why: `signature timestamp is ${Math.round(ageMs / 60000)} minutes off, outside the 30 minute window` };

  const want = Buffer.from(crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'));
  const got = Buffer.from(String(given).replace(/^v0=/, ''));
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) {
    return { ok: false, status: 401, why: 'signature does not match' };
  }
  return { ok: true };
}

/** Pull what we need out of ElevenLabs' payload without ever assuming its shape. */
export function readPayload(body) {
  const d = (body && body.data) || body || {};
  const meta = d.metadata || {};
  const phone = meta.phone_call || d.phone_call || {};
  const analysis = d.analysis || {};

  const transcript = Array.isArray(d.transcript) ? d.transcript : [];
  const lines = transcript.map((t) => ({
    speaker: t && (t.role || t.speaker),
    text: t && (t.message ?? t.text ?? ''),
  })).filter((l) => String(l.text || '').trim());

  const startSecs = Number(meta.start_time_unix_secs);
  const callSid = String(phone.call_sid || d.call_sid || '');

  return {
    call_sid: /^CA[0-9a-f]{32}$/i.test(callSid) ? callSid : '',
    conversation_id: String(d.conversation_id || ''),
    from: String(phone.external_number || phone.from_number || ''),
    to: String(phone.agent_number || phone.to_number || ''),
    started_at: Number.isFinite(startSecs) && startSecs > 0 ? new Date(startSecs * 1000).toISOString() : '',
    duration_seconds: Number(meta.call_duration_secs ?? d.call_duration_secs),
    disposition: String(analysis.call_successful || d.status || ''),
    summary: String(analysis.transcript_summary || ''),
    transcript: lines,
  };
}

export default async (req) => {
  if (req.method !== 'POST') {
    return json(405, { ok: false, error: 'POST only. This is the ElevenLabs post-call webhook receiver.' });
  }

  let raw = '';
  try { raw = await req.text(); } catch { return json(400, { ok: false, error: 'Could not read the body.' }); }
  if (raw.length > MAX_BODY) return json(413, { ok: false, error: 'Body is over the cap.' });

  const sig = req.headers.get('elevenlabs-signature') || req.headers.get('ElevenLabs-Signature');
  const check = checkSignature(sig, raw, String(process.env.ELEVENLABS_WEBHOOK_SECRET || '').trim());
  if (!check.ok) {
    console.error(`el-postcall refused a request: ${check.why}`);
    return json(check.status, { ok: false, error: check.why });
  }

  let body;
  try { body = JSON.parse(raw || '{}'); } catch { return json(400, { ok: false, error: 'Body must be JSON.' }); }

  const type = String((body && body.type) || '');
  if (type && type !== 'post_call_transcription') {
    // Audio-only events and anything else EL adds later are acknowledged, not processed. A 4xx
    // here would make ElevenLabs retry an event we are never going to want.
    return json(200, { ok: true, ignored: type });
  }

  const input = readPayload(body);
  if (!input.transcript.length && !input.call_sid) {
    return json(200, { ok: true, ignored: 'no transcript and no call sid in the payload, so there is nothing to recap' });
  }

  const result = await deliverRecap(input, { site: new URL(req.url).origin });
  // Always 200 to ElevenLabs once the signature passed: a non-2xx makes them retry, and a retry of
  // an email that already went is worse than a log line about one that did not.
  if (!result.ok && !result.duplicate) console.error(`el-postcall: recap delivery failed: ${JSON.stringify(result.delivery && result.delivery.email)}`);
  return json(200, { ok: true, recap: result });
};

export const config = { path: '/api/el-postcall' };
