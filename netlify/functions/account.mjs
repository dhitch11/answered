// /account : where a business owner signs in, writes the rules his line answers by, and asks for
// a number.
//
// FIVE THINGS ABOUT THIS FILE
//
// 1. IT IS RENDERED ON THE SERVER, AFTER THE CHECK. Nothing belonging to an account is put into a
//    string until the session cookie has been verified. The estate has already paid for the other
//    approach: a CSS "PIN curtain" over a page the server had already sent in full, 303,451 bytes
//    readable by any anonymous curl. If the bytes reach the browser, the page is public.
//
// 2. IT WORKS WITH JAVASCRIPT OFF. Every control is a form that posts and redirects. A contractor
//    on a bad connection in a truck is the user, and there is no state in this page that needs a
//    script to be correct.
//
// 3. IT NEVER CLAIMS A CAPABILITY WE DO NOT HAVE. Assigning a phone number is a human step today.
//    The page says that, in those words, instead of showing a spinner that means nothing. When
//    there is no number yet, it says there is no number yet.
//
// 4. THE RULES AND THE WORDS ARE THE SAME OBJECT. The page prints the exact instructions the line
//    runs under, rendered from the stored fields by lib/accounts.mjs. An owner reads what his
//    phone actually says, not a description of it.
//
// 5. `missing` IS NEVER RECOMPUTED HERE. It arrives from the database so the page, the gate and
//    the operator list cannot disagree.

import {
  getAccount, saveConfig, requestLine, consumeToken, renderSpec, renderGreeting,
  STATE_TEXT, humanMissing, dbConfigured,
} from './lib/accounts.mjs';
import {
  readSession, mintSession, setCookie, clearCookie, readCookie, hashToken,
  configured as authConfigured, PRIVATE_HEADERS, html, json, slow, clientIp,
} from './lib/account-auth.mjs';
import { logAccountToHubSpot, notifyOperator } from './lib/account-notify.mjs';

const h = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const DAYS = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'],
  ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];

// ── the shell ────────────────────────────────────────────────────────────────────────────────

const CSS = `
*{box-sizing:border-box}
body{margin:0;background:#0B0C0E;color:#F2F4F0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:52rem;margin:0 auto;padding:2rem 1.25rem 5rem}
header{display:flex;flex-wrap:wrap;gap:1rem;align-items:baseline;justify-content:space-between;margin-bottom:2rem}
.mark{font-weight:800;letter-spacing:.14em;font-size:.9rem}
.mark b{color:#E3FF4F;font-weight:800}
h1{font-size:clamp(1.6rem,5vw,2.3rem);line-height:1.15;margin:0 0 .5rem;letter-spacing:-.02em}
h2{font-size:1.1rem;margin:0 0 .35rem;letter-spacing:-.01em}
p{margin:.4rem 0}
.muted{color:#8B939C}
.card{background:#16181C;border:1px solid #24272C;border-radius:14px;padding:1.25rem;margin:1rem 0}
.state{border-left:3px solid #E3FF4F}
.state.live{border-left-color:#37C8F0}
.state.warn{border-left-color:#FF3355}
label{display:block;font-size:.82rem;color:#8B939C;margin:.9rem 0 .3rem;letter-spacing:.02em}
input,select,textarea{width:100%;background:#0B0C0E;color:#F2F4F0;border:1px solid #2C3037;border-radius:9px;padding:.7rem .8rem;font:inherit;font-size:.95rem;min-height:44px}
textarea{min-height:6rem;resize:vertical}
input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid #E3FF4F;outline-offset:2px}
/* ★ minmax(0,1fr), never 1fr. A bare 1fr is minmax(AUTO,1fr), and the auto floor is the item's
   min-content width. An input[type=time] has a wide intrinsic minimum, so three "equal" columns
   silently grew past the viewport: 402px of content in a 390px window, with every element still
   reporting a sensible width of its own. Nothing but a screenshot and a scrollWidth read catches
   this, which is why both are in the check. */
.row{display:grid;grid-template-columns:minmax(0,1fr);gap:.6rem}
@media(min-width:600px){.row{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
.hours{display:grid;grid-template-columns:4.5rem minmax(0,1fr) minmax(0,1fr);gap:.4rem;align-items:center;margin:.4rem 0}
.hours span{font-size:.8rem;color:#8B939C}
.hours input{padding:.6rem .4rem;min-width:0}
@media(min-width:420px){.hours{grid-template-columns:5.5rem minmax(0,1fr) minmax(0,1fr);gap:.5rem}
  .hours input{padding:.7rem .8rem}.hours span{font-size:.85rem}}
button{background:#E3FF4F;color:#0B0C0E;border:0;border-radius:9px;padding:.8rem 1.4rem;font:inherit;font-weight:700;cursor:pointer;min-height:44px}
button.quiet{background:transparent;color:#8B939C;border:1px solid #2C3037;font-weight:500}
ul{margin:.4rem 0;padding-left:1.1rem}
li{margin:.2rem 0}
pre{white-space:pre-wrap;word-wrap:break-word;background:#0B0C0E;border:1px solid #24272C;border-radius:10px;padding:1rem;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#C8CDD3;overflow-x:auto}
.err{color:#FF3355}
.ok{color:#37C8F0}
.tag{display:inline-block;font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;color:#8B939C;border:1px solid #2C3037;border-radius:999px;padding:.2rem .6rem}
a{color:#E3FF4F}
hr{border:0;border-top:1px solid #24272C;margin:1.5rem 0}
`;

