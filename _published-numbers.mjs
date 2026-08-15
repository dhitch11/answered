#!/usr/bin/env node
// _published-numbers.mjs — every phone number this site PRINTS must be one we own.
//
// ★ WHY THIS EXISTS. @user-4f put it better than I would have: **a published phone number is a
// claim that decays.** Two failures on this estate in one evening, reached by different doors and
// ending in the same place:
//
//   MINE      the health probe called Lookup, which answers "does this number exist in the world",
//             and went GREEN while the account owned zero numbers. Green publishes the number as a
//             real tel: link. A visitor would have dialled a stranger.
//   THEIRS    reddenda.com's terms and privacy pages print a number on an account nobody can
//             manage anymore. Twilio RECYCLES released numbers. Nothing re-checks after publish,
//             so the page quietly becomes a signpost to whoever gets that number next.
//
// The second one needs no bug at all. The value was correct when it was written and nothing ever
// asked again. So the general fix is not a better probe, it is an OWNER and a RE-CHECK for anything
// that prints a number.
//
// Answered's own exposure, measured 2026-08-15: /pricing carries (916) 350-4869 inside the A2P
// consent sentence, which is a compliance artifact naming the originating number. That number is on
// the OLD Twilio account. If it lapses and is recycled, our own consent language names a stranger's
// line as the sender of our texts.
//
// ── WHAT IT DOES, AND WHAT IT DELIBERATELY DOES NOT ─────────────────────────────────────────────
//
// FAILS when Twilio answers and says we do NOT own a number the site prints. That is a known-bad
// and it is worth stopping a deploy for.
//
// WARNS, and exits zero, when Twilio cannot be reached or no credentials are set. An unknown is not
// a known-bad, and a guard that blocks every deploy during a vendor outage is a guard somebody
// disables. It says loudly what it could not check.
//
// IGNORES numbers inside HTML comments, because a comment is not a publication. That mistake has
// now been made twice on this estate in one evening, in two different files.
//
//   node _published-numbers.mjs            check the built pages in this directory
//   BASE=https://answered.reddenda.com node _published-numbers.mjs --live   check what is served

import { readFileSync, readdirSync } from 'node:fs';

const LIVE = process.argv.includes('--live');
const BASE = (process.env.BASE || 'https://answered.reddenda.com').replace(/\/+$/, '');

const SID = (process.env.TWILIO_ACCOUNT_SID || '').trim();
const KEY = (process.env.TWILIO_API_SID || '').trim();
const SEC = (process.env.TWILIO_API_SECRET || '').trim();

// North American, in the shapes a page actually writes them.
const NUMBER_RE = /\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})/g;
// Numbers that are examples by construction and can never belong to anyone.
// ★ THE RESERVED RANGE IS THE EXCHANGE, NOT THE AREA CODE. NANP reserves 555-0100 through
// 555-0199 in EVERY area code for fiction, which is why (916) 555-0142 appears on our own pages as
// an illustration. The first version of this matched `^\+1555`, i.e. area code 555, and therefore
// flagged our own example number as an unowned publication. A check that cries wolf gets muted, and
// then it is not a check.
const FICTIONAL = (e164) => {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (!m) return false;
  const [, , exch, line] = m;
  // 555-0100 to 555-0199 is the range NANP formally reserves for fiction. The REST of the 555
  // exchange is not formally reserved but is not assigned to subscribers either, and it is the
  // universal placeholder: "(555) 555 5555" is the hint text in our own phone field. Treating a
  // form placeholder as a published claim is a false positive, and a check that cries wolf is one
  // people mute. So the whole 555 exchange is excluded, deliberately and with the reason written
  // down, rather than the narrow formal range.
  void line;
  return exch === '555';
};

const strip = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

function numbersIn(html) {
  const found = new Map();
  const text = strip(html);
  let m;
  NUMBER_RE.lastIndex = 0;
  while ((m = NUMBER_RE.exec(text))) {
    const e164 = `+1${m[1]}${m[2]}${m[3]}`;
    // A run of digits inside a longer number, a date, or an id is not a phone number.
    const before = text[m.index - 1] || '';
    const after = text[m.index + m[0].length] || '';
    if (/\d/.test(before) || /\d/.test(after)) continue;
    if (FICTIONAL(e164)) continue;
    if (!found.has(e164)) found.set(e164, m[0]);
  }
  return found;
}

async function owned(e164) {
  const r = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(SID)}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(e164)}`,
    {
      headers: { Authorization: 'Basic ' + Buffer.from(`${KEY}:${SEC}`).toString('base64') },
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!r.ok) throw new Error(`twilio ${r.status}`);
  const j = await r.json();
  return Array.isArray(j.incoming_phone_numbers) && j.incoming_phone_numbers.length > 0;
}

const pages = LIVE
  ? ['/', '/trades', '/hold', '/recover', '/parley', '/setup', '/pricing', '/trust', '/thanks', '/terms', '/privacy', '/recording']
  : readdirSync('.').filter((f) => f.endsWith('.html'));

console.log(`\nPUBLISHED NUMBERS ${LIVE ? `on ${BASE}` : 'in the built pages'}\n${'─'.repeat(62)}`);

const printed = new Map(); // e164 -> [where]
for (const p of pages) {
  let html;
  try {
    html = LIVE ? await (await fetch(BASE + p, { signal: AbortSignal.timeout(20000) })).text() : readFileSync(p, 'utf8');
  } catch (e) {
    console.log(`  could not read ${p}: ${String(e.message).slice(0, 60)}`);
    continue;
  }
  for (const [e164, asWritten] of numbersIn(html)) {
    if (!printed.has(e164)) printed.set(e164, []);
    printed.get(e164).push(`${p} (${asWritten})`);
  }
}

if (!printed.size) {
  console.log('  no phone numbers are printed anywhere. Nothing to verify.');
  console.log('─'.repeat(62));
  process.exit(0);
}

if (!SID || !KEY || !SEC) {
  console.log('  WARN: no Twilio credentials in this environment, so ownership could NOT be checked.');
  for (const [e164, where] of printed) console.log(`    ${e164}  printed on ${where.length} page(s): ${where[0]}`);
  console.log('  An unknown is not a known-bad, so this is not failing the build. It IS unverified.');
  console.log('─'.repeat(62));
  process.exit(0);
}

let bad = 0;
let unchecked = 0;
for (const [e164, where] of printed) {
  let verdict;
  try {
    verdict = await owned(e164);
  } catch (e) {
    unchecked += 1;
    console.log(`  WARN  ${e164}  could not ask Twilio (${String(e.message).slice(0, 40)}). Printed on: ${where.join(', ')}`);
    continue;
  }
  if (verdict) {
    console.log(`  OK    ${e164}  owned by this account. Printed on: ${where.join(', ')}`);
  } else {
    bad += 1;
    console.log(`  FAIL  ${e164}  THIS ACCOUNT DOES NOT OWN IT, and the site prints it.`);
    console.log(`        Printed on: ${where.join(', ')}`);
    console.log('        A number we do not own can be recycled to somebody else, and this page');
    console.log('        would then point a reader at a stranger while claiming it is us.');
  }
}

console.log('─'.repeat(62));
console.log(`${printed.size} number(s) printed · ${bad} not owned · ${unchecked} unverified`);
process.exit(bad ? 1 : 0);
