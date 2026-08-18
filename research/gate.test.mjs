#!/usr/bin/env node
// gate.test.mjs — the legal gate is the one piece of this system that cannot be wrong.
//
//   node research/gate.test.mjs
//
// Every case here is a real decision the dialler will make. The negative cases matter more than
// the positive ones: this file exists to prove that uncertainty resolves to RED, never to "dial".

import assert from 'node:assert/strict';
import { classify, DEFAULT_POLICY, LANES, LICENSING_REQUIRED_STATES, BIOMETRIC_RISK_STATES, VERIFIED_STATES } from './lib/lane.mjs';
import { npasForState } from './lib/npa.mjs';
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

// dncListed false = checked against a fresh snapshot and not listed. null = could not check.
// ★ Oregon, not Ohio. The fixture used to sit in a state nobody had read, which meant every
// line-type, clock and registry case in this file was silently asserting against an unverified
// state — and once the gate started refusing those, nine tests failed at once for a reason that
// had nothing to do with what they were testing. The fixture state is now the one state of the
// four verified from primary text that a clean number actually passes, so each test below fails
// only for its own reason.
// `businessVerified` is on the base fixture for the same reason the DNC flags are on READY: it is
// a property the corpus supplies for every real row, and without it every case below would fail for
// a reason unrelated to what it tests. The business gate has its own section.
// ★ FIXTURE CORRECTED 2026-08-17. This read `phone: '+15125550142', state: 'OR'` — a TEXAS area
// code labelled Oregon — and every case in this file inherited it. It passed because nothing
// compared the two fields, which is exactly the defect `npa.mjs` now closes: state law was chosen
// from the listing and the subscription fence from the area code, and they were free to disagree.
// The test suite for the gate was itself carrying the confusion the gate had. 503 is Oregon.
const base = { phone: '+15035550142', state: 'OR', lookupOk: true, callCount30d: 0, dncListed: false, businessVerified: true };

// ★ A STATE OVERRIDE MUST BRING ITS OWN AREA CODE WITH IT.
// Every per-state case below used to write `{ ...base, state: 'TX' }` and keep base's phone, so it
// asserted Texas law against an Oregon number. The gate could not see it, because until 2026-08-17
// nothing compared the two fields. Rather than hand-typing a number per state — which is the same
// mistake with more chances to make it — the fixture is DERIVED from NANPA's own map, so a state
// can never again be tested against a number that does not belong to it.
// The subscription fence is a SEPARATE control with its own section at the end. A per-state case
// must not be able to pass or fail on it by accident, so it gets a policy that subscribes to the
// state it is testing, and nothing else changes.
const readyIn = (st) => ({ ...READY, subscribedAreaCodes: new Set(npasForState(st)) });

const inState = (st, rest = {}) => {
  const npas = npasForState(st);
  assert.ok(npas.length, `no NPA on file for ${st}; the fixture cannot be built`);
  return { ...base, state: st, phone: `+1${npas[0]}5550142`, ...rest };
};

// ★ The default policy now refuses EVERY non-consented call, because the do-not-call program does
// not exist yet and 47 CFR 64.1200(d) is a condition precedent. READY is the same policy with those
// two programs stood up, which is what the line-type and clock cases are actually about.
// `subscribedAreaCodes` is part of READY for the same reason the two DNC flags are: without it the
// 16 CFR 310.8(a) fence refuses everything, and every line-type, clock and consent case below would
// fail for a reason that has nothing to do with what it is testing. The fence gets its own section
// at the end, with its own explicit policies.
const READY = {
  ...DEFAULT_POLICY,
  dncScrubbed: true,
  dncProceduresInPlace: true,
  subscribedAreaCodes: new Set(['503', '971', '541', '458']),
};

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
    READY, new Set(['+15035550142']), OPEN,
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
    const v = classify(inState(st, { lineType: 'landline' }), readyIn(st), new Set(), OPEN);
    assert.equal(v.lane, LANES.RED);
    assert.match(v.reasons.join(' '), /registration and bond/);
  });
}
test('IL is refused while a voiceprint cannot be ruled out', () => {
  const v = classify(inState('IL', { lineType: 'landline' }), READY, new Set(), OPEN);
  assert.equal(v.lane, LANES.RED);
  assert.match(v.reasons.join(' '), /WRITTEN release/);
});
test('consent still clears the licensing states, because it is a different basis', () => {
  const v = classify(
    inState('TX', { lineType: 'mobile', consent: { grantedAt: '2026-08-01', scope: 'research_call', source: 'ring_test' } }),
    READY, new Set(), OPEN);
  assert.equal(v.lane, LANES.GREEN);
});
test('the licensing and biometric lists are the verified ones, not guesses', () => {
  // AZ joined this set on 2026-08-14 from primary text: A.R.S. 44-1272(A) binds "before the
  // seller solicits", and soliciting unregistered is a CLASS 5 FELONY under 44-1277(C).
  assert.deepEqual([...LICENSING_REQUIRED_STATES].sort(), ['AZ', 'FL', 'TX', 'WA']);
  assert.deepEqual([...BIOMETRIC_RISK_STATES], ['IL']);
});

