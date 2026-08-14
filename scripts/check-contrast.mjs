#!/usr/bin/env node
// check-contrast.mjs — measure the contrast of what the browser ACTUALLY PAINTED.
//
//   BASE=http://localhost:8931 CRED=/path/to/pw node scripts/check-contrast.mjs [selector]
//
// ── WHY THIS IS A FILE AND NOT A ONE-LINER ───────────────────────────────────────────────────
// I have now written this measurement three times inline and got it wrong twice, in two different
// ways, and BOTH times the wrong version invented failures rather than missing them:
//
//   1. It read `rgba(227,255,79,.10)` as a SOLID lime ground and reported 1.05:1 on white text
//      that is actually sitting on near-black. A checker that ignores alpha does not measure a
//      page, it measures a stylesheet.
//   2. It started the ground search at the element's PARENT, so any element painting its own
//      background — a pill, a badge, a channel glyph — was compared against the ground behind it
//      instead of the one under its own text. That reported 1.01:1 on a lime chip with black
//      letters, which is 17.5:1 in reality.
//
// An instrument that cries wolf gets muted, and a muted instrument is worse than none: the estate
// already has a card about a check whose over-reporting destroyed trust in its real findings. So
// this composites alpha down the stack, starts at the element itself, and carries a POSITIVE
// CONTROL: it asserts a known-good and a known-bad pairing before it reports anything at all.

import fs from 'node:fs';
import { chromium } from '/Users/user/.t6-verify/node_modules/playwright/index.mjs';

const BASE = process.env.BASE || 'http://localhost:8931';
const SCOPE = process.argv[2] || 'body';

const MEASURE = (scope) => {
  const lum = (x) => {
    const [r,g,b] = x.map(v => { v/=255; return v <= .03928 ? v/12.92 : Math.pow((v+.055)/1.055, 2.4); });
    return .2126*r + .7152*g + .0722*b;
  };
  const parse = (s) => {
    const m = String(s).match(/rgba?\(([^)]+)\)/); if (!m) return null;
    const p = m[1].split(',').map(parseFloat);
    return p.length >= 4 ? { c: p.slice(0,3), a: p[3] } : { c: p.slice(0,3), a: 1 };
  };
  const over = (fg, bg, a) => fg.map((v,i) => v*a + bg[i]*(1-a));
  const ratio = (a, b) => { const L1 = lum(a), L2 = lum(b);
    return (Math.max(L1,L2) + .05) / (Math.min(L1,L2) + .05); };

  // Start at the element ITSELF: a pill paints its own ground and its text sits on that, not on
  // whatever is behind the pill. Then composite every translucent layer down to the page.
  const groundOf = (el) => {
    const stack = []; let n = el;
    while (n && n !== document.documentElement) {
      const q = parse(getComputedStyle(n).backgroundColor);
      if (q && q.a > 0) stack.push(q);
      if (q && q.a >= 1) break;
      n = n.parentElement;
    }
    let ground = [8,9,11];
    for (let i = stack.length - 1; i >= 0; i--) ground = over(stack[i].c, ground, stack[i].a);
    return ground;
  };

  // POSITIVE CONTROL. If these two do not come out right, every number below is noise and the run
  // must be discarded rather than reported.
  const control = {
    good: +ratio([245,247,250], [8,9,11]).toFixed(2),   // --ink on --bg, expect ~18.6
    bad:  +ratio([130,130,130], [120,120,120]).toFixed(2), // near-identical greys, expect ~1.1
  };

  const rows = [];
  for (const el of document.querySelectorAll(scope + ' *')) {
    const text = (el.textContent || '').trim();
    if (!text || el.children.length) continue;               // leaf text nodes only
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (parseFloat(cs.opacity) < 0.3) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const f = parse(cs.color); if (!f) continue;
    const g = groundOf(el);
    const fg = f.a < 1 ? over(f.c, g, f.a) : f.c;
    const px = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight, 10) >= 700;
    // WCAG 1.4.3: large text is 24px, or 18.66px when bold. 1.4.11 exempts inactive components.
    const need = (px >= 24 || (px >= 18.66 && bold)) ? 3 : 4.5;
    const disabled = el.closest('[disabled],[aria-disabled="true"]') != null;
    rows.push({ r: +ratio(fg, g).toFixed(2), need, px,
                cls: String(el.className || '').split(' ')[0],
                disabled, text: text.slice(0, 38) });
  }
  rows.sort((a,b) => a.r - b.r);
  return { control, rows };
};

const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await (await b.newContext({ viewport: { width: 1600, height: 1200 } })).newPage();
await p.goto(BASE + '/admin');
if (process.env.CRED) {
  await p.fill('#email', 'david@reddenda.com');
  await p.fill('#password', fs.readFileSync(process.env.CRED, 'utf8').trim());
  await p.click('button[type=submit]');
  await p.waitForSelector('.shell');
  await p.waitForTimeout(3500);
}

const views = (process.env.VIEWS || 'cockpit,crm,overview,billing,compliance,system').split(',');
let worstOverall = null, totalFail = 0, totalRows = 0;

for (const v of views) {
  await p.click('.nav[data-view="' + v + '"]').catch(() => {});
  await p.waitForTimeout(2200);
  const { control, rows } = await p.evaluate(MEASURE, SCOPE);

  if (control.good < 15 || control.bad > 2) {
    console.error(`INSTRUMENT FAILED ITS OWN CONTROL on ${v}: good=${control.good} bad=${control.bad}`);
    console.error('Discarding this run rather than reporting numbers from a broken checker.');
    process.exit(2);
  }
  // Disabled controls are exempt under 1.4.3 and are reported separately rather than silently.
  const live = rows.filter((x) => !x.disabled);
  const fails = live.filter((x) => x.r < x.need);
  totalFail += fails.length; totalRows += live.length;
  const w = live[0];
  if (!worstOverall || (w && w.r < worstOverall.r)) worstOverall = { ...w, view: v };

  console.log(`${v.padEnd(11)} ${String(live.length).padStart(4)} strings · lowest ${String(w ? w.r : 'n/a').padStart(6)}:1` +
    (fails.length ? `  ${fails.length} FAIL` : '  all pass') +
    (rows.length - live.length ? `  (${rows.length - live.length} disabled, exempt)` : ''));
  for (const f of fails.slice(0, 5)) {
    console.log(`    ${String(f.r).padStart(6)}:1 needs ${f.need}  ${f.px}px  .${f.cls}  "${f.text}"`);
  }
}
await b.close();

console.log(`\n${totalRows} live strings measured across ${views.length} views.`);
if (worstOverall) console.log(`lowest anywhere: ${worstOverall.r}:1 on .${worstOverall.cls} in ${worstOverall.view}`);
if (totalFail) { console.log(`${totalFail} FAILURES`); process.exit(1); }
console.log('every live string passes WCAG AA');
