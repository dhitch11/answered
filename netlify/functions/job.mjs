// GET /job/:token            the page a customer lands on when a call became a job
// GET /job/:token/calendar.ics   the same job as a real RFC 5545 file
//
// This is the artifact at the end of the promise. Everything on the marketing site argues that a
// missed call turns into a booked job; this is the page the customer actually opens, and it is the
// page a contractor will screenshot to decide whether we are serious.
//
// FOUR THINGS IT DOES ON PURPOSE:
//
// 1. IT READS NOTHING. The job is in the signed token, so this page cannot be taken down by a
//    database, a blob store, or a package that failed to resolve in the bundler. Prod was
//    measured in exactly that state on the day this shipped.
// 2. IT IS A REAL PHONE COMPANY. The 08-12 redesign war room's unanimous number one finding was
//    a phone company you cannot call: zero tel: links on the whole site. Every number on this page
//    is a tel: link, and where a number was never captured the page says so instead of rendering
//    a control that cannot act.
// 3. IT WORKS WITH JAVASCRIPT OFF. There is none. Add-to-calendar is an anchor to a file. The
//    print stylesheet turns it into a work order for the truck.
// 4. IT NEVER PRETENDS. A demo booking wears a band saying nobody is being dispatched, and the
//    footer says plainly that we did not text anyone, because texting is not switched on yet.

import * as bk from './lib/booking.mjs';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const HEAD = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

const CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:#0B0C0E;color:#0B0C0E;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  font-size:16px;line-height:1.55;overflow-x:hidden}
.sheet{max-width:640px;margin:0 auto;background:#F2F4F0;min-height:100vh;
  padding:clamp(22px,6vw,44px) clamp(18px,5vw,44px) 56px}