const page = (title, body) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>${h(title)}</title><style>${CSS}</style></head>
<body><div class="wrap"><header>
<div class="mark">ANSWERE<b>D</b></div>
<div class="muted" style="font-size:.85rem">Your account</div>
</header>${body}</div></body></html>`;

// ── the door ─────────────────────────────────────────────────────────────────────────────────

const signInPage = (msg = '', kind = '') => page('Sign in to Answered', `
<h1>Sign in</h1>
<p class="muted">Type the email you signed up with. We send a link. There is no password to remember.</p>
${msg ? `<p class="${kind === 'err' ? 'err' : 'ok'}">${h(msg)}</p>` : ''}
<div class="card">
  <form method="POST" action="/api/account/start">
    <label for="email">Your email</label>
    <input id="email" name="email" type="email" required autocomplete="email" placeholder="you@yourbusiness.com">
    <label for="business_name">Your business name</label>
    <input id="business_name" name="business_name" autocomplete="organization" placeholder="Only needed the first time">
    <p style="margin-top:1rem"><button type="submit">Send me a link</button></p>
  </form>
</div>
<p class="muted" style="font-size:.86rem">Signing in does not turn a phone line on. Nothing calls anyone until you ask for a number and a person sets it up.</p>`);

const down = (why) => page('Accounts are not available', `
<h1>Accounts are off right now</h1>
<p>This is not a page problem and it is not your fault. Sign in is turned off until an operator finishes setting it up.</p>
<p class="muted">Reason recorded: ${h(why)}</p>
<p><a href="/">Back to the site</a></p>`);

// ── the console ──────────────────────────────────────────────────────────────────────────────

function consolePage(a, flash) {
  const c = a.config || {};
  const st = STATE_TEXT[a.status] || STATE_TEXT.configuring;
  const missing = humanMissing(a.missing);
  const numbers = Array.isArray(a.numbers) ? a.numbers.filter((n) => n.status === 'provisioned') : [];
  const spec = renderSpec(a);
  const greeting = renderGreeting(a);
  const tone = a.status === 'live' ? 'live' : (missing.length ? 'warn' : '');
  const cap = ((c.monthly_cap_cents ?? 54900) / 100).toFixed(0);

  const arr = (v) => (Array.isArray(v) ? v.join('\n') : '');
  const hours = c.hours && typeof c.hours === 'object' ? c.hours : {};
  const span = (d, i) => (Array.isArray(hours[d]) && hours[d][0] ? h(hours[d][0][i] || '') : '');

  const sel = (name, value, options) => `<select id="${name}" name="${name}">`
    + options.map(([v, t]) => `<option value="${h(v)}"${v === value ? ' selected' : ''}>${h(t)}</option>`).join('')
    + '</select>';

  return page(`${a.business_name} on Answered`, `
