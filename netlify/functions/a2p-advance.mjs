// a2p-advance — moves the TwinFlame A2P registration forward the moment Twilio lets it, so that
// nobody has to sit and poll a console.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
//
// The registration is a chain, and each link unlocks only when a Twilio reviewer moves the one
// before it. Measured 2026-08-15:
//
//   TwinFlame secondary customer profile   pending-review   <- a human at Twilio has not picked it up
//   TwinFlame Standard A2P bundle          draft            <- cannot advance until the profile does
//
// The bundle's own evaluation names the reason exactly: "The status of the Secondary Customer
// Profile must be in atleast review state." `pending-review` is BEFORE review, not in it. The
// profile itself evaluates COMPLIANT with zero failing requirements, so there is nothing to correct
// and nothing anyone can do to make it go faster.
//
// What there IS to do is make sure that the instant it moves, we move, at 3am if that is when it
// happens, instead of discovering it the next morning.
//
// ── THE ONE RULE THIS FUNCTION WILL NOT BREAK ────────────────────────────────────────────────
//
// ★ IT NEVER SUBMITS A BUNDLE THAT EVALUATES NONCOMPLIANT.
//
// That is not caution, it is the specific mistake that has already cost this estate a bundle.
// Version 1 of this bundle was submitted after its own evaluation said it was noncompliant, on the
// reasoning that the fix was obvious. Twilio moved it to `twilio-rejected`, which is terminal. A
// rejected bundle cannot be repaired; it can only be rebuilt. So this evaluates first, every time,
// and a noncompliant result means it does nothing at all and says why.
//
// The evaluation is also free and non-mutating, so running it on a schedule costs nothing but a
// request, and it is the only way to know the chain has unlocked without a human looking.

const TRUSTHUB = 'https://trusthub.twilio.com/v1';

// The objects, measured and named rather than discovered at runtime. If any of these change, this
// function should fail loudly rather than guess at a replacement.
const PROFILE_SID   = 'BUdfa2eea2aed28550d50914a56db86f26';  // TwinFlame secondary customer profile
const BUNDLE_SID    = 'BUb311e948fd48ce790250e72fd5452e5f';  // TwinFlame Standard A2P bundle v2
const A2P_POLICY    = 'RNb0d4771c2c98518d916a3d4cd70a8f8b';  // A2P Messaging: Local - Business

export const config = {
  // Every fifteen minutes. A reviewer moving an object is not a fast-moving event, and a tighter
  // schedule would be polling a queue that turns over in hours.
  schedule: '*/15 * * * *',
};

const auth = () => 'Basic ' + Buffer.from(
  `${(process.env.TWILIO_API_SID || '').trim()}:${(process.env.TWILIO_API_SECRET || '').trim()}`
).toString('base64');

const configured = () =>
  Boolean((process.env.TWILIO_API_SID || '').trim() && (process.env.TWILIO_API_SECRET || '').trim());

async function get(path) {
  const r = await fetch(`${TRUSTHUB}${path}`, { headers: { Authorization: auth() }, signal: AbortSignal.timeout(10_000) });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, body };
}

async function post(path, params) {
  const r = await fetch(`${TRUSTHUB}${path}`, {
    method: 'POST',
    headers: { Authorization: auth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, body };
}

/** Every failing requirement, flattened to sentences a human can act on. */
function failures(evaluation) {
  const out = [];
  for (const req of (evaluation.results || [])) {
    if (req.passed === false) {
      out.push(req.friendly_name || req.requirement_name || 'unnamed requirement');
      for (const f of (req.fields || [])) {
        if (f.passed === false) {
          out.push('  field: ' + (f.friendly_name || f.object_field) + (f.failure_reason ? ' — ' + f.failure_reason : ''));
        }
      }
    }
  }
  return out;
}

export default async function handler() {
  if (!configured()) {
    console.error('a2p-advance: TWILIO_API_SID / TWILIO_API_SECRET are not set, so nothing can be checked.');
    return Response.json({ ok: false, reason: 'unconfigured' });
  }

  const out = { at: new Date().toISOString(), profile: null, bundle: null, action: 'none' };

  // 1. Where is the profile? This is the gate and nothing else can move ahead of it.
  const prof = await get(`/CustomerProfiles/${PROFILE_SID}`);
  if (!prof.ok) {
    console.error('a2p-advance: could not read the customer profile:', prof.status, JSON.stringify(prof.body).slice(0, 200));
    return Response.json({ ok: false, reason: 'profile_read_failed', status: prof.status });
  }
  out.profile = prof.body.status;

  // 2. Where is the bundle?
  const bundle = await get(`/TrustProducts/${BUNDLE_SID}`);
  if (!bundle.ok) {
    console.error('a2p-advance: could not read the A2P bundle:', bundle.status);
    return Response.json({ ok: false, reason: 'bundle_read_failed', status: bundle.status });
  }
  out.bundle = bundle.body.status;

  // Already moving or already done. Nothing to do, and saying so on every run would be noise.
  if (bundle.body.status !== 'draft') {
    out.action = 'nothing_to_do';
    if (bundle.body.status === 'twilio-approved') {
      console.log('a2p-advance: the TwinFlame A2P bundle is APPROVED. The brand can be filed against it.');
    }
    return Response.json({ ok: true, ...out });
  }

  // 3. ★ EVALUATE BEFORE ANYTHING ELSE. Free, non-mutating, and the only thing standing between us
  //    and repeating the submission that permanently burned version 1 of this bundle.
  const ev = await post(`/TrustProducts/${BUNDLE_SID}/Evaluations`, { PolicySid: A2P_POLICY });
  if (!ev.ok) {
    console.error('a2p-advance: evaluation call failed:', ev.status, JSON.stringify(ev.body).slice(0, 200));
    return Response.json({ ok: false, reason: 'evaluation_failed', status: ev.status, ...out });
  }
  out.evaluation = ev.body.status;

  if (ev.body.status !== 'compliant') {
    const why = failures(ev.body);
    out.action = 'held';
    out.failures = why;
    // Quiet on the expected reason, loud on an unexpected one. The known blocker is the profile not
    // yet being in review, and logging that every fifteen minutes would train everyone to ignore
    // this function. Anything else is news.
    const expected = why.some((w) => /Secondary Customer Profile/i.test(w));
    if (expected) {
      console.log(`a2p-advance: holding. Profile is ${out.profile}; the bundle needs it in at least review state. Nothing to fix.`);
    } else {
      console.error('a2p-advance: the bundle is noncompliant for a reason that is NOT the profile gate, '
        + 'which means something needs a human: ' + why.join(' | '));
    }
    return Response.json({ ok: true, ...out });
  }

  // 4. Compliant. Submit, and say so loudly, because this is the moment somebody wants to know about.
  const sub = await post(`/TrustProducts/${BUNDLE_SID}`, { Status: 'pending-review' });
  if (!sub.ok) {
    console.error('a2p-advance: the bundle evaluated COMPLIANT but the submission failed:', sub.status,
      JSON.stringify(sub.body).slice(0, 240));
    out.action = 'submit_failed';
    return Response.json({ ok: false, ...out, status: sub.status });
  }

  out.action = 'submitted';
  out.bundle = sub.body.status;
  console.log('a2p-advance: ★ the TwinFlame A2P bundle evaluated COMPLIANT and has been SUBMITTED. '
    + `Bundle ${BUNDLE_SID} is now ${sub.body.status}. The brand can be filed once it clears.`);
  return Response.json({ ok: true, ...out });
}
