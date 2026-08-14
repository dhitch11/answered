// /api/answered-brain — ONE bridge, FOUR voices.
//
// An OpenAI-compatible chat/completions request comes in from an ElevenLabs
// ConvAI agent, an SSE token stream goes out, and a clause-buffered guard loop
// stands between the model and somebody's ear. Which voice answers is decided
// by the PATH the agent is pointed at, so a persona is a vendor console setting
// and can never be talked into changing mid call:
//
//   /api/answered-brain            riley     the inbound demo receptionist (LIVE)
//   /api/answered-brain/riley      riley     the same voice, named
//   /api/answered-brain/scout      scout     the outbound research caller
//   /api/answered-brain/onboard    onboard   the setup caller
//   /api/answered-brain/customer   customer  a paying business's own line
//
// ElevenLabs appends /chat/completions to a custom LLM server URL, so each of
// those also serves the suffixed form. config.path at the bottom of this file
// lists all ten as a STATIC LITERAL, because Netlify reads that export by
// static analysis and silently drops anything computed. Read the note down
// there before you tidy it: the tidy version took the demo line off the air.
//
// ★ THE LIVE DEMO LINE IS THE THING THIS FILE MUST NOT BREAK. +1 916 350 4869
// answers as Riley, a canary places a real call every two hours and asserts the
// disclosure sentence, and /api/demo-health probes the warm ping on the bare
// path before the site renders a single call control. So: the bare path still
// answers, the warm ping still returns {"ok":true,"warm":"riley"}, and every
// Riley string, floor and evaluation order moved into lib/personas.mjs byte for
// byte. lib/personas.test.mjs asserts that identity as a test, not as a claim.
//
// Env, by NAME only, all fail closed:
//   ANSWERED_BRAIN_SECRET    Bearer auth on every request. Missing means a loud
//                            500 on every call. Wrong or absent bearer is 401.
//   ANTHROPIC_API_KEY_LIVE   direct Anthropic key (never ANTHROPIC_API_KEY,
//                            that org is disabled). Missing means the warm ping
//                            reports 503 (so /api/demo-health goes red and no
//                            dialable control renders) and any live turn speaks
//                            the honest breaker line instead of dead air.
//   ANSWERED_DB_URL / _ANON / _SECRET   used ONLY to write a suppression when
//                            an outbound persona hears a stop. Unset means the
//                            voice says the weaker, true sentence instead of
//                            claiming a list it could not write to.
//
// Reasoning chain: claude-haiku-4-5-20251001 first, claude-sonnet-5 on failure,
// both on the direct Anthropic API. The backup call carries NO temperature
// (Sonnet 5 rejects non-default sampling params) and disables thinking so a
// short spoken turn is not eaten by a reasoning budget.
//
// The warm ping ({"warm": true} with the bearer) answers 200 without spending a
// single model token. It proves route + auth + key config, which is exactly
// what the demo-health brain_ready probe needs; a probe that burned tokens on
// every 60s health pass would be a slow leak, and a probe that skipped auth
// would prove nothing. {"describe": true} returns the persona registry so the
// lane wiring an agent can read the routes and the floors instead of guessing.

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  PERSONAS, personaFor, describe,
  guardClause, guardWhole, deterministicLine, contextDigits, noteHeader,
  nextBoundary, trimToSentence,
} from './lib/personas.mjs';
import * as db from './lib/db.mjs';

const GEN_BUDGET_MS = 8400; // inside Netlify's 10s stream ceiling, closes at the last clean clause
const MODEL_PRIMARY = 'claude-haiku-4-5-20251001';
const MODEL_BACKUP = 'claude-sonnet-5';
const SUPPRESS_TIMEOUT_MS = 2500; // a caller must not sit in silence while a row is written

function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join(' ');
  return '';
}

function toAnthropicMessages(inMsgs) {
  const msgs = [];
  for (const m of inMsgs) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const text = contentText(m.content).trim();
    if (!text) continue;
    msgs.push({ role: m.role, content: text });
  }
  // Anthropic requires the first message to be a user turn; ElevenLabs sends
  // the agent's own first line as an assistant turn, so seed one when needed.
  if (!msgs.length || msgs[0].role === 'assistant') {
    msgs.unshift({ role: 'user', content: '(the call just connected)' });
  }
  return msgs;
}

