// hold-hear.mjs — the ear. Every word the far end says arrives here, and this is where a hold
// stops being a hold.
//
// Twilio's real-time <Start><Transcription> posts each finished utterance from the far end to
// this endpoint. Three things happen, in this order, and the order is the design:
//
//   1. WRITE IT DOWN FIRST. The utterance is stored before anything is decided about it, so a
//      detector bug can never cost us the evidence of what was actually said. The receipt and
//      every future improvement to the classifier are both rendered from this log.
//   2. HONOUR A STOP. If the person we reached asks not to be called, that is obeyed here, on the
//      raw stream, before any state machine gets a vote.
//   3. DECIDE, AND ACT IMMEDIATELY. If a person is on the line, the live call is moved to the
//      announcement in about a second, rather than waiting for the next tick of the waiting loop.
//      That immediacy is the whole reason detection lives in this webhook and not in the loop.
//
// ── WHERE THE MODEL IS ALLOWED, AND WHERE IT IS NOT ──────────────────────────────────────────
// The deterministic classifier in lib/hold-detect.mjs is the floor and it cannot be overruled. A
// model is consulted for exactly one case: an utterance the rules could not label at all. Even
// then it can only PROMOTE an unknown to "there may be a person here", which buys nothing more
// than the right to say a sentence out loud and listen for an answer. It can never silence a
// queue marker, never press a key, and never bridge on its own. Its verdict is logged next to the
// deterministic one on every call, so its accuracy is a measurement we will have rather than a
// claim we made.

import { authenticate } from './lib/twilio-webhook.mjs';
import { isStop } from './lib/scripts.mjs';
import * as db from './lib/db.mjs';
import * as store from './lib/hold-store.mjs';
import * as rt from './lib/hold-runtime.mjs';
import { classifyUtterance, fuse, FAR } from './lib/hold-detect.mjs';

const PUBLIC_PATH = '/api/hold/hear';
// ★ MEASURED, NOT ASSUMED: `new Response('', { status: 204 })` THROWS.
// 204 is a null-body status and undici refuses to construct one with a body at all, including the
// empty string, so this line used to raise "Invalid response status code 204" and the platform
// turned it into a 500. Every transcription callback and every call-status callback failed that
// way: the detector never received one word, no status event ever landed, and the product would
// have looked completely wired while being completely deaf. Nothing about it was visible from the
// code, the routes, or a green deploy. Only a real HTTP request found it.
const OK = () => new Response(null, { status: 204 });

const MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-5'];

/**
 * One short question, one word back. Used only on utterances the rules could not label.
 * Times out fast and fails to null: a live call must never wait on this.
 */
async function askModel(text) {
  const key = String(process.env.ANTHROPIC_API_KEY_LIVE || '').trim();
  if (!key || !text) return null;
  const prompt = 'You are reading one utterance captured from a telephone line that we are on hold with.\n'
    + 'Answer with exactly one word, lowercase, no punctuation:\n'
    + '  person   a live human being is speaking to us right now\n'
    + '  system   a recording, a phone menu, a queue announcement, hold music or a voicemail greeting\n'
    + '  unclear  it is genuinely impossible to tell\n\n'
    + `Utterance: ${JSON.stringify(String(text).slice(0, 400))}`;

  for (const model of MODELS) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(2500),
      });
      if (!r.ok) continue;
      const j = await r.json();
      const word = String((j.content && j.content[0] && j.content[0].text) || '').trim().toLowerCase();
      if (['person', 'system', 'unclear'].includes(word)) return { verdict: word, model };
    } catch (e) { /* next model, then null; a live call never waits on this */ }
  }
  return null;
}

