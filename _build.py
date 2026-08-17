#!/usr/bin/env python3
"""Emit the product pages and normalise nav/footer across every page.

One source of truth for the chrome. A menu that drifts between pages is the
single most common tell of a site assembled by hand, and this site now has six.
"""
import os
import re, pathlib
import sys as _sys
from html.parser import HTMLParser as _HTMLParser

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
    {seg}<a class="nav-cta" href="/setup">Set your rules</a>
    <button class="burger" aria-label="Menu" aria-expanded="false" aria-controls="sheet"><span></span></button>
  </div>
</header>
<div class="sheet" id="sheet">{sheet}<a class="nav-cta" href="/setup">Set your rules</a></div>'''

# ★ ONE FACT, ONE SOURCE. The A2P consent sentence names the number our texts come FROM, which
# is a compliance artifact and not decoration. It was a literal here while every other surface on
# the estate read ANSWERED_DEMO_NUMBER, so a number change would have moved the spoken callback
# number, the health probe, the client and the edge function, and silently left this page naming the
# old one. David bought a NEW number on 2026-08-15, so that drift was about to happen for real.
# Falls back to the previous literal only so a build without the env still produces a page; the
# published-number check is what catches it being wrong.
def _pretty_number(e164: str) -> str:
    """(916) 282-5278 from +19162825278. One fact, one source."""
    import re as _re
    m = _re.fullmatch(r'\+1(\d{3})(\d{3})(\d{4})', (e164 or '').strip())
    return f'({m.group(1)}) {m.group(2)}-{m.group(3)}' if m else ''


# ★ DERIVED, NOT A SECOND ENV VAR. A separate ANSWERED_DEMO_NUMBER_PRETTY would be two variables
# holding one fact, which is the same drift this whole exercise exists to kill: somebody updates the
# E.164 one and the page keeps the old pretty one, silently, in the sentence carriers read.
# ★ THE REGISTERED NUMBER IS A PINNED LITERAL, AND THE BUILD REFUSES TO DISAGREE WITH IT.
#
# This line used to be `_pretty_number(env) or '(916) 350-4869'`. The fallback was the DEAD number,
# so any build whose environment was missing or stale silently published a number with no campaign
# behind it, inside the one sentence a carrier reviewer reads. That is not a hypothetical: it
# happened on 2026-08-15, when a build run from a control plane holding the old value reverted this
# page from 282-5278 back to 350-4869 and the diff was one line among asset stamps.
#
# It is also, precisely, the fact pattern behind three A2P rejections: the site describing a
# messaging program from a DIFFERENT number than the campaign registered. Error 30909.
#
# So the number the campaign registers is pinned here, deliberately, as the thing this file is
# willing to be wrong about loudly rather than quietly. The environment is still read, but only to
# CHECK: if it is set and disagrees, the build STOPS. A build that cannot name the registered
# number must fail, because "still produces a page" is the wrong trade when the page is a
# compliance artifact. Change this literal in the same commit as the campaign, never separately.
A2P_REGISTERED_E164 = '+19162825278'      # the number the A2P campaign registers

_env_number = (os.environ.get('ANSWERED_DEMO_NUMBER', '') or '').strip()
if _env_number and _env_number != A2P_REGISTERED_E164:
    raise SystemExit(
        'BUILD STOPPED. ANSWERED_DEMO_NUMBER is %s but the A2P campaign is registered to %s.\n'
        'One of them is wrong and publishing either guess is how this filing was rejected three\n'
        'times. If the campaign moved, change A2P_REGISTERED_E164 in _build.py in the same commit.\n'
        'If the environment is stale, fix the environment. Do not build around this.'
        % (_env_number, A2P_REGISTERED_E164))

A2P_NUMBER = _pretty_number(A2P_REGISTERED_E164)
if not A2P_NUMBER:
    raise SystemExit('BUILD STOPPED. A2P_REGISTERED_E164 is not a valid US E.164 number.')

FOOT = f'''<footer class="foot">
  <div class="wrap">
    <div class="foot-grid">
      <div>
        <a class="brand" href="/" aria-label="Answered, home">{MARK}<span class="brand-name"><b>ANSWERED</b></span></a>
        <p class="small" style="margin-top:16px;max-width:38ch">The phone layer. It answers, it waits, it follows the money. Priced per outcome, never per minute.</p>
        <p class="src" style="margin-top:10px;max-width:38ch">Every number sourced. Every call auditable. Every price an offer, not an estimate.</p>
      </div>
      <div>
        <h4>Products</h4>
        <ul>
          <li><a href="/trades.html">Answered, for your line</a></li>
          <li><a href="/hold.html">Hold, for everyone</a></li>
          <li><a href="/recover.html">Recover, for your invoices</a></li>
          <li><a href="/parley.html">Parley, for settling a price</a></li>
        </ul>
      </div>
      <!-- ★ A WAY TO REACH A PERSON THAT DOES NOT DEPEND ON THE PHONE LINE.
           Measured 2026-08-14 across all twelve public pages: zero tel: links, and no mailto, no
           calendar link, no contact route of any kind except one buried in /terms. A visitor who
           wanted to talk to somebody had nothing.

           The site is not missing the CAPABILITY: 21 health-gated call slots are wired across nine
           pages and build a real tel: link on a phone the moment /api/demo-health goes green. The
           gate is red because the telephony account is unfunded, so all 21 are dark at once and the
           site silently became a phone company you cannot contact.

           That is the estate's own rule landing on us: when the gate is red, the FALLBACK is the
           product. So this column is deliberately NOT gated on anything. Email works today, it is
           answered by a person, and it keeps working on the worst day the phone line has. -->
      <div>
        <h4>Talk to a person</h4>
        <ul>
          <li><a href="mailto:info@reddenda.com">info@reddenda.com</a></li>
          <li><span class="src">A person reads every one. Usually same day.</span></li>
          <!-- Uses the SAME health gate as every other call slot, rather than a second mechanism
               that could disagree with it. Green: this becomes a real call control, and a tel:
               link on a phone. Red: the honest sentence stays, and the email above still works. -->
          <li><span class="cta-slot" data-callslot="Call the line yourself"><span class="src">We only show the number when the line is genuinely answering. Right now it is not.</span></span></li>
        </ul>
      </div>
      <div>
        <h4>Company</h4>
        <ul>
          <!-- ★ ABOUT AND CONTACT ARE COMPLIANCE SURFACES, NOT NAVIGATION FURNITURE.
               A2P 10DLC error 30907 is "the submitted website URL doesn't represent the same
               business as the registered brand". Measured 2026-08-16 across all twelve live
               pages: "TwinFlame" 0, "LLC" 0, postal address 0, no About, no Contact. A reviewer
               had nothing on this domain to match TWINFLAME INVESTMENTS LLC against. These two
               links are how they find the match from any page on the site. -->
          <li><a href="/about.html">About the company</a></li>
          <li><a href="/contact.html">Contact a person</a></li>
          <li><a href="/account">Your account</a></li>
          <li><a href="/setup.html">How you set it up</a></li>
          <li><a href="/pricing.html">Pricing</a></li>
          <li><a href="/trust.html">Trust and guardrails</a></li>
          <li><a href="/#honesty">What we will not say</a></li>
          <li><a href="/terms.html">The terms, in plain words</a></li>
          <li><a href="/privacy.html">Privacy and texting</a></li>
          <li><a href="/recording.html">If your call was recorded</a></li>
        </ul>
      </div>
    </div>
    <!-- ★ THE ENTITY LINE. It is one sentence and it closes a real hole.
         The brand registered with the carriers is TWINFLAME INVESTMENTS LLC. Until 2026-08-16
         that string did not appear anywhere on this site, on any page, in any form, so the
         registered brand and the registered website named two different things and there was
         no way to tell from the site that they were one company. It sits in the shared footer
         rather than on one page because a reviewer, or a customer, can land on any URL.
         CTIA Messaging Principles 5.3.2 asks that a site reached from a message
         "unambiguously identify the website owner ... and include contact information, such as
         a postal mailing address." This is that, on every page, once. -->
    <div class="foot-base">
      <p class="src">Answered is a product of <b style="font-weight:600">TwinFlame Investments LLC</b>, trading as Reddenda. 1621 Central Ave, Cheyenne, WY 82001, United States. <a href="mailto:info@reddenda.com">info@reddenda.com</a> &middot; <a href="/about.html">About</a> &middot; <a href="/contact.html">Contact</a> &middot; <a href="/privacy.html">Privacy</a> &middot; <a href="/terms.html">Terms</a></p>
      <p class="src">Answered. Working name, working site. &copy; <span data-year>2026</span> TwinFlame Investments LLC.</p>
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


# ══ THE DECISION MOMENT ═══════════════════════════════════════════════════════
# Two things the jury said decide the sale, built once here so they cannot drift
# between the four generated pages.
#
# THE RISK REVERSAL is the strongest sentence on the site and it was living in a
# drawer on /pricing while every other price and every other CTA shipped naked.
# It belongs ADJACENT to the number, in the same eyeline, at a size you read
# rather than one you skip. One function, so the wording is identical wherever a
# price appears and a reword can never land on three surfaces out of four.
#
# Both helpers paint with the INK CONTRACT tokens (--ink, --ink-2, --accent-ink)
# rather than with --bronze/--t1 directly. That is what lets the same block sit
# on an obsidian section and on a bone paper close without a second variant, and
# it keeps the accent in the right family on each ground: Hi-Vis on dark, the
# day dialtone on paper. Hardcoding --bronze here would put acid yellow on cream.

_RULE = 'border-left:2px solid var(--accent-ink)'
_NUM = 'color:var(--accent-ink);font-weight:600'

def reversal(kind, top=22, center=False, delay='d2'):
    """The price law and the way out of it, side by side, next to the number."""
    body = {
        'answered': ('$0 base. <b class="num" style="%s">$19</b> when it books. '
                     'One word, <b class="num" style="%s;letter-spacing:.04em">VOID</b>, and it comes off.'),
        'hold':     ('$0 if nobody ever picks up. <b class="num" style="%s">$20</b> when a human is '
                     'on the line. Your first hold is free, and one word, '
                     '<b class="num" style="%s;letter-spacing:.04em">VOID</b>, takes off any charge.'),
        'recover':  ('$0 to start, $0 a month, <b class="num" style="%s">15%%</b> of what actually '
                     'lands. Nothing lands, nothing owed, and '
                     '<b class="num" style="%s;letter-spacing:.04em">VOID</b> takes off any charge.'),
    }[kind] % (_NUM, _NUM)
    # A CENTRED BLOCK, NOT CENTRED TEXT. Measured on /thanks: with the parent
    # section centring text, the left rule sat ~60px clear of the first
    # character and read as a stray mark rather than as the clause's edge. The
    # block centres; the words stay left against the rule that marks them.
    mid = ('margin-inline:auto;text-align:left;width:fit-content;'
           'max-width:min(56ch,100%);') if center else 'max-width:56ch;'
    return ('<p class="rv %s" style="margin-top:%dpx;%spadding-left:15px;%s;'
            'font-size:clamp(16.5px,1.45vw,20px);line-height:1.46;color:var(--ink)">'
            '%s</p>') % (delay, top, mid, _RULE, body)


