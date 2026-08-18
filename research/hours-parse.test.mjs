// hours-parse.test.mjs — what real contractors type, and what must NOT be guessed.
//
// The second half is the important half. A parser that returns a schedule for everything would
// pass a one-directional test and put invented hours on a real line.

import { parseHours } from '../netlify/functions/lib/hours-parse.mjs';

let pass = 0; let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}\n       ${detail}`); }
};
const span = (h, d) => (h && h[d] && h[d][0] ? `${h[d][0][0]}-${h[d][0][1]}` : 'closed');

console.log('\nHOURS: what people actually type');

const MUST_PARSE = [
  ['weekdays 7 to 5', 'mon', '07:00-17:00', 'sat', 'closed'],
  ['weekdays seven to five', null, null, null, null],           // words, not digits — see below
  ['mon-fri 8 to 6', 'mon', '08:00-18:00', 'sun', 'closed'],
  ['monday through friday 7am to 5pm', 'fri', '07:00-17:00', 'sat', 'closed'],
  ['M-F 7:30 to 4:30', 'wed', '07:30-16:30', 'sun', 'closed'],
  ['7 to 5', 'mon', '07:00-17:00', 'sat', 'closed'],
  ['everyday 8 to 8', 'sun', '08:00-20:00', 'wed', '08:00-20:00'],
  ['24/7', 'sun', '00:00-23:59', 'wed', '00:00-23:59'],
  ['sat and sun 9 to 2', 'sat', '09:00-14:00', 'mon', 'closed'],
  ['8 to noon', 'mon', '08:00-12:00', null, null],
  ['tue, wed, thu 10 to 4', 'wed', '10:00-16:00', 'mon', 'closed'],
];

for (const [text, day, want, otherDay, otherWant] of MUST_PARSE) {
  const { hours } = parseHours(text);
  if (want === null) continue; // handled in the refusal block
  check(`"${text}"`, hours && span(hours, day) === want,
    `${day} came out ${hours ? span(hours, day) : 'null'}, wanted ${want}`);
  if (otherDay) {
    check(`  …and ${otherDay} is ${otherWant}`, hours && span(hours, otherDay) === otherWant,
      `${otherDay} came out ${hours ? span(hours, otherDay) : 'null'}`);
  }
}

console.log('\nHOURS: what must be REFUSED rather than guessed');
console.log('  (a schedule invented here answers a real customer line at the wrong times)');

const MUST_REFUSE = [
  ['weekdays seven to five', 'spelled-out numbers are not parsed, and inventing 07:00 from "seven" is a guess'],
  ['whenever, we are pretty flexible', 'no times at all'],
  ['ask my wife', 'not an answer'],
  ['during business hours', 'means nothing specific'],
  ['7am to 5am', 'qualified and runs backwards — do NOT silently flip it'],
  ['', 'empty'],
  ['mornings mostly', 'no span'],
  ['9', 'one time is not a span'],
  ['call anytime before 5', 'open-ended'],
];

for (const [text, why] of MUST_REFUSE) {
  const { hours } = parseHours(text);
  check(`refuses "${text}" (${why})`, hours === null,
    `returned ${JSON.stringify(hours)} instead of null`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