export default async (req) => {
  const url = new URL(req.url);
  const event = await rt.asLambda(req);
  const gate = authenticate(event, PUBLIC_PATH);
  if (!gate.ok) return new Response(gate.reject.body || 'refused', { status: gate.reject.statusCode });

  const p = gate.params;
  const id = String((event.queryStringParameters || {}).s || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return OK();

  const kind = String(p.TranscriptionEvent || '');
  if (kind === 'transcription-error') {
    await store.event(id, 'transcription_error', { code: p.TranscriptionErrorCode || null });
    // ★ A DEAF SESSION IS NOT A SILENT ONE. With no transcription the detector has no input at
    // all, so it would hold forever and never notice a person. The operator page reads this flag
    // and the session is escalated rather than left running blind.
    try {
      const cur = await store.get(id, 1);
      if (cur && cur.session) {
        await store.patch(id, { detector: { ...(cur.session.detector || {}), deaf: true, deaf_since: new Date().toISOString() } });
      }
    } catch (e) { /* the event above is already the record */ }
    return OK();
  }
  if (kind !== 'transcription-content') return OK();

  let data = {};
  try { data = JSON.parse(p.TranscriptionData || '{}'); } catch { /* an unreadable payload is an empty one */ }
  const text = String(data.transcript || '').trim();
  if (!text) return OK();

  // ── 1. write it down, first, always ────────────────────────────────────────────────────────
  const graded = classifyUtterance(text);
  await store.event(id, 'far_end_said', {
    text: text.slice(0, 600),
    state: graded.state,
    strength: graded.strength,
    by: graded.by,
    markers: graded.markers,
    confidence: data.confidence ?? null,
    call_sid: p.CallSid || null,
  });

  const loaded = await store.get(id, 120);
  if (!loaded || loaded.error || !loaded.session) return OK();
  const s = loaded.session;
  const events = loaded.events || [];

  // Nothing else matters once the errand is over.
  if (s.status === 'ended' || s.outcome) return OK();

  // ── 2. a stop is obeyed before anything else is decided ────────────────────────────────────
  // The person on the far end never asked to be part of this. If they say take us off the list,
  // that is honoured on this number, immediately, and the errand ends.
  if (isStop(text)) {
    await store.event(id, 'stop_heard', { text: text.slice(0, 200), from: 'target' });
    try {
      await db.rpc('sv_dnc_request', {
        p_phone: s.target_phone, p_channel: 'call',
        p_heard_as: text.slice(0, 200), p_call_sid: s.call_sid || null, p_by: 'hold-hear-tripwire',
      });
    } catch (e) {
      console.error('hold: DNC request failed, falling back to suppression:', String(e.message).slice(0, 140));
      try { await db.suppress(s.target_phone, `said "${text.slice(0, 120)}" during hold session ${s.id}`, 'hold-hear-tripwire'); }
      catch (e2) { console.error('hold: suppression ALSO failed:', String(e2.message).slice(0, 140)); }
    }
    await store.patch(id, { outcome_reason: 'the line we called asked not to be called again' });
    await store.settle(s, { operator: 'hold-hear' });
    if (s.call_sid) await rt.endLeg(s.call_sid);
    return OK();
  }

  // ── 3. decide ──────────────────────────────────────────────────────────────────────────────
  const now = Date.now();
  const utterances = rt.utterancesFrom(events, s.answered_at);
  let verdict = fuse({
    utterances,
    answeredAt: s.answered_at ? new Date(s.answered_at).getTime() : null,
    announcedAt: s.announced_at ? new Date(s.announced_at).getTime() : null,
    promptCount: rt.promptCountFrom(events),
    now,
  });

  // The one place a model gets a say, and only upward, and only from nothing.
  let model = null;
  if (graded.state === FAR.UNKNOWN && verdict.act !== 'bridge' && verdict.act !== 'menu' && !s.announced_at) {
    model = await askModel(text);
    if (model) {
      await store.event(id, 'model_read', {
        text: text.slice(0, 200), model: model.model, said: model.verdict,
        deterministic: graded.state, deterministic_by: graded.by, agreed_with_rules: model.verdict === 'system',
      });
      if (model.verdict === 'person') {
        verdict = {
          ...verdict, act: 'announce', state: FAR.HUMAN, confidence: 'model_promoted', ringUserNow: false,
          why: `the rules could not label that, and ${model.model} read it as a person, so we will say something and listen`,
        };
      }
    }
  }

  await store.event(id, 'detector', { by: 'hear', act: verdict.act, state: verdict.state, confidence: verdict.confidence, why: verdict.why });

  if (!s.call_sid) return OK();

  // ★ THE FINDING IS WRITTEN DOWN BEFORE THE ACTION IS TAKEN, and that ordering was a defect
  // until a test caught it. `human_at` used to be set inside the /announce document, which is only
  // reached if the live-call redirect below succeeds. When the redirect failed, and the telephony
  // API failing is exactly the case where it does, the session sat in its old state with no record
  // that a person had ever been detected: the operator console showed a quiet hold while somebody
  // was on the line. The knowledge belongs to the ear that heard it, not to the mouth that acts on
  // it.
  //
  // It is only written on a CONFIDENT read. A weak candidate has not earned `human_at`, because
  // that field decides which outcome sentence the receipt prints, and "we reached a person and
  // could not connect you" is a promise about what happened, not a guess.
  const confident = verdict.act === 'bridge' || (verdict.act === 'announce' && verdict.ringUserNow);

  if (verdict.act === 'bridge' || (verdict.act === 'announce' && !s.announced_at)) {
    const ring = verdict.act === 'bridge' || Boolean(verdict.ringUserNow);
    if (confident && !s.human_at) {
      await store.patch(id, { human_at: new Date().toISOString(), status: 'announcing' });
    }
    // A strong read rings the customer at the same moment we start talking, so the four seconds
    // the page promises are real. A weak read talks first and only rings once something answers.
    if (ring) {
      const rung = await rt.ringUser(s);
      if (!rung.ok && !rung.already) await store.event(id, 'user_ring_failed', { reason: rung.reason });
    }
    const moved = await rt.moveLeg(s.call_sid, '/api/hold/announce', id, `&ring=${ring ? '1' : '0'}&by=hear`);
    if (!moved.ok) {
      // The waiting loop is the backstop: it re-runs the same detector on its next tick and
      // reaches the same document without needing the telephony API to steer anything.
      await store.event(id, 'steer_failed', { to: 'announce', reason: moved.reason, falling_back_to: 'the waiting loop' });
    }
    return OK();
  }
  if (verdict.act === 'menu') {
    await rt.moveLeg(s.call_sid, '/api/hold/menu', id, '&by=hear');
    return OK();
  }
  if (verdict.act === 'give_up') {
    await store.patch(id, { outcome_reason: verdict.why });
    await store.settle(s, { operator: 'hold-hear' });
    await rt.endLeg(s.call_sid);
    return OK();
  }

  return OK();
};

export const config = { path: ['/api/hold/hear'] };
