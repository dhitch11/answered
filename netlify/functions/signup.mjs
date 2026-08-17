// /api/signup — the front door. A contractor texts, an AI sets their line up, and the account is
// real when the conversation ends.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
//
// Measured 2026-08-17: every form on every public page posted to `/api/interest`, a waitlist.
// index, trades, hold and pricing all carried `action="/api/interest"`. `setup.html` had NO FORM AT
// ALL and its call to action looped back to the waitlist. Meanwhile a complete account system
// already existed, with working RPCs (sv_account_start, sv_account_save_config,
// sv_account_request_line) and every gate holding under thirteen attack probes, sitting behind a
// footer link measured at 96% of the way down the homepage.
//
// So the product worked and the front door collected email addresses. David's ruling, verbatim:
// "We are not doing a waitlist. They actually need to be able to sign up."
//
// ── WHY TEXT AND NOT A FORM ──────────────────────────────────────────────────────────────────
//
// A trade contractor is on a phone, often on a job, often with one hand. The console is a good tool
// and it is a 5,845px page at 390px wide, which is the right shape for somebody sitting down and the
// wrong shape for somebody deciding in four seconds whether this is real. A text thread asks one
// question at a time, keeps their place if they put the phone down, and is the same channel the
// product itself uses, so the first thing they experience IS the thing they are buying.
//
// ── WHAT IT REFUSES TO DO ────────────────────────────────────────────────────────────────────
//
//  1. Invent. Every reply passes `guardWhole()` from lib/personas.mjs, the SAME floors the voice
//     runs. A signup AI gets asked "how much is it" and "when can you start" in the first two
//     messages, and prompt instructions do not hold: the estate has seven output floors precisely
//     because the model agreed to a rule and then broke it. Reusing them is not laziness, it is the
//     only version that is safe.
//  2. Collect and go nowhere. On completion this writes a real account row via sv_account_start,
//     saves the config, and emails the operator. ★ THAT PARAGRAPH USED TO SAY the account was
//     created on the first reply, and it was FALSE: nothing in this file touched the account system
//     and nothing anywhere read the store it wrote to. Every finished signup was told "a person
//     assigns your number" and no person was told. A comment claiming a behaviour the code does not
//     have is worse than no comment, because it reads as documentation and stops anyone checking.
//  3. Text anyone who did not text us. This function only ever REPLIES. It is driven by inbound
//     webhook, never by a scheduler, so it cannot become outreach by accident.
//  4. Claim the line is live. It is not live until a number is assigned, which is a human step, and
//     saying otherwise is the exact lie the voice floors already refuse.

import crypto from 'node:crypto';
import * as blobs from '@netlify/blobs';
import { PERSONAS, guardWhole } from './lib/personas.mjs';
// ★ isStop() carries twenty real phrasings and the voice path already uses it. A bare keyword match
// caught 3 of 12 ways people actually say stop: "STOP texting me", "please stop", "remove me from
// this list", "quit texting", "unsubscribe me" and the Spanish forms all fell through and got a
// reply. Consent withdrawal must not depend on somebody typing one word in isolation.
import { isStop } from './lib/scripts.mjs';
import { startAccount, saveConfig, dbConfigured } from './lib/accounts.mjs';
import { rpc } from './lib/db.mjs';
import { notifyOperator } from './lib/account-notify.mjs';

export const config = {
  // A LITERAL. Netlify reads this by static analysis at bundle time and silently drops a computed
  // value; this repo has shipped a function with a computed path that registered no routes at all.
  path: ['/api/signup'],
};

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const nowIso = () => new Date().toISOString();

/** The same store family the rest of the estate uses. */
function store(event, name) {
  if (typeof blobs.connectLambda === 'function') {
    try { blobs.connectLambda(event); } catch (e) { /* the first read or write is the verdict */ }
  }
  return blobs.getStore(name);
}

