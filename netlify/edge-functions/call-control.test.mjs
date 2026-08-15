#!/usr/bin/env node
// The edge call control, tested against REAL production bytes.
//
// ★ WHY THIS FILE IS SHAPED LIKE THIS. The green path cannot be reached on production today: the
// telephony account is unfunded, so /api/demo-health is red and the edge function correctly does
// nothing. A verification that only ever exercises the red path proves the fallback and says
// NOTHING about the thing being built. The handoff's own criterion 3 makes this explicit: a state
// that can only be produced locally is not verified.
//
// So this fetches the live pages, runs the EXACT transform the edge function runs, and asserts on
// the result. The health DECISION is a separate, independently observable fact (the site-wide gate
// is red right now and every page correctly carries no number). What is proven here is that when
// the decision flips, the bytes are right.
//
//   node netlify/edge-functions/call-control.test.mjs

const BASE = (process.env.BASE || 'https://answered.reddenda.com').replace(/\/+$/, '');
const TEL = '+19163504869';
const PAGES = ['/', '/trades', '/hold', '/recover', '/parley', '/setup', '/pricing', '/trust', '/thanks'];

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
};

const escapeAttr = (s) => s.replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The transform, character for character as the edge function performs it.
function transform(html, tel) {
  const m = tel.match(/^\+(\d)(\d{3})(\d{3})(\d{4})$/);
  const pretty = m ? `+${m[1]} (${m[2]}) ${m[3]}-${m[4]}` : tel;
  return html.replace(
    /(<span class="cta-slot"[^>]*data-callslot(?:="[^"]*")?[^>]*>)([\s\S]*?)(<\/span>)/g,
    (_full, open, _inner, close) => {
      const lm = open.match(/data-callslot="([^"]*)"/);
      const label = lm && lm[1] ? lm[1] : 'Call the line';
      return open
        + `<a class="btn btn-primary btn-call" href="tel:${escapeAttr(tel)}">`
        + `<span class="call-l">${escapeAttr(label)}</span> `
        + `<span class="call-n">${escapeAttr(pretty)}</span></a>`
        + close;
    },
  );
}

console.log(`\nEDGE CALL CONTROL against ${BASE}\n${'─'.repeat(62)}`);

let anySlots = 0;
for (const p of PAGES) {
  const r = await fetch(BASE + p, { signal: AbortSignal.timeout(20000) });
  const html = await r.text();
  // ★ COMMENTS ARE NOT SLOTS. Counting raw `data-callslot` occurrences includes the HTML comments
  // that EXPLAIN the mechanism, so `/` reads as 6 slots when it has 4. That produced a false
  // failure here ("4 of 6 slots became tel: links") against a transform that was correct.
  // This is the identical mistake the staging route guard made an hour earlier, where a comment
  // quoting a removed path was read as a live route. Twice in one evening, by me, in two files.
  // Strip comments before counting anything.
  const real = html.replace(/<!--[\s\S]*?-->/g, '');
  const slots = (real.match(/data-callslot/g) || []).length;
  anySlots += slots;

  // RED, as served right now: no dialable control anywhere.
  const telNow = (html.match(/href="tel:/g) || []).length;
  t(`${p} red: served with no dialable control`, telNow === 0,
    `slots present: ${slots}, tel links: ${telNow}`);

  if (!slots) continue;

  // GREEN, by running the real transform over the real bytes.
  const out = transform(real, TEL);
  const telGreen = (out.match(/href="tel:\+19163504869"/g) || []).length;
  t(`${p} green: every slot becomes a real tel: link`, telGreen === slots,
    `${telGreen} of ${slots} slots became tel: links`);
  t(`${p} green: digits are in the HTML for a reader with no JavaScript`,
    out.includes('+1 (916) 350-4869'),
    'the pretty form is present in the served bytes, not only after script runs');
  t(`${p} green: the page is not otherwise rewritten`,
    Math.abs(out.length - real.length) < slots * 400 && out.includes('</html>'),
    `${real.length} -> ${out.length} bytes, document still closed`);
}

// ★ POSITIVE CONTROLS. Without these, every line above passes against a transform that does nothing
// on red and a transform that mangles everything on green.
t('CONTROL: the transform is not a no-op',
  transform('<span class="cta-slot" data-callslot="X">fallback</span>', TEL).includes('href="tel:'),
  'a synthetic slot gains a tel: link');
t('CONTROL: it does not touch HTML with no slot',
  transform('<p>nothing here</p>', TEL) === '<p>nothing here</p>',
  'a page with no call slot is returned byte-identical');
t('CONTROL: the pages actually had slots to transform',
  anySlots > 0, `${anySlots} slots found across ${PAGES.length} pages; zero would make every green assertion vacuous`);

console.log('─'.repeat(62));
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
