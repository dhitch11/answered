#!/usr/bin/env python3
"""Emit the product pages and normalise nav/footer across every page.

One source of truth for the chrome. A menu that drifts between pages is the
single most common tell of a site assembled by hand, and this site now has six.
"""
import re, pathlib

ROOT = pathlib.Path(__file__).parent

# The one place the absolute og origin is defined. The hand-written pages
# (index/trades/hold) carry the same origin inline under an HTML comment that
# points back here. og:image MUST be absolute or scrapers drop it.
ORIGIN = 'https://answered.reddenda.com'

# slug -> brand card under assets/og/ (rendered by _og-render.mjs; brand cards
# only, never a receipt). thanks reuses the home card by design.
OG_CARD = {
    'pricing.html': 'pricing',
    'recover.html': 'recover',
    'trust.html':   'trust',
    'thanks.html':  'home',
}

# THE STANDALONE MARK, IDENTITY-V2 section B, on its 24-grid, all Hi-Vis:
# stem x3 y2 w5.2 h20 r2.2 · inner arc c(8.2,12) r6.6 stroke4.8 ±60°
# · outer arc r11.2 stroke3.0 ±47°. The wordmark beside it keeps a NORMAL D:
# two acid D's never appear in one lockup.
MARK = (
    '<svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
    '<rect class="bm-stem" x="3" y="2" width="5.2" height="20" rx="2.2" fill="var(--bronze)"/>'
    '<path class="bm-a1" d="M 11.5 6.284 A 6.6 6.6 0 0 1 11.5 17.716" fill="none" '
    'stroke="var(--bronze)" stroke-width="4.8" stroke-linecap="round"/>'
    '<path class="bm-a2" d="M 15.838 3.808 A 11.2 11.2 0 0 1 15.838 20.192" fill="none" '
    'stroke="var(--bronze)" stroke-width="3" stroke-linecap="round"/>'
    '</svg>')

# The two-state segmented control. Nav-resident, text only, no emoji. It is
# emitted ONLY on the page that carries the track state machine (the home
# page); a control that changes nothing on the page it sits on is a dead
# control, and this site does not render dead controls.
SEG = (
    '<div class="seg nav-seg" role="tablist" aria-label="Who is this for">'
    '<button class="seg-b" role="tab" id="tab-me" aria-selected="true" data-track-to="me" type="button">'
    '<span class="seg-t">For me</span></button>'
    '<button class="seg-b" role="tab" id="tab-biz" aria-selected="false" data-track-to="biz" type="button">'
    '<span class="seg-t">For my business</span></button>'
    '<span class="seg-thumb" aria-hidden="true"></span>'
    '</div>')

NAVITEMS = [
    ('/trades.html',  'Answered', 'Answers your line'),
    ('/hold.html',    'Hold',     'Waits on hold for you'),
    ('/recover.html', 'Recover',  'Chases what you are owed'),
    ('/pricing.html', 'Pricing',  'Outcomes only, never minutes'),
    ('/trust.html',   'Trust',    'How you audit every call'),
]

CUR = ' aria-current="page"'

def nav(active):
    links = ''.join(
        '<a href="%s"%s>%s</a>' % (h, CUR if h == active else '', l)
        for h, l, _ in NAVITEMS)
    sheet = ''.join(
        f'<a href="{h}"><span class="sh-l">{l}</span><span class="sh-d">{d}</span></a>'
        for h, l, d in NAVITEMS)
    seg = SEG if active == '/' else ''
    return f'''<header class="nav">
  <div class="wrap">
    <a class="brand" href="/" aria-label="Answered, home">{MARK}<span class="brand-name"><b>ANSWERED</b></span></a>
    <nav class="nav-links" aria-label="Primary">{links}</nav>
    {seg}<a class="nav-cta" href="/#early">Get on the list</a>
    <button class="burger" aria-label="Menu" aria-expanded="false" aria-controls="sheet"><span></span></button>
  </div>
</header>
<div class="sheet" id="sheet">{sheet}<a class="nav-cta" href="/#early">Get on the list</a></div>'''

FOOT = f'''<footer class="foot">
  <div class="wrap">
    <div class="foot-grid">
      <div>
        <a class="brand" href="/" aria-label="Answered, home">{MARK}<span class="brand-name"><b>ANSWERED</b></span></a>
        <p class="small" style="margin-top:16px;max-width:38ch">The phone layer. It answers, it waits, it follows the money. Priced per outcome, never per minute.</p>
      </div>
      <div>
        <h4>Products</h4>
        <ul>
          <li><a href="/trades.html">Answered, for your line</a></li>
          <li><a href="/hold.html">Hold, for everyone</a></li>
          <li><a href="/recover.html">Recover, for your invoices</a></li>
        </ul>
      </div>
      <div>
        <h4>Company</h4>
        <ul>
          <li><a href="/pricing.html">Pricing</a></li>
          <li><a href="/trust.html">Trust and guardrails</a></li>
          <li><a href="/#honesty">What we will not say</a></li>
        </ul>
      </div>
    </div>
    <div class="foot-base">
      <p class="src">Answered. Working name, working site. &copy; <span data-year>2026</span></p>
      <p class="src">Every figure on this site carries its source. Nothing here is a customer record.</p>
    </div>
  </div>
</footer>'''

HEAD = '''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{title}</title>
<meta name="description" content="{desc}">
<meta name="theme-color" content="#0B0C0E">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:type" content="website">
<meta property="og:image" content="{og}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="{og}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230B0C0E'/%3E%3Crect x='4' y='5' width='5.4' height='22' rx='2.4' fill='%23E3FF4F'/%3E%3Cpath d='M 12 7.6 A 8.6 8.6 0 0 1 12 24.4' fill='none' stroke='%23E3FF4F' stroke-width='5.4' stroke-linecap='round'/%3E%3Cpath d='M 20.4 10.2 A 11.4 11.4 0 0 1 20.4 21.8' fill='none' stroke='%23E3FF4F' stroke-width='3' stroke-linecap='round'/%3E%3Cpath d='M 25.2 6.9 A 15.6 15.6 0 0 1 25.2 25.1' fill='none' stroke='%23E3FF4F' stroke-width='2.1' stroke-linecap='round'/%3E%3C/svg%3E">
<link rel="preload" href="/assets/fonts/archivo-expanded-700.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/answered.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
'''

TAIL = '</main>\n' + FOOT + '\n<script src="/assets/answered.js" defer></script>\n</body>\n</html>\n'


def page(slug, title, desc, body):
    card = OG_CARD.get(slug)
    if card is None:
        raise SystemExit('BUILD REFUSED: no og card mapped for %s in OG_CARD' % slug)
    if not (ROOT / 'assets' / 'og' / (card + '.png')).exists():
        raise SystemExit('BUILD REFUSED: assets/og/%s.png missing for %s. '
                         'Run: node _og-render.mjs' % (card, slug))
    og = '%s/assets/og/%s.png' % (ORIGIN, card)
    html = HEAD.format(title=title, desc=desc, og=og) + nav('/' + slug) + '\n<main id="main">\n' + body + '\n' + TAIL
    (ROOT / slug).write_text(html, encoding='utf-8')
    print('wrote', slug, len(html), 'bytes')


