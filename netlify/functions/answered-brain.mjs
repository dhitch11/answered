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
import { modulesFor } from './lib/brain-modules.mjs';
import { BOOK_TOOL, anthropicTool, wasBooked } from './lib/tools.mjs';

const GEN_BUDGET_MS = 8400; // inside Netlify's 10s stream ceiling, closes at the last clean clause
const MODEL_PRIMARY = 'claude-haiku-4-5-20251001';
const MODEL_BACKUP = 'claude-sonnet-5';
const SUPPRESS_TIMEOUT_MS = 2500; // a caller must not sit in silence while a row is written
// The orphan-tool recovery below runs INSIDE the same ten second ceiling as the spoken turn, so it
// gets a hard, small budget and the generation budget is measured from the top of the request
// rather than from the top of the stream.
const TOOL_RECOVER_MS = 4000;

function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join(' ');
  return '';
}

/**
 * ★ THIS FUNCTION USED TO DROP EVERY ROLE IT DID NOT RECOGNISE, SILENTLY, AND THAT WAS FINE UNTIL
 * THE VOICE GREW HANDS. When ElevenLabs runs a server tool it hands the answer back as a `tool`
 * role message. Under the old loop that message was discarded, which would have left the model
 * narrating a booking it could not see: exactly the shape of fabrication the rest of this file
 * exists to prevent. So a tool answer is now folded in as a labelled note, and the assistant turn
 * that called the tool leaves a trace even when it carried no words.
 *
 * Same-role turns are merged rather than dropped, because a folded tool note can otherwise land
 * next to the caller's own turn and Anthropic wants a clean alternation.
 */
function toAnthropicMessages(inMsgs) {
  const msgs = [];
  const push = (role, text) => {
    if (!text) return;
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content += '\n' + text;
    else msgs.push({ role, content: text });
  };
  for (const m of inMsgs) {
    if (!m) continue;
    if (m.role === 'tool' || m.role === 'function') {
      const t = contentText(m.content).trim();
      if (t) push('user', TOOL_NOTE + ' ' + t.slice(0, 900));
      continue;
    }
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = contentText(m.content).trim();
    if (text) { push(m.role, text); continue; }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      push('assistant', '(used ' + m.tool_calls.map(toolName).filter(Boolean).join(', ') + ')');
    }
  }
  // Anthropic requires the first message to be a user turn; ElevenLabs sends
  // the agent's own first line as an assistant turn, so seed one when needed.
  if (!msgs.length || msgs[0].role === 'assistant') {
    msgs.unshift({ role: 'user', content: '(the call just connected)' });
  }
  return msgs;
}

// ── the hands ────────────────────────────────────────────────────────────────
// Everything below is about ACTIONS, which are a different kind of risk from
// words. A sentence that goes wrong is embarrassing. A tool call that goes
// wrong sends a van to an address nobody said. So: a persona may only call a
// tool on its own allowlist, only when the vendor declared that tool on this
// request, only once per turn, and never with arguments this bridge could not
// parse. Everything the model produces is treated as a claim, not an
// instruction, right up until lib/tools.mjs has checked it.

// ── the owner's own instructions, when there are more of them than fit ───────
//
// Reported by @LANE-SEARCHLIGHT and verified here: this used to be
// `incomingSystem.slice(0, 4000)`. It kept the first 4,000 characters and dropped the rest in
// silence. No log, no counter, nothing in the transcript. The call sounded fine and the model
// behaved plausibly while half the owner's rules had never arrived.
//
// ★ WHY THE TAIL IS THE WORST PART TO LOSE. People write the setup first and the caveats last.
// "Important:", "Never say...", "If they ask about pricing, do not quote a number." That is the
// shape of human writing, and the end is exactly what a head-slice throws away.
//
// ★ AND WHAT WAS *NOT* WRONG, because the first report of this overstated it: the persona's safety
// spec is assigned to `system` BEFORE this runs and is never sliced. Safety rules were never at
// risk. What was lost was the owner's own instructions, which is a real defect and a smaller one.
//
// So: keep both ends, and TELL THE MODEL something was dropped. A model that silently receives
// partial instructions answers confidently from the half it got. A model that is told its notes
// were clipped can say it will check, which is the behaviour we want at exactly that moment.
const OWNER_NOTE_LIMIT = 4000;

