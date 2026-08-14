// recover-script.mjs — what a Recover call is allowed to say, and what it is never allowed to say.
//
// THE LAW IS THE PRODUCT HERE. This is first-party collection: the call is placed in the CREDITOR'S
// OWN NAME, about the creditor's own invoice, for work the creditor actually did. That is the whole
// footing of 15 U.S.C. 1692a(6), and it is why the caller identity in the first sentence is not
// branding. If this call ever introduces itself as anything other than the business that did the
// work, the product stops being what it is legally allowed to be, mid-sentence.
//
// FOUR THINGS ARE IN THE FIRST BREATH, IN AN UNINTERRUPTIBLE <Say> THAT SITS OUTSIDE THE <Gather>:
//   1. an AI voice is speaking                Cal. AB 2905 (in force 2025-01-01), FCC 24-17 posture
//   2. who is responsible for the call        47 CFR 64.1200(b)(1) — and it is the CREDITOR
//   3. the call is recorded AND transcribed   Cal. Penal Code 632.7; Smith v. LoanMe (2021) 11
//                                             Cal.5th 183 reaches parties, not just eavesdroppers,
//                                             and Ribas v. Clark (1985) 38 Cal.3d 355 found against
//                                             a listener who never spoke. The unannounced second
//                                             auditor is the vice, so the transcriber is NAMED.
//   4. a callback number                      47 CFR 64.1200(b)(2)
//
// ★ THE OPENING SAYS NOTHING ABOUT A DEBT, ON PURPOSE, AND THIS IS NOT CAUTION. 1692c(b) forbids
// discussing the debt with a third party, and we do not know who picked up until they tell us. A
// spouse, an employee, a teenager, a receptionist. So the locked opening names the business and asks
// for the person. THE AMOUNT IS NEVER SPOKEN UNTIL IDENTITY IS CONFIRMED. The lesson learned inside
// lib/scripts.mjs applies with full force here: a <Say> nested in a <Gather> is cut off the instant
// the other party makes a sound, and every real call opens with a human saying "hello".
//
// ★ THE NEVER-THREATEN FLOOR IS A FILTER, NOT A PROMPT INSTRUCTION. A model told not to threaten
// still threatens sometimes, and "sometimes" is 1692e(5) and 1692d. So every generated sentence is
// scanned before it is spoken, and a sentence that trips the filter is DISCARDED and replaced with
// written copy. The model cannot talk its way past a regular expression.

/** Speak a US number as digits a human can write down, not as a quantity. */
export function spokenNumber(e164) {
  const d = String(e164 || '').replace(/\D/g, '').replace(/^1/, '');
  if (d.length !== 10) return '';
  const say = (s) => s.split('').join(' ');
  return `${say(d.slice(0, 3))}, ${say(d.slice(3, 6))}, ${say(d.slice(6))}`;
}

/** Dollars, spoken the way a person says them. Never a bare cent count, never a float artifact. */
export function spokenMoney(cents) {
  const n = Math.round(Number(cents) || 0);
  const d = Math.floor(n / 100);
  const c = n % 100;
  const dollars = d.toLocaleString('en-US');
  if (!c) return `${dollars} dollars`;
  return `${dollars} dollars and ${c} cents`;
}

/** A date said out loud, in the debtor's own week. */
export function spokenDate(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  if (!Number.isFinite(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric',
  }).format(d);
}

/**
 * THE LOCKED OPENING. Every obligation, before anything else can happen, and not one word about
 * what is owed.
 *
 * ★ THE FIRST SENTENCE IS FIXED AND IT IS "This is an A I assistant calling for <business>."
 * Everything downstream, including the legality of the call, hangs off that being true and being
 * first. It takes no arguments it can be talked out of.
 */
export function opening({ businessName, callbackNumber, debtorName }) {
  const business = String(businessName || '').trim();
  if (!business) throw new Error('a Recover call cannot open without the name of the business it is calling for');
  const cb = spokenNumber(callbackNumber);
  return [
    `This is an A I assistant calling for ${business}.`,
    'This call is recorded, and software is transcribing it as we speak.',
    cb ? `If you want to reach a person there, the number is ${cb}.` : '',
    debtorName ? `I am trying to reach ${String(debtorName).trim()} about a billing matter.` : 'I am calling about a billing matter.',
  ].filter(Boolean).join(' ');
}