def band_cell(idx, value, claim, source, delay='', kind='Source'):
    """A stat tile as an ARTIFACT: plate number, figure, claim, ruled provenance.

    The provenance line is the credibility engine of the whole band and it
    shipped at 11.5px on a .66 alpha, which is a whisper nobody reads. It is now
    ruled off from the claim, labelled, and set at 12.8px on --ink-2, so the
    thing that makes the number believable is legible at the distance the number
    is.

    ★ THE LABEL IS AN ARGUMENT, SO IT HAS TO BE ACCURATE (2026-08-13). It read
    "SOURCE" on all eight cells across /recover and /trust, and on five of the
    eight the thing underneath it was not a source. "SOURCE: Design target."
    "SOURCE: Answered pricing law." A reader who catches the word being stretched
    once discounts it on the three cells where the citation is real and external
    and checkable, which is the only place it was ever earning anything. So the
    word now means one thing: SOURCE sits over somebody else's published
    document, with a date. Our own commitments say COMMITMENT, our own
    definitions say DEFINITION, our own price says OUR PRICE. Fewer cells claim
    a citation and the three that do are worth something.

    kind is a plain label, not an enum, so a new cell cannot fail a lookup and
    silently fall back to claiming a source it does not have.
    """
    return (
        '<div class="band-cell rv %s">'
        '<div style="font-family:var(--mono);font-size:9.5px;letter-spacing:.22em;'
        'color:var(--ink-3);margin-bottom:13px">%s</div>'
        '<div class="band-v num">%s</div>'
        '<div class="band-k">%s</div>'
        '<div class="band-s src" style="margin-top:15px;padding-top:12px;'
        'border-top:1px solid var(--line);font-size:12.8px;line-height:1.58;color:var(--ink-2)">'
        '<span style="display:block;font-size:9.5px;letter-spacing:.22em;text-transform:uppercase;'
        'color:var(--accent-ink);margin-bottom:6px">%s</span>%s</div>'
        '</div>') % (delay, idx, value, claim, kind, source)


# TYPE MODULATION. Every H2 on these pages shipped at the same 62px, which gives
# a page no crescendo and no floor: the manifesto line and the plumbing headline
# read as equally important, so neither reads as important. Two registers now.
# PEAK is for the one sentence a section exists to say. UTIL is for a heading
# that is labelling a mechanism, and it gets a WIDER measure to go with the
# smaller size, so it settles into two lines instead of towering in five.
H2_PEAK = 'font-size:clamp(48px,5.4vw,76px);line-height:1.0;letter-spacing:-.022em;text-wrap:balance'
H2_UTIL = 'font-size:clamp(30px,3.4vw,52px);line-height:1.12;letter-spacing:-.012em;text-wrap:balance'
# MID is for a heading that has to COMMAND without COMPETING: a closing CTA, a
# second act. A page gets one peak, at most two. /thanks shipped a 76px H2 over
# a 64px H1, which inverts the page's own hierarchy and reads as a mistake even
# to someone who could not name it.
H2_MID = 'font-size:clamp(34px,3.9vw,58px);line-height:1.06;letter-spacing:-.018em;text-wrap:balance'


# ══ THE SWITCHBOARD ═══════════════════════════════════════════════════════════
# WHY THIS EXISTS, MEASURED 2026-08-14 AGAINST THE REPO, NOT ASSUMED.
#   · There is no billing code of any kind in this repository. No Stripe, no
#     checkout, no card field, no payment intent, nothing that can move a dollar.
#     Every price on every page is therefore an OFFER, and not one of them has
#     ever been charged to anybody.
#   · There is no customer account system. netlify/functions/interest.js upserts
#     a HubSpot contact and sends email through Resend. That is the whole funnel.
#     A contractor who says yes today gets a person, by hand, not a login.
#   · No function in this repo sends an SMS to a customer, and the A2P campaign
#     has been rejected three times, so nothing this company sends arrives as a
#     text. Nine sentences across these pages said or implied one would.
#
# DELETING THOSE PROMISES WAS NEVER THE OPTION. The founder's standing order is
# that a feature is never removed from this site. So every promise stays exactly
# where it was, and the pages gain the one thing they were missing: the line
# between what runs today and what does not.
#
# IT IS ONE SOURCE ON PURPOSE. The same four facts were being told four
# different ways in four places, which is how a disclosure quietly rots: one
# page gets updated, three do not, and the three that did not are now lying.
# STATES below is the only place any of it is written. /pricing, /trust, /terms,
# /privacy and /recording all render from here, and _texting_guard() at the
# bottom of this file fails the build if a page starts promising a text again.
#
# A STATE ROW IS NOT AN APOLOGY. "Every price here was published before we could
# take a single dollar" is a stronger sentence than anything we could have
# written to cover it up, and it is only available to a company telling the
# truth about where it is.
STATE_DATE = '2026-08-14'

# live=True gets the lit dot and reads LIVE. The demo-line row is the only one
# that moves, so it is the only one carrying the [data-callgate] pair: the
# branch that ships VISIBLE is the one that is true when the line is down, which
# is the correct fail direction and the same rule every other gated block on
# this site follows.
STATES = [
    dict(key='line', name='The demo line', live=True,
         short='the demo line answers, and a real call checks it every two hours',
         body='<span data-callgate hidden>It is answering this minute. It says it is an AI in its '
              'first sentence, it announces the recording, and it will not say a dollar amount.</span>'
              '<span data-callgate-off>A real call is placed to it every two hours, and every call '
              'button on this site reads that check before it hands you a number. That is why you '
              'sometimes get a list button here instead of a phone number.</span>'),
    # 2026-08-14, @LANE-SITE-TRUTH, SECOND WRITE OF THE DAY. This row said "there is
    # nothing to sign up for and no account to make, because neither one exists", and
    # that stopped being true a few hours after it shipped. @ANSWERED-ACCOUNTS landed
    # the account spine and posted 68 checks against the real production database.
    # MEASURED HERE, THROUGH THE SERVING PATH, BEFORE REWRITING THE ROW: live prod
    # answers /account with 200 and a real sign-in page, and /api/account/start and
    # /api/meter both answer 405 to a GET, so they are deployed and method-gated
    # rather than missing.
    #
    # A DISCLOSURE THAT UNDERSTATES IS STILL A DISCLOSURE THAT IS WRONG, and this is
    # the exact rot the switchboard was built to stop: one row goes stale, four pages
    # keep printing it, and the company is now lying about being smaller than it is.
    # It stays NOT YET because the reader's question on this row is "is my line being
    # answered", and until a person assigns the number the answer to that is still no.
    # account.mjs says so in its own header: "Assigning a phone number is a human step
    # today." The row says the same thing in the same words.
    dict(key='lines', name='Business lines', live=False,
         short='an account and your rules exist today, and a person assigns the number by hand',
         body='You can make an account today, write the rules your line answers by, and ask for a '
              'number. What a person still does by hand is assign the number itself, and we would '
              'rather tell you that than show you a spinner. Until it is assigned your line is '
              'unchanged, and nothing is answering for you.'),
    # 2026-08-14, @LANE-BILLING. THIS ROW WAS TRUE THIS MORNING AND IS NOT TRUE
    # TONIGHT, so it is rewritten rather than left standing. The meter now exists:
    # it rates an outcome against the list on /terms, it caps a bill at the cap,
    # it records the free events beside the paid ones, and a customer can kill a
    # charge from their own statement. What still does not exist is the moment of
    # payment. There is no card field on this site, the switch that would let a
    # card be charged is off, and turning it on is a deliberate act by a person.
    # The row stays NOT YET because the reader's question is "can this take my
    # money", and the answer to that is still no.
    dict(key='billing', name='Billing', live=False,
         short='the meter runs, and nothing on this site can charge you',
         body='The meter is running. Every outcome is priced against the list on the terms page, '
              'capped, and written down with the reason beside it, including the ones that cost '
              'you nothing. What does not exist yet is the moment you pay. There is no card field '
              'anywhere on this site, and the switch that would let a card be charged is off. Every '
              'price here was published before we could take a single dollar, which is the order we '
              'wanted it in.'),
    # ★ REWORDED 2026-08-16, AND THE REWORD IS A COMPLIANCE FIX, NOT A SOFTENING.
    # The old body read "we are not sending texts to anybody". True, and fine for a customer.
    # But this row renders on /terms, which is the URL filed as TermsAndConditionsUrl, and a
    # carrier reviewer verifying that a live messaging program has compliant terms reads a
    # page that tells them the program does not exist. Twilio error 30908 is exactly "the
    # privacy policy in your registration could not be verified as compliant"; a terms page
    # asserting there is nothing to verify hands them the finding.
    # The honest version keeps the status and moves the tense: the TERMS are in force, the
    # PERMISSION is what is pending. Nothing here claims a message has been sent.
    # ★ FLIPPED TO LIVE 2026-08-17, on measurement, not on an approval email. The
    # A2P campaign reads VERIFIED with a real campaign_id and real per-carrier rate
    # limits, and two messages were DELIVERED to a real handset on a carrier we do
    # not control. The same number had four undelivered sends earlier the same day
    # (30034, 30032), so this is a controlled before-and-after on one circuit rather
    # than a single hopeful success. The prior wording is now false in the other
    # direction, which is its own kind of dishonesty on a customer-facing page.
    dict(key='texting', name='Texting', live=True,
         short='registered with the carriers, and sending',
         # ★ THE WORDS "Reply STOP" AND "Message and data rates may apply" ARE DELIBERATELY
         # ABSENT HERE. This row renders inside a .rv reveal, and _RevealScan refuses the build
         # when a required SMS disclosure sits behind an IntersectionObserver, because a carrier
         # reviewer screenshots without scrolling. Putting the disclosure phrases in a status
         # table would put a compliance string somewhere the reviewer cannot see it, and the
         # build correctly caught that the first time this row was rewritten. The disclosure
         # belongs in the opt-in block beside the phone field, where it is always visible.
         body='Our messaging program is registered and verified with the US carriers, and it '
              'sends. You only get a message you asked for: the transcript, a booking link, or a '
              'receipt, fewer than five a month. Stopping them takes one word, and the full '
              'rules of the program are written out on the terms page. They applied from the '
              'first message onward.'),
]

# THE CAPTION IS SHORT BECAUSE 320 IS REAL. At 27 characters this label wrapped
# to THREE mono lines inside a 248px table at 320px wide, against a date sitting
# on one, which reads as a broken header rather than a caption. The section
# heading above already says the long version, so the caption only has to name
# the object. MEASURED, at 320, twice: 'What is on, and what is not' took three
# lines, 'What is on' still took two against a 16-character date, and one word
# takes one. This is the kind of defect that passes every assertion and is only
# ever visible in a screenshot.
_SB_HEAD = 'State'


def state_table(dark=False, delay='d2', top=26):
    """The four rows, as a receipt. .ptable rebinds the ink contract itself, so
    the same call paints correctly on obsidian (.dark) and on bone paper.

    THE CHIP IS NOT A FLEX CONTAINER, DELIBERATELY. .prow aligns its two grid
    items on the BASELINE. A flex chip's baseline is its first flex item, which
    here is a 7px dot carrying no text, so the state word would have hung below
    the row's name. The dot is inline-block instead and the word keeps the
    baseline. Measured, not assumed: this is the same class of defect as an
    inline <b> blown out into its own flex item, which passes every geometry
    assertion and is only visible in a screenshot.
    """
    rows = []
    for d in STATES:
        lit = d['live']
        ink = 'var(--accent-ink)' if lit else 'var(--ink-2)'
        dot = ('background:var(--accent-ink)' if lit
               else 'border:1.5px solid var(--ink-3)')
        rows.append(
            '<div class="prow" id="state-' + d['key'] + '">'
            '<div><b style="display:block;font-weight:600;font-size:17px;letter-spacing:-.005em">'
            + d['name'] + '</b>'
            '<span style="display:block;margin-top:7px;font-size:15px;line-height:1.56;'
            'color:var(--ink-2)">' + d['body'] + '</span></div>'
            '<div style="font-family:var(--mono);font-size:10.5px;letter-spacing:.18em;'
            'white-space:nowrap;color:' + ink + '">'
            '<span aria-hidden="true" style="display:inline-block;width:7px;height:7px;'
            'border-radius:999px;margin-right:9px;vertical-align:1px;' + dot + '"></span>'
            + ('LIVE' if lit else 'NOT YET') + '</div>'
            '</div>')
    return ('<div class="ptable' + (' dark' if dark else '') + ' rv ' + delay + '" '
            'style="margin-top:' + str(top) + 'px">'
            '<div class="prow head"><span>' + _SB_HEAD + '</span>'
            '<span>As of ' + STATE_DATE + '</span></div>'
            + ''.join(rows) + '</div>')


