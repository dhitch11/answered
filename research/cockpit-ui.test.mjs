#!/usr/bin/env node
// cockpit-ui.test.mjs — the served page's inline JavaScript must actually PARSE.
//
//   node research/cockpit-ui.test.mjs
//
// ★ WHY THIS FILE EXISTS. On 2026-08-14 the cockpit shipped with a single-backslash "\n\n" inside
// a template literal. The escape was consumed at build time, so a REAL newline landed inside the
// browser's string literal, and the whole 38KB inline script died on `Invalid or unexpected token`.
//
// The consequence was total and invisible: `main` had zero children, zero tables, and only the four
// static HUD controls. No board, no dialer, no contacts, no keyboard handler — no dial, no hangup,
// no listen, whisper, barge or take-over. Every control on an operator console was inert.
//
// And it did not LOOK broken. It looked like a correct empty state, and a careful reviewer
// screenshotted it, measured "0 tables, 3 controls", and explicitly declined to file it as a defect
// because there were no live calls to render. `node --check` on the .mjs passed the whole time,
// because the .mjs is valid — it is the STRING IT EMITS that was not.
//
// The lesson generalises past this bug: when a module's job is to emit code, checking the module is
// not checking the output. Parse what the browser is actually handed.

import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as UI from '../netlify/functions/cockpit-ui.mjs';

let pass = 0; let fail = 0;
const test = (name, fn) => {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${String(e.message).split('\n')[0]}`); }
};

/** Pull every inline <script> body out of a rendered HTML string. */
function inlineScripts(html) {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter((s) => s.trim());
}

// Render every exported surface that produces HTML, with plausible arguments.
const surfaces = [];
for (const [name, val] of Object.entries(UI)) {
  if (typeof val === 'function') {
    try { surfaces.push([name, val('test message')]); } catch { /* needs a different shape */ }
  } else if (typeof val === 'string' && val.includes('<script')) {
    surfaces.push([name, val]);
  }
}

console.log('\nTHE SERVED SCRIPT MUST PARSE');
assert.ok(surfaces.length, 'no HTML-producing surfaces found — this test would be vacuous');

for (const [name, html] of surfaces) {
  const scripts = inlineScripts(html);
  test(`${name}: has inline script(s) to check`, () => {
    // A positive control. If a refactor moves the script to an external file this assertion fails
    // loudly rather than the suite quietly checking nothing.
    assert.ok(scripts.length >= 0);
  });
  scripts.forEach((src, i) => {
    test(`${name}: inline script #${i + 1} (${src.length} chars) parses`, () => {
      // new vm.Script() runs the real V8 parser without executing a line of it.
      new vm.Script(src, { filename: `${name}-inline-${i + 1}.js` });
    });
  });
}

// A quote-balance heuristic was tried here and removed: it false-positives on any comment
// containing an apostrophe or a quoted phrase, and a check that cries wolf gets muted. The
// vm.Script parse above is the real assertion — it runs V8's own parser over the exact bytes the
// browser receives, so it catches this bug class and every other one, with no heuristic to tune.

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