/** Asked inside the <Gather>, where being interrupted is fine. */
export function identityAsk(debtorName) {
  return `Am I speaking with ${String(debtorName || '').trim()}?`;
}

/**
 * Said ONLY after identity is confirmed. Every number in it comes from the invoice record, never
 * from a model: 1692e(2) makes a misstated amount a false representation, so the amount is not a
 * thing anything in this system is allowed to improvise.
 */
export function debtStatement({ businessName, amountCents, invoiceNumber, jobDescription, issuedAt, jobAddress }) {
  const bits = [`${businessName} has invoice ${String(invoiceNumber).split('').join(' ')} open for ${spokenMoney(amountCents)}`];
  if (jobDescription) bits.push(`for the ${String(jobDescription).trim()}`);
  if (jobAddress) bits.push(`at ${String(jobAddress).trim()}`);
  if (issuedAt) bits.push(`sent on ${spokenDate(issuedAt)}`);
  return `${bits.join(' ')}. I am not here to argue about it, I just need to know when you can get it paid.`;
}

export const WRONG_PARTY = (businessName, callbackNumber) => {
  const cb = spokenNumber(callbackNumber);
  return `No problem, sorry to bother you. ${cb ? `If you can pass along that ${businessName} called, the number is ${cb}. ` : ''}Have a good one.`;
};

export const STOP_ACKNOWLEDGED =
  'Understood. I have taken this number off the list and we will not call it again. Sorry to have bothered you.';

export const DISPUTE_ACKNOWLEDGED =
  'Got it, and thank you for telling me. I have marked this as disputed and stopped the calls. Somebody from the office will follow up directly.';

export const NO_DATE_YET =
  'That is fair. What day should I put down, even a rough one, so nobody calls you again before then?';

export const PROMISE_CLOSE = (amountCents, iso, businessName) =>
  `Thank you. I have written down ${spokenMoney(amountCents)} on ${spokenDate(iso)}, and I will let ${businessName} know. `
  + 'Nobody will call you again before then. Have a good one.';

export const CLOSE_UNRESOLVED = (businessName, callbackNumber) => {
  const cb = spokenNumber(callbackNumber);
  return `Alright, I will let ${businessName} know we spoke. ${cb ? `Their number is ${cb} if you want to sort it out directly. ` : ''}Thanks for your time.`;
};

/**
 * ★ A VOICEMAIL NAMES NO DEBT. A machine is not the debtor: a spouse, a roommate, an employee or a
 * child can play it back, and 1692c(b) forbids discussing the debt with a third party. This is the
 * whole Foti / Zortman problem, and the resolution both cases point at is a message that identifies
 * the caller and asks for a call back, and stops there. It is also why this message does not carry
 * the "attempt to collect a debt" line: saying it out loud to an unknown listener IS the disclosure.
 */
export const VOICEMAIL = ({ businessName, callbackNumber, debtorName }) => {
  const cb = spokenNumber(callbackNumber);
  return `This is an A I assistant calling for ${businessName}. `
    + `${debtorName ? `This message is for ${debtorName}. ` : ''}`
    + `Please give ${businessName} a call back${cb ? ` at ${cb}` : ''}. Thanks.`;
};

export const BROKEN = (businessName, callbackNumber) => {
  const cb = spokenNumber(callbackNumber);
  return `This is an A I assistant calling for ${businessName}, and something just failed on our end. Sorry about that.`
    + `${cb ? ` Their number is ${cb}.` : ''} Goodbye.`;
};

