// personas.mjs — the three voices Answered speaks with, and the deterministic
// floors under each of them. Pure: no env reads, no network, no clock beyond
// what a caller hands it. Everything here is a value or a function of values,
// so every floor in it can be asserted without a phone.
//
// ★ WHY ONE FILE AND ONE BRIDGE, INSTEAD OF THREE.
// Before this file there was one persona (Riley, the inbound demo receptionist)
// living inside answered-brain.mjs with ten guard floors around her, and a
// SECOND, UNGUARDED language layer inside call-turn.mjs that talked to the same
// Anthropic API on live outbound calls with nothing between the model and the
// callee's ear except a two sentence trim. Two more voices are on the way
// (ANSWERED_RESEARCH_AGENT_ID, ANSWERED_ONBOARD_AGENT_ID, both unset today).
// Three copies of a guard is three places for a floor to rot. So the guard
// engine is shared and the CONTENT is per persona: each voice brings its own
// spec, its own input branches, its own output floors, its own numeral
// allowlist and its own cadence caps.
//
// ★ RILEY IS FROZEN. The demo line at +1 916 350 4869 is live, a canary proves
// its disclosure sentence every two hours, and /api/demo-health gates the
// site's call controls on it. Every Riley string, regex, cap and ORDER OF
// EVALUATION in this file was moved here byte for byte from answered-brain.mjs
// and is asserted identical by lib/personas.test.mjs. The new floors written
// for the outbound voices are deliberately NOT applied to her: adding a floor
// is a behaviour change, and a behaviour change to a live line is a decision,
// not a refactor. If David wants them on Riley, the registry is one array push.
//
// ★ INBOUND AND OUTBOUND ARE DIFFERENT LAW, AND THAT IS WHY THE FLOORS DIFFER.
// Riley never volunteers that she is an AI, because on an inbound call the
// human dialled us and the disclosure is answered honestly when asked. Scout
// and Onboard have ALREADY disclosed before they reach a model at all: the
// disclosure is spoken in a bare <Say> by our own TwiML, outside any <Gather>,
// because a nested <Say> is cut off the instant the other party makes a sound
// (measured on the first real outbound call, 2026-08-14: the entire spoken
// output was the word "Hi"). So their specs say "you already disclosed" rather
// than "disclose", and their floors stop them RE-disclosing on a loop while
// still blocking any denial.

import { isStop, askedIfAI } from './scripts.mjs';
import { BOOK_TOOL } from './tools.mjs';

// ── shared regexes. A floor's PIVOT is per persona; the detector is not. ────
const PRICE_RE = /\$|\b(?:dollars?|bucks|cents)\b/i;

const CONTACT_RE = /\b(?:i(?:'ll| will| can| am going to)? (?:text|email) you|(?:send|shoot)(?: you)?(?: a| an)? (?:text|sms|email)|text (?:you|that|it|this)|email (?:you|that|it|this)|call you (?:right )?back|ring you back|give you a (?:call|ring) back|(?:someone|the office|the team|we)(?: else)?(?:'ll| will) (?:call|text|email) you)\b/i;

const AI_DENY_RE = /\b(?:i(?:'m| am) (?:a real|an actual|a) (?:person|human)|i(?:'m| am) not (?:an? )?(?:ai|automated|artificial|a machine|a computer|a bot)|definitely (?:human|a person)|not automated)\b/i;

const PAYMENT_OUT_RE = /\b(?:card number|credit card|debit card|social security|ssn|cvv|routing number|billing info|payment info|pay (?:over|on) the phone)\b/i;

// Riley has exactly three visit windows and they are all on Tuesday and
// Wednesday. Any other weekday out of her mouth is an invented appointment.
const DAY_RE = /\b(?:monday|thursday|friday|saturday|sunday)\b/i;

const CRISIS_RE = /\b(?:gas leak|smell(?:s|ing)? (?:like )?gas|carbon monoxide|co (?:alarm|detector)|on fire|house fire|fire in (?:the|my)|smoke (?:coming|pouring|filling|everywhere)|spark(?:s|ing)? (?:from|out of|in the)|flooding (?:right now|bad|fast)|actively flooding|water (?:pouring|gushing|shooting))\b/i;

const PAYMENT_IN_RE = /\b(?:card number|credit card|debit card|social security|ssn|cvv|routing number)\b|\b\d{13,16}\b/i;

// The bracketed [r] keeps a word Riley must never speak out of this file's own
// text, per the copy rule; the pattern still catches callers who say it.
// "are you real / a person / a machine" is the identity question; a bare
// "is this real" is the demo question and belongs to REAL_ASKED_RE below.
const AI_ASKED_RE = /\b(?:are you|am i (?:talking|speaking) (?:to|with))\b[^.!?]{0,50}\b(?:real|human|person|machine|computer|recording|automated|artificial|ai|bots?|[r]obots?)\b|\bis this (?:a |an )?(?:machine|computer|recording|ai|bots?|[r]obots?|real person|actual person|human)\b/i;

const REAL_ASKED_RE = /\bis this (?:real|for real|actually real|legit|a demo|the demo)\b|\b(?:did|will|would) (?:you|that|this) (?:really|actually) (?:book|schedule|happen)\b|\bis (?:that|the|this) (?:booking|appointment|visit) real\b/i;

