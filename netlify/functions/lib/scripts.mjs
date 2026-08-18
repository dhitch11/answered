// scripts.mjs — what the line actually says, and the words that stop it.
//
// ★ A NOTE FOR ANY LANE THAT READS THE NEVER-SAY-AI RULE AND REACHES FOR THIS FILE:
// The estate rule "voice personas never say AI unless asked" governs INBOUND calls, where the
// human dialled us. It does not govern outbound. On an outbound artificial-voice call the AI
// disclosure is a legal requirement (California AB 2905, in force 2025-01-01, $500 per
// violation; FCC 24-17 posture), and Answered's own 08-12 verdict already locks it as the
// hard-coded first sentence that cannot be edited out. Do not "fix" the opening by removing the
// disclosure. It is the one part of the script that does not come off.
//
// Four obligations live in the opening, and the dialler refuses to place a call whose script
// does not carry all four:
//   1. who is responsible for the call            47 CFR 64.1200(b)(1)
//   2. a callback number                          47 CFR 64.1200(b)(2)
//   3. that the voice is AI                       Cal. AB 2905 / FCC 24-17
//   4. that the call is recorded                  every state, not just the two-party ones,
//                                                 because we do not check where you are

const CALLBACK = () => process.env.ANSWERED_DEMO_NUMBER || '';
// The registered legal entity responsible for initiating the call, for 47 CFR 64.1200(b)(1).
// Unset is a KNOWN GAP, reported by dncReadiness(), not a silent default.
const LEGAL_ENTITY = () => (process.env.ANSWERED_LEGAL_ENTITY || '').trim();

/** Speak a US number as digits a human can write down, not as a quantity. */
export function spokenNumber(e164) {
  const d = String(e164 || '').replace(/\D/g, '').replace(/^1/, '');
  if (d.length !== 10) return '';
  const say = (s) => s.split('').join(' ');
  return `${say(d.slice(0, 3))}, ${say(d.slice(3, 6))}, ${say(d.slice(6))}`;
}

/**
 * The locked disclosure. It carries all four legal obligations and it is spoken FIRST, in a bare
 * <Say>, before any <Gather> exists on the document.
 *
 * ★ MEASURED 2026-08-14, first real end-to-end call, and this is the reason the shape of the
 * TwiML is not a matter of taste: the disclosure originally lived INSIDE the <Gather>, and a
 * nested <Say> is cut off the instant the other party makes a sound. The callee answered with
 * "Hey there, thanks for calling Cedar Ridge", which barged straight over it, and the entire
 * spoken output on our side of that call was the single word "Hi." The recording notice and the
 * AI disclosure were never said. Every real call starts with a human saying their company name,
 * so this would have silenced the disclosure on essentially all of them while the code, the
 * script file and the obligations list all still read as correct.
 *
 * A <Say> outside a <Gather> cannot be interrupted by speech. Keep it there.
 */
