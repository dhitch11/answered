// consent-visible.test.mjs — the opt-in mechanism and every required SMS
// disclosure must be VISIBLE to a reader that loads the page and does not scroll.
//
//   node research/consent-visible.test.mjs                    # against live prod
//   BASE=http://127.0.0.1:8908 node research/consent-visible.test.mjs   # against a local build
//
// WHY THIS FILE EXISTS, measured on live production 2026-08-16.
// Every opt-in form on this site shipped as `class="iform rv d2"`, and
// `html.js .rv { opacity: 0 }` until an IntersectionObserver fires. So on
// /pricing, the URL filed as the A2P campaign's MESSAGE_FLOW evidence, a reader
// that loaded the page and did not scroll saw NONE of the required disclosures.
// The <form> computed opacity 0 while the <p> inside it computed 1, which is
// exactly why it survived every check anyone had run: grep found the words,
// element-level style checks read the <p>, and every human scrolled.
//
// Twilio: "The URL provided undergoes an automated verification process. A
// screenshot is captured and is evaluated against the A2P 10DLC compliance
// rules." Error 30908 named MESSAGE_FLOW on two consecutive rejections.
//
// `_build.py` now refuses to ship a reveal around a form or a disclosure, and
// that static guard is positive-controlled. But a static check cannot see the
// cascade, and this defect lived in the cascade. This is the instrument that
// can. Run it after any change to the motion system, the CSS, or /pricing.

import { chromium } from '/Users/user/reimburseos-v3-build/node_modules/playwright/index.mjs';

const BASE = process.env.BASE || 'https://answered.reddenda.com';

// The five elements TCR names for a website opt-in flow, plus the sender.
const REQUIRED = [
  'Adding your number opts you into',   // the consent statement itself
  '282-5278',                           // the sender, named at the point of consent
  'Fewer than five a month',            // frequency
  'Message and data rates may apply',   // cost
  'Reply STOP',                         // opt out
  'HELP for help',                      // help
];

// Everything a reviewer must be able to match to the registered brand.
const IDENTITY = {
  '/privacy': ['TWINFLAME INVESTMENTS LLC', 'Cheyenne, WY 82001',
               'never share your mobile phone number', 'Message and data rates may apply', 'Reply STOP'],
  '/terms':   ['TWINFLAME INVESTMENTS LLC', 'Cheyenne, WY 82001', 'Reply STOP', 'How you join'],
  '/about':   ['TWINFLAME INVESTMENTS LLC', 'Cheyenne, WY 82001', 'Reply STOP', '282-5278'],
  '/contact': ['TWINFLAME INVESTMENTS LLC', 'Cheyenne, WY 82001', 'info@reddenda.com'],
};

// Runs in the page. Walks TEXT NODES, then walks each one's ANCESTORS, because
// the element carrying the words is never the one that hides them.
const PROBE = (needles) => {
  const hidden = (el) => {
    let e = el;
    while (e && e.nodeType === 1) {
      const cs = getComputedStyle(e);
      if (cs.opacity === '0' || cs.visibility === 'hidden' || cs.display === 'none') return true;
      if (e === document.body) break;
      e = e.parentElement;
    }
    return false;
  };
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n; (n = w.nextNode());) {
    const t = n.parentElement && n.parentElement.tagName;
    if (t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT' || t === 'TEMPLATE') continue;
    if (n.nodeValue.trim()) nodes.push(n);
  }
  return needles.map((nd) => {
    const hits = nodes.filter((n) => {
      const box = n.parentElement.closest('p,li,div,span,h1,h2,h3,td,a,label') || n.parentElement;
      return box.innerText && box.innerText.includes(nd);
    });
    return [nd, hits.length, hits.length > 0 && hits.some((n) => !hidden(n.parentElement))];
  });
};

const browser = await chromium.launch({ channel: 'chrome' });
let fails = 0;

const open = async (path) => {
  const pg = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await pg.goto(BASE + path, { waitUntil: 'networkidle' });
  await pg.waitForTimeout(1100);          // let the observer do whatever it is going to do
  return pg;
};

console.log(`consent visibility, no scrolling, against ${BASE}\n`);

{
  const pg = await open('/pricing');
  const formVisible = await pg.evaluate(() => {
    const f = document.querySelector('form.iform[name="interest"]') || document.querySelector('form.iform');
    if (!f) return null;
    let e = f;
    while (e && e.nodeType === 1) {
      const cs = getComputedStyle(e);
      if (cs.opacity === '0' || cs.visibility === 'hidden' || cs.display === 'none') return false;
      if (e === document.body) break;
      e = e.parentElement;
    }
    return true;
  });
  if (formVisible !== true) { fails++; console.log(`FAIL  /pricing  the opt-in form is not visible on load (${formVisible})`); }
  else console.log('  OK  /pricing  the opt-in form is visible on load');
  for (const [n, c, v] of await pg.evaluate(PROBE, REQUIRED)) {
    if (!v) fails++;
    console.log(`${v ? '  OK' : 'FAIL'}  /pricing  n=${c} "${n}"`);
  }
  await pg.close();
}

for (const [path, needles] of Object.entries(IDENTITY)) {
  const pg = await open(path);
  for (const [n, c, v] of await pg.evaluate(PROBE, needles)) {
    if (!v) fails++;
    console.log(`${v ? '  OK' : 'FAIL'}  ${path.padEnd(9)} n=${c} "${n}"`);
  }
  await pg.close();
}

// ── POSITIVE CONTROL ────────────────────────────────────────────────────────
// A paragraph on /terms that is deliberately still a reveal and sits below the
// fold. If this instrument cannot read THAT as invisible, every OK above is
// meaningless and this run proves nothing. A test that cannot fail is not a test.
{
  const pg = await open('/terms');
  const [[, count, visible]] = await pg.evaluate(PROBE, ['A job is booked when it has a name']);
  const ok = count > 0 && visible === false;
  console.log(`\nPOSITIVE CONTROL  found=${count} visible=${visible}  ->  ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) {
    fails++;
    console.log('  The instrument never reports invisible. Discard every result above.');
  }
  await pg.close();
}

await browser.close();
console.log(fails === 0
  ? '\nPASS: a reader that never scrolls sees the opt-in form, all six SMS disclosures, and the registered entity on all four policy surfaces.'
  : `\nFAIL: ${fails} check(s). This is A2P error 30908 waiting to happen.`);
process.exit(fails === 0 ? 0 : 1);