SB_EYEBROW = 'Where this actually is'
SB_HEADING = 'What is on, and what is not.'
SB_LEDE = ('This site describes a phone company we are still building. Rather than leave you to '
           'work out which parts exist, here is the line, in one place, dated.')
SB_TAIL = ('Stated ' + STATE_DATE + '. These four rows are written in exactly one place, so no page '
           'can quietly fall out of date on its own. When a row changes it changes here, and every '
           'page carrying it changes in the same build.')


def switchboard(dark=False, attrs='', eyebrow=None, heading=None, lede=None, tail=None):
    """The whole section. id="state" is the anchor every state_note points at."""
    ground = 'pad-s seam' if dark else 'paper seam pad-s'
    return ('\n<section class="' + ground + '" id="state"' + attrs + '>\n'
            '  <div class="wrap">\n'
            '    <p class="eyebrow rv">' + (eyebrow or SB_EYEBROW) + '</p>\n'
            '    <h2 class="h2 rv d1" style="' + H2_UTIL + ';margin-top:16px;max-width:24ch">'
            + (heading or SB_HEADING) + '</h2>\n'
            '    <p class="lede rv d2" style="margin-top:20px;max-width:62ch">'
            + (lede or SB_LEDE) + '</p>\n'
            '    ' + state_table(dark=dark) + '\n'
            '    <p class="src rv d3" style="margin-top:22px;max-width:82ch">'
            + (tail or SB_TAIL) + '</p>\n'
            '  </div>\n'
            '</section>\n')


def state_note(keys, top=20, center=False, delay='d3'):
    """One dated sentence at a promise site, drawn from the same rows.

    A disclosure a reader has to go and find is worth nothing, and a page that
    repeats the whole switchboard four times is unreadable. This is the middle:
    the one row that bears on the sentence beside it, plus the way to the rest.
    """
    parts = [d['short'] for d in STATES if d['key'] in keys]
    if len(parts) == 1:
        txt = parts[0]
    elif len(parts) == 2:
        txt = parts[0] + ', and ' + parts[1]
    else:
        txt = ', '.join(parts[:-1]) + ', and ' + parts[-1]
    mid = ('margin-inline:auto;text-align:left;width:fit-content;max-width:min(66ch,100%);'
           if center else 'max-width:66ch;')
    return ('<p class="src rv ' + delay + '" style="margin-top:' + str(top) + 'px;' + mid + '">'
            'Stated ' + STATE_DATE + ': ' + txt + '. The whole line between what runs today and '
            'what does not is <a href="/pricing.html#state">on the pricing page</a>.</p>')


