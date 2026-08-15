#!/usr/bin/env node
// The owner's instructions must survive being longer than the budget.
//
// The defect this guards (reported by @LANE-SEARCHLIGHT, verified before fixing): the bridge did
// `incomingSystem.slice(0, 4000)`, keeping the head and dropping the tail in silence. People put
// their caveats LAST, so a head-slice throws away exactly the lines that say "never quote a price"
// and "do not promise a same-day visit".
//
// ★ THE SENTINEL IS AT THE END ON PURPOSE. A test asserting `system.length > 0`, or that the FIRST
// line survived, passes forever against the broken version and proves nothing.

import { fitOwnerNotes } from '../answered-brain.mjs';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
};

const persona = { id: 'customer' };
const SENTINEL = 'NEVER QUOTE A PRICE OVER THE PHONE.';
const long = 'Filler about the business. '.repeat(200) + '\n' + SENTINEL;   // ~5,200 chars

console.log('\nOWNER NOTES THAT DO NOT FIT\n' + '─'.repeat(58));
console.log(`input is ${long.length} characters against a 4,000 budget`);

const out = fitOwnerNotes(long, persona);

// 1. THE ONE THAT WAS FAILING. The last line is the whole point.
t('the LAST line of the owner notes survives', out.includes(SENTINEL),
  out.includes(SENTINEL) ? 'the caveat at the end is present' : 'the caveat was dropped, which is the defect');

// 2. The beginning survives too, so this is not a tail-slice with the same bug reversed.
t('the beginning also survives', out.startsWith('Filler about the business.'));

// 3. The model is TOLD, so it does not answer confidently from half a brief.
t('the model is told something was left out', /too long to include/i.test(out));
t('and told what to do about it', /check with the owner/i.test(out));

// 4. It genuinely fits.
t('the result is within budget', out.length <= 4000 + 400,
  `${out.length} characters including the notice`);

// 5. POSITIVE CONTROL: notes that FIT must come through completely untouched. A function that
//    always injected a "we dropped some" notice would pass every check above and would be lying on
//    every short brief.
const short = 'We do not do mobile homes. Always ask for a photo.';
const kept = fitOwnerNotes(short, persona);
t('CONTROL: short notes pass through byte-identical', kept === short,
  kept === short ? 'unchanged, so the notice is not injected when nothing was dropped' : `changed to: ${kept.slice(0, 80)}`);

// 6. A boundary that would hide an off-by-one.
const exact = 'x'.repeat(4000);
t('CONTROL: exactly at the limit is untouched', fitOwnerNotes(exact, persona) === exact);
t('one over the limit IS trimmed', fitOwnerNotes('x'.repeat(4001), persona) !== 'x'.repeat(4001));

console.log('─'.repeat(58));
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