${flash ? `<p class="${flash.kind === 'err' ? 'err' : 'ok'}">${h(flash.text)}</p>` : ''}

<h1>${h(a.business_name)}</h1>
<p class="muted">Signed in as ${h(a.owner_email)}</p>

<div class="card state ${tone}">
  <h2>${h(st.headline)}</h2>
  <p>${h(st.detail)}</p>
  <p class="muted">Next: ${h(st.next)}</p>
  ${missing.length ? `<p style="margin-top:.8rem">Still missing:</p><ul>${missing.map((m) => `<li>${h(m)}</li>`).join('')}</ul>` : ''}
</div>

<div class="card">
  <h2>Your number</h2>
  ${numbers.length
    ? `<p>Calls to <b>${h(numbers[0].phone)}</b> are answered with the rules below.</p>`
      + (numbers.length > 1 ? `<p class="muted">Also on this account: ${numbers.slice(1).map((n) => h(n.phone)).join(', ')}</p>` : '')
    : '<p>You do not have a number yet.</p>'
      + '<p class="muted">Setting a number up is done by a person right now, not by a button. That is the honest state of it today.</p>'}
  ${(!numbers.length && a.status === 'ready')
    ? `<form method="POST" action="/api/account/request-line" style="margin-top:1rem">
         <label for="area_code">Area code you want, if you have a preference</label>
         <input id="area_code" name="area_code" inputmode="numeric" maxlength="3" placeholder="916">
         <label for="note">Anything we should know</label>
         <input id="note" name="note" placeholder="Optional">
         <p style="margin-top:1rem"><button type="submit">Ask for a number</button></p>
       </form>` : ''}
  ${(!numbers.length && a.status === 'awaiting_line')
    ? `<p class="ok" style="margin-top:.8rem">You asked on ${h(new Date(a.requested_line_at).toDateString())}. We email you the moment it is on.</p>` : ''}
  ${(!numbers.length && missing.length)
    ? '<p class="muted" style="margin-top:.8rem">Finish the list above first. A line that does not know what to say should never answer a call.</p>' : ''}
</div>

<form method="POST" action="/api/account/save">
<div class="card">
  <h2>Who answers</h2>
  <div class="row">
    <div><label for="business_name">Business name</label>
      <input id="business_name" name="business_name" value="${h(a.business_name)}" required></div>
    <div><label for="greeting_name">Name of whoever answers</label>
      <input id="greeting_name" name="greeting_name" value="${h(c.greeting_name)}" placeholder="Riley"></div>
  </div>
  <label for="business_says">Say the business name like this, out loud</label>
  <input id="business_says" name="business_says" value="${h(c.business_says)}" placeholder="${h(a.business_name)}">
  <div class="row">
    <div><label for="trade">Your trade</label>
      <input id="trade" name="trade" value="${h(a.trade)}" placeholder="Plumbing"></div>
    <div><label for="owner_phone">Your mobile</label>
      <input id="owner_phone" name="owner_phone" type="tel" value="${h(a.owner_phone)}" placeholder="+19165550142"></div>
  </div>
</div>

<div class="card">
  <h2>The work you take</h2>
  <label for="services">One kind of job per line</label>
  <textarea id="services" name="services" placeholder="Water heater repair&#10;Drain clearing&#10;Leak repair">${h(arr(c.services))}</textarea>
  <label for="service_area">The area you cover</label>
  <input id="service_area" name="service_area" value="${h(c.service_area)}" placeholder="Sacramento and thirty miles around it">
</div>

