#!/usr/bin/env node
// The leak firewall is the only thing standing between a model and the one promise this product
// makes. So it is tested on its own, adversarially, in every form a person writes money in, and
// with a positive control: a check that cannot fail is worth nothing.
import { leakCheck } from './parley-agent.mjs';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`}`);
};
const leaks = (text, secret) => Boolean(leakCheck(text, secret));

console.log('\nLEAK FIREWALL\n' + '─'.repeat(58));

// ── it must CATCH the number in every shape ────────────────────────────────
t('plain digits',              leaks('I can do 1400 and not a dollar less', 1400), true);
t('comma grouped',             leaks('my floor is 1,400 here', 1400), true);
t('dollar sign',               leaks('$1400 is where I stop', 1400), true);
t('dollar and comma',          leaks('$1,400 is the number', 1400), true);
t('two decimal places',        leaks('exactly 1400.00', 1400), true);
t('k shorthand',               leaks('I can go to 1.4k', 1400), true);
t('spoken hundreds',           leaks('fourteen hundred is my limit', 1400), true);
t('spoken thousands',          leaks('eight thousand would work', 8000), true);
t('inside a sentence',         leaks('honestly anything over 350 works for me', 350), true);
t('capitalised spoken',        leaks('Fourteen Hundred, final', 1400), true);

// ── it must NOT fire on numbers that are not the secret ────────────────────
t('a different number',        leaks('how about 1500', 1400), false);
t('the secret as a substring', leaks('the VIN ends 21400X', 1400), false);
t('longer number containing it', leaks('call me on 5551400999', 1400), false);
t('decimal continuation',      leaks('it is 1400.5 miles away', 1400), false);
t('no number at all',          leaks('let me check with him and come back', 1400), false);
t('the public opening',        leaks('his asking price is 1800', 1400), false);

// ── the boundary cases that decide whether it is usable ────────────────────
t('null secret never leaks',   leaks('anything at all', null), false);
t('zero handled',              leaks('I can do 1400', 0), false);
t('reports WHICH form matched', leakCheck('I can do $1,400', 1400) !== null, true);

// ── POSITIVE CONTROL: prove the instrument can report both answers ────────
// A firewall that always says "leak" would pass every catch test above and be useless.
const alwaysFires = ['1400', '1500', 'nothing numeric here'].every((s) => leaks(s, 1400));
t('CONTROL: does not fire on everything', alwaysFires, false);
const neverFires = !['1400', '$1,400', 'fourteen hundred'].some((s) => leaks(s, 1400));
t('CONTROL: does fire on something', neverFires, false);

console.log('─'.repeat(58));
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
