import { chromium } from '/Users/user/reimburseos-v3-build/node_modules/playwright/index.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8908';
// thanks.html was excluded from this list for six deploys and carried a real
// defect the whole time. Every page that ships is swept, linked from a menu or not.
const PAGES = ['/', '/trades.html', '/hold.html', '/recover.html', '/pricing.html', '/trust.html', '/thanks.html'];
const SIZES = [[320, 720], [390, 844], [768, 1024], [1440, 900], [1920, 1080]];

// This machine's resolver intermittently fails on the custom domain while every
// public resolver and the authoritative nameserver return the record. Pinning
// the host still exercises the real domain, the real SNI and the real
// certificate; only the lookup is bypassed.
const args = ['--autoplay-policy=no-user-gesture-required'];
if (process.env.PIN_HOST) args.push('--host-resolver-rules=MAP ' + process.env.PIN_HOST);
const browser = await chromium.launch({ channel: 'chrome', args });
let fails = 0;

for (const path of PAGES) {
  for (const [w, h] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
    page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 160)));

    // 'networkidle' waits on a webfont request that does not always settle, and a
    // timeout there reads exactly like a broken page. 'load' plus an explicit font
    // wait is both faster and honest about what it is waiting for.
    let resp = null;
    for (let attempt = 0; attempt < 2 && !resp; attempt++) {
      try { resp = await page.goto(BASE + path, { waitUntil: 'load', timeout: 25000 }); }
      catch (e) { if (attempt === 1) throw e; }
    }
    try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch (e) {}
    await page.waitForTimeout(700);
    // scroll the whole page so every IntersectionObserver actually fires
    await page.evaluate(async () => {
      // scroll-behavior:smooth turns every scrollTo into an animation, and
      // successive calls cancel each other, so a stepped probe barely moves.
      document.documentElement.style.scrollBehavior = 'auto';
      const step = Math.round(window.innerHeight * 0.8);
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 90));
      }
      // land on the very bottom and hold there before returning, or the last
      // observers on a very tall page never get a frame to fire in and report
      // as stuck on a page where they all work.
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((r) => setTimeout(r, 450));
      window.scrollTo(0, 0);
    });
    // The settle has to scale with the document. A fixed 500ms passed on every
    // page except the tallest one at the narrowest width, where the last reveals
    // had not finished their 800ms transition when the check ran, and reported
    // 9 stuck elements on a page where all of them fire.
    const docH = await page.evaluate(() => document.body.scrollHeight);
    await page.waitForTimeout(Math.min(4200, 800 + docH / 10));

    // horizontal scroll: scrollWidth lies, so actually try to scroll and read back
    const overflow = await page.evaluate(() => {
      window.scrollTo(9999, 0);
      const x = window.scrollX;
      window.scrollTo(0, 0);
      return x;
    });

    // find any element wider than the viewport
    const wide = await page.evaluate((vw) => {
      const out = [];
      document.querySelectorAll('body *').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > vw + 1 && r.height > 0) {
          out.push(el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0, 2).join('.') : '') + ' w=' + Math.round(r.width));
        }
      });
      return out.slice(0, 4);
    }, w);

    // any element still invisible after the full scroll = a permanently blank block
    const stuck = await page.evaluate(() => {
      let n = 0;
      document.querySelectorAll('.rv').forEach((el) => {
        if (parseFloat(getComputedStyle(el).opacity) < 0.9) n++;
      });
      return n;
    });

    const bad = resp.status() !== 200 || overflow !== 0 || errs.length > 0 || stuck > 0;
    if (bad) fails++;
    console.log(
      `${bad ? 'FAIL' : ' ok '} ${path.padEnd(13)} ${String(w).padStart(4)}x${h}  ` +
      `status=${resp.status()} scrollX=${overflow} console=${errs.length} stuckReveals=${stuck}` +
      (wide.length ? ` WIDE:${wide.join(' | ')}` : '') +
      (errs.length ? ` ERR:${errs.slice(0, 2).join(' ~ ')}` : '')
    );

    if (w === 390 || w === 1440) {
      // 1x, not 2x. a full-page shot of a 15,000px document at deviceScaleFactor 2
      // allocates a 30,000px surface, and six of those in a row exhausted the
      // browser and killed two sweeps mid-run.
      const name = `_shots/${path.replace(/[\/.]/g, '_') || 'home'}_${w}.jpeg`;
      await page.screenshot({ path: name, fullPage: true, quality: 70, type: 'jpeg' });
    }
    await ctx.close();
  }
}

// contrast audit on the real computed values, on the real grounds
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
const contrast = await page.evaluate(() => {
  const lum = (c) => {
    const [r, g, b] = c;
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const parse = (s) => (s.match(/[\d.]+/g) || []).map(Number);
  const groundOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const bg = parse(getComputedStyle(n).backgroundColor);
      if (bg.length >= 3 && (bg[3] === undefined || bg[3] > 0.9)) return bg;
      n = n.parentElement;
    }
    return [15, 13, 11];
  };
  const flat = (fg, bg) => {
    const a = fg[3] === undefined ? 1 : fg[3];
    return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
  };
  const out = [];
  document.querySelectorAll('.src, .small, .band-k, .card p, .lede, .ledger-row, .receipt-foot, .foot a, .nav-links a').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const bg = groundOf(el);
    const fg = flat(parse(getComputedStyle(el).color), bg);
    const L1 = lum(fg), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(getComputedStyle(el).fontSize);
    const need = size >= 24 ? 3 : 4.5;
    if (ratio < need) out.push(`${el.className.split(' ')[0] || el.tagName} ${size}px ratio=${ratio.toFixed(2)} need=${need}`);
  });
  return [...new Set(out)];
});
console.log(contrast.length ? 'CONTRAST FAILURES:\n  ' + contrast.join('\n  ') : 'contrast: all sampled text clears AA on its own ground');
if (contrast.length) fails++;

await browser.close();
console.log(fails ? `\n${fails} FAILING CHECK GROUPS` : '\nALL CHECKS PASS');
process.exit(0);