# ── /pricing ──────────────────────────────────────────────────────────────────
PRICING = '''

<section class="gate pad-s" id="choose">
  <div class="wrap">
    <p class="eyebrow rv">Before the numbers</p>
    <h1 class="display rv d1" style="font-size:clamp(40px,5.4vw,74px);line-height:1;text-wrap:balance;margin-top:16px">Who is the phone<br> <span class="lit">ringing for?</span></h1>
    <p class="lede rv d2" style="margin-top:20px;max-width:56ch">Three products, three meters. Pick the one that is you.</p>
    <p class="rv d2" style="margin-top:18px;max-width:60ch;display:flex;gap:12px;align-items:flex-start;border-left:2px solid var(--bronze);padding-left:14px;font-size:clamp(16px,1.35vw,19px);line-height:1.45;color:var(--t1)"><span><b style="font-weight:500">You are charged when something good happened, and never for the attempt.</b></span></p>

    <div class="gate-grid">
      <button class="gc rv" type="button" data-pick="consumer">
        <span class="gc-i">01</span>
        <span class="gc-t">It rings for me</span>
        <span class="gc-d">A carrier, a bank, an airline. Somebody else does the waiting and the arguing.</span>
        <span class="gc-w">Shows Hold</span>
        <span class="gc-go">See what that costs</span>
      </button>

      <button class="gc rv d1" type="button" data-pick="business">
        <span class="gc-i">02</span>
        <span class="gc-t">It rings for my business</span>
        <span class="gc-d">Calls come in while your hands are full. Invoices go quiet after the work is done.</span>
        <span class="gc-w">Shows Answered and Recover</span>
        <span class="gc-go">See what that costs</span>
      </button>

      <button class="gc rv d2" type="button" data-pick="both">
        <span class="gc-i">03</span>
        <span class="gc-t">Both, honestly</span>
        <span class="gc-d">You own the business. You are also the one on hold at nine at night.</span>
        <span class="gc-w">Shows everything</span>
        <span class="gc-go">See all of it</span>
      </button>
    </div>

    <p class="src rv d3" style="margin-top:24px;max-width:70ch;font-size:12.5px;color:rgba(242,244,240,.74)">This only changes what the page shows. Switch any time from the line at the top.</p>
  </div>
</section>

<section class="pad" data-aud="consumer business both" style="padding-top:clamp(38px,4.6vw,68px)">
  <div class="wrap">
    <div class="aud-chip">Showing prices for <b class="aud-name">everyone</b> <button type="button" class="aud-change">change</button></div>
    <p class="eyebrow rv" style="margin-top:26px">What it costs</p>
    <p class="display h2 rv d1" style="''' + H2_PEAK + ''';margin-top:16px" role="heading" aria-level="2">Three products.<br> Three meters. <span class="lit">One rule.</span></p>
    <p class="lede rv d2" style="margin-top:22px;max-width:62ch">Money moves only when something good happened. A job booked. A human reached. A dollar recovered. No subscription and no per minute price, anywhere in this company.</p>

    <div class="pcards">
      <article class="pcard lead rv" data-aud="business both">
        <div class="pc-for">01 / Inbound</div>
        <div class="pc-name">Answered</div>
        <div class="pc-price num">$19</div>
        <div class="pc-unit">per job booked in standard hours.<br> <b style="color:var(--bronze-2)">$49</b> for a job booked after hours.</div>
        <div class="pc-free" style="font-size:12.5px;line-height:1.7;letter-spacing:.045em;border-style:solid;border-color:rgba(227,255,79,.36)">$0 subscription &middot; $0 per minute &middot; $0 per call &middot; $0 for a wrong number</div>
        <p class="pc-void" style="margin-top:13px;padding-left:13px;border-left:2px solid var(--bronze);font-size:15px;line-height:1.42;color:var(--t1)">One word, <b class="num" style="color:var(--bronze-2);font-weight:600;letter-spacing:.04em">VOID</b>, takes any charge off. No argument, no ticket.</p>
        <div class="pc-meter"><span>A booked job means a name, an address, a callback number and a confirmed window. Anything less is free.</span><span>Your bill stops at <b>$549</b>. You set the cap.</span><span>After 90 days, a quiet line settles at <b>$39</b> a month, credited back against bookings.</span></div>
        <ul class="pc-list">
          <li>Answers your existing number, 24 hours a day</li>
          <li>Qualifies the caller and books into your calendar</li>
          <li>Warm transfers a real emergency to your cell in five seconds</li>
          <li>Sends you the transcript inside a minute, by text or by email</li>
          <li>Never quotes a price, enforced in three layers</li>
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
        <div class="pc-free" style="font-size:12.5px;line-height:1.7;letter-spacing:.045em;border-style:solid;border-color:rgba(227,255,79,.36)">$0 if nobody ever picks up &middot; your first hold is free &middot; no subscription, ever</div>
        <p class="pc-void" style="margin-top:13px;padding-left:13px;border-left:2px solid var(--bronze);font-size:15px;line-height:1.42;color:var(--t1)">One word, <b class="num" style="color:var(--bronze-2);font-weight:600;letter-spacing:.04em">VOID</b>, takes any charge off. No argument, no ticket.</p>
        <div class="pc-meter"><span><b>One price, the whole errand.</b> However long the queue runs, however many redials it takes. No clock on your bill.</span><span>A connection means a human on the line who can act on your case. A phone tree is not one, and not a charge.</span><span>Government lines are <b>$20</b> because the queues are longer. Commercial lines are <b>$10</b>.</span></div>
        <ul class="pc-list">
          <li>Works the phone tree, enters your reference, survives the transfer</li>
          <li>Holds as long as it takes, across redials and reconnects</li>
          <li>Rings you the moment a person is on the line</li>
          <li>Ends with the hold receipt: the clock, the queue, the recording</li>
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
        <div class="pc-free" style="font-size:12.5px;line-height:1.7;letter-spacing:.045em;border-style:solid;border-color:rgba(227,255,79,.36)">$0 to start &middot; $0 a month &middot; $0 if nothing lands</div>
        <p class="pc-void" style="margin-top:13px;padding-left:13px;border-left:2px solid var(--bronze);font-size:15px;line-height:1.42;color:var(--t1)">One word, <b class="num" style="color:var(--bronze-2);font-weight:600;letter-spacing:.04em">VOID</b>, takes any charge off. No argument, no ticket.</p>
        <div class="pc-meter"><span>The share exists only on dollars that clear into your account, never on calls placed.</span><span>15% is the standard band. Newer invoices 10%, the oldest 20%, subscribers less on every band. You see the band before the first call, and all three are in the <a href="/terms.html" style="color:inherit">terms</a>.</span><span><b>Autopilot</b> instead: a flat $19 for every invoice that gets paid, no share at all.</span><span>Where state law bars the shape of a contingency fee, you get the flat option automatically.</span></div>
        <ul class="pc-list">
          <li>Calls every invoice past day thirty, in your name and on your caller ID</li>
          <li>Knows the job, the address and the date, because it booked the work</li>
          <li>Writes down every promise to pay, and follows up on the date</li>
          <li>Collections agencies publish 20 to 50% for the same work</li>
        </ul>
        <div class="pc-foot">
          <a class="pc-cta" href="?p=Recover#interest">I want my invoices chased</a>
          <div class="pc-econ">Modeled on a $10,000 recovery<br> Revenue <b>$1,500.00</b><br> Cost of the calls behind it <b>$4.50</b><br> Contribution <b>$1,495.50, about 99.7%</b></div>
        </div>
      </article>
    </div>
    <p class="src rv d3" style="margin-top:24px;max-width:88ch;font-size:12.5px;color:rgba(242,244,240,.74)">These figures are worked out from published vendor rates, not measured from our own running system. The arithmetic is below.</p>
  </div>
</section>
''' + switchboard(dark=False, attrs=' data-aud="consumer business both"') + '''

<section class="pad-s seam" data-aud="business both" style="padding-top:clamp(40px,5vw,72px)">
  <div class="wrap">
    <div>
      <div>
        <p class="eyebrow rv">The whole system</p>
        <h2 class="h2 rv d1" style="''' + H2_UTIL + ''';margin-top:16px;max-width:30ch">Five parts. One of them is a phone code.</h2>
        <p class="lede rv d2" style="margin-top:20px;max-width:64ch">Nothing installed, nothing ported. Your number never changes.</p>
      </div>
      <div class="rv d2" style="margin-top:clamp(28px,3.4vw,48px);overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain"><div class="bp run" style="min-width:820px">
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
      <!-- anchored END at 455 so the words run LEFT, away from the emergency
           branch that leaves node 03 to the right at the same height. -->
      <text x="455" y="98" text-anchor="end" class="bp-sub">says it is an AI, first sentence</text>
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
      <text x="830" y="218" text-anchor="middle" class="bp-sub">the transcript</text>
    </g>

    <!-- the emergency branch -->
    <path d="M470 120 C470 70 620 70 690 70 H800 C820 70 830 80 830 100 V128" class="bp-wire dash"/>
    <text x="640" y="58" text-anchor="middle" class="bp-sub">a real emergency transfers straight to your cell</text>

    <!-- the reversal. the path STOPS where the caption starts: it used to run
         to x=430 under a caption anchored middle at x=470, i.e. straight
         through its own words for 130 units. -->
    <path d="M250 176 C250 240 250 250 302 250" class="bp-wire dash"/>
    <text x="314" y="254" text-anchor="start" class="bp-sub">one code turns it off again, ten seconds</text>
  </svg>
  <span class="bp-cap">Fig 1 &middot; call path</span>
</div></div>
      <p class="src rv d3" style="margin-top:10px;font-size:12.2px;color:var(--ink-3)">Five nodes, left to right. The figure scrolls sideways on a narrow screen.</p>
    </div>
  </div>
</section>

<section class="paper seam pad-s" data-aud="business both">
  <div class="wrap">
    <p class="eyebrow rv">What the customer gets for it</p>
    <h2 class="h2 rv d1" style="''' + H2_UTIL + ''';margin-top:16px;max-width:26ch">Four cents for every dollar it makes you.</h2>
    <div class="ptable rv d2" style="box-shadow:0 24px 60px -28px rgba(0,0,0,.72),0 2px 0 rgba(11,12,14,.06)">
      <div class="prow" style="border-top:0;padding-block:11px;background:rgba(11,12,14,.05);font-family:var(--mono);font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;color:rgba(11,12,14,.66)"><span>Fig 2 &middot; the price against the work</span><span>Answered, per booked job</span></div>
      <div class="prow head"><span>What Answered produced</span><span>Its price as a share of that</span></div>
      <div class="prow"><span>A booked service call, $350 to $500 average ticket</span><span class="num">4 to 5%</span></div>
      <div class="prow"><span>A booked after hours call, about $1,400</span><span class="num">3.5%</span></div>
      <div class="prow"><span>A saved water heater lead, $1,193 ticket</span><span class="num">1.6%</span></div>
      <div class="prow hi"><span>A saved roof lead, $9,504 ticket</span><span class="num">0.5%</span></div>
      <div class="prow"><span>An afternoon of your life, back</span><span class="num">$20</span></div>
    </div>
    <p class="src rv d3" style="margin-top:20px;max-width:84ch;font-size:12.5px;line-height:1.6;color:rgba(11,12,14,.72)">Tickets from Thumbtack average cost data, 2026. Lead values apply Invoca's measured 45% call-to-close rate (70M calls, July 2026) to those tickets. Human answering services publish $250 to $2,100 a month.</p>
  </div>
</section>

<section class="pad seam" data-aud="both" style="padding-top:clamp(48px,6vw,92px)">
  <div class="wrap">
    <p class="eyebrow rv">Where the money goes</p>
    <h2 class="h2 rv d1" style="''' + H2_UTIL + ''';margin-top:16px;max-width:26ch">Where each dollar goes.</h2>
    <p class="lede rv d2" style="margin-top:20px;max-width:64ch">Every bar is <b>one event</b>, split into what it costs us and what is left. Never a monthly total.</p>

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

    <p class="src rv d3" style="margin-top:22px;max-width:86ch;font-size:12.5px;color:rgba(242,244,240,.74)">Hold costs more because holding is the product: an hour of queue is an hour of telephony. Answering and collecting are short calls.</p>
  </div>
</section>

<section class="paper seam pad-s" data-aud="both" style="padding-top:clamp(46px,5.6vw,84px)">
  <div class="wrap">
    <p class="eyebrow rv">The math, step by step</p>
    <h2 class="h2 rv d1" style="''' + H2_UTIL + ''';margin-top:16px;max-width:30ch">How $19 costs us a dollar fifty.</h2>
    <p class="lede rv d2" style="margin-top:20px;max-width:62ch">Every input is either a published vendor rate or an assumption labeled as ours.</p>

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
        <div class="step-t"><b>So one answered call costs us</b><span>Booked or not. Those calls are free to the customer.</span></div>
        <div class="step-v">$0.53</div>
      </div>
      <div class="step-row">
        <span class="op">&divide;</span>
        <div class="step-t"><b>Roughly one call in three books a job</b><span>35%, our own planning assumption, not yet measured in production.</span></div>
        <div class="step-v">35%</div>
      </div>
      <div class="step-row out">
        <span class="op">=</span>
        <div class="step-t"><b>About $1.50 of calls behind every booked job</b><span>Against $19.00 charged, leaving $17.50.</span></div>
        <div class="step-v">$1.50</div>
      </div>
    </div>

    <p class="src rv d3" style="margin-top:22px;max-width:88ch;font-size:12.5px;line-height:1.62;color:rgba(11,12,14,.72)">Per minute rates from published vendor pricing accessed 2026-08-10: Vapi platform fee $0.05 a minute plus models at cost, Retell $0.07 to $0.31 priced by part, Bland $0.11 to $0.14 all inclusive, Twilio ConversationRelay $0.07 plus $0.0085 inbound voice and $1.15 a month for a local number. <b>The 35% booking rate and the 45% recovery rate are our own planning assumptions and are not yet measured in production.</b> The first pilot measures them, and the result gets published here.</p>
  </div>
</section>

<section class="paper seam pad-s" data-aud="consumer business both" style="padding-top:clamp(52px,6.4vw,96px)">
  <div class="wrap">
    <p class="eyebrow rv">Why the shape matters more than the number</p>
    <h2 class="h2 rv d1" style="''' + H2_PEAK + ''';margin-top:16px;max-width:18ch">Their meter wants a longer call. <span class="lit">Ours wants a booked job.</span></h2>
    <p class="lede rv d2" style="margin-top:20px;max-width:64ch">On a per minute meter, every extra minute is margin. On ours, a shorter call that still books the job is better for both sides.</p>
  </div>
</section>

<section class="pad seam" data-aud="business both" style="padding-top:clamp(52px,6.4vw,100px)">
  <div class="wrap narrow">
    <p class="eyebrow rv">Your protection</p>
    <h2 class="h2 rv d1" style="''' + H2_UTIL + ''';margin-top:16px">Every charge, provable.<br> <span class="lit">Every dispute, yours.</span></h2>
    <p class="rv d2" style="margin-top:22px;padding-left:14px;border-left:2px solid var(--bronze);font-size:clamp(17px,1.5vw,21px);line-height:1.45;color:var(--t1);max-width:52ch">$0 base. <b class="num" style="color:var(--bronze-2);font-weight:600">$19</b> when it books. One word, <b class="num" style="color:var(--bronze-2);font-weight:600;letter-spacing:.04em">VOID</b>, and it comes off.</p>
    <details class="disc rv d2" style="margin-top:30px" open>
      <summary>Every charge shows you the call it came from.</summary>
      <div class="disc-body"><p>The recording where consent permits, the transcript, and the appointment record. If you cannot see why you were charged, you should not be charged.</p></div>
    </details>
    <details class="disc rv d2">
      <summary>One tap disputes any charge, and you keep the benefit of the doubt.</summary>
      <div class="disc-body"><p>We would rather lose the $19 than have you spend a Tuesday arguing about it. Repeat disputes mean our booking definition is wrong.</p></div>
    </details>
    <details class="disc rv d3">
      <summary>Quality failures refund themselves before you notice.</summary>
      <div class="disc-body"><p>A nightly check re-reads every booking. A wrong address, a slot already taken, a callback never logged. Those reverse automatically and tell you why.</p></div>
    </details>
    <details class="disc rv d3">
      <summary>What happens at the moment you pay.</summary>
      <div class="disc-body"><p>Nothing is charged as it happens. Every outcome goes on a running statement of your own, priced against the list on the <a href="/terms.html" style="color:var(--bronze-2)">terms page</a>, with the free ones shown beside the paid ones. At the end of the month that statement becomes one bill for one number. You see it before it is charged, and any line on it can be voided until it is.</p></div>
    </details>
    <details class="disc rv d3">
      <summary>Which of these is running today, and which is not.</summary>
      <div class="disc-body"><p>Running now: the price of every outcome, the cap, the free first hold, the four pieces a job needs before it can cost you anything, and the VOID button on your statement. Not running yet: the nightly re-read described above, and the moment of payment itself. There is no card field on this site and the switch that would let a card be charged is off.</p></div>
    </details>
    <!-- Same disclosure the trust page carries, because these four are written
         in the present tense about a meter that has not billed anybody yet.
         They are the terms we are binding ourselves to, which is a different
         kind of statement from a measurement, and a reader is entitled to know
         which one he is reading before he reads four of them. -->
    <p class="src rv d3" style="margin-top:22px;max-width:74ch">Stated 2026-08-14. These are the terms of the meter. The meter itself is running and writing them down, and it has still billed nobody, because no customer line is on the system yet, so none of these is a measurement. What is live today is on the <a href="/trust.html" style="color:var(--bronze-2)">trust page</a>.</p>
  </div>
</section>


<section class="pad-s seam" data-aud="consumer business both" style="padding-block:clamp(46px,5.4vw,80px)">
  <div class="wrap narrow" style="text-align:center">
    <p class="eyebrow rv" style="justify-content:center">Before you decide</p>
    <h2 class="h2 rv d1" style="''' + H2_MID + ''';margin-top:16px">Do not take our word for it. <span class="lit" data-callgate hidden>Call it.</span><span class="lit" data-callgate-off>Check it.</span></h2>
    <!-- THE HEALTH GATE, BOTH WAYS. [data-callgate] ships hidden and appears
         only on healthy:true. [data-callgate-off] ships VISIBLE and is retired
         on healthy:true. The section therefore has a true sentence in it in
         every state, which the single-direction gate did not: measured on the
         red path 2026-08-13, this section printed "The demo line is answering
         right now" with no number anywhere on the page. The demo number is
         never in this file, in either branch. -->
    <p class="lede rv d2" data-callgate hidden style="margin-top:22px;margin-inline:auto;max-width:52ch">Every number above describes a voice you have not heard. It is answering right now.</p>
    <p class="lede rv d2" data-callgate-off style="margin-top:22px;margin-inline:auto;max-width:54ch">The demo line is not answering this minute, so the page will not hand you a number that rings out. It is called every two hours and returns by itself.</p>
    <p class="rv d2" style="margin-top:24px"><span class="cta-slot" data-callslot="Hear it answer"><a class="btn btn-primary" href="#interest">Tell us what you need</a></span></p>
    <p class="src rv d3" data-callgate hidden style="margin-top:14px;font-size:12.8px;color:var(--ink-2)">Free, no account, nobody calls you back. Push it for a price and watch it refuse.</p>
    <p class="src rv d3" data-callgate-off style="margin-top:14px;font-size:12.8px;color:var(--ink-2)">The page reads the line before it offers it to you.</p>
  </div>
</section>

<section class="paper seam pad" id="interest" data-aud="consumer business both">
  <div class="wrap narrow">
    <p class="eyebrow rv" style="justify-content:center">Tell us what you need</p>
    <h2 class="h2 rv d1" style="''' + H2_UTIL + ''';margin-top:16px;text-align:center">No checkout.<br> Just tell us what you need.</h2>
    <p class="lede rv d2" style="margin-top:20px;text-align:center;margin-inline:auto;max-width:54ch">Nothing to buy here, on purpose. The first group goes live free and stays free until it produces something.</p>
    ''' + reversal('answered', top=24, center=True) + '''

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
        <p class="src" style="margin-top:8px">Adding your number opts you into Answered texts from {A2P_NUMBER}: the transcript, booking link, or receipt you asked for. Fewer than five a month, and it varies by what you ask for. Message and data rates may apply. Reply STOP to stop, HELP for help. <a href="/terms#texting">Terms</a> and <a href="/privacy">Privacy</a>.</p>
      </div>
      <div class="ifield full">
        <label for="i-note">Anything we should know</label>
        <textarea id="i-note" name="note" placeholder="What you do, how many calls a week, what you are losing to the phone right now."></textarea>
      </div>
      <button class="btn btn-primary" type="submit">Send it</button>
    </form>
    <p class="src rv d3" style="margin-top:16px;text-align:center">One reply from a person, not a drip sequence. Fleets and franchises get a call, not a listed price.</p>
  </div>
</section>
'''

