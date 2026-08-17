// call-me-gates.test.mjs — the rate gates in front of the dialer.
//
// Every one of these was written after a real failure on 2026-08-16, when David clicked the homepage
// hero for the first time and was refused three different ways for a call that was never placed.
//
//   1. The arbitration read-back ran on eventually-consistent storage, so a FIRST click lost a race
//      it was never in and the dial never ran.
//   2. The reservation written before that dial burned the number under the one-call-a-day gate, so
//      the next attempt would have said "we already called that number today", also false.
//   3. The per-browser gate then blocked the whole browser for 24 hours.
//
// This file tests the LOGIC of the gates directly, because the function itself needs Netlify Blobs,
// Twilio and a mobile-number lookup that no number we own can pass. It is a real gap and it is
// stated rather than papered over: these tests prove the arithmetic, not the wiring.

import { strict as assert } from 'node:assert';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.error(`  FAIL  ${name}\n        ${e.message}`); }
};

const HOURS_24 = 24 * 60 * 60 * 1000;
const RESERVATION_GRACE_MS = 90 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

// The decision, lifted to match the function's shape exactly.
function decide(lastRec, perNumber = 5) {
  const lastAt = lastRec && Date.parse(lastRec.at || '');
  const placed = lastRec && lastRec.outcome === 'placed';
  const recent = Array.isArray(lastRec && lastRec.placed_at)
    ? lastRec.placed_at.filter((x) => Number.isFinite(Date.parse(x)) && Date.now() - Date.parse(x) < HOURS_24)
    : (placed && Number.isFinite(lastAt) && Date.now() - lastAt < HOURS_24 ? [lastRec.at] : []);
  if (recent.length >= perNumber) return 'called_today';
  if (!placed && Number.isFinite(lastAt) && Date.now() - lastAt < RESERVATION_GRACE_MS) return 'in_flight';
  return 'allow';
}

console.log('call-me gates\n');

// ── the bug that started all of this ─────────────────────────────────────────────────────────────
t('a RESERVATION that never dialled does NOT burn the number for a day', () => {
  assert.equal(decide({ at: iso(5 * 60 * 1000), outcome: 'reserved' }), 'allow',
    'a 5-minute-old reservation still blocks; that is the 24-hour lockout bug');
});
t('a reservation DOES hold for its short grace, so a double click is arbitrated', () => {
  assert.equal(decide({ at: iso(10 * 1000), outcome: 'reserved' }), 'in_flight');
});
t('a failed dial leaves a reservation, and does not cost a day either', () => {
  assert.equal(decide({ at: iso(10 * 60 * 1000), outcome: 'dial_failed' }), 'allow');
});

// ── a few per day, which is what David asked for ─────────────────────────────────────────────────
t('a first real call allows a second (show your coworker)', () => {
  assert.equal(decide({ at: iso(60 * 1000), outcome: 'placed', placed_at: [iso(60 * 1000)] }), 'allow');
});
t('four placed calls still allow a fifth', () => {
  const p = [iso(4e6), iso(3e6), iso(2e6), iso(1e6)];
  assert.equal(decide({ at: p[3], outcome: 'placed', placed_at: p }), 'allow');
});
t('the fifth is the ceiling, and the sixth is refused', () => {
  const p = [iso(5e6), iso(4e6), iso(3e6), iso(2e6), iso(1e6)];
  assert.equal(decide({ at: p[4], outcome: 'placed', placed_at: p }), 'called_today');
});
t('the ceiling is a ROLLING window: yesterday does not count against today', () => {
  const old = [iso(HOURS_24 + 6e5), iso(HOURS_24 + 5e5), iso(HOURS_24 + 4e5), iso(HOURS_24 + 3e5), iso(HOURS_24 + 2e5)];
  assert.equal(decide({ at: old[4], outcome: 'placed', placed_at: old }), 'allow',
    'calls older than 24h still count; the window is not rolling');
});
t('the ceiling is configurable and 1 still works for a future tightening', () => {
  assert.equal(decide({ at: iso(1000), outcome: 'placed', placed_at: [iso(1000)] }, 1), 'called_today');
});

// ── back-compat: records written before placed_at existed ────────────────────────────────────────
t('a legacy placed record with no placed_at counts as one call, not zero', () => {
  assert.equal(decide({ at: iso(1000), outcome: 'placed' }, 1), 'called_today');
});
t('a legacy placed record still allows more under the new ceiling', () => {
  assert.equal(decide({ at: iso(1000), outcome: 'placed' }, 5), 'allow');
});

// ── nothing on record ────────────────────────────────────────────────────────────────────────────
t('a number never seen before is allowed', () => {
  assert.equal(decide(null), 'allow');
  assert.equal(decide(undefined), 'allow');
  assert.equal(decide({}), 'allow');
});
t('a corrupt timestamp does not block anyone', () => {
  assert.equal(decide({ at: 'not-a-date', outcome: 'reserved' }), 'allow');
  assert.equal(decide({ at: iso(1000), outcome: 'placed', placed_at: ['garbage', 'also-garbage'] }), 'allow');
});

// ── POSITIVE CONTROLS: prove this file can fail ──────────────────────────────────────────────────
t('POSITIVE CONTROL — decide() can return each of its three verdicts', () => {
  const seen = new Set([
    decide(null),
    decide({ at: iso(10 * 1000), outcome: 'reserved' }),
    decide({ at: iso(1000), outcome: 'placed', placed_at: [iso(1000)] }, 1),
  ]);
  assert.equal(seen.size, 3, `only produced ${[...seen].join(', ')}; the tests above cannot all be meaningful`);
});

// ── the session gate must stay gone ──────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../netlify/functions/call-me.mjs', import.meta.url), 'utf8');
t('the per-browser session gate is REMOVED, not just reworded', () => {
  assert.equal(src.includes('session_used'), false, 'session_used still returned somewhere');
  assert.match(src, /one per session — REMOVED/, 'the removal is not documented where the next reader will look');
});
t('the session key is still WRITTEN, because arbitration uses its nonce', () => {
  assert.match(src, /setJSON\(`session\/\$\{sessionHash\}`/);
});
// ★ THIS ASSERTION EXISTS BECAUSE ITS ABSENCE WAS CAUGHT BY A MUTATION TEST. Changing the shipped
// default from 5 back to 1 left all 17 tests green, because decide() above carries its OWN default
// and never reads the source. The suite was testing the arithmetic of a number it supplied itself.
// A helper that re-declares the value it is checking cannot detect a change to the real one.
t('the SHIPPED default ceiling is more than one, which is the whole point of the change', () => {
  const m = src.match(/ANSWERED_CALLME_PER_NUMBER_DAY \|\| (\d+)/);
  assert.ok(m, 'no shipped default found');
  assert.ok(Number(m[1]) > 1, `shipped default is ${m[1]}; David asked for a few per day, not one`);
});
t('the per-number ceiling and the global cap both survive', () => {
  assert.match(src, /ANSWERED_CALLME_PER_NUMBER_DAY/, 'per-number ceiling gone; a stranger can be dialled without limit');
  assert.match(src, /ANSWERED_CALLME_DAILY_CAP/, 'global daily cap gone');
});
t('every blob read that follows its own write is strongly consistent', () => {
  const arb = src.slice(src.indexOf('await sleep(150)'), src.indexOf('await sleep(150)') + 900);
  assert.match(arb, /consistency: 'strong'/, 'the arbitration read-back is eventually consistent again');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