# ── /pricing ──────────────────────────────────────────────────────────────────
PRICING = '''

<section class="gate pad-s" id="choose">
  <div class="wrap">
    <p class="eyebrow rv">Before the numbers</p>
    <h1 class="display rv d1" style="font-size:clamp(32px,4.2vw,58px);text-wrap:balance;margin-top:16px">Who is the phone<br> <span class="lit">ringing for?</span></h1>
    <p class="lede rv d2" style="margin-top:20px;max-width:56ch">Three products, three different meters, and you almost certainly only care about one of them. Pick the one that is you and the page will show that.</p>

    <div class="gate-grid">
      <button class="gc rv" type="button" data-pick="consumer">
        <span class="gc-i">01</span>
        <span class="gc-t">It rings for me</span>
        <span class="gc-d">You are a person with a phone and a problem. A carrier, a bank, an airline, an agency. You want somebody else to do the waiting and the arguing.</span>
        <span class="gc-w">Shows Hold</span>
        <span class="gc-go">See what that costs</span>
      </button>

      <button class="gc rv d1" type="button" data-pick="business">
        <span class="gc-i">02</span>
        <span class="gc-t">It rings for my business</span>
        <span class="gc-d">You run a shop, a crew or a truck. Calls come in while your hands are full, and invoices go quiet after you have already done the work.</span>
        <span class="gc-w">Shows Answered and Recover</span>
        <span class="gc-go">See what that costs</span>
      </button>

      <button class="gc rv d2" type="button" data-pick="both">
        <span class="gc-i">03</span>
        <span class="gc-t">Both, honestly</span>
        <span class="gc-d">You own the business and you are also the person on hold with the utility company at nine at night. Most owners are both.</span>
        <span class="gc-w">Shows everything, including the economics</span>
        <span class="gc-go">See all of it</span>
      </button>
    </div>

    <p class="src rv d3" style="margin-top:26px;max-width:70ch">This only changes what the page shows you. Nothing is hidden or protected by it, and you can switch at any time from the line at the top of the page.</p>
  </div>
</section>

<section class="pad" data-aud="consumer business both" style="padding-top:calc(var(--nav-h) + clamp(30px,4vw,56px))">
  <div class="wrap">
    <div class="aud-chip">Showing prices for <b class="aud-name">everyone</b> <button type="button" class="aud-change">change</button></div>
    <p class="eyebrow rv" style="margin-top:26px">What it costs</p>
    <p class="display h2 rv d1" style="font-size:clamp(34px,4.6vw,64px);text-wrap:balance;margin-top:16px" role="heading" aria-level="2">Three products.<br> Three meters. <span class="lit">One rule.</span></p>
    <p class="lede rv d2" style="margin-top:22px;max-width:62ch">The rule is that money only moves when something good happened. A job got booked. A human got reached. A dollar got recovered. There is no subscription anywhere in this company and no per minute price anywhere in this company, which means the incentive on our side of the table is identical to the incentive on yours.</p>

    <div class="pcards">
      <article class="pcard lead rv" data-aud="business both">
        <div class="pc-for">01 / Inbound</div>
        <div class="pc-name">Answered</div>
        <div class="pc-price num">$19</div>
        <div class="pc-unit">per job booked in standard hours.<br> <b style="color:var(--bronze-2)">$49</b> for a job booked after hours.</div>
        <div class="pc-free">$0 subscription &middot; $0 per minute &middot; $0 per call</div>
        <div class="pc-meter"><span>Your bill stops at <b>$549</b> a month, and the cap is yours to move</span><span>A line that goes quiet settles at <b>$39</b> a month, credited against bookings</span></div>
        <ul class="pc-list">
          <li>Answers your existing number, 24 hours a day, in a voice built around your trade</li>
          <li>Qualifies the caller, checks your real availability, books straight into your calendar</li>
          <li>Warm transfers a genuine emergency to your cell in five seconds</li>
          <li>Texts you the transcript and the recording inside a minute of the call ending</li>
          <li>Never quotes a price, enforced in three independent layers</li>
          <li>Live in about 60 seconds on one carrier code, off again in ten</li>
        </ul>
        <div class="pc-foot">
          <a class="pc-cta" href="?p=Answered#interest">I want this on my line</a>
          <div class="pc-econ">Modeled per booked job<br> Revenue <b>$19.00</b><br> Cost of the calls behind it <b>$1.50</b><br> Contribution <b>$17.50, about 92%</b></div>
        </div>
      </article>

      <article class="pcard rv d1" data-aud="consumer both">
        <div class="pc-for">02 / Consumer</div>
        <div class="pc-name">Hold</div>
        <div class="pc-price num">$20</div>
        <div class="pc-unit">per human reached on a government line.<br> <b style="color:var(--bronze-2)">$10</b> on a commercial line.</div>
        <div class="pc-free">$0 if nobody ever picks up &middot; no subscription, ever</div>
        <ul class="pc-list">
          <li>Places the call, works the phone tree, enters your reference, survives the transfer</li>
          <li>Holds for as long as it takes, across multiple attempts and reconnects</li>
          <li>Rings your phone the moment a person is actually on the line</li>
          <li>Makes your case on the record when you ask it to</li>
          <li>Ends every session with the hold receipt: the clock, the queue, the recording</li>
          <li>Nothing to install and no account to create before the first one</li>
        </ul>
        <div class="pc-foot">
          <a class="pc-cta" href="?p=Hold#interest">I want it waiting for me</a>
          <div class="pc-econ">Modeled per connection<br> Revenue <b>$20.00</b><br> Cost of a 60 minute hold <b>$9.00</b><br> Contribution <b>$11.00, about 55%</b></div>
        </div>
      </article>

      <article class="pcard rv d2" data-aud="business both">
        <div class="pc-for">03 / Receivables</div>
        <div class="pc-name">Recover</div>
        <div class="pc-price num">15%</div>
        <div class="pc-unit">of dollars actually recovered.<br> You pay nothing unless the money lands.</div>
        <div class="pc-free">Nothing recovered means nothing owed</div>
        <ul class="pc-list">
          <li>Calls on every invoice past day thirty, in your name and on your caller ID</li>
          <li>Already knows the job, the address and the date, because it booked the work</li>
          <li>Writes down every promise to pay with a date, and follows up on that date</li>
          <li>One number for the whole aged list, moving in one direction</li>
          <li>Collections agencies publish 20 to 50% for the same work</li>
          <li>Contingency is gated server side on your verified business location</li>
        </ul>
        <div class="pc-foot">
          <a class="pc-cta" href="?p=Recover#interest">I want my invoices chased</a>
          <div class="pc-econ">Modeled on a $10,000 recovery<br> Revenue <b>$1,500.00</b><br> Cost of the calls behind it <b>$4.50</b><br> Contribution <b>$1,495.50, about 99.7%</b></div>
        </div>
      </article>
    </div>
    <p class="lede rv d2" style="margin-top:26px;max-width:66ch">Two things sit under the Answered meter, and both exist to protect you rather than us. <b>The cap</b> means a busy month can never surprise you, and you set where it sits. <b>The quiet-line rate</b> only ever applies to a line that has gone quiet, it is credited back against your bookings, and it means a line stays answered for a price that is honest instead of nothing.</p>
    <p class="src rv d3" style="margin-top:26px;max-width:88ch">These figures are worked out from published vendor rates, not measured from our own running system. Sources and the full arithmetic are below.</p>
  </div>
</section>

<section class="pad-s seam" data-aud="business both">
  <div class="wrap">
    <div style="display:grid;grid-template-columns:minmax(0,.72fr) minmax(0,1.28fr);gap:clamp(26px,4vw,60px);align-items:center" class="two">
      <div>
        <p class="eyebrow rv">The whole system</p>
        <h2 class="h2 rv d1" style="margin-top:16px;max-width:15ch">Five parts. One of them is a phone code.</h2>
        <p class="lede rv d2" style="margin-top:20px">Nothing is installed, nothing is ported, and your number never changes. The carrier does the forwarding it has always been able to do, and we answer the line on the other side of it.</p>
      </div>
      <div class="rv d2"><div class="bp run">
  <svg viewBox="0 0 900 300" role="img" aria-labelledby="bpt bpd">
    <title id="bpt">How a call reaches Answered</title>
    <desc id="bpd">A caller dials the business number. The carrier forwards the call to a line Answered owns. Answered answers, qualifies the caller, and either books the job into the calendar or transfers a real emergency to the owner's cell.</desc>

    <defs>
      <pattern id="bpgrid" width="24" height="24" patternUnits="userSpaceOnUse">
        <path d="M24 0V24M0 24H24" class="bp-grid"/>
      </pattern>
    </defs>
    <rect x="0" y="0" width="900" height="300" fill="url(#bpgrid)" opacity=".55"/>

    <!-- datum line -->
    <path d="M40 150 H860" class="bp-wire dash"/>
    <g class="bp-tick">
      <path d="M40 142v16M250 142v16M470 142v16M690 142v16M860 142v16"/>
    </g>

    <!-- the live path -->
    <path id="bppath" d="M70 150 H220 M280 150 H440 M500 150 H660 M720 150 H830" class="bp-wire"/>
    <path d="M70 150 H830" class="bp-flow"/>

    <!-- nodes -->
    <g>
      <circle cx="70" cy="150" r="26" class="bp-node hot"/>
      <text x="70" y="155" text-anchor="middle" class="bp-lab">01</text>
      <text x="70" y="200" text-anchor="middle" class="bp-t">Caller</text>
      <text x="70" y="218" text-anchor="middle" class="bp-sub">dials your number</text>
    </g>
    <g>
      <rect x="222" y="124" width="56" height="52" rx="10" class="bp-node"/>
      <text x="250" y="155" text-anchor="middle" class="bp-lab">02</text>
      <text x="250" y="200" text-anchor="middle" class="bp-t">Carrier</text>
      <text x="250" y="218" text-anchor="middle" class="bp-sub">one code, forwards</text>
    </g>
    <g>
      <rect x="442" y="120" width="56" height="60" rx="10" class="bp-node"/>
      <text x="470" y="155" text-anchor="middle" class="bp-lab">03</text>
      <text x="470" y="200" text-anchor="middle" class="bp-t">Answered</text>
      <text x="470" y="218" text-anchor="middle" class="bp-sub">picks up, qualifies</text>
      <text x="470" y="98" text-anchor="middle" class="bp-sub">says it is an AI, first sentence</text>
      <path d="M470 106 V118" class="bp-wire"/>
    </g>
    <g>
      <rect x="662" y="124" width="56" height="52" rx="10" class="bp-node"/>
      <text x="690" y="155" text-anchor="middle" class="bp-lab">04</text>
      <text x="690" y="200" text-anchor="middle" class="bp-t">Booked</text>
      <text x="690" y="218" text-anchor="middle" class="bp-sub">into your calendar</text>
    </g>
    <g>
      <circle cx="830" cy="150" r="22" class="bp-node"/>
      <text x="830" y="155" text-anchor="middle" class="bp-lab">05</text>
      <text x="830" y="200" text-anchor="middle" class="bp-t">You</text>
      <text x="830" y="218" text-anchor="middle" class="bp-sub">text and transcript</text>
    </g>

    <!-- the emergency branch -->
    <path d="M470 120 C470 70 620 70 690 70 H800 C820 70 830 80 830 100 V128" class="bp-wire dash"/>
    <text x="640" y="58" text-anchor="middle" class="bp-sub">a real emergency transfers straight to your cell</text>

    <!-- the reversal -->
    <path d="M250 176 C250 240 250 250 300 250 H430" class="bp-wire dash"/>
    <text x="470" y="254" text-anchor="middle" class="bp-sub">one code turns it off again, ten seconds</text>
  </svg>
  <span class="bp-cap">Fig 1 &middot; call path</span>
</div></div>
    </div>
  </div>
</section>

<section class="paper seam pad-s" data-aud="business both">
  <div class="wrap">
    <p class="eyebrow rv">What the customer gets for it</p>
    <h2 class="h2 rv d1" style="margin-top:16px;max-width:24ch">You pay about four cents for every dollar it makes you.</h2>
    <div class="ptable rv d2">
      <div class="prow head"><span>What Answered produced</span><span>Its price as a share of that</span></div>
      <div class="prow"><span>A booked service call, $350 to $500 average ticket</span><span class="num">4 to 5%</span></div>
      <div class="prow"><span>A booked after hours call, about $1,400</span><span class="num">3.5%</span></div>
      <div class="prow"><span>A saved water heater lead, $1,193 ticket</span><span class="num">1.6%</span></div>
      <div class="prow hi"><span>A saved roof lead, $9,504 ticket</span><span class="num">0.5%</span></div>
      <div class="prow"><span>An afternoon of your life, back</span><span class="num">$20</span></div>
    </div>
    <p class="src rv d3" style="margin-top:20px;max-width:84ch">Ticket figures from Thumbtack average cost data, 2026. Lead values apply Invoca's measured 45% on call close rate (70M calls, July 2026) to those tickets. Human answering services for the same work publish $250 to $2,100 a month.</p>
  </div>
</section>

<section class="pad seam" data-aud="both">
  <div class="wrap">
    <p class="eyebrow rv">Where the money goes</p>
    <h2 class="h2 rv d1" style="margin-top:16px;max-width:22ch">Where each dollar goes.</h2>
    <p class="lede rv d2" style="margin-top:20px;max-width:64ch">Every bar below is <b>one dollar of revenue from one event</b>, split into what that event costs us to run and what is left. Same scale on every row, so they can be read against each other. The dollar figures on the right are the size of that single event, not a monthly or annual total.</p>

    <div class="dollars rv d2">
      <div class="drow">
        <div class="dname">Answered, standard<span>one booked job</span></div>
        <div class="dtrack" data-rev="19" data-cost="1.5" data-cost-label="$1.50">
          <div class="dcost"><span class="dlab">$1.50</span></div>
          <div class="dkeep" data-cost="$1.50"><span class="dlab">$17.50 left &middot; 92%</span></div>
        </div>
        <div class="dtotal">$19.00<span>the job</span></div>
      </div>
      <div class="drow">
        <div class="dname">Answered, after hours<span>one booked job, nights and weekends</span></div>
        <div class="dtrack" data-rev="49" data-cost="1.5" data-cost-label="$1.50">
          <div class="dcost"><span class="dlab">$1.50</span></div>
          <div class="dkeep" data-cost="$1.50"><span class="dlab">$47.50 left &middot; 97%</span></div>
        </div>
        <div class="dtotal">$49.00<span>the job</span></div>
      </div>
      <div class="drow">
        <div class="dname">Hold, government<span>one human reached, about an hour of queue</span></div>
        <div class="dtrack" data-rev="20" data-cost="9" data-cost-label="$9.00">
          <div class="dcost"><span class="dlab">$9.00</span></div>
          <div class="dkeep" data-cost="$9.00"><span class="dlab">$11.00 left &middot; 55%</span></div>
        </div>
        <div class="dtotal">$20.00<span>the connection</span></div>
      </div>
      <div class="drow">
        <div class="dname">Hold, commercial<span>one human reached, about twenty minutes</span></div>
        <div class="dtrack" data-rev="10" data-cost="3" data-cost-label="$3.00">
          <div class="dcost"><span class="dlab">$3.00</span></div>
          <div class="dkeep" data-cost="$3.00"><span class="dlab">$7.00 left &middot; 70%</span></div>
        </div>
        <div class="dtotal">$10.00<span>the connection</span></div>
      </div>
      <div class="drow">
        <div class="dname">Recover<span>one $10,000 invoice collected</span></div>
        <div class="dtrack" data-rev="1500" data-cost="4.5" data-cost-label="$4.50">
          <div class="dcost"><span class="dlab">$4.50</span></div>
          <div class="dkeep" data-cost="$4.50"><span class="dlab">$1,495.50 left &middot; 99.7%</span></div>
        </div>
        <div class="dtotal">$1,500.00<span>the fee</span></div>
      </div>
    </div>

    <div class="dkey rv d3">
      <i><b style="background:linear-gradient(180deg,var(--red-2),var(--red))"></b> what the calls cost us</i>
      <i><b style="background:rgba(227,255,79,.22)"></b> what is left after them</i>
    </div>

    <p class="src rv d3" style="margin-top:22px;max-width:86ch">Hold costs more per event because holding is the product: the line stays connected for the whole wait, so an hour of queue is an hour of telephony. Answering and collecting are short calls, which is why those two rows look the way they do.</p>
  </div>
</section>

<section class="paper seam pad-s" data-aud="both">
  <div class="wrap">
    <p class="eyebrow rv">The math, step by step</p>
    <h2 class="h2 rv d1" style="margin-top:16px;max-width:24ch">How a $19 booking costs us about a dollar fifty.</h2>
    <p class="lede rv d2" style="margin-top:20px;max-width:62ch">Four steps, in order, each one following from the line above it. Every input is either a published vendor rate or an assumption we have labelled as ours.</p>

    <div class="chain rv d2">
      <div class="step-row">
        <span class="op">1</span>
        <div class="step-t"><b>A connected minute of conversational voice</b><span>Published vendor rates run $0.13 to $0.17 all in. We plan on $0.15.</span></div>
        <div class="step-v">$0.15 / min</div>
      </div>
      <div class="step-row">
        <span class="op">&times;</span>
        <div class="step-t"><b>A typical answered call runs about three and a half minutes</b><span>Long enough to qualify a caller and book a slot.</span></div>
        <div class="step-v">3.5 min</div>
      </div>
      <div class="step-row">
        <span class="op">=</span>
        <div class="step-t"><b>So one answered call costs us</b><span>Whether or not it turns into anything. Those calls are free to the customer.</span></div>
        <div class="step-v">$0.53</div>
      </div>
      <div class="step-row">
        <span class="op">&divide;</span>
        <div class="step-t"><b>Roughly one call in three books a job</b><span>35%, our own planning assumption, not yet measured in production.</span></div>
        <div class="step-v">35%</div>
      </div>
      <div class="step-row out">
        <span class="op">=</span>
        <div class="step-t"><b>Which puts about $1.50 of calls behind every booked job</b><span>Against $19.00 charged for that job, leaving $17.50.</span></div>
        <div class="step-v">$1.50</div>
      </div>
    </div>

    <p class="src rv d3" style="margin-top:22px;max-width:88ch">Per minute rates from published vendor pricing accessed 2026-08-10: Vapi platform fee $0.05 a minute plus models at cost, Retell $0.07 to $0.31 priced by part, Bland $0.11 to $0.14 all inclusive, Twilio ConversationRelay $0.07 plus $0.0085 inbound voice and $1.15 a month for a local number. <b>The 35% booking rate and the 45% recovery rate are our own planning assumptions and are not yet measured in production.</b> The first pilot exists to measure them, and whatever they turn out to be will be published here.</p>
  </div>
</section>

<section class="paper seam pad-s" data-aud="consumer business both">
  <div class="wrap">
    <p class="eyebrow rv">Why the shape matters more than the number</p>
    <h2 class="h2 rv d1" style="margin-top:16px;max-width:24ch">A per minute vendor wants a longer call. We want a booked job.</h2>
    <p class="lede rv d2" style="margin-top:20px;max-width:64ch">That is not a slogan, it is an accounting fact. When the meter runs on talk time, every extra minute is margin, so the product has no reason to be efficient and every reason to be chatty. When the meter runs on the outcome, a shorter call that still books the job is strictly better for both sides.</p>
    <p class="lede rv d2" style="margin-top:16px;max-width:64ch">It also makes the free part genuinely free. Wrong numbers, sales calls, somebody's cousin looking for a different business, the call at 2 AM that turns out to be nothing: all of it costs us and none of it costs you. Nobody selling minutes can copy that without breaking their own revenue model.</p>
  </div>
</section>

<section class="pad seam" data-aud="business both">
  <div class="wrap narrow">
    <p class="eyebrow rv">Your protection</p>
    <h2 class="h2 rv d1" style="margin-top:16px">Every charge, provable.<br> Every dispute, yours.</h2>
    <details class="disc rv d2" style="margin-top:30px" open>
      <summary>Every charge shows you the call it came from.</summary>
      <div class="disc-body"><p>The recording where consent permits, the transcript, and the appointment record. If you cannot see why you were charged, you should not be charged, so you will always be able to see it.</p></div>
    </details>
    <details class="disc rv d2">
      <summary>One tap disputes any charge, and you keep the benefit of the doubt.</summary>
      <div class="disc-body"><p>We would rather lose the $19 than have you spend a Tuesday arguing about it. Repeat disputes are a signal that our booking definition is wrong, and that gets fixed at the source.</p></div>
    </details>
    <details class="disc rv d3">
      <summary>Quality failures refund themselves before you notice.</summary>
      <div class="disc-body"><p>A nightly check re-reads every booking. A wrong address, a slot that was already taken, a callback promised and never logged. Those reverse automatically and text you what happened.</p></div>
    </details>
    <details class="disc rv d3">
      <summary>Fleets and franchises are a conversation, not a listed price.</summary>
      <div class="disc-body"><p>Multiple trucks, multiple locations and multiple numbers change the shape of the meter, so those get scheduled properly rather than guessed at on a page.</p></div>
    </details>
  </div>
</section>


<section class="paper seam pad" id="interest" data-aud="consumer business both">
  <div class="wrap narrow">
    <p class="eyebrow rv" style="justify-content:center">Tell us what you need</p>
    <h2 class="h2 rv d1" style="margin-top:16px;text-align:center">No checkout. Just tell us,<br> and we will build it around you.</h2>
    <p class="lede rv d2" style="margin-top:20px;text-align:center;margin-inline:auto;max-width:54ch">There is nothing to buy on this page on purpose. The first group goes live free and stays free until it produces something, so the only thing worth doing right now is telling us which part you want and letting us set it up with you.</p>

    <form class="iform rv d2" name="interest" method="POST" action="/api/interest">
      <p style="display:none"><label>Leave this empty <input name="bot-field"></label></p>

      <div class="ifield">
        <label for="i-name">Your name</label>
        <input id="i-name" name="name" type="text" autocomplete="name" placeholder="Mike Rivera" required>
      </div>
      <div class="ifield">
        <label for="i-email">Email</label>
        <input id="i-email" name="email" type="email" autocomplete="email" placeholder="mike@riveraplumbing.com" required>
      </div>
      <div class="ifield">
        <label for="i-product">Which part</label>
        <select id="i-product" name="product">
          <option>Answered, answer my line</option>
          <option>Hold, wait on hold for me</option>
          <option>Recover, chase my invoices</option>
          <option>All three</option>
          <option>I am an investor or a partner</option>
        </select>
      </div>
      <div class="ifield">
        <label for="i-phone">Phone, if you want us to call</label>
        <input id="i-phone" name="phone" type="tel" autocomplete="tel" placeholder="Optional">
      </div>
      <div class="ifield full">
        <label for="i-note">Anything we should know</label>
        <textarea id="i-note" name="note" placeholder="What you do, how many calls a week, what you are losing to the phone right now."></textarea>
      </div>
      <button class="btn btn-primary" type="submit">Send it</button>
    </form>
    <p class="src rv d3" style="margin-top:16px;text-align:center">One reply from a person, not a drip sequence. Fleets, franchises and portfolios get a scheduled call rather than a listed price.</p>
  </div>
</section>
'''

