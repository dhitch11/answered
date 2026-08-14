#!/usr/bin/env node
// gate.test.mjs — the legal gate is the one piece of this system that cannot be wrong.
//
//   node research/gate.test.mjs
//
// Every case here is a real decision the dialler will make. The negative cases matter more than
// the positive ones: this file exists to prove that uncertainty resolves to RED, never to "dial".

import assert from 'node:assert/strict';
import { classify, DEFAULT_POLICY, LANES, LICENSING_REQUIRED_STATES, BIOMETRIC_RISK_STATES } from './lib/lane.mjs';
import { withinWindow, STATE_ZONES, MULTI_ZONE_STATES } from './lib/geo.mjs';
import { suppress, suppression, paths } from './lib/store.mjs';
import { readFile, writeFile } from 'node:fs/promises';

let pass = 0; let fail = 0;
const test = (name, fn) => {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

// A Tuesday at 11:00 Pacific / 14:00 Eastern: inside the window in every continental zone.
const OPEN = new Date('2026-08-11T18:00:00Z');
// A Tuesday at 03:00 Pacific: outside the window everywhere.
const SHUT = new Date('2026-08-11T10:00:00Z');
// A Saturday.
const WEEKEND = new Date('2026-08-15T18:00:00Z');

// Ohio: single-timezone, no solicitor licensing gate, no biometric gate. The neutral state for
// testing everything that is not itself about geography.
// dncListed false = checked against a fresh snapshot and not listed. null = could not check.
const base = { phone: '+15125550142', state: 'OH', lookupOk: true, callCount30d: 0, dncListed: false };

// ★ The default policy now refuses EVERY non-consented call, because the do-not-call program does
// not exist yet and 47 CFR 64.1200(d) is a condition precedent. READY is the same policy with those
// two programs stood up, which is what the line-type and clock cases are actually about.
const READY = { ...DEFAULT_POLICY, dncScrubbed: true, dncProceduresInPlace: true };

console.log('\nLINE TYPE');
test('a verified landline is dialable', () => {
  const v = classify({ ...base, lineType: 'landline' }, READY, new Set(), OPEN);
  assert.equal(v.lane, LANES.AMBER);
  assert.equal(v.dialable, true);
});
test('fixed VoIP is a business line and is dialable', () => {
  const v = classify({ ...base, lineType: 'fixedVoip' }, READY, new Set(), OPEN);
  assert.equal(v.dialable, true);
});
test('a mobile is REFUSED without consent', () => {
  const v = classify({ ...base, lineType: 'mobile' }, DEFAULT_POLICY, new Set(), OPEN);
  assert.equal(v.lane, LANES.RED);
  assert.equal(v.dialable, false);
  assert.match(v.reasons.join(' '), /64\.1200\(a\)\(1\)/);
});
test('non-fixed VoIP is refused: it can be a mobile app number', () => {
  assert.equal(classify({ ...base, lineType: 'nonFixedVoip' }, DEFAULT_POLICY, new Set(), OPEN).dialable, false);
});
test('toll-free is refused because the called party pays', () => {
  const v = classify({ ...base, lineType: 'tollFree' }, DEFAULT_POLICY, new Set(), OPEN);
  assert.equal(v.dialable, false);
  assert.match(v.reasons.join(' '), /pays/);
});

console.log('\nFAIL CLOSED');
test('a failed lookup is RED, never a maybe', () => {
  const v = classify({ ...base, lineType: 'landline', lookupOk: false }, DEFAULT_POLICY, new Set(), OPEN);
  assert.equal(v.lane, LANES.RED);
});
test('a missing line type is RED', () => {
  assert.equal(classify({ ...base, lineType: null }, DEFAULT_POLICY, new Set(), OPEN).dialable, false);
});
test('a line type the gate has never heard of is RED', () => {
  assert.equal(classify({ ...base, lineType: 'quantumTelepathy' }, DEFAULT_POLICY, new Set(), OPEN).dialable, false);
});
test('a missing state is RED, because local time cannot be established', () => {
  const v = classify({ ...base, state: null, lineType: 'landline' }, DEFAULT_POLICY, new Set(), OPEN);
  assert.equal(v.lane, LANES.RED);
});
test('a malformed number is RED', () => {
  assert.equal(classify({ ...base, phone: '512-555-0142', lineType: 'landline' }, DEFAULT_POLICY, new Set(), OPEN).dialable, false);
});
test('an international number is RED', () => {
  assert.equal(classify({ ...base, phone: '+442071838750', lineType: 'landline' }, DEFAULT_POLICY, new Set(), OPEN).dialable, false);
});

console.log('\nSUPPRESSION AND FREQUENCY');
test('a suppressed number is RED even with consent on file', () => {
  const v = classify(
    { ...base, lineType: 'landline', consent: { grantedAt: '2026-08-01', scope: 'research_call', source: 'form' } },
    READY, new Set(['+15125550142']), OPEN,
  );
  assert.equal(v.lane, LANES.RED);
  assert.match(v.reasons.join(' '), /suppression/);
});
test('the frequency cap blocks a second call inside 30 days', () => {
  const v = classify({ ...base, lineType: 'landline', callCount30d: 1 }, READY, new Set(), OPEN);
  assert.equal(v.lane, LANES.RED);
});
test('the cap stays inside the three-per-30-days ceiling in the regulation', () => {
  assert.ok(DEFAULT_POLICY.maxCallsPer30Days <= 3);
});

console.log('\nCONSENT');
test('consent makes a mobile dialable', () => {
  const v = classify(
    { ...base, lineType: 'mobile', consent: { grantedAt: '2026-08-01', scope: 'research_call', source: 'ring_test' } },
    DEFAULT_POLICY, new Set(), OPEN,
  );
  assert.equal(v.lane, LANES.GREEN);
  assert.equal(v.dialable, true);
});
test('expired consent does not', () => {
  const v = classify(
    { ...base, lineType: 'mobile', consent: { grantedAt: '2026-01-01', expiresAt: '2026-02-01', scope: 'research_call', source: 'form' } },
    DEFAULT_POLICY, new Set(), OPEN,
  );
  assert.equal(v.dialable, false);
});
test('consent for a different purpose does not', () => {
  const v = classify(
    { ...base, lineType: 'mobile', consent: { grantedAt: '2026-08-01', scope: 'marketing', source: 'form' } },
    DEFAULT_POLICY, new Set(), OPEN,
  );
  assert.equal(v.dialable, false);
});
test('promotional content needs WRITTEN consent, not just consent', () => {
  const policy = { ...READY, promotional: true };
  const v = classify(
    { ...base, lineType: 'landline', consent: { grantedAt: '2026-08-01', scope: 'research_call', source: 'form', written: false } },
    policy, new Set(), OPEN,
  );
  assert.equal(v.dialable, false);
});

console.log('\nTHE CLOCK');
test('a good number at a bad hour is HOLD, not RED', () => {
  const v = classify({ ...base, lineType: 'landline' }, READY, new Set(), SHUT);
  assert.equal(v.lane, LANES.HOLD);
  assert.equal(v.dialable, false);
  assert.ok(v.retryAt instanceof Date);
});
test('the weekend is closed', () => {
  assert.equal(classify({ ...base, lineType: 'landline' }, READY, new Set(), WEEKEND).lane, LANES.HOLD);
});
test('a split state must clear the window in BOTH of its zones', () => {
  // 09:15 Central is inside the window, but the same instant is 08:15 Mountain, which is not.
  const early = new Date('2026-08-11T14:15:00Z');
  const tx = withinWindow('TX', DEFAULT_POLICY.window, early);
  assert.equal(tx.ok, false, 'Texas should be held while its Mountain half is still shut');
  const oh = withinWindow('OH', DEFAULT_POLICY.window, early);
  assert.equal(oh.ok, true, 'Ohio is single-zone Eastern and open at 10:15 local');
});
test('every split state is actually flagged as split', () => {
  for (const s of ['TX', 'FL', 'ID', 'IN', 'KS', 'KY', 'MI', 'ND', 'NE', 'NV', 'OR', 'SD', 'TN', 'AK']) {
    assert.ok(MULTI_ZONE_STATES.includes(s), `${s} should be multi-zone`);
  }
});
test('all fifty states plus DC have a timezone', () => {
  const all = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
    'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN',
    'TX','UT','VT','VA','WA','WV','WI','WY','DC'];
  const missing = all.filter((s) => !STATE_ZONES[s]);
  assert.deepEqual(missing, [], `missing timezone mapping: ${missing.join(', ')}`);
});
test('every mapped zone is a real IANA zone the runtime accepts', () => {
  for (const [state, zones] of Object.entries(STATE_ZONES)) {
    for (const z of zones) {
      assert.doesNotThrow(() => new Intl.DateTimeFormat('en-US', { timeZone: z }), `${state}: ${z}`);
    }
  }
});

