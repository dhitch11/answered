// personas.mjs — the three voices Answered speaks with, and the deterministic
// floors under each of them. Pure: no env reads, no network, no clock beyond
// what a caller hands it. Everything here is a value or a function of values,
// so every floor in it can be asserted without a phone.
//
// ★ WHY ONE FILE AND ONE BRIDGE, INSTEAD OF THREE.
// ★ "riley" IS A ROUTE NAME. "Thomas" IS WHAT THE VOICE SAYS. Do not reconcile them.
// The persona id `riley` is load-bearing: it is in config.path as /api/answered-brain/riley, it is
// the ElevenLabs agent's configured LLM URL, and it is pinned by the frozen-spec digest test.
// Renaming the id would 404 a live agent silently, which is precisely the failure the literal route
// table exists to prevent. The SPOKEN name changed to Thomas on David's instruction and the spec
// says "You are Thomas"; every customer-facing and operator-facing string has been updated to match.
// Comments below that still say Riley are describing the slot, not the voice.
//
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
// ★ THE NAME IS NOW THOMAS. David ruled it 2026-08-16: the conversational AI is Thomas,
// the backup voice is Parker, and the company is Answered. The freeze note below said a
// behaviour change to a live line is "a decision, not a refactor" and deferred it to David.
// He has made it, so the SPOKEN NAME changed and NOTHING ELSE did: every string, regex, cap and
// order of evaluation below is untouched, and personas.test.mjs still asserts them identical.
// The constant keeps its RILEY_ name deliberately — renaming an exported symbol across four
// files is a refactor with no behavioural payoff, and the freeze is about behaviour.
//
// ★ RILEY IS FROZEN. The demo line (see .terminal-claims for the current number; the one named
// in this comment is dead) is live, a canary proves
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

