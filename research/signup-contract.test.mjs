// signup-contract.test.mjs — assert the SHAPE CONTRACT between signup.mjs and the live RPC.
//
// ★ WHY THIS EXISTS. On 2026-08-17 `signup.mjs` read the new account's id as
// `r.account_id || r.id`. The live `sv_account_start` returns neither: the id is at
// `r.account.id`. So `id` was always undefined, the entire `if (id)` block was dead, and
// `saveConfig` never ran. Every completed signup created an account row and then DISCARDED all
// seven answers, while telling the contractor "Your setup is saved."
//
// Nothing inside the repo could have caught it. `node --check` passes, every import resolves, the
// unit suite is green, and the SQL on disk is not the schema that is serving. The defect lives
// exactly at the boundary, and a fixture we write ourselves just re-states our own assumption.
//
// So this test calls the REAL RPC and reads the far side. It is the pattern the audit asked for:
// for every boundary the product depends on, assert against the boundary at runtime.
//
//   ./research/with-env.sh node research/signup-contract.test.mjs

import crypto from 'node:crypto';
import { startAccount, saveConfig, getAccount } from '../netlify/functions/lib/accounts.mjs';
import { dbConfigured } from '../netlify/functions/lib/db.mjs';

if (!dbConfigured()) {
  // Not a failure — a test that never ran. run-all-tests.sh reads this message and skips.
  console.error('db not configured: ANSWERED_DB_URL / ANSWERED_DB_ANON / ANSWERED_DB_SECRET');
  process.exit(1);
}

let pass = 0; let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}\n       ${detail}`); }
};

const stamp = Date.now();
const r = await startAccount({
  email: `probe+contract${stamp}@example.com`,
  businessName: 'Contract Probe',
  ownerName: '',
  phone: '+19995559911',
  trade: 'plumbing',
  tokenHash: crypto.createHash('sha256').update(`signup-contract:${stamp}`).digest('hex'),
});

console.log('\nSIGNUP ↔ sv_account_start SHAPE CONTRACT');
console.log(`  live keys: ${Object.keys(r || {}).join(', ')}\n`);

// The exact expression signup.mjs:486 uses. If this ever goes undefined again, the whole
// configuration-saving half of the front door is silently dead and nothing else will say so.
const id = r && (r.account_id || r.id || (r.account && r.account.id));
check('the account id resolves from what the RPC actually returns',
  Boolean(id), `resolved ${JSON.stringify(id)} from keys [${Object.keys(r || {}).join(', ')}]`);

check('the RPC reported success', r && r.ok === true, `ok was ${JSON.stringify(r && r.ok)}`);

// ★ THE PART THAT MATTERS MORE THAN THE ID: prove the write actually lands. A truthy id proves
// the extraction, not the effect. The original defect was invisible precisely because everything
// upstream of the write looked correct.
if (id) {
  const marker = `QA-${stamp}`;
  await saveConfig(id, { greeting_name: marker });
  const back = await getAccount(id);
  const got = back && back.config && back.config.greeting_name;
  check('saveConfig actually persisted the value (the EFFECT, not the extraction)',
    got === marker, `read back ${JSON.stringify(got)}, wanted ${marker}`);

  // ★ AND THE ORIGINAL SYMPTOM, ASSERTED DIRECTLY. The broken build produced rows whose
  // config.updated_at was byte-equal to created_at, because nothing ever patched them. That
  // equality IS the defect's fingerprint, so it is worth failing on by name.
  const created = back && back.created_at;
  const updated = back && back.config && back.config.updated_at;
  check('config.updated_at moved past created_at (a signup that saved nothing leaves them equal)',
    !created || !updated || updated !== created,
    `created_at=${created} config.updated_at=${updated} — equal means the answers were discarded`);
}

// ★ THE FIELD TYPE THAT TAKES THE WHOLE PATCH DOWN WITH IT. `services` must be an ARRAY. Passing
// a string throws Postgres 22023 out of sv_account_save_config and the ENTIRE patch is rejected —
// so greeting_name, service_area, booking_destination and escalation_phone all stayed null too.
// One wrong field type silently discarded every other answer, which is the same symptom as the id
// bug from a completely different cause. Measured, not assumed:
//     services: 'a string'   -> throws 22023, config.greeting_name stays null
//     services: ['a','b']    -> writes, and `services` leaves the missing list
if (id) {
  let threw = null;
  try { await saveConfig(id, { services: 'a string, not an array' }); }
  catch (e) { threw = String(e.message).slice(0, 60); }
  check('the RPC still rejects services-as-a-string (if this stops throwing, re-check the writer)',
    threw !== null, 'a string was accepted; the array assumption in signup.mjs may now be stale');

  await saveConfig(id, { services: ['drain cleaning', 'water heaters'] });
  const svc = await getAccount(id);
  const got = svc && svc.config && svc.config.services;
  check('services persists when written as an array',
    Array.isArray(got) && got.length === 2, `read back ${JSON.stringify(got)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
