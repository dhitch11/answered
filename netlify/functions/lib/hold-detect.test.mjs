// hold-detect.test.mjs — measure the detector, do not believe it.
//
// Run:  node netlify/functions/lib/hold-detect.test.mjs
//
// Every line in the corpus below is the kind of sentence a telephone transcriber actually returns
// from a queue, a phone tree, a voicemail box or a person picking up. The adversarial half is the
// point: the sentences that carry BOTH a machine marker and a human marker are the ones a naive
// keyword matcher gets wrong, and getting them wrong is either two hours of the customer's life
// thrown away, or a stranger left listening to silence.
//
// This file asserts. It does not print a green tick for existing.

import { classifyUtterance, menuOptions, chooseOption, fuse, FAR } from './hold-detect.mjs';

let pass = 0; const fails = [];
const eq = (label, got, want) => {
  if (got === want) { pass++; return; }
  fails.push(`${label}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
};
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; return; }
  fails.push(`${label}${detail ? `\n     ${detail}` : ''}`);
};

// ── 1. the machine, in its own words ─────────────────────────────────────────────────────────
const MACHINE = [
  ['Thank you for calling the Department of Motor Vehicles. Please listen carefully as our menu options have changed.', FAR.IVR],
  ['For registration and titling, press one. For driver licensing, press two. For all other inquiries, press three.', FAR.IVR],
  ['If you know your party\'s extension, you may dial it at any time.', FAR.IVR],
  ['Please say or enter your nine digit account number now.', FAR.IVR],
  ['To repeat these options, press nine. To return to the main menu, press star.', FAR.IVR],
  ['Para continuar en espanol, oprima el numero dos.', FAR.IVR],
  ['All of our representatives are currently assisting other callers.', FAR.QUEUE],
  ['Your call is very important to us. Please continue to hold and your call will be answered in the order it was received.', FAR.QUEUE],
  ['We are currently experiencing higher than normal call volume.', FAR.QUEUE],
  ['Your estimated wait time is more than thirty minutes.', FAR.QUEUE],
  ['You are now caller number four in the queue. Please do not hang up or you will lose your place in line.', FAR.QUEUE],
  ['Thank you for your patience. The next available agent will be with you shortly.', FAR.QUEUE],
  ['Please leave a message after the tone and someone will return your call.', FAR.VOICEMAIL],
  ['The person you are trying to reach is not available right now.', FAR.VOICEMAIL],
  ['Our offices are now closed. Please call back during normal business hours, Monday through Friday.', FAR.VOICEMAIL],
];
for (const [text, want] of MACHINE) {
  const v = classifyUtterance(text);
  eq(`machine: "${text.slice(0, 58)}..."`, v.state, want);
}

// ── 2. a person, in theirs ───────────────────────────────────────────────────────────────────
const PEOPLE = [
  'Thanks for holding, this is Denise in claims, how can I help you?',
  'Claims department, Marcus speaking.',
  'Hi there, sorry about the wait. What can I do for you today?',
  'Okay, go ahead.',
  'Can I get your case number please?',
  'Who am I speaking with?',
  'Hello? Hello, are you there?',
  'Yeah, this is Robert.',
  'Good morning, benefits office.',
  'Hello?',
];
for (const text of PEOPLE) {
  const v = classifyUtterance(text);
  eq(`person: "${text.slice(0, 58)}"`, v.state, FAR.HUMAN);
}

// ── 3. THE ADVERSARIAL HALF: both vocabularies in one sentence ───────────────────────────────
// These are the sentences that decide whether this module is worth anything.

// A real agent almost always opens by apologising for the queue they just pulled you out of.
// Every one of these contains a queue phrase and is still a person.
const HUMAN_WEARING_MACHINE_WORDS = [
  ['Thank you for holding, this is Angela, how may I help you?', 'thanks_for_holding_name / self_named'],
  ['Sorry for the wait, my name is Tom, what is your reference number?', 'sorry_for_wait'],
  ['Thanks for your patience, this is Priya in eligibility.', 'self_named'],
];
for (const [text, why] of HUMAN_WEARING_MACHINE_WORDS) {
  const v = classifyUtterance(text);
  eq(`ADVERSARIAL human: "${text.slice(0, 50)}..." (${why})`, v.state, FAR.HUMAN);
  eq(`  ...and it is STRONG, so we ring the customer at once`, v.strength, 'strong');
}

// A recording that opens with a greeting. A naive "starts with hello" rule calls this a person
// and rings the customer into a phone tree.
const MACHINE_WEARING_HUMAN_WORDS = [
  ['Hello, and thank you for calling Blue Ridge Insurance. For claims, press one.', FAR.IVR],
  ['Hi there. All of our specialists are helping other callers right now.', FAR.QUEUE],
  ['Good afternoon. Your call is important to us. Please stay on the line.', FAR.QUEUE],
  ['Hello. This is a recorded message from the billing department.', FAR.UNKNOWN],
  ['Hi, this is an automated call. Please listen carefully.', FAR.IVR],
];
for (const [text, want] of MACHINE_WEARING_HUMAN_WORDS) {
  const v = classifyUtterance(text);
  eq(`ADVERSARIAL machine: "${text.slice(0, 50)}..."`, v.state, want);
}

// The specific negative lookahead that stops "this is" from firing on a recording.
ok('"this is a recording" is not a person', classifyUtterance('This is a recording.').state !== FAR.HUMAN);
ok('"this is the Department of Labor" is not a person', classifyUtterance('This is the Department of Labor.').state !== FAR.HUMAN);
ok('"this is an important message" is not a person', classifyUtterance('This is an important message about your account.').state !== FAR.HUMAN);
ok('"this is Denise" IS a person', classifyUtterance('This is Denise.').state === FAR.HUMAN);

// Empty transcript is never a person. Hold music transcribes to nothing, and a detector that
// reads nothing as somebody would bridge the customer into silence every single time.
eq('empty is unknown, never human', classifyUtterance('').state, FAR.UNKNOWN);
eq('whitespace is unknown, never human', classifyUtterance('   \n  ').state, FAR.UNKNOWN);

// ── 4. reading the tree ──────────────────────────────────────────────────────────────────────
const menu = 'Thank you for calling. For a new claim, press one. For an existing claim, press two. '
  + 'To speak with billing, press three. Press four for office hours.';
const opts = menuOptions(menu);
eq('four options were heard', opts.length, 4);
eq('option 2 is the existing claim', opts.find((o) => o.digit === '2')?.label, 'an existing claim');
eq('option 4 parses from the reversed phrasing', opts.find((o) => o.digit === '4')?.label, 'office hours');

const picked = chooseOption(opts, 'my existing claim has been stalled for six weeks', 'AB-4471');
eq('the errand routes to the existing claim', picked?.digit, '2');

ok('an errand with no matching option returns null, never a guess',
  chooseOption(opts, 'I want to complain about a pothole on Route 9', null) === null);
ok('no options at all returns null', chooseOption([], 'anything', null) === null);

// A tie must refuse. "my claim" matches both the new-claim and existing-claim options equally,
// and pressing either one on a coin flip throws away an hour of queue.
ok('an ambiguous errand refuses rather than picking the first option',
  chooseOption(opts, 'I am calling about my claim', null) === null,
  `got ${JSON.stringify(chooseOption(opts, 'I am calling about my claim', null))}`);
eq('...while an unambiguous one still resolves',
  chooseOption(opts, 'I am calling about my existing claim', null)?.digit, '2');

// Every chosen digit must be one the tree actually offered. This is the property that keeps a
// language model away from the keypad.
for (const reason of ['new claim', 'billing question', 'what are your hours', 'existing claim']) {
  const c = chooseOption(opts, reason, null);
  ok(`"${reason}" only ever picks an offered digit`, c === null || opts.some((o) => o.digit === c.digit),
    `picked ${JSON.stringify(c)}`);
}

// ── 5. the state machine ─────────────────────────────────────────────────────────────────────
const T = 1_700_000_000_000;

eq('silence after answering is not a person',
  fuse({ utterances: [], answeredAt: T, now: T + 20000 }).act, 'hold');

eq('a phone tree sends us to the menu handler',
  fuse({ utterances: [{ text: 'For claims press one.', at: T + 2000 }], answeredAt: T, now: T + 3000 }).act, 'menu');

eq('a queue keeps us holding',
  fuse({ utterances: [{ text: 'All of our representatives are currently busy.', at: T + 5000 }], answeredAt: T, now: T + 6000 }).act, 'hold');

const strong = fuse({ utterances: [{ text: 'Thanks for holding, this is Denise, how can I help you?', at: T + 90000 }], answeredAt: T, now: T + 91000 });
eq('a strong person makes us speak up', strong.act, 'announce');
eq('...and ring the customer at the same moment', strong.ringUserNow, true);

// A weak signal moments after the hold loop spoke is the hold loop.
eq('a weak signal right after the queue spoke is overruled',
  fuse({ utterances: [
    { text: 'Please continue to hold.', at: T + 40000 },
    { text: 'Okay', at: T + 43000 },
  ], answeredAt: T, now: T + 44000 }).act, 'hold');

// The same weak signal after a long quiet stretch is worth a sentence, but not worth ringing
// the customer until it answers.
const weakLate = fuse({ utterances: [
  { text: 'Please continue to hold.', at: T + 40000 },
  { text: 'Okay', at: T + 120000 },
], answeredAt: T, now: T + 121000 });
eq('the same weak signal much later is worth speaking up', weakLate.act, 'announce');
eq('...but the customer is NOT rung until it is confirmed', weakLate.ringUserNow, false);

// The confirmation. This is the whole design: we spoke, and something answered.
const confirmed = fuse({
  utterances: [
    { text: 'Please continue to hold.', at: T + 40000 },
    { text: 'Yes, hello, sorry, this is Ray.', at: T + 126000 },
  ],
  answeredAt: T, announcedAt: T + 122000, now: T + 127000,
});
eq('a person answering our disclosure is a confirmed bridge', confirmed.act, 'bridge');
eq('...and the verdict says so', confirmed.confidence, 'confirmed');

const notConfirmed = fuse({
  utterances: [
    { text: 'Okay', at: T + 120000 },
    { text: 'Your call is important to us. Please hold.', at: T + 124000 },
  ],
  answeredAt: T, announcedAt: T + 122000, now: T + 125000,
});
eq('the hold loop carrying on after we spoke is NOT a bridge', notConfirmed.act, 'hold');

eq('nothing answering us at all is not a bridge either',
  fuse({ utterances: [{ text: 'Okay', at: T + 120000 }], answeredAt: T, announcedAt: T + 122000, now: T + 135000 }).act, 'hold');

eq('a voicemail box ends the errand rather than waiting on it',
  fuse({ utterances: [{ text: 'Please leave a message after the tone.', at: T + 4000 }], answeredAt: T, now: T + 5000 }).act, 'give_up');

// ── 6. THE PROPERTY THAT MATTERS MOST ────────────────────────────────────────────────────────
// Across the whole machine corpus, running as a live session, the machine must never once reach
// 'bridge'. A single false bridge here is a customer's phone ringing for a recording.
let falseBridges = 0;
for (const [text] of MACHINE) {
  const v = fuse({ utterances: [{ text, at: T + 1000 }], answeredAt: T, now: T + 2000 });
  if (v.act === 'bridge') falseBridges++;
}
eq('ZERO false bridges across the whole machine corpus', falseBridges, 0);

// And the mirror: every strong person, heard cold, must make us speak up rather than sit there.
let missedPeople = 0;
for (const text of PEOPLE) {
  const v = fuse({ utterances: [{ text, at: T + 90000 }], answeredAt: T, now: T + 91000 });
  if (v.act !== 'announce' && v.act !== 'bridge') missedPeople++;
}
eq('every person in the corpus gets spoken to', missedPeople, 0);

// ── report ───────────────────────────────────────────────────────────────────────────────────
if (fails.length) {
  console.error(`\nhold-detect: ${pass} passed, ${fails.length} FAILED\n`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`hold-detect: ${pass} assertions passed.`);
