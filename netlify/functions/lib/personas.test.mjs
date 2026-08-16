// personas.test.mjs — the floors, asserted. Run it with:
//
//   node netlify/functions/lib/personas.test.mjs
//
// It needs no network, no keys and no phone: the registry is pure, and the
// handler is driven through its real default export with a stubbed Anthropic.
//
// ★ EVERY FLOOR IS TESTED TWICE, ONCE TO FIRE AND ONCE TO STAY QUIET. A guard
// that blocks everything passes a fire-only suite and destroys the product.
// The estate has shipped exactly that mistake before, so the negative control
// is not optional here; half the assertions below are benign sentences the
// floors must let through.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  PERSONAS, personaFor, routeTable, describe,
  guardClause, guardWhole, deterministicLine, contextDigits, isAbusive,
  noteHeader, DEFAULT_NOTE_HEADER, RILEY_SPEC_FROZEN, RILEY_BOOKING,
} from './personas.mjs';
import { BOOK_TOOL, WINDOWS, WINDOW_KEYS } from './tools.mjs';

let pass = 0;
let fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass += 1; } catch (e) { fail += 1; failures.push(name + '\n    ' + String(e.message).split('\n')[0]); }
}

const riley = PERSONAS.riley;
const scout = PERSONAS.scout;
const onboard = PERSONAS.onboard;
const customer = PERSONAS.customer;

// ── 1. RILEY IS FROZEN ──────────────────────────────────────────────────────
// The live demo line. If any of these change, a real call and a canary pass are
// owed before the change ships, and this test is the thing that says so.

t('riley spec is the exact text the live line has been serving', () => {
  // The digest of the RILEY_SPEC that was inside answered-brain.mjs at commit
  // b18062b, which is what +1 916 350 4869 has been answering with. Measured,
  // not asserted from memory. Change this line only with a real call behind it.
  //
  // ★ THIS DIGEST MOVED ONCE, ON 2026-08-16, AND ONLY FOR THE NAME. David ruled the persona is
  // THOMAS (backup: Parker), company ANSWERED. Exactly one word changed in the spoken spec;
  // every rule, window, and hard line below it is byte-identical. The digest is re-pinned rather
  // than deleted, because a freeze you can edit without noticing is not a freeze.
  //
  // ★ IT DID NOT MOVE WHEN THE LINE LEARNED TO BOOK (2026-08-14). The
  // booking rules were APPENDED as their own constant, so the 1,597 characters
  // the live line has been answering with are still exactly these bytes and
  // are still asserted here. The test below is the other half: it checks that
  // the frozen text is where the model actually reads it, at the top of the
  // spec, and not merely sitting unused in a variable.
  assert.equal(createHash('sha256').update(RILEY_SPEC_FROZEN).digest('hex'),
    '53b5c892d9136d3c5f185bf2bdb07f6e78deba8dee7470b2ba31ce004a15075e');
  assert.equal(RILEY_SPEC_FROZEN.length, 1598);
});

t('the frozen text is what riley actually leads with, not a museum piece', () => {
  assert.ok(riley.spec.startsWith(RILEY_SPEC_FROZEN),
    'the frozen spec must be the LIVE prefix; a preserved copy nobody serves proves nothing');
  assert.ok(riley.spec.includes(RILEY_BOOKING), 'the booking rules must be in the served spec');
  // Nothing was inserted between them, and nothing was dropped from the end.
  assert.equal(riley.spec, RILEY_SPEC_FROZEN + '\n\n' + RILEY_BOOKING);
});

// ── 1b. THE HANDS ───────────────────────────────────────────────────────────
// A voice that can act needs a floor under the act, not just under the words.

t('riley may call exactly one tool, and it is the booking one', () => {
  assert.deepEqual(riley.tools, [BOOK_TOOL]);
  for (const p of [scout, onboard, customer]) {
    assert.ok(!(p.tools || []).length, p.id + ' has no hands and must not grow any by accident');
  }
});

t('the booking rules tell riley the tool is the only thing that books', () => {
  assert.ok(RILEY_BOOKING.includes(BOOK_TOOL), 'the tool is named so the model can find it');
  assert.match(RILEY_BOOKING, /Nothing is on the schedule until/);
  assert.match(RILEY_BOOKING, /never fill anything in yourself/i);
  assert.match(RILEY_BOOKING, /Only after it tells you the visit is booked/);
  assert.match(RILEY_BOOKING, /Never tell somebody a visit is on the schedule when it is not/);
});

t('riley speaks the three windows the tool can actually book, and no others', () => {
  // If somebody edits one list and not the other, the voice offers a time the
  // tool cannot take, and the caller hears a pivot instead of a booking.
  assert.deepEqual(WINDOW_KEYS, ['tuesday_8am', 'tuesday_130pm', 'wednesday_9am']);
  assert.match(RILEY_SPEC_FROZEN, /Tuesday 8:00 in the morning, Tuesday 1:30 in the afternoon, and Wednesday 9:00 in the morning/);
  for (const w of Object.values(WINDOWS)) {
    assert.ok([2, 3].includes(w.day), 'a window on a day riley is not allowed to say: ' + w.spoken);
  }
});

t('the tool lines survive riley OWN floors, which is not obvious and is the point', () => {
  // These strings are read by the model and spoken in its own words, but the
  // holding line and the failure line are spoken verbatim. A holding line that
  // trips the numeral or contact floor would come out as a pivot mid booking.
  for (const line of [riley.toolHold, riley.toolFail]) {
    const g = guardClause(riley, line, contextDigits(riley, [], ''));
    assert.ok(g.ok, 'blocked by ' + g.by + ': ' + line);
    assert.ok(!/[0-9]/.test(line), 'no digits: ' + line);
  }
  // and neither of them claims a booking that has not happened
  assert.ok(!/booked|on the schedule/i.test(riley.toolHold), riley.toolHold);
  assert.match(riley.toolFail, /nothing is booked/i);
});

t('a tool turn gets its own token budget, and an ordinary turn does not', () => {
  // Five booking fields do not fit in 120 tokens beside a spoken sentence, and
  // a truncated arguments object is not a smaller booking, it is none.
  assert.ok(riley.toolMaxTokens > riley.maxTokens);
  assert.equal(riley.maxTokens, 120, 'the ordinary cadence budget must not have moved');
});

t('riley caps are unchanged', () => {
  assert.equal(riley.maxTokens, 120);
  assert.equal(riley.temperature, 0.6);
  assert.equal(riley.sentenceCap, 2);
  assert.equal(riley.wordCap, 45);
  assert.equal(riley.softCloseAt, 8);
  assert.equal(riley.hardCloseAt, 11);
});

