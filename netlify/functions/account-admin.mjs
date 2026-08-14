// /internal/accounts : the operator side of the accounts spine, and /api/agent-config, the
// resolver a voice runtime can ask "who owns this number and what does it say".
//
// WHY AN OPERATOR PAGE EXISTS AT ALL: turning a business on means putting a real phone number in
// front of real strangers. Nothing about that should be a button a signup form can press. The
// owner asks; a person looks at the account, buys or picks a number, points its Twilio voice
// webhook at /api/account-voice, and records the assignment here. Only that last step can set an
// account live, and it demands an E.164 number that actually exists.
//
// Gated exactly like /internal/cockpit: server-side, nothing serialized before the check, and the
// whole page refuses to exist without a PIN configured. A curtain drawn over content the server
// already sent is not a gate.

import crypto from 'node:crypto';
import {
  listAccounts, getAccount, assignNumber, accountForNumber, renderSpec, renderGreeting,
  humanMissing, dbConfigured,
} from './lib/accounts.mjs';
import {
  BASE_HEADERS, cookieValid, mintCookie, setCookieHeader, pinValid, readCookie, configured, slow,
} from './lib/gate-auth.mjs';
import { notifyOperator } from './lib/account-notify.mjs';

const COOKIE = 'ans_accounts';

const h = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const CSS = `*{box-sizing:border-box}body{margin:0;background:#0B0C0E;color:#F2F4F0;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
.wrap{max-width:64rem;margin:0 auto;padding:2rem 1.25rem 5rem}h1{font-size:1.6rem;margin:0 0 1rem;letter-spacing:-.02em}
h2{font-size:1.05rem;margin:0 0 .3rem}p{margin:.35rem 0}.muted{color:#8B939C}.err{color:#FF3355}.ok{color:#37C8F0}
.card{background:#16181C;border:1px solid #24272C;border-radius:12px;padding:1rem;margin:.9rem 0}
label{display:block;font-size:.8rem;color:#8B939C;margin:.7rem 0 .25rem}
input,select{width:100%;background:#0B0C0E;color:#F2F4F0;border:1px solid #2C3037;border-radius:8px;padding:.6rem .7rem;font:inherit;min-height:44px}
button{background:#E3FF4F;color:#0B0C0E;border:0;border-radius:8px;padding:.7rem 1.2rem;font:inherit;font-weight:700;cursor:pointer;min-height:44px}
.row{display:grid;grid-template-columns:minmax(0,1fr);gap:.6rem}@media(min-width:640px){.row{grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)}}
.tag{display:inline-block;font-size:.7rem;letter-spacing:.08em;text-transform:uppercase;border:1px solid #2C3037;border-radius:999px;padding:.15rem .55rem;color:#8B939C}
.tag.live{color:#37C8F0;border-color:#37C8F0}.tag.wait{color:#E3FF4F;border-color:#E3FF4F}
pre{white-space:pre-wrap;background:#0B0C0E;border:1px solid #24272C;border-radius:8px;padding:.8rem;font:12px/1.5 ui-monospace,Menlo,monospace;color:#C8CDD3;overflow-x:auto}
a{color:#E3FF4F}`;

const shell = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive">
<title>Accounts</title><style>${CSS}</style></head><body><div class="wrap">${body}</div></body></html>`;

const LOGIN = (msg = '') => shell(`<h1>Internal</h1>
<p class="muted">This page is internal.</p>${msg ? `<p class="err">${h(msg)}</p>` : ''}
<div class="card"><form method="POST"><label for="pin">PIN</label>
<input id="pin" name="pin" type="password" autocomplete="off" autofocus>
<p style="margin-top:.9rem"><button type="submit">Enter</button></p></form></div>`);

const TAG = { live: 'live', awaiting_line: 'wait' };
// The database's status values are machine tokens. An operator page that prints AWAITING_LINE is
// showing its schema, not its state.
const STATUS_WORDS = {
  draft: 'never signed in', configuring: 'writing rules', ready: 'rules done, no number',
  awaiting_line: 'waiting on a number', live: 'live', paused: 'paused', closed: 'closed',
};

function listPage(accounts, flash) {
  const rows = accounts.map((a) => {
    const missing = humanMissing(a.missing);
    const nums = (a.numbers || []).filter((n) => n.status === 'provisioned').map((n) => n.phone);
    return `<div class="card">
      <h2>${h(a.business_name)} <span class="tag ${TAG[a.status] || ''}">${h(STATUS_WORDS[a.status] || a.status)}</span></h2>
      <p class="muted">${h(a.owner_email)}${a.owner_phone ? ` &middot; ${h(a.owner_phone)}` : ''}${a.trade ? ` &middot; ${h(a.trade)}` : ''}</p>
      <p>${nums.length ? `Number: <b>${nums.map(h).join(', ')}</b>` : 'No number.'}
         ${a.wanted_area_code ? `<span class="muted">Wanted area code ${h(a.wanted_area_code)}</span>` : ''}</p>
      ${missing.length ? `<p class="muted">Missing: ${h(missing.join(', '))}</p>` : '<p class="ok">Rules complete.</p>'}
      <p class="muted">Rules version ${h(a.config?.version ?? 1)} &middot; account ${h(a.id)}</p>
      ${(!missing.length && !nums.length) ? `<form method="POST" class="row" style="margin-top:.8rem">
          <input type="hidden" name="op" value="assign"><input type="hidden" name="account_id" value="${h(a.id)}">
          <div><label for="p_${h(a.id)}">Real number, E.164</label>
            <input id="p_${h(a.id)}" name="phone" placeholder="+19165550142" required pattern="\\+[0-9]{8,15}"></div>
          <div><label for="s_${h(a.id)}">Twilio SID, optional</label><input id="s_${h(a.id)}" name="twilio_sid" placeholder="PN..."></div>
          <div><label>&nbsp;</label><button type="submit">Assign and go live</button></div>
        </form>
        <p class="muted" style="font-size:.82rem">Point that number's voice webhook at /api/account-voice before you assign it.</p>` : ''}
    </div>`;
  }).join('');

  return shell(`<h1>Accounts</h1>
