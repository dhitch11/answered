// hold-detect.mjs — is that a person, or is it the hold loop?
//
// THIS IS THE HARD PART OF HOLD AND IT IS DELIBERATELY PURE: no network, no clock, no database.
// Everything it decides, it decides from text and timestamps handed to it, so the whole thing can
// be measured against real transcripts in a test file instead of being believed.
//
// ── WHY NOT TWILIO AMD ───────────────────────────────────────────────────────────────────────
// Twilio's MachineDetection answers a different question: "did a person or an answering machine
// pick up the RING?". It runs once, in the first seconds, and then it is done. Hold is the
// opposite shape: the line was answered ninety minutes ago by a machine, and the event we care
// about is a HUMAN arriving in the middle of that. AMD cannot see it, and asking it to would give
// us a confident answer to a question nobody asked.
//
// ── WHY NOT A MEDIA STREAM ───────────────────────────────────────────────────────────────────
// The obvious engineering answer is a bidirectional WebSocket carrying raw audio into a music /
// speech classifier. This estate runs on Netlify Functions, which are request and response and
// cannot hold a socket open for two hours. A design that needs a server we do not have is not a
// design, it is a plan to build one.
//
// ── WHAT WE ACTUALLY USE, AND WHY IT IS HONEST ───────────────────────────────────────────────
// Twilio's real-time <Start><Transcription> delivers each utterance from the far end as an
// ordinary HTTP POST. That fits the runtime we have, and it gives three independent signals:
//
//   1. WHAT was said.        Hold systems and phone trees use a small, extremely stable
//                            vocabulary. "All of our representatives are currently assisting
//                            other callers" is not a sentence a person says.
//   2. WHETHER anything was said at all. Hold music transcribes to nothing, or to short junk.
//                            Silence is evidence, and it is evidence FOR the machine.
//   3. The SHAPE of the turn. A person says one short thing and then stops, waiting for a reply.
//                            A recording talks over you and never waits.
//
// A single utterance is never enough on its own, so the deterministic rules below only ever
// produce a CANDIDATE, and the state machine confirms it by speaking (see confirmPolicy). The
// confirmation is not a trick question: it is the legally required opening sentence, which we
// have to say to a human anyway. A recording does not answer it. A person does.
//
// ── THE FAILURE THIS MODULE IS BUILT AROUND ──────────────────────────────────────────────────
// The two mistakes are NOT symmetrical and the thresholds are asymmetric on purpose.
//   A false HUMAN rings the customer for nothing and speaks a disclosure into hold music. It
//   costs one interruption and it is recoverable inside the same session.
//   A false MACHINE leaves a real person listening to silence and then hanging up, after the
//   customer already waited two hours. It burns the errand and it is rude to a stranger.
// So an ambiguous read leans toward speaking up, and the state machine never charges for a
// session where nobody was actually connected.

export const FAR = Object.freeze({
  HUMAN: 'human',
  QUEUE: 'queue',
  IVR: 'ivr',
  VOICEMAIL: 'voicemail',
  UNKNOWN: 'unknown',
});

/** Everything matched is kept, so the receipt can show the words that produced the verdict. */
const hits = (text, table) => {
  const out = [];
  for (const [name, re] of table) {
    const m = re.exec(text);
    if (m) out.push({ marker: name, matched: m[0].slice(0, 120) });
  }
  return out;
};

// ── the machine vocabularies ─────────────────────────────────────────────────────────────────
// Written from the language these systems actually use. Every one of these is a phrase a person
// on a customer-service desk essentially never utters cold.

