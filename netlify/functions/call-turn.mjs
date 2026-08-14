// /api/call-turn — one conversational turn on a call this system placed.
//
// The turn loop is deliberately short. A research call has one question and one offer; anything
// longer is a sales call wearing a lab coat, and a sales call by artificial voice needs written
// consent we do not have. The loop hard-stops at turn 4 whatever the human says.
//
// Three things happen before any language model is consulted, because none of them are a
// judgment call:
//   1. a stop word suppresses the number, acknowledges once, and hangs up
//   2. "are you a robot" gets one honest sentence, never a speech and never a denial
//   3. the offer is delivered as written, never improvised

import { authenticate, XML, SAY, esc, origin } from './lib/twilio-webhook.mjs';
import { SCRIPTS, isStop, askedIfAI, AI_ANSWER } from './lib/scripts.mjs';
import * as db from './lib/db.mjs';

const PUBLIC_PATH = '/api/call-turn';
const MAX_TURNS = 4;
const ANTHROPIC_KEY = () => (process.env.ANTHROPIC_API_KEY_LIVE || process.env.ANTHROPIC_API_KEY || '').trim();

const say = (text, next) => XML(`<Response>${SAY(text)}${next || '<Hangup/>'}</Response>`);

function gather(base, mode, turn, prompt, seconds = 10) {
  return XML(
    `<Response><Gather input="speech" speechTimeout="auto" timeout="${seconds}" `
    + `action="${esc(`${base}/api/call-turn?mode=${mode}&turn=${turn}`)}" method="POST" `
    + `actionOnEmptyResult="true" language="en-US">${SAY(prompt)}</Gather></Response>`,
  );
}

const YES = /\b(yes|yeah|yep|sure|ok|okay|please|go ahead|send it|why not|do it|alright)\b/i;
const NO = /\b(no|nope|nah|not now|later|pass|don'?t|do not)\b/i;

/**
 * The language layer, and only the language layer. It never decides whether to keep calling, it
 * never quotes a price, and it never claims a result. Two sentences, hard capped.
 */
async function brain(mode, heard, history) {
  const key = ANTHROPIC_KEY();
  if (!key) return null;
  const system = [
    'You are on a live outbound research phone call for a company called Answered.',
    'You have ALREADY disclosed that you are an AI and that the call is recorded. Do not repeat it unless asked.',
    'You are researching how home service businesses handle inbound calls. You are NOT selling.',
    'HARD RULES: never state a price, never promise a result, never claim what the product has achieved,',
    'never claim to be human, never argue. If they are busy, thank them and close.',
    'Reply with AT MOST two short spoken sentences. No lists, no markdown, no stage directions.',
    'Sound like a person who respects that they are working.',
  ].join(' ');
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      signal: AbortSignal.timeout(4500),
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 90,
        system,
        messages: [...history, { role: 'user', content: heard || '(silence)' }],
      }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const text = (j.content || []).map((c) => c.text || '').join(' ').trim();
    if (!text) return null;
    return text.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ').slice(0, 300);
  } catch { return null; }
}

export const handler = async (event) => {
  const gate = authenticate(event, PUBLIC_PATH);
  if (!gate.ok) return gate.reject;

  const p = gate.params;
  const q = event.queryStringParameters || {};
  const mode = (q.mode || 'measure').toLowerCase();
  const turn = Number(q.turn || 1);
  const base = origin(event);
  const heard = String(p.SpeechResult || '').trim();

  try { await db.addEvent(p.CallSid, 'turn', { turn, mode, heard, confidence: p.Confidence }); } catch { /* logging must never end a call */ }

  // 1. STOP outranks everything, including the rest of this function.
  if (isStop(heard)) {
    try {
      await db.suppress(p.To || p.Called, `caller said stop on call ${p.CallSid}`, 'call-turn');
      await db.updateCall(p.CallSid, { disposition: 'do_not_call', outcome: { stopped: true, heard } });
    } catch (e) { console.error('suppression write failed:', String(e.message).slice(0, 140)); }
    return say('Understood. I have taken this number off our list and we will not call again. Sorry to bother you.');
  }

  // 2. A direct question about what they are talking to gets one sentence, then straight back.
  const prefix = askedIfAI(heard) ? `${AI_ANSWER} ` : '';

  if (turn >= MAX_TURNS) {
    return say(`${prefix}That is all I needed. Thanks for your time, and good luck out there.`);
  }

  // ── measure: one turn, no ask ───────────────────────────────────────────────────────────────
  if (mode === 'measure') {
    try { await db.updateCall(p.CallSid, { disposition: 'reached', outcome: { measured: true, heard } }); } catch { /* noop */ }
    return say(`${prefix}That is genuinely all. Thanks for picking up, and have a good one.`);
  }

  // ── discovery ───────────────────────────────────────────────────────────────────────────────
  if (turn === 1) {
    // They answered the question about what happens to an after-hours call. Acknowledge in their
    // own terms if the brain is available, then deliver the offer exactly as written.
    const ack = await brain(mode, heard, [
      { role: 'assistant', content: SCRIPTS.discovery.open() },
    ]);
    const lead = prefix + (ack ? `${ack} ` : 'That is what most shops tell us. ');
    try { await db.updateCall(p.CallSid, { disposition: 'reached', outcome: { answer_1: heard } }); } catch { /* noop */ }
    return gather(base, mode, 2, `${lead}${SCRIPTS.discovery.offer()}`, 10);
  }

  if (turn === 2) {
    const yes = YES.test(heard) && !NO.test(heard);
    try {
      await db.updateCall(p.CallSid, {
        disposition: yes ? 'interested' : 'reached',
        outcome: { answer_2: heard, accepted_offer: yes },
      });
    } catch { /* noop */ }

    if (yes) {
      // The text is queued by the campaign runner rather than sent from inside a voice webhook,
      // because A2P registration is still in carrier review and a silent SMS failure inside a
      // call would be invisible. The cockpit shows it as pending until the carrier clears.
      try { await db.addEvent(p.CallSid, 'offer_accepted', { channel: 'sms_queued' }); } catch { /* noop */ }
      return say(`${prefix}Great. I will get that over to you, and there is nothing to set up on your end until you decide. Thanks for your time.`);
    }
    return say(`${prefix}No problem at all. Thanks for the straight answer, that is exactly what I was after. Have a good one.`);
  }

  const reply = await brain(mode, heard, []);
  return say(`${prefix}${reply || 'Thanks for your time. Good luck out there.'}`);
};
