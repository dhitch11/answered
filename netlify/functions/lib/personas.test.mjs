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
import {
  PERSONAS, personaFor, routeTable, describe,
  guardClause, guardWhole, deterministicLine, contextDigits, isAbusive,
} from './personas.mjs';

let pass = 0;
let fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass += 1; } catch (e) { fail += 1; failures.push(name + '\n    ' + String(e.message).split('\n')[0]); }
}

const riley = PERSONAS.riley;
const scout = PERSONAS.scout;
const onboard = PERSONAS.onboard;

// ── 1. RILEY IS FROZEN ──────────────────────────────────────────────────────
// The live demo line. If any of these change, a real call and a canary pass are
// owed before the change ships, and this test is the thing that says so.

t('riley spec is the exact text the live line has been serving', () => {
  // The digest of the RILEY_SPEC that was inside answered-brain.mjs at commit
  // b18062b, which is what +1 916 350 4869 has been answering with. Measured,
  // not asserted from memory. Change this line only with a real call behind it.
  assert.equal(createHash('sha256').update(riley.spec).digest('hex'),
    '61b6d62f935243e27c49ce5d7366a47543e80b8ed86e9491cf472a5351d3af02');
  assert.equal(riley.spec.length, 1597);
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
  assert.deepEqual(riley.outFloors.map((f) => f.by),
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
  const ctx = contextDigits(riley, ['we open at seven thirty']);
  assert.equal(ctx, '', 'riley context is raw digits only, exactly as it was');
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
let LAST_SYSTEM = '';
let LAST_MAX_TOKENS = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.startsWith('https://api.anthropic.com/')) return realFetch(url, init);
  const b = JSON.parse(init.body);
  LAST_SYSTEM = b.system;
  LAST_MAX_TOKENS = b.max_tokens;
  if (!b.stream) {
    return new Response(JSON.stringify({ content: [{ type: 'text', text: MODEL_REPLY }] }), {
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
  assert.ok(LAST_SYSTEM.startsWith('You are Riley'), 'riley spec');
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

// ── report ──────────────────────────────────────────────────────────────────
console.log('\npersonas: ' + pass + ' passed, ' + fail + ' failed');
for (const f of failures) console.log('  FAIL  ' + f);
process.exit(fail ? 1 : 0);