t('riley floor ORDER is unchanged, because order is behaviour', () => {
  // 'unbooked-claim' was added on 2026-08-14 when the voice grew hands, and it is FIRST because a
  // false booking is the worst sentence this line can produce. The five frozen floors keep their
  // order relative to each other underneath it, which is the part that was never allowed to move.
  assert.deepEqual(riley.outFloors.map((f) => f.by),
    ['unbooked-claim', 'price', 'contact-promise', 'ai-denial', 'payment', 'slot-invention', 'numeral']);
  assert.deepEqual(riley.outFloors.map((f) => f.by).filter((b) => b !== 'unbooked-claim'),
    ['price', 'contact-promise', 'ai-denial', 'payment', 'slot-invention', 'numeral']);
  assert.deepEqual(riley.inBranches.map((b) => b.by),
    ['crisis', 'payment-offered', 'ai-asked', 'demo-asked', 'abuse']);
});

t('riley numeral allowlist is unchanged', () => {
  assert.deepEqual(Array.from(riley.numAllow).sort(), ['00', '1', '130', '30', '8', '800', '9', '900', '911'].sort());
});

t('riley did NOT inherit the outbound floors', () => {
  const names = riley.outFloors.map((f) => f.by);
  for (const n of ['claim', 'date-promise', 'live-claim']) assert.ok(!names.includes(n), n + ' leaked onto the live line');
  assert.equal(riley.stop, undefined, 'riley has no stop branch: nobody cold calls an inbound line');
});

// ── 2. ROUTING ──────────────────────────────────────────────────────────────

t('the live demo path still resolves to riley', () => {
  assert.equal(personaFor('/api/answered-brain', {}).persona.id, 'riley');
  assert.equal(personaFor('/api/answered-brain/chat/completions', {}).persona.id, 'riley');
  assert.equal(personaFor('/api/answered-brain', {}).by, 'path');
});

t('each persona owns its own path, with and without the vendor suffix', () => {
  assert.equal(personaFor('/api/answered-brain/scout', {}).persona.id, 'scout');
  assert.equal(personaFor('/api/answered-brain/scout/chat/completions', {}).persona.id, 'scout');
  assert.equal(personaFor('/api/answered-brain/onboard', {}).persona.id, 'onboard');
  assert.equal(personaFor('/api/answered-brain/onboard/chat/completions', {}).persona.id, 'onboard');
  assert.equal(personaFor('/api/answered-brain/riley/chat/completions', {}).persona.id, 'riley');
});

t('a trailing slash or a query string does not lose the persona', () => {
  assert.equal(personaFor('/api/answered-brain/scout/', {}).persona.id, 'scout');
  assert.equal(personaFor('/api/answered-brain/scout/chat/completions?x=1', {}).persona.id, 'scout');
});

t('body and model fields can only select a persona when the path did not', () => {
  assert.equal(personaFor('/api/answered-brain/scout', { persona: 'onboard' }).persona.id, 'scout');
  assert.equal(personaFor('/unknown', { persona: 'scout' }).persona.id, 'scout');
  assert.equal(personaFor('/unknown', { model: 'answered-onboard' }).persona.id, 'onboard');
  assert.equal(personaFor('/unknown', { persona: 'nonsense' }).persona.id, 'riley');
  assert.equal(personaFor('/unknown', {}).by, 'default');
});

t('every persona route is exported for netlify, suffixed form included', () => {
  const rt = routeTable();
  assert.equal(rt[0], '/api/answered-brain', 'the live demo path must be first');
  for (const p of Object.values(PERSONAS)) {
    for (const r of p.routes) {
      assert.ok(rt.includes(r), r);
      assert.ok(rt.includes(r + '/chat/completions'), r + '/chat/completions');
    }
  }
  assert.equal(new Set(rt).size, rt.length, 'no duplicate routes');
});

