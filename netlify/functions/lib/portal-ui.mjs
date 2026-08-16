// portal-ui.mjs : every pixel the customer portal renders.
//
// Kept apart from portal.mjs on purpose. The handler decides WHO may see a thing; this file
// decides what it looks like. Nothing in here reads a cookie, touches the database or knows what
// a session is, so a rendering bug can never become an authorisation bug, and every function here
// can be called from a test with a plain object and screenshotted without a server.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE GROUND IS HALOGEN, AND THAT IS THE DOCUMENTED SYSTEM, NOT A PREFERENCE
//
// assets/answered.css names --bone #F2F4F0 "the paper, and the business-side ground". The
// consumer surfaces are Obsidian night; the business surfaces are paper. A contractor reads this
// in a truck, in daylight, and sometimes prints it, so paper is also simply correct. The
// homeowner's confirmation page (job.mjs) already made the same call, which means a customer and
// the business he booked with see one company.
//
// Every colour below was MEASURED against its own ground before it was used, because a dark red
// that looks urgent is 3.24:1 on Halogen and fails for text at any size:
//   ink   #0B0C0E on Halogen 17.68:1   meta  #57534B 6.91:1   void  #A8001F 7.07:1
//   live  #0A6C8C 5.37:1               good  #1B6B2F 5.95:1   obsidian on Hi-Vis 17.41:1
// #FF3355 appears ONLY as a 2px border or a large fill, and the only text allowed on top of it is
// Obsidian at 5.46:1. It is never a text colour on paper.
//
// TYPE: Switzer for everything a person reads, Archivo Expanded for the two display lines, Martian
// Mono for numerals. No serif at any size on any surface, including in the fallback stacks.

export const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ── the shell ────────────────────────────────────────────────────────────────────────────────

const FONTS = `
@font-face{font-family:'Archivo';src:url('/assets/fonts/archivo-expanded-700.woff2') format('woff2');font-weight:700;font-stretch:125%;font-display:swap}
@font-face{font-family:'Switzer';src:url('/assets/fonts/switzer-400.woff2') format('woff2');font-weight:400;font-display:swap}
@font-face{font-family:'Switzer';src:url('/assets/fonts/switzer-700.woff2') format('woff2');font-weight:700;font-display:swap}
@font-face{font-family:'Martian Mono';src:url('/assets/fonts/martian-mono-400-600.woff2') format('woff2');font-weight:400 600;font-display:swap}`;

