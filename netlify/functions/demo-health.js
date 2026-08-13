// /api/demo-health. The single source of truth for "is the demo line alive?"
//
// LAW: the front end may render a dialable demo control ONLY from a green
// answer here. Today no demo line is provisioned, so this endpoint reports
// an HONEST RED. There is no fake green state in this file and there never
// will be: a health check that guesses green is exactly how this estate once
// shipped a dead play button on the homepage.
//
// This endpoint ships dark: no page calls it yet. It exists now so the
// contract is fixed before Phase B wires the real probes in.
//
// PHASE B CONTRACT (per the probe-landed law: a probe that never landed
// cannot prove a gate works). Every probe reports TWO booleans:
//   <probe>_landed  = the check itself ran end to end and got an answer
//   <verdict>       = what that answer said
// A timeout or transport failure means landed=false. It never means the
// verdict is false, and it never defaults to true. healthy may be true only
// when all three probes landed AND all three verdicts are good.
'use strict';

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: { Allow: 'GET' }, body: 'Method not allowed' };
  }

  // ── PHASE B PROBE 1: ElevenLabs subscription status ─────────────────────
  // TODO(phase-b): call the ElevenLabs subscription endpoint using
  // ELEVENLABS_API_KEY (env var, by name only, never hardcoded).
  //   el_probe_landed          true only when the request completed with an answer
  //   el_subscription_active   true only when the subscription is current and
  //                            not past_due; anything else is false
  // A 401, a timeout, or a 5xx from the vendor is landed=false, reported as such.

  // ── PHASE B PROBE 2: bridge warm ping ────────────────────────────────────
  // TODO(phase-b): GET the call bridge's warm-ping route at
  // DEMO_BRIDGE_HEALTH_URL (env var).
  //   bridge_probe_landed   true only when the ping completed
  //   bridge_warm           true only on a fresh 2xx from the bridge itself
  // The bridge going cold while the site keeps selling the demo is the
  // premortem's silent-degrade failure. This probe is the tripwire for it.

  // ── PHASE B PROBE 3: Twilio number lookup ────────────────────────────────
  // TODO(phase-b): Twilio Lookup on the provisioned demo number, using
  // TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and DEMO_LINE_NUMBER (env vars).
  //   twilio_probe_landed   true only when the lookup completed
  //   number_provisioned    true only when the number is active on our account

  // TODO(phase-b): cache the composite for about 60 seconds so page loads do
  // not stampede the vendors, then compute:
  //   healthy = every *_landed AND every verdict boolean
  // and include all six booleans in the response so the front end and the
  // events table can tell "probe never ran" apart from "probe said no".

  // Until those probes exist, this endpoint tells the truth:
  const body = {
    healthy: false,
    reason: 'no demo line provisioned yet',
    checked: new Date().toISOString(),
  };

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(body),
  };
};