# ── /recover ──────────────────────────────────────────────────────────────────
RECOVER = '''
<section class="hero" style="min-height:auto;padding-bottom:clamp(40px,5.2vw,74px)">
  <div class="hero-bg" aria-hidden="true"></div>
  <div class="wrap">
    <div class="hero-grid">
      <div>
        <p class="eyebrow rv">Recover. For the work you already did.</p>
        <h1 class="display rv d1" style="font-size:clamp(34px,4.6vw,64px);text-wrap:balance">You already earned it.<br> <span class="lit">Somebody should ask for it.</span></h1>
        <p class="lede hero-sub rv d2">The invoice went out. Thirty one days went by. Nobody called. Recover makes the call, in your name, on your caller ID, and writes down what was promised.</p>
        ''' + reversal('recover', top=24) + '''
        <div class="hero-actions rv d3" style="margin-top:26px">
          <a class="btn btn-primary" href="/setup">Set your rules</a>
          <a class="btn btn-ghost" href="/pricing.html">See what it costs</a>
        </div>
        <p class="src hero-note rv d3">All three bands and the flat alternative are <a href="#fee" style="color:var(--bronze-2)">further down this page</a>.</p>
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
      ''' + band_cell('01', '$299B', 'of US construction payments ran late in one year.', 'Rabbet Construction Payments Report, 2025. Commercial contractor to subcontractor payments.') + '''
      ''' + band_cell('02', '20-50%', 'is what agencies publish for this work, in their own rate cards.', 'Two published cards, not one. The Kaplan Group lists 20% on $5,000 to $50,000 claims and 50% on claims under $1,000, dated 2023-08-29. PSI Collect lists 22% on $5,000 to $50,000, accessed 2026-08-10.', 'd1') + '''
      ''' + band_cell('03', 'Day 31', 'is when an invoice stops being late and starts being a project.', 'The window Recover works, before default and before an agency. Where we chose to start, not a finding about the world.', 'd2', kind='Our definition') + '''
      ''' + band_cell('04', '$0', 'is the whole bill if nothing lands. The fee exists only on recovered dollars.', 'Stated by us, identical on every surface of this site and in the terms. Not a measurement: an offer you can hold us to.', 'd3', kind='Our price') + '''
    </div>
  </div>
</section>

<section class="pad" style="padding-top:clamp(56px,6.4vw,96px)">
  <div class="wrap">
    <p class="eyebrow rv">Why this one works when a collections letter does not</p>
    <h2 class="h2 rv d1" style="''' + H2_UTIL + ''';margin-top:16px;max-width:30ch">Not a stranger calling. You, following up.</h2>
    <div class="steps">
      <div class="step rv"><h3 class="h3">Your name, your number</h3><p>A letter from a stranger gets ignored. A call from the company that did the work gets paid. Nothing about it says the account was sold.</p></div>
      <div class="step rv d1"><h3 class="h3">It remembers the job</h3><p>It answered the call that created the work. It knows the address and the date, so the conversation goes somewhere.</p></div>
      <div class="step rv d2"><h3 class="h3">Every promise written down</h3><p>Who said they would pay, how much, by when. Thursday's follow up happens without you.</p></div>
    </div>
  </div>
</section>

<section class="pad-s seam" style="padding-top:clamp(52px,6vw,88px)">
  <div class="wrap">
    <div style="display:grid;grid-template-columns:minmax(0,.92fr) minmax(0,1.08fr);gap:clamp(28px,5vw,68px);align-items:center" class="two">
      <div>
        <p class="eyebrow rv">Watch it work</p>
        <h2 class="h2 rv d1" style="''' + H2_UTIL + ''';margin-top:16px;max-width:26ch">The aged list, going down instead of sideways.</h2>
        <p class="lede rv d2" style="margin-top:20px">The number at the top is what you are still owed, and it only moves in one direction.</p>
      </div>
      <div class="rv d2"><div class="showcase" data-show="recover">
  <div class="sc-bar"><span class="sc-dot" aria-hidden="true"></span> Recover, working the aged list <span class="sc-num">Day 31 and over</span></div>
  <div class="sc-body">
    <div class="meter-lab">Money out there</div>
    <div class="meter-big">$23,410</div>
    <div class="inv">
      <div class="inv-row" data-amt="1193" data-outcome="paid"><span class="name">Rivera, water heater</span><span class="age">34d</span><span class="amt">$1,193</span></div>
      <div class="inv-row" data-amt="2850" data-outcome="paid"><span class="name">Okafor, panel upgrade</span><span class="age">41d</span><span class="amt">$2,850</span></div>
      <div class="inv-row" data-amt="11400" data-outcome="promised"><span class="name">Delgado GC, phase two</span><span class="age">63d</span><span class="amt">$11,400</span></div>
      <div class="inv-row" data-amt="7967" data-outcome="open"><span class="name">Whitmore, roof section</span><span class="age">88d</span><span class="amt">$7,967</span></div>
    </div>
  </div>
  <!-- THE LEDGER DOES NOT GO TO ZERO, AND THAT IS THE POINT (2026-08-13). It
       used to: all four rows stamped PAID and the meter animated $23,410 down
       to $0. The note underneath said "not a projection of results" while the
       picture above it projected a 100% recovery rate, and the picture is what
       a reader takes away. A collections demo that wins every account is the
       least believable thing we could show a contractor, who knows perfectly
       well that the 88 day one does not pay on the first call. Two land, one
       gives a dated promise, one is still being worked, and the meter moves
       only on money that actually cleared, which is the same rule the fee
       runs on. Honest AND more persuasive, which is usually the same move. -->
  <div class="sc-note">Concept rendering. Not a customer record and not a projection of results. The number moves only when money lands, so a promise to pay is dated here but never counted as recovered.</div>
</div></div>
    </div>
  </div>
</section>



<!-- THE WHOLE FEE, ON THE PRODUCT PAGE (2026-08-13). /recover said 15% and
     nothing else. The terms page, which says of itself "if your bill and this
     page ever disagree, this page wins", has published three bands the whole
     time: 10% on newer invoices, 15% on most, 20% on the oldest, and less again
     for Answered subscribers. A buyer who read the product page and then read
     the governing document found a price he had not been shown, which is the
     definition of a bait number no matter how honest the intent was. The
     headline offer does not move, because 15 IS the standard band. What
     changes is that the page now states the whole thing, which is also where
     the flat option and the state-law gate belong: for a contractor in New
     York, Illinois or North Carolina the flat option is not an alternative,
     it is the only lawful shape, and that cannot live only in a card. -->
<section class="pad-s seam" id="fee" style="padding-top:clamp(48px,5.4vw,76px)">
  <div class="wrap">
    <p class="eyebrow rv">The whole fee</p>
    <h2 class="h2 rv d1" style="''' + H2_UTIL + ''';margin-top:16px;max-width:26ch">Fifteen percent is the standard band.</h2>
    <div class="steps" style="margin-top:30px">
      <div class="step rv"><h3 class="h3">Three bands, by age, shown before the first call</h3><p>Newer invoices <b class="num" style="color:var(--bronze-2)">10%</b>. Most <b class="num" style="color:var(--bronze-2)">15%</b>. The oldest <b class="num" style="color:var(--bronze-2)">20%</b>, because older money is harder to get back. You see the band before anyone dials.</p></div>
      <div class="step rv d1"><h3 class="h3">Autopilot, if you would rather have a flat fee</h3><p>A flat <b class="num" style="color:var(--bronze-2)">$19</b> for every invoice that gets paid, no percentage on top. Never per call, never per invoice placed.</p></div>
      <div class="step rv d2"><h3 class="h3">In three states the flat option is the only one</h3><p>New York, Illinois and North Carolina bar the shape of a contingency fee for this work. If you are in one, the flat option is served automatically, gated on your verified business location.</p></div>
    </div>
    <p class="src rv d3" style="margin-top:24px;max-width:78ch">Recovered means the payment lands within 30 days of our last contact, or by a date the payer promised in writing. Money outside that window is yours alone. The <a href="/terms.html" style="color:var(--bronze-2)">terms</a> win over any page here.</p>
    ''' + state_note(['lines', 'billing'], top=16) + '''
  </div>
</section>

<section class="pad-s seam" style="padding-block:clamp(40px,4.6vw,64px)">
  <div class="wrap">
    <div class="mn" style="max-width:74ch;margin-inline:auto">
      <b>This works the same way for you personally.</b>
      <p style="margin-top:8px">The friend who still owes you for the trip. The deposit a landlord never sent back. Same voice, same rule: nothing back, nothing owed.</p>
      <a class="card-go" href="/#track" style="margin-top:12px">See the personal side <span aria-hidden="true">&rarr;</span></a>
    </div>
  </div>
</section>
<section class="paper seam pad">
  <div class="wrap narrow" style="text-align:center">
    <p class="eyebrow rv" style="justify-content:center">Get started</p>
    <h2 class="h2 rv d1" style="''' + H2_MID + ''';margin-top:16px">Put the quiet invoices on the list.</h2>
    ''' + reversal('recover', top=26, center=True) + '''
    <!-- THE HEALTH GATE. What ships is the ghost below: a plain list CTA. The
         module in answered.js swaps it for the live call control, and un-hides
         the two lines around it, ONLY when /api/demo-health answers
         healthy:true. The demo number is never in this file. -->
    <p class="lede rv d2" data-callgate hidden style="margin-top:26px;margin-inline:auto;max-width:46ch">Hear the voice before you hand it an invoice.</p>
    <p class="rv d2" style="margin-top:22px"><span class="cta-slot" data-callslot="Hear it chase an invoice"><a class="btn btn-primary" href="/setup">Set your rules</a></span></p>
    <p class="src rv d3" data-callgate hidden style="margin-top:14px">Free. No account. Nobody calls you back.</p>
    <p class="src rv d3" data-callgate-off style="margin-top:14px">The demo line is not answering this minute, so the page has taken the number down. It is called every two hours and returns by itself.</p>
  </div>
</section>
'''

