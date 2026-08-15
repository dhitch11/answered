// Extract BOTH shipped functions and prove they produce the same key for the same person.
// If they ever disagree, a carrier STOP writes a key the call path never reads, and the person
// stays reachable by voice while believing they opted out. That is the whole point of this file.
import fs from 'node:fs';
import crypto from 'node:crypto';

const grab = (src, name) => {
  let i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
};
const callme = fs.readFileSync('netlify/functions/call-me.mjs', 'utf8');
const inbound = fs.readFileSync('netlify/functions/sms-inbound.mjs', 'utf8');

const normalizeUs = new Function(grab(callme, 'normalizeUs') + '; return normalizeUs;')();
const e164        = new Function(grab(inbound, 'e164') + '; return e164;')();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const cases = [
  '+19165550142', '19165550142', '9165550142', '(916) 555-0142', '916-555-0142',
  '+1 916 555 0142', '+19162825278', '2125550100', '+12125550100',
];
let bad = 0;
for (const c of cases) {
  const a = normalizeUs(c);
  const b = e164(c);
  const keyA = a.ok ? sha(a.phone) : null;
  const keyB = b ? sha(b) : null;
  const agree = keyA === keyB;
  if (!agree) bad++;
  console.log(`  ${agree ? 'PASS' : 'FAIL'}  ${String(c).padEnd(18)} call-path=${a.ok ? a.phone : 'rejected'}  inbound=${b || 'rejected'}`);
}
console.log('');
// negative control: two DIFFERENT numbers must not collide
const diff = sha(normalizeUs('9165550142').phone) !== sha(e164('9165550143'));
console.log(`  ${diff ? 'PASS' : 'FAIL'}  negative control: different numbers give different keys`);
console.log('');
console.log(bad ? `${bad} DISAGREEMENT(S) — a STOP would not block calls` : 'the inbound webhook writes exactly the key the call path reads');
process.exit(bad ? 1 : 0);