console.log('\nTHE PRECONDITIONS MANUAL DIALLING DOES NOT CURE');
test('with no DNC program, nothing non-consented is dialable at all', () => {
  const v = classify({ ...base, lineType: 'landline' }, DEFAULT_POLICY, new Set(), OPEN);
  assert.equal(v.lane, LANES.RED);
  assert.match(v.reasons.join(' '), /do-not-call registry|64\.1200\(d\)/);
});
test('64.1200(d) procedures are a condition precedent, not a mitigation', () => {
  const scrubbedOnly = { ...DEFAULT_POLICY, dncScrubbed: true };
  const v = classify({ ...base, lineType: 'landline' }, scrubbedOnly, new Set(), OPEN);
  assert.equal(v.dialable, false);
  assert.match(v.reasons.join(' '), /condition precedent/);
});
for (const st of ['TX', 'WA', 'FL']) {
  test(`${st} is refused: registration and bond bind before the first call`, () => {
    const v = classify({ ...base, state: st, lineType: 'landline' }, READY, new Set(), OPEN);
    assert.equal(v.lane, LANES.RED);
    assert.match(v.reasons.join(' '), /registration and bond/);
  });
}
test('IL is refused while a voiceprint cannot be ruled out', () => {
  const v = classify({ ...base, state: 'IL', lineType: 'landline' }, READY, new Set(), OPEN);
  assert.equal(v.lane, LANES.RED);
  assert.match(v.reasons.join(' '), /WRITTEN release/);
});
test('consent still clears the licensing states, because it is a different basis', () => {
  const v = classify(
    { ...base, state: 'TX', lineType: 'mobile', consent: { grantedAt: '2026-08-01', scope: 'research_call', source: 'ring_test' } },
    READY, new Set(), OPEN);
  assert.equal(v.lane, LANES.GREEN);
});
test('the licensing and biometric lists are the verified ones, not guesses', () => {
  assert.deepEqual([...LICENSING_REQUIRED_STATES].sort(), ['FL', 'TX', 'WA']);
  assert.deepEqual([...BIOMETRIC_RISK_STATES], ['IL']);
});