/**
 * Tell the operator, so the person who WROTE the notes can fix them.
 *
 * Keeping both ends and warning the model makes the CALL safe. It does not make the owner's notes
 * right: they still have rules their assistant is not being given, and they cannot know that unless
 * somebody says so. This is the write side of that; @ANSWERED-INTEL owns the render.
 *
 * ★ IT CAN NEVER BREAK A CALL. It is fire-and-forget, it is awaited by nothing, and every failure
 * path swallows to a log. A caller is on the phone; a flag for a dashboard does not get to be the
 * reason they hear silence.
 */
function flagClipped(line, sent, kept) {
  try {
    db.rpc('sv_notes_clipped', { p_line: line || null, p_sent: sent, p_kept: kept })
      .catch((e) => console.error('answered-brain: could not flag clipped notes:', String(e && e.message).slice(0, 120)));
  } catch (e) {
    console.error('answered-brain: could not flag clipped notes:', String(e && e.message).slice(0, 120));
  }
}

export function fitOwnerNotes(notes, persona, line) {
  const s = String(notes || '');
  if (s.length <= OWNER_NOTE_LIMIT) return s;

  // 60/40 favouring the tail, because the caveats live there.
  const head = Math.floor(OWNER_NOTE_LIMIT * 0.55);
  const tail = OWNER_NOTE_LIMIT - head;
  const gap =
    '\n\n[Some of these notes were too long to include and part of the middle was left out. '
    + 'If something comes up that these notes do not cover, do not guess and do not fill the gap: '
    + 'say you will check with the owner and come back.]\n\n';

  console.warn(
    `answered-brain: owner notes for persona ${persona && persona.id} are ${s.length} characters, `
    + `over the ${OWNER_NOTE_LIMIT} limit. Keeping the first ${head} and the last ${tail}; `
    + `${s.length - OWNER_NOTE_LIMIT} characters of the middle were dropped and the model was told so.`,
  );

  flagClipped(line, s.length, OWNER_NOTE_LIMIT);
  return s.slice(0, head) + gap + s.slice(-tail);
}

const TOOL_NOTE = '[the booking system answered]';
const toolName = (tc) => (tc && ((tc.function && tc.function.name) || tc.name)) || '';

/**
 * Which tools this turn offers. BOTH halves must agree, and the second half is
 * the one that matters: if the vendor did not declare the tool, the model must
 * not be able to emit a call to it, because a call nobody runs looks to the
 * caller exactly like a booking and is nothing at all.
 */
function offeredTools(persona, body, inMsgs) {
  const allow = persona.tools || [];
  if (!allow.length) return { names: [], anthropic: [] };
  const declared = (Array.isArray(body && body.tools) ? body.tools : []).map(toolName).filter(Boolean);
  let names = allow.filter((n) => declared.includes(n));
  // A visit already on the schedule is not offered again. The tool endpoint is
  // idempotent and would refuse a second one, but the cleanest way to not book
  // twice is to not ask twice.
  if (names.includes(BOOK_TOOL) && bookedAlready(inMsgs)) names = names.filter((n) => n !== BOOK_TOOL);
  return { names, anthropic: names.includes(BOOK_TOOL) ? [anthropicTool()] : [] };
}

/** Has a tool answer in this conversation already said the visit is on the schedule? */
function bookedAlready(inMsgs) {
  for (const m of inMsgs) {
    if (!m || (m.role !== 'tool' && m.role !== 'function')) continue;
    if (wasBooked(contentText(m.content))) return true;
  }
  return false;
}