console.log('\nTHE FOUR-STATE VERIFICATION, ENFORCED RATHER THAN NOTED');
test('CALIFORNIA is refused for an autonomous call, however clean the number is', () => {
  // The number itself is perfect: fixed business landline, registry-clear, inside the window.
  // California still refuses, because 2874 is about WHO SPEAKS FIRST, not about the number.
  const v = classify(inState('CA', { lineType: 'landline', dncListed: false }), READY, new Set(), OPEN);
  assert.equal(v.lane, LANES.RED);
  assert.match(v.reasons.join(' '), /2874|natural-voice/i);
});
test('CALIFORNIA opens the moment a live human really opens the call', () => {
  const v = classify(inState('CA', { lineType: 'landline', dncListed: false }),
    { ...readyIn('CA'), humanOpener: true }, new Set(), OPEN);
  assert.equal(v.dialable, true, v.reasons.join(' | '));
});
test('NEVADA is refused until the recording region is attested in writing', () => {
  const v = classify(inState('NV', { lineType: 'landline', dncListed: false }), READY, new Set(), OPEN);
  assert.equal(v.lane, LANES.RED);
  assert.match(v.reasons.join(' '), /all-party|NRS 200\.620/i);
});
test('ARIZONA is refused as a licensing gate, exactly like TX/WA/FL', () => {
  const v = classify(inState('AZ', { lineType: 'landline', dncListed: false }), READY, new Set(), OPEN);
  assert.equal(v.lane, LANES.RED);
  assert.match(v.reasons.join(' '), /registration/i);
});
test('OREGON is the one of the four that a clean number actually passes', () => {
  const v = classify(inState('OR', { lineType: 'landline', dncListed: false }), READY, new Set(), OPEN);
  assert.equal(v.dialable, true, v.reasons.join(' '));
});
test('AN UNREAD STATE IS REFUSED, however clean the number is', () => {
  // This is the seam that measuring the book exposed: 774 numbers in NY, PA, NC, MI, OH and VA
  // came back dialable under a gate that refuses everything else it cannot prove.
  for (const st of ['NY', 'PA', 'NC', 'MI', 'OH', 'VA']) {
    const v = classify(inState(st, { lineType: 'landline', dncListed: false }), readyIn(st), new Set(), OPEN);
    assert.equal(v.lane, LANES.RED, `${st} must be refused until somebody reads it`);
    assert.match(v.reasons.join(' '), /nobody has read/);
  }
});
test('the verified set is the states actually read, and it is not the same as the open set', () => {
  assert.deepEqual([...VERIFIED_STATES].sort(), ['AZ', 'CA', 'FL', 'IL', 'NV', 'OR', 'TX', 'WA']);
  // Verified does NOT mean open. Seven of the eight refuse; being on the list means the answer is
  // known rather than assumed, which is the only claim this set makes.
  const open = [...VERIFIED_STATES].filter((st) => classify(
    { ...base, state: st, lineType: 'landline', dncListed: false }, READY, new Set(), OPEN,
  ).dialable);
  assert.deepEqual(open, ['OR']);
});
test('the incentive offer is an OBLIGATION on the call, not a note in the script', () => {
  const v = classify(inState('OR', { lineType: 'landline', dncListed: false }), READY, new Set(), OPEN);
  assert.ok(v.obligations.includes('make_no_incentive_offer'));
  const cleared = classify(inState('OR', { lineType: 'landline', dncListed: false }),
    { ...READY, mayOfferIncentive: true }, new Set(), OPEN);
  assert.ok(!cleared.obligations.includes('make_no_incentive_offer'));
});
test('a state window floor can only tighten our window, never widen it', () => {
  // 08:30 Pacific is inside a hypothetical 8am campaign window but outside California's 9am floor.
  const eightThirtyPacific = new Date('2026-08-17T15:30:00Z'); // Monday, 08:30 PDT
  const wide = { ...READY, humanOpener: true, window: { ...READY.window, startHour: 8 } };
  const ca = classify(inState('CA', { lineType: 'landline', dncListed: false }), wide, new Set(), eightThirtyPacific);
  assert.equal(ca.dialable, false, 'CA must not be dialable at 08:30 even on an 8am campaign window');
  const or = classify(inState('OR', { lineType: 'landline', dncListed: false }), wide, new Set(), eightThirtyPacific);
  assert.equal(or.dialable, true, 'Oregon has no such floor and should still be dialable at 08:30');
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
    const num = '+15035550999';
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


// ★ THIS BLOCK ONCE SAT BELOW process.exit() AND THEREFORE NEVER RAN.
// Appending tests to the end of this file puts them after the summary and the exit, so they
// print nothing, assert nothing, and cannot fail. The only reason it was caught is that the
// pass count did not move when four tests were added — the assertions themselves were silent.
// If you add a section, add it ABOVE the summary, and check the count changes by what you expect.
console.log('\nTHE SUBSCRIPTION FENCE (16 CFR 310.8(a)) — a different violation from a bad scrub');
test('with no subscription on file, even a perfect number is refused', () => {
  // Explicitly strips subscribedAreaCodes back off READY: this is the case where the scrub and the
  // procedures are both in place and the ONLY thing missing is the subscription itself.
  const noSub = { ...READY, subscribedAreaCodes: null };
  const v = classify({ ...base, lineType: 'landline', dncListed: false }, noSub, new Set(), OPEN);
  assert.equal(v.lane, LANES.RED);
  assert.match(v.reasons.join(' '), /310\.8\(a\)|unsubscribed area code/);
});
test('a number OUTSIDE the subscribed area codes is refused, however clean it is', () => {
  // 458 is a real, valid, fixed business line in a verified-clean state, and it is genuinely an
  // OREGON code, so nothing else in the gate objects to it. It is still refused, because we never
  // bought that area code, and a flawless scrub is no defence for that.
  // ★ This case used a 512 (Texas) number until 2026-08-17. That made it pass for TWO reasons at
  // once, and a test that can pass for a reason it is not testing is not measuring what it claims.
  const pol = { ...READY, subscribedAreaCodes: new Set(['503', '971', '541']) };
  const v = classify({ ...base, phone: '+14585550142', lineType: 'landline', dncListed: false }, pol, new Set(), OPEN);
  assert.equal(v.lane, LANES.RED);
  assert.match(v.reasons.join(' '), /area code 458 is not in our do-not-call subscription/);
});
test('a number INSIDE the subscribed area codes passes', () => {
  const pol = { ...READY, subscribedAreaCodes: new Set(['503', '971', '541', '458']) };
  const v = classify({ ...base, phone: '+15035550142', lineType: 'landline', dncListed: false }, pol, new Set(), OPEN);
  assert.equal(v.dialable, true, v.reasons.join(' '));
});
test('AN OVERLAY IS A SECOND SUBSCRIPTION, NOT THE SAME ONE', () => {
  // The billable unit is the NPA, never the geography. 971 overlays 503 across identical ground,
  // so subscribing to 503 buys nothing for 971 and five free codes is not five markets.
  const pol = { ...READY, subscribedAreaCodes: new Set(['503']) };
  const v = classify({ ...base, phone: '+19715550142', lineType: 'landline', dncListed: false }, pol, new Set(), OPEN);
  assert.equal(v.lane, LANES.RED, '971 must not ride in on 503');
});


console.log('\nTHE HUMAN-DIALLED LANE (David 2026-08-14: keep the mobiles, we will be calling them)');
const HUMAN = { ...READY, humanDialed: true, subscribedAreaCodes: new Set(['503', '971', '541']) };
test('a mobile is REACHABLE when a person dials and a person speaks', () => {
  const v = classify({ ...base, lineType: 'mobile' }, HUMAN, new Set(), OPEN);
  assert.equal(v.dialable, true, v.reasons.join(' '));
  assert.match(v.reasons.join(' '), /HUMAN-DIALLED/);
});
test('the same mobile is still REFUSED to an artificial voice', () => {
  const v = classify({ ...base, lineType: 'mobile' }, READY, new Set(), OPEN);
  assert.equal(v.lane, LANES.RED);
  assert.match(v.reasons.join(' '), /64\.1200\(a\)\(1\)/);
});
test('the human lane must NOT claim an AI disclosure it will not make', () => {
  const v = classify({ ...base, lineType: 'mobile' }, HUMAN, new Set(), OPEN);
  assert.ok(!v.obligations.includes('disclose_ai_at_open'), 'there is no AI to disclose on this call');
  assert.ok(v.obligations.includes('no_artificial_voice_on_this_call'));
  assert.ok(v.obligations.includes('live_human_must_speak'));
  assert.ok(v.obligations.includes('announce_recording_if_recorded'), 'the AI still LISTENS; that disclosure never drops');
});
test('THE REGISTRY STILL BINDS ON A MOBILE — Chennette makes a contractor cell residential', () => {
  const listed = classify({ ...base, lineType: 'mobile', dncListed: true }, HUMAN, new Set(), OPEN);
  assert.equal(listed.lane, LANES.RED);
  const unknown = classify({ ...base, lineType: 'mobile', dncListed: null }, HUMAN, new Set(), OPEN);
  assert.equal(unknown.lane, LANES.RED, 'an unanswerable registry check is still a refusal');
});
test('STATE LAW STILL BINDS on the human lane — manual dialling cures none of it', () => {
  for (const st of ['AZ', 'TX', 'WA', 'FL', 'IL', 'NV']) {
    const v = classify({ ...base, state: st, lineType: 'mobile' }, HUMAN, new Set(), OPEN);
    assert.equal(v.lane, LANES.RED, `${st} must still refuse a human-dialled mobile`);
  }
  const ca = classify(inState('CA', { lineType: 'mobile' }), HUMAN, new Set(), OPEN);
  assert.equal(ca.lane, LANES.RED, 'CA still needs its opener');
  const unread = classify(inState('NY', { lineType: 'mobile' }), HUMAN, new Set(), OPEN);
  assert.equal(unread.lane, LANES.RED, 'an unread state is still a refusal');
});
test('the window, the cap, suppression and the subscription fence all still bind', () => {
  assert.equal(classify({ ...base, lineType: 'mobile' }, HUMAN, new Set(), SHUT).lane, LANES.HOLD);
  assert.equal(classify({ ...base, lineType: 'mobile', callCount30d: 1 }, HUMAN, new Set(), OPEN).lane, LANES.RED);
  assert.equal(classify({ ...base, lineType: 'mobile' }, HUMAN, new Set(['+15035550142']), OPEN).lane, LANES.RED);
  // 458 is Oregon, so the jurisdiction check is satisfied and the SUBSCRIPTION is the only thing
  // left to refuse it. (This was 212 — New York — which was refused three ways over.)
  const offNpa = classify({ ...base, phone: '+14585550142', lineType: 'mobile' }, HUMAN, new Set(), OPEN);
  assert.equal(offNpa.lane, LANES.RED, '458 is not in the subscription');
  assert.match(offNpa.reasons.join(' '), /not in our do-not-call subscription/);
});
test('the human lane does NOT quietly widen anything else', () => {
  // nonFixedVoip, unknown, voicemail and a failed lookup stay refused. The lane relaxes line-type
  // reachability for MOBILES and nothing more; a scope change beyond that is David's to make.
  for (const lt of ['nonFixedVoip', 'unknown', 'voicemail']) {
    assert.equal(classify({ ...base, lineType: lt }, HUMAN, new Set(), OPEN).dialable, false, `${lt} must stay refused`);
  }
  assert.equal(classify({ ...base, lineType: 'landline', lookupOk: false }, HUMAN, new Set(), OPEN).dialable, false);
  assert.equal(classify({ ...base, lineType: 'tollFree' }, HUMAN, new Set(), OPEN).dialable, false);
});

console.log('\nBUSINESS USE IS A DIFFERENT QUESTION FROM LINE TYPE');
test('a perfect fixed line that is NOT verified as a business is refused', () => {
  // Mo. Rev. Stat. 407.1095(2) defines a residential subscriber by USE. A landline in a sole
  // proprietor's kitchen is residential, and every B2B carve-out we rely on fails on it.
  const v = classify({ ...base, lineType: 'landline', businessVerified: undefined }, READY, new Set(), OPEN);
  assert.equal(v.lane, LANES.RED);
  assert.match(v.reasons.join(' '), /BUSINESS number|technology rather than the use/);
});
test('a MISSING businessVerified is a refusal, not a default yes', () => {
  const rec = { ...base, lineType: 'landline' };
  delete rec.businessVerified;
  assert.equal(classify(rec, READY, new Set(), OPEN).dialable, false);
});
test('businessVerified false is refused as firmly as absent', () => {
  assert.equal(classify({ ...base, lineType: 'landline', businessVerified: false }, READY, new Set(), OPEN).dialable, false);
});
test('a truthy-but-not-true value does not satisfy it', () => {
  // presence, never truthiness, for a control whose absence means permission
  assert.equal(classify({ ...base, lineType: 'landline', businessVerified: 'yes' }, READY, new Set(), OPEN).dialable, false);
});
test('the business gate binds on the HUMAN lane too', () => {
  const HUMAN2 = { ...READY, humanDialed: true };
  assert.equal(classify({ ...base, lineType: 'mobile', businessVerified: false }, HUMAN2, new Set(), OPEN).dialable, false);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
