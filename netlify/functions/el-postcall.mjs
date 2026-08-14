// POST /api/el-postcall — ElevenLabs hands us the call after it ends, and we turn it into a record.
//
// This is the transcript path for the line that actually works today: the inbound demo number,
// answered by the ConvAI agent as Riley. When a conversation finishes, ElevenLabs POSTs the whole
// thing here (transcript, duration, the caller's number, its own summary), this writes it into the
// live call spine, and then delivers the recap. One recap format, one delivery layer, one place
// where the copy about texting lives.
//
// ★ THE SIGNATURE IS CHECKED, AND IT FAILS CLOSED. An unauthenticated webhook that writes a
// transcript and emails an operator is a way for a stranger to put words in a customer's mouth and
// have the shop read them as if they were said. ElevenLabs signs with
// `ElevenLabs-Signature: t=<unix>,v0=<hex>` over `${t}.${rawBody}`. Three things this checks that a
// naive implementation skips:
//   1. The RAW body, byte for byte, before any JSON.parse. Re-serializing changes key order and
//      whitespace, and every signature fails for reasons nobody can find.
//   2. A constant-time compare, on equal-length buffers.
//   3. The timestamp, against a 30 minute window, so yesterday's captured payload cannot be
//      replayed today.
// With ELEVENLABS_WEBHOOK_SECRET unset this returns 503 and refuses everything. It never accepts
// an unsigned payload "for now".
//
// ★ THE SECRET IS ELEVENLABS', NOT OURS. `POST /v1/workspace/webhooks` GENERATES the signing
// secret and returns it exactly once, at creation. You cannot choose your own. Anyone "generating
// a webhook secret" and setting it here will watch every signature fail with a correct
// implementation, which is a very expensive afternoon. The value in ELEVENLABS_WEBHOOK_SECRET
// must be the `wsec_...` string that call returned.
//
// ★ WHAT THIS DOES WITH A VERIFIED EVENT, in order, because the order is the point:
//   1. PERSIST to the spine (calls, transcript_lines, call_events) via the sv_* RPCs. Before this
//      existed, `calls` held ZERO inbound rows and `transcript_lines` held ZERO ElevenLabs lines:
//      the line answered, people spoke, and the only copy of those words lived inside a vendor.
//   2. DELIVER the recap on whatever channels ANSWERED_RECAP_CHANNELS names, guarded by a durable
//      per-call claim so a retry cannot send twice.
// Storing first means a mail outage costs nobody their record.

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
  const to = String(phone.agent_number || phone.to_number || '');

  // The demo number is ours, not a customer's line. Labelling those calls 'demo' keeps the
  // billing and reporting surfaces from counting a proof call as a shop's inbound call.
  const demo = String(process.env.ANSWERED_DEMO_NUMBER || '').trim();

  return {
    call_sid: /^CA[0-9a-f]{32}$/i.test(callSid) ? callSid : '',
    conversation_id: String(d.conversation_id || ''),
    agent_id: String(d.agent_id || ''),
    direction: String(phone.direction || 'inbound') === 'outbound' ? 'outbound' : 'inbound',
    from: String(phone.external_number || phone.from_number || ''),
    to,
    started_at: Number.isFinite(startSecs) && startSecs > 0 ? new Date(startSecs * 1000).toISOString() : '',
    duration_seconds: Number(meta.call_duration_secs ?? d.call_duration_secs),
    termination_reason: String(meta.termination_reason || ''),
    disposition: String(analysis.call_successful || d.status || ''),
    summary: String(analysis.transcript_summary || ''),
    summary_title: String(analysis.call_summary_title || ''),
    call_class: demo && to === demo ? 'demo' : 'inbound',
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
  if (!input.transcript.length && !input.call_sid && !input.conversation_id) {
    return json(200, { ok: true, ignored: 'no transcript, no call sid and no conversation id in the payload, so there is nothing to file' });
  }

  const result = await deliverRecap(input, { site: new URL(req.url).origin, persist: true });
  // Always 200 to ElevenLabs once the signature passed: a non-2xx makes them retry, and the words
  // are already stored by this point, so a retry could only duplicate a delivery.
  if (!result.ok) console.error(`el-postcall: recap delivery failed for ${result.key}: ${JSON.stringify(result.delivery)}`);
  return json(200, { ok: true, recap: result });
};

export const config = { path: '/api/el-postcall' };
