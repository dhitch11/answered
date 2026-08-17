// brain-modules-es.test.mjs — the Spanish knowledge modules and their language scoping.
//
// ★ THE SCOPING IS THE POINT OF THIS FILE. Several trigger words are shared across the two
// languages - "gas", "breaker", "AC", "clima" - so without a language argument an ENGLISH module
// loads on a Spanish call and drops four thousand characters of English prose into the prompt
// mid-sentence. These tests pin that it cannot happen in either direction.

import { strict as assert } from 'node:assert';
import { MODULES, modulesFor } from '../netlify/functions/lib/brain-modules.mjs';
import { TEXT } from '../netlify/functions/lib/brain-text.mjs';
import { PERSONAS } from '../netlify/functions/lib/personas.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.error(`  FAIL  ${name}\n        ${e.message}`); }
};
const es = (said) => modulesFor(said, new Set(), 'es').map((m) => m.name);
const en = (said) => modulesFor(said, new Set(), 'en').map((m) => m.name);

console.log('spanish knowledge modules\n');

const SPANISH = ['trades_es', 'human_range_es', 'money_es', 'scheduling_es', 'safety_es', 'upset_es'];

for (const k of SPANISH) {
  t(`${k}: registered, tagged 'es', and non-empty`, () => {
    const row = MODULES.find(([n]) => n === k);
    assert.ok(row, `${k} not in MODULES`);
    assert.equal(row[3], 'es', `${k} is not tagged as Spanish`);
    assert.ok(typeof TEXT[k] === 'string' && TEXT[k].length > 2500, `${k} text is ${TEXT[k]?.length}`);
  });
}

// ── LANGUAGE SCOPING, BOTH DIRECTIONS ────────────────────────────────────────────────────────────
t('the Spanish persona declares its language', () => {
  assert.equal(PERSONAS.customer_es.lang, 'es');
});
t('English personas default to English without declaring it', () => {
  for (const id of ['riley', 'scout', 'onboard', 'customer']) {
    assert.ok(!PERSONAS[id].lang || PERSONAS[id].lang === 'en', `${id} claims a non-English language`);
  }
});
t('a Spanish call never loads an English module', () => {
  for (const s of ['huele a gas cerca del calentador', 'se botó el breaker', 'el aire no enfría',
                   'cuánto cobran', 'quiero una cita hoy']) {
    const loaded = es(s);
    const english = loaded.filter((n) => !n.endsWith('_es'));
    assert.equal(english.length, 0, `"${s}" pulled English modules: ${english.join(', ')}`);
  }
});
t('an English call never loads a Spanish module', () => {
  for (const s of ['I smell gas near the furnace', 'the breaker tripped', 'how much do you charge',
                   'can you come out today']) {
    const loaded = en(s);
    const spanish = loaded.filter((n) => n.endsWith('_es'));
    assert.equal(spanish.length, 0, `"${s}" pulled Spanish modules: ${spanish.join(', ')}`);
  }
});
t('the shared word "gas" routes to the right language on each side', () => {
  assert.ok(en('I smell gas').includes('safety'), 'English safety missing');
  assert.ok(!en('I smell gas').some((n) => n.endsWith('_es')), 'Spanish leaked into English');
  assert.ok(!es('huele a gas').some((n) => !n.endsWith('_es')), 'English leaked into Spanish');
});

// ── MUST FIRE ────────────────────────────────────────────────────────────────────────────────────
const FIRE = {
  trades_es: ['se tapó el fregadero', 'no hay agua caliente', 'el aire no enfría', 'se botó el breaker',
              'gotea el techo', 'la lavadora no saca el agua'],
  human_range_es: ['está lloviendo bien fuerte', 'hace un frío horrible', 'ando manejando ahorita'],
  money_es: ['cuánto cobran por venir', 'me da un aproximado', 'está muy caro'],
  scheduling_es: ['quiero una cita', 'pueden venir mañana', 'el portón tiene código'],
  upset_es: ['ya van tres veces', 'quiero un reembolso', 'quiero hablar con el dueño'],
  // ★ safety_es fires on the MINIMISER, not the hazard: the hazard ends the call before the model.
  safety_es: ['no creo que sea nada pero huele raro', 'es poquito nada más', 'siempre lo hace'],
};
for (const [k, lines] of Object.entries(FIRE)) {
  for (const s of lines) t(`FIRES ${k}: ${s}`, () => assert.ok(es(s).includes(k), `loaded: ${es(s).join(', ') || 'nothing'}`));
}

// ── the division of labour with the crisis floor ─────────────────────────────────────────────────
t('a clear hazard is the FLOOR\'s job, not the safety module\'s', () => {
  // "huele a gas" ends the call in deterministicLine before any module is consulted. The module is
  // the narrow band the floor cannot catch, so it must NOT be what fires on the obvious case.
  const p = PERSONAS.customer_es;
  const branch = (p.inBranches || []).find((b) => b.by === 'crisis');
  assert.ok(branch.test('huele a gas en la cocina'), 'the floor does not catch the obvious hazard');
});

// ── POSITIVE CONTROLS ────────────────────────────────────────────────────────────────────────────
t('POSITIVE CONTROL — nonsense loads nothing in either language', () => {
  assert.equal(es('zzzq wibble frobnicate').length, 0);
  assert.equal(en('zzzq wibble frobnicate').length, 0);
});
t('POSITIVE CONTROL — every Spanish module can fire at least once', () => {
  for (const [k, lines] of Object.entries(FIRE)) {
    assert.ok(es(lines[0]).includes(k), `${k} never fires; its scoping tests are vacuous`);
  }
});
t('append once per call, in Spanish too', () => {
  const loaded = new Set();
  assert.equal(modulesFor('se tapó el fregadero', loaded, 'es').filter((m) => m.name === 'trades_es').length, 1);
  assert.equal(modulesFor('sigue tapado el fregadero', loaded, 'es').filter((m) => m.name === 'trades_es').length, 0);
});
t('a bare greeting loads nothing', () => {
  for (const s of ['hola', 'buenos días', 'bueno', 'aló']) {
    assert.equal(es(s).length, 0, `something fired on "${s}"`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
