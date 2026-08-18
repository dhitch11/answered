// npa-jurisdiction.test.mjs — the gate must resolve WHICH jurisdiction a number is in before it
// applies any jurisdiction's law.
//
// ═══ THE DEFECT THIS PINS ═══
//
// `classify()` chose state law from `rec.state` (the published business listing) and chose the
// do-not-call subscription fence from `rec.phone.slice(2,5)` (the area code). Nothing compared
// them. In the live corpus they disagree on 2,513 rows, including 368 rows labelled OR carrying
// area code 360 — Washington, where RCW 19.158.050 requires a solicitor registration and bars an
// unregistered solicitor from maintaining or defending a lawsuit in state.
//
// It was invisible because it was masked by a SECOND unfinished thing: `subscribedAreaCodes` is
// null, so the fence refuses every number for an unrelated reason. The masking ends the moment a
// real DNC subscription is loaded, which is the one action standing between this program and its
// first call. So the bug's arming condition is the same event as the program's go-live.

import { strict as assert } from 'node:assert';
import { classify, DEFAULT_POLICY, LANES } from '../research/lib/lane.mjs';
import { jurisdictionAgrees, npaFacts, npasForState, NPA_SOURCE } from '../research/lib/npa.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.error(`  FAIL  ${name}\n        ${e.message}`); }
};

console.log('npa <-> state jurisdiction coherence\n');

// ── the data itself ──────────────────────────────────────────────────────────────────────────────
t('the NANPA source is recorded with its file date, not just pasted in', () => {
  assert.match(NPA_SOURCE.source, /nanpa\.com/);
  assert.match(NPA_SOURCE.fileDate, /^\d{2}\/\d{2}\/\d{4}$/);
  assert.ok(NPA_SOURCE.rows > 500, `only ${NPA_SOURCE.rows} NPAs loaded`);
});
t('Oregon has exactly four in-service general-purpose NPAs', () => {
  assert.deepEqual(npasForState('OR'), ['458', '503', '541', '971']);
});
t('and four fits inside the five free area codes of 16 CFR 310.8(c)', () => {
  assert.ok(npasForState('OR').length <= 5,
    'the free-subscription finding this program is planned around no longer holds');
});
t('POSITIVE CONTROL — other states have the counts a real map would give', () => {
  assert.equal(npasForState('WA').length, 6);   // 206 253 360 425 509 564
  assert.ok(npasForState('CA').length > 30, 'California should have dozens');
  assert.equal(npasForState('ZZ').length, 0);
});
t('a toll-free code is not a geography', () => {
  for (const n of ['800', '888', '877', '866', '855', '844', '833']) {
    assert.equal(npaFacts(n).geographic, false, `${n} was treated as geographic`);
  }
});

// ── the comparison, with its failure classes ─────────────────────────────────────────────────────
const J = (phone, st) => jurisdictionAgrees(phone, st);

t('agreement passes', () => {
  const r = J('+15035550100', 'OR');
  assert.equal(r.ok, true);
  assert.equal(r.why, null);
});
t("a foreign NPA on an OR listing is a 'state' disagreement, not an NPA fault", () => {
  const r = J('+13605550100', 'OR');
  assert.equal(r.ok, false);
  assert.equal(r.why, 'state');
  assert.equal(r.npaState, 'WA');
});
for (const [label, phone, why] of [
  ['a Canadian NPA that passes the +1 regex', '+15145550100', 'npa'],
  ['an NPA that is not an area code at all',  '+11545550100', 'npa'],
  ['a toll-free number',                      '+18005550100', 'npa'],
]) {
  t(`${label} fails as 'npa', so it is refused even with consent`, () => {
    const r = J(phone, 'OR');
    assert.equal(r.ok, false);
    assert.equal(r.why, why);
  });
}
t('the reason names both signals so an auditor can see the conflict', () => {
  const r = J('+13605550100', 'OR');
  assert.match(r.reason, /\bOR\b/);
  assert.match(r.reason, /\bWA\b/);
  assert.match(r.reason, /360/);
});

// ── through the real gate ────────────────────────────────────────────────────────────────────────
// Wednesday 11:00 America/Los_Angeles. The policy is the one that exists AFTER the SAN lands,
// because that is the only configuration in which this defect is reachable.
const at = new Date('2026-08-19T18:00:00Z');
const armed = {
  ...DEFAULT_POLICY, dncScrubbed: true, dncProceduresInPlace: true,
  subscribedAreaCodes: new Set(['458', '503', '541', '971', '360', '509', '208']),
};
const base = { lineType: 'landline', lookupOk: true, consent: null, callCount30d: 0,
               dncListed: false, businessVerified: true };

t('★ THE DEFECT: an OR listing on a Washington area code is REFUSED', () => {
  const v = classify({ ...base, phone: '+13605550100', state: 'OR' }, armed, new Set(), at);
  assert.equal(v.dialable, false, 'a WA number was about to be called under Oregon law');
  assert.match(v.reasons.join(' '), /360 belongs to WA|two different bodies of law/);
});
t('a genuine Oregon number still passes the gate', () => {
  const v = classify({ ...base, phone: '+15035550100', state: 'OR' }, armed, new Set(), at);
  assert.equal(v.dialable, true, v.reasons.join(' | '));
  assert.equal(v.lane, LANES.AMBER);
});
t('a Canadian number is refused even WITH valid consent', () => {
  const v = classify({
    ...base, phone: '+15145550100', state: 'OR',
    consent: { grantedAt: '2026-08-01T00:00:00Z', expiresAt: null, scope: 'research_call', source: 'sms', written: true },
  }, armed, new Set(), at);
  assert.equal(v.dialable, false, 'consent was read as a choice of law');
  assert.match(v.reasons.join(' '), /CANADA|not the governing statute/i);
});
t('consent still works on a coherent US number', () => {
  const v = classify({
    ...base, phone: '+15035550100', state: 'OR', lineType: 'mobile',
    consent: { grantedAt: '2026-08-01T00:00:00Z', expiresAt: null, scope: 'research_call', source: 'sms', written: true },
  }, armed, new Set(), at);
  assert.equal(v.dialable, true, `consent path broke: ${v.reasons.join(' | ')}`);
  assert.equal(v.lane, LANES.GREEN);
});

// ── POSITIVE CONTROLS: prove the new check is what refuses, not something else ────────────────────
t('POSITIVE CONTROL — the WA-number refusal is the JURISDICTION check, not the area-code fence', () => {
  // 360 is deliberately IN subscribedAreaCodes above, so the fence cannot be what stopped it.
  assert.ok(armed.subscribedAreaCodes.has('360'), 'the control is not set up correctly');
  const v = classify({ ...base, phone: '+13605550100', state: 'OR' }, armed, new Set(), at);
  assert.doesNotMatch(v.reasons.join(' '), /not in our do-not-call subscription/);
});
t('POSITIVE CONTROL — before this check existed, that number was dialable', () => {
  // Same record, but told the truth about its state: WA is a licensing state, so it must STILL
  // refuse — for a different, correct reason. If this ever passes as dialable, the state rules
  // have been lost, not just the coherence check.
  const v = classify({ ...base, phone: '+13605550100', state: 'WA' }, armed, new Set(), at);
  assert.equal(v.dialable, false);
  assert.match(v.reasons.join(' '), /registration and bond/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