// ★ THE ASSERTION THAT REPLACES A LIVE OUTAGE.
// answered-brain.mjs must declare config.path as a STATIC LITERAL, because
// Netlify reads it by static analysis and silently drops anything it cannot
// evaluate. On 2026-08-14 that exact mistake put /api/answered-brain at 404 in
// production while the function itself answered 200 on its default route: the
// demo line's agent was pointing at a URL that did not exist, and every build,
// probe and unit test was green. So there are two assertions here, and they
// are different assertions on purpose: the literal must BE a literal, and the
// literal must MATCH the registry.
t('config.path is a static literal, not a computed value', () => {
  const src = readFileSync(new URL('../answered-brain.mjs', import.meta.url), 'utf8');
  const m = src.match(/export const config = \{\s*path:\s*(\[[\s\S]*?\])/);
  assert.ok(m, 'config.path must be written as an array literal in the file');
  assert.ok(!/routeTable\(\)/.test(m[1]), 'a function call here is dropped by the bundler');
  const declared = JSON.parse(m[1].replace(/'/g, '"').replace(/,(\s*\])/g, '$1'));
  assert.deepEqual(declared, routeTable(), 'the declared routes have drifted from the registry');
  assert.equal(declared[0], '/api/answered-brain', 'the live demo line path must be declared first');
});

t('a declared path removes the default route, so the default must not be relied on', () => {
  // Recorded because this is the signature that identifies the failure in one
  // curl: if /.netlify/functions/answered-brain answers while /api/answered-brain
  // 404s, no path was registered at all.
  const src = readFileSync(new URL('../answered-brain.mjs', import.meta.url), 'utf8');
  assert.ok(/\/\.netlify\/functions\/answered-brain\s+->\s+200/.test(src),
    'the outage signature must stay written down in the file');
});

// ── 3. THE FLOORS, EACH ONE FIRED AND EACH ONE HELD ─────────────────────────

const fires = (p, text, by, ctx = '') => {
  const g = guardClause(p, text, ctx);
  assert.equal(g.ok, false, 'expected ' + by + ' to fire on: ' + text);
  assert.equal(g.by, by, 'wrong floor fired on: ' + text);
};
const quiet = (p, text, ctx = '') => {
  const g = guardClause(p, text, ctx);
  assert.equal(g.ok, true, 'a floor (' + g.by + ') wrongly fired on: ' + text);
};

t('riley: price fires on a dollar sign and on the word', () => {
  fires(riley, 'It is about $89 for the trip.', 'price');
  fires(riley, 'That runs ninety dollars.', 'price');
  quiet(riley, 'I can get somebody out to look at it.');
});

t('riley: contact promise fires, ordinary help does not', () => {
  fires(riley, "I'll text you the details.", 'contact-promise');
  fires(riley, 'Someone will call you back.', 'contact-promise');
  quiet(riley, 'Let me get you on the book right now.');
});

t('riley: an AI denial is blocked, an honest admission is not', () => {
  fires(riley, "No, I'm a real person.", 'ai-denial');
  fires(riley, "I'm not a bot.", 'ai-denial');
  quiet(riley, "I'm an AI receptionist on the demo line.");
});

t('riley: only the three windows survive the day and numeral floors', () => {
  fires(riley, 'How about Thursday morning?', 'slot-invention');
  fires(riley, 'I have 3:45 open.', 'numeral');
  quiet(riley, 'Tuesday at 8:00, Tuesday at 1:30, or Wednesday at 9:00.');
  quiet(riley, 'So that is 9165550134, correct?', '9165550134');
});

t('riley: numerals the caller said first are read back, not blocked', () => {
  quiet(riley, 'Got it, unit 412.', '412');
  fires(riley, 'Got it, unit 412.', 'numeral', '999');
});

t('scout: it never sells, never prices, never claims a result', () => {
  fires(scout, 'It is only $19 a booked job.', 'price');
  fires(scout, 'Most shops save 30 percent.', 'claim');
  fires(scout, 'We have helped a lot of contractors.', 'claim');
  fires(scout, 'We guarantee you will book more.', 'claim');
});

t('scout: the claim floor does NOT eat honest speech', () => {
  quiet(scout, 'That is what most shops tell us.');
  quiet(scout, 'I cannot guarantee anything, I am just asking.');
  quiet(scout, 'Understood, so it goes to voicemail after hours.');
  quiet(scout, 'Thanks, that is exactly what I was after.');
});

t('scout: a delivery promise and a date promise are both blocked', () => {
  fires(scout, 'I will text you the code.', 'contact-promise');
  fires(scout, 'We will have it to you by Tuesday.', 'date-promise');
});

t('scout: the date floor lets ordinary manners through', () => {
  quiet(scout, 'I will be out of your hair in a minute.');
  quiet(scout, 'Sounds like you are slammed tomorrow, I will let you go.');
  quiet(scout, 'Thanks for your time, and good luck out there.');
});

t('scout: no numeral it was not given', () => {
  fires(scout, 'About 40 percent of calls go unanswered.', 'claim'); // claim wins, it is earlier
  fires(scout, 'I will note it as 3 missed calls.', 'numeral');
  quiet(scout, 'Got it, three a week.', contextDigits(scout, ['about three a week']));
});

t('scout: a spoken number from the callee counts as said', () => {
  const ctx = contextDigits(scout, ['we open at seven thirty and close at five']);
  quiet(scout, 'So 7:30 to 5, got it.', ctx);
  fires(scout, 'So 6:15, got it.', 'numeral', ctx);
});

t('riley does NOT get the spoken number widening', () => {
  // The context became a SET when the numeral firewall stopped being a substring test — it was
  // matching any number appearing anywhere in the caller's concatenated digits, which let six of
  // seven invented figures through. The SUBSTANCE of this assertion is unchanged and is what
  // matters: Riley's context contains no number the caller only SPELLED OUT, so she is still held
  // to digits alone and the live line's behaviour is not widened.
  const ctx = contextDigits(riley, ['we open at seven thirty']);
  assert.equal(ctx.size, 0, 'riley context must not pick up spelled-out numbers');
  const withDigits = contextDigits(riley, ['my number is 916 350 4869']);
  assert.ok(withDigits.has('916') && withDigits.has('9163504869'),
    'riley still grounds on digits the caller actually said, including the run read back as one');
  assert.ok(!withDigits.has('16') && !withDigits.has('6350'),
    'but no longer on arbitrary substrings spanning unrelated numbers');
});

t('onboard: it cannot say anything is live, but it can read a setup back', () => {
  fires(onboard, 'You are all set.', 'live-claim');
  fires(onboard, 'Your line is live now.', 'live-claim');
  fires(onboard, 'I have switched it on.', 'live-claim');
  quiet(onboard, 'So you are set on seven to five, and after that it comes to us?');
  quiet(onboard, 'Nothing switches on today, I am just getting this down.');
});

t('onboard: no price, no date, no card', () => {
  fires(onboard, 'That plan is $39 a month.', 'price');
  fires(onboard, 'We will have you going by Monday.', 'date-promise');
  fires(onboard, 'I can take a credit card now.', 'payment');
  quiet(onboard, 'Every number is on the site, and I do not set them.');
});

// ── the customer line: the owner's numbers are his, and only his ────────────
// This is the persona that answers for a REAL business, under rules a real
// owner typed. Its floors have to let his truth through and stop everything
// else, so every assertion below comes in a pair.

const OWNER_RULES = [
  'You are Dana, answering the phone for Delgado Electric.',
  'Hours: open 7:00 to 5:00 Monday to Friday.',
  'The owner wrote this down about pricing, and it is the only pricing you may repeat:',
  'A diagnostic visit is $145. Panel quotes are free.',
  'After hours a caller gets a message taken and the owner calls back.',
].join('\n');
const ownerCtx = (said = []) => contextDigits(customer, said, OWNER_RULES);

t('customer: a price the OWNER wrote down is speakable', () => {
  quiet(customer, 'A diagnostic visit is $145, and a panel quote is free.', ownerCtx());
  quiet(customer, 'We are open 7:00 to 5:00, Monday through Friday.', ownerCtx());
});

t('customer: a price the owner did NOT write is not speakable', () => {
  fires(customer, 'A diagnostic visit is $220.', 'numeral', ownerCtx());
  fires(customer, 'We can be there at 6:45.', 'numeral', ownerCtx());
});

t('customer: a SPELLED price is held to the same allowlist as a written one', () => {
  // the sentence with no digits in it, which is how a numeral firewall gets
  // walked straight past
  fires(customer, 'It is about two hundred dollars for that.', 'money-invention', ownerCtx());
  quiet(customer, 'That one is a hundred and forty five dollars.', ownerCtx());
});

t('customer: the money floor does not eat ordinary counting', () => {
  quiet(customer, 'One moment while I write that down.', ownerCtx());
  quiet(customer, 'I have two quick questions for you.', ownerCtx());
  quiet(customer, 'There is no charge to come and look.', ownerCtx());
});

t('customer: a callback is allowed because it is true, a text is not', () => {
  quiet(customer, 'I will take a message and the owner will call you back.', ownerCtx());
  fires(customer, 'I will text you when he is on his way.', 'message-promise', ownerCtx());
  fires(customer, 'I can email you the quote.', 'message-promise', ownerCtx());
});

t('customer: it cannot claim to be a person and cannot claim other jobs', () => {
  fires(customer, 'No, I am a real person here at the office.', 'ai-denial', ownerCtx());
  fires(customer, 'We have helped hundreds of homeowners with this.', 'claim', ownerCtx());
  quiet(customer, 'I am an AI assistant answering this line.', ownerCtx());
});

t('customer: a caller number is a read back, not an invention', () => {
  const ctx = ownerCtx(['my number is 559 555 0148']);
  quiet(customer, 'Got it, 5595550148, and what is the address?', ctx);
});

t('customer: the emergency branch is on a REAL line, so it ends the call', () => {
  const d = deterministicLine(customer, 'there is smoke pouring out of the panel', 0);
  assert.equal(d.by, 'crisis');
  assert.equal(d.end, true);
});

t('customer: the owner rules get a header that says they win on facts', () => {
  const h = noteHeader(customer);
  assert.ok(/win on every fact/i.test(h), h);
  assert.ok(/safety rules above still bind/i.test(h), h);
  // and the three voices we author keep the opposite layering
  for (const p of [riley, scout, onboard]) {
    assert.equal(noteHeader(p), DEFAULT_NOTE_HEADER, p.id);
    assert.ok(/rules above always win/.test(noteHeader(p)), p.id);
  }
});

t('the buffered guard stops at the first bad clause and keeps what was clean', () => {
  const out = guardWhole(riley, 'I can get somebody out there. It is about $89 for the trip. Want it?', '');
  assert.ok(out.startsWith('I can get somebody out there.'));
  assert.ok(out.includes('The office quotes prices'));
  assert.ok(!out.includes('$89'));
});

t('the sentence cap is per persona and it truncates', () => {
  assert.equal(guardWhole(riley, 'One. Two. Three. Four.', ''), 'One. Two.');
  assert.equal(guardWhole(onboard, 'One. Two. Three. Four.', ''), 'One. Two. Three.');
});

// ── 4. THE DETERMINISTIC BRANCHES ───────────────────────────────────────────

t('an emergency ends the call on every persona', () => {
  for (const p of [riley, scout, onboard]) {
    const d = deterministicLine(p, 'I smell gas in the kitchen', 0);
    assert.equal(d.by, 'crisis', p.id);
    assert.equal(d.end, true, p.id);
    assert.ok(/911/.test(d.line), p.id + ' must say the number out loud');
  }
});

t('a card number read out loud is refused on every persona', () => {
  for (const p of [riley, scout, onboard]) {
    assert.equal(deterministicLine(p, 'my card number is 4111 1111 1111 1111', 0).by, 'payment-offered', p.id);
  }
});

t('asked what they are, every persona answers honestly and none denies it', () => {
  for (const p of [riley, scout, onboard]) {
    const d = deterministicLine(p, 'am I talking to a robot', 0);
    assert.equal(d.by, 'ai-asked', p.id);
    assert.equal(guardClause(p, d.line, '').ok, true, p.id + ' answer must survive its own floors');
  }
  // and the outbound pair also catch the phrasings scripts.mjs knows about
  assert.equal(deterministicLine(scout, 'what are you', 0).by, 'ai-asked');
});

t('riley alone answers the is-this-real question, because only she is a demo', () => {
  assert.equal(deterministicLine(riley, 'is this real', 0).by, 'demo-asked');
  // The outbound pair have no demo branch, and should not: their call IS real,
  // so "is this real" falls to the model, where the spec and the ai-denial
  // floor already make a dishonest answer unreachable.
  assert.equal(deterministicLine(scout, 'is this real', 0), null);
  assert.equal(guardClause(scout, 'Yes, this is a real call. I am an A I voice.', '').ok, true);
  // but the identity question in any of its usual shapes is still caught
  for (const q of ['is this a recording', 'are you a robot', 'what are you', 'am i talking to a real person']) {
    assert.equal(deterministicLine(scout, q, 0).by, 'ai-asked', q);
  }
});

t('the disclosure is in the WORDS, not just in the rule firing', () => {
  // ★ RELAYED FROM THE FUTUREFUL VOICE LANE, 2026-08-14, and it is worth guarding here because
  // their line failed exactly this way: asked "is this an AI?" it answered "there's a real person
  // behind the listening part." False, and a California disclosure exposure. Their conclusion was
  // that prose inside a long prompt does not enforce itself.
  //
  // Our answer is deterministic, so the model never writes it, and the test above already asserts
  // the RULE fires (`by === 'ai-asked'`). But a rule firing is not the right words being spoken:
  // that is the estate's own "a tool firing is not its number being spoken". So this asserts the
  // TEXT a caller actually hears.
  const asks = ['is this an AI', 'are you a real person', 'am i talking to a robot',
                'is this a recording', 'you sound fake, are you a bot'];
  const CLAIMS_HUMAN = /\b(?:i am|i'm)\s+(?:a\s+)?(?:real|human|actual)\b|\breal person\b|\bnot a (?:bot|robot|computer|machine|recording)\b/i;
  const SAYS_AI = /\b(?:a\s*i|ai|artificial)\b|\bassistant\b|\bvirtual\b/i;
  for (const id of ['riley', 'customer']) {
    const p = PERSONAS[id];
    for (const q of asks) {
      const d = deterministicLine(p, q, 1);
      const said = String((d && (d.line || d.text)) || '');
      assert.ok(said, `${id} said nothing to "${q}"`);
      assert.ok(SAYS_AI.test(said), `${id} did not disclose it is an AI when asked "${q}": ${said}`);
      assert.ok(!CLAIMS_HUMAN.test(said), `${id} claimed to be a person when asked "${q}": ${said}`);
    }
  }
  // POSITIVE CONTROL: the matchers must be capable of failing, or every line above passes forever.
  assert.ok(CLAIMS_HUMAN.test("there's a real person behind the listening part"),
    'the human-claim matcher cannot catch the exact sentence that caused the incident');
  assert.ok(!SAYS_AI.test('let me grab that for you'), 'the disclosure matcher fires on anything');
});

t('a stop on an outbound call is returned unresolved, never as a claim', () => {
  const d = deterministicLine(scout, 'take me off your list', 0);
  assert.equal(d.stop, true);
  assert.equal(d.end, true);
  assert.equal(d.line, undefined, 'the line depends on whether a row was written, so the registry must not choose it');
  assert.equal(deterministicLine(onboard, 'do not call me again', 0).stop, true);
});

t('stop outranks every other branch', () => {
  assert.equal(deterministicLine(scout, 'stop calling me, are you a robot', 0).stop, true);
});

t('a contractor answering the discovery question is NOT a stop', () => {
  // the measured false positive that suppressed a real answer: "we stop taking
  // calls at six" is the answer we rang to get.
  assert.equal(deterministicLine(scout, 'we stop taking calls at six', 0), null);
  assert.equal(deterministicLine(scout, 'it goes to voicemail and I call back in the morning', 0), null);
});

t('riley has no stop branch, so a caller saying stop just keeps talking to her', () => {
  assert.equal(deterministicLine(riley, 'stop calling me', 0), null);
});

t('the hard close fires at the persona ceiling and not before', () => {
  assert.equal(deterministicLine(riley, 'ok', 10), null);
  assert.equal(deterministicLine(riley, 'ok', 11).by, 'hard-close');
  assert.equal(deterministicLine(scout, 'ok', 3), null);
  assert.equal(deterministicLine(scout, 'ok', 4).by, 'hard-close');
  assert.equal(deterministicLine(onboard, 'ok', 15), null);
  assert.equal(deterministicLine(onboard, 'ok', 16).by, 'hard-close');
});

t('abuse ends an outbound call and does not end an inbound one', () => {
  assert.equal(deterministicLine(riley, "you're useless", 0).end, false);
  assert.equal(deterministicLine(scout, "you're useless", 0).end, true);
});

t('one swear word is not abuse, two is', () => {
  assert.equal(isAbusive('the damn thing is shit'), false);
  assert.equal(isAbusive('this shit is fucking broken'), true);
});

t('the abuse detector does not carry state between calls', () => {
  // ABUSE_RE is a /g regex; a .test() loop over it would alternate true/false.
  for (let i = 0; i < 5; i++) assert.equal(isAbusive('this shit is fucking broken'), true, 'run ' + i);
});

// ── 5. EVERY LINE A PERSONA CAN SPEAK MUST SURVIVE ITS OWN FLOORS ───────────
// A pivot that trips another floor is an infinite pivot. A close line that
// trips one is a call that cannot end.

t('every fixed line of every persona passes that persona own guards', () => {
  for (const p of Object.values(PERSONAS)) {
    const lines = [
      p.breaker, p.closeLine,
      ...p.outFloors.map((f) => f.pivot),
      ...p.inBranches.map((b) => b.line),
      ...(p.stop ? [p.stop.lineSuppressed, p.stop.lineUnrecorded] : []),
    ];
    for (const line of lines) {
      const g = guardClause(p, line, '');
      assert.equal(g.ok, true, p.id + ' floor ' + g.by + ' blocks its own line: ' + line);
    }
  }
});

t('no fixed line, spec or pivot carries an em dash', () => {
  for (const p of Object.values(PERSONAS)) {
    const all = [p.spec, p.breaker, p.closeLine, p.softCloseNote,
      ...p.outFloors.map((f) => f.pivot), ...p.inBranches.map((b) => b.line),
      ...(p.stop ? [p.stop.lineSuppressed, p.stop.lineUnrecorded] : [])].join(' ');
    assert.ok(!/[—–]/.test(all), p.id + ' has an em dash in spoken copy');
  }
});

t('no persona spec promises a text message, because SMS is carrier blocked', () => {
  for (const p of Object.values(PERSONAS)) {
    assert.ok(/never promise|Never promise|do not need|never take/i.test(p.spec), p.id);
  }
  assert.ok(/Never promise to send them anything/.test(scout.spec));
  assert.ok(/Never promise to send a text or an email/.test(onboard.spec));
});

t('both outbound specs state the disclosure ALREADY happened, never that it should be skipped', () => {
  for (const p of [scout, onboard]) {
    assert.ok(/ALREADY said/.test(p.spec), p.id + ' must know the disclosure was spoken');
    assert.ok(/A I voice/.test(p.spec), p.id);
    assert.ok(/Never claim to be a person/.test(p.spec), p.id);
  }
  assert.ok(/recorded/.test(scout.spec), 'the research call is recorded and says so');
});

// ── 6. THE SELF DESCRIPTION ─────────────────────────────────────────────────

t('describe() names every persona, leaks no prompt and no secret', () => {
  const d = describe();
  assert.equal(d.length, 4);
  const blob = JSON.stringify(d);
  assert.ok(!blob.includes('Cedar Ridge'), 'the spec must not be serialised');
  assert.ok(!blob.includes('sk-'), 'no key shaped string');
  assert.deepEqual(d.map((x) => x.id), ['riley', 'scout', 'onboard', 'customer']);
  assert.equal(d[0].frozen, true);
  assert.equal(d[1].agent_env, 'ANSWERED_RESEARCH_AGENT_ID');
  assert.equal(d[2].agent_env, 'ANSWERED_ONBOARD_AGENT_ID');
  assert.equal(d[3].agent_env, 'ANSWERED_CUSTOMER_AGENT_ID');
  assert.deepEqual(d[0].tools, [BOOK_TOOL], 'the registry tells the truth about what a voice can DO');
  assert.deepEqual(d[1].tools, []);
  assert.ok(d[1].input_branches.includes('stop'));
  assert.ok(!d[3].input_branches.includes('stop'), 'an inbound line has no stop branch');
});

// ── 7. THROUGH THE REAL HANDLER ─────────────────────────────────────────────
// The registry being right is not the same as the bridge using it.

process.env.ANSWERED_BRAIN_SECRET = 'test-secret';
process.env.ANTHROPIC_API_KEY_LIVE = 'test-key';
delete process.env.ANSWERED_DB_URL;
delete process.env.ANSWERED_DB_ANON;
delete process.env.ANSWERED_DB_SECRET;

let MODEL_REPLY = '';
let MODEL_TOOL = null;      // { name, json } -> streamed as a real tool_use content block
let LAST_SYSTEM = '';
let LAST_MAX_TOKENS = 0;
let LAST_TOOLS = null;
let LAST_MESSAGES = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.startsWith('https://api.anthropic.com/')) return realFetch(url, init);
  const b = JSON.parse(init.body);
  LAST_SYSTEM = b.system;
  LAST_MAX_TOKENS = b.max_tokens;
  LAST_TOOLS = b.tools || null;
  LAST_MESSAGES = b.messages;
  if (!b.stream) {
    const content = [{ type: 'text', text: MODEL_REPLY }];
    if (MODEL_TOOL) {
      let input = null;
      try { input = JSON.parse(MODEL_TOOL.json); } catch (e) { input = MODEL_TOOL.json; }
      content.push({ type: 'tool_use', id: 'toolu_test', name: MODEL_TOOL.name, input });
    }
    return new Response(JSON.stringify({ content }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    start(c) {
      for (let i = 0; i < MODEL_REPLY.length; i += 5) {
        c.enqueue(enc.encode('data: ' + JSON.stringify({
          type: 'content_block_delta', delta: { type: 'text_delta', text: MODEL_REPLY.slice(i, i + 5) },
        }) + '\n\n'));
      }
      if (MODEL_TOOL) {
        // exactly the shape Anthropic streams: one start, a run of partial json, one stop.
        // Chunked mid token on purpose, because a parser that only works on whole json is a
        // parser that works in a test and fails on a phone.
        c.enqueue(enc.encode('data: ' + JSON.stringify({
          type: 'content_block_start', index: 1,
          content_block: { type: 'tool_use', id: 'toolu_test', name: MODEL_TOOL.name, input: {} },
        }) + '\n\n'));
        for (let i = 0; i < MODEL_TOOL.json.length; i += 7) {
          c.enqueue(enc.encode('data: ' + JSON.stringify({
            type: 'content_block_delta', index: 1,
            delta: { type: 'input_json_delta', partial_json: MODEL_TOOL.json.slice(i, i + 7) },
          }) + '\n\n'));
        }
        c.enqueue(enc.encode('data: ' + JSON.stringify({ type: 'content_block_stop', index: 1 }) + '\n\n'));
      }
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

const brain = (await import('../answered-brain.mjs')).default;
const post = (path, body, auth = 'test-secret') => brain(new Request('https://answered.reddenda.com' + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + auth },
  body: JSON.stringify(body),
}));
const spoken = (sse) => (sse.match(/"content":"((?:[^"\\]|\\.)*)"/g) || [])
  .map((m) => JSON.parse('{' + m + '}').content).join('');

async function at(name, fn) {
  try { await fn(); pass += 1; } catch (e) { fail += 1; failures.push(name + '\n    ' + String(e.message).split('\n')[0]); }
}

await at('the demo line warm ping still answers exactly what demo-health expects', async () => {
  const r = await post('/api/answered-brain', { warm: true });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.warm, 'riley');
});

await at('each persona path warms as itself', async () => {
  assert.equal((await (await post('/api/answered-brain/scout', { warm: true })).json()).warm, 'scout');
  assert.equal((await (await post('/api/answered-brain/onboard/chat/completions', { warm: true })).json()).warm, 'onboard');
});

await at('every persona path is bearer gated, not just the live one', async () => {
  for (const p of routeTable()) {
    const r = await post(p, { warm: true }, 'wrong');
    assert.equal(r.status, 401, p);
  }
});

await at('the bridge describes itself without spending a token or leaking a prompt', async () => {
  const j = await (await post('/api/answered-brain/scout', { describe: true })).json();
  assert.equal(j.routed_here_as, 'scout');
  assert.equal(j.personas.length, 4);
  assert.ok(!JSON.stringify(j).includes('Cedar Ridge'));
});

await at('the persona in the path chooses the system prompt and the token budget', async () => {
  MODEL_REPLY = 'Understood, thanks.';
  await post('/api/answered-brain/scout', { messages: [{ role: 'user', content: 'it goes to voicemail' }] });
  assert.ok(LAST_SYSTEM.startsWith('You are the voice on an outbound research call'), 'scout spec');
  assert.equal(LAST_MAX_TOKENS, 90);
  await post('/api/answered-brain', { messages: [{ role: 'user', content: 'my heater is out' }] });
  assert.ok(LAST_SYSTEM.startsWith('You are Thomas'), 'thomas spec');
  assert.equal(LAST_MAX_TOKENS, 120);
});

await at('a persona floor fires on the streaming path and ends the turn there', async () => {
  MODEL_REPLY = 'Good question. Most shops save 30 percent with us. Want to hear more?';
  const sse = await (await post('/api/answered-brain/scout', {
    messages: [{ role: 'user', content: 'does it work' }], stream: true,
  })).text();
  const said = spoken(sse);
  assert.ok(said.includes('Good question.'), said);
  assert.ok(said.includes('I am not going to throw numbers at you'), said);
  assert.ok(!said.includes('30 percent'), 'the claim reached the caller: ' + said);
  assert.ok(!said.includes('Want to hear more'), 'the turn continued after a blocked clause');
});

await at('the same reply through riley is blocked by HER floor, with her words', async () => {
  MODEL_REPLY = 'Sure thing. It is $89 for the trip. Want a window?';
  const said = spoken(await (await post('/api/answered-brain', {
    messages: [{ role: 'user', content: 'how much' }], stream: true,
  })).text());
  assert.ok(said.includes('The office quotes prices, I only book the visit.'), said);
  assert.ok(!said.includes('$89'), said);
});

await at('a stop with no number available speaks the WEAKER, true sentence', async () => {
  const j = await (await post('/api/answered-brain/scout', {
    messages: [{ role: 'user', content: 'take me off your list' }],
  })).json();
  const said = j.choices[0].message.content;
  assert.equal(said, scout.stop.lineUnrecorded);
  assert.ok(!/taken this number off/.test(said), 'it claimed a suppression it did not write');
});

await at('a stop asks for end_call when the agent offers the tool', async () => {
  const j = await (await post('/api/answered-brain/scout', {
    messages: [{ role: 'user', content: 'do not call me again' }],
    tools: [{ type: 'function', function: { name: 'end_call' } }],
  })).json();
  assert.equal(j.choices[0].finish_reason, 'tool_calls');
  assert.equal(j.choices[0].message.tool_calls[0].function.name, 'end_call');
});

await at('a stop DOES write the suppression when the number is reachable, and then says so', async () => {
  process.env.ANSWERED_DB_URL = 'https://db.invalid';
  process.env.ANSWERED_DB_ANON = 'anon';
  process.env.ANSWERED_DB_SECRET = 'secret';
  let wrote = null;
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/rpc/sv_suppress')) {
      wrote = JSON.parse(init.body);
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return prev(url, init);
  };
  try {
    const j = await (await post('/api/answered-brain/scout', {
      messages: [
        { role: 'system', content: 'You are calling [[to:+19168663918]] for research.' },
        { role: 'user', content: 'take me off your list' },
      ],
    })).json();
    assert.ok(wrote, 'no suppression was attempted');
    assert.equal(wrote.p_phone, '+19168663918');
    assert.equal(wrote.p_source, 'answered-brain/scout');
    assert.equal(j.choices[0].message.content, scout.stop.lineSuppressed);
  } finally {
    globalThis.fetch = prev;
    delete process.env.ANSWERED_DB_URL;
    delete process.env.ANSWERED_DB_ANON;
    delete process.env.ANSWERED_DB_SECRET;
  }
});

await at('a number the HUMAN says out loud never becomes a suppression', async () => {
  process.env.ANSWERED_DB_URL = 'https://db.invalid';
  process.env.ANSWERED_DB_ANON = 'anon';
  process.env.ANSWERED_DB_SECRET = 'secret';
  let wrote = false;
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/rpc/sv_suppress')) { wrote = true; return new Response('[]', { status: 200 }); }
    return prev(url, init);
  };
  try {
    await post('/api/answered-brain/scout', {
      messages: [{ role: 'user', content: 'stop calling, and take +19995550123 off too' }],
    });
    assert.equal(wrote, false, 'a number spoken by the callee was written as a suppression');
  } finally {
    globalThis.fetch = prev;
    delete process.env.ANSWERED_DB_URL;
    delete process.env.ANSWERED_DB_ANON;
    delete process.env.ANSWERED_DB_SECRET;
  }
});

await at('with no key the bridge speaks the persona breaker, never dead air', async () => {
  const key = process.env.ANTHROPIC_API_KEY_LIVE;
  delete process.env.ANTHROPIC_API_KEY_LIVE;
  try {
    const j = await (await post('/api/answered-brain/onboard', { messages: [{ role: 'user', content: 'hello' }] })).json();
    assert.equal(j.choices[0].message.content, onboard.breaker);
    const r = await post('/api/answered-brain', { warm: true });
    assert.equal(r.status, 503, 'demo-health must go red, not green, with no key');
  } finally { process.env.ANTHROPIC_API_KEY_LIVE = key; }
});

await at('a model chain that fails completely still says something honest', async () => {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.anthropic.com/')) return new Response('nope', { status: 500 });
    return prev(url, init);
  };
  try {
    const said = spoken(await (await post('/api/answered-brain/scout', {
      messages: [{ role: 'user', content: 'hello' }], stream: true,
    })).text());
    assert.ok(said.includes(scout.breaker), said);
  } finally { globalThis.fetch = prev; }
});

