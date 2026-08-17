// every-function-imports.test.mjs — the gate that would have caught tonight's outage.
//
// ═══ WHY THIS EXISTS ═══
//
// 2026-08-17: lib/personas.mjs referenced an identifier that was never defined. Every function
// importing it threw at load, /api/answered-brain returned 502, and the voice line was dark until a
// peer's own function 502'd on the same import and traced it back.
//
// ★ `node --check` PASSED ON THAT FILE. It is syntactically perfect. I had added a parse sweep over
// every function file earlier the same day, felt covered, and it was blind to this by construction:
// a ReferenceError on an undefined identifier is a RUNTIME event that fires only when something
// actually imports the module. Parsing proves the grammar; it proves nothing about the program.
//
// So this sweep IMPORTS. Every function and every lib is loaded for real, exactly as the runtime
// loads it, and a module that cannot construct itself fails here instead of on a customer's call.
//
// It is deliberately a test rather than a shell loop, so it runs in the same command everything else
// does. A gate nobody runs is not a gate.

import { strict as assert } from 'node:assert';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

let pass = 0, fail = 0;
const t = (name, fn) => fn().then(
  () => { pass++; },
  (e) => { fail++; console.error(`  FAIL  ${name}\n        ${e && e.message}`); },
);

const ROOT = new URL('..', import.meta.url).pathname;
const FUNCTIONS = join(ROOT, 'netlify', 'functions');

// ★ DISCOVERED, NOT LISTED. A hardcoded list of modules is a defect with a delay on it: the next
// file somebody adds is the one that is not covered, and nothing says so. This walks the directory
// the runtime actually bundles.
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { out.push(...walk(p)); continue; }
    if (!name.endsWith('.mjs')) continue;
    if (name.endsWith('.test.mjs')) continue;      // suites run themselves
    out.push(p);
  }
  return out;
}

const files = walk(FUNCTIONS);

console.log(`every function imports (${files.length} modules)\n`);

// ── POSITIVE CONTROL, FIRST. A sweep that cannot fail is decoration. ────────────────────────────
await t('POSITIVE CONTROL — importing a module with an undefined identifier DOES throw', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'importgate-'));
  const bad = join(dir, 'bad.mjs');
  // Syntactically perfect. node --check passes on this. It throws only on import.
  writeFileSync(bad, 'export const x = THIS_IDENTIFIER_DOES_NOT_EXIST;\n');
  let threw = false;
  try { await import(`file://${bad}`); } catch (e) { threw = /is not defined/.test(String(e && e.message)); }
  assert.ok(threw, 'the control module did not throw; this sweep cannot detect the outage it exists for');
});

await t('POSITIVE CONTROL — the sweep found modules to check', async () => {
  assert.ok(files.length >= 10, `only found ${files.length} modules; the walk is not reaching the functions directory`);
});

// ── the sweep ────────────────────────────────────────────────────────────────────────────────────
for (const f of files) {
  const rel = relative(ROOT, f);
  await t(`imports: ${rel}`, async () => {
    await import(`file://${f}`);
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.error('\n*** A module failed to LOAD. node --check would pass on it. This is the shape that');
  console.error('*** took the voice line down on 2026-08-17: syntactically perfect, runtime dead. ***');
}
process.exit(fail ? 1 : 0);