// ── THE NEVER-THREATEN FLOOR ─────────────────────────────────────────────────────────────────
// 1692e(5): threatening any action that cannot legally be taken or is not actually intended.
// 1692e(4): representing that nonpayment will result in arrest, seizure, garnishment or attachment
// unless that is lawful AND intended. 1692d(1)-(2): threats of harm, abusive language.
//
// We do not sue anybody, we do not report to any credit bureau, we do not put liens on houses, and
// we have no idea whether our customer intends to. So the honest rule is that this voice never says
// any of it. Not softened, not conditional, not "eventually". Never.
const FORBIDDEN = [
  // ★ `court` IS MATCHED BARE, not only in "take you to court". The test suite caught "This could
  // end up in court" walking straight through a list that already had four different court phrases
  // in it, which is exactly how a filter built from examples fails: it catches the sentences
  // somebody thought of and misses the one a model actually writes.
  { re: /\b(sue|suing|lawsuit|litigat|court|legal action|judgment|judgement|small claims)\b/i, why: 'threat of legal action' },
  { re: /\b(lien|garnish|garnishment|levy|repossess|seiz(e|ure)|foreclos)/i, why: 'threat of seizure or attachment' },
  { re: /\b(arrest|jail|prison|police|warrant|criminal charges|fraud charges)\b/i, why: 'threat of arrest or criminal process' },
  { re: /\b(credit (report|bureau|score|rating)|equifax|experian|transunion|ding your credit|hurt your credit)\b/i, why: 'threat about credit reporting' },
  { re: /\b(collections? agency|send (this|it|you) to collections|turn (this|it|you) over to collections|charge ?off)\b/i, why: 'threat of referral to a collector' },
  { re: /\b(attorney|lawyer|law firm|counsel)\b/i, why: 'invoking lawyers' },
  { re: /\b(late fee|interest|penalty|penalties|finance charge)\b/i, why: 'a charge that is not on the invoice record' },
  { re: /\b(deadbeat|scam|fraud|steal|thief|stole|liar|lying)\b/i, why: 'abusive characterisation' },
  { re: /\b(have to|must|required to) pay (today|now|right now|immediately)\b/i, why: 'a demand for immediate payment we cannot enforce' },
  { re: /\b(consequences|escalat|final notice|last warning|serious trouble)\b/i, why: 'vague menace' },
  { re: /\$\s?\d/, why: 'an amount, which only the invoice record is allowed to state' },
  { re: /\b\d{2,}\s?(dollars|bucks)\b/i, why: 'an amount, which only the invoice record is allowed to state' },
];

/**
 * Scan one candidate sentence before it is ever spoken.
 * @returns {{ok:boolean, why?:string, pattern?:string}}
 */
export function floorCheck(text) {
  const t = String(text || '');
  for (const f of FORBIDDEN) {
    if (f.re.test(t)) return { ok: false, why: f.why, pattern: String(f.re) };
  }
  return { ok: true };
}

// ── STOP, AND DISPUTE, WHICH ARE DIFFERENT ───────────────────────────────────────────────────
// 1692c(c): a request to stop communicating ends the calls, full stop, immediately. Deliberately
// broad, because a false positive costs one call and a false negative costs a complaint and rightly.
const STOP_PATTERNS = [
  /^\s*stop\b/i,
  /\bstop\s+(call|contact|phon|ring|bother|dial|it\b|that\b)/i,
  /\b(please|just|hey|ok|okay|now)\s+stop\b/i,
  /\bquit\s+(calling|phoning|bothering)\b/i,
  /\btake me off\b/i, /\bremove me\b/i, /\btake this number off\b/i,
  /\bdo not call\b/i, /\bdon'?t call\b/i, /\bnever call\b/i, /\bno more calls\b/i,
  /\bstop contacting me\b/i, /\bcease (and desist|contact|communication)/i,
  /\bunsubscribe\b/i, /\bopt out\b/i,
  /\blose (my|this) number\b/i,
  /\bfuck off\b/i, /\bleave me alone\b/i, /\bharass/i,
];
export const isStop = (t) => STOP_PATTERNS.some((re) => re.test(String(t || '')));

