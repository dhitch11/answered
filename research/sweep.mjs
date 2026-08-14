#!/usr/bin/env node
// sweep.mjs — THE MEASUREMENT THAT SETTLES THE LEGAL QUESTION.
//
// Runs Twilio Line Type Intelligence over the corpus and reports what share of real contractor
// numbers are fixed business lines (dialable by an AI on a non-promotional research call) versus
// mobile (needs prior express consent first, 47 CFR 64.1200(a)(1)).
//
//   ./research/with-env.sh node research/sweep.mjs --limit 500
//   ./research/with-env.sh node research/sweep.mjs --report-only
//
// Numbers already looked up are never re-billed. Failures are recorded as failures and counted as
// RED, because an unclassifiable number is never dialled.

import { lineType } from './lib/twilio.mjs';
import { append, read, lookupIndex, suppression, callCounts } from './lib/store.mjs';
import { gateAll, DEFAULT_POLICY } from './lib/lane.mjs';

const argv = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ') || 'true']),
);

const corpus = await read('corpus');
if (!corpus.length) {
  console.error('Corpus is empty. Run: node research/pull.mjs --states TX,FL,OH --limit 300');
  process.exit(1);
}

const idx = await lookupIndex();

if (!argv['report-only']) {
  const todo = corpus.filter((r) => !idx.has(r.phone)).slice(0, Number(argv.limit || 500));
  console.log(`corpus ${corpus.length} · already classified ${idx.size} · looking up ${todo.length}`);

  let done = 0;
  const BATCH = 10;                            // polite concurrency, well inside Twilio's limits
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    const results = await Promise.all(chunk.map((r) => lineType(r.phone)));
    for (const res of results) { await append('lookups', res); idx.set(res.phone, res); }
    done += chunk.length;
    process.stdout.write(`\r  ${done}/${todo.length}`);
  }
  if (todo.length) console.log('');
}

// ---- join, gate, report ---------------------------------------------------------------------
const counts = await callCounts();
const suppress = await suppression();

const joined = corpus
  .filter((r) => idx.has(r.phone))
  .map((r) => {
    const l = idx.get(r.phone);
    return { ...r, lineType: l.lineType, carrier: l.carrier, lookupOk: l.lookupOk, callCount30d: counts.get(r.phone) || 0 };
  });

const gated = gateAll(joined, DEFAULT_POLICY, suppress);

const byType = new Map();
for (const r of joined) {
  const k = r.lookupOk ? (r.lineType || 'null') : 'lookup_failed';
  byType.set(k, (byType.get(k) || 0) + 1);
}

const pct = (n) => `${((n / joined.length) * 100).toFixed(1)}%`;
const bar = (n) => '█'.repeat(Math.round((n / joined.length) * 40));

console.log(`\n${'='.repeat(74)}`);
console.log(`LINE TYPE SWEEP · ${joined.length} real contractor numbers classified`);
console.log('='.repeat(74));
for (const [type, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${type.padEnd(16)} ${String(n).padStart(5)}  ${pct(n).padStart(6)}  ${bar(n)}`);
}

console.log(`\n${'-'.repeat(74)}`);
console.log('THE GATE (non-promotional research script, business hours, cap 1 per 30 days)');
console.log('-'.repeat(74));
console.log(`  GREEN  consent on file, any line type   ${String(gated.tally.green).padStart(5)}  ${pct(gated.tally.green)}`);
console.log(`  AMBER  fixed business line, dialable    ${String(gated.tally.amber).padStart(5)}  ${pct(gated.tally.amber)}`);
console.log(`  HOLD   right number, wrong hour         ${String(gated.tally.hold).padStart(5)}  ${pct(gated.tally.hold)}`);
console.log(`  RED    never                            ${String(gated.tally.red).padStart(5)}  ${pct(gated.tally.red)}`);

const reachable = joined.filter((r) => {
  const t = r.lookupOk ? r.lineType : null;
  return t === 'landline' || t === 'fixedVoip';
}).length;
console.log(`\n  Dialable pool, ignoring the clock: ${reachable} of ${joined.length} (${pct(reachable)})`);
console.log(`  Per 1,000 contractor numbers pulled, that is ~${Math.round((reachable / joined.length) * 1000)} free dials.`);

console.log('\n  Top refusal reasons:');
for (const [reason, n] of gated.reasons.slice(0, 6)) console.log(`    ${String(n).padStart(5)}  ${reason}`);

const byState = new Map();
for (const r of gated.records) {
  const k = r.state;
  const v = byState.get(k) || { total: 0, dialable: 0 };
  v.total += 1; if (r.verdict.lane === 'amber' || r.verdict.lane === 'green' || r.verdict.lane === 'hold') {
    if (r.lineType === 'landline' || r.lineType === 'fixedVoip') v.dialable += 1;
  }
  byState.set(k, v);
}
console.log('\n  By state:');
for (const [st, v] of [...byState.entries()].sort((a, b) => b[1].total - a[1].total)) {
  console.log(`    ${st}  ${String(v.dialable).padStart(4)}/${String(v.total).padEnd(4)}  ${((v.dialable / v.total) * 100).toFixed(0)}% fixed-line`);
}
console.log(`${'='.repeat(74)}\n`);