# ── /recover ──────────────────────────────────────────────────────────────────
RECOVER = '''
<section class="hero" style="min-height:auto;padding-bottom:clamp(48px,7vw,90px)">
  <div class="hero-bg" aria-hidden="true"></div>
  <div class="wrap">
    <div class="hero-grid">
      <div>
        <p class="eyebrow rv">Recover. For the work you already did.</p>
        <h1 class="display rv d1" style="font-size:clamp(34px,4.6vw,64px);text-wrap:balance">You already earned it.<br> <span class="lit">Somebody should ask for it.</span></h1>
        <p class="lede hero-sub rv d2">The invoice went out. Thirty one days went by. Nobody called, because calling is uncomfortable and you are busy and it always feels like next week is fine. Recover makes the call, in your name, on your caller ID, and writes down exactly what was promised.</p>
        <div class="hero-actions rv d3">
          <a class="btn btn-primary" href="/#early">Turn it on</a>
          <a class="btn btn-ghost" href="/pricing.html">See what it costs</a>
        </div>
        <p class="src hero-note rv d3">Nothing recovered, nothing owed. The fee is a function of dollars that actually land, never of calls placed.</p>
      </div>
      <div class="rv d2">
        <div class="ring-stage" style="max-width:420px">
          <div class="ring-glow" aria-hidden="true"></div>
          <canvas aria-hidden="true"></canvas>
          <div class="ring-center"><div class="ring-state">Picked up on the first ring</div><div class="ring-count" style="font-size:clamp(22px,2.6vw,32px)">Answered</div></div>
        </div>
      </div>
    </div>
  </div>
</section>

<section class="band">
  <div class="wrap" style="padding-inline:0">
    <div class="band-grid">
      <div class="band-cell rv"><div class="band-v num">$299B</div><div class="band-k">of US construction payments ran late in one year.</div><div class="band-s src">Rabbet Construction Payments Report, 2025. Commercial contractor to subcontractor payments.</div></div>
      <div class="band-cell rv d1"><div class="band-v num">20-50%</div><div class="band-k">is what collections agencies publish for this work.</div><div class="band-s src">PSI Collect publishes 22% on $5,000 to $50,000 accounts, accessed 2026-08-10.</div></div>
      <div class="band-cell rv d2"><div class="band-v num">Day 31</div><div class="band-k">is when an invoice stops being late and starts being a project.</div><div class="band-s src">The window Recover works, before default and before an agency.</div></div>
      <div class="band-cell rv d3"><div class="band-v num">$0</div><div class="band-k">if nothing lands. The fee only exists on recovered dollars.</div><div class="band-s src">Answered pricing law.</div></div>
    </div>
  </div>
</section>

<section class="pad">
  <div class="wrap">
    <p class="eyebrow rv">Why this one works when a collections letter does not</p>
    <h2 class="h2 rv d1" style="margin-top:16px;max-width:22ch">It is not a stranger calling. It is you, following up.</h2>
    <div class="steps">
      <div class="step rv"><h3 class="h3">Your name, your number</h3><p>The call comes from your business, on your caller ID, in the tone you would use. Nothing about it says the account has been sold or handed to an agency, because it has not been.</p></div>
      <div class="step rv d1"><h3 class="h3">It remembers the job</h3><p>It already answered the call that created this work. It knows the address, the date, and what was done. That is why the conversation goes somewhere instead of going in circles.</p></div>
      <div class="step rv d2"><h3 class="h3">Every promise written down</h3><p>Who said they would pay, how much, and by when. Next Thursday becomes a record instead of a memory, and the follow up on Thursday happens whether or not you remember it.</p></div>
    </div>
  </div>
</section>

<section class="pad seam">
  <div class="wrap">
    <div style="display:grid;grid-template-columns:minmax(0,.92fr) minmax(0,1.08fr);gap:clamp(28px,5vw,68px);align-items:center" class="two">
      <div>
        <p class="eyebrow rv">Watch it work</p>
        <h2 class="h2 rv d1" style="margin-top:16px;max-width:18ch">The aged list, going down instead of sideways.</h2>
        <p class="lede rv d2" style="margin-top:20px">Every invoice past day thirty gets a call in your name. Every promise to pay is written down with a date. The number at the top is what you are still owed, and it only moves in one direction.</p>
        
      </div>
      <div class="rv d2"><div class="showcase" data-show="recover">
  <div class="sc-bar"><span class="sc-dot" aria-hidden="true"></span> Recover, working the aged list <span class="sc-num">Day 31 and over</span></div>
  <div class="sc-body">
    <div class="meter-lab">Money out there</div>
    <div class="meter-big">$23,410</div>
    <div class="inv">
      <div class="inv-row" data-amt="1193"><span class="name">Rivera, water heater</span><span class="age">34d</span><span class="amt">$1,193</span></div>
      <div class="inv-row" data-amt="2850"><span class="name">Okafor, panel upgrade</span><span class="age">41d</span><span class="amt">$2,850</span></div>
      <div class="inv-row" data-amt="11400"><span class="name">Delgado GC, phase two</span><span class="age">63d</span><span class="amt">$11,400</span></div>
      <div class="inv-row" data-amt="7967"><span class="name">Whitmore, roof section</span><span class="age">88d</span><span class="amt">$7,967</span></div>
    </div>
  </div>
  <div class="sc-note">Concept rendering of the product running. Not a customer record and not a projection of results. Every promise to pay captured on a call is written to this ledger as it happens.</div>
</div></div>
    </div>
  </div>
</section>

<section class="pad seam">
  <div class="wrap narrow">
    <p class="eyebrow rv">It calls in your name</p>
    <h2 class="h2 rv d1" style="margin-top:16px">Your customer hears your company, not a collections agency.</h2>
    <p class="lede rv d2" style="margin-top:20px">Every call goes out as you. Your business name, your number, your tone. It is your own front office following up on your own invoice, which is exactly what it should sound like.</p>
    <p class="lede rv d2" style="margin-top:16px">That is why it works. A friendly call from the company that did the work gets paid. A letter from a stranger gets ignored, and it costs you the customer.</p>
    <p class="src rv d3" style="margin-top:20px">We only get paid when you do. Fifteen percent of what actually lands in your account, never a fee on calls placed or letters sent.</p>
  </div>
</section>


<section class="pad-s seam">
  <div class="wrap">
    <div class="mn" style="max-width:74ch;margin-inline:auto">
      <b>This works the same way for you personally.</b>
      <p style="margin-top:8px">It is not only for invoices. The friend who still owes you for the trip. The deposit a landlord never sent back. The refund a store keeps promising and never sends. Same voice, same rule. It gets nothing back, you owe nothing.</p>
      <a class="card-go" href="/#track" style="margin-top:12px">See the personal side <span aria-hidden="true">&rarr;</span></a>
    </div>
  </div>
</section>
<section class="paper seam pad">
  <div class="wrap narrow" style="text-align:center">
    <p class="eyebrow rv" style="justify-content:center">Get started</p>
    <h2 class="h2 rv d1" style="margin-top:16px">Put the quiet invoices on the list.</h2>
    <p class="rv d2" style="margin-top:24px"><a class="btn btn-primary" href="/#early">Turn it on</a></p>
  </div>
</section>
'''