const IVR = [
  ['press_digit',        /\b(?:press|dial|enter|push)\s+(?:the\s+)?(?:number\s+)?(?:one|two|three|four|five|six|seven|eight|nine|zero|pound|star|hash|\d)\b/i],
  ['for_x_press',        /\b(?:for|to)\b[^.?!]{2,60}?\b(?:press|dial|say)\b/i],
  ['main_menu',          /\b(?:main|previous|this)\s+menu\b|\breturn(?:ing)?\s+to\s+the\s+menu\b/i],
  ['options_changed',    /\b(?:menu\s+)?options\s+have\s+(?:recently\s+)?changed\b|\blisten\s+carefully\b/i],
  ['extension',          /\bif\s+you\s+know\s+your\s+party'?s?\s+extension\b|\bdial\s+the\s+extension\b/i],
  ['say_or_enter',       /\b(?:say|speak)\s+or\s+(?:press|enter|dial)\b|\bplease\s+say\s+(?:your|the)\b/i],
  ['spanish',            /\bpara\s+(?:espa|continuar|ingl)|\boprima\b|\bmarque\b/i],
  ['repeat_menu',        /\bto\s+(?:repeat|hear)\s+(?:these|this|the)\s+(?:options|menu|again)\b/i],
  ['monitored',          /\b(?:this|your)\s+call\s+may\s+be\s+(?:monitored|recorded)\b/i],
  ['thank_you_calling',  /\bthank\s+you\s+for\s+calling\b/i],
];

const QUEUE = [
  ['agents_busy',        /\ball\s+(?:of\s+)?our\s+(?:agents|representatives|specialists|operators|associates|advisors|counselors)\s+are\s+(?:currently\s+)?(?:busy|assisting|helping|serving|on\s+other)/i],
  ['call_important',     /\byour\s+call\s+is\s+(?:very\s+)?important\s+to\s+us\b/i],
  ['estimated_wait',     /\b(?:estimated|approximate|current|expected)\s+wait(?:ing)?\s+time\b|\byour\s+wait\s+(?:time\s+)?is\b/i],
  ['please_hold',        /\bplease\s+(?:continue\s+to\s+)?hold\b|\bstay\s+on\s+the\s+line\b|\bremain\s+on\s+the\s+line\b/i],
  ['thanks_patience',    /\bthank\s+you\s+for\s+(?:your\s+)?(?:patience|continued\s+patience|holding)\b/i],
  ['queue_position',     /\byou\s+are\s+(?:now\s+)?(?:caller\s+)?number\s+\w+\s+in\s+(?:the\s+)?(?:queue|line)\b|\bcallers?\s+ahead\s+of\s+you\b/i],
  ['next_available',     /\bnext\s+available\s+(?:agent|representative|operator|specialist)\b/i],
  ['higher_than_normal', /\b(?:higher|longer)\s+than\s+(?:normal|usual|expected)\s+(?:call|wait)\b|\bexperiencing\s+(?:high|heavy)\s+(?:call\s+)?volume/i],
  ['do_not_hang_up',     /\bdo\s+not\s+hang\s+up\b|\byour\s+place\s+in\s+line\b/i],
];

const VOICEMAIL = [
  ['leave_message',      /\bleave\s+(?:a|your)\s+(?:message|name\s+and\s+number)\b/i],
  ['after_tone',         /\bafter\s+the\s+(?:tone|beep)\b|\bat\s+the\s+(?:tone|beep)\b/i],
  ['mailbox',            /\b(?:voice\s*)?mail\s*box\b|\bhas\s+been\s+forwarded\s+to\b/i],
  ['unavailable',        /\b(?:is|are)\s+(?:not\s+|un)available\s+(?:right\s+now|at\s+(?:the|this)\s+moment|to\s+take\s+your\s+call)\b/i],
];

// ★ THE GUARD THAT COST SIX FAILING ASSERTIONS TO FIND.
// "This is a recording", "This is the Department of Labor" and "This is an important message"
// are all six to eight words long, carry no queue vocabulary and no menu vocabulary, and the
// short-turn rule below happily called every one of them a person. A recording introducing
// ITSELF looks exactly like a person introducing themselves, and the only difference is the word
// after "this is". So the machine's way of naming itself is matched explicitly, and it is checked
// BEFORE any weak human rule gets a look.
const RECORDED_SELF = [
  ['impersonal_this_is', /\bthis\s+is\s+(?:a|an|the|your|our|not)\b/i],
  ['recorded_message',   /\brecorded\s+(?:message|announcement|line)\b|\bautomated\s+(?:message|call|system|attendant)\b/i],
  ['message_about',      /\b(?:important|urgent)\s+message\b|\bmessage\s+(?:regarding|about|concerning)\b/i],
];

const CLOSED = [
  ['closed',             /\b(?:we\s+are|our\s+office(?:s)?\s+(?:is|are))\s+(?:now\s+)?closed\b|\boutside\s+(?:of\s+)?(?:our\s+)?(?:normal\s+)?business\s+hours\b|\bcall\s+back\s+during\b/i],
  ['call_volume_full',   /\bdue\s+to\s+(?:extremely\s+)?high\s+call\s+volume[^.?!]{0,40}\b(?:cannot|can\s+not|unable)\b|\bplease\s+(?:try|call)\s+(?:your\s+call\s+)?again\s+later\b/i],
];

// ── the person ───────────────────────────────────────────────────────────────────────────────
// STRONG markers are ones a hold loop has no reason to contain. Each is a claim of personal
// presence, or an invitation to speak now.

const HUMAN_STRONG = [
  // "this is Denise", but never "this is a recording" / "this is the Department of..."
  ['self_named',         /\bthis\s+is\s+(?!a\b|an\b|the\b|your\b|our\b|not\b|recorded\b|recording\b|automated\b|important\b|urgent\b|regarding\b|about\b|just\b|still\b|why\b|how\b|what\b|to\b|in\b|for\b)[a-z]{2,15}\b/i],
  ['speaking',           /\b[a-z]{2,15}\s+speaking\b/i],
  ['how_can_i_help',     /\bhow\s+(?:can|may)\s+i\s+(?:help|assist|direct)\b/i],
  ['what_can_i_do',      /\bwhat\s+can\s+i\s+(?:do|get)\s+for\s+you\b/i],
  ['who_am_i_speaking',  /\bwho\s+am\s+i\s+speaking\s+(?:with|to)\b/i],
  ['can_i_get_your',     /\b(?:can|could|may)\s+i\s+(?:get|have|take|grab)\s+your\b/i],
  ['sorry_for_wait',     /\b(?:sorry|apolog\w+)\s+(?:about|for)\s+(?:the|your)\s+(?:wait|hold|delay)\b/i],
  ['go_ahead',           /\bgo\s+ahead\b/i],
  ['still_there',        /\bare\s+you\s+(?:still\s+)?there\b|\bhello\?\s*hello\b/i],
  ['thanks_for_holding_name', /\bthank(?:s|\s+you)\s+for\s+holding\b[^.?!]{0,40}\bthis\s+is\b/i],
];

const HUMAN_WEAK = [
  ['greeting',           /^\s*(?:hi|hello|hey|yes|yeah|good\s+(?:morning|afternoon|evening))\b/i],
  ['name_dept',          /^\s*[a-z]{2,15}\s+(?:here|from)\b/i],
];

const WORD_DIGIT = Object.freeze({
  zero: '0', oh: '0', one: '1', two: '2', to: '2', too: '2', three: '3', four: '4', for: '4',
  five: '5', six: '6', seven: '7', eight: '8', ate: '8', nine: '9',
  pound: '#', hash: '#', star: '*', asterisk: '*',
});

const words = (t) => String(t || '').trim().split(/\s+/).filter(Boolean);

/**
 * One utterance, one verdict. Order is the behaviour: a strong human marker beats a queue
 * marker, because "Thanks for holding, this is Denise in claims" contains both and is a person.
 * Everything else machine-shaped beats a weak human marker, because "Hello, and thank you for
 * calling the Department of Motor Vehicles" also contains both and is not.
 */
export function classifyUtterance(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return { state: FAR.UNKNOWN, strength: null, by: 'empty', markers: [], words: 0 };
  const n = words(text).length;

  const strong = hits(text, HUMAN_STRONG);
  if (strong.length) {
    return { state: FAR.HUMAN, strength: 'strong', by: strong[0].marker, markers: strong, words: n };
  }

  const vm = hits(text, VOICEMAIL);
  if (vm.length) return { state: FAR.VOICEMAIL, strength: 'strong', by: vm[0].marker, markers: vm, words: n };

  const closed = hits(text, CLOSED);
  if (closed.length) return { state: FAR.VOICEMAIL, strength: 'strong', by: closed[0].marker, markers: closed, words: n, closed: true };

  const ivr = hits(text, IVR);
  const queue = hits(text, QUEUE);
  if (ivr.length && (!queue.length || ivr.length >= queue.length)) {
    return { state: FAR.IVR, strength: 'strong', by: ivr[0].marker, markers: ivr, words: n };
  }
  if (queue.length) return { state: FAR.QUEUE, strength: 'strong', by: queue[0].marker, markers: queue, words: n };

  // Nothing machine-shaped matched. Before any weak rule runs, the recording's own way of
  // introducing itself is ruled out, because every weak rule below would say "person" to it.
  const self = hits(text, RECORDED_SELF);
  if (self.length) return { state: FAR.UNKNOWN, strength: null, by: self[0].marker, markers: self, words: n };

  // Now a short turn that greets, or asks, is a person candidate.
  const weak = hits(text, HUMAN_WEAK);
  if (weak.length && n <= 12) {
    return { state: FAR.HUMAN, strength: 'weak', by: weak[0].marker, markers: weak, words: n };
  }
  if (/\?\s*$/.test(text) && n <= 14) {
    return { state: FAR.HUMAN, strength: 'weak', by: 'short_question', markers: [{ marker: 'short_question', matched: text.slice(-60) }], words: n };
  }
  // A short turn with no machine vocabulary at all is still weak evidence of a person: hold
  // systems are verbose by design, because their whole job is to fill the silence.
  if (n > 0 && n <= 8) {
    return { state: FAR.HUMAN, strength: 'weak', by: 'short_turn', markers: [], words: n };
  }
  return { state: FAR.UNKNOWN, strength: null, by: 'no_marker', markers: [], words: n };
}

/**
 * Pull the choices a phone tree just offered. Deterministic, and it is the reason a model is
 * allowed nowhere near the decision of which key to press: whatever chooses, the digit it returns
 * has to be one this function found in the words the tree actually spoke.
 */
export function menuOptions(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ');
  const found = new Map();
  const digit = (w) => {
    const k = String(w || '').toLowerCase().replace(/[^a-z0-9#*]/g, '');
    if (/^[0-9#*]$/.test(k)) return k;
    return WORD_DIGIT[k] || null;
  };
  const add = (d, label) => {
    if (!d) return;
    const clean = String(label || '').replace(/^(?:for|to)\s+/i, '').replace(/[,.;:]+$/, '').trim().toLowerCase();
    if (!found.has(d)) found.set(d, clean);
    else if (clean && clean.length > (found.get(d) || '').length) found.set(d, clean);
  };

  // "For a stalled claim, press two."   /   "To check a claim press 2"
  for (const m of text.matchAll(/\b(?:for|to)\s+([^,.;?!]{2,70}?),?\s*(?:please\s+)?(?:press|dial|push|enter)\s+(?:the\s+)?(?:number\s+)?([a-z0-9#*]+)\b/gi)) {
    add(digit(m[2]), m[1]);
  }
  // "Press two for claims."
  for (const m of text.matchAll(/\b(?:press|dial|push|enter)\s+(?:the\s+)?(?:number\s+)?([a-z0-9#*]+)\s+(?:for|to)\s+([^,.;?!]{2,70})/gi)) {
    add(digit(m[1]), m[2]);
  }
  return [...found.entries()].map(([d, label]) => ({ digit: d, label }));
}

// ★ "new" AND "existing" ARE NOT STOP WORDS AND PUTTING THEM HERE BROKE THE ONLY MENU THAT
// MATTERS. A claims tree offers "for a NEW claim press one, for an EXISTING claim press two".
// Strip those two words and both options reduce to {claim}, the scores tie, and the tie went to
// whichever was said first: an errand about a stalled existing claim pressed one. The
// discriminating word in a phone tree is almost always the adjective, not the noun.
const STOP_WORDS = new Set(['a', 'an', 'the', 'to', 'for', 'of', 'my', 'your', 'our', 'is', 'are',
  'i', 'we', 'you', 'it', 'and', 'or', 'with', 'on', 'in', 'at', 'about', 'please', 'all', 'other',
  'any', 'question', 'questions', 'inquiries', 'inquiry', 'call', 'calls']);

const tokens = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w));

/**
 * Which option matches what the customer said this errand is about. Word overlap, nothing
 * cleverer, and it returns null rather than a guess when nothing overlaps. A wrong key press
 * costs the customer the whole queue position they just spent an hour earning, so "I do not
 * know" has to be an available answer.
 */
export function chooseOption(options, reason, reference) {
  if (!Array.isArray(options) || !options.length) return null;
  const want = new Set([...tokens(reason), ...(reference ? ['reference', 'account', 'case', 'claim'] : [])]);
  const scored = options
    .map((o) => {
      const overlap = tokens(o.label).filter((w) => want.has(w));
      return { ...o, score: overlap.length, overlap };
    })
    .filter((o) => o.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return null;
  // ★ A TIE IS A REFUSAL, NOT A COIN FLIP. Two options that match the errand equally well means
  // we do not know which one it is, and pressing the wrong key throws away the queue position the
  // customer just spent an hour earning. Waiting costs nothing by comparison.
  if (scored.length > 1 && scored[1].score === scored[0].score) return null;
  return scored[0];
}

/** The last resort every phone tree still honours. Never guessed; only used when the plan says so. */
export const ZERO_OUT = Object.freeze({ digit: '0', label: 'ask for an operator', why: 'no menu option matched the errand' });

/**
 * The running verdict over everything heard so far, plus the clock.
 *
 * @param {object} s
 *   utterances      [{ text, at }] newest last, already limited by the caller
 *   answeredAt      ms epoch the far end picked up
 *   now             ms epoch
 *   announcedAt     ms epoch we spoke the disclosure, or null
 *   heardAfterAnnounce  whether anything came back after we spoke
 *   promptCount     how many times we have already spoken up on this session
 * @returns {{act, state, confidence, why, evidence}}
 *   act: 'hold' | 'menu' | 'announce' | 'bridge' | 'give_up' | 'redial'
 */
export function fuse(s = {}) {
  const now = Number(s.now) || Date.now();
  const list = Array.isArray(s.utterances) ? s.utterances : [];
  const graded = list.map((u) => ({ ...u, ...classifyUtterance(u.text) }));
  const last = graded[graded.length - 1] || null;
  const lastAt = last ? Number(last.at) || now : null;
  const answeredAt = Number(s.answeredAt) || null;
  const sinceAnswer = answeredAt ? now - answeredAt : 0;
  const promptCount = Number(s.promptCount) || 0;

  const recent = graded.filter((u) => now - (Number(u.at) || 0) <= 45000);
  const lastMachine = [...graded].reverse().find((u) => u.state === FAR.QUEUE || u.state === FAR.IVR);
  const sinceMachine = lastMachine ? now - (Number(lastMachine.at) || now) : Infinity;

  const evidence = {
    utterances_seen: graded.length,
    last_state: last ? last.state : null,
    last_by: last ? last.by : null,
    last_markers: last ? last.markers : [],
    ms_since_last_utterance: lastAt ? now - lastAt : null,
    ms_since_machine_marker: Number.isFinite(sinceMachine) ? sinceMachine : null,
    ms_since_answer: sinceAnswer,
    prompt_count: promptCount,
  };

  // ── the confirmation, when we have already spoken ──────────────────────────────────────────
  // We said the opening sentence. Something answered it, and it was not a hold loop. That is the
  // strongest signal this system can get, because a recording does not react to being spoken to.
  if (s.announcedAt) {
    const after = graded.filter((u) => Number(u.at) > Number(s.announcedAt));
    const person = after.find((u) => u.state === FAR.HUMAN);
    if (person) {
      return { act: 'bridge', state: FAR.HUMAN, confidence: 'confirmed',
        why: 'we said who we were and a person answered', evidence: { ...evidence, confirmed_by: person.by, confirmed_text: String(person.text || '').slice(0, 160) } };
    }
    const machineBack = after.find((u) => u.state === FAR.QUEUE || u.state === FAR.IVR || u.state === FAR.VOICEMAIL);
    if (machineBack) {
      return { act: 'hold', state: machineBack.state, confidence: 'confirmed_machine',
        why: 'we spoke up and the hold loop carried on, so nobody is there yet', evidence };
    }
    if (now - Number(s.announcedAt) > 9000) {
      return { act: 'hold', state: FAR.QUEUE, confidence: 'confirmed_machine',
        why: 'nothing answered when we spoke, so we are still in the queue', evidence };
    }
    return { act: 'wait', state: FAR.UNKNOWN, confidence: 'listening', why: 'waiting to see if anyone answers us', evidence };
  }

  if (!last) {
    // Nothing has transcribed at all. That is normal: hold music produces no words.
    return { act: sinceAnswer > 8000 ? 'hold' : 'wait', state: FAR.UNKNOWN, confidence: 'no_speech',
      why: 'nothing has been said on the far end, which is what hold music sounds like to a transcriber', evidence };
  }

  if (last.state === FAR.VOICEMAIL) {
    return { act: 'give_up', state: FAR.VOICEMAIL, confidence: 'strong',
      why: last.closed ? 'the line says it is closed' : 'this is a voicemail box, not a queue', evidence };
  }

  if (last.state === FAR.IVR) {
    return { act: 'menu', state: FAR.IVR, confidence: 'strong', why: 'a phone tree is offering choices', evidence };
  }

  if (last.state === FAR.HUMAN && last.strength === 'strong') {
    return { act: 'announce', state: FAR.HUMAN, confidence: 'strong',
      why: `a person said something only a person says (${last.by})`, evidence, ringUserNow: true };
  }

  if (last.state === FAR.HUMAN && last.strength === 'weak') {
    // Weak, and the hold loop was talking moments ago: almost certainly still the loop.
    if (sinceMachine < 6000) {
      return { act: 'hold', state: FAR.QUEUE, confidence: 'weak_overruled',
        why: 'that could have been a person, but the hold loop was speaking seconds ago', evidence };
    }
    return { act: 'announce', state: FAR.HUMAN, confidence: 'weak',
      why: `that sounded like a person (${last.by}) and the hold loop has been quiet for a while`, evidence, ringUserNow: false };
  }

  if (last.state === FAR.QUEUE) {
    return { act: 'hold', state: FAR.QUEUE, confidence: 'strong', why: 'the queue is still talking', evidence };
  }

  // Unknown text. If it has been quiet for a long time after a queue that used to talk, speak up:
  // some systems connect you silently and the agent waits for you.
  if (recent.length === 0 && sinceMachine > 40000 && sinceAnswer > 60000 && promptCount < 6) {
    return { act: 'announce', state: FAR.UNKNOWN, confidence: 'silence_probe',
      why: 'the line has gone quiet after a queue, which is what a silent connect sounds like', evidence, ringUserNow: false };
  }
  return { act: 'hold', state: FAR.UNKNOWN, confidence: 'no_marker', why: 'nothing decisive yet', evidence };
}

/**
 * How long the state machine may wait before speaking up on its own, in ms. Deliberately not a
 * constant: the longer a session has been quiet the more likely a silent connect is, and the
 * cheaper an unnecessary sentence becomes.
 */
export function silenceProbeAfterMs(promptCount) {
  const n = Math.max(0, Number(promptCount) || 0);
  return Math.min(40000 + n * 30000, 240000);
}
