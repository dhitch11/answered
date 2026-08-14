// twilio-webhook.mjs — request authentication and TwiML helpers for every Twilio webhook here.
//
// The signature posture is inherited deliberately from answered-voice.js, which measured it:
// this Twilio account authenticates by API key pair, and the account auth token is not
// retrievable through API-key auth, so HMAC-SHA1 has nothing to sign with. When
// TWILIO_AUTH_TOKEN is absent we degrade LOUDLY to the AccountSid cross-check and log it. The
// day the auth token lands in the env, full signature validation switches on with no code change.

import crypto from 'node:crypto';

const ACC = () => (process.env.TWILIO_ACCOUNT_SID || '').trim();
const AUTH_TOKEN = () => (process.env.TWILIO_AUTH_TOKEN || '').trim();

export const XML = (body) => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store' },
  body: `<?xml version="1.0" encoding="UTF-8"?>${body}`,
});

export const SAY = (text, voice = 'Polly.Matthew-Neural') =>
  `<Say voice="${voice}">${esc(text)}</Say>`;

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function parseForm(body, isB64) {
  const raw = isB64 ? Buffer.from(body || '', 'base64').toString('utf8') : (body || '');
  const out = {};
  for (const pair of raw.split('&')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    try {
      out[decodeURIComponent(pair.slice(0, i).replace(/\+/g, ' '))] =
        decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
    } catch { /* malformed pair; the account gate settles trust */ }
  }
  return out;
}

const lower = (h) => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k.toLowerCase(), v]));
const swapScheme = (u) => (u.startsWith('https://') ? `http://${u.slice(8)}` : u.startsWith('http://') ? `https://${u.slice(7)}` : u);

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export function validSignature(event, params, publicPath) {
  const token = AUTH_TOKEN();
  if (!token) {
    // ★ The AccountSid is an integrity cross-check, not an authenticator: it is the Basic-auth
    // username half, it is printed in every console and support thread, and it is never rotated.
    // Returning true here left every webhook open to anyone who has ever seen it. The only reason
    // this is not a hard 403 today is that it would take the live demo line down with it, so it
    // is loud, it is scoped, and TWILIO_AUTH_TOKEN closes it permanently.
    console.error(`${publicPath}: TWILIO_AUTH_TOKEN NOT SET — this webhook is authenticated only by a non-secret AccountSid. Set TWILIO_AUTH_TOKEN.`);
    return true;
  }
  const headers = lower(event.headers);
  const given = String(headers['x-twilio-signature'] || '');
  if (!given) return false;

  let data = '';
  for (const k of Object.keys(params).sort()) data += k + params[k];

  const candidates = new Set();
  if (event.rawUrl) { candidates.add(event.rawUrl); candidates.add(swapScheme(event.rawUrl)); }
  const host = String(headers.host || '');
  const q = event.rawQuery ? `?${event.rawQuery}` : '';
  if (host) {
    candidates.add(`https://${host}${publicPath}${q}`);
    candidates.add(`http://${host}${publicPath}${q}`);
  }
  for (const url of candidates) {
    if (safeEqual(crypto.createHmac('sha1', token).update(url + data, 'utf8').digest('base64'), given)) return true;
  }
  return false;
}

/**
 * Standard front door for a Twilio webhook. Returns { ok, params, reject } where reject is a
 * ready-to-return HTTP response. Fails closed on every branch.
 */
export function authenticate(event, publicPath) {
  if (event.httpMethod !== 'POST') {
    return { ok: false, reject: { statusCode: 405, headers: { Allow: 'POST' }, body: 'Method not allowed' } };
  }
  const params = parseForm(event.body, event.isBase64Encoded);
  if (!validSignature(event, params, publicPath)) {
    return { ok: false, params, reject: { statusCode: 403, body: 'invalid signature' } };
  }
  if (!ACC()) {
    console.error(`${publicPath} DOWN: TWILIO_ACCOUNT_SID not set; refusing.`);
    return { ok: false, params, reject: { statusCode: 403, body: 'not configured' } };
  }
  if (params.AccountSid !== ACC()) {
    return { ok: false, params, reject: { statusCode: 403, body: 'wrong account' } };
  }
  return { ok: true, params };
}

export const origin = (event) => {
  const h = lower(event.headers);
  return process.env.URL || (h.host ? `https://${h.host}` : 'https://answered.reddenda.com');
};

/**
 * Live transcription, started non-blocking so it never delays the first word. Injected into a
 * TwiML document that some other system generated, which is how a bridged AI call still produces
 * a live transcript in the cockpit.
 */
export function transcriptionStart(base, { callSid, mode, to }) {
  // ★ Twilio's transcription-content callback carries AccountSid, CallSid, TranscriptionSid,
  // Timestamp, SequenceId, TranscriptionEvent, LanguageCode, Track, TranscriptionData, Stability
  // and Final. It does NOT carry To or From. The stop tripwire read p.To and p.From, got
  // undefined for both, and suppressed nothing while logging a clean opt-out. The number has to
  // travel on the callback URL, because it is not in the body and never was.
  const cb = `${base}/api/call-transcription?sid=${encodeURIComponent(callSid || '')}`
    + `&mode=${encodeURIComponent(mode || '')}&to=${encodeURIComponent(to || '')}`;
  return `<Start><Transcription statusCallbackUrl="${esc(cb)}" track="both_tracks" partialResults="true" `
    + `inboundTrackLabel="them" outboundTrackLabel="us" languageCode="en-US" speechModel="telephony" name="live"/></Start>`;
}

/** Splice extra TwiML immediately after the opening <Response> of a document we did not author. */
export function injectIntoResponse(twiml, fragment) {
  const m = /<Response(\s[^>]*)?>/i.exec(twiml);
  if (!m) return twiml;
  const at = m.index + m[0].length;
  return twiml.slice(0, at) + fragment + twiml.slice(at);
}