const CSS = `${FONTS}
:root{
  --paper:#F2F4F0; --card:#FFFFFF; --ink:#0B0C0E; --meta:#57534B; --line:#D7DBD3;
  --hivis:#E3FF4F; --void:#A8001F; --void-edge:#FF3355; --live:#0A6C8C; --good:#1B6B2F;
  --sans:'Switzer',ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial;
  --display:'Archivo','Switzer',ui-sans-serif,-apple-system,'Segoe UI',Arial;
  --mono:'Martian Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);
  font-size:16px;line-height:1.55;-webkit-font-smoothing:antialiased;overflow-x:hidden}
h1,h2,h3,p,dl,dd,ul,figure{margin:0}
ul{padding-left:1.05rem}
img,svg{display:block;max-width:100%}
a{color:var(--ink)}
.sheet{max-width:640px;margin:0 auto;padding:clamp(20px,5vw,40px) clamp(16px,4.5vw,40px) 64px}
.sheet.wide{max-width:860px}

/* header */
.top{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin:0 0 24px}
.mark{display:flex;align-items:center;gap:9px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;
  color:var(--meta);font-weight:700}
.dot{width:9px;height:9px;border-radius:50%;background:var(--ink);flex:none}
.ref{font-family:var(--mono);font-size:12px;color:var(--meta);letter-spacing:-.02em}

/* type */
h1{font-family:var(--display);font-weight:700;font-stretch:125%;letter-spacing:-.02em;
  font-size:clamp(26px,6.4vw,38px);line-height:1.08;margin:0 0 8px}
.sub{color:#454138;font-size:clamp(15px,4vw,17px);margin:0 0 24px}
h2{font-family:var(--display);font-weight:700;font-stretch:125%;font-size:13px;letter-spacing:.13em;
  text-transform:uppercase;color:var(--meta);margin:32px 0 10px}
h3{font-size:16px;font-weight:700;margin:0 0 4px;letter-spacing:-.01em}
.small{font-size:13.5px;color:var(--meta);overflow-wrap:anywhere}
/* ★ A MONO IDENTIFIER IS THE WIDEST THING ON THIS PAGE AND IT DOES NOT WRAP ON ITS OWN. A Twilio
   call sid is 34 characters, and 34 characters of Martian Mono measured 308px inside a 288px
   column at 320px, pushing the whole document to 343px. Every element still reported a sensible
   width; only documentElement.scrollWidth caught it. Breaking mid-string is correct for an id. */
.num{font-family:var(--mono);font-variant-numeric:tabular-nums;letter-spacing:-.03em;overflow-wrap:anywhere}

/* blocks */
.card{background:var(--card);border:2px solid var(--ink);border-radius:12px;
  padding:clamp(15px,4vw,22px);margin:0 0 16px}
.card.flat{border-width:1px;border-color:var(--line)}
.band{border:2px solid var(--ink);border-radius:10px;padding:13px 15px;margin:0 0 20px;font-size:14.5px;background:var(--hivis)}
.band b{display:block;margin-bottom:2px}
.band.stop{background:var(--card);border-color:var(--void-edge)}
.band.stop b{color:var(--void)}
.band.note{background:var(--card);border-color:var(--line);border-width:1px;color:var(--meta)}

/* the window */
.when .lab{font-size:11.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--meta);font-weight:700;margin:0 0 6px}
.when .day{font-family:var(--display);font-weight:700;font-stretch:125%;
  font-size:clamp(20px,5.2vw,26px);line-height:1.1;margin:0 0 2px}
.when .win{font-family:var(--mono);font-size:clamp(16px,4.4vw,19px);font-weight:600;margin:0;letter-spacing:-.03em}

/* facts */
dl{margin:0}
.row{display:flex;flex-wrap:wrap;gap:2px 16px;padding:11px 0;border-bottom:1px solid var(--line)}
.row:first-child{border-top:1px solid var(--line)}
dt{flex:0 0 104px;font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--meta);font-weight:700;margin:3px 0 0}
dd{flex:1 1 160px;min-width:0;margin:0;font-size:16px;overflow-wrap:anywhere}
/* ★ MEASURED, NOT GUESSED. At 320px the sheet leaves 288px of content, and a 104px label beside a
   190px flex-basis needs 310px, so the job number in tabular mono pushed the document to 343px and
   the whole page scrolled sideways. Every element still reported a sensible width of its own;
   only documentElement.scrollWidth showed it. Below 360px the label sits on its own line. */
@media(max-width:359px){
  dt{flex:0 0 100%}
  dd{flex:1 1 100%}
}
.none{color:var(--meta)}

/* controls */
.cta,button.cta{display:block;width:100%;text-align:center;background:var(--ink);color:var(--hivis);
  text-decoration:none;font-family:var(--sans);font-weight:700;font-size:17px;padding:16px 18px;
  border:2px solid var(--ink);border-radius:11px;margin:0 0 10px;min-height:52px;cursor:pointer}
.cta.ghost{background:var(--card);color:var(--ink)}
.cta.danger{background:var(--card);color:var(--void);border-color:var(--void-edge)}
.cta[aria-disabled="true"]{background:var(--card);color:var(--meta);border-color:var(--line);cursor:not-allowed}
a.tel{font-weight:700;text-decoration-thickness:2px;text-underline-offset:3px}
:focus-visible{outline:3px solid var(--live);outline-offset:2px}

/* filters */
.pills{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 18px;padding:0;list-style:none}
/* ★ 44px is the floor and it is MEASURED, not declared. These pills computed to 42px with
   min-height:40px and padding:8px, because min-height on an inline-block loses to the box the
   content actually makes. inline-flex plus the real minimum is what makes the number true. */
.pills a{display:inline-flex;align-items:center;border:2px solid var(--ink);border-radius:999px;
  padding:9px 15px;gap:6px;font-size:13.5px;font-weight:700;text-decoration:none;
  background:var(--card);min-height:44px;line-height:1.2}
.pills a[aria-current="page"]{background:var(--ink);color:var(--hivis)}
.pills .n{font-family:var(--mono);font-size:12px;letter-spacing:-.03em;opacity:.75}

/* job list */
.job{display:block;background:var(--card);border:2px solid var(--ink);border-radius:12px;
  padding:14px 16px;margin:0 0 12px;text-decoration:none}
.job.void{border-color:var(--line);border-width:1px;background:transparent}
.job .head{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:baseline;justify-content:space-between}
.job .w{font-family:var(--mono);font-size:13.5px;font-weight:600;letter-spacing:-.03em}
.job .p{font-family:var(--mono);font-size:13.5px;font-weight:600;letter-spacing:-.03em;white-space:nowrap}
.job h3{margin:6px 0 2px;font-size:17px}
.job .meta{font-size:13.5px;color:var(--meta);overflow-wrap:anywhere}
/* The job number is what a person reads out on the phone when he calls us about one of these, so
   it belongs on the row and not only on the receipt. Quiet, but present. */
.job .jref{font-size:11.5px;margin-top:5px;letter-spacing:-.02em}
.job .tag{display:inline-block;font-size:11px;letter-spacing:.1em;text-transform:uppercase;font-weight:700;
  border:1px solid var(--line);border-radius:999px;padding:2px 8px;margin:8px 6px 0 0;color:var(--meta)}
.job .tag.void{color:var(--void);border-color:var(--void-edge)}
.job .tag.soon{color:var(--live);border-color:var(--live)}

/* pieces */
.pieces{list-style:none;padding:0;margin:12px 0 0;display:grid;grid-template-columns:minmax(0,1fr);gap:6px}
@media(min-width:440px){.pieces{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
.pieces li{font-size:14px;display:flex;gap:8px;align-items:flex-start}
.pieces .y{color:var(--good);font-weight:700;flex:none}
.pieces .n{color:var(--void);font-weight:700;flex:none}

/* forms */
label{display:block;font-size:13px;color:var(--meta);font-weight:700;margin:14px 0 5px;letter-spacing:.02em}
input[type=email],input[type=text],input[type=tel],textarea,select{width:100%;background:var(--card);
  color:var(--ink);border:2px solid var(--ink);border-radius:9px;padding:12px 13px;font:inherit;
  font-size:16px;min-height:48px}
textarea{min-height:88px;resize:vertical}
input[readonly]{border-color:var(--line);color:var(--meta);font-family:var(--mono);font-size:12.5px;letter-spacing:-.03em}
fieldset{border:0;padding:0;margin:0}
legend{padding:0;font-size:13px;color:var(--meta);font-weight:700;letter-spacing:.02em}
.choice{display:flex;gap:11px;align-items:flex-start;padding:11px 0;border-bottom:1px solid var(--line);cursor:pointer}
.choice:last-of-type{border-bottom:0}
.choice input{margin:3px 0 0;width:22px;height:22px;flex:none;accent-color:#0B0C0E}
.choice span{font-size:15.5px}
.switch{display:flex;gap:12px;align-items:flex-start;padding:14px 0;border-bottom:1px solid var(--line)}
.switch:last-of-type{border-bottom:0}
.switch .body{flex:1 1 auto;min-width:0}
.switch .state{font-family:var(--mono);font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;
  font-weight:600;border:1px solid var(--line);border-radius:999px;padding:2px 9px;flex:none;color:var(--meta)}
.switch .state.on{color:var(--good);border-color:var(--good)}
.switch .state.blocked{color:var(--void);border-color:var(--void-edge)}
details{margin:0 0 16px}
summary{cursor:pointer;font-weight:700;padding:14px 0;min-height:48px;list-style:none}
summary::-webkit-details-marker{display:none}
summary::before{content:"+ ";font-family:var(--mono)}
details[open] summary::before{content:"- "}

/* footer */
.foot{border-top:2px solid var(--ink);padding-top:16px;margin-top:36px;font-size:13.5px;color:#454138}
.foot p{margin:0 0 9px}
.foot b{color:var(--ink)}
.err{color:var(--void);font-weight:700}
.ok{color:var(--good);font-weight:700}
.hr{border:0;border-top:1px solid var(--line);margin:26px 0}

@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
@media print{
  body{background:#fff}
  .sheet{max-width:none;padding:0}
  .cta,.pills,details,form,.band.note{display:none}
  .card{border:1px solid #000}
}`;