<div class="card">
  <h2>Your hours</h2>
  <p class="muted" style="font-size:.86rem">Leave a day blank if you are closed.</p>
  ${DAYS.map(([d, label]) => `<div class="hours"><span>${label}</span>
    <input type="time" name="h_${d}_open" value="${span(d, 0)}" aria-label="${label} open">
    <input type="time" name="h_${d}_close" value="${span(d, 1)}" aria-label="${label} close"></div>`).join('')}
  <label for="after_hours">Outside those hours</label>
  ${sel('after_hours', c.after_hours || 'take_message', [
    ['take_message', 'Take a message and say someone calls back'],
    ['book', 'Still book for the next working day'],
    ['urgent_only', 'Emergencies only, message for everything else'],
    ['transfer', 'Offer to put an emergency through to me'],
  ])}
</div>

<div class="card">
  <h2>What happens with a job</h2>
  <label for="booking_mode">Booking</label>
  ${sel('booking_mode', c.booking_mode || 'sends_invite', [
    ['sends_invite', 'Hold the time and send it to me to confirm'],
    ['writes_directly', 'Write it straight into my calendar'],
    ['message_only', 'Do not book, just take the message'],
  ])}
  <label for="booking_destination">Where the booking goes</label>
  <input id="booking_destination" name="booking_destination" value="${h(c.booking_destination)}" placeholder="you@yourbusiness.com or a calendar link">
  <label for="always_ask">What to find out on every call, one per line</label>
  <textarea id="always_ask" name="always_ask" placeholder="their name&#10;the best number to reach them on&#10;the address&#10;what is going on">${h(arr(c.always_ask))}</textarea>
</div>

<div class="card">
  <h2>Money</h2>
  <label for="quote_policy">Prices on the phone</label>
  ${sel('quote_policy', c.quote_policy || 'never', [
    ['never', 'Never say a price'],
    ['range', 'May repeat a range I wrote down'],
    ['exact', 'May say the exact prices I wrote down'],
  ])}
  <label for="price_notes">The only pricing that may be repeated</label>
  <textarea id="price_notes" name="price_notes" placeholder="Leave blank if nobody should say a price">${h(c.price_notes)}</textarea>
  <label for="monthly_cap">Stop billing me past this much in a month, in dollars</label>
  <input id="monthly_cap" name="monthly_cap" type="number" min="0" max="100000" step="1" value="${h(cap)}">
</div>

<div class="card">
  <h2>Reaching you</h2>
  <label for="escalation_when">Put a caller through to you when</label>
  ${sel('escalation_when', c.escalation_when || 'emergency', [
    ['emergency', 'It is a real emergency'],
    ['on_request', 'They ask for a person'],
    ['always', 'Anyone who wants to'],
    ['never', 'Never, always take a message'],
  ])}
  <label for="escalation_phone">The number to ring</label>
  <input id="escalation_phone" name="escalation_phone" type="tel" value="${h(c.escalation_phone)}" placeholder="+19165550142">
  <label for="never_say">Things nobody should ever say on your line, one per line</label>
  <textarea id="never_say" name="never_say" placeholder="anything about a warranty&#10;how many trucks we run">${h(arr(c.never_say))}</textarea>
</div>

<p><button type="submit">Save my rules</button></p>
</form>

<div class="card">
  <h2>What your line says</h2>
  <span class="tag">Rendered from your rules, version ${h(c.version ?? 1)}</span>
  ${greeting ? `<p style="margin-top:.9rem">First thing a caller hears:</p><pre>${h(greeting)}</pre>` : ''}
  ${spec
    ? `<p>The full instructions your line runs under:</p><pre>${h(spec)}</pre>`
    : '<p class="muted">There is nothing to show yet. Fill in who answers and save.</p>'}
</div>