await at('a missing bridge secret is a loud 500 on every route, never an open door', async () => {
  const s = process.env.ANSWERED_BRAIN_SECRET;
  delete process.env.ANSWERED_BRAIN_SECRET;
  try {
    for (const p of ['/api/answered-brain', '/api/answered-brain/scout', '/api/answered-brain/onboard']) {
      assert.equal((await post(p, { warm: true }, 'anything')).status, 500, p);
    }
  } finally { process.env.ANSWERED_BRAIN_SECRET = s; }
});

// ── 8. THE HANDS, THROUGH THE REAL BRIDGE ───────────────────────────────────
// The registry saying riley may book is not the same as a booking leaving the
// wire. Everything below drives the real default export and reads the SSE.

const GOOD_ARGS = JSON.stringify({
  customer_name: 'Dana Whitfield',
  address: '4412 Fair Oaks Boulevard, Sacramento',
  callback_number: '916 866 3918',
  service: 'water heater is leaking',
  window: 'tuesday_8am',
});
const EL_DECLARES = [{ type: 'function', function: { name: 'book_job', description: 'book it', parameters: { type: 'object' } } }];
const toolCallsIn = (sse) => (sse.match(/"tool_calls":\[[^\]]*\]/g) || []);

await at('a tool call actually leaves the bridge, in the shape the vendor reads', async () => {
  MODEL_REPLY = '';
  MODEL_TOOL = { name: 'book_job', json: GOOD_ARGS };
  const sse = await (await post('/api/answered-brain', {
    stream: true, tools: EL_DECLARES, conversation_id: 'conv_abc123',
    messages: [{ role: 'user', content: 'Dana Whitfield, forty four twelve Fair Oaks, nine one six eight six six three nine one eight, Tuesday at eight' }],
  })).text();
  MODEL_TOOL = null;
  const calls = toolCallsIn(sse);
  assert.equal(calls.length, 1, 'exactly one tool call on the wire');
  assert.ok(/"finish_reason":"tool_calls"/.test(sse), 'the turn must end as a tool call, not as a stop');
  const emitted = JSON.parse('{' + calls[0] + '}').tool_calls[0];
  assert.equal(emitted.function.name, 'book_job');
  assert.equal(emitted.type, 'function');
  const args = JSON.parse(emitted.function.arguments);
  assert.equal(args.customer_name, 'Dana Whitfield');
  assert.equal(args.window, 'tuesday_8am');
  // The bridge sets this, never the model: it is half of the idempotency key.
  assert.equal(args.conversation_id, 'conv_abc123');
  // and the caller is not left in silence while the booking is written
  assert.ok(spoken(sse).includes(riley.toolHold), spoken(sse));
});

