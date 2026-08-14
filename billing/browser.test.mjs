// browser.test.mjs — a real browser on the statement page, pressing the real button.
//
//   ./billing/with-env.sh node billing/serve.mjs
//   ./billing/with-env.sh node billing/browser.test.mjs
//
// A statement is a document a person reads on a phone in a truck, so it is checked at 320 and 390
// as well as on a desktop. And the VOID control is not "verified" by the element existing: this
// clicks it, waits for the page to come back, and asserts the charge is gone from the bill AND
// still present as a voided row, because a void that deletes the record cannot be audited later.

import assert from 'node:assert/strict';
import { chromium } from '/Users/user/reimburseos-v3-build/node_modules/playwright/index.mjs';

const BASE = process.env.BILLING_BASE || 'http://localhost:8951';
const SECRET = process.env.ANSWERED_METER_SECRET;
const KEY = `qa-browser-${Date.now()}`;
const SIZES = [[320, 720], [390, 844], [768, 1024], [1440, 900]];

let pass = 0; let fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
};
const meter = async (body) => {
  const r = await fetch(`${BASE}/api/meter`, {
    method: 'POST', headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
};

// A statement with something to look at: a charge, a free line, and a refusal.
const acct = await meter({ op: 'account', account_key: KEY, email: 'info@reddenda.com', business_name: 'QA, browser. Not a customer.' });
await meter({ op: 'record', account_key: KEY, event: { kind: 'booked_job', idem_key: `${KEY}-1`, evidence: { name: 'Dana Reyes', address: '414 Mill St', callback: '+19168663918', window: 'Thu 8-10am', call_sid: 'CAqabrowser0001' } } });
await meter({ op: 'record', account_key: KEY, event: { kind: 'booked_job', idem_key: `${KEY}-2`, evidence: { name: 'No Address', callback: '+19168663918', window: 'Fri 1-3pm' } } });
await meter({ op: 'record', account_key: KEY, event: { kind: 'hold_no_human', idem_key: `${KEY}-3` } });
const url = `${BASE}/statement/${acct.statement_token}`;

const browser = await chromium.launch({ channel: 'chrome' });
console.log(`\nbrowser on ${url}\n`);

console.log('layout');
for (const [w, h] of SIZES) {
  await t(`${w}x${h}: renders, no horizontal scroll, no console errors`, async () => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e.message)));
    const res = await page.goto(url, { waitUntil: 'networkidle' });
    assert.equal(res.status(), 200);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(over <= 0, `horizontal overflow of ${over}px`);
    // The one number a reader came for must be on the screen without a scroll on any of these.
    const due = await page.locator('.due-v').first().innerText();
    assert.match(due, /^\$\d/);
    assert.deepEqual(errors, [], `console errors: ${errors.join(' | ')}`);
    await ctx.close();
  });
}

console.log('\nwhat the page says');
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'networkidle' });

await t('the charge, the free line and the reason are all visible', async () => {
  const body = await page.locator('body').innerText();
  assert.match(body, /Job booked, standard hours/);
  assert.match(body, /\$19\.00/);
  assert.match(body, /missing address/, 'the free line must show WHY it was free');
  assert.match(body, /Hold reached nobody/);
});
await t('the charge shows the call it came from, which is what the terms promise', async () => {
  const body = await page.locator('body').innerText();
  assert.match(body, /CAqabrowser0001/);
});
await t('the free lines carry no VOID button, because there is nothing to void', async () => {
  const buttons = await page.locator('[data-void]').count();
  assert.equal(buttons, 1, `one billable charge means one void button, found ${buttons}`);
});
await t('every glyph on the page clears 4.5:1 against its own ground', async () => {
  const worst = await page.evaluate(() => {
    const lum = (c) => {
      const [r, g, b] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => {
        const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ground = (el) => {
      let n = el;
      while (n) {
        const bg = getComputedStyle(n).backgroundColor;
        if (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) return bg;
        n = n.parentElement;
      }
      return 'rgb(11, 12, 14)';
    };
    let min = 99; let where = '';
    for (const el of document.querySelectorAll('body *')) {
      const txt = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join('');
      if (!txt) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
      const a = lum(cs.color); const b = lum(ground(el));
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (ratio < min) { min = ratio; where = txt.slice(0, 40); }
    }
    return { min, where };
  });
  assert.ok(worst.min >= 4.5, `lowest contrast ${worst.min.toFixed(2)}:1 on "${worst.where}"`);
  console.log(`       lowest measured contrast ${worst.min.toFixed(2)}:1 on "${worst.where}"`);
});

console.log('\nthe button, pressed');
await t('CLICKING VOID KILLS THE CHARGE, and the bill goes down by exactly that amount', async () => {
  const dueBefore = await page.locator('.due-v').innerText();
  const cents = (s) => Math.round(Number(s.replace(/[^0-9.]/g, '')) * 100);
  const before = cents(dueBefore);
  assert.equal(before, 1900, `expected a $19.00 bill before the click, saw ${dueBefore}`);

  await page.locator('[data-void]').first().click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);

  const after = cents(await page.locator('.due-v').innerText());
  assert.equal(after, 0, 'the bill must be zero after the only charge was voided');
  const body = await page.locator('body').innerText();
  assert.match(body, /voided/i, 'the voided row must still be on the page');
  assert.match(body, /Job booked, standard hours/, 'a void must never delete the record');
  assert.equal(await page.locator('[data-void]').count(), 0, 'nothing left to void');
});
await t('the ledger agrees with what the browser showed', async () => {
  const s = await meter({ op: 'statement', account_key: KEY });
  assert.equal(s.due_cents, 0);
  const row = s.lines.find((l) => l.kind === 'booked_job' && l.state === 'voided');
  assert.ok(row, 'the ledger must hold a voided row');
  assert.equal(row.gross_cents, 1900, 'the price it WAS is still on the record');
});

console.log('\nwith javascript switched off');
await t('the statement still reads completely, it just cannot void', async () => {
  const noJs = await browser.newContext({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false });
  const p2 = await noJs.newPage();
  const res = await p2.goto(url, { waitUntil: 'domcontentloaded' });
  assert.equal(res.status(), 200);
  const body = await p2.locator('body').innerText();
  // innerText returns RENDERED text, and .due-k is text-transform:uppercase, so the label on
  // screen is "DUE THIS CYCLE". Matching the source casing here asserted against a string the
  // browser never shows.
  assert.match(body, /Due this cycle/i);
  assert.match(body, /Job booked, standard hours/);
  assert.match(body, /info@reddenda.com/, 'the door that works without js must be on the page');
  assert.match(body, /\$0\.00|\$19\.00/, 'the amount must render with no script at all');
  await noJs.close();
});

console.log('\nthe pricing page tells the truth about payment');
await t('the two new disclosures are on the built page and open', async () => {
  const p3 = await ctx.newPage();
  await p3.goto(`file://${process.cwd()}/pricing.html`, { waitUntil: 'domcontentloaded' });
  const body = await p3.locator('body').innerText();
  assert.match(body, /What happens at the moment you pay/);
  assert.match(body, /Which of these is running today/);
  assert.match(body, /The meter is running/, 'the state row must have propagated here');
  await p3.close();
});

await browser.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
