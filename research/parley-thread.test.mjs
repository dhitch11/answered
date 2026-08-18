// parley-thread.test.mjs — a negotiation must survive both limits, and an SMS must reach it.
//
// ═══ THE DEFECT THIS PINS ═══
//
// Parley shipped as a sealed-bid CALCULATOR wearing a negotiation's clothes. `tr_set_limit`
// settled INLINE: the instant the second limit landed it computed a figure, wrote
// status='settled', and `tr_say` then refused every message with "this deal is finished".
//
// Measured on production before the fix:
//     23 of 23 settled deals settled 0.000000s after the second limit arrived
//     23 of 23 settled deals carry ZERO messages
//
// So the whole text-native engine - tr_say, tr_agent_brief, tr_agent_say, tr_agent_settle, and
// lib/parley-agent.mjs with its output firewall - was finished, correct, and unreachable, sitting
// one branch away. Built and wired and never fed, and the tell was in the data the whole time.
//
// These tests are OFFLINE. They pin the routing contract and the shape of the transport, which is
// what silently rots. The database half is proven separately against live prod, because a mock of
// tr_set_limit would just be me asserting my own belief about it.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.error(`  FAIL  ${name}\n        ${e.message}`); }
};

const inbound = readFileSync(new URL('../netlify/functions/sms-inbound.mjs', import.meta.url), 'utf8');
const transport = readFileSync(new URL('../netlify/functions/lib/parley-sms.mjs', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/20260818090000_parley_text_thread.sql', import.meta.url), 'utf8');

// ★ STRIP COMMENTS BEFORE ASSERTING ON CODE. Two checks below failed on their first run because
// they matched the FILE HEADER - which names `outbox.sms()` and `tr_set_contact` while explaining
// why the transport uses one and never calls the other. A keyword search cannot tell use from
// mention, and prose that documents a rule necessarily contains the rule's own words. Same trap as
// research/module-gate-es.mjs, which flagged four Spanish modules for stating their own
// prohibitions. So the "does the code do X" assertions read CODE, and the "does the file explain
// itself" assertions read the whole text.
const codeOnly = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
const transportCode = codeOnly(transport);

console.log('parley text thread\n');

// ── the routing order, which is the part that can silently ruin the other product ───────────────
t('★ the negotiation check runs BEFORE the setup thread', () => {
  const neg = inbound.indexOf('partyForPhone');
  const signup = inbound.lastIndexOf('signupHandler');
  assert.ok(neg > 0, 'sms-inbound never calls partyForPhone');
  assert.ok(neg < signup,
    'setup is dispatched before the negotiation check; a live negotiator typing "8500" would be '
    + 'read as an answer to a setup question and their deal would go silent');
});
t('a failed lookup falls through to setup, never the other way', () => {
  assert.match(transport, /catch[\s\S]{0,400}return null/,
    'partyForPhone must return null on error so the message goes where it went yesterday');
});
t('STOP is still intercepted before either product sees it', () => {
  assert.ok(inbound.indexOf('STOP_WORDS.has(word)') < inbound.indexOf('partyForPhone'),
    'the opt-out branch must come first, or a STOP inside a negotiation is a negotiation turn');
});

// ── waitUntil is feature-detected, because nothing else here has ever used it ────────────────────
t('★ context.waitUntil is feature-detected, not assumed', () => {
  assert.match(inbound, /typeof context\?\.waitUntil === 'function'/,
    'calling an absent waitUntil throws into the catch, which routes the turn to SETUP');
  assert.match(inbound, /Promise\.race\(\[work/, 'there must be a bounded fallback');
});
t('the fallback is bounded under Twilio\'s webhook window', () => {
  const m = inbound.match(/setTimeout\(r, (\d+)\)/);
  assert.ok(m, 'no timeout found in the fallback');
  assert.ok(Number(m[1]) <= 12000,
    `fallback waits ${m[1]}ms; Twilio gives ~15s and REDELIVERS on timeout, which doubles the turn`);
});

// ── the transport adds no negotiation logic of its own ──────────────────────────────────────────
t('the reply goes through outbox.sms(), not a second bare-From path', () => {
  assert.match(transportCode, /outbox\.sms\(/, 'must reuse the one send path');
  assert.doesNotMatch(transportCode, /api\.twilio\.com/, 'a second direct Twilio path would skip suppression');
});
t('settle is recorded by the DATABASE before the message is sent', () => {
  const settle = transportCode.indexOf('tr_agent_settle');
  const send = transportCode.indexOf('outbox.sms(');
  assert.ok(settle > 0 && settle < send,
    'a message must never announce a figure the record does not hold');
});
t('the transport never writes a phone number', () => {
  assert.doesNotMatch(transportCode, /tr_set_contact|update .*phone|set phone/i,
    'only tr_set_contact writes a phone, and only with that party\'s own token');
});
t('it reuses the web thread\'s rate limiter, same bucket and key', () => {
  assert.match(transport, /p_bucket: 'truce_say'/, 'a second bucket is a second, looser allowance');
  assert.match(transport, /p_key: party\.token/);
});

// ── the migration's guarantees ──────────────────────────────────────────────────────────────────
t('★ thread mode skips the inline settle', () => {
  assert.match(migration, /if d\.mode = 'thread' then\s*\n\s*return public\.tr_view/,
    'the thread guard is the whole point of the migration');
});
t('the overlap check still runs BEFORE the thread guard', () => {
  assert.ok(migration.indexOf("status='no_overlap'") < migration.indexOf("if d.mode = 'thread'"),
    'an impossible pair must still die immediately instead of sending two agents to haggle over nothing');
});
t('existing deals keep the calculator', () => {
  assert.match(migration, /default 'instant'/, 'a silent behaviour change to settled deals is not a feature');
});
t('tr_party_by_phone resolves only a LIVE thread deal', () => {
  assert.match(migration, /td\.mode = 'thread'/);
  assert.match(migration, /td\.status in \('open','negotiating'\)/);
  assert.match(migration, /td\.expires_at > now\(\)/);
});
t('one handset cannot be two live parties', () => {
  assert.match(migration, /already in another live negotiation/,
    'without this an inbound SMS is ambiguous and the transport would have to guess');
});
t('tr_thread_state returns no sealed figure', () => {
  const fn = migration.slice(migration.indexOf('tr_thread_state'));
  assert.doesNotMatch(fn.slice(0, 1800), /l\.amount|l\.target|sealed\.limits l[\s\S]{0,80}amount/,
    'the transport never needs an amount, and fewer places it can reach is fewer places it can leak from');
});

// ── POSITIVE CONTROLS ───────────────────────────────────────────────────────────────────────────
t('POSITIVE CONTROL — these files are actually loaded and non-trivial', () => {
  assert.ok(inbound.length > 5000 && transport.length > 3000 && migration.length > 4000);
});
t('POSITIVE CONTROL — the assertions can fail', () => {
  assert.throws(() => assert.match(transport, /this string is definitely not in the file/));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