await at('the model is only handed the tool when the VENDOR declared it', async () => {
  LAST_TOOLS = null;
  MODEL_REPLY = 'Okay, what is the address?';
  await post('/api/answered-brain', { stream: true, messages: [{ role: 'user', content: 'my heater is out' }] });
  assert.equal(LAST_TOOLS, null, 'no declaration, no tool: a call nobody can run is worse than no call');
  assert.equal(LAST_MAX_TOKENS, 120, 'and an ordinary turn keeps the ordinary budget');

  await post('/api/answered-brain', { stream: true, tools: EL_DECLARES, messages: [{ role: 'user', content: 'my heater is out' }] });
  assert.equal(LAST_TOOLS.length, 1);
  assert.equal(LAST_TOOLS[0].name, 'book_job');
  assert.ok(LAST_TOOLS[0].input_schema.properties.window.enum.length === 3, 'the model can only express the three real windows');
  assert.equal(LAST_MAX_TOKENS, riley.toolMaxTokens);
});

await at('a voice with no hands cannot grow them from a vendor console', async () => {
  LAST_TOOLS = null;
  MODEL_REPLY = 'Understood, thanks.';
  await post('/api/answered-brain/scout', { stream: true, tools: EL_DECLARES, messages: [{ role: 'user', content: 'voicemail' }] });
  assert.equal(LAST_TOOLS, null, 'scout is not on the allowlist, so declaring the tool changes nothing');
});

