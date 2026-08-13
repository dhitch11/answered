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
const MARK = `<svg class="mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
<rect x="3" y="2" width="5.2" height="20" rx="2.2" fill="#E3FF4F"/>
<path d="M 11.5 6.284 A 6.6 6.6 0 0 1 11.5 17.716" fill="none" stroke="#E3FF4F" stroke-width="4.8" stroke-linecap="round"/>
<path d="M 15.838 3.808 A 11.2 11.2 0 0 1 15.838 20.192" fill="none" stroke="#E3FF4F" stroke-width="3" stroke-linecap="round"/>
</svg>`;

// One Halogen line per page. These are offers and descriptions, never outcomes.
const CARDS = [
  { name: 'home',    line: 'It answers. It calls. It collects. You pay when it works.', size: 72 },
  { name: 'trades',  line: 'Every call answered. $19 when it books you a job.',         size: 78 },
  { name: 'hold',    line: 'We wait on hold. You get the human.',                       size: 84 },
  { name: 'recover', line: 'You already earned it. Somebody should ask for it.',        size: 78 },
  // the non-breaking hyphen + explicit break keep "per-minute price" on one
  // line; text-wrap:balance otherwise snaps the phrase in half at the hyphen
  { name: 'pricing', line: 'No subscription. No&nbsp;per&#8209;minute price.<br>Pay when it works.', size: 72 },
  { name: 'trust',   line: 'Built to be believed.',                                     size: 100 },
];

// Self-hosted faces inlined as data: URIs, because a setContent document has
// an about:blank origin and cannot fetch file:// resources.
import { readFileSync } from 'node:fs';
const F = (f) => 'data:font/woff2;base64,' + readFileSync(path.join(ROOT, 'assets', 'fonts', f)).toString('base64');

function cardHTML({ line, size }) {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  @font-face { font-family: 'Archivo'; font-weight: 700; font-stretch: 125%; src: url('${F('archivo-expanded-700.woff2')}') format('woff2'); }
  @font-face { font-family: 'Switzer'; font-weight: 700; src: url('${F('switzer-700.woff2')}') format('woff2'); }
  @font-face { font-family: 'Martian Mono'; font-weight: 400 600; src: url('${F('martian-mono-400-600.woff2')}') format('woff2'); }
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
    font-family: 'Switzer', sans-serif; font-weight: 700;
    font-size: 27px; letter-spacing: .06em; color: #F2F4F0;
  }
  .line {
    font-family: 'Archivo', sans-serif; font-weight: 700; font-stretch: 125%;
    font-size: ${size}px; line-height: 0.98; letter-spacing: -0.02em;
    color: #F2F4F0; /* Halogen, the one line */
    max-width: 1020px; margin: auto 0; text-wrap: balance;
  }
  .foot {
    font-family: 'Martian Mono', monospace; font-weight: 500;
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
      document.fonts.load('700 27px "Switzer"'),
      document.fonts.load('700 72px "Archivo"'),
      document.fonts.load('500 17px "Martian Mono"'),
    ]);
    await document.fonts.ready;
    return {
      sans:  document.fonts.check('700 27px "Switzer"'),
      display: document.fonts.check('700 72px "Archivo"'),
      mono:  document.fonts.check('500 17px "Martian Mono"'),
    };
  });
  if (!fontsOk.sans || !fontsOk.display || !fontsOk.mono) {
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
