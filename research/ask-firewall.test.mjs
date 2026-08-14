const { _internals } = await import('/Users/user/answered-site/netlify/functions/lib/ask.mjs');
const { scanModelProse, substituteAndVerify, newLedger, countSlot } = _internals;

let fail = 0;
const t = (label, got, want) => { const ok = got === want; if (!ok) fail++;
  console.log((ok?'PASS':'FAIL').padEnd(5), label.padEnd(52), ok?'':('got ' + JSON.stringify(got))); };

console.log('── PHASE 0: the model may not author a quantity ──');
t('plain slot prose is allowed',            scanModelProse('{{M1}} contacts are in the book.'), null);
t('a bare digit is rejected',               scanModelProse('There are 4650 contacts.')?.split(':')[0], 'model_wrote_a_digit');
t('a spelled number is rejected',           scanModelProse('There are four thousand contacts.')?.split(':')[0], 'model_wrote_a_spelled_number');
t('"the vast majority" is rejected',        scanModelProse('The vast majority are fixed lines.')?.split(':')[0], 'model_wrote_an_ungrounded_quantity');
t('"roughly" is rejected',                  scanModelProse('Roughly {{M1}} of them.')?.split(':')[0], 'model_wrote_an_ungrounded_quantity');
t('"a handful" is rejected',                scanModelProse('A handful are suppressed.')?.split(':')[0], 'model_wrote_an_ungrounded_quantity');
t('arithmetic between slots is rejected',   scanModelProse('{{M1}} minus {{M2}} remain.')?.split(':')[0], 'model_did_arithmetic');
t('a percentage claim is rejected',         scanModelProse('That is 12 percent.')?.split(':')[0], 'model_wrote_a_digit');
t('ordinary prose is NOT rejected',         scanModelProse('Nothing is callable yet, and that is correct rather than a defect.'), null);
t('"a moment" is NOT rejected',             scanModelProse('Give me a moment while this runs.'), null);

console.log('');
console.log('── PHASE 2/3: substitution and the scan of the RESULT ──');
const L = newLedger();
const a = countSlot(L, 4650, { tool:'x', rpcName:'y', path:'total' });
const b = countSlot(L, 1212, { tool:'x', rpcName:'y', path:'fixed_line' });
const nullSlot = countSlot(L, null, { tool:'x', rpcName:'y', path:'snapshot_numbers', nullMeans:'never_measured' });

const r1 = substituteAndVerify('{{'+a+'}} contacts, of which {{'+b+'}} are on a fixed line.', L);
t('substitution produces the real figures',  r1.text, '4,650 contacts, of which 1,212 are on a fixed line.');
t('spans cover exactly the substituted text', r1.spans.length, 2);

const r2 = substituteAndVerify('We hold {{'+nullSlot+'}} registry numbers.', L);
t('a null slot renders as "not measured"',   r2.text, 'We hold not measured registry numbers.');

const r3 = substituteAndVerify('There are 99 contacts.', L);
t('a digit outside a slot is rejected',      r3.error?.split(':')[0], 'digit_outside_a_slot');

const r4 = substituteAndVerify('{{M999}} contacts.', L);
t('an unresolvable slot is rejected',        r4.error?.split(':')[0], 'unresolvable_slot');

console.log('');
console.log('── THE REGRESSION THAT MADE THE OLD GUARD ABSTAIN ON A CORRECT ANSWER ──');
const L2 = newLedger();
const thousand = countSlot(L2, 1000, { tool:'x', rpcName:'y', path:'n' });
const r5 = substituteAndVerify('{{' + thousand + '}} jobs are on the board.', L2);
t('a number the SERVER wrote is allowed',    r5.text, '1,000 jobs are on the board.');
// and the server writing a spelled word inside a display must not trip the scan
const L3 = newLedger();
const { slot } = _internals;
const spelled = slot(L3, { kind:'text', value:'one week', display:'one week', tool:'x', rpcName:'y', path:'w' });
const r6 = substituteAndVerify('Measured over {{'+spelled+'}}.', L3);
t('a SERVER-written spelled word is allowed', r6.text, 'Measured over one week.');
t('  ...and it is not flagged',               r6.error, undefined);

console.log('');


console.log('');
console.log('── FALSE POSITIVES: legitimate English must survive ──');
const ok = (s) => scanModelProse(s) === null;
const cases = [
  'If you want to know how many you may actually call, run check_reachability.',
  '{{M1}} contacts are in the book. How much of that is usable is a different question.',
  'Nothing is callable yet and that is correct rather than a defect.',
  'Give me a moment.',
  'That is a property of the number, not a permission.',
];
for (const c of cases) console.log((ok(c)?'PASS':'FAIL').padEnd(5), JSON.stringify(c.slice(0,58)));
console.log('');
console.log('── TRUE POSITIVES: real quantity claims must still be caught ──');
const caught = (s) => scanModelProse(s) !== null;
const bad = [
  'Many of them are on a fixed line.',
  'The vast majority are unreachable.',
  'Roughly half have an email.',
  'More than {{M1}} are suppressed.',
  'That is 14 percent of the book.',
];
for (const c of bad) console.log((caught(c)?'PASS':'FAIL').padEnd(5), JSON.stringify(c.slice(0,58)), caught(c)?('-> '+scanModelProse(c)):'  NOT CAUGHT');


console.log(fail ? fail + ' FAILURES' : 'every firewall case passes');
process.exit(fail?1:0);
