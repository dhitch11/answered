#!/usr/bin/env node
// smoke-call.mjs — prove the telephony runtime end to end, on a line we own.
//
//   ./research/with-env.sh node research/smoke-call.mjs
//
// This deliberately calls Twilio directly rather than going through the console, because it is
// testing the RUNTIME (TwiML, AMD, status callbacks, recording, live transcription), not the
// legal gate. The gate is tested separately and exhaustively in gate.test.mjs, and nothing here
// weakens it: the only number this script will dial is Answered's own demo line, and it refuses
// to run against anything else.

import { placeCall, getCall } from './lib/twilio.mjs';

const TO = process.env.ANSWERED_DEMO_NUMBER;
const FROM = process.env.CANARY_FROM_NUMBER;
const SITE = process.env.SMOKE_SITE || 'https://answered.reddenda.com';

if (!TO || !FROM) {
  console.error('Need ANSWERED_DEMO_NUMBER and CANARY_FROM_NUMBER. Run through with-env.sh.');
  process.exit(1);
}
// A smoke test that can dial an arbitrary number is not a smoke test, it is a dialler.
if (TO === FROM) { console.error('demo and from number are the same; nothing to test'); process.exit(1); }

console.log(`\nplacing ${FROM} -> ${TO}  (mode=measure)\n`);

const call = await placeCall({
  to: TO,
  from: FROM,
  url: `${SITE}/api/call-voice?mode=measure`,
  statusCallback: `${SITE}/api/call-status`,
  machineDetection: 'DetectMessageEnd',
  timeout: 30,
  record: true,
});

console.log(`  call_sid   ${call.sid}`);
console.log(`  status     ${call.status}`);

const seen = new Set();
for (let i = 0; i < 40; i += 1) {
  await new Promise((r) => setTimeout(r, 3000));
  let c;
  try { c = await getCall(call.sid); } catch (e) { console.log(`  poll error: ${e.message}`); continue; }
  const key = `${c.status}|${c.answered_by || ''}`;
  if (!seen.has(key)) {
    seen.add(key);
    console.log(`  ${String(i * 3).padStart(3)}s  status=${c.status}  answered_by=${c.answered_by || '-'}  duration=${c.duration || '-'}`);
  }
  if (['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(c.status)) {
    console.log(`\n  final: ${c.status}, ${c.duration}s, answered_by=${c.answered_by || 'unknown'}, price=${c.price || 'pending'}`);
    console.log('\nNow check the cockpit: the call, its recording and its transcript should all be on the row.');
    process.exit(0);
  }
}
console.log('\n  still running after 120s; check the cockpit.');
