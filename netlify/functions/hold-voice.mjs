// hold-voice.mjs — every document the Hold runtime speaks.
//
// One function, seven exact routes, no splat. /api/hold must never be able to swallow
// /api/hold/voice, so each path is written out and matched literally, the same reasoning
// netlify.toml already applies to /api/call-me/twiml.
//
// ── THE MACHINE, IN ORDER ────────────────────────────────────────────────────────────────────
//
//   /voice     the target line picked up. Start listening. Say nothing.
//   /tick      the waiting loop. Pause, think, pause again. Also the backstop for everything
//              the transcription webhook might have missed, and the only place a timeout lives.
//   /menu      a phone tree offered options. Press the one that matches the errand, or wait.
//   /announce  somebody might be a person. Say who we are, what this is about, and listen.
//   /join      confirmed. Go into the conference the customer is being rung into.
//   /user      the customer's own leg. One keypress, then the conference.
//   /sorry     we reached a person and could not deliver our customer. Say so and let them go.
//
// ── WHY THE LINE IS SILENT UNTIL A PERSON IS THERE ───────────────────────────────────────────
// Nothing is spoken to the target between /voice and /announce. Not a greeting, not a beep. A
// queue does not need to be talked to, and every word spoken into a phone tree risks triggering
// its speech recogniser and losing the customer's place in line. The first thing this product
// ever says out loud is the disclosure, and it says it to a person.

import { authenticate } from './lib/twilio-webhook.mjs';
import * as store from './lib/hold-store.mjs';
import * as rt from './lib/hold-runtime.mjs';
import { fuse, menuOptions, chooseOption, classifyUtterance, FAR, ZERO_OUT } from './lib/hold-detect.mjs';

const { XML, SAY, HANGUP, goTo, transcriptionOn, waiting, conference, esc } = rt;

const PATHS = {
  '/api/hold/voice': 'voice',
  '/api/hold/tick': 'tick',
  '/api/hold/menu': 'menu',
  '/api/hold/announce': 'announce',
  '/api/hold/join': 'join',
  '/api/hold/user': 'user',
  '/api/hold/sorry': 'sorry',
};

/** Every document ends the call rather than hanging silently when we cannot read the session. */
const LOST = (why) => XML(
  `<Response>${SAY("I'm sorry, something went wrong on our side and I have to end this call. Nobody needs to do anything.")}<Hangup/></Response>`
  + `<!-- ${esc(String(why).slice(0, 120))} -->`,
);

async function load(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null;
  try {
    const r = await store.get(id, 120);
    if (!r || r.error) return null;
    return r;
  } catch (e) {
    console.error('hold-voice: session read failed:', String(e.message).slice(0, 140));
    return null;
  }
}

export default async (req) => {
  const url = new URL(req.url);
  const role = PATHS[url.pathname.replace(/\/+$/, '') || '/'];
  if (!role) return new Response('not found', { status: 404 });

  const event = await rt.asLambda(req);
  const gate = authenticate(event, url.pathname);
  if (!gate.ok) return new Response(gate.reject.body || 'refused', { status: gate.reject.statusCode });

  const p = gate.params;
  const q = event.queryStringParameters || {};
  const id = String(q.s || '');
  const loaded = await load(id);
  if (!loaded) return LOST(`no session for ${id}`);

  const s = loaded.session;
  const events = loaded.events || [];
  const now = Date.now();

  switch (role) {
    case 'voice':    return onAnswer(s, p);
    case 'tick':     return onTick(s, events, q, now);
    case 'menu':     return onMenu(s, events, q, now);
    case 'announce': return onAnnounce(s, events, q, now);
    case 'join':     return onJoin(s);
    case 'user':     return onUser(s, p, q);
    case 'sorry':    return onSorry(s, q);
    default:         return LOST('unreachable');
  }
};