<hr>
<form method="POST" action="/account/signout"><button class="quiet" type="submit">Sign out</button></form>
`);
}

// ── form parsing ─────────────────────────────────────────────────────────────────────────────

async function readBody(req) {
  const ct = (req.headers.get('content-type') || '').toLowerCase();
  const raw = await req.text();
  if (ct.includes('application/json')) {
    try { return JSON.parse(raw || '{}'); } catch { return {}; }
  }
  const out = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 40);

/** Form fields to the patch the RPC accepts. Only named keys travel; nothing else is trusted. */
function toPatch(f) {
  const p = {};
  for (const k of ['business_name', 'greeting_name', 'business_says', 'trade', 'owner_name', 'owner_phone',
    'service_area', 'price_notes', 'booking_destination', 'escalation_phone', 'timezone',
    'after_hours', 'quote_policy', 'booking_mode', 'escalation_when']) {
    if (typeof f[k] === 'string' && f[k].trim()) p[k] = f[k].trim();
  }
  for (const k of ['services', 'never_say', 'always_ask']) {
    if (typeof f[k] === 'string') p[k] = lines(f[k]);
    else if (Array.isArray(f[k])) p[k] = f[k];
  }
  const hours = {};
  let touched = false;
  for (const [d] of DAYS) {
    const o = String(f[`h_${d}_open`] || '').trim();
    const c = String(f[`h_${d}_close`] || '').trim();
    if (`h_${d}_open` in f || `h_${d}_close` in f) touched = true;
    hours[d] = (o && c) ? [[o, c]] : [];
  }
  if (touched) p.hours = hours;
  if (f.monthly_cap !== undefined && String(f.monthly_cap).trim() !== '') {
    const n = Math.round(Number(f.monthly_cap) * 100);
    if (Number.isFinite(n) && n >= 0 && n <= 10000000) p.monthly_cap_cents = n;
  }
  if (f.hours && typeof f.hours === 'object') p.hours = f.hours;
  if (f.monthly_cap_cents !== undefined) {
    const n = Number(f.monthly_cap_cents);
    if (Number.isFinite(n) && n >= 0 && n <= 10000000) p.monthly_cap_cents = Math.round(n);
  }
  return p;
}

const seeOther = (to, extra = {}) =>
  new Response('', { status: 303, headers: { Location: to, ...PRIVATE_HEADERS, ...extra } });

const wantsJson = (req) => (req.headers.get('accept') || '').includes('application/json')
  || (req.headers.get('content-type') || '').includes('application/json');

// ── handler ──────────────────────────────────────────────────────────────────────────────────

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/account';

  if (!dbConfigured()) return html(503, down('ANSWERED_DB_URL / ANSWERED_DB_ANON / ANSWERED_DB_SECRET'));
  if (!authConfigured()) return html(503, down('ANSWERED_ACCOUNT_KEY'));

  // ── the emailed link ───────────────────────────────────────────────────────────────────────
  if (path === '/account/enter') {
    const t = url.searchParams.get('t') || '';
    if (!t) return html(400, signInPage('That link is missing its code. Ask for a new one.', 'err'));
    await slow(250);
    let r;
    try { r = await consumeToken(hashToken(t), clientIp(req)); } catch (e) {
      console.error('account enter failed:', String(e.message).slice(0, 200));
      return html(502, signInPage('We could not sign you in just now. Try the link again in a minute.', 'err'));
    }
    if (!r || !r.ok) {
      // Used, expired, or never real. All three get the same answer on purpose.
      return html(401, signInPage('That link does not work any more. Links work once and last twenty minutes. Ask for a new one.', 'err'));
    }
    return seeOther('/account', { 'Set-Cookie': setCookie(mintSession(r.account.id)) });
  }

  if (path === '/account/signout') {
    if (req.method !== 'POST') return seeOther('/account');
    return seeOther('/account', { 'Set-Cookie': clearCookie() });
  }

  // ── everything below needs a session ───────────────────────────────────────────────────────
  const accountId = readSession(readCookie(req.headers));
  if (!accountId) {
    if (path.startsWith('/api/')) return json(401, { ok: false, error: 'sign in first' });
    return html(200, signInPage());
  }

  let account;
  try { account = await getAccount(accountId); } catch (e) {
    console.error('account load failed:', String(e.message).slice(0, 200));
    return path.startsWith('/api/')
      ? json(502, { ok: false, error: 'account is unreadable right now' })
      : html(502, page('Trouble', '<h1>We cannot read your account right now</h1><p>Nothing is lost. Try again in a minute.</p>'));
  }
  if (!account) {
    // A signed cookie for an account that no longer exists. Clear it rather than loop.
    return path.startsWith('/api/')
      ? json(401, { ok: false, error: 'sign in first' }, { 'Set-Cookie': clearCookie() })
      : html(200, signInPage('Sign in again.'), { 'Set-Cookie': clearCookie() });
  }

  if (path === '/api/account/save') {
    if (req.method !== 'POST') return json(405, { ok: false, error: 'POST only' });
    const patch = toPatch(await readBody(req));
    if (!Object.keys(patch).length) {
      return wantsJson(req) ? json(400, { ok: false, error: 'nothing to save' }) : seeOther('/account?saved=empty');
    }
    let updated;
    try { updated = await saveConfig(accountId, patch, account.owner_email); } catch (e) {
      console.error('account save failed:', String(e.message).slice(0, 200));
      return wantsJson(req) ? json(502, { ok: false, error: 'save failed' }) : seeOther('/account?saved=error');
    }
    logAccountToHubSpot(updated, 'rules_saved').catch(() => {});
    return wantsJson(req) ? json(200, { ok: true, account: updated }) : seeOther('/account?saved=1');
  }

  if (path === '/api/account/request-line') {
    if (req.method !== 'POST') return json(405, { ok: false, error: 'POST only' });
    const f = await readBody(req);
    let r;
    try { r = await requestLine(accountId, f.area_code || '', f.note || ''); } catch (e) {
      console.error('line request failed:', String(e.message).slice(0, 200));
      return wantsJson(req) ? json(502, { ok: false, error: 'request failed' }) : seeOther('/account?line=error');
    }
    if (!r.ok) {
      return wantsJson(req) ? json(409, r) : seeOther('/account?line=incomplete');
    }
    const acct = r.account;
    logAccountToHubSpot(acct, 'line_requested').catch(() => {});
    notifyOperator({
      subject: `ACTION NEEDED: assign a number to ${acct.business_name}`,
      replyTo: acct.owner_email,
      lines: [
        'ACTION NEEDED: a business finished its rules and asked for a phone number. Assigning one is a manual step.',
        '',
        `Business: ${acct.business_name}`,
        `Owner: ${acct.owner_name || 'not given'} <${acct.owner_email}>`,
        `Mobile: ${acct.owner_phone || 'not given'}`,
        `Trade: ${acct.trade || 'not given'}`,
        `Area code wanted: ${acct.wanted_area_code || 'no preference'}`,
        `Account id: ${acct.id}`,
        '',
        'To turn it on: assign a real number with sv_account_assign_number, then point that number\'s',
        'Twilio voice webhook at /api/account-voice. The account goes live only when a real number exists.',
      ],
    }).catch(() => {});
    return wantsJson(req) ? json(200, r) : seeOther('/account?line=asked');
  }

  if (path !== '/account') return json(404, { ok: false, error: 'no such path' });

  const q = url.searchParams;
  let flash = null;
  if (q.get('saved') === '1') flash = { kind: 'ok', text: 'Saved. The next call uses these rules.' };
  if (q.get('saved') === 'error') flash = { kind: 'err', text: 'That did not save. Nothing changed. Try again.' };
  if (q.get('saved') === 'empty') flash = { kind: 'err', text: 'Nothing was filled in, so nothing was saved.' };
  if (q.get('line') === 'asked') flash = { kind: 'ok', text: 'Asked. A person sets the number up and we email you.' };
  if (q.get('line') === 'incomplete') flash = { kind: 'err', text: 'Finish the missing list first.' };
  if (q.get('line') === 'error') flash = { kind: 'err', text: 'That did not go through. Try again.' };

  return html(200, consolePage(account, flash));
};

export const config = {
  path: ['/account', '/account/enter', '/account/signout', '/api/account/save', '/api/account/request-line'],
};
