// /internal/ops — the daily operating view.
//
// WHAT THIS IS FOR. The cockpit is where calls are worked. This is the page you
// open first, once a day, on a phone, to answer one question: is anything
// broken, and if it is, what do I do about it. Everything on it is measured at
// the moment you load it. Nothing on it is remembered from a better day.
//
// GATED SERVER-SIDE, same posture as /internal and /internal/cockpit: not one
// byte of the operating view is serialized before the PIN check passes. The
// anonymous response is a form. That is the /competitors lesson, where a CSS
// curtain over already sent bytes protected nothing and 303,451 bytes were
// readable by any anonymous curl.
//
// IT ACCEPTS THE COCKPIT COOKIE TOO, on purpose. Both cookies are minted by the
// same PIN and signed with the same key, so honouring a cockpit session here
// grants nothing the PIN would not. The direction only goes one way: this page
// is read only, and the cockpit, which can dial, does NOT accept this page's
// cookie. Higher privilege opens the lower view, never the reverse.
//
// NO KEYBOARD SHORTCUTS AND NO PARTIAL RE-RENDER, deliberately. A lane in this
// repo shipped a 2.5s poll that called innerHTML on a region containing an
// input; focus fell back to BODY, a keyboard guard stopped matching, and typing
// a campaign name fired barge and then hangup on a live call. Refresh here is a
// full navigation and there is nothing to type into.

import {
  collect, summarize, ENV_SPEC, SWITCH_SPEC,
} from './lib/ops-status.mjs';
import {
  BASE_HEADERS, mintCookie, cookieValid, pinValid, configured, readCookie, setCookieHeader, slow,
} from './lib/gate-auth.mjs';

