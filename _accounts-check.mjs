#!/usr/bin/env node
// _accounts-check.mjs : the accounts lane, exercised through its serving path.
//
// This is not a unit test. It boots the real Netlify v2 handlers behind a real HTTP server, on
// real credentials pulled from the Netlify project at run time, against the real production
// database, and then USES the thing: it signs a business up, opens its emailed link, fails to
// open it twice, writes rules, gets refused for a line while rules are missing, gets a line,
// assigns a number, and dials the number as Twilio would.
//
// A 200 is not evidence. Every check below asserts on a computed result: bytes that must be
// present, and bytes that must be ABSENT, which is the half that catches the real defects.
//
//   ./_accounts-check.mjs            run everything and clean up after itself
//   ./_accounts-check.mjs --keep     leave the QA account behind for inspection
//
// The QA account is deleted at the end by default. An operator console showing a business that
// does not exist is exactly the fake data this estate refuses.

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const KEEP = process.argv.includes('--keep');
const QA_EMAIL = 'delivered@resend.dev';       // Resend's own sink. A real send, no human inbox.
const QA_BUSINESS = 'QA Harness Plumbing (delete me)';
const QA_NUMBER = '+15005550199';              // Twilio's reserved test range. Never a real line.

// ── credentials, in memory only ──────────────────────────────────────────────────────────────
function loadEnv() {
  const raw = execFileSync('netlify', ['env:list', '--context', 'production', '--json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const data = JSON.parse(raw);
  let n = 0;
  for (const [k, v] of Object.entries(data)) {
    const val = typeof v === 'string' ? v : (v?.value ?? v?.values?.[0]?.value);
    if (val) { process.env[k] = String(val); n += 1; }
  }
  return n;
}

// ── the server ───────────────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 8917);
const ORIGIN = `http://127.0.0.1:${PORT}`;

async function buildRouter() {
  const mods = await Promise.all([
    import('./netlify/functions/account.mjs'),
    import('./netlify/functions/account-start.mjs'),
    import('./netlify/functions/account-admin.mjs'),
    import('./netlify/functions/account-voice.mjs'),
  ]);
  const routes = new Map();
  for (const m of mods) {
    const paths = Array.isArray(m.config.path) ? m.config.path : [m.config.path];
    for (const p of paths) routes.set(p, m.default);
  }
  return routes;
}

function serve(routes) {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, ORIGIN);
      const handler = routes.get(url.pathname.replace(/\/+$/, '') || '/')
        || routes.get(url.pathname);
      if (!handler) { res.writeHead(404).end('no route'); return; }
      const request = new Request(ORIGIN + req.url, {
        method: req.method,
        headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      });
      try {
        const out = await handler(request);
        const headers = {};
        for (const [k, v] of out.headers) {
          if (k.toLowerCase() === 'set-cookie') (headers['set-cookie'] ||= []).push(v);
          else headers[k] = v;
        }
        res.writeHead(out.status, headers);
        res.end(Buffer.from(await out.arrayBuffer()));
      } catch (e) {
        res.writeHead(500).end(`handler threw: ${e && e.stack}`);
      }
    });
    s.listen(PORT, '127.0.0.1', () => resolve(s));
  });
}

