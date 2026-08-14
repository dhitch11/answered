// /internal/parley — the operator console for the negotiation product.
//
// David asked for "all talking to our admin console, all being tracked. Every aspect of it being
// tracked, including revenue and what the results were, the conversations, everything recorded."
// This is that surface: every deal, what state it is in, what was actually said, what settled, and
// what money arrived.
//
// ★ IT DOES NOT SHOW SEALED NUMBERS, AND THAT IS THE POINT. The product tells both parties that
// their limit is shown to nobody. An operator console quietly displaying both floors would make
// that sentence false while every customer-facing surface kept saying it, and the first person to
// notice would be right to stop trusting the whole thing. So the board carries public openings, the
// settled figure and the state of the money, and `tr_board` does not return the limits at all. It
// is enforced in the RPC rather than by this page choosing not to render them.
//
// GATED SERVER-SIDE, the same posture as /internal and /internal/ops: the page exists as a string
// INSIDE this handler and is serialized only after the PIN check passes. Rule 9 exists because a
// CSS-only PIN curtain served 303,451 bytes to an anonymous curl while showing a padlock. If the
// bytes reach the browser, the page is public.
//
// Env by NAME only: ANSWERED_DIRECTORY_PIN, ANSWERED_BRAIN_SECRET, plus the database via lib/db.mjs.

import crypto from 'node:crypto';
import { rpc } from './lib/db.mjs';

const PIN = (process.env.ANSWERED_DIRECTORY_PIN || '').trim();
const SECRET = (process.env.ANSWERED_BRAIN_SECRET || '').trim();
const COOKIE = 'parley_console';
const TTL_MS = 8 * 60 * 60 * 1000;

