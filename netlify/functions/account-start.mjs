// /api/account/start — the front door. An email in, a sign-in link out.
//
// THE ANSWER IS THE SAME EVERY TIME, ON PURPOSE. New account, existing account, throttled,
// missing business name: one page, one message, one timing. An endpoint that answers differently
// for an address that exists is a way to ask us who our customers are, and the honest wording
// below covers every branch without ever needing to lie:
//
//   "If that email has an account, a link is on the way."
//
// The one thing this endpoint will NOT paper over is a send that failed. A page that says check
// your email while nothing was sent is the worst outcome available here, so a Resend failure is
// reported as a failure and the person is told to try again.

import { startAccount, dbConfigured } from './lib/accounts.mjs';
import {
  mintLoginToken, configured as authConfigured, PRIVATE_HEADERS, html, json, slow, clientIp,
} from './lib/account-auth.mjs';
import { sendLoginLink, notifyOperator, logAccountToHubSpot } from './lib/account-notify.mjs';

const h = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const shell = (title, body) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive"><title>${h(title)}</title>
<style>*{box-sizing:border-box}body{margin:0;background:#0B0C0E;color:#F2F4F0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
.wrap{max-width:34rem;margin:0 auto;padding:3rem 1.25rem}h1{font-size:clamp(1.5rem,5vw,2.1rem);margin:0 0 .6rem;letter-spacing:-.02em}
p{margin:.6rem 0}.muted{color:#8B939C}.err{color:#FF3355}a{color:#E3FF4F}
.mark{font-weight:800;letter-spacing:.14em;font-size:.9rem;margin-bottom:2rem}.mark b{color:#E3FF4F}</style>
</head><body><div class="wrap"><div class="mark">ANSWERE<b>D</b></div>${body}</div></body></html>`;

const SENT = shell('Check your email', `
<h1>Check your email</h1>
<p>If that email has an account, a link is on the way. It works once and it stops working in twenty minutes.</p>
<p class="muted">Signing up the first time needs your business name too. If you left that blank and you are new here, add it and send again.</p>
<p class="muted">Nothing calls anybody because of this. A phone line only turns on after you ask for a number and a person sets it up.</p>
<p><a href="/account">Back to sign in</a></p>`);

const failed = (why) => shell('That did not send', `
<h1>That did not send</h1>
<p>No link went out, so there is nothing waiting in your inbox. This is on us, not on you.</p>
<p class="muted">Recorded: ${h(why)}</p>
<p><a href="/account">Try again</a></p>`);

async function readBody(req) {
  const ct = (req.headers.get('content-type') || '').toLowerCase();
  const raw = await req.text();
  if (ct.includes('application/json')) { try { return JSON.parse(raw || '{}'); } catch { return {}; } }
  const out = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

const wantsJson = (req) => (req.headers.get('accept') || '').includes('application/json')
  || (req.headers.get('content-type') || '').includes('application/json');

// Deliberately permissive: this is a shape check, not a validity claim. The only proof an address
// is real is that the link arrives at it, which is the whole design.
const looksLikeEmail = (s) => /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(String(s || '').trim());

export default async (req) => {
  if (req.method !== 'POST') {
    return json(405, { ok: false, error: 'POST only' }, { Allow: 'POST' });
  }
  if (!dbConfigured() || !authConfigured()) {
    const why = !dbConfigured() ? 'the account database is not configured' : 'ANSWERED_ACCOUNT_KEY is not set';
    console.error(`account-start refusing: ${why}`);
    return wantsJson(req) ? json(503, { ok: false, error: why }) : html(503, failed(why));
  }
  if (!(process.env.RESEND_API_KEY || '').trim()) {
    const why = 'RESEND_API_KEY is not set, so no sign-in link can be sent';
    console.error(`account-start refusing: ${why}`);
    return wantsJson(req) ? json(503, { ok: false, error: why }) : html(503, failed(why));
  }

  const f = await readBody(req);
  const email = String(f.email || '').trim().toLowerCase().slice(0, 200);
  if (!looksLikeEmail(email)) {
    await slow(300);
    return wantsJson(req) ? json(400, { ok: false, error: 'that does not look like an email address' })
      : html(400, shell('Check the address', '<h1>Check the address</h1><p>That does not look like an email address.</p><p><a href="/account">Try again</a></p>'));
  }

  const { raw, hash } = mintLoginToken();
  const origin = process.env.URL || new URL(req.url).origin;

  let r;
  try {
    r = await startAccount({
      email,
      businessName: String(f.business_name || f.businessName || '').trim().slice(0, 200),
      ownerName: String(f.owner_name || f.name || '').trim().slice(0, 120),
      phone: String(f.phone || f.owner_phone || '').trim().slice(0, 40),
      trade: String(f.trade || '').trim().slice(0, 80),
      tokenHash: hash,
      ttlMinutes: 20,
      ip: clientIp(req),
      ua: (req.headers.get('user-agent') || '').slice(0, 300),
    });
  } catch (e) {
    const msg = String((e && e.message) || e);
    // "business name required" means the address is unknown here. Saying so out loud would turn
    // this endpoint into a customer-list oracle, so it lands on the same page as everything else,
    // whose wording already covers this exact case.
    if (/business name required/i.test(msg)) {
      await slow(400);
      return wantsJson(req) ? json(200, { ok: true, sent: 'maybe' }) : html(200, SENT);
    }
    console.error('account-start db failure:', msg.slice(0, 200));
    return wantsJson(req) ? json(502, { ok: false, error: 'could not start an account just now' })
      : html(502, failed('the account database refused the write'));
  }

  if (!r.ok && r.throttled) {
    // A link went out within the last few minutes. "Check your email" is true.
    await slow(400);
    return wantsJson(req) ? json(200, { ok: true, sent: 'recent' }) : html(200, SENT);
  }

  const account = r.account;
  const url = `${origin}/account/enter?t=${encodeURIComponent(raw)}`;
  const sent = await sendLoginLink({
    email, businessName: account.business_name, url, isNew: r.created,
  });

  if (!sent.ok) {
    console.error(`account-start: login link NOT sent (${sent.why}) ${sent.detail || ''}`);
    return wantsJson(req) ? json(502, { ok: false, error: 'the sign-in email did not send', why: sent.why })
      : html(502, failed(sent.why));
  }

  if (r.created) {
    logAccountToHubSpot(account, 'signed_up').catch(() => {});
    notifyOperator({
      subject: `Answered: new account started, ${account.business_name}`,
      replyTo: account.owner_email,
      lines: [
        'A business started an Answered account. Nothing is live and no number exists yet.',
        '',
        `Business: ${account.business_name}`,
        `Owner: ${account.owner_name || 'not given'} <${account.owner_email}>`,
        `Trade: ${account.trade || 'not given'}`,
        `Mobile: ${account.owner_phone || 'not given'}`,
        `Account id: ${account.id}`,
        '',
        'They see their rules page after opening the link. You hear from them again when they ask for a number.',
      ],
    }).catch(() => {});
  }

  await slow(200);
  return wantsJson(req) ? json(200, { ok: true, sent: true }) : html(200, SENT);
};

export const config = { path: '/api/account/start' };