/** E.164 for a US number, matching normalizeUs in call-me.mjs so every hash in the estate agrees. */
function e164(raw) {
  const d = String(raw || '').replace(/\D+/g, '');
  if (d.length === 11 && d[0] === '1') return '+' + d;
  if (d.length === 10) return '+1' + d;
  if (String(raw || '').startsWith('+') && d.length >= 10) return '+' + d;
  return null;
}

// ── THE SETUP, AS AN ORDERED CONVERSATION ────────────────────────────────────────────────────
// One field per turn, in the order a contractor can answer without thinking. Business name first
// because it is the only field the account RPC requires, so the account becomes real on turn one.
//
// `ask` is what the AI says if it has nothing better. The model may rephrase, but the ORDER and the
// STOPPING POINT are decided here in code, not by the model, because a model deciding it has enough
// information is a model that stops early on the field nobody checked.
const STEPS = [
  { key: 'business_name', ask: 'What is the business called?' },
  { key: 'trade', ask: 'What trade are you in? Plumbing, HVAC, electrical, roofing, something else?' },
  { key: 'greeting_name', ask: 'What should your line call itself when it picks up? Most people pick a first name.' },
  { key: 'service_area', ask: 'Where do you work? A town and a rough radius is plenty.' },
  { key: 'hours_text', ask: 'What hours do you want it answering? You can say something like weekdays seven to five.' },
  { key: 'booking_destination', ask: 'Where should a booked job land? An email address works.' },
  { key: 'escalation_phone', ask: 'If somebody has a real emergency, what number should it ring?' },
];

// The one line that opens the thread. Says who it is and what is about to happen, because a text
// from an unknown number asking for a business name reads as a scam otherwise.
const GREET = 'This is Answered. I will set your line up in about seven questions.';

const DONE_LINE = 'That is everything. Your setup is saved and you can change any of it any time. '
  + 'A person assigns your number, and until that happens nothing is answering for you.';

const HELP_LINE = 'This is Answered setting up your line. Reply STOP to stop. '
  + 'Questions: help@reddenda.com';

// ── THE PERSONA ──────────────────────────────────────────────────────────────────────────────
// Built from the `onboard` persona, which is the closest existing shape: it collects a setup and is
// explicitly forbidden from claiming anything switched on. Reusing its floors rather than writing
// new ones, because the floors are the part that took a week of real calls to get right.
function signupPersona() {
  const base = PERSONAS.onboard;
  return {
    ...base,
    id: 'signup',
    label: 'the setup thread',
    // A text thread is not a phone call. Nobody reads three sentences on a phone screen while
    // standing on a roof, and there is no turn-taking pressure, so one short sentence per reply is
    // both kinder and less able to hide a claim in the middle of a paragraph.
    sentenceCap: 2,
    maxTokens: 90,
    // ★ THE NUMERAL FLOOR IS DROPPED HERE, AND ONLY HERE. Caught by a real conversation: a
    // contractor answered "weekdays 7 to 5" and the reply came back "I would rather not throw a
    // number at you", refusing a legitimate answer as if it were a price.
    //
    // That floor is correct for the VOICE, where any spoken number can be heard as a quote and
    // where the caller cannot see the digits to check them. In a setup thread the numbers ARE the
    // content: hours, a radius, a callback number. Blocking them makes the product unusable at
    // exactly the step it exists to complete.
    //
    // What replaces it is narrower and aimed at the actual risk: PRICE and MONEY still fire, so
    // "it costs 49 dollars" is still refused. Only the blanket "no numerals at all" is gone.
    outFloors: base.outFloors.filter((f) => !f.numeral),
  };
}