// ── who are we talking to ───────────────────────────────────────────────────
// A suppression is a claim about a database row, so the number has to come from
// somewhere the caller cannot invent. Two sources, both set by us:
//   1. a top level field on the request body, if the vendor sends one
//   2. the marker [[to:+1XXXXXXXXXX]] placed in the agent's system prompt in the
//      ElevenLabs console, where {{system__called_number}} expands to the number
//      the call was placed to
// Anything else is ignored. In particular a number the HUMAN says out loud is
// never used: "take 555 1234 off your list" must not suppress somebody else.
const E164 = /\+\d{10,15}/;
const BODY_NUMBER_KEYS = ['to_number', 'called_number', 'to', 'callee', 'customer_number', 'phone'];

function calleeNumber(body, systemText) {
  for (const k of BODY_NUMBER_KEYS) {
    const v = body && body[k];
    if (typeof v === 'string') {
      const m = v.match(E164);
      if (m && /^\+\d{10,15}$/.test(m[0])) return m[0];
    }
  }
  const marker = String(systemText || '').match(/\[\[\s*to\s*:\s*(\+\d{10,15})\s*\]\]/i);
  return marker ? marker[1] : null;
}

// ── direct Anthropic caller, streaming and buffered ─────────────────────────
async function askAnthropic({ apiKey, model, system, messages, maxTokens, temperature, disableThinking, stream, signal, onDelta }) {
  const reqBody = { model, system, messages, max_tokens: maxTokens, stream: !!stream };
  if (temperature !== undefined) reqBody.temperature = temperature;
  if (disableThinking) reqBody.thinking = { type: 'disabled' };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(reqBody),
    signal,
  });
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.text()).slice(0, 200); } catch (e) { /* status alone will do */ }
    throw new Error('anthropic ' + r.status + ' ' + detail);
  }
  if (!stream) {
    const j = await r.json();
    const text = (Array.isArray(j.content) ? j.content : [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(' ')
      .trim();
    return { text };
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let acc = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    acc += dec.decode(value, { stream: true });
    let nl;
    while ((nl = acc.indexOf('\n')) >= 0) {
      const line = acc.slice(0, nl).trim();
      acc = acc.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(payload); } catch (e) { continue; }
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && ev.delta.text) {
        onDelta(ev.delta.text);
      }
    }
  }
  return {};
}