# ── /trust ────────────────────────────────────────────────────────────────────
TRUST = '''
<section class="pad" style="padding-top:calc(var(--nav-h) + clamp(44px,6vw,88px));padding-bottom:clamp(44px,5vw,72px)">
  <div class="wrap">
    <p class="eyebrow rv">Trust</p>
    <h1 class="display rv d1" style="font-size:clamp(34px,4.6vw,64px);text-wrap:balance;margin-top:16px">Audit every word<br> <span class="lit">from the truck.</span></h1>
    <p class="lede rv d2" style="margin-top:22px;max-width:60ch">Every call transcribed to you inside a minute. Every charge linked to the call that made it. Which parts run today, and which do not, is set out below.</p>
  </div>
</section>

<section class="band">
  <div class="wrap" style="padding-inline:0">
    <div class="band-grid">
      ''' + band_cell('01', '60s', 'from hang up to the transcript in your hand.', 'Our design target, published 2026-08-13. Not a measurement, and we will not print one until customer lines are running. It arrives by text, or by email if you did not give us a number.', kind='Our commitment') + '''
      ''' + band_cell('02', '5s', 'from a caller asking for a human to your cell ringing.', 'Our design target, published 2026-08-13. Warm transfer attempt. 20 seconds without a pickup and it takes a callback and sends it to you.', 'd1', kind='Our commitment') + '''
      ''' + band_cell('03', '0', 'prices quoted. Ever. It is not allowed to say a number.', 'Our rule, published 2026-08-13, held by three guardrails below. Two run on the demo line today, so you can test it yourself.', 'd2', kind='Our commitment') + '''
      ''' + band_cell('04', '1st', 'sentence of every call is the AI saying it is an AI.', 'Our rule, published 2026-08-13. Every call, everywhere, whether or not the law requires it. Check it on the demo line.', 'd3', kind='Our commitment') + '''
    </div>
  </div>
</section>

<section class="pad" style="padding-top:clamp(56px,6.4vw,96px)">
  <div class="wrap">
    <p class="eyebrow rv">The guardrail that matters most</p>
    <h2 class="h2 rv d1" style="''' + H2_PEAK + ''';margin-top:18px;max-width:22ch">It will never quote a price. <span class="lit">Enforced in three places.</span></h2>
    <p class="lede rv d2" style="margin-top:24px;max-width:62ch">Pricing is yours to give, and it stays yours. The agent books the visit and tells the caller you will confirm the number personally.</p>
    <div class="cards">
      <article class="card rv"><div class="card-tag">Layer 1 &middot; running now</div><h3 class="h3">The instruction</h3><p>It is told what to say instead: it cannot quote, you will call back today, and it books the visit anyway.</p></article>
      <article class="card rv d1"><div class="card-tag">Layer 2 &middot; running now</div><h3 class="h3">The filter</h3><p>Every sentence is checked for dollar amounts before it is spoken. A number that slips the instruction is cut before the caller hears it.</p></article>
      <article class="card rv d2"><div class="card-tag">Layer 3 &middot; starts with the first customer line</div><h3 class="h3">The nightly replay</h3><p>Fifty recorded calls where a caller pushes hard for a price, replayed against every build overnight. It needs real customer calls, so it starts when the first line does.</p></article>
    </div>
  </div>
</section>

<!-- WHERE WE ACTUALLY ARE (2026-08-13). The rest of this page was written in
     the present tense about a product with no customer lines on it. Every
     mechanism described is real and designed and some of it is genuinely
     running, but "Every call transcribed to you inside a minute" reads as a
     measurement of a fleet, and there is no fleet. The privacy page already
     does this correctly and says so in as many words ("Customer lines: not
     live yet... We would rather show you a blank than invent a number"), which
     is the strongest paragraph on this whole site. This page owed the same
     paragraph. It is placed HIGH, above the audit mechanics, because a
     disclosure a skeptic finds after he has already discounted the page is
     worth nothing, and one he finds before he starts is the reason he keeps
     reading. -->
<section class="pad-s seam" style="padding-top:clamp(52px,6vw,88px)">
  <div class="wrap">
    <p class="eyebrow rv">Where we actually are</p>
    <h2 class="h2 rv d1" style="''' + H2_UTIL + ''';margin-top:16px;max-width:30ch">Some of this is running. Some is not.</h2>
    ''' + state_table(dark=True) + '''
    <p class="rv d3" style="margin-top:26px;max-width:76ch">Two more things follow from those rows. <b style="font-weight:600">The transcript inside a minute, the warm transfer, the guardrail counter and the nightly replay all need a live customer line</b>, so the four numbers at the top of this page are targets we are binding ourselves to, not measurements of a fleet. And <b style="font-weight:600">there are numbers we will not print until we have them</b>: no answer rate, no recovery rate, no customer count, no logo wall, no testimonial. None of them exists yet. The first pilot produces the real ones, and they go up here including the unflattering ones.</p>
    <p class="src rv d3" style="margin-top:20px;max-width:78ch">Stated 2026-08-14. If the first customer lines are live and this still says otherwise, that is a page we failed to update.</p>
  </div>
</section>

<section class="paper seam pad-s" style="padding-top:clamp(58px,6.6vw,100px)">
  <div class="wrap">
    <p class="eyebrow rv">How you audit it</p>
    <h2 class="h2 rv d1" style="''' + H2_UTIL + ''';margin-top:16px;max-width:30ch">From the truck, on your phone.</h2>
    <div class="steps">
      <div class="step rv" style="border-color:rgba(30,27,23,.2)"><h3 class="h3">Every call, transcribed to you</h3><p style="color:rgba(30,27,23,.76)">The transcript, a one line summary and the caller's number, inside a minute of the call ending.</p></div>
      <div class="step rv d1" style="border-color:rgba(30,27,23,.2)"><h3 class="h3">It reports its own mistakes first</h3><p style="color:rgba(30,27,23,.76)">A hang up mid sentence. An address it misheard. A callback it promised and never logged. You hear it from us first.</p></div>
      <div class="step rv d2" style="border-color:rgba(30,27,23,.2)"><h3 class="h3">Four numbers, no vanity metrics</h3><p style="color:rgba(30,27,23,.76)">Answer rate. Median pickup, in rings. Escalations delivered to your cell. Price guardrail violations, which should read zero.</p></div>
    </div>
    <p class="src rv d3" style="margin-top:26px;max-width:80ch;font-size:12.8px;line-height:1.6;color:var(--ink-2)">If the recording system goes down, we stop taking your calls rather than take them unwatched, and tell you that. Silent degradation is worse than an outage.</p>
  </div>
</section>

<section class="pad-s seam" style="padding-top:clamp(52px,6vw,88px)">
  <div class="wrap narrow">
    <p class="eyebrow rv">Disclosure and recording</p>
    <h2 class="h2 rv d1" style="''' + H2_UTIL + ''';margin-top:16px;max-width:32ch">Held to the strictest rule in the country.</h2>
    <details class="disc rv d2" style="margin-top:28px" open>
      <summary>It identifies itself as an AI in its first sentence.</summary>
      <div class="disc-body"><p>Not buried later in the call. First sentence, every call, everywhere. We never ship a version that hides.</p></div>
    </details>
    <details class="disc rv d2">
      <summary>Recording is announced on every call, everywhere.</summary>
      <div class="disc-body"><p>Eleven states require every party to consent. We could look up the caller's state and behave differently. We do not: that lookup can fail silently, and a failure is a wiretap claim.</p></div>
    </details>
    <details class="disc rv d3">
      <summary>Answering a call is not the same as making one, legally or ethically.</summary>
      <div class="disc-body"><p>Inbound answering is untouched by the rules that govern outbound dialing. When we call out for you, consent is in the code, not in a policy.</p></div>
    </details>
  </div>
</section>

<section class="paper seam pad">
  <div class="wrap narrow" style="text-align:center">
    <p class="eyebrow rv" style="justify-content:center">Get started</p>
    <h2 class="h2 rv d1" style="''' + H2_MID + ''';margin-top:16px">Audit it for a week before you trust it.</h2>
    ''' + reversal('answered', top=26, center=True) + '''
    <!-- THE HEALTH GATE. What ships is the ghost below: a plain list CTA. The
         module in answered.js swaps it for the live call control, and un-hides
         the two lines around it, ONLY when /api/demo-health answers
         healthy:true. The demo number is never in this file. -->
    <p class="lede rv d2" data-callgate hidden style="margin-top:26px;margin-inline:auto;max-width:48ch">Call it and listen to the first sentence.</p>
    <p class="rv d2" style="margin-top:22px"><span class="cta-slot" data-callslot="Hear the first sentence"><a class="btn btn-primary" href="/setup">Set your rules</a></span></p>
    <p class="src rv d3" data-callgate hidden style="margin-top:14px">It tells you it is an AI before anything else. Push it for a price and watch it refuse.</p>
    <p class="src rv d3" data-callgate-off style="margin-top:14px">The demo line is not answering this minute, so the page has taken the number down. Same rule as above: down beats unwatched.</p>
  </div>
</section>
'''

page('pricing.html', 'Answered pricing. You only pay when it works.',
     'No subscription and no per minute price. $19 a booked job, $49 after hours, $20 when a human is reached, 15% of what is recovered, and $0 when nothing is produced.', PRICING)
page('recover.html', 'Recover. You already earned it. Now somebody asks for it.',
     'Follow up on the invoices that went quiet at day 31, in your own name and on your own caller ID. Nothing recovered, nothing owed.', RECOVER)
THANKS = '''
<section class="hero" style="min-height:auto;padding-block:clamp(56px,7vw,104px) clamp(44px,5.4vw,78px)">
  <div class="hero-bg" aria-hidden="true"></div>
  <div class="wrap narrow" style="position:relative;z-index:2;text-align:center">
    <div class="ring-stage" style="max-width:240px;margin-bottom:30px">
      <div class="ring-glow" aria-hidden="true"></div>
      <canvas aria-hidden="true"></canvas>
      <div class="ring-center"><div class="ring-state">Picked up on the first ring</div><div class="ring-count" style="font-size:clamp(20px,2.4vw,28px)">Answered</div></div>
    </div>
    <p class="eyebrow rv" style="justify-content:center">Received</p>
    <h1 class="display rv d1" style="font-size:clamp(34px,4.6vw,64px);margin-top:16px">A person has it,<br> <span class="lit">not a drip sequence.</span></h1>
    <p class="lede rv d2" style="margin-top:22px;margin-inline:auto;max-width:46ch">We read every one of these ourselves. You will hear back from a person.</p>
    <div class="hero-actions rv d3" style="justify-content:center;margin-top:30px">
      <a class="btn btn-ghost" href="/">Back to the site</a>
      <a class="btn btn-ghost" href="/pricing.html">See what each part costs</a>
    </div>
  </div>
</section>

<!-- The highest intent moment on the whole site: they have just asked for it.
     The one thing better than reading about the voice here is hearing it, so
     this close carries the same health-gated call control as every other page.
     What ships is the ghost; the number is never in this file, in either branch.

     BOTH BRANCHES ARE WRITTEN, because the red one was the one that shipped.
     Measured 2026-08-13 with /api/demo-health forced to 503: this section
     printed "The demo line is answering right now" in 30px type under the
     heading "You do not have to take our word for the voice", and then handed
     over a button reading "See what each part costs" that was byte-identical
     to the one already in the hero of this same page. A false present-tense
     claim, an unkept promise and a duplicated control, all in one section, all
     invisible to a green-path check. The red branch now says what is true and
     sends them to the seven minute walkthrough, which is the same voice and is
     a file on this origin rather than a line that has to be up. -->
<section class="paper seam pad-s">
  <div class="wrap narrow" style="text-align:center">
    <p class="eyebrow rv" style="justify-content:center">While you wait</p>
    <h2 class="h2 rv d1" style="''' + H2_MID + ''';margin-top:16px">Hear the voice yourself.</h2>
    <p class="lede rv d2" data-callgate hidden style="margin-top:22px;margin-inline:auto;max-width:50ch">The demo line is answering right now. It says it is an AI, refuses to quote a price, and books you a slot anyway.</p>
    <p class="lede rv d2" data-callgate-off style="margin-top:22px;margin-inline:auto;max-width:52ch">The demo line is not answering this minute. The seven minute walkthrough is the same voice, and it plays either way.</p>
    ''' + reversal('answered', top=26, center=True) + '''
    ''' + state_note(['lines', 'billing'], top=16, center=True) + '''
    <p class="rv d2" style="margin-top:22px"><span class="cta-slot" data-callslot="Hear it answer now"><a class="btn btn-primary" href="/#listen">Hear the walkthrough instead</a></span></p>
    <p class="src rv d3" data-callgate hidden style="margin-top:14px">Free. No account. Nobody calls you back.</p>
    <p class="src rv d3" data-callgate-off style="margin-top:14px">A real call is placed to the line every two hours. The number returns by itself.</p>
  </div>
</section>
'''

page('trust.html', 'Trust. Audit every call from the truck.',
     'It never quotes a price, it hands a caller to a human in five seconds, it transcribes every call to you inside a minute, and it reports its own mistakes first.', TRUST)
page('thanks.html', 'Thank you. A person has it.',
     'Your note reached a person at Answered. We read every one of these ourselves and you will hear back from a human being.', THANKS)


