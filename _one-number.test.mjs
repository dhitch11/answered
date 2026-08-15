#!/usr/bin/env node
// _one-number.test.mjs — the number we SPEAK, the number we PRINT, and the number we OWN must be
// the same string.
//
// ★ WHY. Proposed by @LANE-SEARCHLIGHT while relaying David's ruling to buy a new number, and it is
// the right assertion: **three sources of one fact is how they drift.** Tonight produced five
// separate instances of a check answering a different question from the one asked, and this is the
// one that would have caught an entire number migration before it happened.
//
// The three sources, and why each is dangerous alone:
//
//   SPOKEN   lib/scripts.mjs reads ANSWERED_DEMO_NUMBER and says the callback number aloud on every
//            recovery call. 47 CFR 64.1200(b)(2) requires a callback number, so a call speaking a
//            number we no longer own is a compliance defect ON A LIVE CALL, not a copy error. It is
//            the highest-severity item in the set by a distance.
//   PRINTED  the A2P consent sentence names the number our texts come FROM. Carriers check it. It
//            was a hardcoded literal in _build.py until 2026-08-15 while everything else read the
//            env, which is exactly the drift this file exists to catch.
//   OWNED    what Twilio says the account actually holds. Lookup does NOT answer this: it reports
//            that a number exists in the world, which stays true for years after we release it.
//            Only IncomingPhoneNumbers answers ownership.
//
//   node _one-number.test.mjs                 check the built pages
//   BASE=... node _one-number.test.mjs --live check what is served

import { readFileSync } from 'node:fs';

const LIVE = process.argv.includes('--live');
const BASE = (process.env.BASE || 'https://answered.reddenda.com').replace(/\/+$/, '');

const SID = (process.env.TWILIO_ACCOUNT_SID || '').trim();
const KEY = (process.env.TWILIO_API_SID || '').trim();
const SEC = (process.env.TWILIO_API_SECRET || '').trim();
const ENV_NUM = (process.env.ANSWERED_DEMO_NUMBER || '').trim();

let pass = 0, fail = 0, skip = 0;
const t = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
};
const note = (name, why) => { skip++; console.log(`SKIP  ${name}\n      ${why}`); };

// ★ PARSE E.164 FIRST. The loose pattern below slides: applied to "+19163504869" it matches from
// index 1 and yields "+11916350486", a number that does not exist, and then reports a DRIFT that is
// entirely the parser's. A false failure costs exactly what a false pass costs, because both end in
// the check being disbelieved.
const e164 = (s) => {
  const raw = String(s || '').trim();
  const strict = /^\+1(\d{10})$/.exec(raw.replace(/[^\d+]/g, ''));
  if (strict) return `+1${strict[1]}`;
  const m = /\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})/.exec(raw);
  return m ? `+1${m[1]}${m[2]}${m[3]}` : null;
};

console.log(`\nONE NUMBER, THREE SOURCES\n${'─'.repeat(62)}`);

// ── 1. SPOKEN ────────────────────────────────────────────────────────────────
let spoken = null;
try {
  const scripts = await import('./netlify/functions/lib/scripts.mjs');
  // The module reads the env at call time, so this asserts the WIRING, not a constant.
  const src = readFileSync('./netlify/functions/lib/scripts.mjs', 'utf8');
  const readsEnv = /process\.env\.ANSWERED_DEMO_NUMBER/.test(src);
  t('the spoken callback number is read from the environment, not hardcoded', readsEnv,
    readsEnv ? 'scripts.mjs reads ANSWERED_DEMO_NUMBER' : 'a literal here survives a number change and is spoken on live calls');
  const hardcoded = /\+?1?\(?9\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.exec(src.replace(/\/\/.*$/gm, ''));
  t('no phone number is hardcoded in the script source', !hardcoded,
    hardcoded ? `found ${hardcoded[0]} outside a comment` : 'none outside comments');
  spoken = ENV_NUM ? e164(ENV_NUM) : null;
  void scripts;
} catch (e) {
  note('spoken number', `could not load scripts.mjs: ${String(e.message).slice(0, 60)}`);
}

// ── 2. PRINTED ───────────────────────────────────────────────────────────────
let printed = null;
try {
  const html = LIVE
    ? await (await fetch(`${BASE}/pricing`, { signal: AbortSignal.timeout(20000) })).text()
    : readFileSync('./pricing.html', 'utf8');
  const stripped = html.replace(/<!--[\s\S]*?-->/g, '');
  const m = /opts you into Answered texts from ([^:]{5,24}):/.exec(stripped);
  if (!m) {
    t('the A2P consent sentence names a number', false, 'the sentence was not found, so the carrier-required disclosure may be missing');
  } else {
    printed = e164(m[1]);
    t('the A2P consent sentence names a number', Boolean(printed), `reads "${m[1].trim()}"`);
    t('the printed number is not an unsubstituted template token', !/\{|\}/.test(m[1]),
      /\{|\}/.test(m[1]) ? `it literally says ${m[1].trim()}, so the build did not substitute` : 'substituted');
  }
} catch (e) {
  note('printed number', `could not read the pricing page: ${String(e.message).slice(0, 60)}`);
}

// ── 3. OWNED ─────────────────────────────────────────────────────────────────
let owned = null;
if (!SID || !KEY || !SEC) {
  note('owned number', 'no Twilio credentials in this environment, so ownership was not checked');
} else if (!ENV_NUM) {
  note('owned number', 'ANSWERED_DEMO_NUMBER is not set, so there is nothing to ask about');
} else {
  try {
    const r = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(SID)}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(e164(ENV_NUM))}`,
      { headers: { Authorization: 'Basic ' + Buffer.from(`${KEY}:${SEC}`).toString('base64') }, signal: AbortSignal.timeout(8000) },
    );
    const j = await r.json();
    const rows = Array.isArray(j.incoming_phone_numbers) ? j.incoming_phone_numbers : [];
    owned = rows.length ? e164(rows[0].phone_number) : null;
    t('this Twilio account owns the configured number', Boolean(owned),
      owned ? `owns ${owned}` : `the account does NOT own ${e164(ENV_NUM)}, so nothing would answer it`);
    if (owned) {
      t('the owned number has a voice webhook', Boolean(rows[0].voice_url),
        rows[0].voice_url ? String(rows[0].voice_url).slice(0, 60) : 'no voice URL, so a call rings into nothing');
    }
  } catch (e) {
    note('owned number', `Twilio could not be asked: ${String(e.message).slice(0, 50)}`);
  }
}

// ── THE ASSERTION THIS FILE EXISTS FOR ───────────────────────────────────────
const known = [['spoken', spoken], ['printed', printed], ['owned', owned]].filter(([, v]) => v);
if (known.length < 2) {
  note('all three agree', `only ${known.length} of 3 sources could be read, so agreement is unproven`);
} else {
  const values = [...new Set(known.map(([, v]) => v))];
  t('every source that could be read names the SAME number', values.length === 1,
    known.map(([k, v]) => `${k}=${v}`).join('  ') + (values.length === 1 ? '' : '  <- they disagree, which is the drift'));
}

// ── POSITIVE CONTROL ─────────────────────────────────────────────────────────
// Without this, a run where every source is null "passes" by having nothing to compare.
t('CONTROL: at least one source was actually read', known.length > 0,
  known.length ? `read: ${known.map(([k]) => k).join(', ')}` : 'nothing was read, so nothing above means anything');

console.log('─'.repeat(62));
console.log(`${pass}/${pass + fail} passed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
