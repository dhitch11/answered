#!/usr/bin/env node
// _og-render.mjs — renders the og:image brand cards for every page.
//
// BRAND CARDS ONLY. Locked law: no receipt cards, no fabricated outcomes, no
// numbers that claim a result happened. Each card is the LIVEWIRE identity:
// Obsidian ground, the 3px HI-VIS hairline, the ANSWERED wordmark (the same
// inline D-mark the nav brand uses), and one Halogen line.
//
// Run:  node _og-render.mjs
// Playwright is borrowed from the estate install at reimburseos-v3-build via
// createRequire, because this repo deliberately has no node_modules.
//
// Output: assets/og/<page>.png, exactly 1200x630 at deviceScaleFactor 1.
// thanks.html reuses home.png, so no thanks card is rendered here.

import { createRequire } from 'node:module';
import { mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PW_HOST = '/Users/user/reimburseos-v3-build/package.json';
const require = createRequire(PW_HOST);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  console.error(`REFUSED: playwright not resolvable from ${PW_HOST}: ${e.message}`);
  process.exit(1);
}

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'assets', 'og');
mkdirSync(OUT, { recursive: true });

// The D-mark, copied from the nav brand in index.html, with the CSS var
// resolved to the literal HI-VIS hex because this document has no stylesheet.
const MARK = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
<rect x="4" y="5" width="5.4" height="22" rx="2.4" fill="#E3FF4F"/>
<path d="M 12 7.6 A 8.6 8.6 0 0 1 12 24.4" fill="none" stroke="#E3FF4F" stroke-width="5.4" stroke-linecap="round"/>
<path d="M 20.4 10.2 A 11.4 11.4 0 0 1 20.4 21.8" fill="none" stroke="#E3FF4F" stroke-width="3" stroke-linecap="round"/>
<path d="M 25.2 6.9 A 15.6 15.6 0 0 1 25.2 25.1" fill="none" stroke="#E3FF4F" stroke-width="2.1" stroke-linecap="round"/>
</svg>`;

// One Halogen line per page. These are offers and descriptions, never outcomes.
const CARDS = [
  { name: 'home',    line: 'It answers. It calls. It collects. You pay when it works.', size: 72 },
  { name: 'trades',  line: 'Every call answered. $19 when it books you a job.',         size: 78 },
  { name: 'hold',    line: 'We wait on hold. You get the human.',                       size: 92 },
  { name: 'recover', line: 'You already earned it. Somebody should ask for it.',        size: 78 },
  // the non-breaking hyphen + explicit break keep "per-minute price" on one
  // line; text-wrap:balance otherwise snaps the phrase in half at the hyphen
  { name: 'pricing', line: 'No subscription. No&nbsp;per&#8209;minute price.<br>Pay when it works.', size: 72 },
  { name: 'trust',   line: 'Built to be believed.',                                     size: 110 },
];

const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Instrument+Sans:ital,wght@0,400..700;1,400..700&family=Instrument+Serif:ital@0;1&family=IBM+Plex+Mono:wght@400;500&display=swap';

function cardHTML({ line, size }) {
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${FONT_CSS}" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 630px; overflow: hidden; }
  body {
    background: #0B0C0E; /* Obsidian */
    display: flex; flex-direction: column;
    border-top: 3px solid #E3FF4F; /* the HI-VIS hairline */
    padding: 61px 72px 56px; /* 64 visual top minus the 3px hairline */
    -webkit-font-smoothing: antialiased;
  }
  .brand { display: flex; align-items: center; gap: 15px; }
  .mark { width: 46px; height: 46px; flex: 0 0 auto; }
  .word {
    font-family: 'Instrument Sans', sans-serif; font-weight: 800;
    font-size: 27px; letter-spacing: .045em; color: #F2F4F0;
  }
  .line {
    font-family: 'Instrument Serif', serif; font-weight: 400;
    font-size: ${size}px; line-height: 1.04; letter-spacing: -0.018em;
    color: #F2F4F0; /* Halogen, the one line */
    max-width: 1020px; margin: auto 0; text-wrap: balance;
  }
  .foot {
    font-family: 'IBM Plex Mono', monospace; font-weight: 500;
    font-size: 17px; letter-spacing: .18em; text-transform: uppercase;
    color: #8B939C;
  }
</style></head><body>
<div class="brand">${MARK}<span class="word">ANSWERED</span></div>
<div class="line">${line}</div>
<div class="foot">answered.reddenda.com</div>
</body></html>`;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 1,
});

const failures = [];
for (const card of CARDS) {
  await page.setContent(cardHTML(card), { waitUntil: 'networkidle' });

  // The site fonts must actually render in the capture. fonts.ready resolves
  // even when a font FAILED to load, so check each family explicitly and fail
  // loud rather than shipping a system-font card.
  const fontsOk = await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('800 27px "Instrument Sans"'),
      document.fonts.load('400 72px "Instrument Serif"'),
      document.fonts.load('500 17px "IBM Plex Mono"'),
    ]);
    await document.fonts.ready;
    return {
      sans:  document.fonts.check('800 27px "Instrument Sans"'),
      serif: document.fonts.check('400 72px "Instrument Serif"'),
      mono:  document.fonts.check('500 17px "IBM Plex Mono"'),
    };
  });
  if (!fontsOk.sans || !fontsOk.serif || !fontsOk.mono) {
    failures.push(`${card.name}: fonts did not load ${JSON.stringify(fontsOk)}`);
    continue;
  }

  const file = path.join(OUT, `${card.name}.png`);
  await page.screenshot({ path: file, type: 'png' });
  const kb = statSync(file).size / 1024;
  if (kb > 300) failures.push(`${card.name}.png is ${kb.toFixed(0)}KB, over the 300KB budget`);
  console.log(`wrote ${file} (${kb.toFixed(1)}KB) fonts=${JSON.stringify(fontsOk)}`);
}

await browser.close();

if (failures.length) {
  console.error('\n*** OG RENDER REFUSED ***');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('og render: all cards written, fonts verified');
