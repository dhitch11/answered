// ops-status.mjs — ONE collector, read by two surfaces.
//
// /internal/ops (the founder's daily view) and ops-watch (the scheduled alert)
// must never disagree about whether something is up. They disagree the moment
// they each measure it their own way, so they do not: both call collect() here,
// one renders it, one diffs it. If you add a check, both get it.
//
// THE RULES THIS FILE OBEYS, because every one of them was paid for somewhere
// in this estate:
//
//  1. LANDED AND OK ARE TWO BOOLEANS, NEVER ONE. "the check ran" and "the check
//     said yes" are different facts. A timeout is landed:false. It is never ok,
//     and it never quietly becomes ok.
//  2. NOTHING GUESSES GREEN. There is no default-pass anywhere below. A check
//     that cannot run reports that it could not run, and that counts as red.
//  3. SECRETS BY NAME ONLY. This file reads process.env to answer "is it set",
//     and it returns a boolean. No value, no prefix, no length, no last four,
//     no hash. Read envReport(): it cannot return a value, by construction.
//  4. AN UNREAD SECRET IS STILL A RISK. A variable set in the environment that
//     no code reads is reported, because it is exposure with no benefit.
//  5. A MONITOR THAT CANNOT ALERT MUST SAY SO. alerting.armed is a first class
//     field. An alerting system that silently cannot send is the worst object
//     in an operations stack: its silence reads as calm.