console.log('\nTHE REGISTRY ANSWER IS THREE-STATE');
test('a number ON the registry is refused', () => {
  const v = classify({ ...base, lineType: 'landline', dncListed: true }, READY, new Set(), OPEN);
  assert.equal(v.lane, LANES.RED);
  assert.match(v.reasons.join(' '), /Do-Not-Call Registry/i);
});
test('an UNANSWERABLE registry check is a refusal, not permission', () => {
  const v = classify({ ...base, lineType: 'landline', dncListed: null }, READY, new Set(), OPEN);
  assert.equal(v.lane, LANES.RED);
  assert.match(v.reasons.join(' '), /unanswerable is not permission/);
});
test('a missing dncListed field is also a refusal', () => {
  const rec = { ...base, lineType: 'landline' };
  delete rec.dncListed;
  assert.equal(classify(rec, READY, new Set(), OPEN).dialable, false);
});
test('consent still clears a registry listing, because the registry governs solicitation', () => {
  const v = classify(
    { ...base, lineType: 'mobile', dncListed: true, consent: { grantedAt: '2026-08-01', scope: 'research_call', source: 'ring_test' } },
    READY, new Set(), OPEN);
  assert.equal(v.lane, LANES.GREEN);
});

console.log('\nOBLIGATIONS');
test('a dialable call always carries the four legal obligations', () => {
  const v = classify({ ...base, lineType: 'landline' }, READY, new Set(), OPEN);
  for (const o of ['identify_caller_at_open', 'state_callback_number', 'disclose_ai_at_open', 'announce_recording_if_recorded']) {
    assert.ok(v.obligations.includes(o), `missing ${o}`);
  }
});

// ── THE ROUND TRIP ───────────────────────────────────────────────────────────────────────────
// ★ This class of test is the only one that could have caught the real bug: the writer appended
// "+1512…  # caller said stop <timestamp>" and the reader put the WHOLE annotated line into the
// Set, so has('+1512…') was false for every number ever suppressed. A suppression test that
// builds the Set by hand passes happily while the file and the gate disagree forever.
console.log('\nSUPPRESSION ROUND TRIP (write it, then read it back through the gate)');
{
  const backup = await readFile(paths.suppression, 'utf8').catch(() => null);
  try {
    const num = '+15125550999';
    await suppress(num, 'said stop on call CA00000000000000000000000000000000');
    const set = await suppression();

    await (async () => test('the reader can find what the writer wrote', () => {
      assert.ok(set.has(num), `suppression() returned ${[...set].slice(0, 3).join(', ')} — the annotated line, not the number`);
    }))();

    await (async () => test('a suppressed number is RED through the real gate', () => {
      const v = classify({ ...base, phone: num, lineType: 'landline' }, READY, set, OPEN);
      assert.equal(v.lane, LANES.RED);
      assert.match(v.reasons.join(' '), /suppression/);
    }))();

    await (async () => test('comments and blank lines never become members', () => {
      assert.ok(![...set].some((x) => x.startsWith('#') || x === ''));
    }))();
  } finally {
    if (backup !== null) await writeFile(paths.suppression, backup, 'utf8');
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
