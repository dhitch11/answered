// routes.test.mjs — the piece billing/serve.mjs cannot prove.
//
// The local harness routes by hand, so a green suite there says nothing about whether Netlify will
// reach these functions in production. This reads the real netlify.toml and the real function
// files and asserts the wiring, including the two ways this repo has already been bitten:
//
//   1. A v2 function that declares config.path must have NO redirect block, because declaring a
//      custom path removes the default /.netlify/functions/ route and a forced redirect would then
//      point at a dead target. That comment is already in netlify.toml about answered-brain; this
//      turns it into a check.
//   2. An exact webhook route must be declared BEFORE the route that could swallow it.

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const toml = readFileSync(join(ROOT, 'netlify.toml'), 'utf8');

let pass = 0; let fail = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

/** Every [[redirects]] block, in file order, as {from, to}. */
const blocks = [...toml.matchAll(/\[\[redirects\]\]([\s\S]*?)(?=\n\[\[|\n?$)/g)].map((m) => ({
  from: (/from\s*=\s*"([^"]+)"/.exec(m[1]) || [])[1],
  to: (/to\s*=\s*"([^"]+)"/.exec(m[1]) || [])[1],
  forced: /force\s*=\s*true/.test(m[1]),
}));

console.log('\nrouting\n');

t('every redirect points at a function file that exists', () => {
  for (const b of blocks) {
    if (!b.to?.startsWith('/.netlify/functions/')) continue;
    const name = b.to.replace('/.netlify/functions/', '');
    const found = ['.mjs', '.js', '.ts'].some((ext) => existsSync(join(ROOT, 'netlify/functions', name + ext)));
    assert.ok(found, `${b.from} points at ${name}, which is not a file in netlify/functions`);
  }
});

t('/api/meter reaches the function that exports the meter handler', () => {
  const r = blocks.find((b) => b.from === '/api/meter');
  assert.ok(r, '/api/meter has no redirect');
  assert.equal(r.to, '/.netlify/functions/bill-meter');
  assert.equal(r.forced, true, 'unforced redirects lose to a static file of the same name');
  const src = readFileSync(join(ROOT, 'netlify/functions/bill-meter.mjs'), 'utf8');
  assert.match(src, /export const handler/, 'a v1 redirect target must export a handler');
  assert.equal(/export const config/.test(src), false, 'a function with a redirect must not also declare config.path');
});

t('/api/billing reaches the stripe function, and the webhook route comes FIRST', () => {
  const bill = blocks.findIndex((b) => b.from === '/api/billing');
  const hook = blocks.findIndex((b) => b.from === '/api/billing/webhook');
  assert.ok(hook >= 0 && bill >= 0, 'both billing routes must exist');
  assert.ok(hook < bill, 'the exact webhook route must be declared before /api/billing or it can be swallowed');
  assert.equal(blocks[bill].to, '/.netlify/functions/bill-stripe');
  assert.equal(blocks[hook].to, '/.netlify/functions/bill-stripe');
});

t('the statement declares its own paths and has NO redirect, which is the trap this repo already hit', () => {
  const src = readFileSync(join(ROOT, 'netlify/functions/bill-statement.mjs'), 'utf8');
  const cfg = /export const config = \{ path: \[([^\]]+)\] \}/.exec(src);
  assert.ok(cfg, 'bill-statement must declare config.path');
  assert.match(cfg[1], /'\/statement\/:token'/);
  assert.match(cfg[1], /'\/api\/statement'/);
  assert.match(src, /export default/, 'a v2 function exports a default handler, not `handler`');
  for (const p of ['/statement', '/statement/:token', '/api/statement']) {
    assert.equal(blocks.some((b) => b.from === p), false,
      `${p} must have no redirect block: declaring config.path removes the default function route, so a forced redirect points at a dead target`);
  }
});

t('the statement route is reachable by shape: a 64 hex token matches its token pattern', () => {
  const src = readFileSync(join(ROOT, 'netlify/functions/bill-statement.mjs'), 'utf8');
  const re = /const TOKEN = (\/[^;]+\/);/.exec(src);
  assert.ok(re, 'no TOKEN pattern found');
  // eslint-disable-next-line no-eval
  const pattern = eval(re[1]);
  assert.equal(pattern.test('a'.repeat(64)), true, 'the tokens the ledger mints are 64 hex characters');
  assert.equal(pattern.test('../../etc/passwd'), false);
  assert.equal(pattern.test(''), false);
});

t('no route added by this lane collides with one already in the file', () => {
  const froms = blocks.map((b) => b.from);
  const dupes = froms.filter((f, i) => froms.indexOf(f) !== i);
  assert.deepEqual(dupes, [], `duplicate redirect sources: ${dupes.join(', ')}`);
});

t('the money switch is off in the code, not only in the environment', () => {
  const src = readFileSync(join(ROOT, 'netlify/functions/lib/stripe-rest.mjs'), 'utf8');
  assert.match(src, /billingArmed = \(\) => process\.env\.ANSWERED_BILLING_ARMED === '1'/,
    'arming must be an explicit equality against 1, never a truthiness check on an unset variable');
  assert.match(src, /function requireArmed/);
  for (const op of ['finalizeInvoice', 'payInvoice']) {
    const fn = new RegExp(`export function ${op}\\([^)]*\\) \\{\\s*requireArmed`);
    assert.match(src, fn, `${op} must call requireArmed on its first line`);
  }
});

t('no secret literal is in any file this lane wrote', () => {
  const files = ['netlify/functions/bill-meter.mjs', 'netlify/functions/bill-stripe.mjs',
    'netlify/functions/bill-statement.mjs', 'netlify/functions/lib/meter.mjs',
    'netlify/functions/lib/ledger.mjs', 'netlify/functions/lib/stripe-rest.mjs',
    'billing/serve.mjs', 'billing/with-env.sh', 'billing/001_billing_ledger.sql'];
  const bad = [/sk_live_[A-Za-z0-9]/, /sk_test_[A-Za-z0-9]/, /whsec_[A-Za-z0-9]/, /eyJ[A-Za-z0-9_-]{20,}/];
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    for (const re of bad) assert.equal(re.test(src), false, `${f} carries something shaped like a live secret`);
  }
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