// ── what this site serves ────────────────────────────────────────────────────
// Every route, what answers it, and what a healthy answer looks like. A POST
// only endpoint answering 405 to a GET is a PASS: it proves the route is
// deployed and reachable, which is the fact a route sweep can honestly
// establish. It does not prove the endpoint works, and this file never says it
// does. That is what the canary and a real call are for.
export const ROUTES = [
  { path: '/',                     kind: 'page', what: 'The home page. Two sided, consumer by default.' },
  { path: '/trades',               kind: 'page', what: 'The contractor product page.' },
  { path: '/hold',                 kind: 'page', what: 'The consumer hold product.' },
  { path: '/recover',              kind: 'page', what: 'Late invoice recovery.' },
  { path: '/parley',               kind: 'page', what: 'Text negotiation.' },
  { path: '/setup',                kind: 'page', what: 'Customization and the confidence ladder.' },
  { path: '/pricing',              kind: 'page', what: 'All three meters, and the interest form.' },
  { path: '/trust',                kind: 'page', what: 'The guardrails page.' },
  { path: '/thanks',               kind: 'page', what: 'Where the interest form lands.' },
  { path: '/terms',                kind: 'page', what: 'Terms, including the texting rules.' },
  { path: '/privacy',              kind: 'page', what: 'Privacy.' },
  { path: '/recording',            kind: 'page', what: 'For a recorded caller.' },

  { path: '/api/demo-health',      kind: 'api', expect: [200], what: 'The site wide call gate. Everything reads this.' },
  { path: '/api/interest',         kind: 'api', expect: [405, 400, 200], what: 'The interest form handler.' },
  { path: '/api/event',            kind: 'api', expect: [405, 400, 200], what: 'The funnel collector.' },
  { path: '/api/answered-voice',   kind: 'api', expect: [405, 403, 200], what: 'The demo number Twilio webhook.' },
  { path: '/api/answered-brain',   kind: 'api', expect: [401, 405, 200], what: 'The demo line reasoning bridge. 401 to a stranger is correct.' },
  { path: '/api/call-voice',       kind: 'api', expect: [405, 403, 200], what: 'Outbound TwiML.' },
  { path: '/api/call-turn',        kind: 'api', expect: [405, 403, 200], what: 'One outbound conversational turn.' },
  { path: '/api/call-status',      kind: 'api', expect: [405, 403, 200], what: 'Outbound state changes.' },
  { path: '/api/call-transcription', kind: 'api', expect: [405, 403, 200], what: 'Live words and the stop tripwire.' },
  { path: '/api/call-recording',   kind: 'api', expect: [405, 403, 200], what: 'Stores the recording pointer.' },
  { path: '/api/recording',        kind: 'api', expect: [401, 403, 405, 400], what: 'Gated recording proxy. A stranger must not get audio.' },
  { path: '/api/truce',            kind: 'api', expect: [405, 400, 200], what: 'The text negotiation engine.' },
  // A GET must be refused: this endpoint only ever accepts a signed POST from Stripe, and a 405
  // here is the proof it deployed. It is the only thing allowed to record that money moved, so if
  // it is missing, settlements silently stop being paid for and nothing else reports it.
  { path: '/api/parley-webhook',   kind: 'api', expect: [405, 400], what: 'Stripe telling us a settlement was actually paid. The only writer of a succeeded payout.' },
  // Internal, PIN-gated server-side. A 200 here is the LOGIN FORM, never the page: the content
  // lives inside the handler and is serialized only past the PIN. Its source file is deliberately
  // git-ignored, because this repository is public and the file is competitor intelligence.
  { path: '/internal/parley',      kind: 'gate', expect: [200, 503], what: 'The negotiation board: every deal, what was said, what settled, what was paid. Anonymous callers get the PIN form.' },
  { path: '/internal/competitors', kind: 'api', expect: [200, 401, 503], what: 'Internal competitor intelligence. Anonymous callers get the PIN form and nothing else.' },
  { path: '/api/call-me',          kind: 'api', expect: [405, 400, 200], what: 'One click activation.' },

  // ── Recover: first-party invoice calls, in the creditor own name (@LANE-RECOVER) ───────────
  // The three webhook routes are POST-only and refuse a GET, so 405 is the PASS here and it is
  // what proves they are deployed. /api/recover answers a GET with its own configuration, which
  // is how an operator sees whether the runtime is switched on without touching an invoice.
  { path: '/api/recover',          kind: 'api', expect: [200, 405, 401], what: 'Recover: the invoice, the call, the promise, the meter.' },
  { path: '/api/recover/twiml',    kind: 'api', expect: [405, 403], what: 'What a debtor hears when they pick up. Capability token only.' },
  { path: '/api/recover/turn',     kind: 'api', expect: [405, 403], what: 'One turn of a Recover call. Stop is checked here first, always.' },
  { path: '/api/recover/status',   kind: 'api', expect: [405, 403], what: 'How a Recover call ended.' },

  // ── accounts, booking and money. Added 2026-08-14 as those lanes landed. ──
  // Every one of these is POST only and answers 405 to the GET this sweep
  // makes, which was checked in the source before it was added here. Nothing in
  // this list can be probed into doing something.
  { path: '/account',              kind: 'page', expect: [200, 302, 401], what: 'The customer console.' },
  { path: '/account/enter',        kind: 'page', expect: [200, 302, 401, 405], what: 'Customer sign in.' },
  { path: '/api/account/start',    kind: 'api', expect: [405, 400, 200], what: 'Signup.' },
  { path: '/api/account/save',     kind: 'api', expect: [405, 400, 401, 200], what: 'Saves a customerrule set.' },
  { path: '/api/account/request-line', kind: 'api', expect: [405, 400, 401, 200], what: 'A customer asking for their own number.' },
  { path: '/api/account-voice',    kind: 'api', expect: [405, 403, 200], what: 'The voice webhook for a customer line.' },
  { path: '/api/booking',          kind: 'api', expect: [405, 400, 200], what: 'A booked job, which is the billable event.' },
  { path: '/api/billing',          kind: 'api', expect: [405, 400, 401, 200], what: 'Billing.' },
  { path: '/api/billing/webhook',  kind: 'api', expect: [405, 400, 401, 200], what: 'The payment processor webhook.' },
  { path: '/api/meter',            kind: 'api', expect: [405, 400, 401, 200], what: 'Usage metering.' },
  { path: '/api/statement',        kind: 'api', expect: [405, 400, 200], what: 'The bill, itemised.' },
  { path: '/api/recap',            kind: 'api', expect: [405, 400, 200], what: 'The after call recap.' },
  { path: '/api/el-postcall',      kind: 'api', expect: [405, 403, 200], what: 'The ElevenLabs post call hook.' },
  // The voice's HANDS (@LANE-VOICE / booking). Not my routes: I added them to unblock _stage.sh's
  // drift check, which was failing the whole staging run for everybody. A GET is 405 by design
  // because the method check runs before the bearer check. Owner: tighten or relabel freely.
  { path: '/api/answered-tool',    kind: 'api', expect: [405, 401], what: 'The tool endpoint the voice calls to book a job.' },
  { path: '/api/answered-tool/book_job', kind: 'api', expect: [405, 401], what: 'The booking tool, addressed by path the way ElevenLabs sends it.' },
  // Hold's test line (@LANE-HOLD). Also not mine: added so the drift check stops failing the
  // staging run for every lane. It is a Twilio webhook, so a GET is 405 or 403. Owner: relabel freely.
  { path: '/api/hold/testline',    kind: 'api', expect: [405, 403], what: 'The Hold test line webhook.' },
  // HOLD's two Twilio webhooks (@LANE-HOLD). NOT my routes, and I have not read a line of their
  // logic. They are here because _stage.sh's drift check refuses to stage ANY lane's work while a
  // declared path is unmonitored, so an unlisted route from one lane blocks the whole estate. Both
  // sit behind lib/twilio-webhook's gate, which answers 405 to a GET and 403 to a bad signature,
  // exactly like /api/answered-voice above. Owner: tighten, relabel or take these over freely.
  { path: '/api/hold/hear',        kind: 'api', expect: [405, 403, 200], what: 'Twilio hands back what it heard on a held call.' },
  { path: '/api/hold/status',      kind: 'api', expect: [405, 403, 200], what: 'Call state changes on a held call.' },
  { path: '/api/agent-config',     kind: 'api', expect: [405, 400, 401, 200], what: 'Per customer agent configuration.' },

  // ── notifications and the calendar feed (@LANE-NOTIFY, 2026-08-14) ──
  // /api/notify answers a GET 200 to a STRANGER on purpose: the public half is the model, which
  // belongs to nobody, so a page can explain how this works before anybody signs in. It carries no
  // account data without a session, and the sweep reading 200 here is the correct pass, not a leak.
  // /api/notify/send is POST only behind lib/bearer, so 405 to this GET is what proves it deployed.
  // The feed itself is /api/calendar/* and cannot be swept: probing it needs a real signed token,
  // and a made up one would be a fabricated test.
  { path: '/api/notify',           kind: 'api', expect: [200, 405, 503], what: 'What we tell you and how you want to hear it. Public to read, session to change.' },
  { path: '/api/notify/send',      kind: 'api', expect: [405, 401, 503], what: 'Telling one customer one thing, over every channel they asked for that can deliver.' },
  { path: '/account/signout',      kind: 'page', expect: [200, 302, 303, 405], what: 'Customer sign out. Harmless to probe with no cookie.' },
  { path: '/api/call-me/twiml',    kind: 'api', expect: [405, 403, 200], what: 'What Twilio asks for when a person picks up an activation call.' },
  { path: '/api/call-me/status',   kind: 'api', expect: [405, 403, 200], what: 'Activation call state changes.' },

  // DECLARED, DELIBERATELY NOT PROBED. A sweep must never be able to cause the
  // thing it is watching. This route runs a real synchronisation into the call
  // spine on a bare GET, so probing it every ten minutes would make the monitor
  // a participant. Its health is covered by its own schedule and its own logs.
  { path: '/api/consent-sync',     kind: 'api', probe: false,
    what: 'Mirrors one click consent into the call spine. Runs on its own schedule; a GET would execute it, so the sweep leaves it alone.' },

  { path: '/internal',             kind: 'gate', expect: [200, 503], what: 'The site directory. Must serve the PIN form and nothing else.' },
  { path: '/internal/cockpit',     kind: 'gate', expect: [200, 503], what: 'The call console. Must serve the PIN form and nothing else.' },
  { path: '/internal/accounts',    kind: 'gate', expect: [200, 503], what: 'The accounts admin. Must serve the PIN form and nothing else.' },
  // The watch checks the operating view too. A monitor that never checks itself
  // is one more thing that can die quietly. /internal/ops skips this row when it
  // sweeps, because a page probing itself is a loop, not a measurement.
  { path: '/internal/ops',         kind: 'gate', expect: [200, 503], what: 'This operating view. Must serve the PIN form and nothing else.' },
];