/**
 * A tool call sitting in the history with no answer after it. The vendor is
 * supposed to run a server tool and hand back what it said; if it did not, the
 * model is about to narrate a booking that never happened.
 */
function orphanToolCall(inMsgs) {
  let call = null;
  let at = -1;
  inMsgs.forEach((m, i) => {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) return;
    for (const tc of m.tool_calls) if (toolName(tc) === BOOK_TOOL) { call = tc; at = i; }
  });
  if (!call) return null;
  for (let i = at + 1; i < inMsgs.length; i += 1) {
    const m = inMsgs[i];
    if (m && (m.role === 'tool' || m.role === 'function')) return null;
  }
  return call;
}

const toolOrigin = () =>
  String(process.env.ANSWERED_SITE_URL || process.env.URL || 'https://answered.reddenda.com').trim().replace(/\/+$/, '');

/**
 * Run the tool ourselves, on the same authenticated, idempotent endpoint the
 * vendor would have called. Safe to run even if the vendor DID call it: the
 * idempotency key is derived from the facts of the job, so the second attempt
 * replays the first one's answer instead of booking a second van.
 */
async function runToolInline(tc, conversationId) {
  const secret = String(process.env.ANSWERED_BRAIN_SECRET || '').trim();
  const name = toolName(tc);
  let args = {};
  try { args = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch (e) { args = {}; }
  if (conversationId) args.conversation_id = conversationId;
  const r = await fetch(toolOrigin() + '/api/answered-tool?tool=' + encodeURIComponent(name), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(TOOL_RECOVER_MS),
  });
  const j = await r.json().catch(() => null);
  return j && typeof j.result === 'string' ? j.result : null;
}

