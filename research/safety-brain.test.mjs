// safety-brain.test.mjs — the hazard module.
//
// This is the one module where a false NEGATIVE is a person in a house with a gas leak and a
// confident voice booking them for Tuesday, and a false POSITIVE is hazard language dumped into a
// routine furnace tune-up. Both are tested here, and the positive controls exist so the suite can
// actually fail rather than pass by being empty.

import { strict as assert } from 'node:assert';
import { MODULES, modulesFor, moduleHealth } from '../netlify/functions/lib/brain-modules.mjs';
import { TEXT } from '../netlify/functions/lib/brain-text.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.error(`  FAIL  ${name}\n        ${e.message}`); }
};
const fires = (said) => modulesFor(said, new Set()).some((m) => m.name === 'safety');

console.log('safety brain\n');

// ── the module exists and is non-empty ──────────────────────────────────────────────────────────
t('safety module is registered', () => {
  assert.ok(MODULES.some(([n]) => n === 'safety'), 'no safety module in MODULES');
});
t('safety module is FIRST, so hazard knowledge lands before scheduling knowledge', () => {
  assert.equal(MODULES[0][0], 'safety');
});
t('safety text is present and substantial', () => {
  assert.ok(typeof TEXT.safety === 'string');
  assert.ok(TEXT.safety.length > 2000, `only ${TEXT.safety?.length} chars`);
});
t('moduleHealth reports safety as readable', () => {
  const h = moduleHealth().find((x) => x.name === 'safety');
  assert.ok(h && h.ok && h.bytes > 0);
});

// ── MUST FIRE: the way people actually report a hazard ──────────────────────────────────────────
for (const said of [
  'I smell gas',
  'i smell gas in the kitchen',
  "there's a gas smell by the furnace",
  'it smells like gas down here',
  'I think we have a gas leak',
  'smells like rotten eggs in the basement',
  'the carbon monoxide detector is going off',
  'our CO alarm keeps going off',
  'there is smoke coming out of the panel',
  'something smells like burning',
  'I think the furnace is on fire',
  'it shocked me when I touched it',
]) {
  t(`FIRES: ${said}`, () => assert.ok(fires(said), 'safety did not load'));
}

// ── MUST NOT FIRE: routine gas work, which is most of a trades line ──────────────────────────────
for (const said of [
  'I need a quote on a gas furnace',
  'we want to switch to a gas water heater',
  'can you run a gas line to the patio',
  'the gas fireplace needs servicing',
  'my gas bill is really high this month',
  'I need someone to look at the water heater',
  'the AC stopped cooling',
  'can I book a drain cleaning',
  // ★ MEASURED ON THE LIVE LINE 2026-08-16, and it is why bare spark words were removed from this
  // trigger. The hard crisis floor correctly stayed quiet on this sentence, but the module fired
  // on "sparks" and the model told a customer asking a routine question to evacuate the building.
  // A pilot light sparking as it lights is a furnace working correctly. The floor already requires
  // an electrical noun near a spark; the module has to agree with it, or the module re-opens the
  // false positive the floor was careful to avoid.
  'the pilot light sparks a bit when it lights, is that normal',
  'the pilot light sparked and then lit fine',
]) {
  t(`QUIET: ${said}`, () => assert.ok(!fires(said), 'safety loaded on a routine call'));
}

// ── POSITIVE CONTROL: prove the test can fail ────────────────────────────────────────────────────
t('POSITIVE CONTROL — a nonsense phrase does NOT fire safety', () => {
  assert.ok(!fires('zzzq wibble frobnicate'), 'trigger matches everything; the tests above are meaningless');
});
t('POSITIVE CONTROL — the fires() helper can return true at all', () => {
  assert.ok(fires('I smell gas'), 'fires() never returns true; every QUIET test above is vacuous');
});

// ── content the module must actually carry ───────────────────────────────────────────────────────
t('carries the verified CPSC order: outside FIRST, then call', () => {
  assert.match(TEXT.safety, /get outside to fresh air immediately, and then call 911/);
  assert.match(TEXT.safety, /Outside first, then the\ncall/);
});
t('forbids reassurance, which is the dangerous sentence', () => {
  assert.match(TEXT.safety, /NEVER REASSURE/);
  assert.match(TEXT.safety, /probably nothing/);
});
t('forbids coaching a procedure', () => {
  assert.match(TEXT.safety, /RECOGNITION, NOT INSTRUCTION/);
  assert.match(TEXT.safety, /Do not talk anyone through/);
});
t('forbids calling a CO alarm faulty', () => {
  assert.match(TEXT.safety, /Never suggest the alarm is faulty/);
});
t('forbids booking a job as the response to a hazard', () => {
  assert.match(TEXT.safety, /never book an appointment as the response to a hazard/i);
});
t('forbids qualifying questions before they are out', () => {
  assert.match(TEXT.safety, /DO NOT ASK QUALIFYING QUESTIONS FIRST/);
});

// ── append-once, same as every other module ──────────────────────────────────────────────────────
t('appends once per call, not once per turn', () => {
  const loaded = new Set();
  assert.equal(modulesFor('I smell gas', loaded).filter((m) => m.name === 'safety').length, 1);
  assert.equal(modulesFor('I still smell gas', loaded).filter((m) => m.name === 'safety').length, 0);
});
t('a hazard phrase that is also a trade phrase loads BOTH, safety first', () => {
  const got = modulesFor('I smell gas near the furnace', new Set()).map((m) => m.name);
  assert.ok(got.includes('safety'), 'safety missing');
  assert.ok(got.includes('trades'), 'trades missing');
  assert.ok(got.indexOf('safety') < got.indexOf('trades'), 'safety must append before trades');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