// A gate is only doing its job if the anonymous body is TINY. A directory page
// is tens of kilobytes; a PIN form is about two. This is the /competitors
// lesson wired into a number: the estate once shipped a "PIN gate" that served
// 303,451 bytes to any anonymous curl. Bytes are the only honest test.
export const GATE_MAX_ANON_BYTES = 6000;

// ── every environment variable this codebase reads ───────────────────────────
// readers were established by grepping process.env across netlify/functions and
// research/lib on 2026-08-14, not from memory. severity: red means something
// people can see is broken right now; amber means a capability is off; note
// means it is informational.
export const ENV_SPEC = [
  { name: 'ANSWERED_DIRECTORY_PIN', severity: 'red',
    readers: ['site-directory.js', 'lib/gate-auth.mjs'],
    unset: 'Every internal surface fails closed and serves nothing. /internal, /internal/cockpit and /internal/ops all go to 503.' },
  { name: 'ANSWERED_COCKPIT_KEY', severity: 'amber',
    readers: ['lib/gate-auth.mjs'],
    unset: 'The internal session cookie falls back to ANSWERED_BRAIN_SECRET, which is a token ElevenLabs holds and transmits on every turn. Anyone with it could mint an operator session. Set this.' },
  { name: 'ANSWERED_BRAIN_SECRET', severity: 'red',
    readers: ['answered-brain.mjs', 'answered-keepwarm.mjs', 'demo-health.js', 'site-directory.js'],
    unset: 'The demo line cannot think. The bridge refuses every turn and the health gate goes red.' },
  { name: 'ANTHROPIC_API_KEY_LIVE', severity: 'red',
    readers: ['answered-brain.mjs'],
    unset: 'The demo line has no model behind it. Callers get the honest fallback message.' },
  { name: 'ELEVENLABS_API_KEY', severity: 'red',
    readers: ['answered-voice.js', 'answered-canary.mjs', 'demo-health.js'],
    unset: 'Nothing speaks. The voice webhook serves the fallback and the canary cannot check anything.' },
  { name: 'ANSWERED_EL_AGENT_ID', severity: 'red',
    readers: ['answered-voice.js', 'answered-canary.mjs', 'demo-health.js'],
    unset: 'There is no agent to hand the call to. The demo line falls back.' },
  { name: 'ANSWERED_DEMO_NUMBER', severity: 'red',
    readers: ['answered-voice.js', 'answered-canary.mjs', 'demo-health.js', 'cockpit.mjs'],
    unset: 'The gate cannot check the demo number, so healthy is false and every call control on the site hides itself.' },
  { name: 'TWILIO_ACCOUNT_SID', severity: 'red',
    readers: ['answered-voice.js', 'answered-canary.mjs', 'lib/twilio-rest.mjs'],
    unset: 'No call can be placed and no webhook can be trusted.' },
  { name: 'TWILIO_API_SID', severity: 'red',
    readers: ['answered-canary.mjs', 'demo-health.js', 'lib/twilio-rest.mjs'],
    unset: 'No Twilio REST call works. The canary cannot dial and Lookup cannot run.' },
  { name: 'TWILIO_API_SECRET', severity: 'red',
    readers: ['answered-canary.mjs', 'demo-health.js', 'lib/twilio-rest.mjs'],
    unset: 'No Twilio REST call works. The canary cannot dial and Lookup cannot run.' },
  { name: 'CANARY_FROM_NUMBER', severity: 'red',
    readers: ['answered-canary.mjs', 'cockpit.mjs'],
    unset: 'The canary has no caller ID, so it never places its real call and the gate goes red on staleness within three hours.' },
  { name: 'RESEND_API_KEY', severity: 'red',
    readers: ['interest.js', 'ops-watch.mjs'],
    unset: 'THE INTEREST FORM CANNOT ACCEPT A SUBMISSION. Every person who fills it in is told, honestly, that we could not record it. It also means this operations watch cannot send an alert.' },
  { name: 'HUBSPOT_TOKEN', severity: 'amber',
    readers: ['interest.js'],
    unset: 'A submission still emails David, but nothing is logged to the CRM. Estate rule 6 says a send that does not log is a bug.' },
  { name: 'TWILIO_AUTH_TOKEN', severity: 'amber',
    readers: ['answered-voice.js', 'lib/twilio-webhook.mjs'],
    unset: 'Twilio webhook signatures cannot be verified with HMAC. The code degrades loudly to an AccountSid cross check and says so in the log. It is a documented posture, not a crash, but full verification is better.' },
  { name: 'ANSWERED_DB_URL', severity: 'amber',
    readers: ['lib/db.mjs', 'truce.mjs'],
    unset: 'The call spine is unreachable. The cockpit serves 503 on every operation.' },
  { name: 'ANSWERED_DB_ANON', severity: 'amber',
    readers: ['lib/db.mjs', 'truce.mjs'], unset: 'Same as above. The cockpit cannot read or write anything.' },
  { name: 'ANSWERED_DB_SECRET', severity: 'amber',
    readers: ['lib/db.mjs'], unset: 'Same as above. Every RPC throws rather than returning an empty chart you would trust.' },
  { name: 'ANSWERED_ONBOARD_AGENT_ID', severity: 'amber',
    readers: ['call-me.mjs', 'demo-health.js'],
    unset: 'outbound_ready can never go green, so the one click activation button stays hidden. There is no setup agent to answer a signup call.' },
  { name: 'ANSWERED_CALLME_FROM', severity: 'note',
    readers: ['call-me.mjs', 'demo-health.js'],
    unset: 'Activation calls fall back to the demo number as caller ID. That works. A dedicated number is cleaner.' },
  { name: 'ANSWERED_OPERATOR_NUMBER', severity: 'amber',
    readers: ['cockpit.mjs'],
    unset: 'Listen, whisper, barge and takeover have nowhere to send the operator leg. The cockpit refuses those four with a plain reason instead of dialling something random.' },
  { name: 'ANSWERED_RESEARCH_AGENT_ID', severity: 'amber',
    readers: ['call-voice.mjs'],
    unset: 'Outbound calls have no agent to hand off to.' },
  { name: 'ANSWERED_AUTOPILOT_DAILY_CAP', severity: 'note',
    readers: ['campaign-runner.mjs'], unset: 'Autopilot uses its built in default of 250 calls a day.' },
  { name: 'ANSWERED_CALLME_DAILY_CAP', severity: 'note',
    readers: ['call-me.mjs'], unset: 'Activation uses its built in default of 50 calls a day.' },
];