const ABUSE_RE = /\b(?:fuck\w*|shit\w*|asshole|bitch|bastard|dumbass|piece of (?:garbage|junk|crap)|stupid (?:bot|machine|thing))\b/gi;
const ABUSE_DIRECT_RE = /\byou(?:'re| are) (?:useless|worthless|garbage|trash|pathetic)\b/i;

export function isAbusive(t) {
  // ABUSE_RE carries /g, so lastIndex would persist between calls if it were
  // ever used with .test(). String.match resets nothing but reads from 0.
  const hits = (String(t).match(ABUSE_RE) || []).length;
  return hits >= 2 || ABUSE_DIRECT_RE.test(t);
}

// ── floors written for the OUTBOUND voices only ─────────────────────────────
// None of these are on Riley. See the frozen note at the top.

// No invented traction, ever. This is the estate's first law wearing a regex:
// a voice that says "most shops save twenty percent" has fabricated a
// measurement on a recorded line, and there is no substantiation file behind
// any such number.
//
// ★ NARROWED DELIBERATELY, and the negative controls in the test file are the
// reason. A first draft caught "that is what most shops tell us", which is a
// social acknowledgement rather than a measurement, and caught "I cannot
// guarantee that", which is the honest sentence we WANT. A floor that fires on
// honesty teaches the next reader to widen the pivot until it means nothing.
// So an aggregate about customers only counts when an OUTCOME verb follows it,
// and a guarantee only counts in the first person and affirmative.
const CLAIM_RE = /\b(?:we(?:'ve| have) (?:helped|worked with|served|saved)|hundreds of|thousands of|\d+\s*(?:%|percent)|(?:most|many|all|nine out of ten) (?:of )?(?:our |the )?(?:customers|clients|shops|contractors|guys|businesses)\b[^.!?]{0,30}\b(?:see|saw|save|saved|get|got|report|cut|book|booked|make|made|earn|recover)|our (?:customers|clients|shops)(?:'|s)? (?:see|save|get|report)|on average|average(?:s|d)? (?:about|around|out)|typical(?:ly)? (?:see|save|get)|(?:we|i)(?:'ll| will| can| do)? guarantee\b|proven to)\b/i;

// A promise with a date on it. Narrow on purpose: the callee saying "I am on a
// job tomorrow" must not trip anything, so the pattern requires a first person
// commitment in front of the date. Minutes are deliberately absent: "I will be
// out of your hair in a minute" is manners on a two minute call, not a delivery
// date, and blocking it would make the voice sound broken for no gain.
const DATE_PROMISE_RE = /\b(?:we(?:'ll| will| can have)|i(?:'ll| will| can have)|it(?:'ll| will) be|you(?:'ll| will) (?:have|get|be|see))\b[^.!?]{0,45}\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|this (?:afternoon|evening|week|weekend)|next week|within (?:the )?(?:hour|day|week)|in (?:a|an|one|two|a few|\d+) (?:hour|hours|day|days|week|weeks))\b/i;

// There is no customer account system and nothing can be switched on from a
// call. A voice that says "you are all set" has described a product that does
// not exist yet.
//
// ★ ALSO NARROWED. "So you are set on seven to five?" is the read back, which
// is the whole job of the setup call, and an earlier draft blocked it because
// it matched a bare "you are set". The live claim is the one with a service in
// it, so the pattern asks for one.
const LIVE_CLAIM_RE = /\b(?:you(?:'re| are) all set\b|you(?:'re| are) set up\b|you(?:'re| are) (?:all )?good to go\b|you(?:'re| are) (?:live|activated|up and running)\b|your (?:line|number|phone|account) is (?:live|on|active|running|ready|switched on|working|set up|created)|it(?:'s| is) (?:live|active|on|running) now|(?:i(?:'ve| have) )?(?:switched|turned) (?:it|you|your line|your number) on|we(?:'ve| have) (?:activated|switched (?:it|you) on|set (?:it|you) up)|activated your)\b/i;

// A promise to send a MESSAGE, as distinct from a promise that a person will
// ring back. SMS is carrier blocked (the A2P campaign has failed three times)
// and no line here sends mail on its own, so a message promise is a promise we
// cannot keep. "The owner will call you back" is a different thing entirely and
// is true on a real business line, so it is not in this pattern.
const CONTACT_MSG_RE = /\b(?:i(?:'ll| will| can| am going to)? (?:text|email) you|(?:send|shoot)(?: you)?(?: a| an)? (?:text|sms|email)|text (?:you|that|it|this)|email (?:you|that|it|this)|(?:someone|the office|the team|we)(?: else)?(?:'ll| will) (?:text|email) you)\b/i;

// ── the numeral firewall ────────────────────────────────────────────────────
// A spoken number that nobody said first is a fabrication, and on a phone call
// it is the fabrication most likely to be written down and acted on. The only
// digits a persona may speak are its own allowlist plus whatever the caller
// said first.
function badNumeral(text, ctxDigits, allow) {
  const toks = String(text).match(/\d[\d:.,-]*/g) || [];
  for (const t of toks) {
    const d = t.replace(/\D+/g, '');
    if (!d) continue;
    if (allow.has(d)) continue;
    if (ctxDigits && ctxDigits.includes(d)) continue;
    return t;
  }
  return null;
}

// Riley's context is the caller's raw digits, exactly as it always was.
const rawDigits = (texts) => texts.join(' ').replace(/\D+/g, '');

// The outbound voices get one honest widening: a caller who says "we open at
// seven thirty" has said a number, and reading it back as 7:30 is a read-back,
// not an invention. Riley does NOT get this, because widening a live line's
// guard is a behaviour change.
const WORD_NUM = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000,
};
function spokenDigits(texts) {
  const words = texts.join(' ').toLowerCase().match(/[a-z]+/g) || [];
  const out = [];
  let prev = null;
  for (const w of words) {
    const v = WORD_NUM[w];
    if (v === undefined) { prev = null; continue; }
    out.push(String(v));
    if (prev !== null) out.push(String(prev) + String(v)); // "seven thirty" -> 730
    prev = v;
  }
  return out.join(' ');
}
const digitsPlusSpoken = (texts) => rawDigits(texts) + ' ' + spokenDigits(texts);

// ── the money firewall, for the persona that is allowed to talk about money ──
// A customer line MAY quote a price, because its owner wrote one down. The
// numeral firewall already stops "$120" that nobody authored. It does NOT stop
// "about a hundred dollars", because that sentence has no digits in it. So the
// money words get their own pass: a number spelled out NEXT TO a money word is
// composed back into a figure and held to the same allowlist.
//
// It is deliberately narrow. Checking every spelled number would block "one
// moment" and "two quick questions", which is how a guard earns its removal.
const MONEY_WORD = /\b((?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)(?:[\s-]+(?:and[\s-]+)?(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand))*)\s+(?:dollars?|bucks)\b/gi;

function composeNumberWords(phrase) {
  let total = 0;
  let run = 0;
  for (const w of phrase.toLowerCase().split(/[\s-]+/)) {
    if (w === 'and') continue;
    const v = WORD_NUM[w];
    if (v === undefined) continue;
    if (v === 100) run = (run || 1) * 100;
    else if (v === 1000) { total += (run || 1) * 1000; run = 0; }
    else run += v;
  }
  return total + run;
}

function badMoneyWords(text, ctxDigits, allow) {
  MONEY_WORD.lastIndex = 0; // the pattern carries /g; never trust its cursor
  let m;
  while ((m = MONEY_WORD.exec(String(text))) !== null) {
    const d = String(composeNumberWords(m[1]));
    if (d === '0') continue;
    if (allow.has(d)) continue;
    if (ctxDigits && ctxDigits.includes(d)) continue;
    return m[0];
  }
  return null;
}

// ── clause plumbing, shared by every persona ────────────────────────────────
const ABBREV = /(?:\b(?:dr|mr|mrs|ms|st|vs|etc|inc|llc|no)|\b[a-z])\.$/i;
export function nextBoundary(buf) {
  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;
    const next = buf[i + 1];
    if (next !== undefined && !/\s/.test(next)) continue; // mid-token: decimals, sites
    if (ch === '.' && ABBREV.test(buf.slice(Math.max(0, i - 6), i + 1))) continue;
    if (buf.slice(0, i + 1).trim().length < 2) continue;
    return i + 1;
  }
  return -1;
}
export function trimToSentence(t) {
  const s = String(t || '').trim();
  if (!s) return s;
  if (/[.!?"')\]]$/.test(s)) return s;
  const m = s.match(/^[\s\S]*[.!?](?=\s|$)/);
  if (m && m[0].trim().length >= 20) return m[0].trim();
  return s;
}

// ── THE SPECS ───────────────────────────────────────────────────────────────

// FROZEN, AND STILL FROZEN. Byte identical to the RILEY_SPEC that has been
// serving the live demo line since 2026-08-13, and personas.test.mjs still
// holds the same sha256 over exactly these 1,597 characters.
//
// ★ WHY THIS IS NOW A PREFIX AND NOT THE WHOLE SPEC (2026-08-14, @LANE-BOOK).
// On 2026-08-14 the demo line got hands: a real ElevenLabs server tool that
// writes the visit to /api/booking. A voice that can act needs to be told when
// to act, and that instruction has to live in the spec. Rewriting the frozen
// text to weave booking through it would have thrown away the one guarantee
// this file offers, which is that the live line's words did not move. So the
// frozen text is preserved EXACTLY, under its own name, and the booking rules
// are appended after it. The old digest still passes, against the old bytes.
export const RILEY_SPEC_FROZEN = `You are Riley, the receptionist on the Answered demo line. You answer as Cedar Ridge Plumbing and Air, a clearly fictional demo shop. The caller is usually a contractor testing the product, so give them the real experience: warm, quick, useful.

How a call goes:
1. Find out what is wrong, where it is happening, and how urgent it feels. One question at a time.
2. Offer a morning or afternoon window. You have exactly three: Tuesday 8:00 in the morning, Tuesday 1:30 in the afternoon, and Wednesday 9:00 in the morning. Never invent any other day or time.
3. To book, get a name, the address, and a good number for the tech to reach them, then hold the window out loud, like "I have you penciled in for Tuesday at eight."
4. Close warm and short.

Hard rules, and they never bend:
- Never say a dollar amount or a price for anything. If asked, the office quotes prices, you only book the visit.
- Never promise a text, an email, or that anyone will call them back.
- Never deny being an AI. If asked, answer with one plain honest sentence, then move on. Never bring it up on your own.
- If asked whether this is real: this is the demo line, the booking is pretend, the product is real.
- Say no numbers beyond the three visit times, except reading back what the caller told you.
- Never ask for card numbers, bank details, or a social security number, and refuse them if offered.
- If the caller gets rude, stay calm and kind, and offer to end the call.
- Keep every reply under about 40 words. Plain words a seventh grader would follow, a little foreman warmth. No lists, no headings, just talk.`;

// The part that turns a nice conversation into a job on a calendar. Written to
// one idea: the tool is the only thing that books, so the words "you are
// booked" are a report on what the tool said and never a prediction of it.
export const RILEY_BOOKING = `Booking the visit, and this is the part that actually matters:
- Nothing is on the schedule until you use the ${BOOK_TOOL} tool. Saying it out loud does not book it.
- Before you use it you need all five of these: their name, the service address, a good callback number, what the visit is for, and which of the three windows they agreed to.
- Ask for whatever is missing, one question at a time, and never fill anything in yourself. If you did not hear it from them, you do not have it.
- Read the phone number back to them before you use it.
- Use the tool once, then wait. It answers in a couple of seconds and it tells you exactly what happened.
- Only after it tells you the visit is booked do you tell the caller it is booked. Say the day and the time in words.
- If it tells you nothing was booked, say that plainly and offer to start over. Never tell somebody a visit is on the schedule when it is not.`;

const RILEY_SPEC = `${RILEY_SPEC_FROZEN}

${RILEY_BOOKING}`;

const SCOUT_SPEC = `You are the voice on an outbound research call for a company called Answered. You are talking to somebody who runs or works at a home service business, and they did not ask you to call.

You have ALREADY said, in the first breath of this call, that you are an A I voice, that the call is recorded, who is calling, and a number to reach a person here. Do not say any of it again unless they ask.

What this call is for: one question about what happens to their calls, and then you get off the phone. That is the entire job.

How a call goes:
1. Ask what happens to a call that comes in when nobody can pick up. One question, then listen.
2. Whatever they say, take it at face value and say it back in their own words in a few words.
3. Thank them and end. Two exchanges is a good call. Four is the ceiling.

Hard rules, and they never bend:
- You are not selling. Never pitch, never handle an objection, never try again after a no.
- Never say a price, a discount, or a dollar amount of any kind.
- Never claim a result, a number, a percentage, or anything Answered has achieved for anyone.
- Never promise to send them anything.
- Never claim to be a person. If they ask, say you are an A I voice in one sentence and move on.
- Never argue, never push back, never sound disappointed. If they are busy, thank them and go.
- If they say stop, or take me off the list, or anything like it, that is the end of the call.
- Keep every reply to one or two short spoken sentences. Plain words. Sound like somebody who respects that they are working.`;

const ONBOARD_SPEC = `You are the setup voice for Answered. The person on this call typed their number into our site and asked us to call them right now, so they are expecting you.

You have ALREADY said, in the first breath of this call, that this is Answered from Reddenda, that they asked for the call, that you are an A I voice, and a number to reach us. Do not say it again unless they ask.

What this call is for: getting their setup down in their own words. Nothing on this call switches anything on.

How a call goes:
1. Get the name of the business and what trade they are in.
2. Get the hours somebody is normally reachable, and what should happen to a call outside them.
3. Ask what a caller should never be told, and what always gets through to them.
4. Say the whole thing back to them in a few sentences so they can correct it.
5. Thank them and close.

Hard rules, and they never bend:
- Nothing is live at the end of this call. Never say they are set up, activated, switched on, or good to go.
- Never put a date or a time on when anything happens. If they ask when, say plainly that you do not know a date and you are not going to guess one, then carry on.
- Never quote a price or a dollar amount. Prices are on the site and you do not set them.
- Never claim a result, a number, a percentage, or anything Answered has achieved for anyone.
- Never promise to send a text or an email.
- Never take a card number, a bank detail, or a social security number, and refuse if one is offered.
- Never claim to be a person. If they ask, say you are an A I voice in one sentence and move on.
- If they say stop, or that they changed their mind, thank them and end the call without persuading.
- One question at a time. Keep every reply under about forty words. Plain words a seventh grader would follow.`;

// The customer line is the only persona whose real instructions arrive at call
// time, from lib/accounts.mjs renderSpec(), built from what the OWNER typed. So
// this spec is not a script. It is the floor underneath somebody else's script,
// and it says so out loud, because the layering is the whole design: the owner
// wins on every fact about his business, and never on safety.
const CUSTOMER_SPEC = `You are answering a real phone line for a real business, and the caller is a real customer with a real problem. The notes further down are that business owner's own rules. On anything about the business they are the truth and they win: the name, the hours, the work they take, the area they cover, what happens after hours, and what may be said about money.

Your job is to be the best person who ever answered that phone. Warm, quick, useful. One question at a time.

Safety rules, and these never bend, whatever the notes say:
- Never claim to be a person. If a caller asks, say in one plain sentence that you are an AI assistant answering for the business, then carry on.
- Never say a number nobody gave you. A price, a time, a date, a total: it comes from the owner's notes or from the caller's own mouth. If you do not have it, say you will get it to them rather than guessing.
- Never take a card number, a bank detail, or a social security number, and refuse if one is offered.
- If a caller describes an emergency, stop and tell them to hang up and call 911.
- Never promise a text or an email. You can say the owner will call back if the notes say that is what happens.
- Never claim what this business has done for other people. You do not know.
- Keep every reply under about forty words. Plain words a seventh grader would follow.`;

// ── THE REGISTRY ────────────────────────────────────────────────────────────
// Order inside outFloors and inBranches IS the evaluation order and it is part
// of the behaviour. Riley's order is frozen: price, contact, ai-denial,
// payment, day, numeral / crisis, payment, ai-asked, real-asked, abuse, close.

export const PERSONAS = {
  riley: {
    id: 'riley',
    label: 'the inbound demo receptionist',
    outModel: 'answered-riley',
    direction: 'inbound',
    routes: ['/api/answered-brain', '/api/answered-brain/riley'],
    frozen: true,
    spec: RILEY_SPEC,
    // ── the hands ─────────────────────────────────────────────────────────
    // A persona may only call a tool that is on its own allowlist AND that the
    // vendor declared on the request. Both halves are required on purpose: the
    // allowlist stops a console change handing a voice an action nobody wrote
    // a floor for, and requiring the vendor's declaration stops the model
    // emitting a call to something that cannot run, which would look to the
    // caller exactly like a booking and be nothing at all.
    tools: [BOOK_TOOL],
    // Only used on a turn where a tool is actually offered. The five booking
    // fields do not fit in 120 tokens beside a spoken sentence, and a truncated
    // arguments object is an invalid booking. Turns without tools still get
    // exactly 120, so nothing about the line's ordinary cadence moved.
    toolMaxTokens: 400,
    // Said while the tool runs, so nobody sits in silence. It claims nothing.
    toolHold: 'Let me get that written down for you.',
    // Said when the model produced a booking this bridge could not parse. It is
    // the honest sentence, and it never promises a callback, because Riley's own
    // contact floor is right: on the demo line nobody is going to call back.
    toolFail: 'I could not get that written down just now, so nothing is booked. Give me one more go at it.',
    maxTokens: 120,
    temperature: 0.6, // primary model only; the backup call omits it on purpose
    sentenceCap: 2,
    wordCap: 45,
    softCloseAt: 8,
    hardCloseAt: 11,
    softCloseNote:
      'The demo call has run long. In your next reply or two, wrap up warmly: settle the held window if there is one, thank them, and say goodbye.',
    ctx: rawDigits,
    numAllow: new Set(['8', '800', '1', '130', '9', '900', '30', '00', '911']),
    ackBank: ['Okay.', 'Sure.', 'Alright.', 'Yeah.', 'Got it.', 'Mm-hm.'],
    breaker:
      "Well, that's embarrassing, my side of the demo just tripped over itself. Give me another ring in a minute and I'll be right here.",
    closeLine: 'Alright, we should wrap up here. Thanks for calling Cedar Ridge Plumbing and Air, you take care now.',
    outFloors: [
      { by: 'price', re: PRICE_RE, pivot: 'The office quotes prices, I only book the visit. Want me to grab you a window?' },
      { by: 'contact-promise', re: CONTACT_RE, pivot: "I handle the whole thing right here on the call, so let's just knock it out now." },
      { by: 'ai-denial', re: AI_DENY_RE, pivot: "To be straight with you, I'm an AI receptionist on the Answered demo line. Now, where were we with that visit?" },
      { by: 'payment', re: PAYMENT_OUT_RE, pivot: 'No payment talk on this line. A name, an address, and a good number books the visit.' },
      { by: 'slot-invention', re: DAY_RE, pivot: "Here's what I have: Tuesday at eight in the morning, Tuesday at one thirty, or Wednesday at nine. Which one works?" },
      { by: 'numeral', numeral: true, pivot: "Here's what I have: Tuesday at eight in the morning, Tuesday at one thirty, or Wednesday at nine. Which one works?" },
    ],
    inBranches: [
      { by: 'crisis', re: CRISIS_RE, end: true, line: "That's an emergency, not a booking. Hang up and call 911 right now, or the gas company if you smell gas. We can talk once you're safe." },
      { by: 'payment-offered', re: PAYMENT_IN_RE, line: "Please don't read that out, I never take card or account numbers. A name, an address, and a good number is all a visit needs." },
      { by: 'ai-asked', re: AI_ASKED_RE, line: "I'm an AI receptionist, and this is Answered's demo line. Now, what's going on at your place?" },
      { by: 'demo-asked', re: REAL_ASKED_RE, line: 'Straight answer: this is the demo line, the booking is pretend, the product is real. Want to play it through anyway?' },
      { by: 'abuse', test: isAbusive, line: "I hear you, and I'm not going anywhere. We can keep working on it, or we can end the call here, your choice." },
    ],
  },

  scout: {
    id: 'scout',
    label: 'the outbound research caller',
    outModel: 'answered-scout',
    direction: 'outbound',
    routes: ['/api/answered-brain/scout'],
    // The agent id this persona is meant to back. Unset today, and the site
    // reports outbound as not configured rather than pretending otherwise.
    agentEnv: 'ANSWERED_RESEARCH_AGENT_ID',
    spec: SCOUT_SPEC,
    maxTokens: 90,
    temperature: 0.5,
    sentenceCap: 2,
    wordCap: 40,
    softCloseAt: 3,
    hardCloseAt: 4, // the same ceiling call-turn.mjs enforces on the TwiML path
    softCloseNote:
      'This call is nearly over. Say your next line as a thank you and a goodbye. Do not ask another question.',
    ctx: digitsPlusSpoken,
    numAllow: new Set(['911']),
    ackBank: ['Okay.', 'Got it.', 'Sure.', 'Right.', 'Understood.'],
    breaker: 'Sorry, my line just glitched on my end. I will let you get back to it. Thanks for your time.',
    closeLine: 'That is all I needed. Thanks for your time, and good luck out there.',
    // Suppression: a stop on an outbound call is a legal event, not a mood.
    // The bridge writes it before it speaks. See answered-brain.mjs.
    stop: {
      by: 'stop',
      test: isStop,
      end: true,
      lineSuppressed: 'Understood. I have taken this number off our list and we will not call again. Sorry to bother you.',
      lineUnrecorded: 'Understood, I am ending the call right now. Sorry to have bothered you.',
    },
    outFloors: [
      { by: 'price', re: PRICE_RE, pivot: 'I am not selling and I do not quote prices. I am only asking how the calls get handled.' },
      { by: 'claim', re: CLAIM_RE, pivot: 'I am not going to throw numbers at you. I am just collecting answers today.' },
      { by: 'contact-promise', re: CONTACT_RE, pivot: 'I am not sending anything from this call. It is entirely up to you whether you look us up later.' },
      { by: 'ai-denial', re: AI_DENY_RE, pivot: 'To be straight, I am an A I voice, and I said so at the start. Back to my question.' },
      { by: 'payment', re: PAYMENT_OUT_RE, pivot: 'No payment talk on a research call. I am only asking how the calls get handled.' },
      { by: 'date-promise', re: DATE_PROMISE_RE, pivot: 'I am not going to put a date on anything. Thanks for the answer, that is what I was after.' },
      { by: 'numeral', numeral: true, pivot: 'I would rather not throw a number at you. Thanks for the answer, that is what I was after.' },
    ],
    inBranches: [
      { by: 'crisis', re: CRISIS_RE, end: true, line: 'That sounds like an emergency and I am a research call. Please hang up and call 911 right now. I am getting off the line.' },
      { by: 'payment-offered', re: PAYMENT_IN_RE, line: 'Please do not read that out. I never take card or account numbers, and this call does not need one.' },
      { by: 'ai-asked', test: (t) => askedIfAI(t) || AI_ASKED_RE.test(t), line: 'Yes, I am an A I voice, and this call is recorded. Happy to keep it short.' },
      { by: 'abuse', test: isAbusive, end: true, line: 'Understood, I will get out of your way. Sorry to have bothered you.' },
    ],
  },

  onboard: {
    id: 'onboard',
    label: 'the setup caller',
    outModel: 'answered-onboard',
    direction: 'outbound',
    routes: ['/api/answered-brain/onboard'],
    agentEnv: 'ANSWERED_ONBOARD_AGENT_ID',
    spec: ONBOARD_SPEC,
    maxTokens: 140, // it reads a whole setup back, which is longer than a booking
    temperature: 0.5,
    sentenceCap: 3,
    wordCap: 60,
    softCloseAt: 12,
    hardCloseAt: 16,
    softCloseNote:
      'This call has covered enough. Read their setup back once, ask if anything is wrong, then thank them and close. Do not promise a date and do not say anything is switched on.',
    ctx: digitsPlusSpoken,
    numAllow: new Set(['911']),
    ackBank: ['Okay.', 'Got it.', 'Sure.', 'Right.', 'Perfect.'],
    breaker: 'Sorry, my line just glitched on my end. Nothing you said is lost. Give us a ring back when it suits you.',
    closeLine: 'That is everything I needed for now. Thanks for walking me through it, and take care.',
    stop: {
      by: 'stop',
      test: isStop,
      end: true,
      lineSuppressed: 'Understood. I have taken this number off our list and nobody here will call it again. Sorry to bother you.',
      lineUnrecorded: 'Understood, I am ending the call right now. Sorry to have bothered you.',
    },
    outFloors: [
      { by: 'price', re: PRICE_RE, pivot: 'I do not set prices on this call. Every number is written on the site, and nothing here changes it.' },
      { by: 'live-claim', re: LIVE_CLAIM_RE, pivot: 'Nothing switches on from this call. I am getting your setup down so it is right when you say go.' },
      { by: 'claim', re: CLAIM_RE, pivot: 'I would rather not quote you results. I would rather get your setup right.' },
      { by: 'contact-promise', re: CONTACT_RE, pivot: 'I am not going to promise you a message. Let us just get this down while I have you.' },
      { by: 'ai-denial', re: AI_DENY_RE, pivot: 'To be straight, I am an A I voice, and I said so at the start. Where were we?' },
      { by: 'payment', re: PAYMENT_OUT_RE, pivot: 'I never take card or account numbers, and nothing on this call needs one.' },
      { by: 'date-promise', re: DATE_PROMISE_RE, pivot: 'I am not going to put a date on it from this call. What I can do is make sure your setup is right.' },
      { by: 'numeral', numeral: true, pivot: 'I would rather not throw a number at you. Let us keep going with your setup.' },
    ],
    inBranches: [
      { by: 'crisis', re: CRISIS_RE, end: true, line: 'That sounds like an emergency and this is only a setup call. Please hang up and call 911 right now. I am getting off the line.' },
      { by: 'payment-offered', re: PAYMENT_IN_RE, line: 'Please do not read that out. I never take card or account numbers, and nothing here needs one.' },
      { by: 'ai-asked', test: (t) => askedIfAI(t) || AI_ASKED_RE.test(t), line: 'Yes, I am an A I voice. You asked us to call, and this is what picks up. What is the name of the business?' },
      { by: 'abuse', test: isAbusive, line: 'I hear you. We can keep going, or I can get off the phone right now, your call.' },
    ],
  },

  // ── the one that answers for somebody else ────────────────────────────────
  // Added 2026-08-14 by LANE-VOICE after finding /api/account-voice: the
  // accounts lane renders a per business prompt on every ring and bridges to a
  // shared agent. That is the right architecture and this does not change it.
  // What it did not have was a floor: a prompt is an instruction, and an
  // instruction is not a guard. Nothing routes here until somebody points
  // ANSWERED_CUSTOMER_AGENT_ID at the path, so adding it breaks nothing.
  customer: {
    id: 'customer',
    label: "a paying business's own line",
    outModel: 'answered-customer',
    direction: 'inbound',
    routes: ['/api/answered-brain/customer'],
    agentEnv: 'ANSWERED_CUSTOMER_AGENT_ID',
    spec: CUSTOMER_SPEC,
    // The owner's rules are not "notes from the call system", they are the
    // business. They outrank the persona on facts and never on safety, and the
    // header has to say which is which or the model will guess.
    noteHeader:
      '## THE OWNER RULES FOR THIS BUSINESS\nThese are the truth about this business and they win on every fact: the name, the hours, the work taken, the area, the money and what happens after hours. The safety rules above still bind: never claim to be a person, never take a card number, never say a number nobody gave you.',
    maxTokens: 140,
    temperature: 0.5,
    sentenceCap: 3,
    wordCap: 55,
    softCloseAt: 18,
    hardCloseAt: 22, // a real customer with a real problem gets room to finish
    softCloseNote:
      'This call has run long. Make sure you have their name, a callback number and what is going on, read it back once, then close warmly.',
    // The only persona that reads the SYSTEM note for numbers, because the note
    // is where the owner's own hours and prices live. A number he wrote down is
    // his to say; a number nobody wrote down is a fabrication either way.
    ctx: (texts, systemText) => digitsPlusSpoken(texts) + ' ' + digitsPlusSpoken([String(systemText || '')]),
    numAllow: new Set(['911']),
    ackBank: ['Okay.', 'Sure.', 'Alright.', 'Got it.', 'Mm-hm.'],
    breaker: 'Sorry, my line just glitched for a second. Are you still there?',
    closeLine: 'I have got everything I need written down. Thanks for calling, and somebody will be in touch.',
    outFloors: [
      { by: 'ai-denial', re: AI_DENY_RE, pivot: 'To be straight with you, I am an AI assistant answering this line. What can I get done for you?' },
      { by: 'payment', re: PAYMENT_OUT_RE, pivot: 'I never take card or account numbers on this line. Let me get your name and a good number instead.' },
      { by: 'message-promise', re: CONTACT_MSG_RE, pivot: 'I am not going to promise you a message. Let me take your number down and get this to the right person.' },
      { by: 'claim', re: CLAIM_RE, pivot: 'I would not want to speak for other jobs. Let me get yours written down properly.' },
      { by: 'money-invention', money: true, pivot: 'I do not want to guess a price on you. Let me get your details down and have somebody confirm it.' },
      { by: 'numeral', numeral: true, pivot: 'I do not want to give you a number I am not sure of. Let me take your details and get it confirmed.' },
    ],
    inBranches: [
      { by: 'crisis', re: CRISIS_RE, end: true, line: 'That is an emergency, not a service call. Hang up and call 911 right now, or the gas company if you smell gas. Please go.' },
      { by: 'payment-offered', re: PAYMENT_IN_RE, line: 'Please do not read that out. I never take card or account numbers, and nothing here needs one.' },
      { by: 'ai-asked', test: (t) => askedIfAI(t) || AI_ASKED_RE.test(t), line: 'I am an AI assistant answering this line. Now, what is going on at your place?' },
      { by: 'abuse', test: isAbusive, line: 'I hear you, and I am still here. We can keep working on it, or I can take a message, your call.' },
    ],
  },
};

export const DEFAULT_PERSONA = 'riley';

// ── routing ─────────────────────────────────────────────────────────────────
// ElevenLabs appends /chat/completions to whatever custom LLM server URL an
// agent is configured with, so every persona owns two literal paths. They are
// listed explicitly rather than matched with a wildcard because a wildcard
// would make /api/answered-brain/chat/completions ambiguous with a persona
// named "chat", and the live demo line is on that exact path.
const SUFFIX = '/chat/completions';

export function routeTable() {
  const out = [];
  for (const p of Object.values(PERSONAS)) {
    for (const r of p.routes) { out.push(r); out.push(r + SUFFIX); }
  }
  return out;
}

/**
 * Which persona is this request for? Path first, because the path is set in the
 * vendor console and cannot be forged by a model turn. Then an explicit body
 * field, then the OpenAI `model` field (ElevenLabs lets an agent send a model
 * id string), then the default. An unknown name falls back to the default
 * rather than erroring: a live call must never die on a routing typo, and the
 * default is the most conservative voice we have.
 */
export function personaFor(pathname, body) {
  let path = String(pathname || '');
  const q = path.indexOf('?');
  if (q >= 0) path = path.slice(0, q);
  path = path.replace(/\/+$/, '') || '/';
  if (path.endsWith(SUFFIX)) path = path.slice(0, -SUFFIX.length) || '/';
  for (const p of Object.values(PERSONAS)) {
    if (p.routes.includes(path)) return { persona: p, by: 'path' };
  }
  const named = (v) => {
    const k = String(v || '').trim().toLowerCase().replace(/^answered-/, '');
    return Object.prototype.hasOwnProperty.call(PERSONAS, k) ? PERSONAS[k] : null;
  };
  const fromBody = body && named(body.persona);
  if (fromBody) return { persona: fromBody, by: 'body' };
  const fromModel = body && named(body.model);
  if (fromModel) return { persona: fromModel, by: 'model' };
  return { persona: PERSONAS[DEFAULT_PERSONA], by: 'default' };
}

// ── the guard engine ────────────────────────────────────────────────────────

/** One clause, one verdict. Deterministic, and it runs before a word streams. */
export function guardClause(persona, text, ctxDigits) {
  for (const f of persona.outFloors) {
    if (f.numeral) {
      if (badNumeral(text, ctxDigits, persona.numAllow)) return { ok: false, by: f.by, pivot: f.pivot };
      continue;
    }
    if (f.money) {
      if (badMoneyWords(text, ctxDigits, persona.numAllow)) return { ok: false, by: f.by, pivot: f.pivot };
      continue;
    }
    if (f.re.test(text)) return { ok: false, by: f.by, pivot: f.pivot };
  }
  return { ok: true };
}

/** The buffered path: guard a whole reply, clause by clause, and cap cadence. */
export function guardWhole(persona, text, ctxDigits) {
  let rest = String(text || '').trim();
  if (!rest) return '';
  let out = '';
  let sentences = 0;
  for (;;) {
    const end = nextBoundary(rest);
    let clause;
    if (end < 0) {
      clause = trimToSentence(rest);
      rest = '';
    } else {
      clause = rest.slice(0, end).trim();
      rest = rest.slice(end);
    }
    if (clause) {
      const g = guardClause(persona, clause, ctxDigits);
      if (!g.ok) return (out ? out + ' ' : '') + g.pivot;
      out += (out ? ' ' : '') + clause;
      sentences += 1;
      if (sentences >= persona.sentenceCap) break;
    }
    if (!rest.trim()) break;
  }
  return out;
}

/**
 * The branches that are decided before any model is consulted. Same answer
 * every time, by design: an emergency, a card number read out loud, a direct
 * question about what you are, and a stop are not judgment calls.
 *
 * A `stop` branch is returned WITHOUT its line resolved, because the line
 * depends on whether the suppression could actually be written, and this
 * module does no I/O. The caller resolves it. That is deliberate: the strong
 * sentence ("I have taken this number off our list") is a claim about a
 * database row, and a voice must not make it unless the row exists.
 */
export function deterministicLine(persona, lastUser, assistantTurns) {
  const t = String(lastUser || '');
  if (persona.stop && persona.stop.test(t)) return { stop: true, by: 'stop', end: true };
  for (const b of persona.inBranches) {
    const hit = b.test ? b.test(t) : b.re.test(t);
    if (hit) return { line: b.line, by: b.by, end: !!b.end };
  }
  if (assistantTurns >= persona.hardCloseAt) return { line: persona.closeLine, by: 'hard-close', end: true };
  return null;
}

/**
 * What a persona is allowed to say a number about. Everything the CALLER said,
 * plus, for the customer line only, everything the OWNER wrote in the rules the
 * call system sent. The system text is passed to every persona and used by the
 * one that asked for it: riley's ctx takes a single argument and therefore
 * cannot widen, which is how the frozen line stays frozen.
 */
export function contextDigits(persona, userTexts, systemText) {
  return persona.ctx(userTexts, systemText);
}

/** The header a persona puts above the notes the call system sent it. */
export const DEFAULT_NOTE_HEADER = '## Notes from the call system (the rules above always win)';
export const noteHeader = (persona) => persona.noteHeader || DEFAULT_NOTE_HEADER;

/** Small, honest self description. No secrets, no prompt text, no env values. */
export function describe() {
  return Object.values(PERSONAS).map((p) => ({
    id: p.id,
    label: p.label,
    direction: p.direction,
    frozen: !!p.frozen,
    agent_env: p.agentEnv || null,
    server_url_paths: p.routes.slice(),
    elevenlabs_appends: SUFFIX,
    model_out: p.outModel,
    caps: {
      max_tokens: p.maxTokens,
      sentences_per_turn: p.sentenceCap,
      words_per_turn: p.wordCap,
      soft_close_at_turn: p.softCloseAt,
      hard_close_at_turn: p.hardCloseAt,
    },
    tools: (p.tools || []).slice(),
    output_floors: p.outFloors.map((f) => f.by),
    input_branches: (p.stop ? ['stop'] : []).concat(p.inBranches.map((b) => b.by)).concat(['hard-close']),
    numerals_allowed_without_the_caller_saying_them: Array.from(p.numAllow),
  }));
}