# ── normalise the chrome on every hand-written page ───────────────────────────
# THE THREE LEGAL PAGES WERE NEVER IN THIS LOOP, AND THEIR FOOTERS HAD DRIFTED.
# terms/privacy/recording each carried a byte copy of the chrome as it stood on
# the day they were written, so by 2026-08-14 the footer on all three was
# missing FIVE links that FOOT had gained since: /parley, /setup, /terms,
# /privacy and /recording. Measured consequence: a reader standing on /privacy
# could not reach /recording, and /privacy's own footer did not link /privacy.
# Their own header comments asked for exactly this. They are in the guard,
# _extensionless() and _asset_version() lists already; this closes the last one,
# and from here their chrome cannot drift again.
# ★ AND THE LIST ITSELF WAS THE BUG, TWICE. The comment above describes finding three pages whose
# chrome had drifted because they were not in this loop. The fix was to add three names to a
# hardcoded list, which left parley.html and setup.html outside it, and on 2026-08-14 those two
# were measured missing a footer change every other page had. A list you must remember to append to
# is a defect with a delay on it.
#
# So the loop now DISCOVERS its own members: every page at the root that carries the shared chrome
# gets it normalised. Generated pages are rewritten from TAIL anyway, so including them is
# idempotent and harmless. A page added next week is covered the day it is added, by nobody.
_CHROME = sorted(
    q.name for q in ROOT.glob('*.html')
    if '<footer class="foot">' in q.read_text(encoding='utf-8')
)
for slug in _CHROME:
    active = '/' if slug == 'index.html' else '/' + slug
    p = ROOT / slug
    s = p.read_text(encoding='utf-8')
    s = re.sub(r'<header class="nav">.*?</header>\s*<div class="sheet" id="sheet">.*?</div>\n',
               nav(active) + '\n', s, count=1, flags=re.S)
    s = re.sub(r'<footer class="foot">.*?</footer>', FOOT, s, count=1, flags=re.S)

    # ── canonical ────────────────────────────────────────────────────────────
    # Measured 2026-08-14: ZERO rel="canonical" across all twelve public pages,
    # while every page is reachable at BOTH /pricing and /pricing.html because
    # _extensionless() rewrites the links but the .html URL keeps answering 200.
    # Two live URLs for one page, and nothing telling a crawler which is the
    # real one. The canonical is always the EXTENSIONLESS form, because that is
    # what every internal link now points at.
    # ★ ONE FACT, ONE SOURCE. The A2P consent sentence names the number our texts come FROM. It is
    # a compliance artifact, not decoration, and it was a LITERAL here while every other surface
    # read ANSWERED_DEMO_NUMBER: scripts.mjs speaks it aloud on every recovery call, the health
    # probe checks it, the client renders it, the edge function injects it. David bought a NEW
    # number on 2026-08-15, so a change would have moved all four and silently left this page naming
    # the dead one. Substituted here, in the loop that already rewrites every page, because the
    # template it lives in is a plain string full of braces and converting it to an f-string would
    # break the CSS and JS inside it.
    s = s.replace('{A2P_NUMBER}', A2P_NUMBER)

    # ── A CONSENT MECHANISM MUST NEVER REST AT opacity:0 ─────────────────────
    # ★ MEASURED ON LIVE PRODUCTION 2026-08-16, and this is a carrier rejection,
    # not a nitpick. `html.js .rv { opacity: 0 }` until an IntersectionObserver
    # fires, and EVERY opt-in form on this site shipped as `class="iform rv d2"`.
    # So on /pricing, the URL filed as the campaign's MESSAGE_FLOW evidence, a
    # capture that loads the page and does not scroll sees NONE of this:
    #     "Adding your number opts you into ..."   invisible
    #     "Fewer than five a month"                invisible
    #     "Message and data rates may apply"       invisible
    #     "Reply STOP" / "HELP for help"           invisible
    # The whole <form> was at opacity 0 while the <p> inside it computed 1,
    # which is why every grep, every "is it on the page" check and every human
    # who scrolled said it was fine. Twilio states plainly that the registered
    # website "undergoes an automated verification process. A screenshot is
    # captured and is evaluated against the A2P 10DLC compliance rules", and
    # error 30908 named MESSAGE_FLOW on two consecutive rejections.
    #
    # The reveal stays everywhere else. It is stripped from the two things a
    # reviewer must be able to see without interacting: the opt-in form itself,
    # and any block carrying the consent sentence. DISCOVERED by the property
    # that defines them, never a list of page names.
    _consent_before = s
    s = re.sub(r'(<form\b[^>]*\bclass=")([^"]*)"',
               lambda m: m.group(1) + ' '.join(
                   t for t in m.group(2).split() if t not in ('rv', 'd1', 'd2', 'd3')) + '"', s)
    for _mark in ('Adding your number opts you into', 'Message and data rates may apply',
                  'Reply STOP'):
        for _m in re.finditer(re.escape(_mark), s):
            _open = s.rfind('<p ', 0, _m.start())
            _close = s.find('>', _open) if _open >= 0 else -1
            if _open < 0 or _close < 0 or _close > _m.start():
                continue
            _tag = s[_open:_close + 1]
            _new = re.sub(r'class="([^"]*)"',
                          lambda m: 'class="' + ' '.join(
                              t for t in m.group(1).split() if t not in ('rv', 'd1', 'd2', 'd3')) + '"',
                          _tag)
            if _new != _tag:
                s = s[:_open] + _new + s[_close + 1:]

    canon = 'https://answered.reddenda.com' + ('/' if slug == 'index.html' else '/' + slug[:-5])
    s = re.sub(r'\n<link rel="canonical"[^>]*>', '', s)
    s = s.replace('</head>', f'<link rel="canonical" href="{canon}">\n</head>', 1)

    p.write_text(s, encoding='utf-8')
    print('chrome normalised in', slug)

# ── AND IT REFUSES, RATHER THAN PRINTING THAT IT RAN ─────────────────────────
# The transform above is worthless if a later edit reintroduces the class, and a
# disclosure that silently stops being visible is the worst failure available
# here: everything downstream still believes it is there. This asserts on the
# OUTPUT of the whole build, with a positive control proving it can fail.
# ★ IT WALKS THE ANCESTOR STACK, because the element itself is never the problem.
# On live prod the consent <p> computed opacity 1 while its parent <form> computed
# 0. A check that reads the element's own class is a check that agrees with every
# broken page. This one keeps the open-tag stack and asks the only question that
# matters: is ANY ancestor of this disclosure a reveal?
# It also means the guard is NOT a tautology against the transform above: that
# transform only strips <form> and <p> tags, so a reveal on any wrapper still
# reaches here and still refuses.
class _RevealScan(_HTMLParser):
    MARKS = ('Adding your number opts you into', 'Message and data rates may apply', 'Reply STOP')
    VOID = {'br','img','input','meta','link','hr','source','area','base','col','embed','track','wbr'}
    def __init__(self, slug):
        super().__init__(convert_charrefs=True)
        self.slug, self.stack, self.bad = slug, [], []
    def handle_starttag(self, tag, attrs):
        if tag in self.VOID:
            return
        cls = dict(attrs).get('class') or ''
        self.stack.append((tag, 'rv' in cls.split()))
        if tag == 'form' and any(hidden for _t, hidden in self.stack):
            self.bad.append('%s: the opt-in <form> is inside a reveal (%s)'
                            % (self.slug, ' > '.join(t for t, h in self.stack if h)))
    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                return
    def handle_data(self, data):
        if any(m in data for m in self.MARKS) and any(h for _t, h in self.stack):
            self.bad.append('%s: a required SMS disclosure is inside a reveal (%s)'
                            % (self.slug, ' > '.join(t for t, h in self.stack if h)))

_hidden = []
for _slug in _CHROME:
    _p = _RevealScan(_slug)
    _p.feed((ROOT / _slug).read_text(encoding='utf-8'))
    _hidden += _p.bad
if _hidden:
    print('\n*** BUILD REFUSED: a consent mechanism would ship at opacity:0 ***', file=_sys.stderr)
    for _h in _hidden:
        print('  -', _h, file=_sys.stderr)
    print('  A carrier reviewer captures a screenshot without scrolling. An opt-in\n'
          '  form or a rates/STOP disclosure behind an IntersectionObserver is not on\n'
          '  the page as far as that reader is concerned. This is error 30908.',
          file=_sys.stderr)
    _sys.exit(1)
# positive control: the transform must actually have had something to do, or the
# check above is passing because it is looking at the wrong thing.
assert '<form' in (ROOT / 'pricing.html').read_text(encoding='utf-8'), \
    'POSITIVE CONTROL FAILED: no <form> on pricing.html, so the consent check proves nothing'
print('consent visibility: %d pages, 0 opt-in forms and 0 rate disclosures behind a reveal'
      % len(_CHROME))


# ── THE STATE MARKERS ON THE STANDALONE PAGES ─────────────────────────────────
# terms/privacy/recording are hand-written HTML and cannot call a Python
# function, so each carries a marker pair that the generator refills on every
# run. That keeps them standalone to READ and generated to MAINTAIN, which is
# the only arrangement under which four pages still promise the same thing in
# the same words a month from now.
#
# IT REFUSES RATHER THAN SKIPS. A marker that goes missing in an edit would make
# this step a silent no-op, and a disclosure that silently stops rendering is
# worse than one that was never written, because everybody downstream still
# believes it is there.
_STATE_BLOCKS = {
    'terms.html': switchboard(
        dark=True, eyebrow='Before the bill',
        heading='Nothing here has billed anybody yet.',
        lede='Everything on this page is a term we are binding ourselves to in advance. None of it '
             'describes a bill that somebody received, because there are none. Here is the line, in '
             'the same words every other page on this site uses.'),
    'privacy.html': '  ' + state_note(['lines'], top=16) + '\n',
    'recording.html': '  ' + state_note(['lines'], top=16) + '\n',
}

def _standalone_state():
    import re as _re, sys as _s2
    for slug, block in _STATE_BLOCKS.items():
        p = ROOT / slug
        html = p.read_text(encoding='utf-8')
        if '<!-- STATE:START -->' not in html or '<!-- STATE:END -->' not in html:
            print('*** BUILD REFUSED: %s has lost its <!-- STATE:START/END --> markers, so the '
                  'state disclosure would silently stop rendering ***' % slug, file=_s2.stderr)
            _s2.exit(1)
        out = _re.sub(r'<!-- STATE:START -->.*?<!-- STATE:END -->',
                      lambda m: '<!-- STATE:START -->' + block + '<!-- STATE:END -->',
                      html, count=1, flags=_re.S)
        if out != html:
            p.write_text(out, encoding='utf-8')
        print('state block filled in', slug, len(block), 'bytes')


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
        'Collections agencies publish 20 to 50% for the same work. We charge 15%, and only on dollars that land in your account.')
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
    # ★ DISCOVERED, NOT LISTED. This was a hardcoded twelve-name list, which is the exact
    # defect this file has already had twice: the loop that normalises the chrome had one,
    # it missed parley and setup for a day, and the "fix" of adding three names left two
    # more pages uncovered. A list you must remember to append to is a defect with a delay
    # on it. _CHROME is every page at the root carrying the shared footer, which is the
    # property that actually defines "a public page of this site".
    PAGES = list(_CHROME)

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

_standalone_state()
_guard()


