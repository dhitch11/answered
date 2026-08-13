// /internal — the Answered site directory. PIN-GATED SERVER-SIDE.
//
// THE LAW THIS FILE OBEYS (estate hard rule 9, learned from the /competitors
// incident): if the bytes reach the browser, the page is public. A client-side
// PIN curtain protects nothing. So the directory HTML lives INSIDE this
// function and is serialized ONLY after the PIN check passes. The
// unauthenticated response contains the entry form and not one byte of the
// directory.
//
// Auth: POST pin=<value> checked against env ANSWERED_DIRECTORY_PIN
// (constant-time). Success sets an HttpOnly HMAC cookie (signed with
// ANSWERED_BRAIN_SECRET) valid 12 hours so refreshes work. Fails CLOSED: no
// PIN env, no page. Wrong PIN answers slowly (600ms) and honestly.
// Every response carries X-Robots-Tag: noindex and Cache-Control: no-store.
'use strict';

const crypto = require('crypto');

const PIN = (process.env.ANSWERED_DIRECTORY_PIN || '').trim();
const SECRET = (process.env.ANSWERED_BRAIN_SECRET || '').trim();
const COOKIE = 'aw_dir';
const TTL_MS = 12 * 60 * 60 * 1000;

function hmac(s) {
  return crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
}
function makeToken() {
  const exp = String(Date.now() + TTL_MS);
  return exp + '.' + hmac('dir|' + exp);
}
function tokenValid(tok) {
  if (!tok || !SECRET) return false;
  const i = tok.indexOf('.');
  if (i < 1) return false;
  const exp = tok.slice(0, i);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const want = hmac('dir|' + exp);
  const got = tok.slice(i + 1);
  const a = Buffer.from(want), b = Buffer.from(got);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function pinMatches(given) {
  if (!PIN || !given) return false;
  const a = Buffer.from(String(given)), b = Buffer.from(PIN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const BASE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Frame-Options': 'SAMEORIGIN',
};

const SHELL_CSS = `*{margin:0;padding:0;box-sizing:border-box}
body{background:#0B0C0E;color:#F2F4F0;font:16px/1.55 -apple-system,'Segoe UI',Arial,sans-serif;padding:40px 20px;max-width:960px;margin:0 auto}
h1{font-size:26px;margin:0 0 6px}h2{font-size:19px;margin:34px 0 10px;color:#E3FF4F}
p{margin:8px 0}a{color:#37C8F0}
.card{background:#16181C;border:1px solid #23262c;border-radius:10px;padding:16px 18px;margin:12px 0}
.u{font-family:ui-monospace,Menlo,monospace;font-size:14px;color:#E3FF4F;word-break:break-all}
.k{color:#8B939C;font-size:13.5px}
.tag{display:inline-block;font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;color:#0B0C0E;background:#E3FF4F;border-radius:4px;padding:2px 7px;margin-left:8px;vertical-align:2px}
.tag.blue{background:#37C8F0}.tag.red{background:#FF3355;color:#fff}
input{background:#16181C;border:1px solid #2a2e35;border-radius:8px;color:#F2F4F0;font-size:18px;padding:12px 14px;width:220px;letter-spacing:.2em;text-align:center}
button{background:#E3FF4F;color:#0B0C0E;border:0;border-radius:8px;font-size:16px;font-weight:700;padding:12px 22px;margin-left:10px;cursor:pointer}
table{width:100%;border-collapse:collapse;font-size:14.5px}td,th{text-align:left;padding:7px 10px 7px 0;border-bottom:1px solid #23262c;vertical-align:top}
.small{font-size:13px;color:#8B939C}`;

function gatePage(msg) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Answered, internal</title><style>${SHELL_CSS}</style></head><body>
<h1>Internal directory</h1><p class="k">This page is for the team. Enter the PIN.</p>
${msg ? `<p style="color:#FF3355">${msg}</p>` : ''}
<form method="POST" style="margin-top:18px"><input name="pin" type="password" inputmode="numeric" autocomplete="off" autofocus><button type="submit">Open</button></form>
</body></html>`;
}

// ── THE DIRECTORY (served only past the gate) ───────────────────────────────
function directoryPage() {
  const now = new Date().toISOString().slice(0, 10);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Answered, site directory</title><style>${SHELL_CSS}</style></head><body>
<h1>Answered, the whole site on one page</h1>
<p class="k">Internal. Server-gated. Rendered ${now}. Source of truth for what exists, where it lives, and how to use it. The public site is <a href="https://answered.reddenda.com">answered.reddenda.com</a> (temporary domain, no hardcoded hosts anywhere). Repo: github.com/dhitch11/answered. Netlify project answered-preview, site id 2c9f4ae6-f61c-4c1f-96ba-2a467fec00f3, its own project so no other lane's deploy can touch it.</p>

<h2>The pages people see</h2>
<div class="card"><span class="u">https://answered.reddenda.com/</span><span class="tag">two-sided</span>
<p>The home page. It opens on the consumer side and a switch in the menu, For me and For my business, flips it. The choice sticks (saved in the browser), and a link ending in #business opens the business side directly. The hero shows the live demo number ONLY when the health check says the line is up. If the line is down, the number simply is not there.</p>
<p class="k">How to use: send consumers the bare link. Send contractors the link with #business. The whole page works with JavaScript off, consumer side.</p></div>
<div class="card"><span class="u">https://answered.reddenda.com/trades</span>
<p>The contractor product page. The 2 AM story, the missed-call math with sources, the setup dial codes (*71 catch what you miss, *72 everything, *73 off), and the pricing card: $19 a booked standard job, $49 after hours, bill stops at $549, quiet line settles at $39 credited back.</p>
<p class="k">How to use: this is the page for a plumber, roofer, HVAC, electrician. It is the one to text another contractor.</p></div>
<div class="card"><span class="u">https://answered.reddenda.com/hold</span>
<p>The consumer product page. It waits on hold with the government, the bank, the airline, and rings you when a real person picks up. $20 a government connection, $10 commercial, $0 if no human is ever reached, first hold free.</p></div>
<div class="card"><span class="u">https://answered.reddenda.com/recover</span>
<p>The money page. Late invoices get a phone call in the contractor's own name. 15% of dollars actually recovered (tiers 10/15/20 by invoice age, 8/13/18 for Answered customers). Autopilot, the flat fork, is $19 per invoice paid. The first sentence of every call is locked: it says it is an AI assistant calling for the company, and that part does not come off.</p></div>
<div class="card"><span class="u">https://answered.reddenda.com/pricing</span>
<p>All three meters on one page with a chooser at the top (consumer, business, both) that only changes what is shown, nothing is hidden behind it. Carries the interest form, the cost arithmetic with sources, and the modeled-not-measured labels that are required by ruling. The phone field carries the SMS consent line.</p>
<p class="k">How to use: the form posts to /api/interest. Every submission emails David, upserts HubSpot with a scored note and a task, and sends the submitter one confirmation email.</p></div>
<div class="card"><span class="u">https://answered.reddenda.com/trust</span>
<p>The guardrails page. Never quotes a price (three enforcement layers), audit by text, the fail-closed recording stance. The page a skeptic should be sent to.</p></div>
<div class="card"><span class="u">https://answered.reddenda.com/thanks</span>
<p>Where the interest form lands. A person reads every submission.</p></div>
<div class="card"><span class="u">https://answered.reddenda.com/privacy · /terms · /recording</span><span class="tag blue">staged</span>
<p>The legal cluster: the texting rules with the carrier-required no-sharing clause, the entire bill enumerated as a ledger, and the page a recorded caller can be sent to. Written and verified, ships with the next integration deploy.</p></div>

<h2>The phone</h2>
<div class="card"><span class="u">+1 (916) 350-4869</span><span class="tag">live</span>
<p>The demo line. Riley answers as Cedar Ridge Plumbing and Air, a clearly fictional demo shop. First sentence always: AI assistant, call recorded. It will not quote prices, will not take card numbers, sends real emergencies to 911, and answers honestly when asked if it is an AI or a demo. Call it and try to break it, that is what it is for.</p>
<p class="k">This number is Answered's own, bought fresh. It is not connected to any other platform's numbers and never will be. A real test call is placed through the whole path every two hours (the canary); two fails in a row and every call button on the site removes itself automatically.</p></div>

<h2>The machinery (functions)</h2>
<table>
<tr><th>URL</th><th>What it does</th></tr>
<tr><td class="u">/api/interest</td><td>The form handler. Emails David, HubSpot upsert with lead score + note + task, autoresponder to the submitter. Fails loud, never silently.</td></tr>
<tr><td class="u">/api/demo-health</td><td>GET returns JSON: healthy true or false with four checks (ElevenLabs subscription, the reasoning bridge, the Twilio number, the canary record), each reporting landed and ok separately. The front end shows call buttons only on green. Check it any time.</td></tr>
<tr><td class="u">/api/event</td><td>The measurement collector. Pages send events (track flips, form submits, demo calls) so the funnel is measured, not guessed. Stores on Netlify Blobs, IP hashed, no cookies, no third parties.</td></tr>
<tr><td class="u">/api/answered-brain</td><td>The demo line's reasoning. ElevenLabs sends the conversation here; it thinks with Claude and every sentence passes ten hard guard floors before it is spoken. Bearer-secret protected, 401 to anyone else.</td></tr>
<tr><td class="u">/api/answered-voice</td><td>The Twilio webhook for the demo number. Health-gates ElevenLabs, falls back to an honest spoken message if anything is down. Never dead air.</td></tr>
<tr><td class="u">answered-canary</td><td>Scheduled, every 2 hours: places a REAL call to the demo line, finds the conversation on the platform, and asserts the first sentence contained the AI disclosure. Result feeds /api/demo-health.</td></tr>
<tr><td class="u">answered-keepwarm</td><td>Scheduled, every 5 minutes: warm pings so the first caller of the hour never hits a cold start.</td></tr>
</table>

<h2>How deploys work here</h2>
<div class="card"><p>Run <span class="u">python3 _build.py</span> in the repo first, always. It regenerates pricing/recover/trust/thanks from templates (hand edits to those four get overwritten), normalizes the menu and footer everywhere, rewrites links extensionless, stamps content-hashed ?v= versions on the css and js, and REFUSES to build if a price is hedged, the 15% is missing, or a recovery share outside the sanctioned tiers appears anywhere, including the audio narration transcript.</p>
<p>Deploy from a clean staging copy, never from the repo folder, with the site id spelled out: static files as the publish dir, functions separately with node_modules installed. Commit and push to github.com/dhitch11/answered as you go. After any deploy, open the live pages in a real browser at phone and desktop widths and look at them.</p></div>

<h2>Where the deeper records live</h2>
<div class="card"><p class="k">The redesign verdict and build plan: <span class="u">~/answered-handoff/REDESIGN-VERDICT-2026-08-12.md</span> · the original war-room corpus: <span class="u">~/answered-handoff/</span> · coordination: <span class="u">~/reimburseos-v3-build/.terminal-claims.md</span> (search @ANSWERED) · this page: <span class="u">netlify/functions/site-directory.js</span>, content lives inside the function on purpose, it is never a static file. Secrets are named in env vars only; the credentials vault holds values.</p></div>
</body></html>`;
}

exports.handler = async (event) => {
  const headers = {};
  for (const k in (event.headers || {})) headers[k.toLowerCase()] = event.headers[k];

  if (!PIN || !SECRET) {
    console.error('site-directory: ANSWERED_DIRECTORY_PIN or ANSWERED_BRAIN_SECRET not set; refusing (fail closed).');
    return { statusCode: 503, headers: BASE_HEADERS, body: gatePage('The gate is not configured. Nothing is served without it.') };
  }

  if (event.httpMethod === 'POST') {
    const body = String(event.body || '');
    const m = /(?:^|&)pin=([^&]*)/.exec(body);
    const given = m ? decodeURIComponent(m[1].replace(/\+/g, ' ')).trim() : '';
    if (pinMatches(given)) {
      return {
        statusCode: 200,
        headers: { ...BASE_HEADERS, 'Set-Cookie': `${COOKIE}=${makeToken()}; HttpOnly; Secure; SameSite=Strict; Path=/internal; Max-Age=${TTL_MS / 1000}` },
        body: directoryPage(),
      };
    }
    await new Promise((r) => setTimeout(r, 600)); // wrong answers arrive slowly
    return { statusCode: 401, headers: BASE_HEADERS, body: gatePage('Not it. Try again.') };
  }

  if (event.httpMethod === 'GET') {
    const cookies = String(headers.cookie || '');
    const cm = new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)').exec(cookies);
    if (cm && tokenValid(cm[1])) {
      return { statusCode: 200, headers: BASE_HEADERS, body: directoryPage() };
    }
    return { statusCode: 200, headers: BASE_HEADERS, body: gatePage('') };
  }

  return { statusCode: 405, headers: { ...BASE_HEADERS, Allow: 'GET, POST' }, body: 'Method not allowed' };
};
