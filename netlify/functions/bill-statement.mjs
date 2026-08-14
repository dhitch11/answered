// /statement/:token — the customer's own bill, and the working half of the VOID promise.
//
// /terms says: "Every charge shows you the call it came from." and "If you think a charge is wrong,
// tap it or reply VOID, and it dies." THIS PAGE IS THE TAP. It is a real server-rendered document
// against the real ledger, with a real button that really writes.
//
// ★ WHY THE REPLY HALF IS NOT HERE, STATED ON THE PAGE RATHER THAN QUIETLY DROPPED. Replying VOID
// needs SMS, and the A2P campaign has failed three times, so today a text cannot be relied on to
// arrive. The estate law is that nothing may claim a text will be delivered. So the page carries
// the tap, an email address, and the phone line, and it says plainly that the text half is not
// running yet. The word VOID stays. What changes is that the page stops implying a channel that
// cannot deliver.
//
// Authentication is the link, exactly like the truce party token: 24 bytes of randomness scope
// every read and every write to one account. There is no account system on this site yet, and
// inventing a password wall in front of a bill nobody can otherwise see would be a worse answer
// than a capability URL that the ledger itself scopes.

import { readStatement, voidCharge, usd, dbConfigured } from './lib/ledger.mjs';

const TOKEN = /^[0-9a-f]{32,96}$/;

const HTML = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};
const JSON_H = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const when = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '';
};

const CSS = `
:root{--ink:#0B0C0E;--ink9:#16181C;--ink8:#23272D;--hi:#E3FF4F;--red:#FF3355;
--t1:#F2F4F0;--t2:rgba(242,244,240,.82);--t3:rgba(242,244,240,.66);--static:#8B939C;
--line:rgba(242,244,240,.10);--line2:rgba(242,244,240,.18);
--sans:'Switzer',ui-sans-serif,'Segoe UI Variable Text',Arial;
--mono:'Martian Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@font-face{font-family:'Switzer';src:url('/assets/fonts/switzer-400.woff2') format('woff2');font-weight:400;font-display:swap}
@font-face{font-family:'Switzer';src:url('/assets/fonts/switzer-500.woff2') format('woff2');font-weight:500;font-display:swap}
@font-face{font-family:'Switzer';src:url('/assets/fonts/switzer-700.woff2') format('woff2');font-weight:700;font-display:swap}
@font-face{font-family:'Martian Mono';src:url('/assets/fonts/martian-mono-400-600.woff2') format('woff2');font-weight:400 600;font-display:swap}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--ink);color:var(--t1);font-family:var(--sans);font-size:16px;line-height:1.5;
-webkit-font-smoothing:antialiased}
.wrap{max-width:760px;margin:0 auto;padding:clamp(22px,5vw,54px) clamp(18px,5vw,32px) 80px}
.top{display:flex;align-items:center;gap:10px;padding-bottom:22px;border-bottom:1px solid var(--line)}
.mark{width:22px;height:22px;flex:none}
.name{font-weight:700;letter-spacing:.13em;font-size:12.5px}
h1{font-size:clamp(26px,5vw,38px);line-height:1.14;letter-spacing:-.01em;font-weight:700;margin:26px 0 0}
.sub{color:var(--t3);margin-top:10px;font-size:15px;max-width:56ch}
.due{margin-top:26px;padding:20px;background:var(--ink9);border:1px solid var(--line2);border-radius:12px}
.due-k{font-family:var(--mono);font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--static)}
.due-v{font-family:var(--mono);font-size:clamp(32px,7vw,44px);font-weight:600;margin-top:8px;letter-spacing:-.02em}
.meta{display:flex;flex-wrap:wrap;gap:8px 22px;margin-top:14px;font-size:13.5px;color:var(--t3)}
.meta b{color:var(--t2);font-weight:500;font-family:var(--mono);font-size:12.5px}
h2{font-size:13px;font-family:var(--mono);letter-spacing:.2em;text-transform:uppercase;color:var(--static);
font-weight:400;margin:38px 0 12px}
.line{padding:16px 0;border-top:1px solid var(--line);display:grid;grid-template-columns:1fr auto;gap:6px 18px}
.line:last-of-type{border-bottom:1px solid var(--line)}
.l-t{font-weight:500}
.l-p{font-family:var(--mono);font-size:15px;font-weight:600;text-align:right;white-space:nowrap}
.l-p.zero{color:var(--static);font-weight:400}
.l-r{grid-column:1/-1;color:var(--t3);font-size:14px;max-width:64ch}
.l-e{grid-column:1/-1;font-family:var(--mono);font-size:11.5px;color:var(--static);
display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:2px}
.l-a{grid-column:1/-1;margin-top:8px}
.void{appearance:none;background:transparent;border:1px solid var(--line2);color:var(--t2);
font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;
padding:8px 14px;border-radius:999px;cursor:pointer}
.void:hover{border-color:var(--red);color:var(--red)}
.void:focus-visible{outline:2px solid var(--hi);outline-offset:2px}
.void[disabled]{opacity:.5;cursor:not-allowed}
.tag{font-family:var(--mono);font-size:10px;letter-spacing:.16em;text-transform:uppercase;
padding:3px 8px;border-radius:999px;border:1px solid var(--line2);color:var(--static)}
.tag.dead{color:var(--red);border-color:rgba(255,51,85,.4)}
.note{margin-top:34px;padding:18px 20px;background:var(--ink9);border-left:2px solid var(--hi);border-radius:0 10px 10px 0;
font-size:14.5px;color:var(--t2);max-width:62ch}
.note b{color:var(--t1);font-weight:500}
.note a{color:var(--hi);text-decoration:underline;text-underline-offset:3px}
.foot{margin-top:44px;padding-top:22px;border-top:1px solid var(--line);font-size:13px;color:var(--static)}
.foot a{color:var(--t2);text-decoration:underline;text-underline-offset:3px}
.empty{padding:30px 0;color:var(--t3)}
@media(max-width:420px){.line{grid-template-columns:1fr}.l-p{text-align:left}}
`;