# ── THE TEXTING TRUTH GUARD ───────────────────────────────────────────────────
# THE DEFECT THIS EXISTS TO STOP. On 2026-08-14 nine sentences across these
# pages told a reader that a text message would arrive. No function in this repo
# sends an SMS to a customer and the A2P campaign has been rejected three times,
# so every one of those sentences was false, and the ones on /pricing were
# inside a price card that this same file copies onto three more pages. One
# wrong sentence, six wrong surfaces.
#
# THE PROGRAM ITSELF IS NOT THE DEFECT AND MUST NOT BE SCRUBBED. The consent
# language on /terms#texting and /privacy#texting is what a carrier reviews, it
# is correct, and deleting it would make the next campaign submission weaker,
# not stronger. So this gate does not ban the word. It bans a DELIVERY PROMISE
# that is not standing next to its status, which is a different thing and is the
# thing that was actually wrong.
#
# IT IS SCOPED SO IT CANNOT OVER-REPORT. A check that cries wolf gets ignored on
# the day it is right. Every hit is exempt if a status sentence sits within
# _SMS_WINDOW characters of it, and the gate proves itself on a known-bad and a
# known-good string before it is allowed to report a clean run.
# ★ THE DELIVERY RULES WERE RETIRED 2026-08-17, ON MEASUREMENT. Texting is live: the A2P campaign
# reads VERIFIED with campaign_id C1D7R7P and real per-carrier rate limits, and two messages were
# DELIVERED to a real handset on a carrier we do not control. The same handset took four undelivered
# sends earlier the same day (30034, 30032), so it is a controlled before-and-after on one circuit.
# "It texts you the transcript" is now simply true, and a guard that keeps calling a true sentence a
# violation trains the next reader to ignore the whole gate.
#
# ★ THE CHANNEL RULES STAY, AND "reply VOID" IS THE REASON. Outbound going live did not make the
# INBOUND side real. Measured on production: POST /api/sms-inbound with Body=VOID returns an empty
# <Response></Response>, and `void` appears nowhere in sms-inbound.mjs. STOP and HELP do work - our
# handler records the stop into the same stop/<hash> key the call path reads, and Twilio's Advanced
# Opt-Out sends the customer-facing reply at the platform level, which is why all three return empty
# TwiML and only STOP has an effect. So a page saying "Reply VOID and it comes off" still names a
# channel that cannot receive, and the honest wording the generated pages already use is
# "One word, VOID, and it comes off."
#
# WHEN VOID IS IMPLEMENTED in sms-inbound.mjs, delete the last rule here and not before.
_SMS_BANNED = [
    (r'\btext and transcript\b',  'channel',  'names SMS as the channel'),
    (r'\breply\s+VOID\b',         'channel',  'names a reply channel that cannot receive'),
]
# DELIBERATELY NOT BANNED: a bare "by text" or "in a text". Both fired on
# parley.html's "Settle the price by text", where the two HUMANS text each other
# from their own phones and this company sends nothing at all, which is true and
# is the whole reason Parley is unblocked by the carrier problem. Catching a
# real defect is worth nothing if the same rule brands three true sentences,
# because the next reader discounts all of it. Both real instances of those two
# phrasings were fixed at the source in TRUST above.
# any one of these within the window makes the sentence honest rather than false
_SMS_OK = ['not switched on', 'until texting clears', 'while texting is off',
           'not approved by the carrier', 'arrives by email', 'comes by email',
           'by email instead', 'reaches you by email',
           # Added 2026-08-16. The opt-in block on /pricing is the page BOTH carrier filings
           # cite as consent evidence, and "texting is not switched on yet" reads to a reviewer
           # as "there is no messaging program here" - which is the thing 30908 [MESSAGE_FLOW]
           # keeps naming. "Carrier registration is in progress" is equally true and is the
           # compliant order of operations. It is a status label, not a delivery promise, so it
           # belongs in this list for the same reason every other entry does.
           'carrier registration', 'registration is in progress']
_SMS_WINDOW = 900


def _sms_hits(text):
    """Every unlabelled delivery promise in one flattened page. Returns
    (pattern, category, why, excerpt) so a finding can be read without opening
    the file, and so the categories can be counted separately."""
    import re as _re
    out = []
    low = text.lower()
    for pat, cat, why in _SMS_BANNED:
        for m in _re.finditer(pat, text, _re.I):
            a = max(0, m.start() - _SMS_WINDOW)
            b = min(len(text), m.end() + _SMS_WINDOW)
            if any(tok in low[a:b] for tok in _SMS_OK):
                continue
            out.append((pat, cat, why, text[max(0, m.start() - 90):m.end() + 90].strip()))
    return out


def _texting_guard():
    import re as _re

    # ── POSITIVE CONTROL, RUN FIRST ──────────────────────────────────────────
    # A gate that reports zero is only worth something if it has just been shown
    # to be capable of reporting one. Both directions are checked, because a
    # matcher that fires on everything is as useless as one that fires on
    # nothing: this estate has shipped both.
    bad = 'It texts you the transcript inside a minute and you reply VOID to any charge.'
    # ★ THE NEGATIVE CONTROL IS THE SENTENCE THAT ACTUALLY SHIPS, not a paraphrase of it.
    # A control written in wording nobody deploys proves the guard tolerates that wording and
    # nothing else. This is the live /pricing opt-in status line, verbatim, so if a future edit
    # to _SMS_OK stops accepting the real page, the build refuses here rather than on the page.
    good = ('Carrier registration is in progress, so until it completes what you ask for '
            'arrives by email. When it completes it texts you the transcript inside a minute.')
    # The older phrasing stays covered too, because /terms and several bands still use it.
    good_legacy = ('Texting is not switched on yet, so what you ask for arrives by email. '
                   'When it clears it texts you the transcript inside a minute.')
    if _sms_hits(good_legacy):
        print('*** BUILD REFUSED: the texting guard fired on the legacy status wording, which is '
              'still live on /terms and in the band copy. ***', file=_sys.stderr)
        _sys.exit(1)
    if not _sms_hits(bad):
        print('*** BUILD REFUSED: the texting guard failed its own positive control. It did not '
              'fire on a known-false sentence, so its clean result on the real pages means '
              'nothing. ***', file=_sys.stderr)
        _sys.exit(1)
    if _sms_hits(good):
        print('*** BUILD REFUSED: the texting guard failed its negative control. It fired on a '
              'sentence that IS labelled with its status, so it would bury its real findings '
              'under false ones. ***', file=_sys.stderr)
        _sys.exit(1)

    # ── WHOSE PAGE IS IT ─────────────────────────────────────────────────────
    # This gate was written on a repo with several lanes in it at once. Failing
    # the shared build over a sentence in a file somebody else is mid-edit on
    # does not fix that sentence, it just makes the next lane delete the gate.
    # So: REFUSE on the pages the generator owns, and REPORT, loudly and by
    # name, on the hand-written ones. Move a page into OWNED the day its lane
    # lands and the report becomes a refusal with no other change.
    OWNED = ['recover.html', 'pricing.html', 'trust.html', 'thanks.html',
             'terms.html', 'privacy.html', 'recording.html',
             # added 2026-08-16 with the pages themselves, so they are a refusal from
             # birth rather than a report that somebody has to remember to promote.
             'about.html', 'contact.html']
    # ★ DERIVED. Everything on the site that is not owned is reported on, and a page added
    # next week is covered the day it is added, by nobody. The old literal list silently
    # excluded any new page from the texting guard entirely, which is worse than either
    # bucket: not owned, not reported, just invisible.
    OTHERS = [p for p in _CHROME if p not in OWNED]
    findings, reports = [], []
    for pg in OWNED + OTHERS:
        f = ROOT / pg
        if not f.exists():
            continue
        t = _re.sub(r'<[^>]+>', ' ', f.read_text(encoding='utf-8'))
        t = _re.sub(r'\s+', ' ', t)
        for pat, cat, why, ex in _sms_hits(t):
            (findings if pg in OWNED else reports).append((cat, pg, why, ex))
    PAGES = OWNED + OTHERS

    if reports:
        cs = {}
        for c, _p, _w, _e in reports:
            cs[c] = cs.get(c, 0) + 1
        print('\n  ┌─ TEXTING TRUTH: %d finding(s) in pages this lane does not own ─────────'
              % len(reports), file=_sys.stderr)
        print('  │ %s. Not fatal, because another lane is mid-edit on these files.'
              % ', '.join('%s=%d' % kv for kv in sorted(cs.items())), file=_sys.stderr)
        for c, pg, w, ex in reports:
            print('  │ [%s] %s: %s' % (c, pg, w), file=_sys.stderr)
            print('  │     ...%s...' % ex[:150], file=_sys.stderr)
        print('  │ FIX: "Reply VOID" names a channel that cannot receive while A2P is',
              file=_sys.stderr)
        print('  │ rejected. The generated pages now read "One word, VOID, and it comes',
              file=_sys.stderr)
        print('  │ off." Copy that wording and this goes quiet.', file=_sys.stderr)
        print('  └────────────────────────────────────────────────────────────────────────\n',
              file=_sys.stderr)

    # ── THE DISCLOSURE MUST ACTUALLY BE ON THE PAGE ──────────────────────────
    # Rendering it is not the same as it surviving to the file. A block that
    # silently stops emitting is the worst outcome available here, because every
    # sentence it was covering keeps shipping and nobody downstream knows.
    _TABLE = 'id="state-billing"'   # only state_table() can emit this
    must_carry = {'pricing.html': _TABLE, 'trust.html': _TABLE, 'terms.html': _TABLE,
                  'recover.html': 'Stated ' + STATE_DATE, 'thanks.html': 'Stated ' + STATE_DATE,
                  'privacy.html': 'Stated ' + STATE_DATE, 'recording.html': 'Stated ' + STATE_DATE}
    for pg, needle in must_carry.items():
        f = ROOT / pg
        if f.exists() and needle not in f.read_text(encoding='utf-8'):
            findings.append(('missing-disclosure', pg,
                             'the state disclosure did not reach this page', needle))

    if findings:
        cats = {}
        for c, _pg, _w, _e in findings:
            cats[c] = cats.get(c, 0) + 1
        print('\n*** BUILD REFUSED: a page promises something the product cannot do ***',
              file=_sys.stderr)
        print('  %d finding(s): %s' % (len(findings),
              ', '.join('%s=%d' % kv for kv in sorted(cats.items()))), file=_sys.stderr)
        for c, pg, w, ex in findings:
            print('  - [%s] %s: %s -> ...%s...' % (c, pg, w, ex[:170]), file=_sys.stderr)
        _sys.exit(1)
    print('texting guard: 0 unlabelled delivery promises across %d pages, disclosure present on %d'
          % (len(PAGES), len(must_carry)))

_texting_guard()


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
    # ★ DISCOVERED, AND THE PATTERN IS BUILT FROM THE SAME SET. Two hardcoded lists in one
    # function is two chances to drift: a page could be in the loop but absent from the
    # alternation, so its own links were rewritten and links TO it were not, silently.
    pages = list(_CHROME)
    slugs = sorted((n[:-5] for n in pages), key=len, reverse=True)
    pat = _re.compile(r'href="/(' + '|'.join(_re.escape(s) for s in slugs)
                      + r')\.html([?#][^"]*)?"')
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

# ── sitemap ──────────────────────────────────────────────────────────────────
# Measured 2026-08-14: /sitemap.xml was a 404. Generated from _CHROME, the same
# discovered set the canonical tags come from, so the sitemap and the site can
# never disagree about which pages exist. A hand-kept list would drift the first
# time somebody added a page, which is the defect this file has already had twice.
_sitemap_urls = ['https://answered.reddenda.com' + ('/' if n == 'index.html' else '/' + n[:-5])
                 for n in _CHROME]
(ROOT / 'sitemap.xml').write_text(
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + ''.join(f'  <url><loc>{u}</loc></url>\n' for u in sorted(_sitemap_urls))
    + '</urlset>\n', encoding='utf-8')
print(f'sitemap: {len(_sitemap_urls)} urls, generated from the discovered page set')



# ── ASSET VERSIONING ──────────────────────────────────────────────────────────
# /assets/* ships with a one-year immutable cache header, and answered.css /
# answered.js live at fixed names, so a returning visitor kept STALE styles and
# scripts for up to a year after every deploy (measured live 2026-08-13: a
# browser that had ever loaded the old CSS computed the dead serif on the new
# page). Every reference now carries ?v=<content-hash>; new HTML can never pair
# with old assets again. The build FAILS if an unversioned reference survives.
def _asset_version():
    import re as _re, hashlib as _hl
    # ★ DISCOVERED. A page missing from this list shipped an UNVERSIONED asset reference and
    # the refusal below never ran on it, so the one guard that exists to catch a stale-cache
    # defect was blind on exactly the pages nobody had remembered.
    pages = list(_CHROME)
    vers = {}
    for a in ('answered.css', 'answered.js'):
        f = ROOT / 'assets' / a
        vers[a] = _hl.md5(f.read_bytes()).hexdigest()[:8]
    n = 0
    for pg in pages:
        p = ROOT / pg
        s = p.read_text(encoding='utf-8')
        out = s
        for a, v in vers.items():
            out = _re.sub(r'/assets/' + _re.escape(a) + r'(\?v=[0-9a-f]*)?', '/assets/%s?v=%s' % (a, v), out)
        if out != s:
            p.write_text(out, encoding='utf-8')
            n += 1
        for a in vers:
            if _re.search(r'/assets/' + _re.escape(a) + r'(?!\?v=[0-9a-f]{8})', out):
                print('*** BUILD REFUSED: unversioned %s reference in %s ***' % (a, pg), file=_sys.stderr)
                _sys.exit(1)
    print('asset versioning: css=%s js=%s stamped across %d pages' % (vers['answered.css'], vers['answered.js'], n))

_asset_version()