const COOKIE = 'ans_ops';
const COCKPIT_COOKIE = 'ans_cockpit';
const SELF = '/internal/ops';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── style. Dark, dense, readable on a phone at arm's length in a truck ───────
const CSS = `*{margin:0;padding:0;box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{background:#0B0C0E;color:#F2F4F0;font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;padding:22px 16px 80px;max-width:1000px;margin:0 auto;overflow-wrap:break-word}
h1{font-size:24px;line-height:1.2;margin:0 0 4px;letter-spacing:-.01em}
h2{font-size:17px;margin:32px 0 10px;color:#E3FF4F;letter-spacing:.01em}
h3{font-size:15px;margin:0 0 6px}
p{margin:7px 0}
a{color:#37C8F0}
.k{color:#8B939C;font-size:13.5px}
.u{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13.5px;color:#E3FF4F;word-break:break-all}
.card{background:#16181C;border:1px solid #23262c;border-radius:10px;padding:14px 15px;margin:10px 0}
.card.red{border-color:#FF3355;background:#1c1416}
.card.amber{border-color:#E3A21F;background:#1b1813}
.card.green{border-color:#2c7a4b;background:#121814}
.verdict{border-radius:12px;padding:16px 16px 14px;margin:14px 0 6px;border:2px solid}
.verdict.red{border-color:#FF3355;background:#20090f}
.verdict.amber{border-color:#E3A21F;background:#1e1708}
.verdict.green{border-color:#3ED07E;background:#0c1a12}
.big{font-size:21px;font-weight:700;line-height:1.25;margin:0 0 4px}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;vertical-align:1px;flex:0 0 auto}
.dot.red{background:#FF3355}.dot.amber{background:#E3A21F}.dot.green{background:#3ED07E}.dot.grey{background:#4A5058}
ul{margin:8px 0 2px;padding-left:0;list-style:none}
li{margin:8px 0;display:flex;gap:9px;align-items:flex-start}
/* A flex item will not shrink below its own min-content width unless it is told
   it may. Without this, a long <code> run inside a runbook line pushed the page
   6px wider than a 320px viewport and the whole document scrolled sideways.
   Measured in a real browser at 320px; every geometry assertion above the
   element passed, which is why the screenshot is the check that matters. */
li>span{min-width:0;flex:1 1 auto}
.tag{display:inline-block;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:#0B0C0E;background:#E3FF4F;border-radius:4px;padding:2px 7px;font-weight:700}
.tag.red{background:#FF3355;color:#fff}.tag.amber{background:#E3A21F}.tag.grey{background:#3A4048;color:#C9CFD6}.tag.green{background:#3ED07E}
.row{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:baseline;margin:5px 0}
.grid{display:grid;grid-template-columns:1fr;gap:8px}
@media(min-width:720px){.grid{grid-template-columns:1fr 1fr}}
.mono-row{display:flex;gap:10px;align-items:baseline;padding:5px 0;border-bottom:1px solid #1E2126;flex-wrap:wrap}
.mono-row:last-child{border-bottom:0}
.st{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;min-width:44px;color:#8B939C}
.pill{font-size:12px;border:1px solid #2a2e35;border-radius:20px;padding:2px 9px;color:#B6BDC5}
/* display:block is load bearing. This is a <span>, so it inherits inline
   layout, and inline boxes ignore vertical margin and do not start a new line.
   The runbook then ran on from the end of the red sentence as one wall of text
   and read as part of it. Every assertion passed. The screenshot is what
   caught it. */
.fix{display:block;margin-top:8px;padding:10px 12px;background:#0E1013;border-left:3px solid #37C8F0;border-radius:0 6px 6px 0;font-size:14px;color:#C9CFD6}
.fix b{color:#F2F4F0}
.fix code,code{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;background:#0B0C0E;border:1px solid #262a30;border-radius:4px;padding:1px 5px;color:#E3FF4F;word-break:break-all;overflow-wrap:anywhere}
.fix,.fix *{min-width:0}
button,.btn{background:#E3FF4F;color:#0B0C0E;border:0;border-radius:8px;font-size:15px;font-weight:700;padding:11px 18px;cursor:pointer;font-family:inherit;text-decoration:none;display:inline-block}
button.ghost{background:transparent;color:#E3FF4F;border:1px solid #3d4450}
input{background:#16181C;border:1px solid #2a2e35;border-radius:8px;color:#F2F4F0;font-size:18px;padding:12px 14px;width:200px;letter-spacing:.2em;text-align:center;font-family:inherit}
.foot{margin-top:34px;padding-top:14px;border-top:1px solid #23262c}
#alertout{margin-top:9px;font-size:14px}`;