${flash ? `<p class="${flash.kind}">${h(flash.text)}</p>` : ''}
<p class="muted">${accounts.length} account${accounts.length === 1 ? '' : 's'}. Assigning a number is the only thing here that changes what a caller hears.</p>
${rows || '<div class="card"><p>No accounts yet. Nothing to show, and nothing invented to fill the space.</p></div>'}`);
}

// ── the resolver, for a voice runtime ────────────────────────────────────────────────────────

const svc = (req) => {
  const key = (process.env.ANSWERED_COCKPIT_KEY || '').trim();
  if (!key) return false;
  const given = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

async function agentConfig(req) {
  const to = new URL(req.url).searchParams.get('to') || '';
  const jsonRes = (status, body) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
  if (!svc(req)) return jsonRes(401, { ok: false, error: 'unauthorized' });
  if (!dbConfigured()) return jsonRes(503, { ok: false, error: 'account database not configured' });
  if (!/^\+[1-9][0-9]{7,14}$/.test(to)) return jsonRes(400, { ok: false, error: 'to must be an E.164 number' });
  let a;
  try { a = await accountForNumber(to); } catch (e) {
    return jsonRes(502, { ok: false, error: String(e.message).slice(0, 200) });
  }
  // 404 is the honest answer for a number no business owns, and callers must handle it.
  // There is no default persona to hand back.
  if (!a) return jsonRes(404, { ok: false, error: 'no live account owns that number' });
  return jsonRes(200, {
    ok: true,
    account_id: a.id,
    business_name: a.business_name,
    config_version: a.config?.version ?? 1,
    first_message: renderGreeting(a),
    prompt: renderSpec(a),
  });
}

// ── handler ──────────────────────────────────────────────────────────────────────────────────

export default async (req) => {
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/agent-config')) return agentConfig(req);

  const headers = {};
  for (const [k, v] of req.headers) headers[k.toLowerCase()] = v;
  const H = { ...BASE_HEADERS };

  if (!configured()) {
    console.error('account-admin: ANSWERED_DIRECTORY_PIN or ANSWERED_COCKPIT_KEY not set; refusing (fail closed).');
    return new Response(LOGIN('This page is not configured.'), { status: 503, headers: H });
  }

  let authed = cookieValid(COOKIE, readCookie(headers, COOKIE));
  let flash = null;

  if (req.method === 'POST') {
    const form = new URLSearchParams(await req.text());
    if (!authed) {
      if (pinValid(form.get('pin'))) {
        return new Response(await afterAuth(null), {
          status: 200,
          headers: { ...H, 'Set-Cookie': setCookieHeader(COOKIE, mintCookie(COOKIE)) },
        });
      }
      await slow();
      return new Response(LOGIN('Not it. Try again.'), { status: 401, headers: H });
    }
    if (form.get('op') === 'assign') {
      const id = form.get('account_id') || '';
      const phone = String(form.get('phone') || '').trim();
      try {
        const r = await assignNumber(id, phone, form.get('twilio_sid') || '', 'operator');
        if (!r.ok) {
          flash = { kind: 'err', text: `Not assigned. Still missing: ${humanMissing(r.missing).join(', ')}` };
        } else {
          flash = { kind: 'ok', text: `${r.account.business_name} is live on ${phone}.` };
          const acct = await getAccount(id);
          notifyOperator({
            subject: `Answered: ${acct.business_name} is live on ${phone}`,
            lines: [
              `${acct.business_name} is now answering on ${phone}.`,
              `Owner: ${acct.owner_email}`,
              `Rules version ${acct.config?.version ?? 1}.`,
              '',
              'Confirm that number\'s Twilio voice webhook points at /api/account-voice, then place a real call to it.',
            ],
          }).catch(() => {});
        }
      } catch (e) {
        flash = { kind: 'err', text: String(e.message).slice(0, 200) };
      }
    }
    authed = true;
  }

  if (!authed) return new Response(LOGIN(), { status: 200, headers: H });
  return new Response(await afterAuth(flash), { status: 200, headers: H });
};

async function afterAuth(flash) {
  if (!dbConfigured()) {
    return shell('<h1>Accounts</h1><p class="err">The account database is not configured, so there is nothing real to show. ANSWERED_DB_URL / ANSWERED_DB_ANON / ANSWERED_DB_SECRET.</p>');
  }
  try {
    const accounts = await listAccounts(null, 200);
    return listPage(Array.isArray(accounts) ? accounts : [], flash);
  } catch (e) {
    console.error('account-admin list failed:', String(e.message).slice(0, 200));
    return shell(`<h1>Accounts</h1><p class="err">The account list could not be read. Nothing is shown rather than something wrong.</p><pre>${h(String(e.message).slice(0, 300))}</pre>`);
  }
}

export const config = { path: ['/internal/accounts', '/api/agent-config'] };