/**
 * Every page. `noindex` and a private cache posture are set in the response headers by the
 * handler; the meta tag here is belt and braces for the case where a page is saved to disk.
 */
export const shell = ({ title, body, wide = false, script = '' }) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="color-scheme" content="light">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head><body><main class="sheet${wide ? ' wide' : ''}">${body}</main>${script}</body></html>`;

const head = (right = '') => `<div class="top">
  <div class="mark"><span class="dot"></span>Answered</div>
  ${right}
</div>`;

// ── shared pieces ────────────────────────────────────────────────────────────────────────────

/** A real tel: link, or an honest sentence. Never a control that cannot dial. */
export const telOr = (e164, pretty, fallback) => (e164
  ? `<a class="tel" href="tel:${esc(e164)}">${esc(pretty || e164)}</a>`
  : `<span class="none">${esc(fallback)}</span>`);

const mapLink = (address) => `<a href="https://www.google.com/maps/search/?api=1&amp;query=${
  encodeURIComponent(address)}">Open in maps</a>`;

const flashBlock = (flash) => (flash
  ? `<div class="band ${flash.kind === 'err' ? 'stop' : 'note'}"><b class="${flash.kind === 'err' ? 'err' : 'ok'}">${
    esc(flash.title || (flash.kind === 'err' ? 'That did not work' : 'Done'))}</b>${esc(flash.text)}</div>`
  : '');

