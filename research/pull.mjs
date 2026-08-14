#!/usr/bin/env node
// pull.mjs — build the contractor corpus from public sources.
//
//   node research/pull.mjs --states TX,FL,OH,AZ,NC --limit 300
//   node research/pull.mjs --states TX --trades plumber,hvac --limit 100
//
// Appends to research/data/corpus.jsonl. Numbers already in the corpus are skipped, so re-running
// widens the corpus rather than duplicating it.

import { pullState, TRADES, sleep } from './sources/osm.mjs';
import { append, read } from './lib/store.mjs';
import { STATE_ZONES } from './lib/geo.mjs';

const argv = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')]),
);

const states = (argv.states || 'TX').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const trades = argv.trades ? argv.trades.split(',').map((s) => s.trim()) : Object.keys(TRADES);
const limit = Number(argv.limit || 300);

const unknown = states.filter((s) => !STATE_ZONES[s]);
if (unknown.length) {
  console.error(`Refusing to pull ${unknown.join(', ')}: no timezone mapping, so the calling-hours gate could never clear these numbers.`);
  process.exit(1);
}

const existing = new Set((await read('corpus')).map((r) => r.phone));
console.log(`corpus already holds ${existing.size} numbers`);

let added = 0;
for (const state of states) {
  process.stdout.write(`  ${state} … `);
  try {
    const rows = await pullState({
      state,
      trades,
      limit,
      onProgress: (p) => process.stdout.write(p.error ? `[${p.batch}/${p.of} ERR] ` : `[${p.batch}/${p.of}:${p.found}] `),
    });
    let n = 0;
    for (const row of rows) {
      if (existing.has(row.phone)) continue;
      existing.add(row.phone);
      await append('corpus', row);
      n += 1; added += 1;
    }
    console.log(`${rows.length} found, ${n} new`);
  } catch (e) {
    console.log(`FAILED (${e.message})`);
  }
  await sleep(3000);                       // Overpass is a free shared service. Do not hammer it.
}

console.log(`\ncorpus: +${added} new, ${existing.size} total`);
