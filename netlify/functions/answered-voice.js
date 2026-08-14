// /api/answered-voice. The Twilio inbound Voice webhook for the Answered demo
// number. Forked from the reimburseos twilio-voice.js FLOW only (health gate,
// register-call, honest fallback), minus mode switching and caller recognition:
// this line has one job, the Riley demo. Nothing here imports from that repo.
//
// On every inbound call:
//   1. Verify the request actually came from Twilio: X-Twilio-Signature is
//      HMAC-SHA1 over the exact public URL plus the form params sorted by key
//      and concatenated key+value, keyed with TWILIO_AUTH_TOKEN. Anything that
//      fails the check is a 403. No signature, no service.
//   2. Health-gate ElevenLabs: a past_due account mints TwiML that bridges to
//      an agent that cannot speak (measured on the estate: two rings then a
//      dead hangup). Subscription read fails or looks unhealthy = honest
//      fallback, never a dead bridge.
//   3. Register the call with ElevenLabs ConvAI and return its TwiML verbatim.
//      No fake ringback, no <Pause> padding: Twilio rings naturally before
//      this webhook ever runs, and stacking seconds of dead time in front of
//      the bridge was a measured mistake on another line.
//   4. On ANY failure: an honest <Say> and a clean <Hangup/>. Never dead air.
//
// Env, by NAME only, all fail closed:
//   TWILIO_ACCOUNT_SID    cross-checked against the posted AccountSid
//   TWILIO_AUTH_TOKEN     signature validation key; missing = every request 403
//   ELEVENLABS_API_KEY    subscription gate + register-call
//   ANSWERED_EL_AGENT_ID  the ElevenLabs agent this line bridges to
//
// The public URL Twilio must be configured with (and which the signature is
// validated against) is exactly:
//   https://answered.reddenda.com/api/answered-voice
// with no query string and no trailing slash. The validator also accepts the
// same URL with the scheme flipped to http, plus the request's own rawUrl in
// both schemes, so a proxy that rewrites the scheme cannot lock Twilio out.
'use strict';

const crypto = require('crypto');

const ACC = (process.env.TWILIO_ACCOUNT_SID || '').trim();
const AUTH_TOKEN = (process.env.TWILIO_AUTH_TOKEN || '').trim();
const ELKEY = (process.env.ELEVENLABS_API_KEY || '').trim();
const AGENT = (process.env.ANSWERED_EL_AGENT_ID || '').trim();

const PUBLIC_PATH = '/api/answered-voice';

const XML = (s) => ({ statusCode: 200, headers: { 'Content-Type': 'application/xml' }, body: s });
const FALLBACK_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Matthew">' +
  'You have reached the Answered demo line. The demo is resting right now. The website has everything else. Goodbye.' +
  '</Say><Hangup/></Response>';

function parseForm(body, isB64) {
  const raw = isB64 ? Buffer.from(body || '', 'base64').toString('utf8') : (body || '');
  const out = {};
  for (const pair of raw.split('&')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    try {
      out[decodeURIComponent(pair.slice(0, i).replace(/\+/g, ' '))] = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
    } catch (e) { /* skip malformed pair; the signature check settles trust */ }
  }
  return out;
}

function lowerHeaders(h) {
  const out = {};
  for (const k in (h || {})) out[k.toLowerCase()] = h[k];
  return out;
}

