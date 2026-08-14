#!/usr/bin/env node
// numeral-firewall.test.mjs — demonstrate that badNumeral()'s context check is a SUBSTRING test
// over concatenated digits, not a membership test over what the caller actually said.
//
//   node research/numeral-firewall.test.mjs
//
// badNumeral is the guard that stops a persona speaking a number it was not given. Its context is
// rawDigits(texts) = texts.join(' ').replace(/\D+/g, ''), i.e. EVERY digit the caller has uttered,
// concatenated with no separators, and the check is ctxDigits.includes(d).
//
// So the moment a caller states a phone number, the guard admits any digit sequence that happens to
// appear anywhere inside that soup. A caller who says "916 350 4869" has, without knowing it,
// authorised the persona to say "$350", "16", "35", "4869" and "6350" as facts.
//
// This extracts the SHIPPED functions from personas.mjs rather than reimplementing them, so the
// result cannot drift from what the live line runs.
// Extract the SHIPPED badNumeral + rawDigits and demonstrate the substring hole.
import fs from 'node:fs';
const src = fs.readFileSync('/Users/user/answered-site/netlify/functions/lib/personas.mjs','utf8');
const grab = (name) => {
  let i = src.indexOf('function ' + name + '(');
  if (i < 0) i = src.indexOf('const ' + name + ' = ');
  if (i < 0) throw new Error('missing ' + name);
  if (src.startsWith('function', i)) { let d=0;
    for (let k=src.indexOf('{',i); k<src.length; k++){ if(src[k]==='{')d++; else if(src[k]==='}'){d--; if(!d) return src.slice(i,k+1);} } }
  let d=0; for (let k=i;k<src.length;k++){ const c=src[k];
    if('({['.includes(c))d++; else if(')}]'.includes(c))d--; else if(c===';'&&d===0) return src.slice(i,k+1); }
};
const fn = new Function(grab('badNumeral') + '\n' + grab('rawDigits') + '\n; return {badNumeral, rawDigits};')();

const callerSaid = ['Hi, my number is 916 350 4869 and my zip is 97204'];
const ctx = fn.rawDigits(callerSaid);
console.log('caller turns   :', JSON.stringify(callerSaid[0]));
console.log('ctxDigits      :', JSON.stringify(ctx), '  <- every digit, concatenated, no separators');
console.log('');
const allow = new Set();
const tries = [
  'That will be $350 a month.',
  'We have 16 openings this week.',
  'Your rate is 35 dollars.',
  'It takes 4869 days.',
  'There are 6350 jobs on the board.',
  'The price is $9,163.',
  'That will be $742 a month.',
];
for (const t of tries) {
  const bad = fn.badNumeral(t, ctx, allow);
  console.log((bad ? 'BLOCKED ' : 'ALLOWED ') + JSON.stringify(t) + (bad ? '   (flagged "'+bad+'")' : '   <- spoken to the caller as fact'));
}