// A dispute is NOT a stop. It stops this debt and says nothing about the person, so it never writes
// a permanent suppression. It is also the one thing on this call that a machine must not argue with.
const DISPUTE_PATTERNS = [
  /\b(i )?(dispute|disputing)\b/i,
  /\b(i )?(already|alread[iy]) paid\b/i, /\bi paid (that|this|it|you)\b/i,
  // "that's not" and "that is not" are the same sentence and people say both. A contraction-only
  // pattern reads as thorough and misses half of every real transcript.
  /\bthat('?s| is| was)? ?(not|isn'?t|ain'?t) (right|correct|mine|my bill|my invoice)\b/i,
  /\b(i )?(don'?t|do not|never) owe\b/i, /\bnever (hired|used|ordered)\b/i,
  // ★ "wrong number" AND "wrong person" ARE DELIBERATELY NOT HERE ANY MORE, and taking them out
  // fixed a real misclassification found by driving a live call: "no, wrong number" was being filed
  // as a DISPUTE OF THE DEBT. Nothing leaked, because the wrong-party branch never speaks an
  // amount either, so the failure was invisible from the outside. It was still wrong in three ways
  // that matter: a perfectly valid invoice was frozen as "disputed", it landed in the operator's
  // dispute queue where a human would go looking for an argument nobody made, and the ONE action
  // the call should have triggered (this number does not reach our debtor, stop dialling it) never
  // happened. A wrong number is a fact about the NUMBER. A dispute is a fact about the DEBT.
  /\bwrong (account|amount|invoice|bill)\b/i,
  /\bwork (was )?(never|not) (done|finished|completed)\b/i,
  /\b(my|an?) (lawyer|attorney)\b/i,
  /\bbankrupt/i,
];
export const isDispute = (t) => DISPUTE_PATTERNS.some((re) => re.test(String(t || '')));

/**
 * "You have the wrong number." Its own verdict, checked BEFORE both stop and dispute.
 *
 * This is the one branch where the person on the line is, on their own account, NOT our debtor, and
 * that changes what the right action is. It is not a dispute: no debt is being contested. It is not
 * quite an ordinary stop either: nobody is opting out of anything, they are telling us we have a
 * fact wrong. But the ACTION is the same as a stop and for a stronger reason, because the harm of
 * getting this wrong is an uninvolved stranger receiving an artificial voice about somebody else's
 * bill, over and over. So it stops the calls and suppresses the number, and it tells the operator
 * the invoice needs a better number rather than a lawyer.
 */
const WRONG_NUMBER_PATTERNS = [
  /\bwrong (number|person|guy|lady)\b/i,
  /\b(no ?one|nobody) (here )?(by|with) that name\b/i,
  /\bnever heard of (him|her|them|that (guy|person|name))\b/i,
  // "there is no" and "there's no" again: the third time in this file a contraction-only pattern
  // has silently covered half the sentences people say. Both spellings, every time.
  /\bthere('s| is|s)? no \w+ here\b/i,
  /\byou('| ha)?ve got the wrong\b/i,
];
export const isWrongNumber = (t) => WRONG_NUMBER_PATTERNS.some((re) => re.test(String(t || '')));

export const WRONG_NUMBER_ACKNOWLEDGED =
  'Sorry about that, I had the wrong number. I have taken it off the list and we will not call it again. Have a good one.';

const ASKED_AI = [
  /\b(are|is) (you|this) (a |an )?(robot|bot|recording|machine|computer|a ?i|artificial)/i,
  /\bam i talking to a (real )?(person|human)/i,
  /\bis (this|that) a real person\b/i,
  /\bwhat are you\b/i,
];
export const askedIfAI = (t) => ASKED_AI.some((re) => re.test(String(t || '')));
export const AI_ANSWER = "Yes, I'm an A I assistant. Happy to keep this short.";

const YES = /\b(yes|yeah|yep|yup|speaking|this is (he|she|him|her|me)|that'?s me|uh huh|correct|sure|it is)\b/i;
// Same lesson as the dispute list: "doesn't live here" and "does not live here" are one sentence
// spoken two ways, and only one of them was in the pattern until a test said so out loud.
const NO = /\b(no|nope|nah|wrong number|not me|he'?s not|she'?s not|isn'?t here|is not here|(does ?n'?t|does not) live here|never heard)\b/i;
export const saidYes = (t) => YES.test(String(t || '')) && !NO.test(String(t || ''));
export const saidNo = (t) => NO.test(String(t || ''));

// ── THE PROMISE TO PAY ───────────────────────────────────────────────────────────────────────
// Deterministic. The numbers on this call are never produced by a language model: /terms turns a
// promise into a billing-relevant fact (it is what next_action_at is set from) and a hallucinated
// Thursday is a call to somebody who asked not to be called until Friday.

const WORD_NUM = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const WEEKDAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6,
  august: 7, september: 8, october: 9, november: 10, december: 11,
};

/** Spelled-out English up to "nine hundred ninety nine thousand"-ish. Enough for an invoice. */
function wordsToNumber(text) {
  const words = String(text).toLowerCase().replace(/-/g, ' ').replace(/\band\b/g, ' ').split(/\s+/).filter(Boolean);
  let total = 0; let current = 0; let seen = false;
  for (const w of words) {
    if (w in WORD_NUM) { current += WORD_NUM[w]; seen = true; }
    else if (w === 'hundred') { current = (current || 1) * 100; seen = true; }
    else if (w === 'thousand') { total += (current || 1) * 1000; current = 0; seen = true; }
    else { return seen ? total + current : null; }
  }
  return seen ? total + current : null;
}

/**
 * An amount, in cents, or null for "they did not name one".
 * null is a real answer and it means the balance, which is why it is never coerced to zero.
 */
export function parseAmountCents(text, balanceCents) {
  const t = String(text || '').toLowerCase();
  if (/\b(all of it|the whole (thing|lot|amount|balance)|in full|everything|paid in full|the full amount)\b/.test(t)) {
    return { cents: balanceCents ?? null, how: 'they said the whole balance' };
  }
  if (/\bhalf\b/.test(t) && Number.isFinite(balanceCents)) {
    return { cents: Math.round(balanceCents / 2), how: 'they said half' };
  }
  const digits = t.match(/\$?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?\s*(?:dollars|bucks)?/);
  if (digits) {
    const whole = Number(digits[1].replace(/,/g, ''));
    const cents = Number(digits[2] || 0);
    // A bare one or two digit number in a sentence about days is a DATE, not an amount. Requiring
    // the word "dollars" or a "$" for anything under 100 keeps "I'll pay on the 15th" from being
    // read as fifteen dollars, which is the single most expensive misread available here.
    const explicit = /\$/.test(t) || /\b(dollars|bucks)\b/.test(t);
    if (whole >= 100 || explicit) {
      return { cents: whole * 100 + cents, how: `they said ${digits[0].trim()}` };
    }
  }
  const spelled = t.match(/((?:(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|and)[\s-]*)+)\s*(?:dollars|bucks)/);
  if (spelled) {
    const n = wordsToNumber(spelled[1]);
    if (Number.isFinite(n) && n > 0) return { cents: n * 100, how: `they said ${spelled[0].trim()}` };
  }
  return { cents: null, how: 'they did not name an amount, so this is the whole balance' };
}

/** Today, as a Y/M/D triple in the DEBTOR'S timezone. A promise is a date in their week, not ours. */
function localToday(tz, now) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now).map((p) => [p.type, p.value]),
  );
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) };
}
const iso = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toISOString().slice(0, 10);
};
const dow = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
const addDays = (y, m, d, n) => {
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
};

