// research/brain-wired.test.mjs — is the knowledge loader ACTUALLY reached by the serving path?
//
// brain-modules.mjs shipped orphaned: nothing imported it. Every unit test on it passed, because
// they tested the module in isolation. A caller could say "my water heater is leaking" and the
// trades knowledge sat on disk unread. This asserts the WIRING, which is the thing that was missing.
import assert from 'node:assert/strict';
import fs from 'node:fs';

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); console.log(`  ok   ${n}`); pass++; } catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };
const src = fs.readFileSync(new URL('../netlify/functions/answered-brain.mjs', import.meta.url), 'utf8');

console.log('\n── the serving path must import and call the loader ──');
t('answered-brain imports brain-modules', () => {
  assert.match(src, /import \{ modulesFor \} from '\.\/lib\/brain-modules\.mjs'/,
    'the loader is orphaned again: knowledge exists on disk and no call can reach it');
});
t('it calls modulesFor with the caller\'s latest turn', () => {
  assert.match(src, /modulesFor\(lastUser,/, 'the loader is imported but never called, which is the same defect wearing a nicer hat');
});
t('what it returns is appended to the system prompt', () => {
  assert.match(src, /for \(const m of fresh\) system \+= /, 'modules are computed and then discarded');
});

console.log('\n── ORDER: knowledge appends AFTER the spec ──');
t('the append happens after `let system = persona.spec`', () => {
  const spec = src.indexOf('let system = persona.spec');
  const app = src.indexOf('for (const m of fresh) system +=');
  assert.ok(spec > 0 && app > spec, 'knowledge must not precede the persona floor, or it could override a rule');
});
t('and BEFORE the owner notes and soft-close, so the cached prefix stays stable', () => {
  const app = src.indexOf('for (const m of fresh) system +=');
  const owner = src.indexOf('if (incomingSystem) system +=');
  assert.ok(app < owner, 'modules must sit directly after the spec so the cacheable prefix is contiguous');
});

console.log('\n── the loaded-set must not leak between callers ──');
t('module state is derived from the transcript, not module scope', () => {
  assert.match(src, /function moduleState\(inMsgs\)/, 'no per-call state function');
  assert.ok(!/^const loaded = new Set\(\)/m.test(src),
    'a module-scope Set would carry one caller\'s loaded modules into the next caller\'s call');
});
t('it excludes the newest turn, which is the one being evaluated now', () => {
  assert.match(src, /turns\.slice\(0, -1\)/,
    'if the newest turn were included, its modules would count as already-loaded and never append');
});

console.log('\n── the modules themselves still ship ──');
t('the knowledge is IMPORTED, not read from disk at runtime', () => {
  const loader = fs.readFileSync(new URL('../netlify/functions/lib/brain-modules.mjs', import.meta.url), 'utf8');
  assert.match(loader, /import \{ TEXT \} from '\.\/brain-text\.mjs'/,
    'the loader must import its content — a runtime fs read is invisible to the bundler and ships empty');
  assert.ok(!/readFileSync/.test(loader),
    'a runtime file read is back: a real call proved the bundler cannot see it (ENOENT on /var/task/brain/)');
});

console.log(`\n${fail ? 'FAILED' : 'PASSED'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