// The two switches that silently change what this system does. They are not
// secrets, they are posture, and posture should be visible.
export const SWITCH_SPEC = [
  { name: 'ANSWERED_AUTOPILOT_KILL', readers: ['campaign-runner.mjs'],
    on: 'Autopilot cannot dial. Nothing is placed by the campaign runner at all.',
    off: 'Autopilot will dial when a campaign is armed.',
    trap: 'Any non empty value engages it. Setting it to the string "0" still kills autopilot, because the code tests for a non empty string, not for a truthy number. If you mean to turn it off, DELETE the variable.' },
  { name: 'ANSWERED_CALLME_KILL', readers: ['call-me.mjs'],
    on: 'One click activation refuses every dial.',
    off: 'Activation will dial when someone asks it to.',
    trap: 'Any non empty value engages it, including "0". Delete it to turn it off.' },
  { name: 'CANARY_BOOTSTRAP', readers: ['demo-health.js'],
    on: 'A MISSING canary record is treated as a pass. This is the one sanctioned exception to nothing guesses green, and it is temporary by design. While it is set, a canary that never runs at all looks healthy.',
    off: 'A missing canary record keeps the gate red, which is correct.',
    trap: 'It only counts when the value is exactly "allow". It never covers a failed or stale canary, only a missing one. Delete it within a day of setting it.' },
];

