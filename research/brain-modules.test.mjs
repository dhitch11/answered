// research/brain-modules.test.mjs — do the knowledge modules load when they should, and only then?
import assert from 'node:assert/strict';
import { modulesFor, moduleHealth, MODULES } from '../netlify/functions/lib/brain-modules.mjs';

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); console.log(`  ok   ${n}`); pass++; } catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };
const fire = (s) => { const l = new Set(); return modulesFor(s, l).map((m) => m.name).sort().join('+') || 'none'; };

console.log('\n── the knowledge is actually on disk ──');
t('every module reads non-empty', () => {
  for (const h of moduleHealth()) assert.ok(h.ok && h.bytes > 500, `${h.name} is ${h.bytes} bytes — a module that reads empty is a brain with nothing in it`);
});

console.log('\n── triggers fire on what a homeowner actually says ──');
for (const [said, want] of [
  ['My water heater is leaking', 'trades'],
  ['no hot water since last night', 'trades'],
  ['the breaker keeps tripping', 'trades'],
  ['there is a burning smell from the outlet', 'trades'],
  ['half the shingles came off', 'trades'],
  ['my kid gets home at three', 'human_range'],
  ['did you catch the game', 'human_range'],
  ['the heat pump is out and my son is home', 'human_range+trades'],
]) t(`${JSON.stringify(said)} -> ${want}`, () => assert.equal(fire(said), want));

console.log('\n── NEGATIVE CONTROLS: it must not fire on everything ──');
for (const [said, want] of [
  ['I need to book something', 'none'],
  ['it is wheat season', 'none'],          // caught by this suite before it shipped
  ['can you hear me okay', 'none'],
  ['', 'none'],
]) t(`${JSON.stringify(said)} -> ${want}`, () => assert.equal(fire(said), want));

console.log('\n── append-once, because repetition is the most machine-like thing a voice does ──');
t('the same trigger twice appends only once', () => {
  const l = new Set();
  assert.equal(modulesFor('water heater', l).length, 1);
  assert.equal(modulesFor('water heater is still leaking', l).length, 0, 'a module re-appended and will make the model repeat itself');
});

t('a second, different module still loads later in the same call', () => {
  const l = new Set();
  modulesFor('water heater', l);
  assert.equal(modulesFor('my daughter is home', l).map((m) => m.name).join(''), 'human_range',
    'once one module loaded, later modules stopped loading — the whole point is mid-call growth');
});

console.log(`\n${fail ? 'FAILED' : 'PASSED'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