await at('arguments the bridge cannot parse book NOTHING and say so out loud', async () => {
  MODEL_REPLY = '';
  MODEL_TOOL = { name: 'book_job', json: '{"customer_name": "Dana", "addre' };  // truncated by max_tokens
  const sse = await (await post('/api/answered-brain', {
    stream: true, tools: EL_DECLARES, messages: [{ role: 'user', content: 'book it' }],
  })).text();
  MODEL_TOOL = null;
  assert.equal(toolCallsIn(sse).length, 0, 'half an arguments object must never reach the vendor');
  assert.ok(spoken(sse).includes(riley.toolFail), spoken(sse));
  assert.ok(!/"finish_reason":"tool_calls"/.test(sse));
});

await at('a tool answer reaches the model instead of being silently dropped', async () => {
  MODEL_REPLY = 'You are on the schedule for Tuesday morning.';
  await post('/api/answered-brain', {
    stream: true, tools: EL_DECLARES,
    messages: [
      { role: 'user', content: 'Tuesday at eight works' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'book_job', arguments: GOOD_ARGS } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'BOOKED. It is written down and the shop has it, for Tuesday at eight in the morning.' },
    ],
  });
  const blob = JSON.stringify(LAST_MESSAGES);
  assert.ok(blob.includes('[the booking system answered]'), 'the answer must be in the conversation the model reads');
  assert.ok(blob.includes('BOOKED.'), blob.slice(0, 200));
  // and the tool is NOT offered again, because the visit is already on the schedule
  assert.equal(LAST_TOOLS, null, 'one visit, one booking');
});

