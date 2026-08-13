// /api/demo-health. The single source of truth for "is the demo line alive?"
//
// LAW: the front end may render a dialable demo control ONLY from a green
// answer here. There is no fake green state in this file and there never will
// be: a health check that guesses green is exactly how this estate once
// shipped a dead play button on the homepage.
//
// Phase B: the three REAL probes are wired in. Per the probe-landed law (a
// probe that never landed cannot prove a gate works), every probe reports TWO
// booleans, never conflated:
//   landed  = the check itself ran end to end and got an answer
//   ok      = what that answer said
// A timeout, a transport failure, or a missing env var is landed=false with a
// reason. It never means ok, and it never defaults to ok. healthy is true only
// when all three probes landed AND all three said yes.
//
// Env, by NAME only:
//   ELEVENLABS_API_KEY     probe 1, subscription status
//   ANSWERED_BRAIN_SECRET  probe 2, Bearer for the self-call to the bridge
//   TWILIO_ACCOUNT_SID     probe 3, Lookup auth
//   TWILIO_AUTH_TOKEN      probe 3, Lookup auth
//   ANSWERED_DEMO_NUMBER   probe 3, the number being looked up
//
// THE FRONT-END CONTRACT DOES NOT CHANGE: nothing on any page calls this yet.
// Shape stays {healthy, checks: {...}, checked}, GET-only, no-store.
'use strict';

const CACHE_MS = 60000; // page loads must not stampede the vendors
let cached = { at: 0, body: null };

function probeFail(reason) {
  return { landed: false, ok: false, reason };
}

// ── probe 1: ElevenLabs subscription ────────────────────────────────────────
async function probeElSubscription() {
  const key = (process.env.ELEVENLABS_API_KEY || '').trim();
  if (!key) return probeFail('env not set');
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
      headers: { 'xi-api-key': key },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return { landed: true, ok: false, reason: 'subscription read returned ' + r.status };
    const j = await r.json();
    if (j.status === 'past_due') return { landed: true, ok: false, reason: 'subscription past_due' };
    if (typeof j.character_count === 'number' && typeof j.character_limit === 'number' && j.character_count >= j.character_limit) {
      return { landed: true, ok: false, reason: 'character quota exhausted' };
    }
    return { landed: true, ok: true, reason: '' };
  } catch (e) {
    return probeFail('request failed: ' + String(e && e.message).slice(0, 80));
  }
}

// ── probe 2: the reasoning bridge answers its warm ping ─────────────────────
// A POST to the real bridge path with the real Bearer secret. The warm ping is
// designed for exactly this: it proves route + auth + key config end to end
// without spending a model token. Anything other than a 200 is not ready.
async function probeBrainReady(host) {
  const secret = (process.env.ANSWERED_BRAIN_SECRET || '').trim();
  if (!secret) return probeFail('env not set');
  const base = (process.env.URL || (host ? 'https://' + host : '')).replace(/\/+$/, '');
  if (!base) return probeFail('no site host available for the self-call');
  try {
    const r = await fetch(base + '/api/answered-brain', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ warm: true }),
      signal: AbortSignal.timeout(5000),
    });
    if (r.status !== 200) return { landed: true, ok: false, reason: 'bridge answered ' + r.status };
    return { landed: true, ok: true, reason: '' };
  } catch (e) {
    return probeFail('request failed: ' + String(e && e.message).slice(0, 80));
  }
}

// ── probe 3: Twilio Lookup v2 on the demo number ────────────────────────────
async function probeTwilioNumber() {
  const sid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const tok = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  const num = (process.env.ANSWERED_DEMO_NUMBER || '').trim();
  if (!sid || !tok || !num) return probeFail('env not set');
  const clean = num.replace(/[^+\d]/g, '');
  if (!/^\+\d{10,15}$/.test(clean)) return probeFail('ANSWERED_DEMO_NUMBER is not E.164');
  try {
    const r = await fetch('https://lookups.twilio.com/v2/PhoneNumbers/' + encodeURIComponent(clean), {
      headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64') },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return { landed: true, ok: false, reason: 'lookup returned ' + r.status };
    const j = await r.json();
    if (j.valid !== true) return { landed: true, ok: false, reason: 'lookup says the number is not valid' };
    return { landed: true, ok: true, reason: '' };
  } catch (e) {
    return probeFail('request failed: ' + String(e && e.message).slice(0, 80));
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: { Allow: 'GET' }, body: 'Method not allowed' };
  }

  const now = Date.now();
  let body = cached.body;
  if (!body || now - cached.at > CACHE_MS) {
    const headers = {};
    for (const k in (event.headers || {})) headers[k.toLowerCase()] = event.headers[k];
    const host = String(headers.host || '');

    const [el, brain, twilio] = await Promise.all([
      probeElSubscription(),
      probeBrainReady(host),
      probeTwilioNumber(),
    ]);

    const checks = { el_subscription: el, brain_ready: brain, twilio_number: twilio };
    const healthy = [el, brain, twilio].every((c) => c.landed && c.ok);
    body = { healthy, checks, checked: new Date().toISOString() };
    cached = { at: now, body };
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(body),
  };
};