const MARK = `<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="2" width="5.2" height="20" rx="2.2" fill="#E3FF4F"/><path d="M 11.5 6.284 A 6.6 6.6 0 0 1 11.5 17.716" fill="none" stroke="#E3FF4F" stroke-width="4.8" stroke-linecap="round"/><path d="M 15.838 3.808 A 11.2 11.2 0 0 1 15.838 20.192" fill="none" stroke="#E3FF4F" stroke-width="3" stroke-linecap="round"/></svg>`;

const shell = (title, inner) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><div class="wrap"><div class="top">${MARK}<span class="name">ANSWERED</span></div>${inner}</div></body></html>`;

/** An unknown or malformed link says so in one sentence and offers a person. Never a stack trace. */
const notFound = () => ({
  statusCode: 404, headers: HTML,
  body: shell('That link does not open a statement', `
    <h1>That link does not open a statement.</h1>
    <p class="sub">It may have been retyped, or it may belong to a closed account. Nothing is wrong on your side.</p>
    <p class="note">Write to <a href="mailto:info@reddenda.com">info@reddenda.com</a> and a person answers, or call and we will read you the bill line by line.</p>`),
});

function render(s, token) {
  const a = s.account || {};
  const lines = Array.isArray(s.lines) ? s.lines : [];
  const cycle = s.cycle ? new Date(`${s.cycle}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : '';
  const billable = lines.filter((l) => l.cents > 0 && l.state !== 'voided');
  const free = lines.filter((l) => !(l.cents > 0 && l.state !== 'voided'));

  const row = (l) => {
    const dead = l.state === 'voided';
    const price = dead ? 'voided' : usd(l.cents);
    const ev = [];
    if (l.evidence && l.evidence.call_sid) ev.push(`call ${esc(String(l.evidence.call_sid).slice(0, 20))}`);
    if (l.evidence && l.evidence.deal_id) ev.push(`deal ${esc(String(l.evidence.deal_id).slice(0, 8))}`);
    if (l.evidence && l.evidence.invoice_ref) ev.push(`invoice ${esc(String(l.evidence.invoice_ref).slice(0, 30))}`);
    if (l.cap_applied_cents > 0) ev.push(`cap took off ${usd(l.cap_applied_cents)}`);
    if (l.credit_applied_cents > 0) ev.push(`credit took off ${usd(l.credit_applied_cents)}`);
    return `<div class="line" data-id="${esc(l.id)}">
      <div class="l-t">${esc(l.label || l.kind)}${dead ? ' <span class="tag dead">voided</span>' : ''}</div>
      <div class="l-p${l.cents > 0 && !dead ? '' : ' zero'}">${esc(price)}</div>
      <div class="l-r">${esc(l.reason)}</div>
      ${ev.length ? `<div class="l-e"><span>${when(l.occurred_at)}</span>${ev.map((x) => `<span>${x}</span>`).join('')}</div>` : `<div class="l-e"><span>${when(l.occurred_at)}</span></div>`}
      ${l.cents > 0 && !dead && l.state !== 'paid'
        ? `<div class="l-a"><button class="void" type="button" data-void="${esc(l.id)}">Void this charge</button></div>` : ''}
    </div>`;
  };

  const card = a.card_on_file
    ? `<span>Card on file <b>${esc(a.card_brand || 'card')} &middot;&middot;&middot;&middot; ${esc(a.card_last4 || '')}</b></span>`
    : '<span>No card on file yet</span>';

  return shell(`Your Answered statement, ${cycle}`, `
    <h1>${esc(a.business_name || 'Your statement')}</h1>
    <p class="sub">Every event on this account for ${esc(cycle)}, including the ones that cost nothing. If a charge is wrong, void it. You do not have to explain why.</p>

    <div class="due">
      <div class="due-k">Due this cycle</div>
      <div class="due-v">${usd(s.due_cents || 0)}</div>
      <div class="meta">
        <span>Cap <b>${usd(s.cap_cents || 0)}</b></span>
        <span>Room left <b>${usd(s.cap_room_cents || 0)}</b></span>
        ${s.credit_cents > 0 ? `<span>Credit <b>${usd(s.credit_cents)}</b></span>` : ''}
        ${card}
      </div>
    </div>

    <h2>Charges</h2>
    ${billable.length ? billable.map(row).join('') : '<p class="empty">Nothing has cost you anything this cycle.</p>'}

    <h2>Everything else, at no charge</h2>
    ${free.length ? free.map(row).join('') : '<p class="empty">No free events recorded this cycle.</p>'}

    <p class="note"><b>About VOID.</b> Tapping the button above kills a charge on the spot, with no ticket and no argument.
    <b>Replying VOID to a text is not running yet.</b> Our texting program is still waiting on carrier approval, so we will not
    promise you a message that may never arrive. Until it clears, this page and
    <a href="mailto:info@reddenda.com">info@reddenda.com</a> are the two doors, and both are read by a person.</p>

    <div class="foot">
      This statement is generated from the ledger, not from a summary of it. The
      <a href="/terms">terms</a> list every event that can ever appear here. If this page and the terms ever disagree, the terms win.
    </div>

    <script>
    (function(){
      var token = ${JSON.stringify(token)};
      document.addEventListener('click', function(e){
        var b = e.target.closest ? e.target.closest('[data-void]') : null;
        if (!b) return;
        b.disabled = true;
        var was = b.textContent;
        b.textContent = 'Voiding';
        fetch('/api/statement', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ op:'void', token: token, id: b.getAttribute('data-void') })
        }).then(function(r){ return r.json(); }).then(function(d){
          if (d && d.ok) { location.reload(); return; }
          // A void that could not happen says why, on the button, instead of pretending it did.
          b.textContent = (d && d.error) ? d.error : 'Could not void that. Email us.';
        }).catch(function(){
          b.disabled = false; b.textContent = was + ' (network failed, try again)';
        });
      });
    })();
    </script>`);
}