// ── helpers ──────────────────────────────────────────────────────────────────
const isSet = (name) => Boolean((process.env[name] || '').trim());

async function timed(fn) {
  const t0 = Date.now();
  try { return { ...(await fn()), ms: Date.now() - t0 }; }
  catch (e) { return { landed: false, ok: false, reason: String(e && e.message).slice(0, 140), ms: Date.now() - t0 }; }
}

export function siteBase(event) {
  const fromEnv = (process.env.URL || '').replace(/\/+$/, '');
  if (fromEnv) return fromEnv;
  const h = {};
  for (const k in (event?.headers || {})) h[k.toLowerCase()] = event.headers[k];
  return h.host ? 'https://' + h.host : '';
}

// ── the environment report. By construction it cannot leak a value ───────────
// It reads process.env[name] and returns Boolean(). There is no code path here
// that puts a value into the returned object. Keep it that way.
export function envReport() {
  const known = new Set(ENV_SPEC.map((e) => e.name).concat(SWITCH_SPEC.map((s) => s.name)));
  const vars = ENV_SPEC.map((spec) => ({ ...spec, set: isSet(spec.name) }));
  const switches = SWITCH_SPEC.map((spec) => ({ ...spec, engaged: isSet(spec.name) }));

  // Set but read by nothing in this repo. Exposure with no benefit.
  const platform = new Set([
    'URL', 'DEPLOY_URL', 'DEPLOY_PRIME_URL', 'SITE_NAME', 'SITE_ID', 'CONTEXT', 'BRANCH',
    'COMMIT_REF', 'CACHED_COMMIT_REF', 'HEAD', 'REPOSITORY_URL', 'NETLIFY', 'NETLIFY_DEV',
    'NETLIFY_LOCAL', 'NETLIFY_IMAGES_CDN_DOMAIN', 'BUILD_ID', 'PULL_REQUEST', 'REVIEW_ID',
    'LAMBDA_TASK_ROOT', 'AWS_REGION', 'NODE_ENV', 'PATH', 'HOME', 'TZ', 'LANG', 'PWD', 'SHLVL', '_',
  ]);
  const orphans = Object.keys(process.env)
    .filter((k) => !known.has(k) && !platform.has(k) && !k.startsWith('AWS_') && !k.startsWith('LAMBDA_')
      && !k.startsWith('NETLIFY') && !k.startsWith('_') && !k.startsWith('npm_') && !k.startsWith('NODE_'))
    .filter((k) => /(KEY|SECRET|TOKEN|PIN|PASSWORD|EMAIL|NUMBER|SID|ID)$/.test(k) || k.startsWith('ANSWERED_'))
    .sort();

  return { vars, switches, orphans };
}

