#!/usr/bin/env node
// The webhook signature is the only thing standing between "money moved" and anybody who can send
// us an HTTP request. So it is tested against a REAL HMAC, in both directions, with a positive
// control proving the instrument can return both answers.
import crypto from 'node:crypto';
import { verifyWebhook } from './parley-money.mjs';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got ${JSON.stringify(got)} wanted ${JSON.stringify(want)}`}`);
};

const SECRET = 'whsec_test_only_never_a_real_secret';
const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1' } } });
const sign = (b, sec, ts) => {
  const t0 = ts || Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', sec).update(`${t0}.${b}`, 'utf8').digest('hex');
  return `t=${t0},v1=${mac}`;
};

console.log('\nSTRIPE WEBHOOK SIGNATURE\n' + '─'.repeat(58));

process.env.STRIPE_WEBHOOK_SECRET = SECRET;

let r = await verifyWebhook(body, sign(body, SECRET));
t('a genuine signature is accepted', r.ok, true);
t('  and the event is parsed', r.ok && r.event.type, 'payment_intent.succeeded');

r = await verifyWebhook(body, sign(body, 'whsec_a_different_secret'));
t('a signature from the wrong secret is refused', r.ok, false);

r = await verifyWebhook(body + ' ', sign(body, SECRET));
t('a tampered body is refused', r.ok, false);

r = await verifyWebhook(body, sign(body, SECRET, Math.floor(Date.now() / 1000) - 4000));
t('a replayed old signature is refused', r.ok, false);

r = await verifyWebhook(body, 't=123');
t('a malformed header is refused', r.ok, false);

r = await verifyWebhook(body, null);
t('a missing header is refused', r.ok, false);

r = await verifyWebhook('not json at all', sign('not json at all', SECRET));
t('a correctly signed non-json body is refused', r.ok, false);

// ★ FAIL CLOSED. No secret configured must mean nothing is trusted, NOT that everything passes.
delete process.env.STRIPE_WEBHOOK_SECRET;
r = await verifyWebhook(body, sign(body, SECRET));
t('NO SECRET CONFIGURED: refuses everything', r.ok, false);
t('  and says why', /not set/.test(r.reason || ''), true);

// ★ POSITIVE CONTROL: a verifier that always said false would pass every refusal test above.
process.env.STRIPE_WEBHOOK_SECRET = SECRET;
const good = await verifyWebhook(body, sign(body, SECRET));
t('CONTROL: it can still say yes', good.ok, true);

console.log('─'.repeat(58));
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
