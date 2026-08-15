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

const TRUSTHUB  = 'https://trusthub.twilio.com/v1';
const MESSAGING = 'https://messaging.twilio.com/v1';

// The objects, measured and named rather than discovered at runtime. If any of these change, this
// function should fail loudly rather than guess at a replacement.
const PROFILE_SID   = 'BUdfa2eea2aed28550d50914a56db86f26';  // TwinFlame secondary customer profile
const BUNDLE_SID    = 'BUb311e948fd48ce790250e72fd5452e5f';  // TwinFlame Standard A2P bundle v2
const A2P_POLICY    = 'RNb0d4771c2c98518d916a3d4cd70a8f8b';  // A2P Messaging: Local - Business
const BRAND_SID     = 'BN24a7a4a0cc7d6e56dba14c5a1606ec64';  // TwinFlame Standard brand, tcr BP01ODH
const SERVICE_SID   = 'MGab661e1277775dfa0cbe1851b039c3f5';  // "Answered customer communication"

// ── THE CAMPAIGN, WORD FOR WORD ──────────────────────────────────────────────────────────────
// Every string below is copied verbatim from research/a2p-campaign-evidence.md, which was written
// against live production and checked claim by claim. It is encoded here rather than composed at
// runtime because a campaign is filed once and judged on its exact words, and because three earlier
// filings were rejected for a number mismatch between the copy and the registration.
//
// ★ DO NOT EDIT THESE STRINGS WITHOUT EDITING THE EVIDENCE DOC IN THE SAME COMMIT. A reviewer who
// finds the hosted page saying something different from the filing rejects the filing, and the
// rejection reason will name neither file.
const CAMPAIGN = {
  // ★ THE POLICY URLS ARE STATED LITERALLY, IN BOTH FIELDS, ON PURPOSE.
  // The first filing (QE2c6890da8086d771620e9b13fadeba0b) was rejected 30908 "a compliant privacy
  // policy can not be verified" and 30882 "Terms and Conditions issues". Neither is a field on this
  // API, so the reviewer graded the website registered on the brand, which is
  // https://futureful.app/ — a workforce-development site with, measured, ZERO privacy or terms
  // links anywhere on it. That URL is frozen: the customer profile bundle is immutable (70002) and
  // a brand can only be edited while FAILED (21725).
  // The program's real policies are at answered.reddenda.com and both were measured to contain
  // every element the two error codes test for. So the URLs are written into the only fields a
  // reviewer will actually read, rather than left to be inferred from a site that does not have them.
  description:
    'Customer communication. Every message is the direct, requested consequence of something the '
    + 'recipient did: a call they placed, a job they booked, or an invoice they discussed on a '
    + 'recorded call. The program sends confirmations, transcripts, receipts and agreed follow-ups '
    + 'to people who asked for them. There is no promotional traffic, no newsletter, no drip '
    + 'sequence and no list. '
    + 'Privacy policy: https://answered.reddenda.com/privacy . '
    + 'Terms and conditions for this texting program: https://answered.reddenda.com/terms#texting . '
    + 'Both are publicly reachable with no login. The privacy policy states that the mobile number '
    + 'and the fact of opting in are never shared with anyone and never sold, to third parties, '
    + 'affiliates, or for marketing.',

  messageFlow:
    'A person opts in one of two ways, both of which require an action from them. On the website: '
    + 'at https://answered.reddenda.com/pricing they type their mobile number into the contact '
    + 'form. Directly beside that field, before they submit, the page prints: "Adding your number '
    + 'opts you into Answered texts from (916) 282-5278: the transcript, booking link, or receipt '
    + 'you asked for. Fewer than five a month, and it varies by what you ask for. Message and data '
    + 'rates may apply. Reply STOP to stop, HELP for help." with links to the Terms and Privacy '
    + 'pages, which are https://answered.reddenda.com/terms#texting and '
    + 'https://answered.reddenda.com/privacy . The page is publicly reachable with no login and no '
    + 'paywall. On a call they placed to '
    + 'us: the caller asks for the transcript, the booking link or the receipt to be texted to '
    + 'them, and the request is recorded on the call. There is no third way in. We never add a '
    + 'number ourselves, we never buy or import a list, and consent is never transferred between '
    + 'numbers or programs.',

  samples: [
    'Answered here. You are booked with {Business} for {Day} between {Window}. Address {Address}. '
      + 'Reply STOP to stop these texts, HELP for help.',
    'Answered: your line took a call from {Caller} at {Time}. {Outcome}. Full transcript: {Link}. '
      + 'Reply STOP to stop these texts, HELP for help.',
    'Answered: {Outcome} on {Date}, {Amount}. The recording and the line-by-line reason are on your '
      + 'statement: {Link}. Reply STOP to stop these texts, HELP for help.',
    '{Business} here via Answered, following up on invoice {Ref} for {Amount} as agreed on our '
      + 'call. Pay or dispute: {Link}. Reply STOP to stop these texts, HELP for help.',
  ],

  // Measured against the samples above rather than asserted: three of the four carry a {Link}, and
  // none of them carries a phone number. Getting either of these wrong is its own rejection.
  hasEmbeddedLinks: true,
  hasEmbeddedPhone: false,

  optInKeywords: ['START', 'YES', 'UNSTOP'],
  optInMessage:
    'Answered: you are subscribed. You will get the transcript, booking link or receipt you asked '
    + 'for, fewer than five a month. Message and data rates may apply. Reply STOP to stop, HELP for help.',
  optOutKeywords: ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'],
  optOutMessage:
    'Answered: you are unsubscribed and will get no further texts from this number. Reply START to '
    + 'resume.',
  helpKeywords: ['HELP', 'INFO'],
  helpMessage:
    'Answered: we text you the transcript, booking link or receipt you asked for. Help: '
    + 'help@reddenda.com. Reply STOP to stop. Message and data rates may apply.',
};

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