# ── /trust ────────────────────────────────────────────────────────────────────
TRUST = '''
<section class="pad" style="padding-top:calc(var(--nav-h) + clamp(48px,7vw,96px))">
  <div class="wrap">
    <p class="eyebrow rv">Trust</p>
    <h1 class="display rv d1" style="font-size:clamp(34px,4.6vw,64px);text-wrap:balance;margin-top:16px">Audit every word<br> <span class="lit">from the truck.</span></h1>
    <p class="lede rv d2" style="margin-top:22px;max-width:60ch">Your phone is your business, so you get to see exactly what happens on it. Every call transcribed to you inside a minute. Every charge linked to the call that made it. Guardrails you can watch working, and four numbers that tell you the truth every day.</p>
  </div>
</section>

<section class="band">
  <div class="wrap" style="padding-inline:0">
    <div class="band-grid">
      <div class="band-cell rv"><div class="band-v num">60s</div><div class="band-k">from hang up to the transcript in your hand, by text.</div><div class="band-s src">Design target. If the pipeline is down, calls pause rather than run unaudited.</div></div>
      <div class="band-cell rv d1"><div class="band-v num">5s</div><div class="band-k">from a caller asking for a human to your cell ringing.</div><div class="band-s src">Warm transfer attempt. 20 seconds without a pickup and it takes a callback and texts you.</div></div>
      <div class="band-cell rv d2"><div class="band-v num">0</div><div class="band-k">prices quoted. Ever. It is not allowed to say a number.</div><div class="band-s src">Three stacked guardrails, below. The counter is published per account.</div></div>
      <div class="band-cell rv d3"><div class="band-v num">1st</div><div class="band-k">sentence of every call is the AI saying it is an AI.</div><div class="band-s src">On every call, everywhere, whether or not the law requires it.</div></div>
    </div>
  </div>
</section>

<section class="pad">
  <div class="wrap">
    <p class="eyebrow rv">The guardrail that matters most</p>
    <h2 class="h2 rv d1" style="margin-top:16px;max-width:24ch">It will never quote a price. That is enforced in three places, not one.</h2>
    <p class="lede rv d2" style="margin-top:20px;max-width:62ch">Pricing is yours to give, and it stays yours. The agent books the visit, captures everything you need, and tells the caller you will confirm the number personally. That promise is enforced in three independent places, so it holds every single time.</p>
    <div class="cards">
      <article class="card rv"><div class="card-tag">Layer 1</div><h3 class="h3">The instruction</h3><p>It is told exactly what to say instead: that it cannot quote, that you will call back with a real number today, and then it books the visit anyway.</p></article>
      <article class="card rv d1"><div class="card-tag">Layer 2</div><h3 class="h3">The filter</h3><p>Every sentence is checked for dollar amounts and price language before it is ever spoken aloud. A number that slips the instruction is cut before it reaches the caller's ear.</p></article>
      <article class="card rv d2"><div class="card-tag">Layer 3</div><h3 class="h3">The nightly replay</h3><p>Fifty recorded calls where a caller pushes hard for a price are replayed against the current build every night. A regression is caught by us, before it is caught by your customer.</p></article>
    </div>
  </div>
</section>

<section class="paper seam pad">
  <div class="wrap">
    <p class="eyebrow rv">How you audit it</p>
    <h2 class="h2 rv d1" style="margin-top:16px;max-width:20ch">From the truck, in a text, without opening an app.</h2>
    <div class="steps">
      <div class="step rv" style="border-color:rgba(30,27,23,.2)"><h3 class="h3">Every call, transcribed to you</h3><p style="color:rgba(30,27,23,.76)">The transcript, a one line summary, and the caller's number, inside a minute of the call ending. You read every call the way you would read a message from your best dispatcher.</p></div>
      <div class="step rv d1" style="border-color:rgba(30,27,23,.2)"><h3 class="h3">It reports its own mistakes first</h3><p style="color:rgba(30,27,23,.76)">Every night it flags its own bad calls. A hang up mid sentence. An address it probably misheard. A callback it promised and never logged. You hear it from us before you hear it from the customer.</p></div>
      <div class="step rv d2" style="border-color:rgba(30,27,23,.2)"><h3 class="h3">Four numbers, no vanity metrics</h3><p style="color:rgba(30,27,23,.76)">Answer rate. Median pickup, in rings. Escalations actually delivered to your cell. Price guardrail violations, which should read zero, and we show the zero.</p></div>
    </div>
    <p class="src rv d3" style="margin-top:28px;max-width:80ch">If the recording system goes down, we stop taking your calls rather than take them unwatched. You get a text that says exactly that. A silent degradation is worse than an outage, because you keep trusting it.</p>
  </div>
</section>

<section class="pad seam">
  <div class="wrap narrow">
    <p class="eyebrow rv">Disclosure and recording</p>
    <h2 class="h2 rv d1" style="margin-top:16px">One behaviour, everywhere, held to the strictest rule in the country.</h2>
    <details class="disc rv d2" style="margin-top:30px" open>
      <summary>It identifies itself as an AI in its first sentence.</summary>
      <div class="disc-body"><p>Not buried later in the call. First sentence, every call, everywhere. It is the strictest version of the rule found anywhere in the country, so it is the only version we build. We never ship a version that hides.</p></div>
    </details>
    <details class="disc rv d2">
      <summary>Recording is announced on every call, everywhere.</summary>
      <div class="disc-body"><p>Eleven states require every party to consent. We could look up the caller's state and behave differently. We do not. A lookup like that can fail without telling you, and a failure there is a wiretap claim. Saying it out loud costs five seconds and a fraction of a cent.</p></div>
    </details>
    <details class="disc rv d3">
      <summary>Answering a call is not the same as making one, legally or ethically.</summary>
      <div class="disc-body"><p>Inbound answering is untouched by the rules that govern outbound dialing. When we call out for you, consent is written into the code, with a person to fall back on. It is not a paragraph buried in a policy.</p></div>
    </details>
    <details class="disc rv d3">
      <summary>Capability, always. Guarantees, never.</summary>
      <div class="disc-body"><p>Everything on this site is something the product actually does, and every figure carries the source it came from. In a category full of promises, being the one you can check is the strongest position available.</p></div>
    </details>
  </div>
</section>

<section class="paper seam pad">
  <div class="wrap narrow" style="text-align:center">
    <p class="eyebrow rv" style="justify-content:center">Get started</p>
    <h2 class="h2 rv d1" style="margin-top:16px">Audit it for a week before you trust it with a Tuesday.</h2>
    <p class="rv d2" style="margin-top:24px"><a class="btn btn-primary" href="/#early">Turn it on</a></p>
  </div>
</section>
'''

