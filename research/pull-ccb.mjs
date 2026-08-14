#!/usr/bin/env node
// pull-ccb.mjs — bring the Oregon CCB active-licence registry into the corpus.
//
//   node research/pull-ccb.mjs            (whole registry)
//   node research/pull-ccb.mjs --limit 500
//
// Appends to research/data/corpus.jsonl. Numbers already in the corpus are skipped, so this widens
// the book rather than duplicating it, and it can be re-run as licences are issued.

import { pullOregonCCB } from './sources/ccb-oregon.mjs';
import { append, read } from './lib/store.mjs';

const argv = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ') || 'true']),
);

const existing = new Set((await read('corpus')).map((r) => r.phone));
console.log(`corpus already holds ${existing.size} numbers`);

const { rows, stats } = await pullOregonCCB({
  limit: Number(argv.limit || Infinity),
  onProgress: (p) => process.stdout.write(`\r  scanned ${p.scanned}  kept ${p.kept}`),
});
console.log('');

let added = 0;
for (const row of rows) {
  if (existing.has(row.phone)) continue;
  existing.add(row.phone);
  await append('corpus', row);
  added += 1;
}

console.log(`
  registry rows with a usable phone   ${stats.kept}
  skipped, no usable phone            ${stats.noPhone}
  skipped, not an ICP endorsement     ${stats.notIcp}
  skipped, same number twice          ${stats.dupInSource}

  NEW into the corpus                 ${added}
  corpus total                        ${existing.size}

  Every one of these carries a state licence number, which is the business-verification evidence
  the gate requires. It does NOT excuse the line-type gate: these still need classifying, and an
  unclassified number is still refused.
`);