await at('a FAILED tool answer leaves the tool on the table for another try', async () => {
  MODEL_REPLY = 'I could not get that down. What is the address again?';
  await post('/api/answered-brain', {
    stream: true, tools: EL_DECLARES,
    messages: [
      { role: 'user', content: 'book it' },
      { role: 'tool', tool_call_id: 'call_1', content: 'NOT BOOKED, because something is still missing: the address. Ask the caller for it.' },
    ],
  });
  assert.ok(LAST_TOOLS && LAST_TOOLS.length === 1,
    'a failure that reads as a success would leave the caller with no second attempt');
});

await at('an unanswered tool call is RUN by the bridge rather than narrated', async () => {
  // The vendor declared the tool, emitted the call and never came back with an
  // answer. Left alone the model would tell somebody their visit is booked.
  let hit = null;
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/answered-tool')) {
      hit = { url: String(url), body: JSON.parse(init.body), auth: init.headers.Authorization };
      return new Response(JSON.stringify({ ok: true, booked: true, result: 'BOOKED. It is written down.' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return prev(url, init);
  };
  try {
    MODEL_REPLY = 'You are all set for Tuesday morning.';
    await post('/api/answered-brain', {
      stream: true, tools: EL_DECLARES, conversation_id: 'conv_orphan',
      messages: [
        { role: 'user', content: 'yes book it' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'book_job', arguments: GOOD_ARGS } }] },
        { role: 'user', content: 'are we good?' },
      ],
    });
  } finally { globalThis.fetch = prev; }
  assert.ok(hit, 'the bridge must run the tool the vendor abandoned');
  assert.ok(hit.url.includes('tool=book_job'), hit.url);
  assert.equal(hit.body.conversation_id, 'conv_orphan');
  assert.ok(/^Bearer /.test(hit.auth), 'the recovery hop is authenticated like every other one');
  assert.ok(JSON.stringify(LAST_MESSAGES).includes('BOOKED. It is written down.'));
});