export function opening() {
  const cb = spokenNumber(CALLBACK());
  return [
    // ★ 47 CFR 64.1200(b)(1) requires the message to state, at the BEGINNING, "the identity of the
    // business, individual, or other entity that is responsible for initiating the call" — and the
    // (b) chapeau reads "All artificial or prerecorded voice telephone messages shall", with NO
    // line-type limitation, so it binds on business landlines exactly as it does on residences.
    //
    // "Answered" is a product name. Whether it is also the responsible entity depends on which
    // company actually places the call, and that is a fact about the corporate structure that I am
    // not entitled to assume. So the legal entity is env-driven: set ANSWERED_LEGAL_ENTITY and the
    // opening names it; leave it unset and the script keeps today's wording rather than inventing
    // a company name into a legally operative sentence.
    //
    // Deliberately NOT wired into the gate as a refusal: doing that would silently stop every call
    // over a config value, and the honest failure here is a flagged decision for David, not an
    // outage. It is surfaced by dncReadiness() instead.
    LEGAL_ENTITY() ? `Hi, this is Answered, a service of ${LEGAL_ENTITY()}.` : 'Hi, this is Answered.',
    // ★ THE THIRD PARTY IS NAMED, not just the recording.
    // Six adversarial lenses found the largest exposure in this whole program is the AI that
    // LISTENS and never speaks, and that a wiretap claim is the class-certifiable one because the
    // disclosure is a single uniform practice applied identically to every callee, at $5,000 a
    // violation with no injury element. Cal. Penal Code 632.7 reaches any call involving a cellular
    // phone, has NO confidential-communication element, and applies to PARTIES, not only
    // eavesdroppers (Smith v. LoanMe (2021) 11 Cal.5th 183). Ribas v. Clark (1985) 38 Cal.3d 355
    // found liability against a listener who never spoke: the vice is the UNANNOUNCED SECOND
    // AUDITOR. "This call is recorded" discloses the wrong object. So the sentence names what is
    // actually on the line.
    "I'm an A I voice, this call is recorded, and software is transcribing it as we speak.",
    cb ? `If you want to reach a person here, the number is ${cb}.` : '',
    // ★ THIS SENTENCE USED TO READ "I'm not selling anything." IT WAS FALSE, AND IT WAS THE MOST
    // DANGEROUS SENTENCE IN THE SCRIPT.
    //
    // The discovery script ends by offering a free week of a paid service. A.R.S. 44-1522(A)
    // declares unlawful any "deception, deceptive or unfair act or practice ... false promise,
    // misrepresentation, or concealment, suppression or omission of any material fact" made in
    // connection with the SALE OR ADVERTISEMENT of merchandise, and an inducement to try a paid
    // product is advertisement. Saying "not selling" while offering a free trial of the thing we
    // sell is the misrepresentation, stated in our own voice, in our own recording, on every call.
    //
    // The replacement is narrower and true on every call we place: we take no payment and quote
    // no price. If the script ever does quote a price, this line has to change with it.
    "I'm not asking for a payment and I won't quote you a price.",
  ].filter(Boolean).join(' ');
}

export const SCRIPTS = {
  // Pure measurement. The point is to observe what happens when a customer calls, so the call is
  // as short and as honest as it can be, and it never asks for anything.
  measure: {
    id: 'measure.v2',
    obligations: ['identify_caller_at_open', 'state_callback_number', 'disclose_ai_at_open', 'announce_recording_if_recorded'],
    // Spoken in a bare <Say>. Uninterruptible. Carries every obligation.
    disclosure: () => opening(),
    // Spoken inside the <Gather>, where being interrupted is fine and even welcome.
    ask: () => 'We are studying how home service calls get handled, and you just helped by picking up. That is the whole call. Thanks for your time, and have a good one.',
    listenSeconds: 4,
  },

  // The real one. One question about the past, then the offer, then out.
  discovery: {
    id: 'discovery.v2',
    obligations: ['identify_caller_at_open', 'state_callback_number', 'disclose_ai_at_open', 'announce_recording_if_recorded', 'honour_stop_immediately'],
    disclosure: () => opening(),
    ask: () => 'This takes under two minutes. When a customer calls you after hours and you are on a job, what happens to that call right now?',
    // The payload. Delivered only after they have answered something.
    offer: () => 'Here is why I asked. We will take the calls you are already missing, free, for a week, and send you the list of everything that came in. Your phone still rings first. One code turns it off. Want me to text you the code?',
    listenSeconds: 12,
  },

  // A human operator on the line, joined through a conference.
  //
  // NOTE ON A DISTINCTION WE ARE DELIBERATELY NOT TAKING ADVANTAGE OF: a call dialled by a
  // person, with a person speaking, is neither an autodialled call nor an artificial voice, so
  // 47 CFR 64.1200(a)(1) does not reach it and the mobile restriction that blocks everything
  // else here would not apply. That is very probably correct in law. It is still gated exactly
  // like an AI call in this system, because the moment "a human is on it" unlocks a wider pool,
  // autopilot has a loophole to drive through, and the difference between a supervised manual
  // dial and an automated one is a code path nobody will re-read in six months. If we ever want
  // the wider pool for genuinely manual dialling, it gets its own explicit lane with its own
  // audit trail, not a quiet exemption inside this object.
  conference: {
    id: 'conference.v1',
    obligations: ['identify_caller_at_open', 'state_callback_number', 'disclose_ai_at_open', 'announce_recording_if_recorded'],
    disclosure: () => opening(),
    ask: () => '',
    listenSeconds: 0,
  },

  // Voicemail. Short, honest, and it never calls back.
  voicemail: {
    id: 'voicemail.v1',
    text: () => `${opening()} We are researching how home service calls get handled. There is nothing you need to do, and we will not call this number again. Thanks.`,
  },
};