/**
 * A date, or null. Resolved in the debtor's own timezone so "Friday" is their Friday.
 * @returns {{iso:string|null, how:string}}
 */
export function parseDate(text, { timezone = 'America/Los_Angeles', now = new Date() } = {}) {
  const t = String(text || '').toLowerCase();
  let tz = timezone;
  let today;
  try { today = localToday(tz, now); }
  catch { tz = 'America/Los_Angeles'; today = localToday(tz, now); }

  if (/\b(today|right now|this afternoon|tonight|this evening)\b/.test(t)) {
    return { iso: iso(today.y, today.m, today.d), how: 'they said today' };
  }
  if (/\btomorrow\b/.test(t)) {
    const n = addDays(today.y, today.m, today.d, 1);
    return { iso: iso(n.y, n.m, n.d), how: 'they said tomorrow' };
  }

  // "friday", "next friday", "a week from tuesday"
  const wd = t.match(/\b(next\s+|this\s+|a week from\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (wd) {
    const want = WEEKDAYS[wd[2]];
    const cur = dow(today.y, today.m, today.d);
    let delta = (want - cur + 7) % 7;
    if (delta === 0) delta = 7;                                   // "Friday" said on a Friday means the next one
    if (/next|a week from/.test(wd[1] || '')) delta += 7;
    const n = addDays(today.y, today.m, today.d, delta);
    return { iso: iso(n.y, n.m, n.d), how: `they said ${wd[0].trim()}` };
  }

  // "the 15th", "on the 3rd", "March 3rd", "the first"
  const ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, fifteenth: 15, twentieth: 20, thirtieth: 30 };
  const md = t.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (md) {
    const mm = MONTHS[md[1]] + 1;
    const dd = Number(md[2]);
    let yy = today.y;
    if (mm < today.m || (mm === today.m && dd < today.d)) yy += 1;
    return { iso: iso(yy, mm, dd), how: `they said ${md[0].trim()}` };
  }
  const dm = t.match(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/) || t.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/)
    || t.match(/\b(?:on\s+)?the\s+(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|fifteenth|twentieth|thirtieth)\b/);
  if (dm) {
    const dd = Number(dm[1]) || ORD[dm[1]];
    if (dd >= 1 && dd <= 31) {
      let yy = today.y; let mm = today.m;
      if (dd < today.d || /next month/.test(t)) { mm += 1; if (mm > 12) { mm = 1; yy += 1; } }
      return { iso: iso(yy, mm, dd), how: `they said the ${dd}` };
    }
  }

  const inN = t.match(/\bin\s+((?:a|one|two|three|four|five|six|seven|eight|nine|ten|\d+))\s+(day|days|week|weeks)\b/);
  if (inN) {
    const raw = inN[1] === 'a' ? 1 : (Number(inN[1]) || wordsToNumber(inN[1]) || 0);
    const mult = /week/.test(inN[2]) ? 7 : 1;
    if (raw > 0) {
      const n = addDays(today.y, today.m, today.d, raw * mult);
      return { iso: iso(n.y, n.m, n.d), how: `they said in ${inN[1]} ${inN[2]}` };
    }
  }
  if (/\bnext week\b/.test(t)) {
    const n = addDays(today.y, today.m, today.d, 7);
    return { iso: iso(n.y, n.m, n.d), how: 'they said next week' };
  }
  if (/\b(end of (the )?(month|the month))\b/.test(t)) {
    const last = new Date(Date.UTC(today.y, today.m, 0)).getUTCDate();
    return { iso: iso(today.y, today.m, last), how: 'they said the end of the month' };
  }
  if (/\b(next|first of (the |next )?month|beginning of (the |next )?month)\b/.test(t) && /month/.test(t)) {
    let mm = today.m + 1; let yy = today.y;
    if (mm > 12) { mm = 1; yy += 1; }
    return { iso: iso(yy, mm, 1), how: 'they said the first of next month' };
  }
  if (/\b(payday|when i get paid|after i get paid)\b/.test(t)) {
    return { iso: null, how: 'they said payday, which is not a date' };
  }
  return { iso: null, how: 'no date in what they said' };
}

