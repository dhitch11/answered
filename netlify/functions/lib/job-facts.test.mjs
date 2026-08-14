#!/usr/bin/env node
// job-facts.test.mjs — the decisions that change a bill must be reproducible from their inputs.
//
// This covers the PURE half of lib/job-facts.mjs. The database half is proved through the live
// serving path by POSTing a real booking and reading the row back, because that is the only
// evidence this estate accepts for a seam: a writer and a reader can each be correct and still
// never have been run against each other once.
//
// Two cases here exist because the code they test was WRONG in production earlier today, in a way
// no status code could reveal:
//   - a free-text `source` fed straight at a CHECK constraint, refused as an HTTP 200
//   - `after_hours` read off a field lib/booking.mjs never sets, so it was false on every job
//
//   node netlify/functions/lib/job-facts.test.mjs

import * as f from './job-facts.mjs';
import { normalize } from './booking.mjs';

let failed = 0;
let ran = 0;
const t = (name, got, want) => {
  ran += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      got ${JSON.stringify(got)}${ok ? '' : `\n      want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond, detail) => {
  ran += 1;
  if (!cond) failed += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
};

// ── source: the column has a CHECK constraint, the endpoint takes free text ───────────────────
console.log('\n── source categorisation ───────────────────');
t('an allowed value passes through untouched', f.normalizeSource('voice').source, 'voice');
t('a call sid makes it voice whatever the label said', f.normalizeSource('marketing-test', { hasCallSid: true }).source, 'voice');
t('an ElevenLabs label becomes voice', f.normalizeSource('elevenlabs-agent').source, 'voice');
t('a web label becomes form', f.normalizeSource('website widget').source, 'form');
t('a console label becomes operator', f.normalizeSource('cockpit manual entry').source, 'operator');
t('anything else becomes api', f.normalizeSource('zapier-hook-7').source, 'api');
t('the raw claim is never lost', f.normalizeSource('zapier-hook-7').source_raw, 'zapier-hook-7');
// ★ REGRESSION. The first version matched bare substrings, so the very first booking sent through
// production, tagged "lane-jobrec-baseline", filed itself as VOICE because "baseline" contains
// "line". These four are the whole family of that bug.
t('"baseline" is not a phone line', f.normalizeSource('lane-jobrec-baseline').source, 'api');
t('"online form" is a form, not a voice call', f.normalizeSource('online form').source, 'form');
t('"callback widget" is a form, not a voice call', f.normalizeSource('callback widget').source, 'form');
t('"decline-handler" is neither', f.normalizeSource('decline-handler').source, 'api');
t('but a real phone word still lands', f.normalizeSource('inbound phone call').source, 'voice');
ok(
  'EVERY input produces a value the CHECK constraint accepts',
  ['voice', 'x', '', 'operator', 'weird thing', 'FORM', 'lane-jobrec-baseline', '../../etc', '🙂']
    .every((s) => f.SOURCES.includes(f.normalizeSource(s).source)),
  `SOURCES = ${f.SOURCES.join(', ')}. A value outside this list fails jobs_source_check, and PostgREST answers that as HTTP 200 with ok:false.`,
);

// ── after hours: the fact that decides $19 or $49 ────────────────────────────────────────────
console.log('\n── after hours ─────────────────────────────');
const HOURS = {
  mon: [['07:00', '17:00']], tue: [['07:00', '17:00']], wed: [['07:00', '17:00']],
  thu: [['07:00', '17:00']], fri: [['07:00', '17:00']], sat: [['08:00', '12:00']], sun: [],
};
const TZ = 'America/Los_Angeles';
const at = (iso) => new Date(iso);   // 2026-08-12 is a Wednesday

const inside = f.afterHoursFact({ at: at('2026-08-12T16:00:00Z'), tz: TZ, hours: HOURS });   // 09:00 PDT Wed
t('a Wednesday morning is standard hours', [inside.after_hours, inside.determined], [false, true]);
ok('and it names the posted span it fell inside', /posted wed hours of 7:00am to 5:00pm/.test(inside.basis), inside.basis);

const night = f.afterHoursFact({ at: at('2026-08-13T04:00:00Z'), tz: TZ, hours: HOURS });    // 21:00 PDT Tue
t('nine at night is after hours', [night.after_hours, night.determined], [true, true]);

const sunday = f.afterHoursFact({ at: at('2026-08-16T18:00:00Z'), tz: TZ, hours: HOURS });
t('a day posted CLOSED is after hours, and that is DETERMINED', [sunday.after_hours, sunday.determined], [true, true]);
ok('and it says the business posts that day closed', /posts sun as closed/.test(sunday.basis), sunday.basis);

const noHours = f.afterHoursFact({ at: at('2026-08-13T04:00:00Z'), tz: TZ, hours: null });
t('NO POSTED HOURS falls to the cheaper answer, never the premium', [noHours.after_hours, noHours.determined], [false, false]);
ok('and it says plainly it could not be established', /could not be established/.test(noHours.basis), noHours.basis);

const badZone = f.afterHoursFact({ at: at('2026-08-13T04:00:00Z'), tz: 'Mars/Olympus', hours: HOURS });
t('an unusable timezone is undetermined, not a crash', [badZone.after_hours, badZone.determined], [false, false]);

const NIGHT_SHIFT = { ...HOURS, wed: [['22:00', '06:00']], thu: [['22:00', '06:00']] };
const crossing = f.afterHoursFact({ at: at('2026-08-13T08:00:00Z'), tz: TZ, hours: NIGHT_SHIFT }); // 01:00 PDT Thu
t('a 24-hour line whose span crosses midnight is honoured', [crossing.after_hours, crossing.determined], [false, true]);

t('the opening minute is inside', f.afterHoursFact({ at: at('2026-08-12T14:00:00Z'), tz: TZ, hours: HOURS }).after_hours, false);
t('the closing minute is outside', f.afterHoursFact({ at: at('2026-08-13T00:00:00Z'), tz: TZ, hours: HOURS }).after_hours, true);

// ★ THE REGRESSION THAT MATTERS MOST. The shop's posted hours are wall-clock text on the SHOP's
// clock. The same instant is a $19 booking for a Los Angeles shop and, read on the caller's New
// York clock, an $49 one. Reading hours in the caller's zone is a wrong bill, not a rounding error.
const sameInstant = at('2026-08-13T00:30:00Z');   // 17:30 PDT (closed) / 20:30 EDT
t('the shop clock and the caller clock give different answers, so the shop clock must win',
  [
    f.afterHoursFact({ at: sameInstant, tz: 'America/Los_Angeles', hours: HOURS }).after_hours,
    f.afterHoursFact({ at: sameInstant, tz: 'America/New_York', hours: HOURS }).after_hours,
  ], [true, true]);
const openInLA = at('2026-08-12T23:30:00Z');      // 16:30 PDT (open) / 19:30 EDT (would read closed)
t('a booking inside LA hours must not read as after hours just because the caller is in New York',
  [
    f.afterHoursFact({ at: openInLA, tz: 'America/Los_Angeles', hours: HOURS }).after_hours,
    f.afterHoursFact({ at: openInLA, tz: 'America/New_York', hours: HOURS }).after_hours,
  ], [false, true]);

// ── the two fields the old code read that normalize() never writes ───────────────────────────
console.log('\n── the fields that were never there ────────');
const n = normalize({
  shop_name: 'QA', customer_name: 'QA Caller', service: 'test',
  starts_at: new Date(Date.now() + 864e5).toISOString(), source: 'lane-jobrec-baseline',
});
ok('normalize() produced a job', n.ok, n.ok ? `job ${n.job.id}` : n.errors.join('; '));
t('normalize() does NOT set after_hours, so Boolean(j.after_hours) was always false', n.job.after_hours, undefined);
t('normalize() does NOT set trade either', n.job.trade, undefined);
t('normalize() DOES pass free text through as src', n.job.src, 'lane-jobrec-baseline');
ok(
  'and that free text is exactly what jobs_source_check would have refused',
  !f.SOURCES.includes(n.job.src) && f.SOURCES.includes(f.normalizeSource(n.job.src).source),
  `"${n.job.src}" is not in the allowed list; it categorises to "${f.normalizeSource(n.job.src).source}"`,
);

// ── the honest empty state ──────────────────────────────────────────────────────────────────
// With no ANSWERED_DB_* configured, nothing may report a write that did not happen.
console.log('\n── honest empty states ─────────────────────');
for (const k of ['ANSWERED_DB_URL', 'ANSWERED_DB_ANON', 'ANSWERED_DB_SECRET']) delete process.env[k];
const c = await f.createChecked({ job_ref: 'AJ0123456789' });
t('an unconfigured create reports landed:false, never ok:true', [c.ok, c.landed], [false, false]);
ok('and it says why', /not reachable/.test(c.reason), c.reason);
const cNoRef = await f.createChecked({});
ok('a create with no reference is refused locally', cNoRef.ok === false && /reference/.test(cNoRef.reason), cNoRef.reason);
// ★ THE VOID GUARD MUST FIRE BEFORE THE DATABASE IS EVEN CONSULTED. sv_job_void does
// nullif(p_reason,'') and voids the row anyway, so an empty reason leaves status='voided' with
// void_reason NULL: a booking somebody was charged for, cancelled by nobody, for nothing.
const vEmpty = await f.voidChecked('AJ0123456789', '', 'tester');
ok('a void with NO reason is refused, and refused LOCALLY', vEmpty.ok === false && /needs a reason/.test(vEmpty.error), vEmpty.error);
const vBadRef = await f.voidChecked('!!', 'a reason', 'tester');
ok('a void of a malformed reference is refused', vBadRef.ok === false && /not a job reference/.test(vBadRef.error), vBadRef.error);
const vNoDb = await f.voidChecked('AJ0123456789', 'a real reason', 'tester');
ok('a void with a reason but no database reports failure, never success', vNoDb.ok === false && /not reachable/.test(vNoDb.error), vNoDb.error);
ok('and the refusal shape is the one portal.mjs reads', Object.prototype.hasOwnProperty.call(vNoDb, 'ok') && Object.prototype.hasOwnProperty.call(vNoDb, 'error'), JSON.stringify(vNoDb));

const acct = await f.resolveAccount('+19165550142');
t('an unconfigured owner lookup returns null, not a guess', acct.account_id, null);
ok('and it says why, so the orphan is named', /not reachable/.test(acct.reason), acct.reason);
const noLine = await f.resolveAccount('');
ok('no line number is its own honest reason', /no usable line number/.test(noLine.reason), noLine.reason);
const facts = await f.factsFor(n.job);
t('factsFor still builds a writable row with no database', [facts.row.job_ref === n.job.id, facts.row.account_id], [true, null]);
ok('and the row carries a legal source', f.SOURCES.includes(facts.row.source), `source=${facts.row.source} source_raw=${facts.row.details.source_raw}`);
ok('and after_hours is a boolean with its reasoning attached', typeof facts.row.after_hours === 'boolean' && Boolean(facts.row.details.after_hours_basis), `${facts.row.after_hours} : ${facts.row.details.after_hours_basis}`);
ok('and nothing in the row is undefined', Object.values(facts.row).every((v) => v !== undefined), Object.entries(facts.row).filter(([, v]) => v === undefined).map(([k]) => k).join(', ') || 'no undefined values');

// ── the seam: does the caller read fields the callee actually returns? ───────────────────────
//
// ★ THIS IS THE CHECK THAT WOULD HAVE CAUGHT THE DEFECT THAT SHIPPED TODAY. booking.mjs read
// `jobRes.account_matched` while recordJob returned `owned`, so `!undefined` was true and the
// "no owning account" warning fired on EVERY booking, including the owned ones. Both halves were
// individually correct and had never been run against each other, which is the entire thesis of
// seams.test.mjs. A writer and a reader are only correct together.
console.log('\n── the booking.mjs <-> recordJob contract ──');
const { readFileSync } = await import('node:fs');
const jobsMod = await import('./jobs.mjs');
const callerSrc = readFileSync(new URL('../booking.mjs', import.meta.url), 'utf8');

const readsInCaller = [...new Set([...callerSrc.matchAll(/\bjobRes\s*\.\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))];
ok('booking.mjs reads at least one field off the job result', readsInCaller.length > 0, `reads: ${readsInCaller.join(', ')}`);

// The unconfigured early return is the NARROWEST shape recordJob can produce, so every field the
// caller reads must be present in it or the caller is reading undefined on the failure path.
const narrow = await jobsMod.recordJob({ id: 'AJ0123456789', ln: '+19165550142' }, '');
const missing = readsInCaller.filter((k) => !Object.prototype.hasOwnProperty.call(narrow, k));
ok(
  'every field booking.mjs reads exists on recordJob\'s narrowest return',
  missing.length === 0,
  missing.length
    ? `MISSING: ${missing.join(', ')} — the caller would read undefined on the failure path`
    : `all present: ${readsInCaller.join(', ')} (narrow shape: ${Object.keys(narrow).join(', ')})`,
);
ok(
  'booking.mjs does NOT read the field name that was wrong',
  !readsInCaller.includes('account_matched'),
  readsInCaller.includes('account_matched') ? 'account_matched is back and recordJob does not return it' : 'account_matched is gone; the caller reads `owned`',
);
ok(
  'recordBooking and recordJob are the same function',
  jobsMod.recordBooking === jobsMod.recordJob,
  'two lanes published two names for one seam; both must resolve to one implementation',
);

console.log(`\n${'─'.repeat(60)}\n${ran - failed}/${ran} passed`);
process.exit(failed ? 1 : 0);