function shell(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title><style>${CSS}</style></head><body>${inner}</body></html>`;
}

function LOGIN(msg) {
  return shell('Answered, operations', `<h1>Operations</h1>
<p class="k">This page is for the team. Enter the PIN.</p>
${msg ? `<p style="color:#FF3355;margin-top:10px">${esc(msg)}</p>` : ''}
<form method="POST" style="margin-top:18px"><input name="pin" type="password" inputmode="numeric" autocomplete="off" autofocus aria-label="PIN"><button type="submit" style="margin-left:10px">Open</button></form>`);
}

// ── the runbook. What to do, for each thing that can be wrong ────────────────
// Keyed by a substring of the red line, so a red always arrives with its fix
// attached rather than sending someone hunting through a separate document.
const RUNBOOK = [
  { match: '@netlify/blobs failed to load', title: 'The blobs package is missing from the deployed bundle',
    body: 'This is a packaging fault, not an outage. The dependency is declared in <code>netlify/functions/package.json</code> and the deploy has to install it. Run <code>npm install</code> inside <code>netlify/functions</code>, make sure the staged copy carries <code>netlify/functions/node_modules</code>, and deploy again with the repo layout mirrored. Until it is fixed the canary cannot write, the event collector cannot write, and the site wide gate stays red, which hides every call button on the site.' },
  { match: 'no canary has ever run', title: 'The canary has never produced a record',
    body: 'Either the scheduled function is not deployed, or it cannot load its dependency and is dying before its first line. Check the function log for <code>ANSWERED CANARY</code>. If the log is empty the function is not running at all. The canary is scheduled at <code>0 */2 * * *</code>, so a fresh deploy can wait up to two hours for its first run.' },
  { match: 'canary record is', title: 'The canary has gone stale',
    body: 'The scheduled run stopped. The gate goes red after three hours by design, because a monitor that stopped reporting is not a monitor that is happy. Check the scheduled function logs first, then check that the Twilio and ElevenLabs credentials still work.' },
  { match: 'canary FAILED', title: 'A real call was placed and it did not pass',
    body: 'This is the serious one, because it means the whole seam was exercised and something in it is wrong. Read the reason on the canary card below, it names the exact probe that failed. Then call <span class="u">+1 (916) 350-4869</span> yourself and listen to the first sentence.' },
  { match: 'RESEND_API_KEY', title: 'Nothing can email',
    body: 'Two things break at once. The interest form on /pricing returns 503 to every person who fills it in, and this operations watch cannot tell anyone that anything is wrong. Set <code>RESEND_API_KEY</code> in the Netlify environment for this project from the credentials vault. Do not paste it anywhere else.' },
  { match: 'NOT DEPLOYED', title: 'A route answers 404',
    body: 'The page or function is in the repo but not in the deploy. Deploy from a clean staged copy that mirrors the repo layout, with <code>netlify/functions</code> passed as the functions directory. A flattened functions directory also breaks the cockpit, which imports across directories.' },
  { match: 'THE GATE IS LEAKING', title: 'An internal page is serving its content to strangers',
    body: 'Stop and fix this before anything else. Something is being rendered before the PIN check instead of after it. The rule has no exceptions: if the bytes reach the browser, the page is public, and a noindex header on public bytes is a request, not a control.' },
  { match: 'ALERTING IS UNARMED', title: 'The watch cannot raise its hand',
    body: 'Everything below may be green and you would still not be told when it stops being green. Set <code>RESEND_API_KEY</code>. Until then this page is the only monitor, and it only works when somebody opens it.' },
  { match: 'ANSWERED_ONBOARD_AGENT_ID', title: 'There is no agent to answer a signup call',
    body: 'Create the setup agent in ElevenLabs, then set <code>ANSWERED_ONBOARD_AGENT_ID</code>. It must NOT be the same id as <code>ANSWERED_EL_AGENT_ID</code>, or a real customer signup would be answered by the demo persona from the fictional plumbing shop.' },
  { match: 'ANSWERED_COCKPIT_KEY', title: 'The internal cookie is signed with a key a vendor holds',
    body: 'The fallback key is the bearer token pasted into the ElevenLabs custom LLM configuration, and they transmit it on every conversational turn. Anyone holding it could mint an operator session that places calls. Set <code>ANSWERED_COCKPIT_KEY</code> to a fresh random value of our own.' },
  { match: 'TWILIO_AUTH_TOKEN', title: 'Webhook signatures are not being verified',
    body: 'The account authenticates with an API key pair, and the account auth token cannot be read back through key auth, so the HMAC check has nothing to sign with. The code degrades loudly to an AccountSid cross check and logs it every time. It is a known posture. Add the auth token to the environment to upgrade to full verification.' },
];

function runbookFor(line) {
  return RUNBOOK.find((r) => line.includes(r.match)) || null;
}

// ── rendering ────────────────────────────────────────────────────────────────
function verdictBlock(v, s) {
  const when = new Date(s.at).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const lines = [
    ...v.reds.map((t) => ({ level: 'red', t })),
    ...v.ambers.map((t) => ({ level: 'amber', t })),
  ];
  return `<div class="verdict ${v.level}">
<p class="big"><span class="dot ${v.level}"></span>${esc(v.headline)}</p>
<p class="k">Measured just now, ${esc(when)}. Nothing on this page is cached from earlier.</p>
${lines.length ? `<ul>${lines.map((l) => {
    const rb = runbookFor(l.t);
    return `<li><span class="dot ${l.level}" style="margin-top:6px"></span><span><b>${esc(l.t)}</b>${
      rb ? `<span class="fix"><b>${esc(rb.title)}.</b> ${rb.body}</span>` : ''}</span></li>`;
  }).join('')}</ul>` : '<p>No red lines and no amber lines. Go and sell something.</p>'}
</div>`;
}

function gateBlock(s) {
  const g = s.gate;
  if (!g.landed) {
    return `<div class="card red"><h3><span class="dot red"></span>The health gate could not be read</h3>
<p class="k">${esc(g.reason || 'no reason given')}</p>
<p class="k">This is the single most important endpoint on the site. Every call control reads it. If it is unreachable, treat the site as down.</p></div>`;
  }
  const checks = Object.entries(g.checks || {});
  return `<div class="card ${g.healthy ? 'green' : 'red'}">
<h3><span class="dot ${g.healthy ? 'green' : 'red'}"></span>The site wide call gate is ${g.healthy ? 'GREEN' : 'RED'}</h3>
<p class="k">${g.healthy
    ? 'Call controls render across the site. The demo number is visible where it belongs.'
    : 'Every health gated call control on the site is hiding itself right now. This is correct behaviour for a broken check, and it means visitors cannot see the demo number.'}</p>
<p class="k" style="margin-top:6px">One click activation is <b>${g.outbound_ready ? 'ready' : 'not ready'}</b>, which is a separate gate on purpose. An unset activation variable must never take the site's main call to action dark.</p>
${checks.map(([name, c]) => {
    const good = c && c.landed && c.ok;
    const parts = c && c.parts ? Object.entries(c.parts) : [];
    return `<div class="mono-row"><span class="dot ${good ? 'green' : (c && c.landed ? 'red' : 'grey')}"></span>
<span class="u" style="min-width:140px">${esc(name)}</span>
<span class="pill">${c && c.landed ? 'ran' : 'never ran'}</span>
<span class="pill">${good ? 'yes' : 'no'}</span>
<span class="k" style="flex:1 1 240px">${esc((c && c.reason) || (good ? '' : 'no reason given'))}</span>
${parts.length ? `<span class="k" style="flex:1 1 100%;padding-left:20px">${parts.map(([pn, p]) =>
      `${esc(pn)}: ${p.landed && p.ok ? 'ok' : esc(p.reason || 'not ok')}`).join(' &middot; ')}</span>` : ''}
</div>`;
  }).join('')}
<p class="k" style="margin-top:8px">Two booleans per check, never one. <b>ran</b> means the check completed and got an answer. <b>yes</b> means what the answer said. A check that never ran is never counted as a pass.</p>
</div>`;
}

function canaryBlock(s) {
  const c = s.canary;
  const head = `<h3><span class="dot ${c.ok ? 'green' : (c.landed ? 'red' : 'grey')}"></span>The real call canary</h3>
<p class="k">Every two hours this places a genuine phone call to the demo line, finds the conversation on the platform, and asserts the very first sentence contained both "AI assistant" and "recorded". It is the only check that exercises the whole seam. Everything else tests a part.</p>`;
  if (!c.latest) {
    return `<div class="card ${c.landed ? '' : 'red'}">${head}
<p style="margin-top:10px"><b>There is no canary record at all.</b> ${esc(c.reason || '')}</p>
${c.fix ? `<p class="fix">${c.fix}</p>` : ''}
<p class="k">This is an honest empty state. It is not a pass, and the gate treats it as red.</p></div>`;
  }
  const L = c.latest;
  const P = c.prev;
  const probes = Object.entries(L.probes || {});
  return `<div class="card ${c.ok ? 'green' : 'red'}">${head}
<div class="row" style="margin-top:10px">
<span class="tag ${L.ok ? 'green' : 'red'}">${L.ok ? 'last run passed' : 'last run failed'}</span>
<span class="k">${esc(String(L.at || '').replace('T', ' ').slice(0, 19))} UTC, ${c.age_minutes == null ? 'age unknown' : esc(c.age_minutes + ' minutes ago')}</span>
${P ? `<span class="pill">the run before it ${P.ok ? 'passed' : 'failed'}</span>` : '<span class="pill">no earlier run on file</span>'}
${L.store_writable === false ? '<span class="tag red">this result was never saved</span>' : ''}
</div>
${L.reason ? `<p style="margin-top:8px">${esc(L.reason)}</p>` : ''}
${probes.map(([n, p]) => `<div class="mono-row"><span class="dot ${p.landed && p.ok ? 'green' : (p.landed ? 'red' : 'grey')}"></span>
<span class="u" style="min-width:150px">${esc(n)}</span>
<span class="pill">${p.landed ? 'ran' : 'never ran'}</span><span class="pill">${p.ok ? 'yes' : 'no'}</span>
<span class="k" style="flex:1 1 200px">${esc(p.reason || '')}</span></div>`).join('')}
${L.call_sid ? `<p class="k" style="margin-top:8px">Twilio call <span class="u">${esc(L.call_sid)}</span>${L.conversation_id ? `, conversation <span class="u">${esc(L.conversation_id)}</span>` : ''}</p>` : ''}
${c.history && c.history.length ? `<p class="k" style="margin-top:8px">${c.history.length} earlier run${c.history.length === 1 ? '' : 's'} on file. Newest first: ${c.history.slice(0, 6).map((k) => esc(k.replace('history/', '').replace(/-/g, ':').slice(0, 16))).join(', ')}</p>` : ''}
</div>`;
}

function routesBlock(s) {
  if (!s.routes.length) return '';
  const bad = s.routes.filter((r) => !r.skipped && !r.ok);
  const good = s.routes.filter((r) => r.skipped || r.ok);
  const row = (r) => `<div class="mono-row"><span class="dot ${r.ok ? 'green' : 'red'}"></span>
<span class="st">${r.skipped ? '&mdash;' : esc(String(r.status == null ? 'none' : r.status))}</span>
<span class="u" style="min-width:170px">${esc(r.path)}</span>
<span class="k" style="flex:1 1 220px">${esc(r.reason || r.what)}</span>
${r.skipped ? '' : `<span class="pill">${esc(r.ms)}ms</span>`}</div>`;
  return `<div class="card ${bad.length ? 'red' : 'green'}">
<h3><span class="dot ${bad.length ? 'red' : 'green'}"></span>${s.routes.length} routes, ${bad.length} not answering properly</h3>
<p class="k">Real requests, made from this function, just now. A 405 or a 401 from a POST only or gated endpoint is a pass: it proves the route is deployed and reachable. It does not prove the endpoint works, and this page does not claim it does. That is what the canary and a real call are for.</p>
${bad.length ? `<div style="margin-top:10px">${bad.map(row).join('')}</div><p class="k" style="margin-top:10px">Everything else:</p>` : ''}
<div>${good.map(row).join('')}</div></div>`;
}

function envBlock(s) {
  const { vars, switches, orphans } = s.env;
  const missing = vars.filter((v) => !v.set);
  const present = vars.filter((v) => v.set);
  return `<div class="card ${missing.some((m) => m.severity === 'red') ? 'red' : (missing.length ? 'amber' : 'green')}">
<h3><span class="dot ${missing.some((m) => m.severity === 'red') ? 'red' : (missing.length ? 'amber' : 'green')}"></span>Configuration: ${present.length} of ${vars.length} set</h3>
<p class="k">Names only. This page reads the environment to answer "is it set" and returns a yes or a no. It cannot print a value, a prefix, a length or a last four, by construction. Values live in the credentials vault.</p>
${missing.length ? `<p style="margin-top:10px"><b>Not set:</b></p>${missing.map((v) => `<div class="mono-row">
<span class="tag ${v.severity === 'red' ? 'red' : (v.severity === 'amber' ? 'amber' : 'grey')}">${esc(v.severity === 'note' ? 'fine' : v.severity)}</span>
<span class="u" style="min-width:210px">${esc(v.name)}</span>
<span class="k" style="flex:1 1 240px">${esc(v.unset)}</span></div>`).join('')}` : '<p style="margin-top:10px">Everything this code reads is set.</p>'}
<p class="k" style="margin-top:12px">Set: ${present.map((v) => `<span class="u">${esc(v.name)}</span>`).join(', ') || 'none'}</p>
${orphans.length ? `<p class="k" style="margin-top:10px"><b style="color:#E3A21F">Set but read by nothing in this repo:</b> ${orphans.map((o) => `<span class="u">${esc(o)}</span>`).join(', ')}. That is exposure with no benefit. Either something is meant to use it, or it should be removed.</p>` : ''}
<h3 style="margin-top:16px">The switches that silently change behaviour</h3>
${switches.map((sw) => `<div class="mono-row"><span class="dot ${sw.engaged ? 'amber' : 'grey'}"></span>
<span class="u" style="min-width:210px">${esc(sw.name)}</span>
<span class="tag ${sw.engaged ? 'amber' : 'grey'}">${sw.engaged ? 'engaged' : 'not set'}</span>
<span class="k" style="flex:1 1 240px">${esc(sw.engaged ? sw.on : sw.off)}</span>
<span class="k" style="flex:1 1 100%;padding-left:20px">${esc(sw.trap)}</span></div>`).join('')}
</div>`;
}

function alertBlock(s) {
  if (!s.alerting.armed) {
    // A control that cannot act must never render. There is no test button here
    // because pressing it could not send anything.
    return `<div class="card red"><h3><span class="dot red"></span>Alerting is unarmed</h3>
<p>${esc(s.alerting.reason)}</p>
<p class="k">There is deliberately no test button on this card, because pressing it could not send anything, and a control that cannot act must never render.</p></div>`;
  }
  return `<div class="card green"><h3><span class="dot green"></span>Alerting is armed</h3>
<p class="k">The scheduled watch emails David@Reddenda.com when the state CHANGES, not on every run. A problem that is still there does not email again, and a recovery does email, because "it is fixed" is news too.</p>
<p style="margin-top:10px"><button id="testalert" type="button">Send a test alert now</button></p>
<div id="alertout" class="k"></div></div>`;
}

function deployBlock() {
  const rows = [
    ['Commit', process.env.COMMIT_REF],
    ['Branch', process.env.BRANCH],
    ['Context', process.env.CONTEXT],
    ['Deploy id', process.env.DEPLOY_ID],
    ['Site', process.env.SITE_NAME],
    ['URL', process.env.URL],
  ].filter((r) => r[1]);
  return `<div class="card"><h3>What is actually live</h3>
${rows.length ? rows.map(([k, v]) => `<div class="mono-row"><span class="k" style="min-width:90px">${esc(k)}</span><span class="u">${esc(v)}</span></div>`).join('')
    : '<p class="k">The platform did not supply build identity variables to this function, so this page cannot tell you which commit is live. Read the deploy id from the claims file instead.</p>'}
<p class="k" style="margin-top:8px">Repo github.com/dhitch11/answered, Netlify site id 2c9f4ae6-f61c-4c1f-96ba-2a467fec00f3.</p></div>`;
}

// The honest ledger. The standing order is that nothing is removed from the
// site because it is not built. So it is written down here instead, where the
// person selling it can see it before a customer does.
function notBuiltBlock() {
  return `<div class="card amber"><h3><span class="dot amber"></span>Sold on the site, not built yet</h3>
<p class="k">Nothing here is a reason to take a page down. It is a reason to know what you are promising before you promise it.</p>
<ul>
<li><span class="dot amber" style="margin-top:6px"></span><span><b>There is no billing.</b> No Stripe integration, no card capture, no invoice. Prices are published and nothing in this codebase can charge anyone. A customer who says yes today pays by whatever you arrange by hand.</span></li>
<li><span class="dot amber" style="margin-top:6px"></span><span><b>There are no customer accounts.</b> A contractor who signs up today cannot get his own number, his own agent, or his own rules from this system. This is the widest gap between what the site markets and what exists.</span></li>
<li><span class="dot amber" style="margin-top:6px"></span><span><b>Texting is carrier blocked.</b> The A2P campaign has been rejected three times. Until one passes, no surface may say a text will arrive. Every text path degrades to a labelled email fallback. The known root cause is a contradiction on the brand's registered website, which describes a different messaging program from a different number.</span></li>
</ul></div>`;
}

function runbookBlock() {
  return `<div class="card"><h3>The runbook</h3>
<p class="k">Every red line at the top of this page already carries its own fix. This is the same set in one place, plus the two things that are always true.</p>
${RUNBOOK.map((r) => `<div style="margin:12px 0"><b>${esc(r.title)}</b><div class="fix">${r.body}</div></div>`).join('')}
<div style="margin:14px 0"><b>The deploy, every time</b><div class="fix">Run <code>python3 _build.py</code> first, always. Stage a clean copy that MIRRORS THE REPO LAYOUT, meaning the static files, <code>netlify/functions/</code> and <code>research/</code> and <code>netlify.toml</code> all sitting where they sit in the repo. Run <code>npm install</code> inside <code>netlify/functions</code>. Then deploy with the site id spelled out. A flattened functions directory breaks the cockpit, which imports across directories, and it strips the dependency the canary and the event collector need.</div></div>
<div style="margin:14px 0"><b>Before you believe anything is fixed</b><div class="fix">A 200, a green deploy and a passing assertion are not evidence. Reload this page and read the measurement. For the phone, call <span class="u">+1 (916) 350-4869</span> and listen to the first sentence yourself. Test calls go to the estate QA number <span class="u">+1 (916) 866-3918</span> and never to a stranger.</div></div>
</div>`;
}

function PAGE(s, v) {
  return shell('Answered, operations', `
<h1>Operations</h1>
<p class="k">The one page to open first. Everything on it was measured when you loaded it.</p>
${verdictBlock(v, s)}
<h2>The gate everything reads</h2>
${gateBlock(s)}
<h2>The phone, proved by a real call</h2>
${canaryBlock(s)}
<h2>Alerting</h2>
${alertBlock(s)}
<h2>Every route on the site</h2>
${routesBlock(s)}
<h2>Configuration</h2>
${envBlock(s)}
<h2>What is live</h2>
${deployBlock()}
<h2>Honest ledger</h2>
${notBuiltBlock()}
<h2>Runbook</h2>
${runbookBlock()}
<div class="foot">
<p><a class="btn" href="${SELF}">Measure again</a>
<a class="btn" href="/internal/cockpit" style="background:transparent;color:#E3FF4F;border:1px solid #3d4450;margin-left:8px">Cockpit</a>
<a class="btn" href="/internal" style="background:transparent;color:#E3FF4F;border:1px solid #3d4450;margin-left:8px">Directory</a></p>
<p class="k" style="margin-top:12px">This view is read only. It cannot dial, cannot text, cannot change a price and cannot spend money. The one thing it can do is send a test alert to David, and only when alerting is armed.</p>
</div>
<script>
(function(){
  var b=document.getElementById('testalert');
  if(!b) return;
  var out=document.getElementById('alertout');
  b.addEventListener('click',function(){
    b.disabled=true; out.textContent='Sending.';
    fetch('${SELF}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'testalert'})})
      .then(function(r){return r.json().then(function(j){return {s:r.status,j:j};});})
      .then(function(x){
        out.textContent = x.s===200 ? ('Sent. Resend accepted it, id '+(x.j.id||'unknown')+'. Check the inbox, delivery is the only proof.')
                                    : ('Not sent. '+(x.j.error||('HTTP '+x.s)));
        b.disabled=false;
      })
      .catch(function(e){ out.textContent='Not sent. '+e.message; b.disabled=false; });
  });
})();
</script>`);
}

// ── the test alert. Real send, real reported failure ────────────────────────
async function sendTestAlert(base) {
  const key = (process.env.RESEND_API_KEY || '').trim();
  if (!key) return { statusCode: 503, body: { error: 'RESEND_API_KEY is not set, so nothing can be sent.' } };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Answered Operations <info@reddenda.com>',
        to: ['David@Reddenda.com'],
        subject: 'Answered operations: test alert, nothing is wrong',
        text: 'Somebody pressed the test button on ' + base + SELF + '.\n\n'
          + 'This proves the alert path works end to end. It is not a report about the site.\n'
          + 'Real alerts only arrive when the state CHANGES, and they say what changed and what to do.\n',
      }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { statusCode: 502, body: { error: 'Resend answered ' + r.status + '. ' + String(j.message || '').slice(0, 160) } };
    return { statusCode: 200, body: { ok: true, id: j.id || null } };
  } catch (e) {
    return { statusCode: 502, body: { error: 'the request never completed: ' + String(e && e.message).slice(0, 140) } };
  }
}

// ── handler ──────────────────────────────────────────────────────────────────
export const handler = async (event) => {
  if (!configured()) {
    console.error('ops: ANSWERED_DIRECTORY_PIN or the cookie key is not set; refusing (fail closed).');
    return { statusCode: 503, headers: BASE_HEADERS, body: LOGIN('This page is not configured. Nothing is served without the gate.') };
  }

  const authed = cookieValid(COOKIE, readCookie(event.headers, COOKIE))
    || cookieValid(COCKPIT_COOKIE, readCookie(event.headers, COCKPIT_COOKIE));
  const ctype = String(event.headers['content-type'] || event.headers['Content-Type'] || '');
  const isJson = ctype.includes('application/json');

  // sign in
  if (event.httpMethod === 'POST' && !isJson) {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
    if (pinValid(new URLSearchParams(raw).get('pin'))) {
      const s = await collect({ event, timeoutMs: 5000, selfPath: SELF });
      return {
        statusCode: 200,
        headers: { ...BASE_HEADERS, 'Set-Cookie': setCookieHeader(COOKIE, mintCookie(COOKIE)) },
        body: PAGE(s, summarize(s)),
      };
    }
    await slow();
    return { statusCode: 401, headers: BASE_HEADERS, body: LOGIN('Not it. Try again.') };
  }

  if (!authed) {
    if (isJson) {
      return { statusCode: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: 'not signed in' }) };
    }
    return { statusCode: 200, headers: BASE_HEADERS, body: LOGIN() };
  }

  // signed in, JSON operations
  if (event.httpMethod === 'POST' && isJson) {
    let body = {};
    try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body || '{}')); }
    catch { body = {}; }
    const jsonHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    if (body.op === 'testalert') {
      const r = await sendTestAlert(siteOf(event));
      return { statusCode: r.statusCode, headers: jsonHeaders, body: JSON.stringify(r.body) };
    }
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'unknown op' }) };
  }

  const s = await collect({ event, timeoutMs: 5000, selfPath: SELF });
  const v = summarize(s);

  // A machine readable form of the same measurement, for a verifier or a
  // terminal. Same collector, so it can never disagree with the page.
  const wantsJson = String(event.queryStringParameters?.format || '') === 'json';
  if (wantsJson) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
      body: JSON.stringify({ verdict: v, ...s }, null, 2),
    };
  }

  return { statusCode: 200, headers: BASE_HEADERS, body: PAGE(s, v) };
};

function siteOf(event) {
  const h = {};
  for (const k in (event.headers || {})) h[k.toLowerCase()] = event.headers[k];
  return (process.env.URL || (h.host ? 'https://' + h.host : '')).replace(/\/+$/, '');
}