// ★ MEASURED, NOT IMAGINED (2026-08-14). A full conversation was run through the real agent with
// the booking tool MOCKED by the vendor's simulator, which answers every tool with the two words
// "Tool Called." The model read that, and said: "You're all set, Marcus. I have you booked for
// Tuesday at eight in the morning." Nothing had been booked. Nothing had even been attempted.
//
// That is the single most damaging sentence this product can produce, and no floor stood under it,
// because every floor here reads only the WORDS and this one is about a FACT: has a booking
// actually been confirmed in this conversation. So this floor takes the fact as an argument. It is
// off only when a tool answer has said the visit is on the schedule; the default, and the value on
// any code path that forgets to pass it, is ON.
//
// It deliberately does NOT catch the HOLD language the frozen spec requires ("I have you penciled
// in for Tuesday at eight"), because holding a window out loud before booking it is exactly what
// Riley is told to do. The line between them is the claim of completion, not the mention of a time.
const BOOKED_CLAIM_RE = /\b(?:you(?:'re| are)? all set\b|you(?:'re| are) (?:booked|scheduled|confirmed|locked in)\b|i(?:'ve| have) (?:got )?(?:you )?(?:booked|scheduled)\b|we(?:'ve| have) (?:got )?(?:you )?(?:booked|scheduled)\b|(?:it|that|the visit|the appointment)(?:'s| is| has been) (?:booked|scheduled|confirmed)\b|you(?:'re| are) on the (?:books|schedule)\b|(?:it|that)(?:'s| is) on the (?:books|schedule)\b)/i;

// ★ THIS FLOOR ENDS THE CALL (end: true), so it is the one regex on this estate where BOTH failure
// directions are expensive: a miss leaves somebody in a house with a hazard talking to a booking
// voice, and a false positive hangs up on a paying customer asking about a gas furnace. It is
// widened below, deliberately and narrowly, and `personas.test.mjs` tests both directions.
//
// ★ WHAT THE ORIGINAL MISSED, measured 2026-08-16 against 17 natural phrasings: 11 were not caught.
// Three distinct bugs, all of the same family - the pattern assumed one word order and one adjacency:
//   1. WORD ORDER. "smell(s|ing) (like )?gas" catches "I smell gas" but NOT "there is a gas smell",
//      which is how people more often say it. Now matched both ways.
//   2. ADJACENCY. "water (pouring|gushing)" requires the two words to touch, so "water IS pouring
//      through the ceiling" fell straight through to the booking voice. An optional copula now sits
//      between, here and in the smoke pattern.
//   3. ABSENT ENTIRELY. Rotten eggs and a sulfur smell are how a gas leak is usually DESCRIBED by
//      somebody who has not concluded it is gas. A burning smell and an electric shock were nowhere.
//
// ★ AND WHAT IS DELIBERATELY STILL NARROW, because widening it hangs up on customers:
//   - "smoke" is never matched bare. A smoke detector someone wants INSTALLED is routine work, and
//     "smoke detector in the hallway" must not end the call. Smoke only counts when it is moving
//     (coming, pouring, filling) or located ("smoke in the utility room").
//   - Sparks require an electrical noun nearby, in either word order. A bare /spark/ matches a pilot
//     light sparking when it lights, which is a furnace working correctly.
//   - "flooding" stays qualified. A yard that floods when it rains is a job, not an evacuation.
const CRISIS_RE = new RegExp('\\b(?:' + [
  // Gas, in both word orders, plus the two smells people report INSTEAD of saying the word gas.
  'gas leak', 'leaking gas', 'gas smell', 'smell(?:s|ing|ed)? (?:like )?gas', 'smell of gas',
  'rotten eggs?', 'sulfur smell', 'smells? like sulfur',
  // Carbon monoxide. The alarm IS the evidence and never needs confirming.
  'carbon monoxide', 'co (?:alarm|detector)',
  // Fire.
  'on fire', 'house fire', 'fire in (?:the|my)',
  // Smoke, only when moving or located. Never bare (see the smoke-detector note above).
  'smoke (?:is |was |keeps )?(?:coming|pouring|filling|everywhere)', 'smoke in (?:the|my)',
  // Burning. A burning smell from wiring is the call that must not be booked for Tuesday.
  'burning smell', 'smells? (?:like )?(?:something )?burning', 'something(?:s| is)? burning',
  // Electrical, requiring an electrical noun so a sparking pilot light stays a routine call.
  '(?:outlet|panel|breaker|wir(?:e|ing)|socket|fuse box)[^.!?]{0,24}spark(?:s|ed|ing)',
  'spark(?:s|ed|ing)[^.!?]{0,24}(?:outlet|panel|breaker|wir(?:e|ing)|socket|fuse box)',
  'spark(?:s|ing)? (?:from|out of|in the)', 'shocked me', 'electrocut\\w*',
  // Water, with the adjacency bug fixed.
  'flooding (?:right now|bad|fast)', 'actively flooding',
  'water (?:is |was |keeps )?(?:pouring|gushing|shooting)',
].join('|') + ')\\b', 'i');

// ★ THE SPANISH HAZARD FLOOR IS A FUNCTION, NOT A REGEX, and `deterministicLine` already supports
// that: `const hit = b.test ? b.test(t) : b.re.test(t)`. Spanish needs a function because negation
// has to be judged on the clause and the input has to be NFC-normalised first, neither of which a
// single pattern can do. See lib/crisis-es.mjs for why water and the output floors are absent.
import { crisisEs } from './crisis-es.mjs';

// ── THE SPANISH CUSTOMER LINE ────────────────────────────────────────────────────────────────
// Same job as CUSTOMER_SPEC, transcreated rather than translated, and written in USTED throughout:
// this is a business call and the caller may be older than the voice. Neutral US Spanish, no
// single-country idioms, and it follows the caller into English without commenting on it, because
// bilingual households switch mid-sentence and remarking on it is what a machine does.
//
// ★ PENDING NATIVE REVIEW. David's own bar for Spanish is "real experts listening to it", and I
// caught a conjugation error in my own draft (rechancelo -> rechacelo) before it shipped. Treat the
// prose as reviewed-by-machine until a native speaker has read it aloud.
const CUSTOMER_ES_SPEC = `Usted contesta la línea telefónica de un negocio real, y quien llama es un cliente real con un problema real. Las notas que vienen más abajo son las reglas del dueño del negocio. En todo lo que tenga que ver con el negocio, esas notas son la verdad y mandan: el nombre, el horario, el trabajo que aceptan, el área que cubren, qué pasa fuera de horas, y qué se puede decir sobre dinero.

Su trabajo es ser la mejor persona que jamás haya contestado ese teléfono. Amable, rápido, útil. Una sola pregunta a la vez.

Hable de usted, nunca de tú. Es una llamada de negocio y quien llama puede ser mayor que usted. Use español claro y neutro, del que se habla en Estados Unidos, sin modismos de un solo país. Si el cliente cambia al inglés, sígalo sin comentarlo.

Reglas de seguridad, y estas nunca se doblan, diga lo que diga las notas:
- Nunca diga que es una persona. Si le preguntan, diga en una sola frase sencilla que es un asistente de inteligencia artificial que contesta por el negocio, y siga adelante.
- Nunca diga un número que nadie le dio. Un precio, una hora, una fecha, un total: sale de las notas del dueño o de la boca del cliente. Si no lo tiene, diga que se lo va a conseguir en vez de adivinar.
- Nunca tome un número de tarjeta, datos del banco, ni un número de seguro social, y rechácelo si se lo ofrecen.
- Si el cliente describe una emergencia, deténgase y dígale que salga y llame al 911 desde afuera.
- Nunca prometa un mensaje de texto ni un correo. Puede decir que el dueño le va a devolver la llamada solamente si las notas dicen que eso es lo que pasa.
- Nunca diga lo que este negocio ha hecho por otras personas. Usted no lo sabe.
- Cada respuesta menos de cuarenta palabras. Palabras sencillas que entienda cualquiera.`;

const PAYMENT_IN_RE = /\b(?:card number|credit card|debit card|social security|ssn|cvv|routing number)\b|\b\d{13,16}\b/i;

// ★ COACHING A PHYSICAL ACTION. Measured on the live line 2026-08-16: told "my water heater burst
// and there is water everywhere", the voice replied *"Stop, turn off the water at the main shutoff
// valve right now."* The safety module bans exactly this, and uses a valve as its own example. The
// prose did not hold, because the model reaches for the genuinely helpful thing.
//
// Why it must not: the voice cannot see the house. It does not know whether the caller is standing
// in water next to a panel, whether the valve is seized, whether there is a ladder involved, or
// whether the person is physically able. Recognition and getting out of the way is the whole
// doctrine; a confident instruction is where a phone voice does real harm.
//
// ★ NOT MATCHED, deliberately: the caller's own report ("I turned off the water already") and the
// voice ASKING ("is the water off?"). Floors run on what the voice SAYS, and asking is not coaching.
// The pattern requires an imperative or a "you need to" aimed at a control.
const COACH_ACTION_RE = new RegExp('(?:' + [
  // imperative or directive, then a control, within a short window
  "\\b(?:turn|shut|switch|cut|kill|flip|trip|close|open)\\s+(?:it\\s+|that\\s+|the\\s+|your\\s+)?(?:off|on|down)?\\s*(?:the\\s+|your\\s+)?(?:water|gas|main|valve|breaker|panel|power|electric\\w*|shutoff|shut-off|supply|line)",
  "\\byou (?:need to|should|have to|want to|can) (?:turn|shut|switch|cut|kill|flip|unplug|reset|open|close)\\b",
  "\\b(?:go|head)\\s+(?:and\\s+)?(?:turn|shut|switch|check|open|close)\\b",
  "\\bunplug\\s+(?:it|the|your)\\b",
  "\\breset\\s+(?:the\\s+|your\\s+)?(?:breaker|panel|switch)\\b",
  "\\bopen\\s+(?:a\\s+|the\\s+|your\\s+)?window",
  "\\blight\\s+(?:the\\s+|a\\s+)?(?:pilot|match)",
].join('|') + ')', 'i');

// ★ A TIME NOBODY GAVE US. Measured the same night: "we can get someone out today" and "we'll get
// someone out today" on notes that carry business hours and nothing about same-day service. Two of
// five test calls. The scheduling module bans it in plain words and the model said it anyway.
//
// A promised day is the single most load-bearing thing a caller remembers, and it is the owner's to
// promise, not ours. This floor is unconditional on the customer line because there is no notes flag
// that could authorise it generically: a business that really does same-day says so in its own notes
// and the voice can quote them, which the numeral and money floors already allow for.
//
// NOT MATCHED: the caller's own words, and a question ("are you free today?"). Same reason as above.
const TIME_PROMISE_RE = new RegExp('\\b(?:' + [
  "(?:we|i|someone|somebody|a tech\\w*|the tech\\w*)(?:'ll| will| can| could| should)?\\s+(?:get|have|send|be)\\s+(?:someone|somebody|a tech\\w*|him|out|there)?[^.!?]{0,24}\\b(?:today|tomorrow|this (?:morning|afternoon|evening)|tonight|right away|first thing|within the hour|shortly)",
  "\\bout (?:there )?(?:today|tomorrow|this (?:morning|afternoon)|tonight|right away|shortly|first thing)\\b",
  "\\bcome (?:out )?(?:today|tomorrow|tonight|right away|first thing)\\b",
].join('|') + ')', 'i');

// A promise that a HUMAN will ring the caller. Distinct from CONTACT_MSG_RE, which is about a text
// or an email, and which measurably does not catch any of these.
//
// ★ WHAT IS DELIBERATELY NOT HERE, because the voice must still be able to do its actual job:
//   - "I'll put your details in front of the owner"  - a note, not a promise about anyone's action
//   - "I've written that down for the owner"          - past tense, about the voice's own act
//   - "the owner handles that"                        - a statement of fact from the notes
// The pattern needs a FUTURE-TENSE commitment that a person will make contact. A caller ASKING
// "will someone call me back?" is untouched: floors run on what the voice says, never the caller.
const CALLBACK_PROMISE_RE = new RegExp('\\b(?:' + [
  // First person arranging it. The leading pronoun is OPTIONAL: the phrasing that slipped through
  // the first version of this pattern was "...and have them call you with a number", lifted straight
  // out of a drafted knowledge module, where the subject is carried by an earlier clause. A promise
  // does not stop being a promise because it is the second half of a sentence.
  "(?:i(?:'ll| will| can| am going to| am gonna)?\\s+)?(?:have|get|ask)\\s+(?:them|him|her|someone|somebody|the owner|the tech\\w*)\\s+(?:to\\s+)?(?:call|ring|phone|get back)",
  // third person doing it
  "(?:they|he|she|someone|somebody|the owner|the tech\\w*|a tech\\w*)(?:'ll| will| is going to| are going to| can)\\s+(?:call|ring|phone)\\b",
  "(?:they|he|she|someone|somebody|the owner)(?:'ll| will| is going to| are going to)\\s+get back to you",
  // bare future commitments people actually say
  "(?:you(?:'ll| will) (?:get|receive) a call)",
  "(?:expect a call)", "(?:we(?:'ll| will) call you)", "(?:i(?:'ll| will) call you)",
  // ★ THE NOUN-PHRASE FORM, added after a live measurement. Asked "can someone call me back", the
  // voice replied "a few quick things so we can get you the right callback" on notes that authorise
  // no callback at all. The floor missed it because "callback" there is a NOUN, not a promise verb:
  // nobody is stated to be calling, and yet the caller hangs up certain that somebody will. An
  // implication the notes do not support costs exactly what a promise costs, because the customer
  // cannot tell the difference. Grammar is not the thing being regulated; the expectation is.
  // The trailing lookahead keeps "callback NUMBER" out of it: asking for the number to reach
  // somebody on is a field, not a promise that anyone will dial it.
  "(?:get|getting|set|setting|line|lining)\\s+(?:you\\s+)?(?:up\\s+)?(?:with\\s+)?(?:a|the|your)\\s+(?:right\\s+|quick\\s+)?call\\s?back(?!\\s*(?:number|line|time|info))",
  "(?:arrange|schedule|organis|organiz)\\w*\\s+(?:a|the|your)\\s+call\\s?back(?!\\s*(?:number|line|time|info))",
].join('|') + ')', 'i');

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
// ★ THIS WAS A SUBSTRING TEST AND IT LET INVENTED PRICES THROUGH ON THE LIVE LINE.
//
// The last line used to read `if (ctxDigits && ctxDigits.includes(d)) continue;`, where ctxDigits
// was every digit the caller had uttered CONCATENATED WITH NO SEPARATORS. So the question it asked
// was "does this number appear somewhere in the digit soup", not "did the caller say this number".
//
// After a caller says "my number is 916 350 4869 and my zip is 97204", the soup is
// "916350486997204", and six of these seven inventions passed, each spoken to the caller as fact:
//     $350 a month · 16 openings · 35 dollars · 4869 days · 6350 jobs · $9,163      ALLOWED
//     $742 a month                                                                 blocked
// The guard was weakest exactly when a caller had given a phone number, which on an inbound line is
// nearly always. Found and reproduced by @ANSWERED-INTEL; the reproduction reads this file directly
// so it cannot drift from what ships (research/numeral-firewall.test.mjs).
//
// The fix is a SHAPE change, not a tuning change: the context is now a SET and this is a MEMBERSHIP
// test. Substring matching cannot be made safe by widening or narrowing it.
//
// ★ WHAT IT STILL DOES NOT SOLVE, said plainly rather than left implied: a digit-run the caller
// genuinely spoke is still allowed in any role. "$350 a month" survives, because the caller really
// did say "350" — as part of their phone number. Distinguishing a price from a phone fragment needs
// semantic role, which this guard does not have. It closes four of the six holes; the remaining two
// need the money-word path or a grounded-figures allowlist.
// ── PROVENANCE, ADDED 2026-08-18. THE HOLE THE COMMENT ABOVE SAID WAS STILL OPEN. ────────────
//
// The paragraph above ends "the remaining two need the money-word path or a grounded-figures
// allowlist", and it was right that the shape change alone did not close them. @LANE-FOOTER then
// measured it live on the shipped guard, with positive controls:
//
//   "My water heater is leaking"  ->  "The visit is 350."   BLOCKED
//   "My number is 916 350 4869"   ->  "The visit is 350."   ALLOWED, spoken as fact
//
// Giving a callback number is the single most common thing a caller does, so the guard was weakest
// on almost every real call, and `/trust` says in its own words: "The guardrail that matters most.
// It will never quote a price." That sentence was false.
//
// ★ THE FIX IS SEMANTIC ROLE, WHICH IS EXACTLY WHAT THE COMMENT ASKED FOR, AND IT IS TWO IDEAS:
//
// 1. WHO SAID IT. A number the OWNER wrote in the notes may be quoted as a fact about the business.
//    A number the CALLER said may be READ BACK and nothing else. Previously both landed in one set
//    and the guard could not tell a price from a phone fragment because it never knew where either
//    came from. Now the context carries its provenance.
//
// 2. WHAT ROLE THE NUMBER IS PLAYING IN THIS CLAUSE. In a price-shaped clause only the owner's
//    figures are admissible; everywhere else the caller's own numbers still pass, so read-backs,
//    addresses, times and quantities are untouched.
//
// Direction of failure: a clause we cannot classify is treated as ordinary, NOT as a price — but
// the money-word path is owner-only unconditionally, so a spelled price cannot ride in on that.
// riley has no owner notes at all, so for the demo line this reduces to "never says a price",
// which is what the site promises.

/** A clause where a bare figure would be heard as what something COSTS. */
const PRICE_SHAPED = new RegExp(
  // an explicit currency marker is always price-shaped
  '\\$|\\b(?:dollars?|bucks|cents)\\b'
  // ...or a cost noun/verb anywhere in the clause, which is what "The visit is 350" has and
  // PRICE_RE did not look for. Deliberately a closed list of COST words rather than any copula:
  // "it is 350" with no cost word stays ordinary, because that is usually a read-back.
  + '|\\b(?:price[sd]?|pricing|cost[s]?|charge[sd]?|fee[s]?|rate[s]?|quote[sd]?|estimate[sd]?|'
  + 'deposit|minimum|invoice|bill|billed|labou?r|hourly|flat|upfront|up front|'
  + 'visit|trip|call-?out|service call|diagnostic|per hour|an hour|a month|a year|a visit)\\b',
  'i',
);

/**
 * Normalise a context into { caller, owner }.
 * A bare Set is the legacy shape and is treated as CALLER-supplied, which is the safe reading:
 * it means a persona that has not been split cannot accidentally license a price.
 */
function provenance(ctx) {
  if (ctx && !(ctx instanceof Set) && (ctx.caller || ctx.owner)) {
    return { caller: ctx.caller || new Set(), owner: ctx.owner || new Set() };
  }
  if (ctx instanceof Set) return { caller: ctx, owner: new Set() };
  // A string context is the oldest shape of all. Keep it working, keep it caller-only.
  const s = new Set(String(ctx || '').match(/\d+/g) || []);
  return { caller: s, owner: new Set() };
}

function badNumeral(text, ctx, allow) {
  const { caller, owner } = provenance(ctx);
  // ★ THE ROLE TEST. In a price-shaped clause a caller-supplied digit is NOT a licence: the caller
  // saying "916 350 4869" does not authorise "the visit is 350". Everywhere else the caller's own
  // numbers still pass, which is what keeps read-backs, addresses, times and counts working.
  const priceShaped = PRICE_SHAPED.test(String(text));
  const has = priceShaped ? (d) => owner.has(d) : (d) => caller.has(d) || owner.has(d);
  const toks = String(text).match(/\d[\d:.,-]*/g) || [];
  for (const t of toks) {
    const d = t.replace(/\D+/g, '');
    if (!d) continue;
    if (allow.has(d)) continue;
    if (has(d)) continue;
    return t;
  }
  return null;
}

/**
 * Every number the caller actually SAID, as a set of exact tokens — plus the concatenations of
 * CONSECUTIVE tokens, so reading a phone number back as one string is still a read-back rather than
 * an invention. That is the one widening that is honest: "916 350 4869" -> "9163504869" is the same
 * number the caller gave. An arbitrary substring spanning unrelated numbers is not.
 */
function numberSet(texts) {
  const ctx = new Set();
  for (const t of texts) {
    const toks = (String(t).match(/\d[\d:.,-]*/g) || [])
      .map((x) => x.replace(/\D+/g, '')).filter(Boolean);
    for (let i = 0; i < toks.length; i += 1) {
      let run = '';
      // Bounded: a phone number is at most a few tokens. An unbounded join would rebuild the soup.
      for (let j = i; j < Math.min(i + 5, toks.length); j += 1) { run += toks[j]; ctx.add(run); }
    }
  }
  return ctx;
}

// Riley's context is the caller's raw digits, exactly as it always was.
// Now a SET of exact tokens (plus consecutive-run concatenations), not a digit soup.
const rawDigits = (texts) => numberSet(texts);

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
// Union of the digits the caller typed/spoke and the numbers they spelled out in words.
const digitsPlusSpoken = (texts) => new Set([...numberSet(texts), ...numberSet([spokenDigits(texts)])]);

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

function badMoneyWords(text, ctx, allow) {
  // The SECOND consumer of the context, and it had the identical substring bug. Fixing badNumeral
  // alone would have left a spelled price ("three fifty dollars") still tested against the digit
  // soup — and worse, once the context became a Set this line threw `ctxDigits.includes is not a
  // function`, which the money-word floor would have surfaced as a crash rather than a refusal.
  // Two call sites, one contract: membership, with the string form kept working for safety.
  // ★ OWNER-ONLY, NO ROLE TEST NEEDED. A figure sitting next to "dollars" is a price by
  // construction, so there is no non-price reading to protect. A caller saying "three fifty" never
  // licenses the voice to say "three fifty dollars" as the business's price.
  const { owner } = provenance(ctx);
  const has = (d) => owner.has(d);
  MONEY_WORD.lastIndex = 0; // the pattern carries /g; never trust its cursor
  let m;
  while ((m = MONEY_WORD.exec(String(text))) !== null) {
    const d = String(composeNumberWords(m[1]));
    if (d === '0') continue;
    if (allow.has(d)) continue;
    if (has(d)) continue;
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
export const RILEY_SPEC_FROZEN = `You are Thomas, the receptionist on the Answered demo line. You answer as Cedar Ridge Plumbing and Air, a clearly fictional demo shop. The caller is usually a contractor testing the product, so give them the real experience: warm, quick, useful.

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
// ── THE CRAFT FLOORS (added 2026-08-16) ───────────────────────────────────────
//
// Everything above this block stops the voice saying something FALSE or UNSAFE. These four stop it
// sounding like a machine, which is a different failure and until now an unguarded one.
//
// ★ SOURCE: knowledge/19-communication-brain/15-phone-close-doctrine.md, which David made binding
// estate-wide on 07-20 and which states in terms that it governs "voice-agent close behavior". Its
// consolidated ban list is a craft codex, not a compliance list, and these are the four items on it
// that a language model actually reproduces on its own. The rest of that list is either already a
// floor above (price, payment, AI denial, guarantees) or is Reddenda-healthcare-specific and does
// not apply to a contractor line.
//
// ★ WHY THESE FOUR AND NOT THE WHOLE LIST. Each of these is a thing an LLM does by default, on its
// own, with no prompting: it pads, it stacks questions, it invents shared history to sound warm,
// and it reaches for the sales register. A floor is only worth its evaluation cost if the model
// would otherwise trip it.

// A live answer past ~40 words stops being an answer and becomes a monologue. The doctrine's number.
// Counted on the SPOKEN text, so a long address or a read-back is not punished: those are content.
const MONOLOGUE_WORDS = 40;

// Two question marks in one turn is a stacked question, and a person answers only the last one.
const STACKED_Q_RE = /\?[^?]*\?/;

// Fake familiarity: a warmth an LLM invents because it reads as friendly. It is the fastest way to
// be caught out, because the other person knows whether you called them before and you do not.
const FAKE_FAMILIAR_RE = /\b(?:just (?:checking in|touching base|following up)|touching base|returning your call|as (?:we|i) discussed|(?:like|as) (?:we|i) talked about|good to (?:hear from|talk to) you again|thanks for (?:getting back|reaching back))\b/i;

// The sales register. Saying any of these TO the person is the doctrine's own line, and "solutions"
// or "partnership opportunity" out of a receptionist's mouth is an instant tell.
// ★ NO TRAILING \b ON THIS ONE, AND NO LOOKAHEAD. Both were bugs caught by the test:
// a trailing \b after "partnership opportunit" can never match, because the next character is the
// "y" of "opportunity" and that is a word character, so the boundary fails on the exact word it
// was written for. And `solutions?\b(?! for)` was meant to spare "solutions for X" and instead
// spared the commonest form of the tell, "we have solutions for that". Leading \b only.
const SALES_REGISTER_RE = /\b(?:solutions?|partnership opportunit|revenue cycle|value proposition|circle back|reach out to you|leverage (?:our|the)|best in class|cutting edge|game.?chang|synerg)/i;

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
      // FIRST, because a false booking is the worst thing this voice can say. The five frozen
      // floors keep their order relative to each other underneath it.
      { by: 'unbooked-claim', re: BOOKED_CLAIM_RE, unlessBooked: true, pivot: 'Hold on, I do not have that written down yet, so nothing is booked. Let me sort that out for you.' },
      { by: 'price', re: PRICE_RE, pivot: 'The office quotes prices, I only book the visit. Want me to grab you a window?' },
      { by: 'contact-promise', re: CONTACT_RE, pivot: "I handle the whole thing right here on the call, so let's just knock it out now." },
      { by: 'ai-denial', re: AI_DENY_RE, pivot: "To be straight with you, I'm an AI receptionist on the Answered demo line. Now, where were we with that visit?" },
      { by: 'payment', re: PAYMENT_OUT_RE, pivot: 'No payment talk on this line. A name, an address, and a good number books the visit.' },
      { by: 'slot-invention', re: DAY_RE, pivot: "Here's what I have: Tuesday at eight in the morning, Tuesday at one thirty, or Wednesday at nine. Which one works?" },
      { by: 'numeral', numeral: true, pivot: "Here's what I have: Tuesday at eight in the morning, Tuesday at one thirty, or Wednesday at nine. Which one works?" },
    ],
    inBranches: [
      { by: 'crisis', re: CRISIS_RE, end: true, line: "That's an emergency, not a booking. Get everyone outside first, then call 911 or the gas company from outside. We can talk once you're safe." },
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
      // ── craft floors: these stop it sounding like a machine, not saying something false.
      // They run LAST, after every safety floor, because a true-but-padded answer is a smaller
      // problem than a false one and must never pre-empt it.
      { by: 'monologue', maxWords: MONOLOGUE_WORDS, pivot: 'Let me keep that short. What matters is the next step, so tell me where you want to go from here.' },
      { by: 'stacked-question', re: STACKED_Q_RE, pivot: 'Let me ask one thing at a time. Go ahead with that first one.' },
      { by: 'fake-familiarity', re: FAKE_FAMILIAR_RE, pivot: 'This is the first time we have spoken, so let me start clean.' },
      { by: 'sales-register', re: SALES_REGISTER_RE, pivot: 'Plain words are better. Here is the practical version.' },
    ],
    inBranches: [
      { by: 'crisis', re: CRISIS_RE, end: true, line: 'That sounds like an emergency and I am only a research call. Get outside, then call 911 from outside. I am getting off the line.' },
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
      // ── craft floors: these stop it sounding like a machine, not saying something false.
      // They run LAST, after every safety floor, because a true-but-padded answer is a smaller
      // problem than a false one and must never pre-empt it.
      { by: 'monologue', maxWords: MONOLOGUE_WORDS, pivot: 'Let me keep that short. What matters is the next step, so tell me where you want to go from here.' },
      { by: 'stacked-question', re: STACKED_Q_RE, pivot: 'Let me ask one thing at a time. Go ahead with that first one.' },
      { by: 'fake-familiarity', re: FAKE_FAMILIAR_RE, pivot: 'This is the first time we have spoken, so let me start clean.' },
      { by: 'sales-register', re: SALES_REGISTER_RE, pivot: 'Plain words are better. Here is the practical version.' },
    ],
    inBranches: [
      { by: 'crisis', re: CRISIS_RE, end: true, line: 'That sounds like an emergency and this is only a setup call. Get outside, then call 911 from outside. I am getting off the line.' },
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
    // ★ SPLIT BY PROVENANCE 2026-08-18. This used to merge the caller's digits and the owner's
    // notes into ONE set, which is precisely how "the visit is 350" rode in on a caller's phone
    // number. The owner's figures are quotable as facts about the business; the caller's are
    // read-back-only. Same two sets, and now the guard can tell them apart.
    ctx: (texts, systemText) => ({
      caller: digitsPlusSpoken(texts),
      owner: digitsPlusSpoken([String(systemText || '')]),
    }),
    numAllow: new Set(['911']),
    ackBank: ['Okay.', 'Sure.', 'Alright.', 'Got it.', 'Mm-hm.'],
    breaker: 'Sorry, my line just glitched for a second. Are you still there?',
    closeLine: 'I have got everything I need written down. Thanks for calling, and somebody will be in touch.',
    outFloors: [
      { by: 'ai-denial', re: AI_DENY_RE, pivot: 'To be straight with you, I am an AI assistant answering this line. What can I get done for you?' },
      { by: 'payment', re: PAYMENT_OUT_RE, pivot: 'I never take card or account numbers on this line. Let me get your name and a good number instead.' },
      { by: 'message-promise', re: CONTACT_MSG_RE, pivot: 'I am not going to promise you a message. Let me take your number down and get this to the right person.' },
      // ★ THE CALLBACK PROMISE. Added 2026-08-16 after six independently written knowledge modules
      // were reviewed and FIVE of them broke this rule, in eleven separate places. That is not five
      // mistakes, it is one rule with nothing enforcing it: "I'll have them call you back" is the
      // humane thing to say, it is what a good human receptionist says, and the model reaches for it
      // exactly as a person would. CONTACT_MSG_RE never caught it — measured, it passes "I will have
      // them call you back", "someone will call you back today" and "they will get back to you
      // shortly", while catching text, email and "reach out".
      //
      // ★ IT IS CONDITIONAL, NOT ABSOLUTE, because the persona rule is conditional: the voice MAY
      // say the owner will call back WHEN THE OWNER'S NOTES SAY THAT IS WHAT HAPPENS. So this floor
      // is skipped only when the notes actually authorize it (`state.callbackOk`), and with no state
      // it runs at full strength. A blanket ban would make the voice worse on every business that
      // does call people back, which is most of them.
      { by: 'callback-promise', re: CALLBACK_PROMISE_RE, unlessCallbackOk: true, pivot: 'I do not want to promise you a call I cannot promise. Let me take your number and put this in front of the owner.' },
      // Both added 2026-08-16 after live measurement, not after review. See the notes on each regex.
      { by: 'coach-action', re: COACH_ACTION_RE, notQuestion: true, pivot: 'I am not going to talk you through anything hands on, because I cannot see what you are looking at. Tell me what is happening and I will get it to somebody who can.' },
      { by: 'time-promise', re: TIME_PROMISE_RE, notQuestion: true, pivot: 'I do not want to put a time on it that nobody can keep. Let me get the details down so the owner can tell you honestly.' },
      { by: 'claim', re: CLAIM_RE, pivot: 'I would not want to speak for other jobs. Let me get yours written down properly.' },
      { by: 'money-invention', money: true, pivot: 'I do not want to guess a price on you. Let me get your details down and have somebody confirm it.' },
      { by: 'numeral', numeral: true, pivot: 'I do not want to give you a number I am not sure of. Let me take your details and get it confirmed.' },
      // ── craft floors: these stop it sounding like a machine, not saying something false.
      // They run LAST, after every safety floor, because a true-but-padded answer is a smaller
      // problem than a false one and must never pre-empt it.
      { by: 'monologue', maxWords: MONOLOGUE_WORDS, pivot: 'Let me keep that short. What matters is the next step, so tell me where you want to go from here.' },
      { by: 'stacked-question', re: STACKED_Q_RE, pivot: 'Let me ask one thing at a time. Go ahead with that first one.' },
      { by: 'fake-familiarity', re: FAKE_FAMILIAR_RE, pivot: 'This is the first time we have spoken, so let me start clean.' },
      { by: 'sales-register', re: SALES_REGISTER_RE, pivot: 'Plain words are better. Here is the practical version.' },
    ],
    inBranches: [
      { by: 'crisis', re: CRISIS_RE, end: true, line: 'That is an emergency, not a service call. Get everyone out of the building now. Once you are outside, call 911 or the gas company. Go.' },
      { by: 'payment-offered', re: PAYMENT_IN_RE, line: 'Please do not read that out. I never take card or account numbers, and nothing here needs one.' },
      { by: 'ai-asked', test: (t) => askedIfAI(t) || AI_ASKED_RE.test(t), line: 'I am an AI assistant answering this line. Now, what is going on at your place?' },
      { by: 'abuse', test: isAbusive, line: 'I hear you, and I am still here. We can keep working on it, or I can take a message, your call.' },
    ],
  },

  // ── THE SPANISH CUSTOMER LINE ──────────────────────────────────────────────────────────────
  // A separate persona, not a flag on `customer`. The floors, the spec and the deterministic lines
  // are all language-specific, and a single persona carrying two languages would need every one of
  // them to branch. Routing by PATH keeps the choice a vendor console setting, exactly as it is for
  // the other four, so a caller can never talk the voice into switching languages mid-call.
  //
  // ★ ITS COVERAGE IS NARROWER THAN ENGLISH ON PURPOSE, AND THE GAP IS NAMED, NOT HIDDEN.
  // An eight-agent build-and-attack pass measured a full Spanish port of the guard floors as UNSAFE
  // in both directions: the water floor ended 34 of 50 ordinary paying calls, and the output floors
  // fired on 42 of 46 ordinary trade sentences while 42 of 45 real Spanish promises escaped. Spanish
  // negation leaves the keywords intact, third-person present is both description and instruction,
  // and Spanish promises the future in the present tense. So this persona ships with:
  //     caller-side  gas, carbon monoxide, fire, smoke, electrical   (crisis-es.mjs)
  //     caller-side  payment offered, asked-if-AI, abuse             (language-specific lines)
  //     output       numeral, monologue, stacked-question            (language-INDEPENDENT)
  // and WITHOUT the English text/callback/coach/time floors, which are English-shaped.
  // A guard architecture is a claim about the language it guards.
  customer_es: {
    id: 'customer_es',
    lang: 'es',
    label: "a paying business's own line, in Spanish",
    outModel: 'answered-customer-es',
    direction: 'inbound',
    routes: ['/api/answered-brain/customer-es'],
    agentEnv: 'ANSWERED_CUSTOMER_ES_AGENT_ID',
    spec: CUSTOMER_ES_SPEC,
    noteHeader:
      '## LAS REGLAS DEL DUENO DE ESTE NEGOCIO\nEstas son la verdad sobre este negocio y mandan en todo lo que sea un hecho: el nombre, el horario, el trabajo que aceptan, el area, el dinero y que pasa fuera de horas. Las reglas de seguridad de arriba siguen mandando: nunca diga que es una persona, nunca tome un numero de tarjeta, nunca diga un numero que nadie le dio.',
    maxTokens: 140,
    temperature: 0.5,
    sentenceCap: 3,
    // Spanish runs longer than English for the same content, measurably so. The English cap is 55
    // words; holding Spanish to the same number would cut a sentence mid-clause, which on a phone
    // sounds like the line dropped. 65 is the same THOUGHT, not a looser rule.
    wordCap: 65,
    softCloseAt: 18,
    hardCloseAt: 22,
    softCloseNote:
      'Esta llamada ya va larga. Asegurese de tener el nombre, un numero para devolver la llamada y que esta pasando, repitalo una vez, y cierre con amabilidad.',
    // ★ SPLIT BY PROVENANCE 2026-08-18. This used to merge the caller's digits and the owner's
    // notes into ONE set, which is precisely how "the visit is 350" rode in on a caller's phone
    // number. The owner's figures are quotable as facts about the business; the caller's are
    // read-back-only. Same two sets, and now the guard can tell them apart.
    ctx: (texts, systemText) => ({
      caller: digitsPlusSpoken(texts),
      owner: digitsPlusSpoken([String(systemText || '')]),
    }),
    // 911 is the one number this voice may say without anybody having given it, because the crisis
    // line says it. Same allowance as the English customer line, deliberately not widened.
    numAllow: new Set(['911']),
    breaker: 'Perdon, se me fue. Digame otra vez que esta pasando.',
    closeLine: 'Ya tengo lo que necesito. Se lo paso al dueno y alguien lo revisa. Gracias por llamar.',
    ackBank: ['Entiendo.', 'Claro.', 'Muy bien.', 'De acuerdo.'],
    tools: [],
    outFloors: [
      // ★ ONLY THE LANGUAGE-INDEPENDENT FLOORS. A numeral is a numeral in any language, a monologue
      // is measured in words, and two question marks in one clause is two questions anywhere. The
      // English text/callback/coach/time floors are NOT here: they are English-shaped and porting
      // them measured UNSAFE. Their absence is the honest state, not an oversight.
      { by: 'numeral', numeral: true, pivot: 'No quiero adivinarle un numero. Deme sus datos y el dueno le confirma.' },
      { by: 'money-invention', money: true, pivot: 'No quiero adivinarle un precio. Deme sus datos y el dueno le confirma.' },
      { by: 'monologue', maxWords: 65, pivot: 'Perdon, me extendi. Digame nomas que esta pasando.' },
      { by: 'stacked-question', re: /\?[^?]*\?/, pivot: 'Perdon, una pregunta a la vez. Digame que esta pasando.' },
    ],
    inBranches: [
      // ★ A FUNCTION, NOT A REGEX. Spanish needs NFC normalisation and clause-level negation before
      // any pattern is meaningful. deterministicLine already supports `test`.
      { by: 'crisis', test: (t) => crisisEs(t).hit, end: true,
        line: 'Eso es una emergencia, no una llamada de servicio. Salgan todos de la casa ahora. Ya que esten afuera, llame al 911 o a la compania del gas. Vaya.' },
      { by: 'payment-offered', re: PAYMENT_IN_RE,
        line: 'Por favor no me lo lea. Yo nunca tomo numeros de tarjeta ni de cuenta, y aqui no hace falta ninguno.' },
      { by: 'ai-asked', test: (t) => askedIfAI(t) || AI_ASKED_RE.test(t) || /\b(?:eres|es usted|estoy hablando con)\b[^.!?]{0,20}\b(?:un[ao]? )?(?:robot|maquina|m[aá]quina|computadora|grabaci[oó]n|persona real|humano)\b/i.test(t),
        line: 'Soy un asistente de inteligencia artificial que contesta esta linea. Digame, que esta pasando en su casa?' },
      { by: 'abuse', test: isAbusive,
        line: 'Lo escucho, y aqui sigo. Podemos seguir viendolo, o le tomo un recado, usted dice.' },
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

/**
 * One clause, one verdict. Deterministic, and it runs before a word streams.
 *
 * `state` carries facts the guard cannot read out of the text: today the only one is whether a
 * booking has actually been confirmed on this call. A floor marked `unlessBooked` is skipped only
 * when that is TRUE, so a caller that forgets to pass state gets the floor at full strength. The
 * failure direction is a pivot, never a claim.
 */
export function guardClause(persona, text, ctxDigits, state) {
  const booked = Boolean(state && state.booked);
  // ★ SECOND CONDITIONAL FACT, added 2026-08-16. Same shape and same failure direction as `booked`:
  // absent state means the floor runs at FULL STRENGTH, so a caller that forgets to pass it gets the
  // safe behaviour rather than the permissive one.
  const callbackOk = Boolean(state && state.callbackOk);
  for (const f of persona.outFloors) {
    if (f.unlessBooked && booked) continue;
    if (f.unlessCallbackOk && callbackOk) continue;
    if (f.numeral) {
      if (badNumeral(text, ctxDigits, persona.numAllow)) return { ok: false, by: f.by, pivot: f.pivot };
      continue;
    }
    if (f.money) {
      if (badMoneyWords(text, ctxDigits, persona.numAllow)) return { ok: false, by: f.by, pivot: f.pivot };
      continue;
    }
    // ★ A WORD CAP, NOT A REGEX. Length is the one tell you cannot pattern-match: the sentence is
    // grammatical, true, on-topic and still wrong, because nobody talks for forty words on a phone
    // without stopping. Counted on words rather than characters so a long street address, which is
    // content the caller needs, is not punished the way padding is.
    if (f.maxWords) {
      const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
      if (words > f.maxWords) return { ok: false, by: f.by, pivot: f.pivot };
      continue;
    }
    // ★ A QUESTION IS NOT AN INSTRUCTION. "Did you turn the water off?" and "Turn the water off"
    // share every word that matters, and only one of them is coaching. Floors that describe an ACT
    // the voice performs (coaching a physical action, promising a time) must not fire when the voice
    // is ASKING about it, which is a legitimate and often necessary thing to do. Caught by a test:
    // the first version of the coach-action floor refused "Did you turn the water off?".
    if (f.notQuestion && /\?\s*$/.test(String(text || '').trim())) continue;
    if (f.re.test(text)) return { ok: false, by: f.by, pivot: f.pivot };
  }
  return { ok: true };
}

/** The buffered path: guard a whole reply, clause by clause, and cap cadence. */
export function guardWhole(persona, text, ctxDigits, state) {
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
      const g = guardClause(persona, clause, ctxDigits, state);
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