page('pricing.html', 'Answered pricing. You only pay when it works.',
     'No subscription and no per minute price. $19 a booked job, $49 after hours, $20 when a human is reached, 15% of what is recovered, and $0 when nothing is produced.', PRICING)
page('recover.html', 'Recover. You already earned it. Now somebody asks for it.',
     'Follow up on the invoices that went quiet at day 31, in your own name and on your own caller ID. Nothing recovered, nothing owed.', RECOVER)
THANKS = '''
<section class="hero" style="min-height:calc(100svh - var(--nav-h))">
  <div class="hero-bg" aria-hidden="true"></div>
  <div class="wrap narrow" style="position:relative;z-index:2;text-align:center">
    <div class="ring-stage" style="max-width:280px;margin-bottom:34px">
      <div class="ring-glow" aria-hidden="true"></div>
      <canvas aria-hidden="true"></canvas>
      <div class="ring-center"><div class="ring-state">Picked up on the first ring</div><div class="ring-count" style="font-size:clamp(22px,2.6vw,32px)">Answered</div></div>
    </div>
    <p class="eyebrow rv" style="justify-content:center">Received</p>
    <h1 class="display rv d1" style="font-size:clamp(34px,4.6vw,64px);margin-top:16px">A person has it,<br> <span class="lit">not a drip sequence.</span></h1>
    <p class="lede rv d2" style="margin-top:22px;margin-inline:auto;max-width:46ch">We read every one of these ourselves. You will hear back from a human being, and it will be about the thing you actually asked for.</p>
    <div class="hero-actions rv d3" style="justify-content:center;margin-top:32px">
      <a class="btn btn-ghost" href="/">Back to the site</a>
      <a class="btn btn-ghost" href="/pricing.html">See what each part costs</a>
    </div>
  </div>
</section>
'''