.mark{display:flex;align-items:center;gap:9px;font-size:12px;letter-spacing:.14em;
  text-transform:uppercase;color:#57534B;font-weight:700;margin:0 0 26px}
.dot{width:9px;height:9px;border-radius:50%;background:#0B0C0E;flex:none}
h1{font-size:clamp(27px,7vw,38px);line-height:1.12;margin:0 0 6px;font-weight:800;letter-spacing:-.02em}
.sub{margin:0 0 26px;color:#454138;font-size:clamp(15px,4vw,17px)}
.band{margin:0 0 24px;padding:13px 15px;background:#E3FF4F;border:2px solid #0B0C0E;
  border-radius:9px;font-size:14.5px}
.band b{display:block;margin-bottom:2px}
.when{border:2px solid #0B0C0E;border-radius:12px;padding:clamp(16px,4vw,22px);margin:0 0 22px;background:#fff}
.when .lab{font-size:11.5px;letter-spacing:.16em;text-transform:uppercase;color:#57534B;font-weight:700;margin:0 0 7px}
.when .day{font-size:clamp(20px,5.4vw,26px);font-weight:800;margin:0 0 3px;letter-spacing:-.01em}
.when .win{font-size:clamp(17px,4.6vw,20px);font-weight:600;margin:0;color:#26231F}
dl{margin:0 0 24px;display:grid;grid-template-columns:1fr;gap:0}
.row{display:flex;flex-wrap:wrap;gap:4px 16px;padding:11px 0;border-bottom:1px solid #D7DBD3}
.row:first-child{border-top:1px solid #D7DBD3}
dt{flex:0 0 108px;font-size:12.5px;letter-spacing:.09em;text-transform:uppercase;color:#57534B;
  font-weight:700;margin:2px 0 0}
dd{flex:1 1 200px;min-width:0;margin:0;font-size:16px;overflow-wrap:anywhere}
a{color:#0B0C0E}
a.tel{font-weight:800;text-decoration-thickness:2px;text-underline-offset:3px}
.cta{display:block;text-align:center;background:#0B0C0E;color:#E3FF4F;text-decoration:none;
  font-weight:800;font-size:17px;padding:17px 20px;border-radius:11px;margin:0 0 12px}
.cta.ghost{background:#fff;color:#0B0C0E;border:2px solid #0B0C0E}
.hint{margin:0 0 26px;font-size:13.5px;color:#57534B;text-align:center}
.foot{border-top:2px solid #0B0C0E;padding-top:16px;font-size:13px;color:#454138}
.foot p{margin:0 0 9px}
.foot b{color:#0B0C0E}
.no{color:#57534B;font-style:normal}
@media print{
  body{background:#fff}
  .sheet{max-width:none;min-height:0;padding:0}
  .cta,.hint{display:none}
  .band{background:#fff;border:2px solid #000}
}
`;

const page = ({ title, body }) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="color-scheme" content="light">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head><body><main class="sheet">${body}</main></body></html>`;

const notFound = () => new Response(page({
  title: 'That job link did not open',
  body: `
<div class="mark"><span class="dot"></span>Answered</div>
<h1>That link did not open.</h1>
<p class="sub">The link is either mistyped, or it was cut in half by the app you copied it from. Job links are long, so that happens.</p>
<div class="foot">
<p><b>What to do:</b> open the whole link from the email we sent you, or call the shop directly and give them your job number. They have the booking on their side either way.</p>
<p>Answered books jobs for local trades. If you were not expecting this page, nothing has happened and there is nothing to cancel.</p>
</div>`,
}), { status: 404, headers: HEAD });

const notConfigured = () => new Response(page({
  title: 'Job pages are off on this deploy',
  body: `
<div class="mark"><span class="dot"></span>Answered</div>
<h1>Job pages are switched off here.</h1>
<p class="sub">This deploy has no signing key, so it cannot check whether a job link is genuine. It is refusing to show anything rather than showing something it cannot verify.</p>
<div class="foot"><p><b>Operator:</b> set ANSWERED_BOOKING_KEY on this site and redeploy.</p></div>`,
}), { status: 503, headers: HEAD });

/** A tel: link, or an honest sentence about why there is not one. Never a dead control. */
const telOr = (e164, fallbackText) => (e164
  ? `<a class="tel" href="tel:${esc(e164)}">${esc(bk.prettyPhone(e164))}</a>`
  : `<span class="no">${esc(fallbackText)}</span>`);

function render(job, token) {
  const w = bk.whenParts(job);
  const demo = job.m === 'demo';
  const mapHref = job.a ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(job.a)}` : '';

  const rows = [
    ['Who', esc(job.s)],
    ['Job', esc(job.w)],
    job.a ? ['Where', `${esc(job.a)}<br><a href="${esc(mapHref)}">Open in maps</a>`] : null,
    ['Booked for', esc(job.c)],
    job.cp ? ['Your number', telOr(job.cp, '')] : null,
    job.n ? ['Notes', esc(job.n)] : null,
    ['Job number', esc(job.id)],
  ].filter(Boolean);

  const changeIt = job.sp
    ? `<p><b>Need to move it or cancel?</b> Call ${job.s ? esc(job.s) : 'the shop'} on ${telOr(job.sp, '')}. A person picks up.</p>`
    : `<p><b>Need to move it or cancel?</b> Reply to the email this link came in. We did not get a callback number for the shop, so this page will not pretend to give you one.</p>`;

  return page({
    title: `${demo ? 'Demo booking: ' : ''}${job.w} with ${job.s}`,
    body: `
<div class="mark"><span class="dot"></span>Answered</div>
<h1>${demo ? 'Here is how a booking looks.' : 'You are on the schedule.'}</h1>
<p class="sub">${demo
    ? 'This is the real page a customer gets, built from a real booking on the demo line.'
    : `${esc(job.s)} has you down for the window below.`}</p>

${demo ? `<div class="band"><b>This one is pretend.</b> It came from the Answered demo line, so nobody is being dispatched and there is nothing to cancel. Everything else on this page, including the calendar file, is exactly what a real customer receives.</div>` : ''}

<div class="when">
  <p class="lab">Your window</p>
  <p class="day">${esc(w.day)}</p>
  <p class="win">${esc(w.window)}${w.zone ? ` ${esc(w.zone)}` : ''}</p>
</div>

<dl>
${rows.map(([k, v]) => `  <div class="row"><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('\n')}
</dl>

<a class="cta" href="/job/${esc(token)}/calendar.ics">Add it to my calendar</a>
${job.sp ? `<a class="cta ghost" href="tel:${esc(job.sp)}">Call ${esc(job.s)}</a>` : ''}
<p class="hint">The calendar file works on iPhone, Android, Google Calendar and Outlook. It sets a reminder one hour before.</p>

<div class="foot">
${changeIt}
<p><b>We did not text you.</b> Text messaging is not switched on yet, so email is the only channel that actually delivers. When texting is on, this page will say so.</p>
<p>Booked by Answered, which answers the phone for local trades. Booked ${esc(new Date(job.at || Date.now()).toISOString().slice(0, 10))}. This page is private and is not indexed.</p>
</div>`,
  });
}

export default async (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  if (!bk.canSign()) return notConfigured();

  const path = new URL(req.url).pathname;
  const m = /^\/job\/([^/]+?)(\/calendar\.ics)?\/?$/.exec(path);
  if (!m) return notFound();

  const token = decodeURIComponent(m[1]);
  const wantsIcs = Boolean(m[2]);
  const job = bk.verify(token);

  if (!job) {
    // A forged, tampered or expired-key token and a typo land in the same place, and the response
    // says nothing about which. There is no oracle here for someone probing signatures.
    if (wantsIcs) return new Response('That job link did not open.\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    return notFound();
  }

  if (wantsIcs) {
    const body = bk.ics(job, { url: bk.jobUrl(token) });
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8; method=PUBLISH',
        'Content-Disposition': `attachment; filename="${job.id}.ics"`,
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  return new Response(render(job, token), { status: 200, headers: HEAD });
};

// ★ A SPLAT, NOT `/job/:token`, AND THE REASON IS THE TOKEN'S SHAPE.
// A job token is `v1.<payload>.<signature>`, so it carries dots, and whether a `:param` segment
// matches a dotted value is a property of the router's URLPattern implementation rather than of
// this code. I cannot test Netlify's router from a workstation, and the failure mode is silent:
// the route simply would not match and every emailed booking link would 404, after the customer
// had already been told to click it. A splat cannot have that argument with anyone. The handler
// parses the pathname itself either way, so nothing above depends on a captured parameter.
export const config = { path: '/job/*' };
