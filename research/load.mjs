#!/usr/bin/env node
// load.mjs — push the local corpus, its line types and its gate verdicts into the call spine.
//
//   ./research/with-env.sh node research/load.mjs
//
// The local JSONL files are the working set: cheap to re-run, easy to inspect, never deployed and
// never committed. This moves the finished product into the database the cockpit reads, with the
// lane already decided so an operator can see the whole book split green/amber/red on arrival.
//
// The lane written here is a SNAPSHOT for display and triage. It is never trusted at dial time:
// lib/dial.mjs re-runs the gate against live suppression, live call counts and the live clock on
// every single call, because a lane computed last Tuesday is a fact about last Tuesday.

import { read, lookupIndex } from './lib/store.mjs';
import { gateAll, DEFAULT_POLICY } from './lib/lane.mjs';

const URL_ = process.env.ANSWERED_DB_URL;
const ANON = process.env.ANSWERED_DB_ANON;
const SECRET = process.env.ANSWERED_DB_SECRET;
if (!URL_ || !ANON || !SECRET) {
  console.error('Need ANSWERED_DB_URL / ANSWERED_DB_ANON / ANSWERED_DB_SECRET. Run through with-env.sh.');
  process.exit(1);
}

async function rpc(fn, args) {
  const res = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_secret: SECRET, ...args }),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`${fn} ${res.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

const corpus = await read('corpus');
const idx = await lookupIndex();
console.log(`corpus ${corpus.length} · classified ${idx.size}`);

const joined = corpus.map((r) => {
  const l = idx.get(r.phone);
  return {
    ...r,
    lineType: l?.lineType ?? null,
    carrier: l?.carrier ?? null,
    lookupOk: l?.lookupOk ?? null,
    callCount30d: 0,
  };
});

// Evaluated at a known-open instant so the snapshot reflects the number's own merits rather than
// what time it happens to be while this script runs. A number that is only HOLD because it is
// currently 2am is green or amber on its merits, and that is what the book should show.
const OPEN = new Date();
OPEN.setUTCHours(18, 0, 0, 0);
while ([0, 6].includes(OPEN.getUTCDay())) OPEN.setUTCDate(OPEN.getUTCDate() + 1);

const gated = gateAll(joined, DEFAULT_POLICY, new Set(), OPEN);

const rows = gated.records.map((r) => ({
  phone: r.phone, name: r.name, trade: r.trade, state: r.state, city: r.city, street: r.street,
  website: r.website, lat: r.lat, lon: r.lon, source: r.source, source_id: r.sourceId,
  line_type: r.lineType, carrier: r.carrier, lookup_ok: r.lookupOk,
  lane: r.verdict.lane === 'hold' ? 'amber' : r.verdict.lane,
  lane_reasons: r.verdict.reasons,
}));

let done = 0;
const CHUNK = 200;
for (let i = 0; i < rows.length; i += CHUNK) {
  const n = await rpc('sv_upsert_contacts', { p_rows: rows.slice(i, i + CHUNK) });
  done += Number(n || 0);
  process.stdout.write(`\r  loaded ${done}/${rows.length}`);
}
console.log('');

const tally = gated.tally;
console.log(`\n  green ${tally.green} · amber ${tally.amber} · red ${tally.red} · hold ${tally.hold}`);
console.log('  (hold is stored as amber: it is a clock state, not a property of the number)');
console.log('\nOpen the cockpit. The book is loaded.\n');