const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
};

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function pinMatches(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(PIN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function mintCookie() {
  const exp = Date.now() + TTL_MS;
  const mac = crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex');
  return `${exp}.${mac}`;
}
function cookieValid(v) {
  const [exp, mac] = String(v || '').split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const want = crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex');
  const a = Buffer.from(mac); const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const CSS = `
:root{--ink:#0B0C0E;--paper:#F2F4F0;--hi:#E3FF4F;--dim:#8B939C;--line:#1E2126;--live:#37C8F0;--kill:#FF3355}
*{box-sizing:border-box}
body{margin:0;background:var(--ink);color:var(--paper);font:15px/1.6 ui-sans-serif,-apple-system,Segoe UI,Helvetica,Arial,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:26px 18px 90px}
h1{font-size:23px;letter-spacing:-.02em;margin:0 0 4px}
.k{font:600 10px/1 ui-monospace,Menlo,monospace;letter-spacing:.16em;text-transform:uppercase;color:var(--dim)}
.sub{color:var(--dim);margin:0 0 22px;max-width:70ch}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:20px 0 26px}
.tile{border:1px solid var(--line);border-radius:12px;padding:14px 16px;background:#0F1114}
.tile .n{font-size:26px;font-weight:650;letter-spacing:-.02em;margin-top:6px}
.tile .n.money{color:var(--hi)}
.tile .why{color:var(--dim);font-size:12px;margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font:600 10px/1 ui-monospace,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);padding:10px 8px;border-bottom:1px solid var(--line)}
td{padding:11px 8px;border-bottom:1px solid var(--line);vertical-align:top}
tr:hover td{background:#101317}
.pill{display:inline-block;font:600 10px/1 ui-monospace,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;padding:4px 7px;border-radius:999px;border:1px solid var(--line);color:var(--dim)}
.pill.settled{color:var(--ink);background:var(--hi);border-color:var(--hi)}
.pill.negotiating{color:var(--live);border-color:var(--live)}
.pill.no_overlap,.pill.expired{color:var(--kill);border-color:var(--kill)}
.money{color:var(--hi);font-weight:650}
.who{color:var(--dim);font-size:13px}
.empty{border:1px dashed var(--line);border-radius:12px;padding:26px;text-align:center;color:var(--dim)}
form.gate{max-width:330px;margin:16vh auto;text-align:center}
input[type=password]{width:100%;padding:13px;border-radius:10px;border:1px solid var(--line);background:#0F1114;color:var(--paper);font:inherit;font-size:16px}
button{margin-top:10px;width:100%;padding:13px;border-radius:10px;border:0;background:var(--hi);color:var(--ink);font:inherit;font-weight:650;cursor:pointer}
a{color:var(--live)}
details{margin-top:8px}
summary{cursor:pointer;color:var(--dim);font-size:13px}
.msg{border-left:2px solid var(--line);padding:6px 0 6px 12px;margin-top:8px}
.msg.agent{border-left-color:var(--hi)}
.msg b{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
.note{color:var(--dim);font-size:13px;margin-top:26px;border-top:1px solid var(--line);padding-top:16px}
`;

const gatePage = (msg) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Internal</title><style>${CSS}</style></head><body>
<form class="gate" method="POST"><p class="k">Answered internal</p>
<h1 style="margin:8px 0 14px">Parley console</h1>
${msg ? `<p class="sub" style="text-align:center">${esc(msg)}</p>` : ''}
<input type="password" name="pin" inputmode="numeric" autocomplete="off" autofocus aria-label="PIN">
<button type="submit">Open</button></form></body></html>`;

const money = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (t) => (t ? new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

function partyCell(p) {
  if (!p) return '<span class="who">missing</span>';
  const bits = [];
  if (p.invited_not_opened) bits.push('invitation not opened yet');
  else if (!p.number_set) bits.push('opened, no number set');
  else bits.push('number set' + (p.opening != null ? `, asking ${Number(p.opening).toLocaleString('en-US')}` : ''));
  if (p.signed) bits.push('signed');
  if (p.told_by_email) bits.push('will be emailed');
  return `<div>${esc(p.name)} <span class="who">(${esc(p.role)})</span></div><div class="who">${esc(bits.join(' · '))}</div>`;
}

function boardPage(board) {
  const deals = (board && board.deals) || [];
  const rev = (board && board.revenue) || {};
  const settled = deals.filter((d) => d.status === 'settled');
  const totalSettled = settled.reduce((n, d) => n + Number(d.settled_value || 0), 0);

  const tiles = `
  <div class="tiles">
    <div class="tile"><p class="k">Deals</p><div class="n">${deals.length}</div><p class="why">every negotiation ever started</p></div>
    <div class="tile"><p class="k">Settled</p><div class="n">${settled.length}</div><p class="why">reached a number both sides could take</p></div>
    <div class="tile"><p class="k">Value settled</p><div class="n money">$${totalSettled.toLocaleString('en-US')}</div><p class="why">what the parties agreed, not what we earned</p></div>
    <div class="tile"><p class="k">Fees collected</p><div class="n money">${money(rev.fees_earned_cents)}</div><p class="why">money that actually arrived, from paid settlements only</p></div>
    <div class="tile"><p class="k">Awaiting payment</p><div class="n">${Number(rev.awaiting || 0)}</div><p class="why">settled, rail opened, not yet paid</p></div>
  </div>`;

  if (!deals.length) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Parley console</title><style>${CSS}</style></head><body><div class="wrap">
<p class="k">Answered internal</p><h1>Parley</h1>
<p class="sub">Every negotiation, what was said, what settled, and what was paid.</p>
${tiles}
<div class="empty"><p><b>No negotiations yet.</b></p><p>This is a measured zero, not a loading state and not a failure. The moment somebody starts a deal it appears here.</p></div>
</div></body></html>`;
  }

  const rows = deals.map((d) => {
    const a = (d.parties || []).find((p) => p.side === 'a');
    const b = (d.parties || []).find((p) => p.side === 'b');
    const pay = d.payout;
    const payCell = !pay
      ? (d.status === 'settled' ? '<span class="who">rail not opened</span>' : '<span class="who">&mdash;</span>')
      : `<span class="pill ${esc(pay.status)}">${esc(pay.status)}</span>` +
        (pay.status === 'succeeded'
          ? `<div class="who">${money(pay.amount_cents)} paid · <b class="money">${money(pay.fee_cents)}</b> ours</div>`
          : `<div class="who">${money(pay.amount_cents)} · fee ${money(pay.fee_cents)}</div>`);
    return `<tr>
      <td><div>${esc(d.subject)}</div><div class="who">${esc(d.kind)} · started ${esc(when(d.created_at))}</div></td>
      <td><span class="pill ${esc(d.status)}">${esc(d.status)}</span>${d.notified ? '<div class="who">both told</div>' : ''}</td>
      <td>${partyCell(a)}</td>
      <td>${partyCell(b)}</td>
      <td>${d.settled_value != null ? `<span class="money">$${Number(d.settled_value).toLocaleString('en-US')}</span><div class="who">${esc(when(d.settled_at))}</div>` : '<span class="who">&mdash;</span>'}</td>
      <td><div>${Number(d.messages || 0)}</div><div class="who">${Number(d.human_messages || 0)} typed by a person</div></td>
      <td>${payCell}</td>
    </tr>`;
  }).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Parley console</title><style>${CSS}</style></head><body><div class="wrap">
<p class="k">Answered internal</p><h1>Parley</h1>
<p class="sub">Every negotiation, what was said, what settled, and what was paid. Figures come from the database, and a fee only counts once a payment processor confirmed it arrived.</p>
${tiles}
<table><thead><tr>
<th>Deal</th><th>State</th><th>Side A</th><th>Side B</th><th>Settled at</th><th>Messages</th><th>Money</th>
</tr></thead><tbody>${rows}</tbody></table>
<p class="note"><b>Sealed numbers are deliberately absent from this page.</b> Both parties are told their limit is shown to nobody, and that has to include us. The board carries public openings, the settled figure and the state of the money; <span class="k">tr_board</span> does not return the limits at all, so this is enforced in the database rather than by this page choosing not to render them.</p>
</div></body></html>`;
}

export const handler = async (event) => {
  const h = {};
  for (const k in (event.headers || {})) h[k.toLowerCase()] = event.headers[k];

  if (!PIN || !SECRET) {
    console.error('parley-console: ANSWERED_DIRECTORY_PIN or ANSWERED_BRAIN_SECRET is not set; refusing (fail closed).');
    return { statusCode: 503, headers: HEADERS, body: gatePage('This console is not configured. Nothing is served without the gate.') };
  }

  const authed = (() => {
    const m = new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)').exec(String(h.cookie || ''));
    return Boolean(m && cookieValid(m[1]));
  })();

  async function render() {
    try {
      const board = await rpc('tr_board', { p_limit: 80 });
      return { statusCode: 200, headers: HEADERS, body: boardPage(board) };
    } catch (e) {
      console.error('parley-console: could not read the board:', String(e && e.message).slice(0, 160));
      // An error is not an empty state. Say which it is.
      return {
        statusCode: 200, headers: HEADERS,
        body: boardPage({ deals: [], revenue: {} }).replace(
          'No negotiations yet.',
          'The board could not be read, so this is NOT a measured zero.'),
      };
    }
  }

  if (event.httpMethod === 'POST') {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
    const m = /(?:^|&)pin=([^&]*)/.exec(raw);
    const given = m ? decodeURIComponent(m[1].replace(/\+/g, ' ')).trim() : '';
    if (pinMatches(given)) {
      const out = await render();
      return { ...out, headers: { ...HEADERS, 'Set-Cookie': `${COOKIE}=${mintCookie()}; HttpOnly; Secure; SameSite=Strict; Path=/internal; Max-Age=${TTL_MS / 1000}` } };
    }
    await new Promise((r) => setTimeout(r, 600)); // wrong answers arrive slowly
    return { statusCode: 401, headers: HEADERS, body: gatePage('Not it. Try again.') };
  }

  if (event.httpMethod === 'GET') {
    if (authed) return render();
    return { statusCode: 200, headers: HEADERS, body: gatePage('') };
  }

  return { statusCode: 405, headers: { ...HEADERS, Allow: 'GET, POST' }, body: 'Method not allowed' };
};