// ── the target line picked up ────────────────────────────────────────────────────────────────
async function onAnswer(s, p) {
  await store.patch(s.id, {
    status: 'holding',
    answered_at: s.answered_at || new Date().toISOString(),
    hold_started_at: s.hold_started_at || new Date().toISOString(),
  });
  await store.event(s.id, 'answered', { call_sid: p.CallSid, from: p.From ? String(p.From).slice(-4) : null });
  return XML(`<Response>${transcriptionOn(s.id)}<Pause length="4"/>${goTo('/api/hold/tick', s.id, '&amp;t=1')}</Response>`);
}

// ── the waiting loop, and every deadline in the product ──────────────────────────────────────
async function onTick(s, events, q, now) {
  const tick = Math.max(1, Number(q.t) || 1);

  // A finished session must never keep a leg alive, whatever asked for this document.
  if (s.status === 'ended' || s.outcome) return HANGUP();
  if (s.status === 'bridged' || s.bridged_at) return onJoin(s);

  // ── the operator, who outranks the detector ───────────────────────────────────────────────
  // This is the human in the loop. Somebody watching /internal/hold can say "that is a person"
  // or "give up", and the next tick obeys within seconds. It is checked FIRST, before any
  // machine judgement, because the whole reason it exists is to overrule one.
  const command = (s.detector && s.detector.operator_action) || null;
  if (command === 'bridge') {
    await store.patch(s.id, { detector: { ...(s.detector || {}), operator_action: null, bridged_by: 'operator' } });
    await store.event(s.id, 'operator_bridge', { tick });
    const rung = await rt.ringUser(s);
    if (!rung.ok) await store.event(s.id, 'user_ring_failed', { reason: rung.reason, by: 'operator' });
    return onAnnounce(s, events, { ring: rung.ok ? '1' : '0', by: 'operator' }, now);
  }
  if (command === 'abandon') {
    await store.patch(s.id, { detector: { ...(s.detector || {}), operator_action: null } });
    await store.event(s.id, 'operator_abandon', { tick });
    await store.settle({ ...s, outcome: 'cancelled' }, { operator: 'operator' });
    return HANGUP();
  }

  // ── the deadlines ─────────────────────────────────────────────────────────────────────────
  const since = s.answered_at ? now - new Date(s.answered_at).getTime() : 0;
  if (since > rt.maxHoldMs()) {
    await store.event(s.id, 'attempt_timed_out', { minutes: Math.round(since / 60000), attempt: s.attempts });
    await store.settle(s, { operator: 'hold-runtime' });
    return HANGUP();
  }

  // ── the detector ──────────────────────────────────────────────────────────────────────────
  const verdict = fuse({
    utterances: rt.utterancesFrom(events, s.answered_at),
    answeredAt: s.answered_at ? new Date(s.answered_at).getTime() : null,
    announcedAt: s.announced_at ? new Date(s.announced_at).getTime() : null,
    promptCount: rt.promptCountFrom(events),
    now,
  });

  if (verdict.act === 'bridge')  return onAnnounce(s, events, { ring: '1', by: 'tick-confirm' }, now);
  if (verdict.act === 'announce') {
    await store.event(s.id, 'detector', { by: 'tick', ...verdict });
    return onAnnounce(s, events, { ring: verdict.ringUserNow ? '1' : '0', by: 'tick' }, now);
  }
  if (verdict.act === 'menu') return onMenu(s, events, { by: 'tick' }, now);
  if (verdict.act === 'give_up') {
    await store.event(s.id, 'gave_up', { why: verdict.why, state: verdict.state });
    await store.patch(s.id, { outcome_reason: verdict.why });
    await store.settle(s, { operator: 'hold-runtime' });
    return HANGUP();
  }

  // Nothing to do. Wait, and come back.
  if (tick % 12 === 0) await store.event(s.id, 'still_holding', { tick, minutes: Math.round(since / 60000), state: verdict.state });
  return waiting(s.id, tick, since);
}