page('trust.html', 'Trust. Audit every call from the truck.',
     'It never quotes a price, it hands a caller to a human in five seconds, it transcribes every call to you inside a minute, and it reports its own mistakes first.', TRUST)
page('thanks.html', 'Thank you. A person has it.',
     'Your note reached a person at Answered. We read every one of these ourselves and you will hear back from a human being.', THANKS)


# ── normalise the chrome on the three hand-written pages ──────────────────────
for slug, active in (('index.html', '/'), ('trades.html', '/trades.html'), ('hold.html', '/hold.html')):
    p = ROOT / slug
    s = p.read_text(encoding='utf-8')
    s = re.sub(r'<header class="nav">.*?</header>\s*<div class="sheet" id="sheet">.*?</div>\n',
               nav(active) + '\n', s, count=1, flags=re.S)
    s = re.sub(r'<footer class="foot">.*?</footer>', FOOT, s, count=1, flags=re.S)
    p.write_text(s, encoding='utf-8')
    print('chrome normalised in', slug)


# ── post-step: pricing cards and CTAs, applied to EVERY page from one source ──
# Hand-injecting these into generated pages meant every rebuild silently wiped
# them. Twice. So the generator owns them now and the result is idempotent.
import re as _re

_src = (ROOT / 'pricing.html').read_text(encoding='utf-8')
_cards = _re.findall(r'<article class="pcard[^"]*"[^>]*>.*?</article>', _src, _re.S)
assert len(_cards) == 3, 'expected 3 pricing cards in pricing.html, found %d' % len(_cards)
_ANSWERED, _HOLD, _RECOVER = _cards

_CTA_LABEL = {'Answered': 'I want this on my line',
              'Hold': 'I want it waiting for me',
              'Recover': 'I want my invoices chased'}

def _clean(card):
    """Strip the investor economics block AND any existing CTA.

    The PRICING source now ships its own same-page CTA, so a product page that
    reused the card verbatim got an anchor to a form that does not exist there.
    Strip both, then re-add the right one for the page being built."""
    card = _re.sub(r'\s*<div class="pc-econ">.*?</div>', '', card, flags=_re.S)
    card = _re.sub(r'\s*<div class="pc-foot">\s*</div>', '', card, flags=_re.S)
    card = _re.sub(r'\s*<a class="pc-cta"[^>]*>.*?</a>', '', card, flags=_re.S)
    return card

def _with_cta(card, same_page):
    if 'pc-cta' in card:
        return card
    n = _re.search(r'<div class="pc-name">([^<]+)</div>', card).group(1).strip()
    href = ('?p=%s#interest' % n) if same_page else ('/pricing.html?p=%s#interest' % n)
    return card[:card.rfind('</article>')] + '<a class="pc-cta" href="%s">%s</a>' % (href, _CTA_LABEL[n]) + '</article>'