/** The model's tool_use, in the shape ElevenLabs expects back on the wire. */
function toOpenAiToolCall(tu, conversationId, t0) {
  const args = { ...tu.input };
  // The conversation id is OURS to set and never the model's to invent: it is
  // half of the idempotency key that stops a retry booking a second visit.
  if (conversationId) args.conversation_id = conversationId;
  else delete args.conversation_id;
  return {
    index: 0,
    id: String(tu.id || 'call_' + tu.name + '_' + Math.floor(t0 / 1000)).slice(0, 64),
    type: 'function',
    function: { name: tu.name, arguments: JSON.stringify(args) },
  };
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

/**
 * Which knowledge modules this call has already been given.
 *
 * ★ DERIVED FROM THE TRANSCRIPT, NEVER HELD IN MODULE SCOPE. This handler is stateless between turns
 * but WARM across invocations, so a `new Set()` at module level would carry one caller's loaded
 * modules into the next caller's call. The symptom would be knowledge silently NOT loading for the
 * second person — no error, no log, just a worse answer — which is the failure shape this estate is
 * worst at seeing. Replaying the transcript costs a few regex tests and cannot leak.
 */
/**
 * Does the owner's own note say somebody rings the caller back?
 *
 * ★ WHY THIS IS A NARROW PATTERN AND NOT A CLEVER ONE. It unlocks a promise the voice makes to a
 * real customer, so a false positive is the voice promising a call that nobody will make. It must
 * match an owner WRITING that calls get returned, and nothing else. It deliberately does NOT match:
 *
 *   "call us on 555 0100"              an instruction to the CALLER, the opposite direction
 *   "after hours goes to voicemail"     where a call lands, not a promise to return it
 *   "do not call the cell"              a prohibition containing the word call
 *
 * Absent or unreadable notes return false, which leaves the floor at full strength.
 */
export function notesAuthorizeCallback(notes) {
  const s = String(notes || '');
  if (!s.trim()) return false;
  // ★ THE -S FORM. The first version matched `call` but not `calls`, so the notes sentence
  // "After hours a caller gets a message taken and the owner calls back" read as NOT authorising a
  // callback, and the floor gagged a business that genuinely does call people back. Caught by an
  // existing test in personas.test.mjs, whose owner-notes fixture uses exactly that phrasing.
  // Third-person singular is the natural way an owner writes their own rules ("the owner calls
  // back", "someone calls you back"), so it was the likelier form and it was the one that missed.
  return /\b(?:(?:we|i|they|he|she|the owner|someone|somebody|a tech\w*|the tech\w*)\s+(?:will\s+|always\s+|usually\s+|do\s+|does\s+)?(?:calls?|rings?|phones?)\s+(?:them|the caller|people|customers|you|him|her)?\s*back\b|call(?:s|ing)?\s+back\s+(?:within|inside|same day|the same day|by)\b|return\s+(?:all\s+)?calls?\b|calls?\s+(?:are|get)\s+returned\b|gets?\s+a\s+(?:call|callback)\s+back\b)/i.test(s);
}

function moduleState(inMsgs) {
  const said = new Set();
  const turns = (inMsgs || []).filter((m) => m && m.role === 'user').map((m) => String(m.content || ''));
  for (const t of turns.slice(0, -1)) modulesFor(t, said);   // every turn except the newest
  return said;
}

async function askAnthropic({ apiKey, model, system, messages, maxTokens, temperature, disableThinking, stream, signal, onDelta, tools, onTool }) {
  const reqBody = { model, system, messages, max_tokens: maxTokens, stream: !!stream };
  if (tools && tools.length) reqBody.tools = tools;
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
    const blocks = Array.isArray(j.content) ? j.content : [];
    const text = blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(' ')
      .trim();
    const tu = blocks.find((b) => b && b.type === 'tool_use');
    return { text, tool: tu ? { id: tu.id, name: tu.name, input: tu.input } : null };
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let acc = '';
  let pendingTool = null;
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
      // A tool call arrives as its own content block: one start, a run of
      // partial JSON, one stop. The JSON is only parsed at the stop, because
      // half an arguments object is not a smaller booking, it is not a booking.
      if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') {
        pendingTool = { id: ev.content_block.id, name: ev.content_block.name, json: '' };
      } else if (ev.type === 'content_block_delta' && ev.delta) {
        if (ev.delta.type === 'text_delta' && ev.delta.text) onDelta(ev.delta.text);
        else if (ev.delta.type === 'input_json_delta' && pendingTool) pendingTool.json += ev.delta.partial_json || '';
      } else if (ev.type === 'content_block_stop' && pendingTool) {
        const done = pendingTool;
        pendingTool = null;
        let input = null;
        try { input = JSON.parse(done.json || '{}'); } catch (e) { input = null; }
        if (onTool) onTool({ id: done.id, name: done.name, input });
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
  const conversationId = String((body && (body.conversation_id || body.conversationId)) || '').trim().slice(0, 120);
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

  // ── KNOWLEDGE MODULES ──────────────────────────────────────────────────────
  // Appended AFTER the persona spec, never before it, for two reasons that both matter:
  //
  //   1. CACHING. lib/anthropic.mjs marks the system prompt cache_control:{type:'ephemeral'}, and a
  //      cache hit needs a STABLE PREFIX. The spec is identical every turn; the modules grow. Putting
  //      the growing part last keeps the cached prefix intact, so appending knowledge mid-call does
  //      not throw the cache away for the rest of the call.
  //   2. PRECEDENCE. The persona's rules are the floor. Knowledge informs what Thomas SAYS, never
  //      what he is ALLOWED to say, and a module cannot override a spec rule it comes after.
  //
  // ★ THIS BLOCK IS WHY THE LOADER EXISTS AT ALL. brain-modules.mjs shipped ORPHANED — nothing
  // imported it, so a caller could say "my water heater is leaking" and the trades knowledge sat on
  // disk unread. Built, wired and never fed, in my own work, one commit after writing a comment
  // warning about exactly that. The modules are only real from this line down.
  const fresh = modulesFor(lastUser, moduleState(inMsgs));
  for (const m of fresh) system += '\n\n' + m.text;
  if (fresh.length) console.log(`answered-brain: loaded knowledge [${fresh.map((m) => m.name).join(', ')}] for ${persona.id}`);

  if (incomingSystem) system += '\n\n' + noteHeader(persona) + '\n' + fitOwnerNotes(incomingSystem, persona, calleeNumber(body, incomingSystem));
  if (assistantTurns >= persona.softCloseAt) system += '\n\n' + persona.softCloseNote;

  const offered = offeredTools(persona, body, inMsgs);
  // The one fact the output guard cannot read out of the model's own words. See the note above
  // BOOKED_CLAIM_RE in lib/personas.mjs: this is what stops "you are all set" from being said on a
  // call where nothing was ever written down.
  // ★ THE SECOND FACT: does this business actually call people back? The persona rule permits the
  // voice to say the owner will call back ONLY WHEN THE OWNER'S NOTES SAY THAT IS WHAT HAPPENS, so
  // the floor that enforces it has to know. Read from the notes the owner wrote, never inferred from
  // the conversation and never defaulted to true: no notes means the floor runs at full strength and
  // the voice takes a number instead of promising a call. That is the safe direction, and it is the
  // one that is honest on a business we know nothing about.
  const guardState = {
    booked: bookedAlready(inMsgs),
    callbackOk: notesAuthorizeCallback(incomingSystem),
  };

  const messages = toAnthropicMessages(inMsgs);

  // ★ THE VENDOR DECLARED A TOOL AND THEN DID NOT RUN IT. This is the failure that would make the
  // voice lie: a book_job call sits in the history, nothing answered it, and the model is one turn
  // away from telling somebody their visit is on the schedule. So the bridge runs it, on the same
  // authenticated idempotent endpoint the vendor would have used, and the answer goes into the
  // conversation where the model can read it. Running it twice is safe by construction: the
  // idempotency key is built from the facts of the job, so a second attempt replays the first.
  const orphan = orphanToolCall(inMsgs);
  if (orphan) {
    let note = null;
    try {
      note = await runToolInline(orphan, conversationId);
      console.error('answered-brain: the vendor left a ' + toolName(orphan) + ' call unanswered; this bridge ran it. conversation=' + (conversationId || 'unknown'));
    } catch (e) {
      console.error('answered-brain: could not recover an unanswered ' + toolName(orphan) + ' call: ' + String(e && e.message).slice(0, 160));
    }
    // Either way the model is told the truth. An unknown outcome is spoken as an unknown outcome,
    // never as a booking, because "we could not check" and "it worked" are different facts.
    messages.push({
      role: 'user',
      content: TOOL_NOTE + ' ' + (note || 'NOT CONFIRMED. Nothing came back from the scheduling system, so do not tell the caller the visit is booked. Say you could not confirm it and offer to take it again.'),
    });
  }

  const maxTokens = offered.anthropic.length ? (persona.toolMaxTokens || persona.maxTokens) : persona.maxTokens;
  const shared = { apiKey, system, messages, maxTokens, tools: offered.anthropic };
  const primaryReq = { ...shared, model: MODEL_PRIMARY, temperature: persona.temperature };
  const backupReq = { ...shared, model: MODEL_BACKUP, disableThinking: true };

  // ── buffered path (gate probes, diagnostics) ──
  if (!wantsStream) {
    let text = '';
    let tool = null;
    try {
      const got = await askAnthropic({ ...primaryReq, stream: false });
      text = got.text; tool = got.tool;
    } catch (e) {
      console.error('answered-brain primary failed (buffered):', String(e && e.message).slice(0, 160));
      try {
        const got = await askAnthropic({ ...backupReq, stream: false });
        text = got.text; tool = got.tool;
      } catch (e2) {
        console.error('answered-brain backup failed too (buffered):', String(e2 && e2.message).slice(0, 160));
      }
    }
    if (tool && offered.names.includes(tool.name)) {
      if (!tool.input || typeof tool.input !== 'object' || Array.isArray(tool.input)) {
        console.error('answered-brain: ' + persona.id + ' produced ' + tool.name + ' arguments this bridge could not parse; nothing was sent');
        return jsonCompletion(id, outModel, persona.toolFail, null);
      }
      const spokenNow = guardWhole(persona, text, ctxDigits, guardState) || persona.toolHold;
      return jsonCompletion(id, outModel, spokenNow, [toOpenAiToolCall(tool, conversationId, T0)]);
    }
    const finalText = guardWhole(persona, text, ctxDigits, guardState) || persona.breaker;
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
      let toolCall = null;   // the one action this turn is allowed to take
      let toolBroken = false; // the model asked for an action we could not parse

      const chunk = (delta, finish) => {
        if (!closed) controller.enqueue(encoder.encode(mk(delta, finish)));
      };
      const finish = (reason) => {
        if (closed) return;
        chunk({}, reason || 'stop');
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
      // Measured from the top of the REQUEST, not the top of the stream, because an orphan-tool
      // recovery above may already have spent some of the ten second ceiling.
      const budget = setTimeout(() => upstream.abort(), Math.max(2500, GEN_BUDGET_MS - (Date.now() - T0)));

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
          const g = guardClause(persona, out, ctxDigits, guardState);
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

      // ONE action per turn, on the allowlist, with arguments that parsed. Anything else is logged
      // loudly and dropped: a dropped action is a caller who has to repeat themselves, and a
      // half-understood action is a van at the wrong house.
      const onTool = (tu) => {
        if (toolCall || toolBroken || dead) return;
        if (!offered.names.includes(tu.name)) {
          console.error('answered-brain: ' + persona.id + ' tried to call ' + tu.name + ', which is not offered on this turn');
          return;
        }
        if (!tu.input || typeof tu.input !== 'object' || Array.isArray(tu.input)) {
          console.error('answered-brain: ' + persona.id + ' produced ' + tu.name + ' arguments this bridge could not parse; nothing was sent');
          toolBroken = true;
          return;
        }
        toolCall = [toOpenAiToolCall(tu, conversationId, T0)];
      };

      try {
        await askAnthropic({ ...primaryReq, stream: true, signal: upstream.signal, onDelta, onTool });
      } catch (e) {
        if (!dead && modelChars === 0 && !toolCall && !toolBroken) {
          console.error('answered-brain primary failed, trying backup:', String(e && e.message).slice(0, 160));
          try {
            await askAnthropic({ ...backupReq, stream: true, signal: upstream.signal, onDelta, onTool });
          } catch (e2) {
            console.error('answered-brain backup failed too:', String(e2 && e2.message).slice(0, 160));
          }
        }
      }
      clearTimeout(primer);
      clearTimeout(budget);
      if (!dead && buf.trim()) release(true);

      if (toolCall) {
        // Nothing said yet means the model went straight for the tool. The caller must not sit in
        // silence while a booking is written, and the holding line is the one sentence that covers
        // this moment without claiming anything: it says a thing is being done, not that it is done.
        if (!spoken.trim() || spoken.trim() === ackText.trim()) say(persona.toolHold);
        chunk({ tool_calls: toolCall });
        console.log('answered-brain: ' + persona.id + ' called ' + toolCall[0].function.name + ' (conversation ' + (conversationId || 'unknown') + ')');
        finish('tool_calls');
        return;
      }
      if (toolBroken) {
        // The model asked to book and this bridge could not read the request. Nothing was sent, so
        // the turn ends on the sentence that says exactly that, whatever else was said first.
        say(persona.toolFail);
        finish();
        return;
      }

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
    '/api/answered-brain/customer-es',
    '/api/answered-brain/customer-es/chat/completions',
  ],
};