// ── assertions ───────────────────────────────────────────────────────────────────────────────
let pass = 0; const fails = []; const deferred = [];
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fails.push(`${name}${detail ? ` :: ${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}`); }
}
/**
 * Some things cannot be measured from here, and saying so is the only honest option. A check that
 * quietly passes because it could not run is worse than no check: you trust the empty chart.
 */
function defer(name, why) {
  deferred.push(`${name} :: ${why}`);
  console.log(`  ..   ${name} (not measurable here: ${why})`);
}

/**
 * ★ Netlify marks some variables is_secret, and `netlify env:list` returns a MASK for those, not
 * the value. RESEND_API_KEY is one. A local run therefore holds "********************", every
 * send fails with "API key is invalid", and the first pass of this harness reported that as a
 * product defect for ten minutes. It is an instrument defect. Detect the mask and defer.
 */
// The mask is asterisks followed by the last few real characters, so it is NOT all asterisks and
// a `/^\*+$/` test misses it. No real API key contains an asterisk; that is the whole tell.
const isMasked = (v) => !v || String(v).includes('*');

let COOKIE = '';
async function hit(path, { method = 'GET', form, json: body, cookie = COOKIE, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  let payload;
  if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
  if (body) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(ORIGIN + path, { method, headers: h, body: payload, redirect: 'manual' });
  return { status: r.status, text: await r.text(), headers: r.headers, cookie: r.headers.getSetCookie?.()[0] || r.headers.get('set-cookie') };
}

const twilioForm = (to, from = '+19168663918', accountSid = process.env.TWILIO_ACCOUNT_SID) => ({
  AccountSid: accountSid, CallSid: `CAqa${Date.now()}`, To: to, From: from,
  Direction: 'inbound', CallStatus: 'ringing',
});

// ── the live probe ───────────────────────────────────────────────────────────────────────────
// The one thing a local box cannot see: whether the deployed site can actually send the email.
// Run this after the integrator deploys. It signs a business up on production, for real, then
// deletes it, so nothing fake is left in the operator console.
async function prodProbe() {
  const BASE = process.env.ANSWERED_BASE || 'https://answered.reddenda.com';
  console.log(`\nprobing ${BASE}\n`);
  const get = async (p, init) => { const r = await fetch(BASE + p, { redirect: 'manual', ...init }); return { status: r.status, text: await r.text() }; };

  let r = await get('/account');
  check('prod /account serves the sign-in page', r.status === 200 && /Sign in/.test(r.text), `status ${r.status}`);
  check('prod /account leaks no account data to an anonymous request', !/@resend\.dev|owner_email/.test(r.text));

  r = await get('/internal/accounts');
  check('prod /internal/accounts asks for a PIN', r.status === 200 && /PIN/.test(r.text), `status ${r.status}`);
  check('prod /internal/accounts serves nothing about any account', !/delete me|@resend\.dev|Slab leak/.test(r.text),
    `${r.text.length} bytes to anonymous`);

  r = await get('/api/agent-config?to=%2B15005550199');
  check('prod /api/agent-config is closed without a key', r.status === 401, `status ${r.status}`);

  r = await get('/api/account-voice', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ AccountSid: 'ACnot_our_account', To: '+15005550199', From: '+19168663918', CallSid: 'CAprobe' }).toString(),
  });
  check('prod /api/account-voice refuses a foreign Twilio account', r.status === 403, `status ${r.status}`);

  r = await get('/api/account/start', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: QA_EMAIL, business_name: QA_BUSINESS, trade: 'Plumbing' }).toString(),
  });
  check('prod sign-up sends the login link for real', r.status === 200 && /Check your email/.test(r.text),
    r.status === 502 ? 'the site said the send failed, so RESEND_API_KEY on this project is not usable' : `status ${r.status}`);

  // Leave nothing behind.
  const { rpc } = await import('./netlify/functions/lib/db.mjs');
  const list = await rpc('sv_accounts', { p_status: null, p_limit: 200 }).catch(() => []);
  for (const a of (Array.isArray(list) ? list : [])) {
    if (a.owner_email === QA_EMAIL) await rpc('sv_qa_delete_account', { p_account_id: a.id }).catch(() => {});
  }
  const after = await rpc('sv_accounts', { p_status: null, p_limit: 200 }).catch(() => []);
  check('the probe account was removed', !(Array.isArray(after) ? after : []).some((a) => a.owner_email === QA_EMAIL));

  console.log(`\n${pass} checks passed, ${fails.length} failed`);
  if (fails.length) { fails.forEach((f) => console.log(`  FAIL ${f}`)); process.exit(1); }
  process.exit(0);
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────
const n = loadEnv();
console.log(`\nenv: ${n} variables pulled from the Netlify production context (values never printed)\n`);
if (process.argv.includes('--prod')) await prodProbe();

const accounts = await import('./netlify/functions/lib/accounts.mjs');
const auth = await import('./netlify/functions/lib/account-auth.mjs');
process.env.URL = ORIGIN;

// Start clean. A run that inherits the last run's account inherits its rate-limit budget and its
// state machine, and then reports failures that belong to the previous run.
{
  const { rpc } = await import('./netlify/functions/lib/db.mjs');
  const prior = await rpc('sv_accounts', { p_status: null, p_limit: 200 }).catch(() => []);
  for (const a of (Array.isArray(prior) ? prior : [])) {
    if (a.owner_email === QA_EMAIL) {
      await rpc('sv_qa_delete_account', { p_account_id: a.id }).catch(() => {});
      console.log(`cleared a leftover QA account from an earlier run (${a.id})`);
    }
  }
}

const routes = await buildRouter();
const server = await serve(routes);
console.log(`serving the real handlers on ${ORIGIN}\n`);

// --serve: stand a fully configured, live QA business up and hold the server open so a real
// browser can be pointed at it. Screenshots catch what assertions cannot.
if (process.argv.includes('--serve')) {
  // Local only, in this process only. The real PIN stays where it is; nothing is written to
  // Netlify and nothing is printed. This exists so the operator page can be opened in a real
  // browser without a credential ever passing through a terminal.
  process.env.ANSWERED_DIRECTORY_PIN = '000000';
  console.log('note: this process is using a throwaway internal PIN, local only, never deployed.');
  const { raw: r0, hash: h0 } = auth.mintLoginToken();
  const s = await accounts.startAccount({
    email: QA_EMAIL, businessName: QA_BUSINESS, trade: 'Plumbing', tokenHash: h0,
    ttlMinutes: 120, ip: '127.0.0.1', ua: 'accounts-check --serve',
  });
  const id = s.account.id;
  await accounts.consumeToken(auth.hashToken(r0), '127.0.0.1');
  await accounts.saveConfig(id, {
    greeting_name: 'Dana', business_says: 'QA Harness Plumbing', owner_phone: '+19168663918',
    services: ['Water heater replacement', 'Slab leak detection', 'Drain clearing'],
    service_area: 'Sacramento and forty miles around it',
    hours: { mon: [['07:00', '17:00']], tue: [['07:00', '17:00']], wed: [['07:00', '17:00']], thu: [['07:00', '17:00']], fri: [['07:00', '17:00']], sat: [['08:00', '12:00']], sun: [] },
    after_hours: 'urgent_only', booking_mode: 'sends_invite',
    booking_destination: 'jobs@qa-harness-plumbing.example',
    always_ask: ['their name', 'the best number to reach them on', 'the address', 'whether water is running right now'],
    quote_policy: 'never', escalation_when: 'emergency', escalation_phone: '+19168663918',
    never_say: ['anything about a warranty', 'how many trucks we run'], monthly_cap_cents: 40000,
  }, 'accounts-check');
  const { raw, hash } = auth.mintLoginToken();
  await accounts.startAccount({ email: QA_EMAIL, businessName: QA_BUSINESS, tokenHash: hash, ttlMinutes: 120, ip: '127.0.0.1', ua: 'serve' });
  console.log(`\nQA business ${id} is ready.`);
  console.log(`sign in:  ${ORIGIN}/account/enter?t=${encodeURIComponent(raw)}`);
  console.log(`operator: ${ORIGIN}/internal/accounts`);
  console.log('\nCtrl-C when done. Run without --serve afterwards to clean up.\n');
  const bye = async () => {
    const { rpc } = await import('./netlify/functions/lib/db.mjs');
    await rpc('sv_qa_delete_account', { p_account_id: id }).catch(() => {});
    console.log('\nQA business removed.');
    process.exit(0);
  };
  // SIGTERM as well as SIGINT: a pkill sends TERM, and the first time this was written the QA
  // business survived the shutdown and poisoned the next run's rate limit.
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  await new Promise(() => {});
}

console.log('1. configuration');
check('the account database is reachable', accounts.dbConfigured());
check('a session signing key exists', auth.configured());

console.log('\n1b. the database door');
{
  // Every sv_* function is callable by the anonymous role by design; the shared secret is the
  // only thing standing in front of it. That claim is worth measuring, not assuming, and a NULL
  // secret is tested on purpose: an absent field sailing through a gate is this estate's
  // most-repeated defect.
  const U = process.env.ANSWERED_DB_URL; const A = process.env.ANSWERED_DB_ANON;
  const call = async (fn, body) => (await fetch(`${U}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: A, Authorization: `Bearer ${A}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })).status;
  for (const secret of ['', 'x'.repeat(64), null]) {
    const label = secret === null ? 'a null secret' : secret ? 'a wrong secret' : 'no secret';
    check(`the account list refuses ${label}`, (await call('sv_accounts', { p_secret: secret, p_status: null, p_limit: 10 })) === 403);
    check(`the number resolver refuses ${label}`, (await call('sv_account_for_number', { p_secret: secret, p_phone: QA_NUMBER })) === 403);
    check(`signup refuses ${label}`, (await call('sv_account_start', {
      p_secret: secret, p_email: 'attacker@example.com', p_business_name: 'X', p_owner_name: '',
      p_phone: '', p_trade: '', p_token_hash: 'deadbeef', p_ttl_minutes: 20, p_ip: '', p_ua: '',
    })) === 403);
  }
  for (const tbl of ['accounts', 'account_tokens', 'account_config', 'account_numbers']) {
    const r = await fetch(`${U}/rest/v1/${tbl}?select=*`, { headers: { apikey: A, Authorization: `Bearer ${A}` } });
    check(`the publishable key cannot read ${tbl}`, r.status === 401, `status ${r.status}`);
  }
}

console.log('\n2. the door, signed out');
{
  const r = await hit('/account', { cookie: '' });
  check('GET /account serves the sign-in page', r.status === 200 && /Sign in/.test(r.text));
  check('no session is handed out for free', !r.cookie);
  check('no account data is in the bytes', !/owner_email|delete me|@resend\.dev/i.test(r.text));
}
{
  const r = await hit('/api/account/start', { method: 'POST', form: { email: 'not-an-email' }, cookie: '' });
  check('a malformed address is refused', r.status === 400);
}
{
  const r = await hit('/api/account/save', { method: 'POST', form: { greeting_name: 'Nope' }, cookie: '' });
  check('saving rules without a session is 401', r.status === 401);
}

console.log('\n3. signing up, over HTTP');
{
  const masked = isMasked(process.env.RESEND_API_KEY);
  const r = await hit('/api/account/start', {
    method: 'POST', cookie: '',
    form: { email: QA_EMAIL, business_name: QA_BUSINESS, trade: 'Plumbing', phone: '+19168663918' },
  });
  if (masked) {
    // The endpoint is SUPPOSED to fail here: no key, no link, and it refuses to say check your
    // email when nothing was sent. That refusal is the behaviour under test.
    check('with no usable send key it refuses to claim an email was sent',
      r.status === 502 && /did not send/.test(r.text) && !/Check your email/.test(r.text), `status ${r.status}`);
    defer('the login link actually sends', 'RESEND_API_KEY is is_secret, so the CLI returns a mask; run --prod after deploy');
  } else {
    check('POST /api/account/start returns the check-your-email page', r.status === 200 && /Check your email/.test(r.text), `status ${r.status}`);
    check('the reply never says whether the address was already known', !/already|existing|new account/i.test(r.text));
  }
}

// The emailed token is not readable from here by design, so the link is minted directly against
// the same RPC the endpoint uses. This tests the consume path, not a stub of it.
const { raw, hash } = auth.mintLoginToken();
const started = await accounts.startAccount({
  email: QA_EMAIL, businessName: QA_BUSINESS, trade: 'Plumbing', tokenHash: hash,
  ttlMinutes: 20, ip: '127.0.0.1', ua: 'accounts-check',
});
check('a second signup is the same business, not a second one', started.created === false, `created=${started.created}`);
check('a failed send never fills the rate-limit budget', started.throttled === false,
  'the throttle counted tokens issued rather than links actually sent');
const ACCOUNT_ID = started.account.id;

console.log('\n4. the emailed link');
{
  const bad = await hit('/account/enter?t=' + 'x'.repeat(43), { cookie: '' });
  check('a made-up link is refused', bad.status === 401);

  const good = await hit(`/account/enter?t=${encodeURIComponent(raw)}`, { cookie: '' });
  check('a real link redirects to the console', good.status === 303 && good.headers.get('location') === '/account', `status ${good.status}`);
  check('a real link sets an HttpOnly Secure cookie', /HttpOnly/.test(good.cookie || '') && /Secure/.test(good.cookie || ''));
  COOKIE = (good.cookie || '').split(';')[0];

  const again = await hit(`/account/enter?t=${encodeURIComponent(raw)}`, { cookie: '' });
  check('the same link cannot be used twice', again.status === 401, `status ${again.status}`);
}

console.log('\n5. the console, signed in');
{
  const r = await hit('/account');
  check('the console renders this business', r.status === 200 && r.text.includes(QA_BUSINESS));
  check('it says the rules are not finished', /not finished/i.test(r.text));
  check('it names what is missing in plain words', /the work you take/i.test(r.text) && /your hours/i.test(r.text));
  check('it says there is no number yet', /do not have a number yet/i.test(r.text));
  check('it does not claim a number is being set up automatically', !/provisioning|automatically assigned/i.test(r.text));
}
{
  const forged = COOKIE.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  const r = await hit('/account', { cookie: forged });
  check('a tampered cookie gets the sign-in page, not the console', r.status === 200 && !r.text.includes(QA_BUSINESS));
}

console.log('\n6. asking for a line too early');
{
  const r = await hit('/api/account/request-line', { method: 'POST', form: { area_code: '916' } });
  check('a line is refused while rules are missing', r.status === 303 && /line=incomplete/.test(r.headers.get('location') || ''), r.headers.get('location') || `status ${r.status}`);
  const a = await accounts.getAccount(ACCOUNT_ID);
  check('the account did not move to awaiting_line', a.status !== 'awaiting_line', `status ${a.status}`);
}

console.log('\n7. writing the rules');
{
  const r = await hit('/api/account/save', {
    method: 'POST',
    form: {
      business_name: QA_BUSINESS,
      greeting_name: 'Dana',
      business_says: 'QA Harness Plumbing',
      trade: 'Plumbing',
      owner_phone: '+19168663918',
      services: 'Water heater replacement\nSlab leak detection\nDrain clearing',
      service_area: 'Sacramento and forty miles around it',
      h_mon_open: '07:00', h_mon_close: '17:00',
      h_tue_open: '07:00', h_tue_close: '17:00',
      h_wed_open: '07:00', h_wed_close: '17:00',
      h_thu_open: '07:00', h_thu_close: '17:00',
      h_fri_open: '07:00', h_fri_close: '17:00',
      h_sat_open: '08:00', h_sat_close: '12:00',
      after_hours: 'urgent_only',
      booking_mode: 'sends_invite',
      booking_destination: 'jobs@qa-harness-plumbing.example',
      always_ask: 'their name\nthe best number to reach them on\nthe address\nwhether water is running right now',
      quote_policy: 'never',
      escalation_when: 'emergency',
      escalation_phone: '+19168663918',
      never_say: 'anything about a warranty\nhow many trucks we run',
      monthly_cap: '400',
    },
  });
  check('saving rules redirects back saved', r.status === 303 && /saved=1/.test(r.headers.get('location') || ''), r.headers.get('location') || `status ${r.status}`);
}
{
  const a = await accounts.getAccount(ACCOUNT_ID);
  check('the account is now ready', a.status === 'ready', `status ${a.status}`);
  check('nothing is missing', (a.missing || []).length === 0, JSON.stringify(a.missing));
  check('the cap the owner typed is what is stored', a.config.monthly_cap_cents === 40000, String(a.config.monthly_cap_cents));
  check('the rules version advanced', a.config.version > 1, String(a.config.version));

  const spec = accounts.renderSpec(a);
  check('the spec speaks this business by name', spec.includes('QA Harness Plumbing'));
  check('the spec carries the owner\'s own service list', spec.includes('Slab leak detection'));
  check('the spec carries the owner\'s own question', spec.includes('whether water is running right now'));
  check('the spec carries the owner\'s never-say list', spec.includes('anything about a warranty'));
  check('after-hours choice is reflected, not defaulted', /emergencies only/i.test(spec));
  check('sends_invite never lets the agent say booked', /Never say the job is booked/.test(spec));
  check('quote policy never is stated as never', /Never quote a price/.test(spec));
  check('the AI disclosure floor is present whatever the owner wrote', /Say you are an AI assistant in your first sentence/.test(spec));
  check('the no-invented-numbers floor is present', /Never state a number you were not given/.test(spec));
  check('the stop-calling floor is present', /asks you to stop calling/.test(spec));
  check('the greeting discloses the AI in the first sentence', /AI assistant/.test(accounts.renderGreeting(a)));

  const r = await hit('/account');
  check('the console prints the exact words the line uses', r.text.includes('Slab leak detection') && /What your line says/.test(r.text));
  check('the console now says the rules are ready', /rules are ready/i.test(r.text));
}

console.log('\n8. asking for a line, properly');
{
  const r = await hit('/api/account/request-line', { method: 'POST', form: { area_code: '916', note: 'harness' } });
  check('the request goes through', r.status === 303 && /line=asked/.test(r.headers.get('location') || ''), r.headers.get('location') || `status ${r.status}`);
  const a = await accounts.getAccount(ACCOUNT_ID);
  check('the account is awaiting a line', a.status === 'awaiting_line', `status ${a.status}`);
  check('no phone row was invented by the request', (a.numbers || []).length === 0, JSON.stringify(a.numbers));
  const page = await hit('/account');
  check('the page says a person does this by hand', /done by a person right now/i.test(page.text));
}

console.log('\n9. the resolver, before a number exists');
{
  const noauth = await hit(`/api/agent-config?to=${encodeURIComponent(QA_NUMBER)}`, { cookie: '' });
  check('/api/agent-config without a key is 401', noauth.status === 401);

  const bearer = { authorization: `Bearer ${process.env.ANSWERED_COCKPIT_KEY}` };
  const bad = await hit('/api/agent-config?to=nonsense', { cookie: '', headers: bearer });
  check('a number that is not E.164 is refused', bad.status === 400);

  const unknown = await hit(`/api/agent-config?to=${encodeURIComponent(QA_NUMBER)}`, { cookie: '', headers: bearer });
  check('an unowned number resolves to nothing, honestly', unknown.status === 404);
}

console.log('\n10. dialling a number nobody owns');
{
  const r = await hit('/api/account-voice', { method: 'POST', cookie: '', form: twilioForm(QA_NUMBER) });
  check('an unowned number gets TwiML, not an error', r.status === 200 && /<Response>/.test(r.text), `status ${r.status}`);
  check('it says the number is not set up', /not set up to answer calls yet/.test(r.text));
  check('it hangs up rather than improvising', /<Hangup\/>/.test(r.text));
  check('IT NEVER ANSWERS AS A BUSINESS IT DOES NOT KNOW', !/Riley|Cedar Ridge|QA Harness/.test(r.text));
}
{
  const r = await hit('/api/account-voice', { method: 'POST', cookie: '', form: twilioForm(QA_NUMBER, '+19168663918', 'ACnot_our_account') });
  check('a webhook from the wrong Twilio account is 403', r.status === 403, `status ${r.status}`);
}
{
  const r = await hit('/api/account-voice', { cookie: '' });
  check('GET on the voice webhook is 405', r.status === 405);
}

console.log('\n11. the operator assigns a real number');
{
  const before = await accounts.assignNumber(ACCOUNT_ID, QA_NUMBER, '', 'accounts-check');
  check('assignment reports success', before.ok === true, JSON.stringify(before).slice(0, 120));
  const a = await accounts.getAccount(ACCOUNT_ID);
  check('the account is live', a.status === 'live', `status ${a.status}`);
  check('the number is on the account', (a.numbers || []).some((x) => x.phone === QA_NUMBER));

  const page = await hit('/account');
  check('the console says the line is on', /line is on/i.test(page.text) && page.text.includes(QA_NUMBER));
}

console.log('\n12. the resolver, with the number live');
{
  const bearer = { authorization: `Bearer ${process.env.ANSWERED_COCKPIT_KEY}` };
  const r = await hit(`/api/agent-config?to=${encodeURIComponent(QA_NUMBER)}`, { cookie: '', headers: bearer });
  const j = JSON.parse(r.text);
  check('/api/agent-config resolves the live number', r.status === 200 && j.ok === true, `status ${r.status}`);
  check('it returns this business\'s own rules', j.prompt.includes('Slab leak detection'));
  check('it returns the greeting the caller hears first', /AI assistant/.test(j.first_message));
  check('it reports the rules version being served', typeof j.config_version === 'number');
}

console.log('\n13. dialling the live number');
{
  const r = await hit('/api/account-voice', { method: 'POST', cookie: '', form: twilioForm(QA_NUMBER) });
  const agentSet = Boolean((process.env.ANSWERED_CUSTOMER_AGENT_ID || '').trim());
  check('the call is answered with TwiML', r.status === 200 && /<Response>/.test(r.text), `status ${r.status}`);
  if (agentSet) {
    check('the call bridges to the agent', /<Connect>|<Stream|<Dial/.test(r.text), r.text.slice(0, 200));
  } else {
    check('with no customer agent configured it says so honestly', /cannot pick up right now/.test(r.text), r.text.slice(0, 200));
    check('the honest fallback still names the right business', r.text.includes('QA Harness Plumbing'));
    check('the honest fallback never claims a message was taken', /nobody is taking a message/.test(r.text));
  }
}

console.log('\n14. the operator page');
{
  const r = await hit('/internal/accounts', { cookie: '' });
  check('/internal/accounts asks for a PIN', r.status === 200 && /PIN/.test(r.text));
  check('NOTHING about any account is in those bytes', !/QA Harness|resend\.dev|Slab leak/.test(r.text),
    `${r.text.length} bytes served to an anonymous request`);
}

console.log('\n15. cleaning up');
if (KEEP) {
  console.log(`  kept: account ${ACCOUNT_ID} (${QA_BUSINESS}) on ${QA_NUMBER}`);
} else {
  const { rpc } = await import('./netlify/functions/lib/db.mjs');
  await rpc('sv_qa_delete_account', { p_account_id: ACCOUNT_ID }).catch(async (e) => {
    console.log(`  cleanup RPC unavailable (${String(e.message).slice(0, 80)}); leaving ${ACCOUNT_ID} for manual removal`);
  });
  const gone = await accounts.getAccount(ACCOUNT_ID);
  check('the QA account is gone', gone === null, gone ? `still ${gone.status}` : '');
  const resolved = await accounts.accountForNumber(QA_NUMBER);
  check('the QA number resolves to nothing again', resolved === null);
}

server.close();
console.log(`\n${pass} checks passed, ${fails.length} failed, ${deferred.length} not measurable from here`);
if (deferred.length) deferred.forEach((d) => console.log(`  DEFERRED ${d}`));
if (fails.length) { fails.forEach((f) => console.log(`  FAIL ${f}`)); process.exit(1); }
console.log('\nAfter deploy, run the one thing this box cannot see:');
console.log('  node _accounts-check.mjs --prod');
process.exit(0);
