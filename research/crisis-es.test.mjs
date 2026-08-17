// crisis-es.test.mjs — the Spanish caller-side hazard floor.
//
// Every QUIET case below is a real false positive found by adversarial review of a first attempt,
// or a case that attempt got wrong. They are not hypotheticals: an eight-agent build-and-attack pass
// on 2026-08-17 measured the first Spanish water floor ending 34 of 50 ordinary paying calls, which
// is why water is not in this file at all.

import { strict as assert } from 'node:assert';
import { crisisEs, normalise, CRISIS_ES_KINDS } from '../netlify/functions/lib/crisis-es.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.error(`  FAIL  ${name}\n        ${e.message}`); }
};
const fires = (s) => crisisEs(s).hit;

console.log('spanish crisis floor\n');

// ── MUST END THE CALL ────────────────────────────────────────────────────────────────────────────
const HAZARD = [
  ['huele a gas en la cocina', 'gas-smell'],
  ['hay un olor fuerte a gas', 'gas-smell'],
  ['huelo gas', 'gas-smell'],
  ['creo que tengo una fuga de gas', 'gas-leak'],
  ['hay un escape de gas', 'gas-leak'],
  ['se está saliendo el gas de la estufa', 'gas-leak'],
  ['huele a huevo podrido en el sótano', 'gas-smell'],
  ['el detector de monóxido está sonando', 'co'],
  ['mi detector de CO está pitando', 'co'],
  ['el detector de carbon monoxide se activó', 'co'],
  ['el detector de gas está sonando', 'gas-alarm'],
  ['hay fuego en la cocina', 'fire'],
  ['se está quemando algo', 'fire'],
  ['se prendió fuego el garage', 'fire'],
  ['huele a quemado', 'burning'],
  ['sale humo del panel', 'smoke'],
  ['hay humo en toda la casa', 'smoke'],
  ['el contacto está echando chispas', 'electrical'],
  ['me dio un toque el cable', 'electrical'],
  ['hay un corto circuito', 'electrical'],
];
for (const [s, kind] of HAZARD) {
  t(`ENDS CALL (${kind}): ${s}`, () => {
    const r = crisisEs(s);
    assert.equal(r.hit, true, 'did not fire');
    assert.equal(r.by, kind, `fired as ${r.by}`);
  });
}

// ── MUST NOT END THE CALL. Ordinary paying work. ────────────────────────────────────────────────
const ROUTINE = [
  // ★ THE BEST CATCH OF THE REVIEW: chispear means to DRIZZLE in Mexican and Central American
  // Spanish. A first draft matched the stem chisp\w* and would have evacuated a house over weather.
  'está chispeando afuera',
  'nomás está chispeando, no llueve fuerte',
  // gas as ordinary paid work
  'necesito un calentador de gas nuevo',
  'quiero precio por una línea de gas',
  'la estufa de gas no prende',
  'mi recibo del gas está muy alto',
  'quiero cambiar de eléctrico a gas',
  // a dead detector is a service call
  'el detector de gas no está encendido',
  'quiero instalar un detector de humo',
  'el detector de humo no sirve',
  // sulfur in the WATER is an anode rod, the commonest plumbing call this could have killed
  'el agua huele a huevo podrido',
  'el calentador de agua huele a huevo podrido',
  'el agua caliente huele a azufre',
  'el drenaje huele a azufre',
  // cooking and fireplaces
  'se me quemó la comida en el horno',
  'huele a quemado la comida',
  'sale humo del asador',
  'la chimenea saca humo',
  // negation inverts the hazard without changing the words
  'no agarró fuego el calentador',
  'no huele a gas ya',
  // ordinary trade
  'necesito servicio para el aire',
  'se tapó el fregadero de la cocina',
];
for (const s of ROUTINE) t(`KEEPS CALL: ${s}`, () => assert.equal(fires(s), false, `hung up (${crisisEs(s).by})`));

// ── the specific engineering faults the review named ─────────────────────────────────────────────
t('REGRESSION: accents work decomposed (NFD) as well as precomposed', () => {
  const nfc = 'el detector de monóxido está sonando';
  const nfd = nfc.normalize('NFD');
  assert.notEqual(nfc, nfd, 'the two forms are identical; this test proves nothing');
  assert.equal(fires(nfc), true, 'NFC failed');
  assert.equal(fires(nfd), true, 'NFD failed — normalise() is not running');
});
t('REGRESSION: whitespace is not one space', () => {
  assert.equal(fires('huele   a    gas'), true, 'multiple spaces failed');
  assert.equal(fires('huele\na gas'), true, 'newline failed');
});
t('REGRESSION: negation is judged on the clause, not a character window', () => {
  assert.equal(fires('no agarró fuego el calentador'), false);
  // and a negation in a DIFFERENT clause must not excuse a real hazard
  assert.equal(fires('no puedo salir. huele a gas'), true, 'a negation in another clause suppressed a real hazard');
});
t('REGRESSION: sparks fire as a noun, never as the drizzle verb', () => {
  assert.equal(fires('el enchufe está echando chispas'), true);
  assert.equal(fires('está chispeando'), false);
  assert.equal(fires('chispea desde ayer'), false);
});
t('monóxido fires BARE; a gas detector needs an alarm word', () => {
  assert.equal(fires('monóxido'), true, 'a CO alarm IS the evidence');
  assert.equal(fires('me pueden cotizar un detector de gas'), false, 'a sale ended the call');
});

// ── the deliberate disagreement, pinned so it is a decision and not a drift ──────────────────────
t('DECISION: a bare "calentador" with a rotten-egg smell ENDS the call', () => {
  assert.equal(fires('el calentador huele a huevo podrido'), true,
    'this is deliberate: rotten egg is the odorant added to natural gas, and a bare calentador is as often a gas appliance as a water tank');
  assert.equal(fires('el calentador de agua huele a huevo podrido'), false,
    'when the caller names the WATER heater we believe them');
});

// ── scope: what this floor deliberately does NOT cover ───────────────────────────────────────────
t('SCOPE: water is deliberately absent, and that is recorded here', () => {
  // On a plumbing line the hazard vocabulary IS the routine vocabulary. The first attempt at a
  // Spanish water floor ended 34 of 50 ordinary calls. These stay live rather than hang up.
  for (const s of ['se está inundando el sótano', 'se reventó un tubo', 'hay agua por todos lados']) {
    assert.equal(fires(s), false, `water fired on "${s}" — the water floor was not supposed to ship`);
  }
});

// ── POSITIVE CONTROLS ────────────────────────────────────────────────────────────────────────────
t('POSITIVE CONTROL — the floor can fire and can stay quiet', () => {
  assert.equal(fires('huele a gas'), true);
  assert.equal(fires('quiero una cotización'), false);
  assert.equal(fires(''), false);
  assert.equal(fires(null), false);
});
t('POSITIVE CONTROL — normalise collapses whitespace and NFC-folds', () => {
  assert.equal(normalise('  a   b  '), 'a b');
  assert.equal(normalise('món'.normalize('NFD')), 'món'.normalize('NFC'));
});
t('every rule kind is exercised by at least one HAZARD case', () => {
  const covered = new Set(HAZARD.map(([, k]) => k));
  const missing = CRISIS_ES_KINDS.filter((k) => !covered.has(k));
  assert.equal(missing.length, 0, `rule kinds with no test: ${missing.join(', ')}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
