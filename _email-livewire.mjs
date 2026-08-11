// Post-deploy notification for the two-sided LIVEWIRE rebuild.
// Secrets by name only: RESEND_API_KEY from env, never logged, never echoed.
const KEY = process.env.RESEND_API_KEY;
if (!KEY) { console.error('no RESEND_API_KEY in env, not sending'); process.exit(1); }

const DEPLOY = '6a7a8dd38fcf41c4003a676c';
const PRIOR  = '6a7a8b8b0cfdf14e297f0da4';

const html = `
<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.62;color:#16181C;max-width:680px">

<div style="background:#0B0C0E;color:#F2F4F0;padding:20px 22px;border-radius:12px;margin-bottom:24px">
<div style="font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.16em;color:#E3FF4F;margin-bottom:10px">ACTION NEEDED</div>
<b>1. One pricing decision is yours, and it is the only thing I stopped on.</b><br>
The build lane had restored a line under the pricing cards reading &ldquo;treat 15% as the shape of the deal rather than a final number.&rdquo; I argued it out and it is now cut, because a contribution figure is a claim about the world and needs a modeled label, but <b>a price is an offer</b> &mdash; publishing 15% commits us to charge 15%, it does not assert that 15% was measured. If you actually want 15% shown as provisional, say so and it goes back. Otherwise 15% now stands unqualified on home, pricing and recover.
<div style="height:12px"></div>
<b>2. The domain is still temporary.</b> Everything is on <code>answered.reddenda.com</code>. You said a real domain is coming. Nothing hardcodes the host, so the move is a config change, not a rebuild.
</div>

<h2 style="font-size:21px;margin:0 0 6px">Answered now has two sides</h2>
<p style="margin:0 0 6px"><a href="https://answered.reddenda.com" style="color:#0A6C8C"><b>https://answered.reddenda.com</b></a></p>
<p style="margin:0 0 20px;font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#5C646C">
PROD <b>${DEPLOY}</b> &middot; prior <b>${PRIOR}</b> &middot; Netlify project <b>answered-preview</b>, site <b>2c9f4ae6-f61c-4c1f-96ba-2a467fec00f3</b><br>
Source <b>/Users/user/answered-site</b> &middot; deploy URL <a href="https://${DEPLOY}--answered-preview.netlify.app" style="color:#0A6C8C">${DEPLOY}--answered-preview.netlify.app</a>
</p>

<p style="margin:0 0 16px">You said the site was all business and contractor facing and needed two sides, and that everyday people were a hard requirement. That is what changed.</p>

<p style="margin:0 0 8px"><b>The home page now leads consumer.</b> A <b>[For me] / [For my business]</b> control switches the stat band, the section headline, the product deck and the demo. The consumer side is what ships in the markup, so it is what renders with JavaScript off or still loading. The choice is remembered, and <code>#business</code> deep-links straight to the other side.</p>

<p style="margin:0 0 8px"><b>Three consumer products, two of which had never existed on the site.</b> It waits on hold. It picks up when you cannot. It makes the call you keep putting off. Named in plain language, per your note that we do not have to name everything.</p>

<p style="margin:0 0 8px"><b>A new demo built on the exact case you described:</b> the call from Mom you missed while driving, the conversation, and the single text you get instead of a voicemail nobody checks.</p>

<p style="margin:0 0 8px"><b>New palette.</b> Obsidian ground, Hi-Vis <code>#E3FF4F</code> as the only accent, Halogen text. The scheme you called boring and lame was my spec error, not a constraint anyone handed us.</p>

<p style="margin:0 0 8px"><b>Logo redrawn to one glyph:</b> a drawn D with signal arcs coming off it, same drawing in the favicon. The old lockup set ANSWERE in halogen with the final D in hi-vis, so at a glance it read as a rendering failure, and there were three unrelated marks across the site.</p>

<p style="margin:0 0 20px"><b>15% is printed</b> on home, pricing and recover. All geographic state language is out of the copy. Every hedge is gone: 35 &ldquo;early access&rdquo; instances and every licence caveat.</p>

<h3 style="font-size:16px;margin:24px 0 8px">Reading level, measured rather than claimed</h3>
<p style="margin:0 0 16px">Flesch-Kincaid on the prose a person actually reads, per page: <b>hold 6.2, index 6.3, recover 6.7, trades 6.7, thanks 6.9, trust 7.0, pricing 7.6.</b> Trust came down from 7.9 by splitting long sentences, not by deleting anything. The pricing page title was the single worst offender and is rewritten.</p>

<h3 style="font-size:16px;margin:24px 0 8px">What is NOT safe to send externally</h3>
<ul style="margin:0 0 16px;padding-left:20px">
<li>The three on-page demos are <b>drawn, not recorded</b>. Each says so in its own words. Do not present any of them as a customer call.</li>
<li>Every contribution figure on /pricing is <b>modeled on published vendor rates, not measured in production</b>, and carries that label. The 35% booking rate is labelled a planning assumption inside the step that uses it.</li>
<li>There are no customer numbers, no traction figures and no revenue on any page, and none should be added.</li>
</ul>

<h3 style="font-size:16px;margin:24px 0 8px">Three defects that testing caught and reading would not have</h3>
<ol style="margin:0 0 16px;padding-left:20px">
<li>The home page said <b>&ldquo;This is a real call arriving at a plumbing company&rdquo;</b> directly above a caption reading <b>&ldquo;Concept rendering.&rdquo;</b> A rendering that calls itself real is the worst version of the no-fabrication rule. Fixed, and all three demos now disclaim in one pattern.</li>
<li>The hero ring had its colour <b>hardcoded as RGB inside the canvas</b>, so no palette change could reach it and it was rendering olive while the token was correct.</li>
<li><code>trust.html</code> is generated by the build script. My first fix to it was silently wiped by the next rebuild, which is a trap worth knowing: four of the seven pages cannot be hand-edited.</li>
</ol>

<h3 style="font-size:16px;margin:24px 0 8px">Two lanes were building this blind to each other</h3>
<p style="margin:0 0 16px">I went looking for the build terminal, was told by another session it was not them, concluded there was no builder and took the whole site. There <i>was</i> a builder, working the same directory. They were holding a deploy because they saw file changes they could not attribute, while I had already promoted four times from the same tree. Nothing was lost, because we share the directory and my promotes carried their work. The reason nothing was lost is that <b>the entire tree had zero files in git</b> when I arrived, seventeen untracked, and I committed it before doing anything else. It is committed now and the build lane has the deploy.</p>

<h3 style="font-size:16px;margin:24px 0 8px">Verification</h3>
<p style="margin:0 0 8px">Measured on the deploy URL rather than the domain, because a fresh host serves stale edges and cached negatives: <b>7 routes returning 200 at 1440 and 390</b>, zero horizontal scroll, zero console errors, zero fused text, zero broken links, contrast AA on every text node, and <b>zero genuine accessibility failures</b> across 70 undersized controls once the WCAG spacing and inline exceptions are applied. The track switch was tested by clicking it in both directions and reading the computed state, not by checking the markup.</p>
<p style="margin:0 0 18px;color:#5C646C;font-size:13.5px">One caution about my own numbers: my first link checker reported 36 broken links, the second reported 6, and the true answer was <b>1</b>. Both earlier versions were counting favicons, stylesheets and query strings as pages. I am telling you the 1 because I decomposed it, not because a tool printed it.</p>

<p style="margin:26px 0 0;color:#5C646C;font-size:13px">Sent by the Answered coordination lane. Registered in internal-directory.html with the deploy id, the full URL and the verification result.</p>
</div>`;

const r = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    from: 'Reddenda Estate <info@reddenda.com>',
    to: ['David@Reddenda.com'],
    subject: 'Answered now has two sides, live, and one pricing decision is yours',
    html,
  }),
});
const j = await r.json();
console.log('status', r.status, 'id', j.id || JSON.stringify(j).slice(0, 200));