await at('a recovery that fails is spoken as unknown, never as booked', async () => {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/answered-tool')) throw new Error('network down');
    return prev(url, init);
  };
  try {
    MODEL_REPLY = 'Let me check on that.';
    await post('/api/answered-brain', {
      stream: true, tools: EL_DECLARES,
      messages: [
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'book_job', arguments: GOOD_ARGS } }] },
        { role: 'user', content: 'are we good?' },
      ],
    });
  } finally { globalThis.fetch = prev; }
  const blob = JSON.stringify(LAST_MESSAGES);
  assert.ok(blob.includes('NOT CONFIRMED'), blob.slice(-300));
  assert.ok(!/\[the booking system answered\] BOOKED/.test(blob));
});

await at('the buffered path books too, because demo-health drives it', async () => {
  MODEL_REPLY = 'Getting that down now.';
  MODEL_TOOL = { name: 'book_job', json: GOOD_ARGS };
  const j = await (await post('/api/answered-brain', {
    tools: EL_DECLARES, conversation_id: 'conv_buffered',
    messages: [{ role: 'user', content: 'book it for Tuesday at eight' }],
  })).json();
  MODEL_TOOL = null;
  assert.equal(j.choices[0].finish_reason, 'tool_calls');
  const args = JSON.parse(j.choices[0].message.tool_calls[0].function.arguments);
  assert.equal(args.conversation_id, 'conv_buffered');
});

await at('every existing floor still runs on a turn that has tools on it', async () => {
  // The tool must not become a hole in the guard: a priced sentence is still
  // pivoted even when the model is mid booking.
  MODEL_REPLY = 'That will be $200 for the visit.';
  const sse = await (await post('/api/answered-brain', {
    stream: true, tools: EL_DECLARES, messages: [{ role: 'user', content: 'how much' }],
  })).text();
  assert.ok(spoken(sse).includes('The office quotes prices'), spoken(sse));
});

// ── 9. THE FLOOR THE SIMULATOR FOUND ────────────────────────────────────────
// A full conversation was run through the real agent with the tool mocked. The
// model read "Tool Called." and said "You're all set, Marcus. I have you booked
// for Tuesday at eight in the morning." Nothing had been booked. These are the
// assertions that make that sentence impossible.

const ctx = contextDigits(riley, [], '');
const guard = (line, booked) => guardClause(riley, line, ctx, { booked });

t('an unbacked booking claim is blocked, in all the ways a model says it', () => {
  const claims = [
    "You're all set, Marcus.",
    'You are all set.',
    'I have you booked for Tuesday.',
    "I've got you booked.",
    "You're booked.",
    'You are scheduled.',
    "We've got you scheduled.",
    "That's booked.",
    'The visit is confirmed.',
    "You're on the schedule.",
    "It's on the books.",
    "You're locked in.",
  ];
  for (const c of claims) {
    const g = guard(c, false);
    assert.equal(g.ok, false, 'went through unblocked: ' + c);
    assert.equal(g.by, 'unbooked-claim', c + ' -> ' + g.by);
    assert.ok(/nothing is booked/i.test(g.pivot), g.pivot);
  }
});

t('the same sentences are fine once a booking really happened', () => {
  for (const c of ["You're all set, Marcus.", 'I have you booked for Tuesday.', "You're on the schedule."]) {
    assert.equal(guard(c, true).ok, true, 'blocked a TRUE statement: ' + c);
  }
});

t('the floor does NOT block the hold language the frozen spec requires', () => {
  // "hold the window out loud, like 'I have you penciled in for Tuesday at eight'"
  const holds = [
    'I have you penciled in for Tuesday at eight.',
    'I have you down for Tuesday at eight.',
    'Let me get that written down for you.',
    'Which one works for you?',
    'Let me get you on the schedule, what is the address?',
    'I can book you in once I have the address.',
  ];
  for (const h of holds) {
    const g = guard(h, false);
    assert.ok(g.ok || g.by !== 'unbooked-claim', 'the hold language must survive: ' + h + ' -> ' + (g.by || 'ok'));
  }
});

t('a caller forgetting to pass the state gets the floor at FULL strength', () => {
  // The failure direction of a missing argument is a pivot, never a claim.
  assert.equal(guardClause(riley, "You're all set.", ctx).ok, false);
  assert.equal(guardClause(riley, "You're all set.", ctx, {}).ok, false);
  assert.equal(guardClause(riley, "You're all set.", ctx, { booked: undefined }).ok, false);
});

t('no other voice grew this floor by accident', () => {
  for (const p of [scout, onboard, customer]) {
    assert.ok(!p.outFloors.some((f) => f.by === 'unbooked-claim'), p.id);
  }
});

await at('the bridge blocks the claim on a call where nothing was booked', async () => {
  MODEL_REPLY = "Yeah. You're all set, Marcus. I have you booked for Tuesday at eight in the morning.";
  const sse = await (await post('/api/answered-brain', {
    stream: true, tools: EL_DECLARES,
    messages: [
      { role: 'user', content: 'so are we good?' },
      { role: 'tool', tool_call_id: 'call_1', content: 'Tool Called.' },
    ],
  })).text();
  const said = spoken(sse);
  assert.ok(/nothing is booked/i.test(said), 'the exact sentence the simulator produced got through: ' + said);
  assert.ok(!/all set/i.test(said), said);
});

await at('and lets it through on a call where something was', async () => {
  MODEL_REPLY = "You're all set, Marcus. I have you booked for Tuesday at eight in the morning.";
  const sse = await (await post('/api/answered-brain', {
    stream: true, tools: EL_DECLARES,
    messages: [
      { role: 'user', content: 'so are we good?' },
      { role: 'tool', tool_call_id: 'call_1', content: 'BOOKED. It is written down and the shop has it, for Tuesday at eight in the morning.' },
    ],
  })).text();
  assert.ok(/all set/i.test(spoken(sse)), 'a true sentence must not be pivoted: ' + spoken(sse));
});

// ── report ──────────────────────────────────────────────────────────────────
console.log('\npersonas: ' + pass + ' passed, ' + fail + ' failed');
for (const f of failures) console.log('  FAIL  ' + f);
process.exit(fail ? 1 : 0);