// ── STOP ─────────────────────────────────────────────────────────────────────────────────────
// Any of these on any call, in any mode, suppresses the number immediately and permanently.
// Deliberately broad. A false positive costs one research call. A false negative costs a
// complaint, and rightly.
// ★ MEASURED: a bare /\bstop\b/ is too broad and it fails in the worst possible direction. The
// discovery question is literally "what happens to that call right now", and a contractor
// answering "we stop taking calls at six" was being permanently suppressed for giving us exactly
// the answer we rang to get. So "stop" only counts when it is aimed at us: as an imperative, at
// the start of an utterance, or attached to what it wants stopped.
const STOP_PATTERNS = [
  /^\s*stop\b/i,                                   // the whole utterance opens with it
  /\bstop\s+(call|contact|phon|ring|bother|dial|it\b|that\b)/i,
  /\b(please|just|hey|ok|okay|now)\s+stop\b/i,
  /\bquit\s+(calling|phoning|bothering|texting|messaging|sending)\b/i,

  // ★ THE CARRIER OPT-OUT KEYWORDS, ADDED 2026-08-17. This function was written for the VOICE path,
  // where "stop" means stop CALLING, and it shows: `quit calling` matched and bare `quit` did not,
  // `no more calls` matched and `no more texts` did not. @LANE-SEARCHLIGHT then wired it into the
  // signup TEXT thread, where the words people use are different and where STOP, QUIT, CANCEL, END,
  // UNSUBSCRIBE and STOPALL are the keywords carriers themselves recognise. Somebody replying QUIT
  // to a text was getting an answer back from us.
  //
  // ★ THEY MATCH ONLY AS A WHOLE UTTERANCE, and that precision is the whole point. A bare `cancel`
  // is an opt-out; "cancel my appointment" is a customer asking for something and suppressing them
  // would be worse than not hearing them. Same for `end`, which is a carrier keyword and also an
  // ordinary word. The anchors keep those apart.
  /^\s*(?:quit|cancel|end|stopall|stop ?all|optout|opt ?out|revoke|unsubscribe)[\s.!]*$/i,

  // The text-shaped siblings of the call-shaped patterns already above.
  /\bstop\s+(?:text|messag)/i,
  /\bno more (?:texts?|messages?|calls?)\b/i,
  /\bdon'?t (?:text|message) me\b/i, /\bdo not (?:text|message) me\b/i,
  /\bnever (?:text|message) me\b/i,
  /\btake me off\b/i, /\bremove me\b/i, /\btake this number off\b/i,
  /\bdo not call\b/i, /\bdon'?t call\b/i, /\bnever call\b/i, /\bno more calls\b/i,
  /\bnot interested\b/i, /\bno thank(s| you)\b/i,
  /\bunsubscribe\b/i, /\bopt out\b/i,
  /\blose (my|this) number\b/i, /\bhow did you get (my|this) number\b/i,
  /\bfuck off\b/i, /\bleave me alone\b/i, /\bharass/i,
  /\b(sue|suing) you\b/i, /\bmy lawyer\b/i, /\bmy attorney\b/i, /\breport you\b/i,
];

export function isStop(text) {
  const t = String(text || '');
  return STOP_PATTERNS.some((re) => re.test(t));
}

/** Someone asking whether they are talking to a machine gets one honest sentence, never a speech. */
const ASKED_AI = [/\b(are|is) (you|this) (a |an )?(robot|bot|recording|machine|computer|a ?i|artificial)/i,
  /\bam i talking to a (real )?(person|human)/i, /\bis (this|that) a real person\b/i, /\bwhat are you\b/i];

export const askedIfAI = (text) => ASKED_AI.some((re) => re.test(String(text || '')));
export const AI_ANSWER = "Yes, I'm an A I voice. Happy to keep it short.";

/** The dialler asserts this before every call. A script missing an obligation cannot be placed. */
export function scriptSatisfies(scriptKey, obligations = []) {
  const s = SCRIPTS[scriptKey];
  if (!s) return { ok: false, missing: ['unknown script'] };
  const have = new Set(s.obligations || []);
  const missing = obligations.filter((o) => !have.has(o) && o !== 'honour_stop_immediately');
  return { ok: missing.length === 0, missing };
}