// ── OpenAI-shape plumbing ────────────────────────────────────────────────────
const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' };

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
}
function mkChunkFactory(id, outModel) {
  return (delta, finish) =>
    'data: ' +
    JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: outModel,
      choices: [{ index: 0, delta, finish_reason: finish || null }],
    }) +
    '\n\n';
}
function jsonCompletion(id, outModel, text, toolCalls) {
  const message = { role: 'assistant', content: text };
  if (toolCalls) message.tool_calls = toolCalls;
  return json({
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: outModel,
    choices: [{ index: 0, message, finish_reason: toolCalls ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}
function sseOneShot(id, outModel, text, toolCalls) {
  const mk = mkChunkFactory(id, outModel);
  let s = mk({ role: 'assistant', content: text });
  if (toolCalls) s += mk({ tool_calls: toolCalls });
  s += mk({}, toolCalls ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n';
  return new Response(s, { headers: SSE_HEADERS });
}

const sha = (s) => createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => timingSafeEqual(sha(a), sha(b));

// ── the handler ──────────────────────────────────────────────────────────────
export default async (req) => {
  const T0 = Date.now();
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const secret = (process.env.ANSWERED_BRAIN_SECRET || '').trim();
  if (!secret) {
    console.error('ANSWERED-BRAIN DOWN: ANSWERED_BRAIN_SECRET is not set. Refusing every request until it is.');
    return json({ error: 'bridge is not configured' }, 500);
  }
  const given = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!given || !safeEq(given, secret)) return json({ error: 'unauthorized' }, 401);

  let body = {};
  try { body = await req.json(); } catch (e) { /* empty body handled below */ }

  let pathname = '/api/answered-brain';
  try { pathname = new URL(req.url).pathname; } catch (e) { /* keep the default */ }
  const { persona, by: routedBy } = personaFor(pathname, body);
  if (routedBy !== 'path') {
    // config.path only serves routes the registry generated, so a request that
    // did not route by path means the vendor reached us on a shape we did not
    // predict. It still gets served, by the most conservative voice, and the
    // surprise is logged rather than swallowed.
    console.error('answered-brain: routed by ' + routedBy + ' not path. pathname=' + pathname + ' persona=' + persona.id);
  }

  const apiKey = (process.env.ANTHROPIC_API_KEY_LIVE || '').trim();

  // registry self description: what an agent should be pointed at, and what
  // will be enforced when it is. No secrets, no prompt text, no env values.
  if (body && body.describe === true) {
    return json({
      ok: true,
      bridge: 'answered-brain',
      default_persona: PERSONAS.riley.id,
      routed_here_as: persona.id,
      note: 'Point an ElevenLabs agent at the server_url_paths entry for its persona. The vendor appends /chat/completions. To let an outbound persona honour a stop, put the marker [[to:{{system__called_number}}]] in the agent system prompt.',
      personas: describe(),
    });
  }

  // warm ping: proves route + auth + key config without spending a model token
  if (body && body.warm === true) {
    if (!apiKey) {
      console.error('ANSWERED-BRAIN NOT READY: ANTHROPIC_API_KEY_LIVE is not set.');
      return json({ ok: false, reason: 'ANTHROPIC_API_KEY_LIVE not set' }, 503);
    }
    return json({ ok: true, warm: persona.id, ms: Date.now() - T0 });
  }

  const inMsgs = Array.isArray(body && body.messages) ? body.messages : [];
  const wantsStream = !!(body && body.stream === true);
  const id = 'chatcmpl-answered-' + Math.floor(T0 / 1000);
  const outModel = persona.outModel;

  const userTexts = inMsgs.filter((m) => m && m.role === 'user').map((m) => contentText(m.content));
  const lastUser = userTexts.length ? userTexts[userTexts.length - 1] : '';
  const assistantTurns = inMsgs.filter((m) => m && m.role === 'assistant' && contentText(m.content).trim().length > 1).length;

  const incomingSystem = inMsgs
    .filter((m) => m && m.role === 'system')
    .map((m) => contentText(m.content))
    .join('\n')
    .trim();

  // The customer line is the only persona whose allowance widens with the call
  // system's own notes, because that is where the OWNER's hours and prices are.
  // Every other persona's ctx function ignores the second argument.
  const ctxDigits = contextDigits(persona, userTexts, incomingSystem);

  const elTools = Array.isArray(body && body.tools) ? body.tools : [];
  const hasEndCall = elTools.some((t) => t && ((t.function && t.function.name === 'end_call') || t.name === 'end_call'));
  const endCallTC = [{ index: 0, id: 'call_end_' + Math.floor(T0 / 1000), type: 'function', function: { name: 'end_call', arguments: '{}' } }];

  // deterministic branches first: stop, crisis, payment refusal, AI honesty,
  // demo honesty, abuse, hard close. No model, no drift, same answer every time.
  const det = deterministicLine(persona, lastUser, assistantTurns);
  if (det) {
    let line = det.line;
    if (det.stop) {
      // A stop is a legal event. Write it BEFORE speaking, and let what was
      // actually written choose the sentence: the strong line claims a row
      // exists, so it is only spoken when one does.
      const to = calleeNumber(body, incomingSystem);
      let wrote = false;
      // The one write that must never fail silently. A falsy or malformed
      // number is a REFUSAL to write, never a call that quietly does nothing,
      // and the sentence spoken changes to match.
      if (to && /^\+\d{10,15}$/.test(to)) {
        try {
          await db.rpc('sv_suppress', {
            p_phone: to,
            p_reason: 'callee said stop on a ' + persona.id + ' call',
            p_source: 'answered-brain/' + persona.id,
          }, { timeoutMs: SUPPRESS_TIMEOUT_MS });
          wrote = true;
        } catch (e) {
          console.error('ANSWERED-BRAIN STOP: suppression write FAILED for a ' + persona.id + ' call:', String(e && e.message).slice(0, 160));
        }
      }
      if (!wrote) {
        console.error(
          'ANSWERED-BRAIN STOP NOT RECORDED. persona=' + persona.id
          + ' number=' + (to || 'unknown')
          + ' conversation=' + String((body && (body.conversation_id || body.conversationId)) || 'unknown')
          + ' SUPPRESS THIS NUMBER BY HAND.',
        );
      } else {
        console.error('ANSWERED-BRAIN STOP recorded. persona=' + persona.id + ' number=' + to);
      }
      line = wrote ? persona.stop.lineSuppressed : persona.stop.lineUnrecorded;
    }
    const tc = det.end && hasEndCall ? endCallTC : null;
    return wantsStream ? sseOneShot(id, outModel, line, tc) : jsonCompletion(id, outModel, line, tc);
  }

  if (!apiKey) {
    console.error('ANSWERED-BRAIN DOWN: ANTHROPIC_API_KEY_LIVE is not set; speaking the honest breaker.');
    return wantsStream ? sseOneShot(id, outModel, persona.breaker, null) : jsonCompletion(id, outModel, persona.breaker, null);
  }

  // system prompt: persona first, then whatever the call system sent, then the
  // wind-down nudge once the call has run long. WHO WINS is per persona and is
  // written into the header: for the three voices we author, the persona rules
  // always win; for the customer line, the owner's rules win on every fact
  // about his business and never on safety.
  let system = persona.spec;
  if (incomingSystem) system += '\n\n' + noteHeader(persona) + '\n' + incomingSystem.slice(0, 4000);
  if (assistantTurns >= persona.softCloseAt) system += '\n\n' + persona.softCloseNote;

  const messages = toAnthropicMessages(inMsgs);
  const shared = { apiKey, system, messages, maxTokens: persona.maxTokens };
  const primaryReq = { ...shared, model: MODEL_PRIMARY, temperature: persona.temperature };
  const backupReq = { ...shared, model: MODEL_BACKUP, disableThinking: true };

  // ── buffered path (gate probes, diagnostics) ──
  if (!wantsStream) {
    let text = '';
    try {
      text = (await askAnthropic({ ...primaryReq, stream: false })).text;
    } catch (e) {
      console.error('answered-brain primary failed (buffered):', String(e && e.message).slice(0, 160));
      try {
        text = (await askAnthropic({ ...backupReq, stream: false })).text;
      } catch (e2) {
        console.error('answered-brain backup failed too (buffered):', String(e2 && e2.message).slice(0, 160));
      }
    }
    const finalText = guardWhole(persona, text, ctxDigits) || persona.breaker;
    return jsonCompletion(id, outModel, finalText, null);
  }

  // ── streaming path: clause-buffered guard loop ──
  const upstream = new AbortController();
  const encoder = new TextEncoder();
  const mk = mkChunkFactory(id, outModel);
  const ackBank = persona.ackBank;
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      let dead = false;
      let ttfc = false;
      let spoken = '';
      let ackText = '';
      let pendingAckDedupe = false;
      let buf = '';
      let sentences = 0;
      let modelChars = 0;

      const chunk = (delta, finish) => {
        if (!closed) controller.enqueue(encoder.encode(mk(delta, finish)));
      };
      const finish = () => {
        if (closed) return;
        chunk({}, 'stop');
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        closed = true;
        controller.close();
      };
      const say = (text) => {
        if (!text) return;
        // transcripts of these turns render on real pages later; the copy law
        // bans em dashes in net-new text, and a comma reads better to TTS too
        text = String(text).replace(/\s*[—–]\s*/g, ', ');
        if (!ttfc) { ttfc = true; chunk({ role: 'assistant' }); }
        chunk({ content: (spoken ? ' ' : '') + text });
        spoken += (spoken ? ' ' : '') + text;
      };

      // primer: never let the caller sit in silence past ~900ms
      const seed = (String(lastUser) + '|' + inMsgs.length + '|' + T0)
        .split('')
        .reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 7);
      const primer = setTimeout(() => {
        if (!ttfc && !dead && !closed) {
          ackText = ackBank[seed % ackBank.length];
          pendingAckDedupe = true;
          say(ackText);
        }
      }, 900);
      const budget = setTimeout(() => upstream.abort(), GEN_BUDGET_MS);

      const release = (flushAll) => {
        for (;;) {
          if (dead) return;
          let end = nextBoundary(buf);
          if (end < 0) {
            if (!flushAll || !buf.trim()) return;
            end = buf.length;
          }
          let out = buf.slice(0, end).trim();
          buf = buf.slice(end);
          if (flushAll) out = trimToSentence(out);
          if (!out) continue;
          if (pendingAckDedupe) {
            // the primer already said its word; never let the model repeat it
            const w = ackText.replace(/[^A-Za-z'-]+/g, '');
            if (w) out = out.replace(new RegExp('^' + w + '[,.!]?\\s*', 'i'), '');
            pendingAckDedupe = false;
            if (!out) continue;
            out = out.charAt(0).toUpperCase() + out.slice(1);
          }
          const g = guardClause(persona, out, ctxDigits);
          if (!g.ok) {
            // a blocked clause ends the turn: pivot spoken, nothing after it
            dead = true;
            upstream.abort();
            console.error('answered-brain guard fired:', persona.id + '/' + g.by);
            say(g.pivot);
            return;
          }
          say(out);
          sentences += 1;
          if (sentences >= persona.sentenceCap || spoken.split(/\s+/).length > persona.wordCap) {
            dead = true; // cadence cap: the turn is complete
            upstream.abort();
            return;
          }
        }
      };

      const onDelta = (d) => {
        if (dead) return;
        modelChars += d.length;
        buf += d;
        release(false);
      };

      try {
        await askAnthropic({ ...primaryReq, stream: true, signal: upstream.signal, onDelta });
      } catch (e) {
        if (!dead && modelChars === 0) {
          console.error('answered-brain primary failed, trying backup:', String(e && e.message).slice(0, 160));
          try {
            await askAnthropic({ ...backupReq, stream: true, signal: upstream.signal, onDelta });
          } catch (e2) {
            console.error('answered-brain backup failed too:', String(e2 && e2.message).slice(0, 160));
          }
        }
      }
      clearTimeout(primer);
      clearTimeout(budget);
      if (!dead && buf.trim()) release(true);
      const substantive = spoken.trim() && spoken.trim() !== ackText.trim();
      if (!substantive) say(persona.breaker); // chain exhausted: honest, never silent
      finish();
    },
    cancel() {
      upstream.abort();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
};

// ★★ THIS ARRAY MUST BE A STATIC LITERAL. IT COST A LIVE OUTAGE TO LEARN.
//
// MEASURED 2026-08-14, in production. This line used to read
//     export const config = { path: routeTable() };
// which is clean, self maintaining, and WRONG. Netlify reads a v2 function's
// `config` export by STATIC ANALYSIS at bundle time; it does not execute the
// module. A computed value it cannot evaluate is not an error and not a
// warning, it is simply dropped, and the function silently falls back to its
// default /.netlify/functions/<name> route.
//
// The signature of the failure, if you ever see it again:
//     /api/answered-brain            -> 404
//     /.netlify/functions/answered-brain -> 200
// A declared path REMOVES the default route, so a live default route means no
// path was ever registered. Both facts were true on deploy 6a7f600d at
// 18:35:57Z: the function was healthy, its URL did not exist, and the demo
// line's ElevenLabs agent was pointing at a 404. Nothing failed loudly. The
// build was green, the function was 200, and the phone had no brain.
//
// So the routes are written out by hand, and lib/personas.test.mjs asserts this
// literal is exactly equal to routeTable(). The bundler gets a literal; the
// humans get the guarantee; neither depends on the other being remembered.
export const config = {
  path: [
    '/api/answered-brain',
    '/api/answered-brain/chat/completions',
    '/api/answered-brain/riley',
    '/api/answered-brain/riley/chat/completions',
    '/api/answered-brain/scout',
    '/api/answered-brain/scout/chat/completions',
    '/api/answered-brain/onboard',
    '/api/answered-brain/onboard/chat/completions',
    '/api/answered-brain/customer',
    '/api/answered-brain/customer/chat/completions',
  ],
};
