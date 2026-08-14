#!/usr/bin/env node
// dnc-ingest.mjs — load a National Do-Not-Call Registry download into the call spine.
//
//   ./research/with-env.sh node research/dnc-ingest.mjs --file ~/Downloads/dnc.txt --san 12345678
//   ./research/with-env.sh node research/dnc-ingest.mjs --status
//
// ★ WHAT THIS CANNOT DO, SAID PLAINLY: it cannot obtain the registry. Access requires an
// organisation account at telemarketing.donotcall.gov, a Subscription Account Number, and payment
// ($82 per area code per year, first five free, $22,626 national cap for FY2026). That is an
// account a human opens in their own name with their own payment method, and no amount of
// engineering substitutes for it. Everything downstream of the download is built and waiting.
//
// The gate reads freshness from the snapshot row, so an old download does not silently keep
// working: 47 CFR 64.1200(c)(2)(i)(D) requires the version used to be under 31 days old, and on day
// 32 the gate closes on its own without anyone remembering to close it.

import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';

const URL_ = process.env.ANSWERED_DB_URL;
const ANON = process.env.ANSWERED_DB_ANON;
const SECRET = process.env.ANSWERED_DB_SECRET;
if (!URL_ || !ANON || !SECRET) {
  console.error('Run through research/with-env.sh so the credentials come from the Netlify project.');
  process.exit(1);
}

const argv = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ') || 'true']),
);

async function rpc(fn, args = {}) {
  const res = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_secret: SECRET, ...args }),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`${fn} ${res.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

if (argv.status) {
  const r = await rpc('sv_dnc_readiness');
  console.log('\nDNC PROGRAM READINESS\n');
  const line = (k, v, why) => console.log(`  ${v ? 'yes' : 'NO '}  ${k}${why ? `  — ${why}` : ''}`);
  line('registry scrub is fresh (under 31 days)', r.scrub_ready,
    r.snapshot_age_days == null ? 'no snapshot has ever been loaded' : `${r.snapshot_age_days} days old`);
  line('written policy on file', r.policy_written);
  line('affiliate scope on file', r.affiliate_scope);
  line('retention policy on file', r.retention_policy);
  line('training recorded', r.training_recorded);
  line('internal do-not-call list live', r.internal_list_live);
  line('no overdue requests', r.overdue_requests === 0, `${r.overdue_requests} overdue`);
  console.log(`\n  PROCEDURES READY (64.1200(d)): ${r.procedures_ready ? 'YES' : 'NO'}`);
  console.log(`  SCRUB READY (64.1200(c)(2)):   ${r.scrub_ready ? 'YES' : 'NO'}`);
  console.log(`\n  The gate opens for non-consented cold calls only when BOTH are yes.\n`);
  process.exit(0);
}

if (!argv.file) {
  console.error('Need --file <path to the registry download>. Use --status to see where the program stands.');
  process.exit(1);
}

// The registry download is a flat list of ten-digit numbers, one per line, per area code file.
const areaCodes = new Set();
const batch = [];
let total = 0;

const snapshot = await rpc('sv_dnc_begin_snapshot', {
  p_san: argv.san || null,
  p_source: 'national_dnc',
});
console.log(`snapshot ${snapshot.snapshot_id}`);

const rl = createInterface({ input: createReadStream(argv.file), crlfDelay: Infinity });
for await (const raw of rl) {
  const d = raw.replace(/\D/g, '');
  if (d.length !== 10) continue;
  const phone = `+1${d}`;
  areaCodes.add(d.slice(0, 3));
  batch.push(phone);
  total += 1;
  if (batch.length >= 5000) {
    await rpc('sv_dnc_load', { p_snapshot: snapshot.snapshot_id, p_numbers: batch });
    batch.length = 0;
    process.stdout.write(`\r  loaded ${total}`);
  }
}
if (batch.length) await rpc('sv_dnc_load', { p_snapshot: snapshot.snapshot_id, p_numbers: batch });
console.log(`\r  loaded ${total} numbers across ${areaCodes.size} area codes`);

await rpc('sv_dnc_finish_snapshot', {
  p_snapshot: snapshot.snapshot_id,
  p_numbers: total,
  p_area_codes: [...areaCodes],
});

const r = await rpc('sv_dnc_readiness');
console.log(`\n  scrub ready: ${r.scrub_ready ? 'YES' : 'NO'}   procedures ready: ${r.procedures_ready ? 'YES' : 'NO'}\n`);