def _price_block(card, heading, lede):
    return '''<section class="pad-s seam" id="price">
  <div class="wrap">
    <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,.86fr);gap:clamp(28px,5vw,68px);align-items:center" class="two">
      <div>
        <p class="eyebrow rv">What it costs</p>
        <h2 class="h2 rv d1" style="margin-top:16px;max-width:17ch">%s</h2>
        <p class="lede rv d2" style="margin-top:20px">%s</p>
        <p class="rv d3" style="margin-top:26px"><a class="btn btn-ghost" href="/pricing.html">See all three meters and the economics</a></p>
      </div>
      <div class="rv d2" style="max-width:420px;width:100%%;justify-self:end">%s</div>
    </div>
  </div>
</section>

''' % (heading, lede, _with_cta(_clean(card), False).replace('class="pcard lead"', 'class="pcard lead rv"').replace('class="pcard"', 'class="pcard rv"'))

# pricing.html: cards keep their economics and anchor to the form on the same page
_p = _src
for _c in _cards:
    _p = _p.replace(_c, _with_cta(_c, True))
(ROOT / 'pricing.html').write_text(_p, encoding='utf-8')
print('pricing.html ctas:', _p.count('pc-cta'), 'econ:', _p.count('pc-econ'))

# recover.html: its own card, no economics, in the same slot as every other product page
_r = (ROOT / 'recover.html').read_text(encoding='utf-8')
if 'class="pcard' not in _r:
    _blk = _price_block(_RECOVER, 'Nothing recovered, nothing owed.',
        'The fee is a share of dollars that actually land in your account, never a fee on calls placed or letters sent. Collections agencies publish 20 to 50% for the same work. We charge 15%.')
    _i = _r.rfind('<section class="paper seam pad">')
    _r = _r[:_i] + _blk + _r[_i:]
    (ROOT / 'recover.html').write_text(_r, encoding='utf-8')
    print('recover.html priced, ctas:', _r.count('pc-cta'))

# trades.html and hold.html are hand written, so their card is injected here too
for _slug, _card, _h, _l in (
    ('trades.html', _ANSWERED, 'Free until it books you work.',
     'No subscription and no per minute charge. The line can ring all day, and the meter does not move until a real job is on your calendar with a name, an address, a callback number and a confirmed window against it.'),
    ('hold.html', _HOLD, 'You pay for a person, not for the waiting.',
     'Two hours of hold music costs you nothing. The charge exists only at the moment an actual human being is on the line, and if one never is, there is no charge at all. There is no subscription and there never will be.'),
):
    _s = (ROOT / _slug).read_text(encoding='utf-8')
    if 'class="pcard' not in _s:
        _i = _s.rfind('<section class="paper seam pad">')
        _s = _s[:_i] + _price_block(_card, _h, _l) + _s[_i:]
        (ROOT / _slug).write_text(_s, encoding='utf-8')
        print(_slug, 'priced, ctas:', _s.count('pc-cta'))
    else:
        # REFRESH, do not skip. Scoped strictly to the <article> blocks so the
        # surrounding hand-written page, including the hero audio player, is
        # never touched.
        _fresh = _with_cta(_clean(_card), False)
        _fresh = _fresh.replace('class="pcard lead"', 'class="pcard lead rv"').replace('class="pcard"', 'class="pcard rv"')
        _n = len(_re.findall(r'<article class="pcard.*?</article>', _s, _re.S))
        _s2 = _re.sub(r'<article class="pcard.*?</article>', lambda m: _fresh, _s, count=1, flags=_re.S)
        if _n == 1 and _s2 != _s:
            (ROOT / _slug).write_text(_s2, encoding='utf-8')
            print(_slug, 'card refreshed from source')


# ── RULING GUARD ──────────────────────────────────────────────────────────────
# David ruled, verbatim: "15% stays!"  The hedge on that price has now entered
# this page TWICE, both times through a REWRITE rather than a decision, and the
# second time in different words ("are being sized with the first pilot
# customers"), which is why a grep for the first wording reported clean.
#
# A ruling that depends on everyone remembering it is not enforced. This fails
# the build instead. It matches INTENT, not one phrase, so a third rewording
# trips it too.
#
# The modeled-not-measured label is the OPPOSITE case and is REQUIRED: a
# contribution figure is a measurement claim about the world, a price is an
# offer. "15% stays" is not licence to strip the modeled labels.
import sys as _sys

_HEDGE = [
    r'shape of the deal', r'not a final number', r'\bstill being sized\b',
    r'\bbeing sized\b', r'\bsized with\b', r'\bsized in pilot\b',
    r'\bpriced in pilot\b', r'\bpriced in the pilot\b', r'\bpriced later\b',
    r'\bpriced on launch\b', r'\bpricing to come\b',
    r'\bprovisional\b', r'\bindicative\b', r'\bballpark\b',
    r'subject to change', r'\bto be determined\b', r'\bTBD\b',
    r'not yet final', r'we are still working out', r'may change',
]
_REQUIRED = ['worked out from published vendor rates', 'not measured from our own running system']

def _guard():
    import re as _re
    problems = []
    pricing = (ROOT / 'pricing.html').read_text(encoding='utf-8')
    text = _re.sub(r'<[^>]+>', ' ', pricing)

    got = sum(1 for r in _REQUIRED if r.lower() in text.lower())
    if got == 0:
        problems.append('MISSING the modeled-not-measured label on the contribution figures. '
                        'That label is required: a contribution figure is a measurement claim. '
                        '"15% stays" is not licence to remove it.')

    if '15%' not in text:
        problems.append('The 15% recovery share is not on the pricing page. David ruled it stays.')

    # A SECOND HEADLINE rate is worse than a hedge, because it makes the 15% look
    # unreliable without ever hedging it in words. But the war room's AGE TIERS
    # (10/15/20 by age, 8/13/18 for subscribers) are the BUILD TARGET, not a
    # contradiction, and 15 is the middle tier rather than a replacement.
    #
    # If you are adding a sanctioned tier and this fires, THE GATE IS WRONG, NOT
    # YOUR PAGE: add it to SANCTIONED.
    #
    # SCOPE HISTORY, because both mistakes are instructive:
    #   v1 read the whole page flattened -> bridged two cards and reported Hold's
    #      "about 55%" contribution as a recovery share. False positive.
    #   v2 scoped to pcard articles on pricing.html only -> killed that false
    #      positive AND opened a real hole: an unsanctioned rate on recover.html,
    #      or anywhere OUTSIDE a card, was invisible. Reproduced: a 35% share in
    #      the Recover hero-note reached the live page with the gate printing
    #      "intact". The `or [pricing]` fallback hid it, because it only fires
    #      when there are no cards at all, and there are always three.
    #   v3 (this) scans EVERY generated page, and within each page scans each card
    #      as its own scope PLUS the non-card remainder as another scope. Keeps the
    #      per-card isolation without leaving the space between cards dark.
    SANCTIONED = {'8', '10', '13', '15', '18', '20'}
    PAGES = ['index.html', 'trades.html', 'hold.html', 'recover.html',
             'pricing.html', 'trust.html', 'thanks.html']

    def _scopes(html):
        cards = _re.findall(r'<article class="pcard.*?</article>', html, _re.S)
        remainder = html
        for c in cards:
            remainder = remainder.replace(c, ' ')
        return cards + [remainder]

    for pg in PAGES:
        f = ROOT / pg
        if not f.exists():
            continue
        html = f.read_text(encoding='utf-8')
        for scope in _scopes(html):
            st = _re.sub(r'<[^>]+>', ' ', scope)
            # the gap must not contain another %, or the match anchors on the
            # FIRST percentage and bridges over the offending one: measured, with
            # [^.] the gate read "15% ... We take 35% of dollars" as share=15.
            for m in _re.finditer(r'(\d{1,3})\s*%[^.%]{0,30}(?:of dollars|actually recovered|recovery share)', st, _re.I):
                if m.group(1) not in SANCTIONED:
                    problems.append('CONTRADICTION in %s: recovery share stated as %s%%, outside the '
                                    'sanctioned tier set %s -> ...%s...'
                                    % (pg, m.group(1), sorted(SANCTIONED),
                                       st[max(0, m.start()-60):m.end()+50].strip()))
            # a hedge on the price is banned on EVERY page, not just pricing
            for pat in _HEDGE:
                for hm in _re.finditer(pat, st, _re.I):
                    window = st[max(0, hm.start()-140):hm.end()+140]
                    if _re.search(r'%|\bfee\b|\bprice\b|\brecover', window, _re.I):
                        problems.append('HEDGE on the price in %s: "%s" -> ...%s...'
                                        % (pg, pat, window.strip()[:170]))

    got = sum(1 for r in _REQUIRED if r.lower() in text.lower())
    if got == 0:
        problems.append('MISSING the modeled-not-measured label on the contribution figures. '
                        'That label is required: a contribution figure is a measurement claim. '
                        '"15% stays" is not licence to remove it.')

    if '15%' not in text:
        problems.append('The 15% recovery share is not on the pricing page. David ruled it stays.')

    # the narration transcript is a pricing surface too: on 08-12 the audio was
    # found selling tiers while the pages printed flat 15, and a hedge in the
    # spoken track is as much an offer defect as one in HTML. Scan it with the
    # same hedge patterns; scope to price-context windows like the page scan.
    _nar = ROOT / 'assets' / 'audio' / 'answered-buildout.txt'
    if _nar.exists():
        nt = _nar.read_text(encoding='utf-8')
        for pat in _HEDGE:
            for hm in _re.finditer(pat, nt, _re.I):
                window = nt[max(0, hm.start()-140):hm.end()+140]
                if _re.search(r'%|percent|\bfee\b|\bprice\b|\bdollar', window, _re.I):
                    problems.append('HEDGE on the price in the NARRATION transcript: "%s" -> ...%s...'
                                    % (pat, window.strip()[:170]))

    if problems:
        print('\n*** BUILD REFUSED: the 15% ruling is not intact ***', file=_sys.stderr)
        for p in problems:
            print('  - ' + p, file=_sys.stderr)
        _sys.exit(1)
    print('ruling guard: 15% intact, unhedged, modeled label present')