// ── the phone tree ───────────────────────────────────────────────────────────────────────────
//
// ★ A DIGIT IS ONLY EVER PRESSED IF THE TREE OFFERED IT IN THE WORDS IT JUST SPOKE. The customer
// can supply a plan, and a plan wins; otherwise the option is chosen by matching the errand
// against the labels the tree itself read out. Nothing invents a keypress, because a wrong key
// throws away the queue position the customer already spent an hour earning, and a phone tree
// never tells you that you are in the wrong queue.
async function onMenu(s, events, q, now) {
  const heard = rt.utterancesFrom(events, s.answered_at);
  const lastIvr = [...heard].reverse().find((u) => classifyUtterance(u.text).state === FAR.IVR);
  const depth = Number(s.menu_depth || 0);
  const plan = Array.isArray(s.tree_plan) ? s.tree_plan : [];
  const sentSoFar = Array.isArray(s.digits_sent) ? s.digits_sent : [];

  let choice = null;

  // 1. The plan the customer gave us, in order.
  if (plan.length > sentSoFar.length) {
    const step = plan[sentSoFar.length];
    const d = String((step && step.digit) || step || '').trim();
    if (/^[0-9#*]$/.test(d)) choice = { digit: d, label: (step && step.label) || 'the customer supplied this step', by: 'plan' };
  }

  // 2. What the tree just offered, matched against the errand.
  if (!choice && lastIvr) {
    const options = menuOptions(lastIvr.text);
    const picked = chooseOption(options, s.reason, s.reference);
    if (picked) choice = { digit: picked.digit, label: picked.label, by: 'matched_offer', offered: options, overlap: picked.overlap };
    else if (options.length) {
      await store.event(s.id, 'menu_unmatched', { offered: options, reason: s.reason, heard: lastIvr.text.slice(0, 300) });
    }
  }

  // 3. The last resort every tree still honours. Only after we have genuinely heard two menus
  // and matched neither, and only if the customer did not switch it off.
  const zeroAllowed = !(s.detector && s.detector.no_zero_out);
  if (!choice && zeroAllowed && depth >= 2 && !sentSoFar.includes('0')) {
    choice = { digit: ZERO_OUT.digit, label: ZERO_OUT.label, by: 'zero_out' };
  }

  if (!choice) {
    // No key we are confident in. Waiting is safe: trees repeat themselves.
    return waiting(s.id, Number(q.t) || 1, s.answered_at ? now - new Date(s.answered_at).getTime() : 0);
  }

  await store.patch(s.id, {
    status: 'navigating',
    menu_depth: depth + 1,
    digits_sent: [...sentSoFar, choice.digit],
  });
  await store.event(s.id, 'digit_sent', {
    digit: choice.digit, label: choice.label, by: choice.by, depth: depth + 1,
    heard: lastIvr ? lastIvr.text.slice(0, 300) : null,
    offered: choice.offered || null,
  });

  // The leading waits matter: a tree that is still reading its options ignores a key pressed on
  // top of it, and half of them need a beat after the prompt before they will accept input.
  return XML(
    `<Response><Pause length="1"/><Play digits="ww${esc(choice.digit)}"/><Pause length="3"/>`
    + goTo('/api/hold/tick', s.id, `&amp;t=${(Number(q.t) || 1) + 1}`)
    + `</Response>`,
  );
}

// ── speaking up ──────────────────────────────────────────────────────────────────────────────
//
// The only place this product opens its mouth to a stranger. It carries all four obligations
// before it carries a single fact about the customer's account, because the case is the part a
// busy agent interrupts, and an interrupted disclosure is no disclosure at all.
async function onAnnounce(s, events, q, now) {
  const ring = String(q.ring || '') === '1';
  const already = Boolean(s.announced_at);

  if (ring) {
    const rung = await rt.ringUser(s);
    if (!rung.ok && !rung.already) await store.event(s.id, 'user_ring_failed', { reason: rung.reason });
  }

  await store.patch(s.id, {
    status: ring ? 'bridging' : 'announcing',
    human_at: s.human_at || new Date().toISOString(),
    announced_at: new Date().toISOString(),
  });
  await store.event(s.id, 'announced', { ringing_customer: ring, by: q.by || 'detector', repeat: already });

  const tail = ring ? store.bridgeTail() : store.probeTail();
  return XML(
    `<Response>`
    + SAY(store.opening(s))
    + (store.theCase(s) ? SAY(store.theCase(s)) : '')
    + SAY(tail)
    + `<Pause length="${ring ? 6 : 5}"/>`
    + goTo(ring ? '/api/hold/join' : '/api/hold/tick', s.id, ring ? '' : `&amp;t=${(Number(q.t) || 1) + 1}&amp;after=announce`)
    + `</Response>`,
  );
}

// ── the room ─────────────────────────────────────────────────────────────────────────────────
async function onJoin(s) {
  const name = s.conference_name || `hold-${String(s.id).replace(/-/g, '').slice(0, 24)}`;
  if (!s.conference_name) await store.patch(s.id, { conference_name: name });

  // ★ RECORDING STARTS HERE AND NOT ONE SECOND EARLIER, AND THAT IS THE POINT.
  // The hold itself is not recorded. The only audio this product keeps is the conversation that
  // begins AFTER the sentence announcing that it is recorded has been spoken. Twilio's
  // record-from-start records from the start of the CONFERENCE, and the conference starts here,
  // which is after /announce. A call recorded from the moment of dialling would have captured a
  // stranger before they were told anything.
  return XML(`<Response>${conference(s.id, name, { record: true })}${goTo('/api/hold/tick', s.id, '&amp;t=1&amp;after=conference')}</Response>`);
}

// ── our own customer's leg ───────────────────────────────────────────────────────────────────
//
// ★ THE KEYPRESS IS NOT A FORMALITY, IT IS THE VOICEMAIL DEFENCE. A voicemail box cannot press a
// key. Without this, an agent who has just given up two hours of queue to talk to us gets joined
// to a customer's answerphone, and neither of them ever knows why. It also costs less than the
// five seconds answering-machine detection would have spent finding out the same thing.
async function onUser(s, p, q) {
  const step = String(q.step || '');
  const name = s.conference_name || `hold-${String(s.id).replace(/-/g, '').slice(0, 24)}`;

  if (step === 'accept') {
    const digits = String(p.Digits || '').trim();
    if (!digits) {
      await store.event(s.id, 'user_no_keypress', { call_sid: p.CallSid });
      // Their leg goes away. The status callback moves the target leg to /sorry, so the person
      // we reached is told something rather than left listening to nothing.
      return XML(`<Response>${SAY("No problem. We'll try you again. Goodbye.")}<Hangup/></Response>`);
    }
    if (!s.conference_name) await store.patch(s.id, { conference_name: name });
    await store.event(s.id, 'user_accepted', { call_sid: p.CallSid, digits: digits.slice(0, 2) });
    return XML(`<Response>${SAY('Connecting you now.')}${conference(s.id, name, { record: false })}</Response>`);
  }

  await store.event(s.id, 'user_answered', { call_sid: p.CallSid });
  return XML(
    `<Response><Gather numDigits="1" timeout="12" actionOnEmptyResult="true" method="POST" `
    + `action="${esc(`${rt.site()}/api/hold/user?s=${encodeURIComponent(s.id)}&step=accept`)}">`
    + SAY(store.userGreeting(s))
    + SAY('Press any key and I will put you through.')
    + `</Gather></Response>`,
  );
}

// ── the apology ──────────────────────────────────────────────────────────────────────────────
// Nobody who gave up their time to answer us is left talking to silence. This is the whole
// abandon path and it is a real document, not a hangup.
async function onSorry(s, q) {
  await store.event(s.id, 'apologised', { why: String(q.why || 'bridge_failed').slice(0, 80) });
  return XML(`<Response>${SAY(store.sorryTail())}<Hangup/></Response>`);
}

// ★ STATIC LITERAL. Netlify reads this by static analysis and silently drops anything computed;
// a dropped path is a 404 on a live phone call. See the note in answered-brain.mjs, which cost an
// outage to write.
export const config = {
  path: [
    '/api/hold/voice',
    '/api/hold/tick',
    '/api/hold/menu',
    '/api/hold/announce',
    '/api/hold/join',
    '/api/hold/user',
    '/api/hold/sorry',
  ],
};