const PROMISE_INTENT = [
  /\b(i(?:'| w)?ll|i will|i can|we(?:'| w)?ll|we will|we can)\s+(pay|send|get|drop|mail|put|have|do|take care|settle|square)/i,
  /\b(pay|send|mail|drop)\s+(it|that|you|the (check|cheque|money|balance|rest))/i,
  /\b(check|cheque) (is|will be) (in the mail|out|sent)/i,
  /\bcan (i|we) (pay|send|do)\b/i,
  /\b(put|get) (it|that) (on|in) the mail\b/i,
  /\bsettle (it|this|up)\b/i,
  /\btake care of (it|that|this)\b/i,
];
export const soundsLikeAPromise = (t) => PROMISE_INTENT.some((re) => re.test(String(t || '')));

/**
 * The whole extraction, from one utterance.
 *
 * A PROMISE IS ONLY A PROMISE WHEN IT HAS A DATE. "I'll get you sorted" with no day is not something
 * a follow-up can be scheduled against, and recording it as one would put a fabricated commitment in
 * front of a customer. Intent without a date returns needs_date, and the call asks for one.
 */
export function extractPromise(text, { balanceCents, timezone, now = new Date() } = {}) {
  const heard = String(text || '').trim();
  if (!heard) return { promise: null, needs_date: false, reason: 'nothing was said' };

  const date = parseDate(heard, { timezone, now });
  const intent = soundsLikeAPromise(heard);
  if (!intent && !date.iso) return { promise: null, needs_date: false, reason: 'no promise and no date in what they said' };
  if (!date.iso) {
    return { promise: null, needs_date: true, reason: `they sound willing but gave no date (${date.how})` };
  }

  const amount = parseAmountCents(heard, balanceCents);
  // ★ NO AMOUNT NAMED MEANS THE WHOLE BALANCE, AND IT IS RESOLVED HERE, NOT LEFT AS null FOR A
  // CALLER TO GUESS AT. A promise row carrying amount_cents: null is a row where the operator sees
  // a blank, the follow-up says nothing, and every reader has to know an unwritten convention. The
  // number is knowable at this point, so it gets written down at this point.
  const resolved = Number.isFinite(amount.cents) ? amount.cents
    : (Number.isFinite(balanceCents) ? balanceCents : null);
  return {
    promise: {
      amount_cents: resolved,
      promised_for: date.iso,
      spoken_text: heard.slice(0, 1000),
      method: 'spoken_on_call',
    },
    needs_date: false,
    reason: `${date.how}; ${amount.how}`,
  };
}