export default async (request) => {
  const url = new URL(request.url);

  // ── the write door, same function, JSON ────────────────────────────────────────────────────────
  if (url.pathname === '/api/statement') {
    if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: JSON_H });
    if (!dbConfigured()) return new Response(JSON.stringify({ error: 'not configured' }), { status: 503, headers: JSON_H });
    let body;
    try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: 'bad json' }), { status: 400, headers: JSON_H }); }
    const token = String(body.token || '');
    if (!TOKEN.test(token)) return new Response(JSON.stringify({ error: 'that link is not valid' }), { status: 400, headers: JSON_H });

    try {
      if (body.op === 'void') {
        const id = String(body.id || '');
        if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response(JSON.stringify({ error: 'which charge?' }), { status: 400, headers: JSON_H });
        const r = await voidCharge(token, id, body.reason);
        return new Response(JSON.stringify(r), { status: r && r.ok ? 200 : 400, headers: JSON_H });
      }
      if (body.op === 'view') {
        const s = await readStatement(token, body.cycle || null);
        return new Response(JSON.stringify(s), { status: s && s.error ? 404 : 200, headers: JSON_H });
      }
      return new Response(JSON.stringify({ error: 'unknown op' }), { status: 400, headers: JSON_H });
    } catch (e) {
      console.error('statement api failed:', String(e.message).slice(0, 200));
      return new Response(JSON.stringify({ error: 'something went wrong on our side' }), { status: 500, headers: JSON_H });
    }
  }

  // ── the page ───────────────────────────────────────────────────────────────────────────────────
  const token = (url.pathname.split('/')[2] || '').trim();
  if (!TOKEN.test(token)) { const r = notFound(); return new Response(r.body, { status: r.statusCode, headers: HTML }); }
  if (!dbConfigured()) {
    return new Response(shell('Statement unavailable', `
      <h1>We cannot reach your ledger right now.</h1>
      <p class="sub">This is our problem, not yours, and nothing on your bill changes while it is happening. Try again in a minute, or write to <a href="mailto:info@reddenda.com" style="color:#E3FF4F">info@reddenda.com</a>.</p>`),
    { status: 503, headers: HTML });
  }

  try {
    const s = await readStatement(token, url.searchParams.get('cycle'));
    if (!s || s.error) { const r = notFound(); return new Response(r.body, { status: r.statusCode, headers: HTML }); }
    return new Response(render(s, token), { status: 200, headers: HTML });
  } catch (e) {
    console.error('statement page failed:', String(e.message).slice(0, 200));
    return new Response(shell('Statement unavailable', `
      <h1>We could not build your statement.</h1>
      <p class="sub">Nothing on your bill changed. Write to <a href="mailto:info@reddenda.com" style="color:#E3FF4F">info@reddenda.com</a> and a person will read it to you.</p>`),
    { status: 500, headers: HTML });
  }
};

export const config = { path: ['/statement/:token', '/api/statement'] };