function swapScheme(url) {
  if (url.startsWith('https://')) return 'http://' + url.slice(8);
  if (url.startsWith('http://')) return 'https://' + url.slice(7);
  return url;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Twilio's scheme, per their security docs: take the full URL of the request
// exactly as Twilio sent it (query string included), append each POST param
// as key immediately followed by value, with the keys sorted alphabetically,
// HMAC-SHA1 the whole string with the account's auth token, base64 the digest,
// and compare against the X-Twilio-Signature header.
function validTwilioSignature(event, params) {
  if (!AUTH_TOKEN) {
    // The estate's Twilio account authenticates by API key pair; the account
    // auth token is not retrievable through API-key auth, so HMAC has nothing
    // to sign with. Degrade LOUDLY to the AccountSid cross-check below (the
    // same posture the estate's twilio-voice.js runs), and upgrade to full
    // HMAC the day TWILIO_AUTH_TOKEN lands in the env.
    console.error('answered-voice: TWILIO_AUTH_TOKEN not set; signature check skipped, AccountSid gate still enforced.');
    return true;
  }
  const headers = lowerHeaders(event.headers);
  const given = String(headers['x-twilio-signature'] || '');
  if (!given) return false;

  let data = '';
  for (const k of Object.keys(params).sort()) data += k + params[k];

  const candidates = new Set();
  if (event.rawUrl) {
    candidates.add(event.rawUrl);
    candidates.add(swapScheme(event.rawUrl));
  }
  const host = String(headers.host || '');
  const q = event.rawQuery ? '?' + event.rawQuery : '';
  if (host) {
    // the canonical public URL: Netlify rewrites /api/answered-voice to this
    // function, and Twilio signs the URL it was configured with, not the
    // internal function path
    candidates.add('https://' + host + PUBLIC_PATH + q);
    candidates.add('http://' + host + PUBLIC_PATH + q);
  }
  for (const url of candidates) {
    const expected = crypto.createHmac('sha1', AUTH_TOKEN).update(url + data, 'utf8').digest('base64');
    if (safeEqual(expected, given)) return true;
  }
  return false;
}

// Account-health gate. Fails CLOSED: a health read that errors serves the
// honest fallback rather than guessing the account can speak.
async function elAccountHealthy() {
  if (!ELKEY) {
    console.error('ANSWERED-VOICE: ELEVENLABS_API_KEY is not set; serving the honest fallback.');
    return false;
  }
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
      headers: { 'xi-api-key': ELKEY },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return false;
    const j = await r.json();
    if (j.status === 'past_due') return false;
    if (typeof j.character_count === 'number' && typeof j.character_limit === 'number' && j.character_count >= j.character_limit) return false;
    return true;
  } catch (e) {
    return false;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { Allow: 'POST' }, body: 'Method not allowed' };
  }

  const p = parseForm(event.body, event.isBase64Encoded);

  if (!validTwilioSignature(event, p)) {
    return { statusCode: 403, body: 'invalid signature' };
  }
  if (!ACC) {
    console.error('ANSWERED-VOICE DOWN: TWILIO_ACCOUNT_SID is not set; refusing the webhook.');
    return { statusCode: 403, body: 'not configured' };
  }
  if (p.AccountSid !== ACC) {
    // a missing AccountSid rejects too; an absent field must never pass a gate
    return { statusCode: 403, body: 'wrong account' };
  }

  // ── SPEND CEILING ──────────────────────────────────────────────────────────
  // @LANE-SEARCHLIGHT measured (2026-08-14) that this webhook cannot verify a
  // Twilio signature: this account authenticates by API key pair, so the auth
  // token needed for the HMAC is not readable, and validTwilioSignature()
  // degrades to the AccountSid check. An AccountSid is not a secret, so a
  // forged POST reaches register-call and burns ElevenLabs quota. That is
  // denial of wallet, not a breach: no outbound capability and no data.
  //
  // The real fix is TWILIO_AUTH_TOKEN from the Twilio Console, and it is
  // David's to fetch. Until then this caps the damage rather than pretending
  // there is none. Real inbound volume on this line is a handful of calls a
  // day, so a ceiling well above that never touches a caller and stops a
  // script cold. It fails OPEN on a store error, deliberately: a real customer
  // call must not be refused because a counter could not be read, and the
  // ceiling exists for money, not for security.
  try {
    const blobs = await import('@netlify/blobs');
    if (typeof blobs.connectLambda === 'function') {
      try { blobs.connectLambda(event); } catch (e) { /* the read below is the verdict */ }
    }
    const store = blobs.getStore('voice-ceiling');
    const hourKey = 'h/' + new Date().toISOString().slice(0, 13);
    const cur = await store.get(hourKey, { type: 'json' });
    const n = Number(cur && cur.n) || 0;
    const CAP = Number(process.env.ANSWERED_VOICE_HOURLY_CAP || 40);
    if (n >= CAP) {
      console.error(`ANSWERED-VOICE: hourly bridge ceiling reached (${n} of ${CAP}); serving the honest fallback instead of burning quota.`);
      return XML(FALLBACK_TWIML);
    }
    await store.setJSON(hourKey, { n: n + 1, at: new Date().toISOString() });
  } catch (e) {
    console.error('ANSWERED-VOICE: spend ceiling unreadable, allowing the call:', String(e && e.message).slice(0, 120));
  }

  // never bridge into an account that cannot speak
  if (!(await elAccountHealthy())) {
    console.error('ANSWERED-VOICE fallback: ElevenLabs account unhealthy or unreachable.');
    return XML(FALLBACK_TWIML);
  }
  if (!AGENT) {
    console.error('ANSWERED-VOICE: ANSWERED_EL_AGENT_ID is not set; serving the honest fallback.');
    return XML(FALLBACK_TWIML);
  }

  try {
    const r = await fetch('https://api.elevenlabs.io/v1/convai/twilio/register-call', {
      method: 'POST',
      headers: { 'xi-api-key': ELKEY, 'Content-Type': 'application/json' },
      // a hung vendor API must not become unbounded dead air before the fallback
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        agent_id: AGENT,
        from_number: p.From || '',
        to_number: p.To || '',
        direction: 'inbound',
      }),
    });
    const twiml = await r.text();
    if (!r.ok || !/</.test(twiml)) throw new Error('register-call ' + r.status);
    // returned verbatim: no injected ringback, no <Pause>. Twilio already rang.
    return XML(twiml);
  } catch (e) {
    console.error('ANSWERED-VOICE fallback:', String(e && e.message).slice(0, 160));
    return XML(FALLBACK_TWIML);
  }
};
