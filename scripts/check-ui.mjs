#!/usr/bin/env node
// check-ui.mjs — the lint that stops a recurring, expensive mistake.
//
// admin-ui.mjs holds the entire console as THREE template literals: TOKENS, CONSOLE_CSS and
// APP_JS. A single backtick anywhere inside one of them — including inside a code comment, which
// is where it has happened all three times — terminates the literal early.
//
// The runtime guards in that file catch the damage. This catches the CAUSE, before a deploy, and
// points at the line. Three occurrences in one day is a process problem, not a typing problem.
//
//   node scripts/check-ui.mjs
import fs from 'node:fs';
const FILE = new URL('../netlify/functions/lib/admin-ui.mjs', import.meta.url).pathname;
const src = fs.readFileSync(FILE, 'utf8');

const BLOCKS = [
  ['TOKENS',      'const TOKENS = `',          '/* TOKENS-END */'],
  ['CONSOLE_CSS', 'const CONSOLE_CSS = `',     '/* CONSOLE-CSS-END */'],
  ['APP_JS',      'const APP_JS = String.raw`', 'return { boot };'],
];

let bad = 0;
for (const [name, open, endMark] of BLOCKS) {
  const i = src.indexOf(open);
  if (i < 0) { console.error(`MISSING BLOCK: ${name}`); bad++; continue; }
  const start = i + open.length;
  const endIdx = src.indexOf(endMark, start);
  if (endIdx < 0) { console.error(`${name}: end marker "${endMark}" not found`); bad++; continue; }
  const body = src.slice(start, endIdx);
  const ticks = (body.match(/`/g) || []).length;
  if (ticks) {
    bad++;
    console.error(`\n${name}: ${ticks} stray backtick(s) — each one ends the template early.`);
    const upto = src.slice(0, start);
    let line = upto.split('\n').length;
    for (const l of body.split('\n')) {
      if (l.includes('`')) console.error(`  line ${line}: ${l.trim().slice(0, 100)}`);
      line++;
    }
  } else {
    console.log(`${name.padEnd(12)} clean (${body.length} chars)`);
  }
}
if (bad) {
  console.error('\nBackticks are not allowed anywhere inside these blocks, including comments.');
  console.error('Use single quotes for emphasis in a comment.');
  process.exit(1);
}
console.log('\nall three templates are intact');
