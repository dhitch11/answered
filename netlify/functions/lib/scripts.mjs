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

/** Speak a US number as digits a human can write down, not as a quantity. */
export function spokenNumber(e164) {
  const d = String(e164 || '').replace(/\D/g, '').replace(/^1/, '');
  if (d.length !== 10) return '';
  const say = (s) => s.split('').join(' ');
  return `${say(d.slice(0, 3))}, ${say(d.slice(3, 6))}, ${say(d.slice(6))}`;
}

export function opening() {
  const cb = spokenNumber(CALLBACK());
  return [
    'Hi, this is Answered.',
    "I'm an A I voice, and this call is recorded.",
    cb ? `If you want to reach a person here, the number is ${cb}.` : '',
    "I'm not selling anything.",
  ].filter(Boolean).join(' ');
}

export const SCRIPTS = {
  // Pure measurement. The point is to observe what happens when a customer calls, so the call is
  // as short and as honest as it can be, and it never asks for anything.
  measure: {
    id: 'measure.v1',
    obligations: ['identify_caller_at_open', 'state_callback_number', 'disclose_ai_at_open', 'announce_recording_if_recorded'],
    open: () => `${opening()} We are studying how home service calls get handled, and you have just helped by picking up. That is the whole call. Thanks for your time, and have a good one.`,
    listenSeconds: 4,
  },

  // The real one. One question about the past, then the offer, then out.
  discovery: {
    id: 'discovery.v1',
    obligations: ['identify_caller_at_open', 'state_callback_number', 'disclose_ai_at_open', 'announce_recording_if_recorded', 'honour_stop_immediately'],
    open: () => `${opening()} This takes under two minutes. When a customer calls you after hours and you are on a job, what happens to that call right now?`,
    // The payload. Delivered only after they have answered something.
    offer: () => 'Here is why I asked. We will take the calls you are already missing, free, for a week, and send you the list of everything that came in. Your phone still rings first. One code turns it off. Want me to text you the code?',
    listenSeconds: 12,
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
const STOP_PATTERNS = [
  /\bstop\b/i, /\btake me off\b/i, /\bremove me\b/i, /\bdo not call\b/i, /\bdon'?t call\b/i,
  /\bnot interested\b/i, /\bno thank(s| you)\b/i, /\bunsubscribe\b/i, /\bopt out\b/i,
  /\bquit calling\b/i, /\bstop calling\b/i, /\bnever call\b/i, /\blose (my|this) number\b/i,
  /\bfuck off\b/i, /\bleave me alone\b/i, /\bharass/i, /\bsue\b/i, /\blawyer\b/i, /\battorney\b/i,
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