// ── the job receipt, /j/<token> ──────────────────────────────────────────────────────────────

/**
 * The contractor's receipt for one booked job.
 *
 * ★ THIS IS NOT /job/<token>. That page is the HOMEOWNER's confirmation: you are on the schedule,
 * here is your calendar file. This page is the other end of the same transaction: here is the job
 * we booked on your line, here is the call it came out of, here is what it costs you, and here is
 * the button that says no. Different reader, different job, different words.
 *
 * ORDER IS THE ARGUMENT. A contractor opening this on a phone wants to ACT first: when is it, and
 * what number do I ring. The money and the dispute come after, because a receipt that leads with
 * a charge reads like a bill, and this is a job.
 */
export function receiptPage({ job, account, call, price, token, flash, portalHint = true }) {
  const w = job.when || {};
  const service = (job.details && job.details.service) || 'A job';
  const notes = (job.details && job.details.notes) || '';
  const voided = job.status === 'voided';
  const shop = (account && account.business_name) || (job.details && job.details.shop_name) || '';
  const demo = job.details && job.details.mode === 'demo';

  const rows = [
    ['What', esc(service)],
    ['Who', job.caller_name ? esc(job.caller_name) : '<span class="none">No name was given on the call</span>'],
    ['Where', job.address
      ? `${esc(job.address)}<br>${mapLink(job.address)}`
      : '<span class="none">No address was given on the call</span>'],
    ['Call them', telOr(job.callback, job.callbackPretty, 'No callback number was given')],
    notes ? ['Notes', esc(notes)] : null,
    ['Booked', esc(job.bookedOn)],
    ['Job number', `<span class="num">${esc(job.job_ref)}</span>`],
  ].filter(Boolean);

  const callRow = call && (call.call_sid || call.summary) ? `
<h2>The call this came from</h2>
<div class="card flat">
  ${call.summary ? `<p>${esc(call.summary)}</p>` : '<p class="none">No summary was written for this call.</p>'}
  <p class="small" style="margin-top:10px">
    ${call.whenText ? `${esc(call.whenText)}. ` : ''}${call.lengthText ? `${esc(call.lengthText)}. ` : ''}
    ${call.call_sid ? `Call <span class="num">${esc(call.call_sid)}</span>.` : ''}
    ${call.recording_sid
    ? 'A recording of this call exists and an operator can pull it.'
    : 'No recording was kept for this call.'}
  </p>
</div>` : `
<h2>The call this came from</h2>
<div class="card flat"><p class="none">This job was not linked to a call record, so there is nothing to show here. That is a gap in what we stored, not something you did.</p></div>`;

  return shell({
    title: `${voided ? 'Voided: ' : ''}${service}${job.caller_name ? ` for ${job.caller_name}` : ''}`,
    body: `
${head(`<span class="ref">${esc(job.job_ref)}</span>`)}
${flashBlock(flash)}

<h1>${voided ? 'This job is voided.' : 'A job was booked on your line.'}</h1>
<p class="sub">${voided
    ? 'It stays here so there is a record of it. Nothing was deleted.'
    : `We answered the phone${shop ? ` for ${esc(shop)}` : ''} and booked this. Check it, and say no if it is wrong.`}</p>

${demo ? `<div class="band"><b>This one is pretend.</b> It came from the Answered demo line, so nobody is being dispatched and nothing is being billed. Everything else on this page is exactly what a real job looks like.</div>` : ''}

${voided ? `<div class="band stop"><b>Voided${job.voidedOn ? ` on ${esc(job.voidedOn)}` : ''}</b>${
  job.void_reason ? `Reason given: ${esc(job.void_reason)}. ` : 'No reason was written down. '
}A person settles the charge on the billing side, and you do not need to do anything else.</div>` : ''}

${w.known ? `
<div class="card when">
  <p class="lab">The window</p>
  <p class="day">${esc(w.day)}</p>
  <p class="win">${esc(w.window)}${w.zone ? ` ${esc(w.zone)}` : ''}</p>
</div>` : `
<div class="card when">
  <p class="lab">The window</p>
  <p class="day">No time was agreed</p>
  <p class="small" style="margin-top:6px">The caller did not settle on a window, so there is nothing to put in a calendar yet. A job without a confirmed window is free, and the cost box below says so.</p>
</div>`}

${job.callback && !voided
    ? `<a class="cta" href="tel:${esc(job.callback)}">Call ${esc(job.caller_name || 'them')} on ${esc(job.callbackPretty)}</a>`
    : ''}
${job.address && !voided
    ? `<a class="cta ghost" href="https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(job.address)}">Get directions</a>`
    : ''}

<h2>The job</h2>
<dl>
${rows.map(([k, v]) => `  <div class="row"><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('\n')}
</dl>

${costPanel(price, voided)}

${callRow}

${voided ? '' : disputeBlock(token, job)}

<div class="foot">
${portalHint ? `<p><b>Every job in one place.</b> This link opens this one job with no password, which is the point of it. If you want the whole list, your bookings, your settings and your calendar feed, <a href="/portal">sign in to your portal</a>.</p>` : ''}
<p><b>What we sent.</b> We emailed this to you, and email stays the record. Where you have asked for texts, the shop is told that way too.</p>
<p>This page is private and is not indexed. Anyone holding this link can see this job, so treat it like the job sheet it is.</p>
</div>`,
  });
}

/**
 * What this job costs, and which kind of fact that number is.
 *
 * ★ TWO DIFFERENT KINDS OF NUMBER, NEVER PRINTED THE SAME WAY. `ledger` is what billing actually
 * recorded and it is the stored, vetted figure. `published` is the price book applied to this row
 * because no charge exists yet, and the panel says exactly that out loud. Blurring them is how a
 * customer ends up arguing with a number nobody can explain.
 */
function costPanel(price, voided) {
  const free = !price.cents;
  const missing = price.missing_pieces || [];
  return `
<h2>What this costs you</h2>
<div class="card">
  <p class="day num" style="font-family:var(--mono);font-size:clamp(28px,8vw,40px);font-weight:600;letter-spacing:-.04em;margin:0 0 6px">${
  free ? 'Nothing' : esc(price.money)}</p>
  <p style="margin:0 0 4px">${esc(price.reason)}</p>
  ${price.source === 'ledger'
    ? `<p class="small" style="margin-top:8px">This is the charge on your bill${price.state ? `, currently ${esc(price.state)}` : ''}. It comes from the billing ledger, not from this page.</p>`
    : `<p class="small" style="margin-top:8px">No charge has been written against this job yet, so this is the published price for it. Your bill is built on the billing side and the monthly cap is applied there.</p>`}
  ${missing.length ? `<p class="small" style="margin-top:8px">Missing: ${esc(missing.join(', '))}.</p>` : ''}
  ${price.pieces ? `<ul class="pieces">${price.pieces.map((p) => `<li><span class="${p.ok ? 'y' : 'n'}">${p.ok ? '&#10003;' : '&#10007;'}</span><span>${esc(p.label)}${p.ok ? '' : ', not captured'}</span></li>`).join('')}</ul>` : ''}
  <p class="small" style="margin-top:12px">A job is billed only when it has a name, an address, a callback number and a confirmed window. Anything less is free. Your bill stops at ${esc(price.capText)} a month however many jobs we book.</p>
  ${voided ? '<p class="small" style="margin-top:8px">This job is voided. A person settles the charge attached to it on the billing side.</p>' : ''}
</div>`;
}

/**
 * The control that rescues the promise.
 *
 * A text cannot reach this customer today, so the link in the email is the only place a dispute
 * can start. It is a real form that posts and redirects, so it works with JavaScript switched off,
 * and the reasons are a closed list because a free text box alone gives an operator nothing to
 * count.
 */
function disputeBlock(token, job) {
  return `
<h2>If this is wrong</h2>
<details>
  <summary>Something is wrong with this job</summary>
  <div class="card">
    <p class="small" style="margin-bottom:6px">Voiding marks the job cancelled and records why. It does not delete it: it stays on your list and on ours, which is what makes it checkable later.</p>
    <form method="POST" action="/api/portal/void">
      <input type="hidden" name="t" value="${esc(token)}">
      <fieldset>
        <legend>What is wrong with it</legend>
        ${(job.reasons || []).map((r, i) => `
        <label class="choice"><input type="radio" name="reason" value="${esc(r.key)}"${i === 0 ? ' required' : ''}><span>${esc(r.label)}</span></label>`).join('')}
      </fieldset>
      <label for="note">Anything you want to add, in your words</label>
      <textarea id="note" name="note" maxlength="500" placeholder="Optional. A person reads this."></textarea>
      <p style="margin-top:14px"><button class="cta danger" type="submit">Void this job</button></p>
    </form>
    <p class="small">We email a person the moment you send this. The charge attached to the job is settled on the billing side, by a human, and you will hear back.</p>
  </div>
</details>`;
}

// ── the portal, /portal ──────────────────────────────────────────────────────────────────────

const FILTERS = [
  ['all', 'Everything'],
  ['upcoming', 'Still coming'],
  ['done', 'Been and gone'],
  ['voided', 'Voided'],
];

export function portalPage({ account, state, jobs, counts, filter, month, prefs, gates, feed, flash, jobsError }) {
  const biz = account.business_name || 'Your business';
  return shell({
    wide: true,
    title: `${biz} jobs`,
    body: `
${head(`<form method="POST" action="/portal/signout" style="margin:0"><button type="submit" style="background:none;border:0;padding:8px 0;font:inherit;font-size:13.5px;font-weight:700;color:#57534B;cursor:pointer;min-height:44px;text-decoration:underline">Sign out</button></form>`)}
${flashBlock(flash)}

<h1>${esc(biz)}</h1>
<p class="sub">${esc(state.headline)}. ${esc(state.detail)}</p>

<h2>Booked jobs</h2>
${jobsError
    ? `<div class="band stop"><b>We cannot read your jobs right now</b>Nothing is lost and nothing is deleted. This is our side, not yours. Try again in a minute, and if it keeps happening reply to any email from us.</div>`
    : `${filterPills(filter, counts)}
${jobs.length ? jobs.map(jobCard).join('\n') : emptyState(state, counts)}`}

${monthPanel(month)}

<h2>How we tell you</h2>
${notifyPanel(prefs, gates)}

<h2>Your calendar</h2>
${feedPanel(feed)}

<div class="foot">
<p><b>Your answering rules live on a different page.</b> What your line says, your hours, your prices and who it puts through are on <a href="/account">your account page</a>. This page is only the jobs it booked.</p>
<p><b>You never need this page to see a job.</b> Every email we send carries a link that opens that job with no password. This is here for when you want the whole list at once.</p>
<p>This page is private and is not indexed. Signing out on this device does not stop the emails.</p>
</div>`,
    script: COPY_SCRIPT,
  });
}

function filterPills(current, counts) {
  return `<ul class="pills">${FILTERS.map(([k, label]) => {
    const n = counts[k] || 0;
    return `<li><a href="/portal?show=${k}"${k === current ? ' aria-current="page"' : ''}>${esc(label)} <span class="n">${n}</span></a></li>`;
  }).join('')}</ul>`;
}

function jobCard(j) {
  const voided = j.status === 'voided';
  return `<a class="job${voided ? ' void' : ''}" href="/j/${esc(j.token)}">
  <div class="head">
    <span class="w">${esc(j.whenShort)}</span>
    <span class="p">${esc(j.priceShort)}</span>
  </div>
  <h3>${esc(j.service)}</h3>
  <p class="meta">${esc(j.caller_name || 'No name given')}${j.address ? ` &middot; ${esc(j.address)}` : ''}</p>
  <p class="meta num jref">${esc(j.job_ref)}</p>
  ${voided ? '<span class="tag void">Voided</span>' : ''}
  ${j.upcoming && !voided ? '<span class="tag soon">Still coming</span>' : ''}
  ${j.after_hours ? '<span class="tag">After hours</span>' : ''}
  ${j.freeReason ? `<span class="tag">Free: ${esc(j.freeReason)}</span>` : ''}
</a>`;
}

/**
 * The empty state, and it is the one every account sees today.
 *
 * ★ AN EMPTY LIST HAS TO SAY WHICH KIND OF EMPTY IT IS. "No jobs yet" under a live line means
 * nobody called. The same words under an account with no phone number mean something completely
 * different and the customer would be waiting for a thing that cannot happen. So the sentence is
 * chosen from the account's real state, and none of them invent a row to fill the space.
 */
function emptyState(state, counts) {
  const anyAtAll = (counts.all || 0) > 0;
  if (anyAtAll) {
    return `<div class="card flat"><h3>Nothing in this view</h3><p class="small">You have ${counts.all} job${counts.all === 1 ? '' : 's'} in total. This filter just does not match any of them. <a href="/portal?show=all">Show everything</a>.</p></div>`;
  }
  return `<div class="card flat">
  <h3>No jobs yet, and that is a real zero</h3>
  <p class="small">${esc(state.emptyWhy)}</p>
  <p class="small" style="margin-top:8px">Nothing is hidden here and nothing is a sample. When we book one, it appears on this page and lands in your email within seconds.</p>
</div>`;
}

function monthPanel(m) {
  if (!m || !m.countable) return '';
  return `
<h2>This month</h2>
<div class="card flat">
  <p><span class="num" style="font-size:22px;font-weight:600">${esc(m.total)}</span> across ${m.billable} billable job${m.billable === 1 ? '' : 's'}${m.free ? `, with ${m.free} free` : ''}.</p>
  <p class="small" style="margin-top:8px">This is the published price of the jobs on this page, added up. It is not your bill. Your bill is built on the billing side from its own ledger, and the ${esc(m.cap)} monthly cap is applied there, so what you actually pay can be lower than this and never higher.</p>
</div>`;
}

/**
 * The channels, and the one ruling that shaped them.
 *
 * David: "There's a reason they're hiring us. It's because they don't answer the phone." Our
 * customer is the person who does not pick up, so a call is the wrong default. Email is automatic
 * and has no switch. Text is a default that a carrier is blocking. A call is opt-in, and the
 * control is DISABLED while nothing on this deploy can dial, with the reason in words, because a
 * control that cannot act must never render as though it can.
 */
function notifyPanel(p, gates) {
  const sms = gates.sms;
  const call = gates.call;
  return `<form method="POST" action="/api/portal/settings" class="card">
  <div class="switch">
    <div class="body">
      <h3>Email</h3>
      <p class="small">Always on. Every booked job is emailed to ${esc(p.owner_email)} the moment it happens, with a link that opens it without a password.</p>
      <label for="email_extra">Send it to somebody else too</label>
      <input id="email_extra" name="email_extra" type="text" inputmode="email" value="${esc((p.email_extra || []).join(', '))}" placeholder="office@yourbusiness.com, partner@yourbusiness.com">
      <p class="small" style="margin-top:6px">Separate them with commas. Leave it empty to send to you only.</p>
    </div>
    <span class="state on">Always</span>
  </div>

  <div class="switch">
    <div class="body">
      <h3>Text message</h3>
      <label class="choice" style="border:0;padding:8px 0">
        <input type="checkbox" name="sms_on" value="1"${p.sms_on ? ' checked' : ''}>
        <span>Text me when a job is booked</span>
      </label>
      <label for="sms_to">Text this number</label>
      <input id="sms_to" name="sms_to" type="tel" inputmode="tel" value="${esc(p.sms_to_pretty || '')}" placeholder="${esc(p.owner_phone_pretty || 'Your mobile')}">
      <p class="small" style="margin-top:6px">${esc(sms.reason || 'Texts send as soon as a job is booked.')}</p>
    </div>
    <span class="state ${sms.ready ? 'on' : 'blocked'}">${sms.ready ? 'On' : 'Blocked'}</span>
  </div>

  <div class="switch">
    <div class="body">
      <h3>Phone call</h3>
      ${call.ready ? '<input type="hidden" name="call_editable" value="1">' : ''}
      <label class="choice" style="border:0;padding:8px 0">
        <input type="checkbox" name="call_on" value="1"${p.call_on ? ' checked' : ''}${call.ready ? '' : ' disabled'}>
        <span>Call me when a job is booked${call.ready ? '' : ' (not available yet)'}</span>
      </label>
      <label class="choice" style="border:0;padding:0 0 8px">
        <input type="checkbox" name="call_after_hours_only" value="1"${p.call_after_hours_only ? ' checked' : ''}${call.ready ? '' : ' disabled'}>
        <span>Only after hours, nights and weekends</span>
      </label>
      <p class="small">${call.ready
    ? 'We ring you and read the job out. It is a recorded assistant and it says so first.'
    : esc(call.reason)}</p>
      <p class="small" style="margin-top:6px">A call is off unless you ask for it, on purpose. You hired us because the phone is the thing you cannot get to, so a call about a booking is for a two in the morning emergency, not for routine news.</p>
    </div>
    <span class="state ${p.call_on && call.ready ? 'on' : ''}">${call.ready ? (p.call_on ? 'On' : 'Off') : 'Off'}</span>
  </div>

  <p style="margin-top:16px"><button class="cta" type="submit">Save how we tell you</button></p>
</form>`;
}

function feedPanel(feed) {
  if (!feed || !feed.url) {
    return `<div class="card flat"><p class="none">The calendar feed is off on this deploy, because it needs a signing key that is not set here. Nothing else on this page depends on it.</p></div>`;
  }
  return `<div class="card flat">
  <p>Every booked job, in the calendar you already use. Add this address once and it keeps itself up to date. A job you void turns into a cancelled event rather than quietly disappearing.</p>
  <label for="feedurl">Your private calendar address</label>
  <input id="feedurl" readonly value="${esc(feed.url)}" onclick="this.select()" aria-describedby="feedwarn">
  <p class="small" id="feedwarn" style="margin-top:8px">Treat this like a key. Anyone who has it can see your jobs, so do not post it anywhere public. In Google Calendar it goes under "Other calendars", then "From URL". On an iPhone it goes under Calendar, "Add Account", "Other", "Add Subscribed Calendar".</p>
</div>`;
}

/**
 * Progressive enhancement, done the way this estate requires: the button is CREATED by the script.
 * With JavaScript off it never exists, so there is no copy control that cannot copy. The input is
 * selectable on its own, which is why the page is already usable without this.
 */
const COPY_SCRIPT = `<script>
(function(){
  var i=document.getElementById('feedurl'); if(!i||!navigator.clipboard) return;
  var b=document.createElement('button');
  b.type='button'; b.className='cta ghost'; b.style.marginTop='10px'; b.textContent='Copy the address';
  b.addEventListener('click',function(){
    navigator.clipboard.writeText(i.value).then(function(){ b.textContent='Copied'; },
      function(){ b.textContent='Could not copy, select it by hand'; });
  });
  i.parentNode.insertBefore(b,i.nextSibling);
})();
</script>`;

// ── the door, /portal/login ──────────────────────────────────────────────────────────────────

export const loginPage = ({ flash, next } = {}) => shell({
  title: 'Sign in to your Answered portal',
  body: `
${head()}
${flashBlock(flash)}
<h1>Your jobs, in one place.</h1>
<p class="sub">Every job we book you is emailed to you with a link that opens it on its own, with no password. Sign in only when you want to see the whole list at once.</p>

<div class="card">
  <form method="POST" action="/api/portal/login">
    ${next ? `<input type="hidden" name="next" value="${esc(next)}">` : ''}
    <label for="email">The email you signed up with</label>
    <input id="email" name="email" type="email" required autocomplete="email" inputmode="email" placeholder="you@yourbusiness.com">
    <p style="margin-top:16px"><button class="cta" type="submit">Send me a link</button></p>
  </form>
  <p class="small">There is no password. We email you a link, it works once, and it stops working in twenty minutes.</p>
</div>

<div class="foot">
<p><b>Signing in does not turn anything on and does not call anybody.</b> It only shows you what has already happened.</p>
<p>Looking for what your line says when it answers? That is on <a href="/account">your account page</a>.</p>
</div>`,
});

export const sentPage = () => shell({
  title: 'Check your email',
  body: `
${head()}
<h1>Check your email.</h1>
<p class="sub">If that address has an account, a link is on its way. It works once and it stops working in twenty minutes.</p>
<div class="card flat">
  <p class="small">We answer the same way whether or not that address is one of ours. That is on purpose: it means nobody can use this box to find out who our customers are.</p>
</div>
<div class="foot"><p><a href="/portal/login">Back to sign in</a></p></div>`,
});

// ── the honest failures ──────────────────────────────────────────────────────────────────────

export const notFoundPage = () => shell({
  title: 'That job link did not open',
  body: `
${head()}
<h1>That link did not open.</h1>
<p class="sub">It is either mistyped, or it was cut in half by the app you copied it from. Job links are long, so that happens more than you would think.</p>
<div class="foot">
<p><b>What to do:</b> open the whole link straight from the email, or <a href="/portal">sign in</a> and pick the job off your list. Both land in the same place.</p>
<p>If you were not expecting this page, nothing has happened and there is nothing to cancel.</p>
</div>`,
});

export const downPage = (why, what = 'This page') => shell({
  title: 'That is off right now',
  body: `
${head()}
<h1>${esc(what)} is off right now.</h1>
<p class="sub">This is our side, not yours, and nothing you did caused it. Nothing has been lost and nothing has been deleted.</p>
<div class="card flat"><p class="small">Recorded: ${esc(why)}</p></div>
<div class="foot"><p>Try again in a minute. If it keeps happening, reply to any email from us and a person picks it up.</p></div>`,
});
