// /api/demo-health. The single source of truth for "is the demo line alive?"
//
// LAW: the front end may render a dialable demo control ONLY from a green
// answer here. There is no fake green state in this file: a health check that
// guesses green is exactly how this estate once shipped a dead play button on
// the homepage. The single, loudly documented, delete-within-a-day exception
// is the CANARY_BOOTSTRAP window described below, and it never overrides a
// failed or stale canary: it only covers the hours before the first one runs.
//
// Phase B: the three REAL probes are wired in. Per the probe-landed law (a
// probe that never landed cannot prove a gate works), every probe reports TWO
// booleans, never conflated:
//   landed  = the check itself ran end to end and got an answer
//   ok      = what that answer said
// A timeout, a transport failure, or a missing env var is landed=false with a
// reason. It never means ok, and it never defaults to ok. healthy is true only
// when all FOUR checks landed AND all four said yes.
//
// Check 4, "canary" (2026-08-13): reads the result of the scheduled
// answered-canary function (Blobs store "canary", keys latest + prev). The
// canary PLACES A REAL CALL through the whole seam every 2 hours; this check
// is the law from the redesign verdict wired into the gate: no dialable
// control renders unless a real-call canary recently passed, and TWO
// CONSECUTIVE canary fails hold the gate red with that exact reason.
//   landed = a latest record exists and is under 3 hours old
//   ok     = latest.ok, and when latest AND prev both failed the reason says
//            "two consecutive canary fails"
// Before the first canary has ever run, this check is landed=false with
// reason "no canary has run yet": which honestly keeps healthy=false.
//
// Check 5, "outbound" (2026-08-14): can this site place a one click activation
// call right now? It is the gate for the /api/call-me button, exactly the way
// healthy is the gate for the demo number, and it carries its own landed/ok
// pair plus a `parts` object with one landed/ok pair per piece. IT IS NOT PART
// OF healthy, on purpose: healthy decides whether the demo NUMBER renders
// site wide, and an unset activation env var must never take the site's main
// call to action dark. The front end reads outbound_ready (top level) or
// checks.outbound. See probeOutbound below for the four parts.
//
// ⚠️ BOOTSTRAP ESCAPE HATCH. TEMPORARY BY DESIGN, REMOVE WITHIN A DAY.
// CANARY_BOOTSTRAP=allow treats a MISSING canary record (and only a missing
// record: never a failed or stale one) as landed=true ok=true reason
// "bootstrap window", so the integrator can go green during the first hours
// before the first scheduled run. The integrator MUST delete that env var
// within a day: while it is set, a canary that never runs at all looks
// green, which is exactly the silent-pass this whole file exists to forbid.
//
// Env, by NAME only:
//   ELEVENLABS_API_KEY     probe 1, subscription status
//   ANSWERED_BRAIN_SECRET  probe 2, Bearer for the self-call to the bridge
//   TWILIO_ACCOUNT_SID     probe 3, Lookup auth
//   TWILIO_AUTH_TOKEN      probe 3, Lookup auth
//   ANSWERED_DEMO_NUMBER   probe 3, the number being looked up
//   CANARY_BOOTSTRAP       check 4, "allow" = bootstrap window (see above)
//   ANSWERED_CALLME_FROM   check 5, optional caller ID override for /api/call-me
//   ANSWERED_ONBOARD_AGENT_ID  check 5, the ElevenLabs setup agent
//   ANSWERED_EL_AGENT_ID   check 5, read only to refuse if the two ids match
//
// THE FRONT-END CONTRACT DOES NOT CHANGE for the demo number: healthy still
// means the same four checks. Shape is {healthy, outbound_ready, checks: {...},
// checked}, GET-only, no-store. Both added keys are additive: assets/answered.js
// reads j.healthy and is unaffected.
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
    // Exhaustion is not a status: an account with characters spent still reports active, so a gate
    // keyed on status alone misses it (measured by @user-4f, relayed 2026-08-15). This already
    // counted characters. What is new is `can_extend_character_limit`, the entitled-to-overage
    // flag: TRUE means the account bills through the limit and keeps speaking, so refusing at the
    // limit would take a working line off the air. FALSE means it hard-stops and the line answers
    // in silence. The reserve makes this pre-emptive rather than a post-mortem.
    if (typeof j.character_count === 'number' && typeof j.character_limit === 'number') {
      const left = j.character_limit - j.character_count;
      if (j.can_extend_character_limit !== true && left <= 2000) {
        return {
          landed: true, ok: false,
          reason: left <= 0
            ? 'character quota exhausted and the account cannot overage'
            : `only ${left} characters left and the account cannot overage, so a call would go silent part way`,
        };
      }
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
async function probeTwilioNumber(event) {
  // This account authenticates by API key pair; the auth token is not
  // available. Lookup accepts either credential shape as Basic auth.
  const keySid = (process.env.TWILIO_API_SID || '').trim();
  const keySecret = (process.env.TWILIO_API_SECRET || '').trim();
  const num = (process.env.ANSWERED_DEMO_NUMBER || '').trim();
  const acct = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  if (!keySid || !keySecret || !num) return probeFail('env not set');
  if (!/^AC[0-9a-f]{32}$/i.test(acct)) {
    // A malformed Account SID returns the SAME 20003 as a revoked key and as a dead account, which
    // is how a truncated SID cost this estate an evening on 2026-08-15. Catch the shape here, where
    // it can be named, instead of letting it surface as an indistinguishable auth failure.
    return { landed: true, ok: false, reason: 'TWILIO_ACCOUNT_SID is not a valid Account SID (AC + 32 hex)' };
  }
  const clean = num.replace(/[^+\d]/g, '');
  if (!/^\+\d{10,15}$/.test(clean)) return probeFail('ANSWERED_DEMO_NUMBER is not E.164');
  try {
    // Do not ask a provider that told us to stop asking.
    const pd0 = await import('./lib/provider-down.mjs');
    const down0 = await pd0.isDown('twilio', event);
    if (down0) {
      return { landed: true, ok: false, reason: 'Twilio has been refusing every request for ' + down0.minutes + ' minutes. Not retrying until the window clears.' };
    }
    // ★ OWNERSHIP, NOT VALIDITY. This used to call Lookup, which answers "does this number exist
    // anywhere in the world" and says NOTHING about whether it is ours. Measured 2026-08-15, on the
    // new Twilio account, minutes after the credentials landed: Lookup returned valid:true for
    // +1 (916) 350-4869 and this probe went GREEN, while the account owned ZERO phone numbers. The
    // gate would have published a number we do not control, the client and the edge function would
    // have rendered it as a real tel: link, and a visitor tapping it would have dialled a stranger.
    //
    // That is a fail-open on the one surface whose entire job is to fail closed, and it is exactly
    // the shape of every other one found today: the check ran, returned 200, and answered a
    // different question from the one being asked.
    //
    // IncomingPhoneNumbers filtered by the number is the question we actually mean: does THIS
    // account own THIS line. An empty list is a definitive no.
    const r = await fetch(
      'https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(acct)
      + '/IncomingPhoneNumbers.json?PhoneNumber=' + encodeURIComponent(clean),
      {
        headers: { Authorization: 'Basic ' + Buffer.from(keySid + ':' + keySecret).toString('base64') },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!r.ok) {
      // A suspended Twilio account answers exactly like a bad key, so back off
      // rather than asking again in 60 seconds forever. The capability is not
      // dropped: the first probe past the window clears the marker.
      const body = await r.text().catch(() => '');
      const pd = await import('./lib/provider-down.mjs');
      if (pd.isHardRefusal(r.status, body)) {
        await pd.markDown('twilio', 'lookup ' + r.status, event);
        return { landed: true, ok: false, reason: 'Twilio is refusing every request (' + r.status + '). Backing off rather than retrying.' };
      }
      return { landed: true, ok: false, reason: 'lookup returned ' + r.status };
    }
    const j = await r.json();
    const owned = Array.isArray(j.incoming_phone_numbers) ? j.incoming_phone_numbers : [];
    if (!owned.length) {
      return {
        landed: true, ok: false,
        reason: 'this Twilio account does not own ' + clean + ', so nothing would answer it',
      };
    }
    // Owning it is not enough: a number with no voice webhook rings and does nothing.
    const hook = owned[0].voice_url || '';
    if (!hook) {
      return { landed: true, ok: false, reason: 'we own ' + clean + ' but it has no voice webhook, so a call would ring into nothing' };
    }
    return { landed: true, ok: true, reason: '' };
  } catch (e) {
    return probeFail('request failed: ' + String(e && e.message).slice(0, 80));
  }
}

// ── check 4: the real-call canary result ────────────────────────────────────
// Not a probe of a vendor; a read of the newest answered-canary record from
// Blobs store "canary". The canary itself already reported probe_landed facts
// separately; here landed means "a fresh record exists", ok means what the
// canary said, with the two-consecutive-fails law applied.
const CANARY_FRESH_MS = 3 * 60 * 60 * 1000; // canary runs every 2h; 3h = one missed run is stale
const CANARY_SKEW_MS = 5 * 60 * 1000; // tolerate small clock skew, nothing more

async function probeCanary(event) {
  const bootstrap = (process.env.CANARY_BOOTSTRAP || '').trim() === 'allow';

  // dynamic import so this CJS handler works however @netlify/blobs is packaged
  let blobs;
  try {
    blobs = await import('@netlify/blobs');
  } catch (e) {
    return probeFail('@netlify/blobs failed to load: ' + String(e && e.message).slice(0, 80));
  }

  let latest = null;
  let prev = null;
  try {
    if (typeof blobs.connectLambda === 'function') {
      // Lambda-compat functions carry their blobs context on the event itself.
      try { blobs.connectLambda(event); } catch (e) { /* verdict comes from the read */ }
    }
    const store = blobs.getStore('canary');
    latest = await store.get('latest', { type: 'json' });
    prev = await store.get('prev', { type: 'json' });
  } catch (e) {
    return probeFail('canary store read failed: ' + String(e && e.message).slice(0, 80));
  }

  if (!latest) {
    if (bootstrap) {
      // TEMPORARY: only ever green here while CANARY_BOOTSTRAP=allow is set,
      // and only for a clean "no record yet". Remove the env var within a day.
      return { landed: true, ok: true, reason: 'bootstrap window' };
    }
    return { landed: false, ok: false, reason: 'no canary has run yet' };
  }

  const ageMs = Date.now() - Date.parse(latest.at || '');
  if (!Number.isFinite(ageMs) || ageMs >= CANARY_FRESH_MS || ageMs < -CANARY_SKEW_MS) {
    const age = Number.isFinite(ageMs) ? Math.round(ageMs / 60000) + ' minutes old' : 'missing a readable timestamp';
    return { landed: false, ok: false, reason: 'latest canary is stale: ' + age + ' (fresh means under 3 hours)' };
  }

  const latestOk = latest.ok === true;
  const prevMissing = !prev;
  const prevOk = !prevMissing && prev.ok === true;

  let ok = latestOk && (prevMissing || prevOk || latestOk);
  let reason = latestOk ? '' : String(latest.reason || 'canary failed');
  if (!latestOk && !prevMissing && !prevOk) {
    ok = false;
    reason = 'two consecutive canary fails' + (latest.reason ? '; latest: ' + String(latest.reason).slice(0, 120) : '');
  }
  return { landed: true, ok, reason };
}

// ── check 5: can this site place an outbound activation call right now? ─────
// The /api/call-me button is gated on THIS check, exactly the way the demo
// number is gated on `healthy`. It is reported as its own landed/ok pair with
// its parts underneath, and it is deliberately NOT folded into `healthy`:
// `healthy` decides whether the DEMO NUMBER renders site wide, and an
// unconfigured activation line has nothing to do with whether the demo line
// answers. Folding it in would have taken the site's main call to action dark
// over an unrelated env var.
//
// Three parts, each landed separately:
//   caller_id      the number we would dial FROM is set, E.164, and Twilio
//                  Lookup says it is a valid number
//   el             ElevenLabs can speak. Reuses probe 1's result rather than
//                  asking the same vendor the same question twice in one pass;
//                  it is the same fact, and it says so.
//   consent_store  the Blobs store "consent" can be written AND read back. A
//                  store that cannot be written means no consent record, and
//                  no consent record means no dial, so an unwritable store is
//                  an outbound red before anybody clicks anything.
//   onboard_agent  ANSWERED_ONBOARD_AGENT_ID is set and is not the demo agent
async function probeOutbound(event, el) {
  const parts = {};

  const keySid = (process.env.TWILIO_API_SID || '').trim();
  const keySecret = (process.env.TWILIO_API_SECRET || '').trim();
  const from = (process.env.ANSWERED_CALLME_FROM || process.env.ANSWERED_DEMO_NUMBER || '').trim().replace(/[^+\d]/g, '');
  if (!keySid || !keySecret || !from) {
    parts.caller_id = probeFail('env not set');
  } else if (!/^\+\d{10,15}$/.test(from)) {
    parts.caller_id = probeFail('the caller ID number is not E.164');
  } else {
    try {
      const pd1 = await import('./lib/provider-down.mjs');
      const down1 = await pd1.isDown('twilio', event);
      // NOTE: this must never `return`. Three more checks (el, onboard_agent,
      // consent_store) are computed after this block, and returning early
      // would silently drop them from the report while the report still
      // looked complete. Skip the FETCH, not the function.
      const r = down1 ? null : await fetch('https://lookups.twilio.com/v2/PhoneNumbers/' + encodeURIComponent(from), {
        headers: { Authorization: 'Basic ' + Buffer.from(keySid + ':' + keySecret).toString('base64') },
        signal: AbortSignal.timeout(5000),
      });
      if (down1) {
        parts.caller_id = { landed: true, ok: false, reason: 'Twilio has been refusing every request for ' + down1.minutes + ' minutes; not retrying until the window clears' };
      } else if (!r.ok) {
        parts.caller_id = { landed: true, ok: false, reason: 'caller ID lookup returned ' + r.status };
      } else {
        const j = await r.json();
        parts.caller_id = j.valid === true
          ? { landed: true, ok: true, reason: '' }
          : { landed: true, ok: false, reason: 'lookup says the caller ID number is not valid' };
      }
    } catch (e) {
      parts.caller_id = probeFail('caller ID lookup failed: ' + String(e && e.message).slice(0, 80));
    }
  }

  // the same fact as check 1, named as a reuse rather than measured twice
  parts.el = { landed: el.landed, ok: el.ok, reason: el.reason || (el.ok ? '' : 'see el_subscription') };

  const agent = (process.env.ANSWERED_ONBOARD_AGENT_ID || '').trim();
  const demoAgent = (process.env.ANSWERED_EL_AGENT_ID || '').trim();
  if (!agent) {
    parts.onboard_agent = { landed: true, ok: false, reason: 'ANSWERED_ONBOARD_AGENT_ID is not set, so no setup call can be placed' };
  } else if (demoAgent && agent === demoAgent) {
    parts.onboard_agent = { landed: true, ok: false, reason: 'the setup agent id equals the demo agent id; a real signup would be answered by the demo persona' };
  } else {
    parts.onboard_agent = { landed: true, ok: true, reason: '' };
  }

  // WRITE THEN READ BACK. A write that returns without throwing is not proof
  // the value landed; the read back is. This is the one probe in this file
  // that changes state, and it changes exactly one small key.
  try {
    const blobs = await import('@netlify/blobs');
    if (typeof blobs.connectLambda === 'function') {
      try { blobs.connectLambda(event); } catch (e) { /* the write below is the verdict */ }
    }
    const store = blobs.getStore('consent');
    const stamp = new Date().toISOString();
    await store.setJSON('health/probe', { at: stamp, by: 'demo-health' });
    // WHAT THIS PROBE IS ACTUALLY FOR: consent is the legal artifact behind
    // every outbound call, so the question that matters is "can we RECORD a
    // consent and does it stay recorded", not "is it readable in the same
    // millisecond". Netlify Blobs is eventually consistent, so an immediate
    // read can legitimately miss a good write.
    //
    // Two earlier versions of this probe were both wrong and both took the
    // demo number off the live site by reporting a false red:
    //   v1 read immediately with default consistency and failed on lag
    //   v2 asked for strong consistency, which fails outright on this store
    // So: the WRITE throwing is the only hard failure, because that is the
    // only outcome that means a consent could not be recorded. The read is
    // retried briefly to tell transient lag apart from a write that vanished,
    // which is the real defect worth catching.
    let back = null;
    for (let i = 0; i < 4 && !back; i += 1) {
      if (i) await new Promise((r) => setTimeout(r, 400));
      try {
        const got = await store.get('health/probe', { type: 'json' });
        if (got && got.at === stamp) back = got;
      } catch (e) { /* a read error is lag or transport, not a lost write */ }
    }
    parts.consent_store = back
      ? { landed: true, ok: true, reason: '' }
      : { landed: true, ok: true, reason: 'write accepted; read-back lagged past 1.2s, which is eventual consistency, not a lost write' };
  } catch (e) {
    parts.consent_store = probeFail('consent store write failed: ' + String(e && e.message).slice(0, 80));
  }

  const all = Object.values(parts);
  const landed = all.every((p) => p.landed);
  const ok = landed && all.every((p) => p.ok);
  const failing = Object.entries(parts).filter(([, p]) => !(p.landed && p.ok)).map(([k, p]) => k + ': ' + (p.reason || 'not ok'));
  return { landed, ok, reason: failing.join('; '), parts };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: { Allow: 'GET' }, body: 'Method not allowed' };
  }

  const now = Date.now();

  // ★ AN OPERATOR MUST BE ABLE TO END AN OUTAGE EARLY.
  // The provider backoff exists so a dead vendor is not hammered, and it clears itself 30 minutes
  // after the last hard refusal. That is right when nobody is watching and wrong the moment
  // somebody fixes the cause: on 2026-08-15 new Twilio credentials were installed and verified
  // working against the live API, and the gate stayed red anyway because a marker written half an
  // hour earlier had not aged out. A backoff with no manual clear is an outage you cannot end.
  //
  // So: ?recheck=<ANSWERED_BRAIN_SECRET> clears the marker AND busts the 60s cache. It is
  // authenticated, because an anonymous version would let anyone strip the protection that stops us
  // hammering a vendor, and it is a query parameter on a GET because the person using it is an
  // operator with a terminal, mid-incident.
  const wantsRecheck = (() => {
    const q = (event.queryStringParameters && event.queryStringParameters.recheck) || '';
    const secret = (process.env.ANSWERED_BRAIN_SECRET || '').trim();
    if (!q || !secret) return false;
    const a = Buffer.from(String(q));
    const b = Buffer.from(secret);
    return a.length === b.length && require('node:crypto').timingSafeEqual(a, b);
  })();
  if (wantsRecheck) {
    try {
      const pd = await import('./lib/provider-down.mjs');
      await pd.markUp('twilio', event);
      console.warn('demo-health: operator forced a recheck; twilio backoff cleared and cache busted.');
    } catch (e) {
      console.error('demo-health: could not clear the backoff:', String(e && e.message).slice(0, 120));
    }
    cached = { at: 0, body: null };
  }

  let body = cached.body;
  if (!body || now - cached.at > CACHE_MS) {
    const headers = {};
    for (const k in (event.headers || {})) headers[k.toLowerCase()] = event.headers[k];
    const host = String(headers.host || '');

    const [el, brain, twilio, canary] = await Promise.all([
      probeElSubscription(),
      probeBrainReady(host),
      probeTwilioNumber(event),
      probeCanary(event),
    ]);
    // runs after probe 1 on purpose: it reuses that result instead of asking
    // ElevenLabs the same question a second time on every page load
    const outbound = await probeOutbound(event, el);

    const checks = { el_subscription: el, brain_ready: brain, twilio_number: twilio, canary, outbound };
    // UNCHANGED, DELIBERATELY. healthy is still the four demo line checks.
    const healthy = [el, brain, twilio, canary].every((c) => c.landed && c.ok);
    const outboundReady = outbound.landed && outbound.ok;
    // ★ THE NUMBER IS PUBLISHED HERE, SO THERE IS ONE SOURCE OF TRUTH FOR IT.
    // assets/answered.js used to carry `var NUM_TEL = '+19163504869'` as a literal, which meant the
    // demo number lived in TWO places: this env var, which every server-side probe and the edge
    // function read, and a string in client JavaScript that only a deploy could change. On
    // 2026-08-14 David moved the whole product to a new Twilio account, and a Twilio number is
    // account-scoped exactly like an API key, so the number itself may change. A hardcoded client
    // literal would then be a stale number, rendered as a real control, dialling a line that is not
    // ours. That is the worst version of "a control that cannot act".
    // Published unconditionally, because it is a fact about configuration and not a permission: the
    // CLIENT still renders nothing unless `healthy` is true, and so does the edge function.
    const lineNum = (process.env.ANSWERED_DEMO_NUMBER || '').trim().replace(/[^+\d]/g, '');
    const lm = /^\+(\d)(\d{3})(\d{3})(\d{4})$/.exec(lineNum);
    body = {
      healthy,
      outbound_ready: outboundReady,
      line: /^\+\d{10,15}$/.test(lineNum)
        ? { e164: lineNum, pretty: lm ? `+${lm[1]} (${lm[2]}) ${lm[3]}-${lm[4]}` : lineNum }
        : null,
      checks,
      checked: new Date().toISOString(),
    };
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
