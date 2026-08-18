// research/interest-hardening.test.mjs
//
// /api/interest was an unauthenticated, unrate-limited email amplifier: anyone could POST it in a
// loop and it would send an autoresponder from info@reddenda.com to any address a stranger
// supplied, plus a notification whose subject carried attacker-controlled text. The blast radius
// is the sending reputation of the address every customer email in this business leaves from.
//
// Its email check was `email.indexOf('@') < 1`, which is not a validator. A CRLF payload was
// measured travelling through it to Resend and returning a 502.
//
// The regex is executed here against real inputs — that half is a genuine behavioural test. The
// rate-limit half is structural, because exercising it for real means POSTing the live endpoint
// until it refuses, which sends mail to a real inbox. Saying which is which rather than letting
// the green count imply both were executed.
import assert from 'node:assert/strict';
import fs from 'node:fs';

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); console.log(`  ok   ${n}`); pass++; }
  catch (e) { console.log(`  FAIL ${n}\n       ${e.message}`); fail++; } };

const src = fs.readFileSync(new URL('../netlify/functions/interest.js', import.meta.url), 'utf8');

// pull the regex out of the source and run it, so the test cannot drift from the shipped pattern
const m = src.match(/const EMAIL_RE = (\/.*\/);/);
assert.ok(m, 'EMAIL_RE not found in interest.js — the validator is gone');
const EMAIL_RE = eval(m[1]);
const accepts = (e) => !(!e || e.length > 254 || /[\r\n\t\0]/.test(e) || !EMAIL_RE.test(e));

console.log('\n── the validator, executed against real inputs ──');

for (const good of ['a@b.co', 'david@reddenda.com', 'first.last+tag@sub.example.co.uk', "o'brien@example.com"]) {
  t(`accepts ${good}`, () => assert.ok(accepts(good), 'a legitimate address was rejected'));
}

t('POSITIVE CONTROL: the old check would have accepted the CRLF payload', () => {
  const payload = 'a@b.co\r\nBcc: victim@example.com';
  assert.ok(payload.indexOf('@') >= 1, 'the old check is not reproduced here, so the comparison is empty');
});

for (const [bad, why] of [
  ['a@b.co\r\nBcc: victim@example.com', 'CRLF header injection'],
  ['a@b.co\nBcc: victim@example.com', 'bare LF injection'],
  ['@nolocal.com', 'no local part'],
  ['no-at-sign', 'no @'],
  ['a@b', 'no TLD'],
  ['a@@b.co', 'double @'],
  ['a b@c.co', 'whitespace in local part'],
  ['<script>@b.co', 'angle brackets'],
  ['a@b.co, victim@example.com', 'comma-separated second recipient'],
  ['a@-b.co', 'domain label starting with a hyphen'],
  ['a'.repeat(250) + '@b.co', 'over the 254 length cap'],
]) t(`rejects ${why}`, () => assert.ok(!accepts(bad), `accepted: ${JSON.stringify(bad).slice(0, 60)}`));

console.log('\n── the rate limit (structural: the wiring, not an executed refusal) ──');

// ★ SCOPE THIS TO THE HANDLER BODY. My first version searched the WHOLE FILE and failed on
//   correct code: `sendAutoresponder` is DECLARED at line 164, above the handler, and its
//   api.resend.com line therefore precedes the rate block in source order while being CALLED
//   200 lines below it. Declaration order is not execution order, and a positional test that
//   confuses the two reports a defect that is not there. Both call sites are checked instead.
const handlerBody = src.slice(src.indexOf('exports.handler'));
const at = (needle) => handlerBody.indexOf(needle);

t('both buckets are taken before every send in the handler', () => {
  const iIp = at("'interest_ip'"), iAddr = at("'interest_addr'");
  assert.ok(iIp > -1, 'the per-IP bucket is gone');
  assert.ok(iAddr > -1, 'the per-address bucket is gone');
  const sends = [at('api.resend.com'), at('sendAutoresponder(')].filter((i) => i > -1);
  assert.ok(sends.length >= 1, 'no send found in the handler — this assertion is vacuous');
  for (const s of sends) {
    assert.ok(iIp < s && iAddr < s,
      'a send happens before a rate check completes, which limits nothing');
  }
});

t('POSITIVE CONTROL: the ordering check can detect a send placed first', () => {
  const fake = "exports.handler = async () => { await fetch('https://api.resend.com/emails'); "
             + "await rpc('sv_rate_take', { p_bucket: 'interest_ip' }); }";
  const fb = fake.slice(fake.indexOf('exports.handler'));
  assert.ok(!(fb.indexOf("'interest_ip'") < fb.indexOf('api.resend.com')),
    'the ordering comparison cannot detect a send-before-limit, so the assertion above proves nothing');
});

t('it reuses sv_rate_take rather than a second limiter', () => {
  assert.ok(/sv_rate_take/.test(src), 'the shared limiter is gone; a second implementation will drift');
});

t('an unreadable limiter REFUSES rather than waving through', () => {
  const c = src.slice(src.indexOf("'interest_ip'"));
  const cat = c.slice(c.indexOf('catch'), c.indexOf('catch') + 420);
  assert.ok(/statusCode:\s*503/.test(cat), 'the catch does not refuse — the limiter fails open');
});

t('the per-address bucket is keyed case-insensitively', () => {
  assert.ok(/p_key:\s*email\.toLowerCase\(\)/.test(src),
    'A@b.co and a@b.co would occupy different buckets, so the cap is trivially bypassed');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