// The brand and the campaign live on messaging.twilio.com, not trusthub. Same credentials, and a
// deliberately separate pair of helpers so a path can never be sent to the wrong host and read as
// a 404 that looks like "the object does not exist".
async function mget(path) {
  const r = await fetch(`${MESSAGING}${path}`, { headers: { Authorization: auth() }, signal: AbortSignal.timeout(10_000) });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, body };
}

async function mpost(path, params) {
  // URLSearchParams repeats a key for each array element, which is exactly the wire format Twilio
  // wants for MessageSamples and the keyword lists.
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const item of v) form.append(k, item);
    else form.append(k, String(v));
  }
  const r = await fetch(`${MESSAGING}${path}`, {
    method: 'POST',
    headers: { Authorization: auth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(20_000),
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

/**
 * Link three of the chain: brand, then campaign.
 *
 * ★ WHY THE USE CASE IS LOOKED UP AND NOT HARDCODED. Twilio returns the set of use cases this
 * specific brand is allowed to file under, and that set depends on the brand's own vetting result.
 * Hardcoding CUSTOMER_CARE would ship a value that is correct today and silently wrong if the brand
 * comes back at a tier that does not carry it, which is the failure mode where a name in a list
 * stops matching the thing the list is supposed to describe. If the use case we need is not in the
 * returned set, this stops and says so rather than substituting a near-enough one: filing under the
 * wrong use case is a rejection, and a rejected campaign costs the vetting fee again.
 */
async function advanceBrandAndCampaign(out) {
  // Has a campaign already been filed? Ask first, because filing a second one is not free and this
  // function runs every fifteen minutes forever.
  const existing = await mget(`/Services/${SERVICE_SID}/Compliance/Usa2p`);
  if (existing.ok && (existing.body.compliance || []).length > 0) {
    const c = existing.body.compliance[0];
    out.action = 'campaign_exists';
    out.campaign = { sid: c.sid, status: c.campaign_status, usecase: c.us_app_to_person_usecase };
    if (c.campaign_status && c.campaign_status !== 'VERIFIED' && c.campaign_status !== 'APPROVED') {
      console.log(`a2p-advance: campaign ${c.sid} is ${c.campaign_status}.`);
    }
    return Response.json({ ok: true, ...out });
  }

  const brand = await mget(`/a2p/BrandRegistrations/${BRAND_SID}`);
  if (!brand.ok) {
    console.error('a2p-advance: could not read the brand registration:', brand.status);
    return Response.json({ ok: false, reason: 'brand_read_failed', status: brand.status, ...out });
  }
  out.brand = { status: brand.body.status, identity: brand.body.identity_status, tcr: brand.body.tcr_id };

  if (brand.body.status === 'FAILED') {
    // Loud, always. A failed brand is the one state nobody should learn about late.
    console.error('a2p-advance: ★ THE BRAND REGISTRATION FAILED. reason='
      + (brand.body.failure_reason || 'none given')
      + ' errors=' + JSON.stringify(brand.body.errors || []).slice(0, 400));
    out.action = 'brand_failed';
    return Response.json({ ok: true, ...out });
  }

  if (brand.body.status !== 'APPROVED') {
    // Quiet. PENDING is the normal state for hours and logging it every run is how a log becomes
    // something people stop reading.
    out.action = 'awaiting_brand';
    return Response.json({ ok: true, ...out });
  }

  // Brand is approved. Which use cases may it actually file under?
  const uc = await mget(`/Services/${SERVICE_SID}/Compliance/Usa2p/Usecases?BrandRegistrationSid=${BRAND_SID}`);
  if (!uc.ok) {
    console.error('a2p-advance: brand is APPROVED but the use case list could not be read:', uc.status,
      JSON.stringify(uc.body).slice(0, 200));
    out.action = 'usecase_read_failed';
    return Response.json({ ok: false, ...out });
  }
  const codes = (uc.body.us_app_to_person_usecases || []).map((u) => u.code);
  out.usecases = codes;
  if (!codes.includes('CUSTOMER_CARE')) {
    console.error('a2p-advance: CUSTOMER_CARE is not among the use cases this brand may file under, '
      + `so nothing was filed. Available: ${codes.join(', ') || '(none returned)'}. This needs a human: `
      + 'the campaign copy describes customer communication and must not be filed under a different use case.');
    out.action = 'usecase_unavailable';
    return Response.json({ ok: true, ...out });
  }

  const filed = await mpost(`/Services/${SERVICE_SID}/Compliance/Usa2p`, {
    BrandRegistrationSid: BRAND_SID,
    Description: CAMPAIGN.description,
    MessageFlow: CAMPAIGN.messageFlow,
    MessageSamples: CAMPAIGN.samples,
    UsAppToPersonUsecase: 'CUSTOMER_CARE',
    HasEmbeddedLinks: CAMPAIGN.hasEmbeddedLinks,
    HasEmbeddedPhone: CAMPAIGN.hasEmbeddedPhone,
    SubscriberOptIn: true,
    AgeGated: false,
    DirectLending: false,
    OptInKeywords: CAMPAIGN.optInKeywords,
    OptInMessage: CAMPAIGN.optInMessage,
    OptOutKeywords: CAMPAIGN.optOutKeywords,
    OptOutMessage: CAMPAIGN.optOutMessage,
    HelpKeywords: CAMPAIGN.helpKeywords,
    HelpMessage: CAMPAIGN.helpMessage,
  });

  if (!filed.ok) {
    console.error('a2p-advance: the brand is APPROVED but filing the campaign failed:', filed.status,
      JSON.stringify(filed.body).slice(0, 400));
    out.action = 'campaign_file_failed';
    out.error = filed.body;
    return Response.json({ ok: false, ...out });
  }

  out.action = 'campaign_filed';
  out.campaign = { sid: filed.body.sid, status: filed.body.campaign_status };
  console.log('a2p-advance: ★ CAMPAIGN FILED. '
    + `${filed.body.sid} is ${filed.body.campaign_status} under brand ${BRAND_SID} (tcr ${out.brand.tcr}). `
    + 'Texting is one carrier approval away.');
  return Response.json({ ok: true, ...out });
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

  // The bundle is moving or done, so the next link in the chain is the brand and then the campaign.
  // This used to return here, which meant the chain stopped at the bundle and a human had to notice
  // the brand had approved and file the campaign by hand.
  if (bundle.body.status !== 'draft') {
    return advanceBrandAndCampaign(out);
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