/** Ask the model for the next line. Falls back to the scripted ask, which is always safe. */
async function speak(step, said, profile) {
  const key = (process.env.ANTHROPIC_API_KEY_LIVE || '').trim();
  if (!key) return step.ask;

  // ★ THE MODEL REPHRASES ONE FIXED QUESTION. IT DOES NOT CHOOSE THE QUESTION.
  // Caught by a real conversation, not a unit test: asked for `trade`, the model asked "What phone
  // number should the line ring to?"; asked for `service_area`, it asked about the greeting. It was
  // running its own idea of a sensible order, so every answer landed in the wrong field and the
  // thread quietly collected garbage while sounding perfectly competent.
  //
  // A model that picks the next question is a model that decides it has enough information, and it
  // decides that early, on the field nobody checked. The order lives in STEPS, in code, above. The
  // model's only job is to make one sentence sound human.
  const system = [
    'You are setting up an AI phone line for a trade contractor, by text message.',
    '',
    'YOUR ONLY JOB THIS TURN is to ask this exact question, in your own words:',
    `  "${step.ask}"`,
    'Do not ask about anything else. Do not ask for a phone number, an email, hours, a name or a',
    'location unless that is what the question above asks for. Another part of this system decides',
    'the order and it has already decided.',
    '',
    'Keep it to one short sentence. Plain words. No sales language, no exclamation marks.',
    'Never quote a price. Never say when the line will be live. Never say it is switched on.',
    'If they asked you something, answer it in a few words first, then ask the question above.',
    profile.business_name ? `Their business is called ${profile.business_name}.` : '',
  ].filter(Boolean).join('\n');

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        // Haiku on merit for this slot, not to save money: the job is one short question at a time
        // from a fixed list, the ordering is decided in code above, and latency is what a person
        // feels in a text thread. A bigger model would be slower at a task that has no judgment in
        // it. The floors below are what make the output safe, and they run whatever answers.
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 90,
        system,
        messages: [{ role: 'user', content: String(said || '').slice(0, 400) || '(they just started)' }],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return step.ask;
    const j = await r.json();
    const text = (j.content || []).map((c) => c.text || '').join(' ').trim();
    if (!text) return step.ask;

    // ★ THE MODEL IS A CLAIM, NOT AN ANSWER. Same floors the voice runs: price, live-claim,
    // date-promise, numeral, monologue, stacked question, sales register. A refusal returns the
    // floor's own pivot, which is a real sentence, so the thread never stalls.
    const guarded = guardWhole(signupPersona(), text, [], {});
    return guarded || step.ask;
  } catch (e) {
    // A model that times out must never stop a signup. The scripted ask is always correct.
    return step.ask;
  }
}

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const reply = (text) => ({
  statusCode: 200,
  headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' },
  body: `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${
    String(text).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))
  }</Message></Response>`,
});

/** Twilio's signature scheme. FAILS CLOSED, copying sms-inbound.mjs: this endpoint writes. */
function verify(shim, params) {
  const token = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  if (!token) return { ok: false, why: 'TWILIO_AUTH_TOKEN is not set, so this webhook cannot verify Twilio' };
  const sig = (shim.headers['x-twilio-signature'] || '').trim();
  if (!sig) return { ok: false, why: 'no X-Twilio-Signature header' };
  const proto = shim.headers['x-forwarded-proto'] || 'https';
  const url = `${proto}://${shim.headers.host || ''}${shim.path}`;
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  const want = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
  const a = Buffer.from(sig); const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, why: 'signature mismatch' };
  return { ok: true };
}