// ── the gate. One read of the site's own /api/demo-health ────────────────────
async function readGate(base, timeoutMs) {
  if (!base) return { landed: false, ok: false, reason: 'no site host is available, so the gate could not be read' };
  const r = await fetch(base + '/api/demo-health', {
    headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) return { landed: true, ok: false, reason: '/api/demo-health answered ' + r.status };
  const body = await r.json();
  const checks = body.checks || {};
  const failing = Object.entries(checks)
    .filter(([, c]) => !(c && c.landed && c.ok))
    .map(([k, c]) => k + ': ' + ((c && c.reason) || 'not ok'));
  return {
    landed: true,
    ok: body.healthy === true,
    healthy: body.healthy === true,
    outbound_ready: body.outbound_ready === true,
    checks,
    checked: body.checked || null,
    reason: failing.join('; '),
  };
}

// ── the canary. Read the store the scheduled real call writes to ─────────────
async function readCanary(event, historyLimit) {
  let blobs;
  try { blobs = await import('@netlify/blobs'); }
  catch (e) {
    return { landed: false, ok: false,
      reason: '@netlify/blobs failed to load, so the canary result cannot be read: ' + String(e && e.message).slice(0, 100),
      fix: 'Run npm install inside netlify/functions and redeploy with that node_modules staged.' };
  }
  try { if (typeof blobs.connectLambda === 'function') blobs.connectLambda(event); } catch (e) { /* the read is the verdict */ }

  const store = blobs.getStore('canary');
  const latest = await store.get('latest', { type: 'json' });
  const prev = await store.get('prev', { type: 'json' });

  let history = [];
  try {
    const listed = await store.list({ prefix: 'history/' });
    history = (listed.blobs || []).map((b) => b.key).sort().slice(-historyLimit).reverse();
  } catch (e) { history = []; }

  if (!latest) {
    return { landed: false, ok: false, latest: null, prev: null, history,
      reason: 'no canary has ever run. There is no record in the store at all.' };
  }
  const ageMs = Date.now() - Date.parse(latest.at || '');
  const fresh = Number.isFinite(ageMs) && ageMs < 3 * 60 * 60 * 1000 && ageMs > -5 * 60 * 1000;
  return {
    landed: fresh, ok: fresh && latest.ok === true,
    latest, prev, history, age_minutes: Number.isFinite(ageMs) ? Math.round(ageMs / 60000) : null,
    reason: !fresh
      ? 'the newest canary record is ' + (Number.isFinite(ageMs) ? Math.round(ageMs / 60000) + ' minutes old' : 'undated') + '. Fresh means under three hours, and it runs every two.'
      : (latest.ok ? '' : String(latest.reason || 'the canary failed and did not say why')),
  };
}

// ── the route sweep. Real HTTP, in parallel, with real timeouts ──────────────
// A route is ok when it answered at all and did not answer 404 or 5xx. A 405 or
// a 401 from a POST only or gated endpoint is a PASS and is labelled as one:
// it proves the route is deployed and reachable. It does not prove the endpoint
// works, and nothing here claims it does.
async function sweepRoutes(base, timeoutMs, selfPath) {
  if (!base) return [];
  return Promise.all(ROUTES.map(async (route) => {
    if (route.path === selfPath) return { ...route, skipped: 'this page', landed: true, ok: true, status: null, ms: 0 };
    // Marked probe:false because a request to it would DO something. Reported
    // as skipped with the reason, never as a pass, so the page cannot imply it
    // was checked.
    if (route.probe === false) return { ...route, skipped: 'not probed on purpose', landed: true, ok: true, status: null, ms: 0 };
    const t0 = Date.now();
    try {
      const r = await fetch(base + route.path, {
        redirect: 'manual', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(timeoutMs),
      });
      const bytes = Number(r.headers.get('content-length') || 0)
        || (route.kind === 'gate' ? (await r.text()).length : 0);
      const ms = Date.now() - t0;
      const expected = route.expect ? route.expect.includes(r.status) : (r.status >= 200 && r.status < 400);
      const reachable = r.status !== 404 && r.status < 500;
      let ok = expected && reachable;
      let reason = ok ? '' : (r.status === 404
        ? 'NOT DEPLOYED. This route answers 404, so the function or page is not there.'
        : 'answered ' + r.status + ', expected one of ' + (route.expect || ['2xx', '3xx']).join(', '));

      // A gate that serves more than a form is not a gate.
      if (ok && route.kind === 'gate' && bytes > GATE_MAX_ANON_BYTES) {
        ok = false;
        reason = 'THE GATE IS LEAKING. An anonymous request got ' + bytes + ' bytes back. A PIN form is about two thousand. If the bytes reach the browser, the page is public.';
      }
      return { ...route, landed: true, ok, status: r.status, bytes: bytes || null, ms, reason };
    } catch (e) {
      return { ...route, landed: false, ok: false, status: null, ms: Date.now() - t0,
        reason: 'the request never completed: ' + String(e && e.message).slice(0, 90) };
    }
  }));
}

// ── the whole picture ────────────────────────────────────────────────────────
export async function collect({ event, base, probeRoutes = true, timeoutMs = 6000, historyLimit = 12, selfPath = null } = {}) {
  const at = new Date().toISOString();
  const resolvedBase = base || siteBase(event);

  const [gate, canary, routes] = await Promise.all([
    timed(() => readGate(resolvedBase, timeoutMs)),
    timed(() => readCanary(event, historyLimit)),
    probeRoutes ? sweepRoutes(resolvedBase, timeoutMs, selfPath) : Promise.resolve([]),
  ]);

  const env = envReport();
  const alerting = isSet('RESEND_API_KEY')
    ? { armed: true, reason: '' }
    : { armed: false, reason: 'RESEND_API_KEY is not set. This watch cannot send an email, so nobody is told when something breaks. Right now the only way anyone learns is by opening this page.' };

  return { at, base: resolvedBase, gate, canary, routes, env, alerting };
}

// ── the verdict ──────────────────────────────────────────────────────────────
// Reds are things a person can see are broken. Ambers are capabilities that are
// off. Both are listed in plain words, because an alert nobody understands at
// 2am is an alert nobody acts on.
export function summarize(s) {
  const reds = [];
  const ambers = [];

  if (!s.gate.landed) reds.push('The health gate could not be read at all. ' + (s.gate.reason || ''));
  else if (!s.gate.healthy) reds.push('The site wide call gate is RED, so every call control on the site is hiding itself. ' + (s.gate.reason || ''));
  if (s.gate.landed && s.gate.healthy && s.gate.outbound_ready === false) {
    ambers.push('Outbound is not ready, so the one click activation button stays hidden. ' + ((s.gate.checks?.outbound?.reason) || ''));
  }

  if (!s.canary.landed) reds.push('The real call canary is not reporting. ' + (s.canary.reason || ''));
  else if (!s.canary.ok) reds.push('The last real call canary FAILED. ' + (s.canary.reason || ''));

  for (const r of s.routes) {
    if (r.skipped) continue;
    if (!r.landed || !r.ok) {
      const line = r.path + ' is not answering properly. ' + (r.reason || '');
      if (r.kind === 'gate' || r.path === '/api/demo-health' || r.kind === 'page') reds.push(line);
      else ambers.push(line);
    }
  }

  for (const v of s.env.vars) {
    if (v.set) continue;
    if (v.severity === 'red') reds.push(v.name + ' is not set. ' + v.unset);
    else if (v.severity === 'amber') ambers.push(v.name + ' is not set. ' + v.unset);
  }

  if (!s.alerting.armed) reds.push('ALERTING IS UNARMED. ' + s.alerting.reason);

  const level = reds.length ? 'red' : (ambers.length ? 'amber' : 'green');
  const headline = level === 'green'
    ? 'Everything measured here is up.'
    : (reds.length ? reds.length + (reds.length === 1 ? ' thing is broken' : ' things are broken') : '')
      + (reds.length && ambers.length ? ' and ' : '')
      + (ambers.length ? ambers.length + (ambers.length === 1 ? ' capability is off' : ' capabilities are off') : '')
      + '.';
  return { level, reds, ambers, headline };
}

// A stable identity for the CURRENT state, so the watch can tell a new problem
// from the same problem still being there. Deliberately excludes timestamps,
// durations, byte counts and ages: those change on every run and would make
// every run look like a change, which is how an alert channel becomes noise
// and then becomes ignored.
// ★ A FINGERPRINT MUST NOT CONTAIN A CLOCK. Measured 2026-08-14 from David's inbox: six identical
// "1 new, 1 cleared" alerts in one hour, ten minutes apart. The change detector was working
// perfectly; what it hashed was not stable. Reasons are human prose and some of them count elapsed
// time ("Twilio has been refusing every request for 13 minutes", "canary 814 min stale"), so the
// number moved on every run and every run looked like a brand new problem. That is my own backoff
// message doing it: it was written for a person reading a health page and became an input to a
// hash. An alert that arrives every ten minutes is one nobody reads, which is the failure mode the
// whole watch exists to avoid. So elapsed durations are normalised OUT of the identity of a
// problem, while status codes and everything else stay in: 401 turning into 503 is a real change
// and must still alert.
const STABLE = (t) => String(t)
  .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|second|seconds|min|mins|minute|minutes|hour|hours|h|day|days)\b/gi, '<elapsed>')
  .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, '<time>')
  .trim();

export function fingerprint(s) {
  const v = summarize(s);
  return JSON.stringify({
    level: v.level,
    reds: v.reds.map(STABLE).sort(),
    ambers: v.ambers.map(STABLE).sort(),
  });
}
