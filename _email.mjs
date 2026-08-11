// Post-deploy notification. Secrets by name only: RESEND_API_KEY from env, never logged.
const KEY = process.env.RESEND_API_KEY;
if (!KEY) { console.error('no RESEND_API_KEY in env, not sending'); process.exit(1); }

const DEPLOY = process.argv[2] || 'unknown';

const html = `
<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1E1B17;max-width:720px">

<div style="background:#26231F;color:#F6EFE0;padding:18px 20px;border-radius:10px;margin-bottom:22px">
<div style="font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.16em;color:#D9A263;margin-bottom:8px">ACTION NEEDED</div>
<b>1. One DNS record, and only you can do it.</b> Neither <code>answer.reddenda.com</code> nor <code>answered.reddenda.com</code> exists yet. reddenda.com sits on Namecheap nameservers (dns1/dns2.registrar-servers.com), not Netlify DNS, so no terminal can add it. Tell me the exact hostname you want and add a CNAME at Namecheap pointing it at <code>answered-preview.netlify.app</code>, then I will attach the domain in Netlify. Nothing in the build hardcodes a host, so this is a five minute change whenever you want it.<br><br>
<b>2. Three prices are deliberately NOT on the site.</b> The war room labelled the $549/mo meter cap, the $39/mo quiet line minimum, and the 10/15/20% contingency tiers as ESTIMATED. A published price is very hard to walk back, so I withheld all three. Say the word and they go up in one edit.
</div>

<h2 style="font-size:20px;margin:0 0 6px">Answered is live</h2>
<p style="margin:0 0 18px"><a href="https://answered-preview.netlify.app" style="color:#8A5A22"><b>https://answered-preview.netlify.app</b></a><br>
<span style="font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#6B6459">Netlify project <b>answered-preview</b> &middot; site 2c9f4ae6-f61c-4c1f-96ba-2a467fec00f3 &middot; prod deploy <b>${DEPLOY}</b></span></p>

<p style="margin:0 0 18px">Six pages, warm dark and cinematic, dropping to bone paper for every artifact the reader has to believe. It is its own Netlify project, so no other lane's deploy can overwrite it and it cannot overwrite theirs.</p>

<table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:22px">
<tr><td style="padding:7px 0;border-bottom:1px solid #E7DECE"><b>/</b></td><td style="padding:7px 0;border-bottom:1px solid #E7DECE">The whole offering. 60 second setup, the three products, the moat, the ledger</td></tr>
<tr><td style="padding:7px 0;border-bottom:1px solid #E7DECE"><b>/trades.html</b></td><td style="padding:7px 0;border-bottom:1px solid #E7DECE">Answered. The math on a missed call, one dial code, the 2am case</td></tr>
<tr><td style="padding:7px 0;border-bottom:1px solid #E7DECE"><b>/hold.html</b></td><td style="padding:7px 0;border-bottom:1px solid #E7DECE">Hold. The consumer product and the hold receipt</td></tr>
<tr><td style="padding:7px 0;border-bottom:1px solid #E7DECE"><b>/recover.html</b></td><td style="padding:7px 0;border-bottom:1px solid #E7DECE">Recover. Launch fork only, Money Out There, the state licence gate</td></tr>
<tr><td style="padding:7px 0;border-bottom:1px solid #E7DECE"><b>/pricing.html</b></td><td style="padding:7px 0;border-bottom:1px solid #E7DECE">The Outcome Ledger. No subscriptions, no minutes, three billable events</td></tr>
<tr><td style="padding:7px 0;border-bottom:1px solid #E7DECE"><b>/trust.html</b></td><td style="padding:7px 0;border-bottom:1px solid #E7DECE">How a contractor audits the robot from the truck</td></tr>
</table>

<h3 style="font-size:16px;margin:0 0 8px">What I built to your last two notes</h3>
<p style="margin:0 0 8px"><b>Setup speed is now the first thing on the page.</b> Hero eyebrow reads "Live in 60 seconds. One code, from your own phone." A dedicated section walks the four steps and ends on "We prove it before we promise it", because the live test call is the part nobody else ships. Three mode cards: *71 catch what you miss, *72 let it take the whole line, *73 yours to switch off in ten seconds.</p>
<p style="margin:0 0 8px"><b>The moat is its own section</b>, titled "Anyone can rent a voice. The intelligence is the company." Four cards: carrier intelligence and activation verification, the guardrails, the outcome ledger, compliance in code. It closes on the compounding argument, that a competitor can rent the same voice tomorrow but cannot rent the record of ten thousand calls that already went right.</p>
<p style="margin:0 0 18px"><b>Positive throughout.</b> Every negative frame is gone. The hero ring used to ring out and read "No answer"; it now resolves and reads <b>Answered</b>, so the brand name lands on screen every six seconds. "What we will not say" became "Built to be believed." No line on the site leads with a competitor's failure or a regulator's fine, and the claims discipline is unchanged underneath.</p>

<h3 style="font-size:16px;margin:0 0 8px">Verified, not asserted</h3>
<p style="margin:0 0 18px">6 pages across 320, 390, 768, 1440 and 1920, run in a real browser on live production. All 200, horizontal scroll exactly zero at every width (measured by scrolling and reading the position back, because scrollWidth lies), zero console errors, zero stuck reveals, and a computed contrast audit that walks every text node to its actual background and fails anything under AA. That audit caught two real defects and both are fixed. Screenshots reviewed by eye at desktop and phone.</p>

<h3 style="font-size:16px;margin:0 0 8px">Safe to send externally</h3>
<p style="margin:0 0 18px"><b>Yes, all of it.</b> This is a public marketing site with no internal figures on it. There are no customer logos, no testimonials, no customer counts, no revenue and no traction numbers anywhere. The ledger and the hold receipt are both labelled as examples rather than customer records. Every third party statistic carries its source inline. <b>Do not send</b> the war room artifacts in /Users/user/answered-handoff, which contain internal economics and the honest case against.</p>

<h3 style="font-size:16px;margin:0 0 8px">Coordination</h3>
<p style="margin:0 0 18px">Running actively both ways with the war room terminal. It owns spec, naming and copy; I own every file and every deploy. One open conflict I did not resolve unilaterally: its spec says light theme only, and you told me there is no light requirement. I held warm dark on your word. Say light and I will invert it.</p>

<p style="font-size:12px;color:#6B6459;margin:26px 0 0">Answered &middot; lane @ANSWERED-SITE &middot; registered in internal-directory.html</p>
</div>`;

const r = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    from: 'Reddenda Estate <info@reddenda.com>',
    to: ['David@Reddenda.com'],
    reply_to: 'info@reddenda.com',
    subject: `Answered is live: six pages, 60 second setup and the moat up front (deploy ${DEPLOY})`,
    html,
  }),
});
const body = await r.json();
console.log('resend status', r.status, 'id', body.id || JSON.stringify(body).slice(0, 200));