_guard()


# ── UPSTREAM GUARD ────────────────────────────────────────────────────────────
# The site guard above cannot see the artifacts the site is REBUILT FROM, and
# that is where the root actually lives. artifacts/final.json still records the
# war room's 10/15/20 age tiers and "flat fee, sized in pilot", and HANDOFF.md
# cites that file BY NAME next to the fee. That is why deleting the words kept
# failing: we each deleted a downstream copy while the source stayed intact.
#
# We do NOT rewrite those artifacts. They are the war room's actual verdict and
# this estate forbids deleting project history; overwriting a room's conclusion
# to match a later ruling falsifies the record. So the rule is: the contradiction
# may exist in the record ONLY while a founder ruling sits alongside it saying
# which paths it supersedes. Lose the annotation and the build stops.
#
# Deliberately NARROW. It reads only paths that state OUR price. It must never
# fire on competitor rates (incumbents publish 20-50%, PSI Collect 22%), on
# ESTIMATED measurement claims, or on generic playbook advice, because an
# over-reporting gate destroys trust in its real findings.
_ART = pathlib.Path('/Users/user/answered-handoff')

def _upstream_guard():
    import json as _json
    fj = _ART / 'artifacts' / 'final.json'
    if not fj.exists():
        print('upstream guard: artifacts not present, skipped')
        return
    try:
        d = _json.loads(fj.read_text(encoding='utf-8'))
    except Exception as e:
        print('upstream guard: could not parse final.json (%s), skipped' % e)
        return

    ruling = d.get('founder_ruling_2026_08_10')
    fin = d.get('final', {})
    surfaces = fin.get('three_surfaces') or []
    ours = ' '.join([
        str(surfaces[1].get('pricing', '')) if len(surfaces) > 1 else '',
        str(fin.get('moat', '')),
        ' '.join(str(s.get('why', '')) for s in (fin.get('subscores') or [])),
    ])

    import re as _re
    hedged = bool(_re.search(r'sized in pilot|being sized|not final|provisional', ours, _re.I))
    # The tiers are NOT a contradiction. David redirected: build what the room
    # specified at full scale. 10/15/20 and 8/13/18 in this artifact are the
    # BUILD TARGET. Only the HEDGE on the price is banned upstream.
    contradicts = False

    if (hedged or contradicts) and not ruling:
        print('\n*** BUILD REFUSED: upstream artifact contradicts the live price and is NOT annotated ***',
              file=_sys.stderr)
        print('  artifacts/final.json states our recovery price with a hedge or with tiers, and carries no',
              file=_sys.stderr)
        print('  founder_ruling_2026_08_10 key saying which paths that ruling supersedes. A rebuild reading',
              file=_sys.stderr)
        print('  this file will reconstruct a page that contradicts the founder and four live surfaces.',
              file=_sys.stderr)
        print('  Do NOT delete the tiers: they are the war room\'s reasoning. ADD the ruling alongside them.',
              file=_sys.stderr)
        _sys.exit(1)

    if hedged or contradicts:
        sup = str(ruling.get('supersedes', ''))
        ok = 'three_surfaces' in sup and 'moat' in sup
        print('upstream guard: artifact carries the old tiers, annotated by founder ruling%s'
              % ('' if ok else ' (WARNING: supersedes list does not name the paths that carry them)'))
    else:
        print('upstream guard: upstream artifacts clean')

_upstream_guard()


# ── the home page's three cards were injected once by a one-off script and never
# entered the generator, so they froze: the $549 cap and $39 quiet line reached
# /pricing and never reached the home card. A generator that only inserts is a
# one-time copy, not a source of truth. This refreshes all three, in order,
# scoped strictly to the <article> blocks so the hand-written page around them,
# including the hero audio player, is never touched.
def _refresh_home_cards():
    p = ROOT / 'index.html'
    s = p.read_text(encoding='utf-8')
    blocks = _re.findall(r'<article class="pcard.*?</article>', s, _re.S)
    if len(blocks) != 3:
        print('home cards: expected 3, found %d, leaving alone' % len(blocks))
        return
    fresh = []
    for card in (_ANSWERED, _HOLD, _RECOVER):
        f = _with_cta(_clean(card), False)
        f = f.replace('class="pcard lead"', 'class="pcard lead rv"').replace('class="pcard"', 'class="pcard rv"')
        fresh.append(f)
    # order must match, or we would silently swap products between cards
    def _name(x):
        m = _re.search(r'<div class="pc-name">([^<]+)</div>', x)
        return m.group(1).strip() if m else '?'
    if [_name(b) for b in blocks] != [_name(f) for f in fresh]:
        print('home cards: order differs from source, refusing to refresh')
        return
    out, i = s, 0
    for old in blocks:
        out = out.replace(old, fresh[i], 1)
        i += 1
    if out != s:
        p.write_text(out, encoding='utf-8')
        print('home cards refreshed from source (3)')

_refresh_home_cards()


# ── EXTENSIONLESS LINKS ───────────────────────────────────────────────────────
# Prod has served extensionless internal links (href="/trades") since the first
# deploy, but the rewrite lived only in a one-off step outside this repo, so a
# naive rebuild+deploy would silently revert live link style. The transform now
# lives HERE so the repo reproduces prod on this axis. Netlify serves /trades
# from trades.html (pretty URLs); "/index" collapses to "/".
def _extensionless():
    import re as _re
    pages = ['index.html', 'trades.html', 'hold.html', 'recover.html',
             'pricing.html', 'trust.html', 'thanks.html']
    pat = _re.compile(r'href="/(index|trades|hold|recover|pricing|trust|thanks)\.html([?#][^"]*)?"')
    def repl(m):
        slug, rest = m.group(1), m.group(2) or ''
        return 'href="%s%s"' % ('/' if slug == 'index' else '/' + slug, rest)
    n = 0
    for pg in pages:
        p = ROOT / pg
        s = p.read_text(encoding='utf-8')
        out, k = pat.subn(repl, s)
        if k:
            p.write_text(out, encoding='utf-8')
            n += k
    print('extensionless links: %d rewritten' % n)

_extensionless()