export default async function handler(req, context) {
  const event = context && context.event ? context.event : null;

  let params = {};
  try {
    params = Object.fromEntries(new URLSearchParams(await req.text()));
  } catch (e) {
    console.error('signup: unreadable body');
    return new Response(EMPTY_TWIML, { status: 200, headers: { 'Content-Type': 'text/xml' } });
  }

  const headers = {};
  req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const v = verify({ headers, path: new URL(req.url).pathname }, params);
  if (!v.ok) {
    console.error('signup: REFUSED, ' + v.why + '. Nothing was written.');
    return new Response(EMPTY_TWIML, { status: 200, headers: { 'Content-Type': 'text/xml' } });
  }

  const from = e164(params.From);
  const said = String(params.Body || '').trim();
  if (!from) {
    console.error('signup: verified request with no usable From. Recorded nothing.');
    return new Response(EMPTY_TWIML, { status: 200, headers: { 'Content-Type': 'text/xml' } });
  }

  const word = said.toLowerCase().replace(/[^a-z]/g, '');

  // ★ STOP AND HELP ARE HANDLED BEFORE ANYTHING ELSE AND BEFORE ANY MODEL RUNS.
  // Twilio's Advanced Opt-Out already replies at platform level, so we answer with empty TwiML and
  // let the platform speak. What we must do is stop the SETUP thread as well, which the platform
  // knows nothing about.
  // ★ isStop() RATHER THAN A KEYWORD LIST. Measured against twelve real phrasings, the bare list
  // caught three. "STOP texting me", "please stop", "stop sending me texts", "unsubscribe me",
  // "remove me from this list", "quit texting", "no thanks, stop" and the Spanish forms all fell
  // through and got a reply, because `replace(/[^a-z]/g,'')` collapses the whole body into one
  // string and only an isolated keyword can match it. isStop() carries twenty patterns and the
  // voice path already trusts it. A person who says stop has said stop, however they phrase it.
  if (isStop(said)) {
    try {
      const s = store(event, 'signup');
      // ★ STRONG CONSISTENCY HERE TOO. This read was the ONE left eventually consistent, and it is
      // the highest-stakes path in the file. Measured: with the store lagging, a STOP read null,
      // wrote `{stopped}` over a record holding five real answers, and destroyed it. The path that
      // has to survive a dispute was the path that erased its own evidence.
      const rec = (await s.get(sha(from), { type: 'json', consistency: 'strong' })) || {};
      rec.stopped = nowIso();
      // A write failure must not throw: an unhandled rejection here is a 502, and Twilio
      // answers a 502 by REDELIVERING the same message, which lands the answer one field to
      // the right. Losing a write costs one turn; throwing costs a corrupted record.
      try { await s.setJSON(sha(from), rec); } catch (e) {
        console.error('signup: write failed for ' + rec.last4 + '; ' + String(e && e.message).slice(0, 90));
      }
    } catch (e) { /* the carrier stop still stands; ours is the redundant half */ }
    console.log('signup: STOP received; the setup thread is closed for this number.');
    return new Response(EMPTY_TWIML, { status: 200, headers: { 'Content-Type': 'text/xml' } });
  }
  // ★ HELP IS DELIBERATELY *NOT* ANSWERED HERE ANY MORE. It used to return before the store was
  // read, which put it in front of the turn cap: measured, 200 inbound HELP produced 200 outbound
  // SMS with the stored record still null. At $0.0113 a message and the 4/sec carrier ceiling that
  // is roughly $163/hour of outbound from one stranger with one phone, forever, and HELP is the
  // keyword every carrier tells consumers to send. It was the cheapest unbounded spend in the file.
  //
  // It falls through to the normal path now, so it is counted and capped like anything else. The
  // person is not left without help: Twilio's Advanced Opt-Out answers HELP at the PLATFORM level
  // before this function is reached, which is the same reason the inbound STOP handler replies with
  // empty TwiML rather than sending its own confirmation. Two replies to one HELP would be a
  // duplicate to the person and a second billed message to us.

  const s = store(event, 'signup');
  let rec;
  try {
    // ★ STRONG CONSISTENCY, ON THE READ, WHICH IS WHERE THIS ESTATE PUTS IT.
    // A setup thread writes on one turn and reads back a few seconds later on the next, every
    // single turn. That is precisely the access pattern eventual consistency loses, and losing it
    // here does not look like an error: the read returns null, the code treats it as a brand new
    // person, and the thread greets them and asks question one again. It looks like a broken state
    // machine and it is a stale read.
    //
    // The estate has paid for this once already: `call-me.mjs:462` records an arbitration read that
    // failed on eventual consistency and refused a genuine first click as a race loser, with strong
    // consistency used in 0 of 10 reads. `answered-canary.mjs:400` reads back the same way.
    rec = (await s.get(sha(from), { type: 'json', consistency: 'strong' })) || null;
  } catch (e) {
    // ★ THIS CATCH USED TO SET rec = null AND SAY NOTHING, AND IT COST THREE TEST RUNS.
    // A failed READ is indistinguishable from a first message when both produce a fresh record, so
    // every turn started over: the greeting reprinted, the cursor sat at step 0, and the thread
    // asked "what is the business called" five times while looking completely healthy. I fixed the
    // cursor and then a falsy-zero bug chasing it, because the symptom pointed at the state machine
    // and the fault was the store read being swallowed.
    //
    // A store that cannot be read is an incident, not a new customer. Say so.
    // ★ A FAILED READ MUST NOT WRITE. This used to fall through to a fresh record which was then
    // SAVED over the real one: measured, a thread holding four answers became `{profile:{}}` after
    // a single failed read. The comment said it would "repeat the first question"; the actual
    // damage was permanent data loss. A store we cannot read is a store we must not overwrite.
    console.error('signup: COULD NOT READ the thread for ' + from.slice(-4)
      + '; replying with nothing rather than overwriting a record we cannot see. '
      + String(e && e.message).slice(0, 120));
    return new Response(EMPTY_TWIML, { status: 200, headers: { 'Content-Type': 'text/xml' } });
  }
  if (!rec) rec = { started: nowIso(), profile: {}, step: 0, last4: from.slice(-4) };

  // ★ IDEMPOTENCY. Twilio retries on a timeout or a non-2xx, and a retry used to be recorded as a
  // NEW ANSWER: the same message landed one field to the right, so "Thomas" ended up in
  // service_area and the question that field belonged to was never asked. The record then looked
  // complete and was wrong. Measured twice, on two different fields.
  const msgSid = String(params.MessageSid || params.SmsSid || '').trim();
  if (msgSid && rec.lastSid === msgSid) {
    console.log(`signup: duplicate delivery of ${msgSid} for ${rec.last4}; replying, recording nothing.`);
    return new Response(reply(rec.lastLine || HELP_LINE).body, { status: 200, headers: { 'Content-Type': 'text/xml' } });
  }

  // ── ★ A CAP, BECAUSE THIS ENDPOINT SPENDS MONEY ON BEHALF OF A STRANGER ────────────────────
  //
  // Anyone in the world can text our published number, and until now every inbound produced an
  // outbound reply: $0.0113 per message in SMS plus carrier fees, about $11.30 per thousand, plus a
  // model call on any message containing a question mark. There was no cap of any kind. One bored
  // person with a script is an unbounded bill, and the first sign of it would have been the invoice.
  //
  // The cap is generous on purpose. A real setup is seven turns; somebody correcting an answer or
  // asking two questions might take fifteen. Forty is far past any honest signup and far below a
  // number that costs real money. The point is a ceiling, not a tight leash.
  //
  // ★ AND IT FAILS QUIET, NOT LOUD. Past the cap we record and stop REPLYING, rather than sending a
  // "you have sent too many messages" message. Answering an abuser costs exactly the thing we are
  // trying to stop spending. A real person who somehow reaches forty turns is not abandoned either:
  // their record and every answer they gave is intact, and the operator can see it.
  // ★ THE BLOB COUNTER BELOW CANNOT SURVIVE A BURST, AND IT WAS MEASURED FAILING.
  //
  // 30 signed messages fired concurrently from one number: 30 replies, counter left reading 1.
  // `rec.turns = (rec.turns || 0) + 1` is a read-modify-write, Netlify Blobs v8 has no
  // compare-and-swap (`onlyIfMatch` does not exist in this version), so every lambda in a burst
  // reads the same value and writes the same value. The effective cap was 40 x burst concurrency,
  // and worse, a SUSTAINED attacker never accumulated: each new burst read the same stale count.
  // It stopped a polite person and did nothing to a script.
  //
  // So the real gate is Postgres, which the estate already built for exactly this and which I
  // should have looked for before writing a counter. `sv_rate_take` is
  // `insert ... on conflict do update set n = n + 1 returning n`, one atomic statement: concurrent
  // callers serialise on the row and no increment is lost.
  //
  // 60 an hour per number. A real setup is seven turns and the whole conversation takes minutes, so
  // 60 is far past any honest signup while bounding a scripted sender to about $0.68 an hour.
  //
  // ★ IT FAILS CLOSED, matching `truce.mjs`. A rate limiter we cannot read is not permission to
  // spend money on an unattributable request. The blob counter stays underneath as a second,
  // weaker gate: it is exact when messages arrive one at a time, which is the ordinary case, and it
  // still holds if the database is configured away.
  try {
    const gate = await rpc('sv_rate_take', {
      p_bucket: 'signup_sms', p_key: from, p_limit: 60, p_window: '1 hour',
    });
    if (!gate || gate.allowed !== true) {
      console.error(`signup: ${from.slice(-4)} is over the hourly rate limit. Silent.`);
      return new Response(EMPTY_TWIML, { status: 200, headers: { 'Content-Type': 'text/xml' } });
    }
  } catch (e) {
    if (dbConfigured()) {
      console.error('signup: rate limiter unreadable; going silent rather than spending on an '
        + 'unattributable request. ' + String(e && e.message).slice(0, 100));
      return new Response(EMPTY_TWIML, { status: 200, headers: { 'Content-Type': 'text/xml' } });
    }
    // No database configured at all is a different situation from one that will not answer: the
    // blob counter below is then the only gate we have, and it is better than none.
  }

  const CAP = 40;
  rec.turns = (rec.turns || 0) + 1;
  if (rec.turns > CAP) {
    if (rec.turns === CAP + 1) {
      console.error(`signup: ${rec.last4} passed ${CAP} turns. Recording and no longer replying.`);
    }
    try { await s.setJSON(sha(from), rec); } catch (e) { /* the cap holds either way */ }
    return new Response(EMPTY_TWIML, { status: 200, headers: { 'Content-Type': 'text/xml' } });
  }

  if (rec.stopped) {
    // They said stop. A later message re-opens the thread only if it is an explicit start.
    if (!['start', 'unstop', 'yes'].includes(word)) {
      return new Response(EMPTY_TWIML, { status: 200, headers: { 'Content-Type': 'text/xml' } });
    }
    delete rec.stopped;
  }

  // ── RECORD THE ANSWER, THEN ADVANCE. THE CURSOR IS THE TRUTH, NOT THE PHRASING. ─────────────
  //
  // ★ CAUGHT BY A REAL CONVERSATION, TWICE. The first version advanced by scanning for the first
  // unfilled field. That reads as obviously correct and it is not, because the model is allowed to
  // rephrase: when it asked a CONFIRMING question ("is Sacramento with a 30 mile radius right?")
  // the reply came back as the answer to the SAME step, the field was overwritten with the same
  // value, the scan found the same first hole, and the thread asked the identical question again.
  // A contractor saw "what name should callers hear" three times and would have left.
  //
  // Two rules fix it, and both are about refusing to infer state from language:
  //   1. The answer is stored against the step we ASKED, recorded in code, never against whatever
  //      the model appeared to be asking about.
  //   2. The cursor MOVES ON after a stored answer. It does not re-scan. A person who gives a
  //      short or unhelpful answer moves forward with a short value rather than being trapped on
  //      one question, because a setup thread that will not advance is worse than a thin field.
  if (rec.asked != null && said) {
    const answered = STEPS[rec.asked];
    if (answered) {
      rec.profile[answered.key] = said.slice(0, 200);
      rec.step = rec.asked + 1;
    }
  } else {
    // The first inbound message opens the thread and answers nothing.
    rec.step = 0;
  }

  // Skip anything already known, without ever moving backwards.
  while (rec.step < STEPS.length && rec.profile[STEPS[rec.step].key]) rec.step += 1;
  if (rec.step >= STEPS.length) rec.step = -1;
  // A write failure must not throw: an unhandled rejection here is a 502, and Twilio
  // answers a 502 by REDELIVERING the same message, which lands the answer one field to
  // the right. Losing a write costs one turn; throwing costs a corrupted record.
  try { await s.setJSON(sha(from), rec); } catch (e) {
    console.error('signup: write failed for ' + rec.last4 + '; ' + String(e && e.message).slice(0, 90));
  }

  if (rec.step === -1) {
    // ★ THE DEFECT THIS BLOCK EXISTS TO FIX, AND IT WAS THE WORST ONE IN THE PRODUCT.
    //
    // Until now this wrote a blob and returned a sentence. NOTHING read that blob: a repo-wide
    // grep for the store name returned exactly two hits, both inside this file. No database row, no
    // email, no HubSpot, no operator view. Every contractor who finished setup was told "a person
    // assigns your number" and no person was ever told. At a hundred signups that is a hundred
    // customers who did the work, believed us, and were invisible.
    //
    // Worse, this file's own header claimed "the account row is created on the FIRST reply" using
    // sv_account_start. That code did not exist. I wrote a false claim in a comment and it read as
    // documentation for hours, which is exactly the failure this estate keeps paying for.
    //
    // ★ THE CURSOR IS RETIRED HERE, ON PURPOSE. rec.asked stays pointing at the last question
    // forever unless it is cleared, so every message a person sends AFTER finishing overwrites the
    // escalation phone: "thanks!" became the number a real emergency rings. Measured. It is now
    // null, and a finished thread stops recording answers.
    rec.asked = null;
    rec.done = rec.done || nowIso();

    // Fire the handoff ONCE. A person who texts again after finishing must not create a second
    // account or a second alert.
    if (!rec.handedOff) {
      rec.handedOff = nowIso();
      const p = rec.profile || {};
      const email = String(p.booking_destination || '').trim();

      // The account itself. Best effort and NEVER fatal: the setup is already captured, and losing
      // the reply because a database was slow would be a worse outcome than a delayed row.
      if (dbConfigured() && /@/.test(email)) {
        try {
          const r = await startAccount({
            email,
            businessName: String(p.business_name || '').slice(0, 200),
            ownerName: '',
            phone: from,
            trade: String(p.trade || '').slice(0, 80),
            tokenHash: sha('signup-thread:' + from + ':' + rec.done),
          });
          const id = r && (r.account_id || r.id);
          if (id) {
            rec.accountId = id;
            await saveConfig(id, {
              greeting_name: String(p.greeting_name || '').slice(0, 80),
              business_says: String(p.business_name || '').slice(0, 200),
              service_area: String(p.service_area || '').slice(0, 200),
              escalation_phone: String(p.escalation_phone || '').slice(0, 40),
              booking_destination: email,
            }, 'signup-thread');
          }
        } catch (e) {
          console.error('signup: account write failed for ' + rec.last4 + ', the setup is still '
            + 'stored and the operator is still told: ' + String(e && e.message).slice(0, 120));
        }
      }

      // The human. This is the promise the closing sentence makes, so it is the one thing that must
      // happen even when the database does not.
      try {
        await notifyOperator({
          subject: `Answered signup: ${p.business_name || 'a new line'} (${rec.last4})`,
          lines: [
            `Business: ${p.business_name || '-'}`,
            `Trade: ${p.trade || '-'}`,
            `Line says: ${p.greeting_name || '-'}`,
            `Area: ${p.service_area || '-'}`,
            `Hours: ${p.hours_text || '-'}`,
            `Bookings to: ${email || '-'}`,
            `Emergencies to: ${p.escalation_phone || '-'}`,
            `Set up by text from a number ending ${rec.last4}.`,
            rec.accountId ? `Account ${rec.accountId}.` : 'No account row was written; assign by hand.',
            'They have been told a person assigns their number. Nothing answers for them yet.',
          ],
        });
      } catch (e) {
        console.error('signup: OPERATOR WAS NOT TOLD about ' + rec.last4 + '. '
          + String(e && e.message).slice(0, 120));
      }
    }

    try { await s.setJSON(sha(from), rec); } catch (e) { /* the handoff already happened */ }
    console.log(`signup: setup complete for ${rec.last4} (${Object.keys(rec.profile).length} fields).`);
    return new Response(reply(DONE_LINE).body, { status: 200, headers: { 'Content-Type': 'text/xml' } });
  }

  // ── THE QUESTION IS SCRIPTED. THE MODEL ONLY HANDLES WHAT IT CANNOT PREDICT. ────────────────
  //
  // ★ THREE REAL CONVERSATIONS KILLED THE ORIGINAL DESIGN, AND THE THIRD IS THE ONE THAT DECIDED
  // IT. Asked to rephrase step N, the model kept asking step N-1: "What's the name of your
  // business?" then "What do you want to call the business?" then "What do you want to call your
  // business?" three turns running, while the cursor underneath was advancing correctly. Tightening
  // the system prompt made it better and did not make it right. The state machine was never wrong;
  // the model simply did not do as it was told, reliably, twice out of eight turns.
  //
  // So the model is removed from the question path. These seven questions are FIXED, short, and
  // already written in plain words a contractor can answer in three seconds. There is no judgment
  // in asking them and nothing for a model to add, and a fluent wrong question is far worse than a
  // plain right one: it silently files the answer under the wrong field.
  //
  // What the model IS still good for is the thing that cannot be scripted: somebody asking a
  // question mid-setup. That path keeps it, guarded by the same floors, and it always ends by
  // asking the scripted question verbatim so the thread cannot drift.
  const step = STEPS[rec.step];
  const asked = String(said || '').includes('?')
    ? await speak(step, said, rec.profile)   // they asked something: answer, then ask ours
    : step.ask;                              // ordinary turn: ask exactly what is next
  // ★ `!rec.asked` WAS A BUG AND IT COST A WHOLE TEST RUN. `rec.asked` is a STEP INDEX, and step 0
  // is a real step, so `!0` is true and the greeting reprinted on every turn while the cursor sat
  // still. The symptom looked like a state machine failure and was a falsy-zero mistake in the
  // presentation line beside it. Compare against null explicitly: the question "have we ever asked
  // anything" is not the same question as "is the thing we asked truthy".
  const firstEver = rec.greeted !== true;
  const line = firstEver ? `${GREET} ${asked}` : asked;
  rec.greeted = true;
  rec.asked = rec.step;
  // Remember which delivery produced this reply, so a Twilio retry of the SAME message replays the
  // same answer instead of being recorded as a new one.
  if (msgSid) { rec.lastSid = msgSid; rec.lastLine = line; }
  // A write failure must not throw: an unhandled rejection here is a 502, and Twilio
  // answers a 502 by REDELIVERING the same message, which lands the answer one field to
  // the right. Losing a write costs one turn; throwing costs a corrupted record.
  try { await s.setJSON(sha(from), rec); } catch (e) {
    console.error('signup: write failed for ' + rec.last4 + '; ' + String(e && e.message).slice(0, 90));
  }

  return new Response(reply(line).body, { status: 200, headers: { 'Content-Type': 'text/xml' } });
}
