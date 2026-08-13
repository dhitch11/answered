// /api/answered-brain (plus the /chat/completions suffix ElevenLabs appends to a
// custom LLM server URL). The Answered demo line's reasoning bridge: an
// OpenAI-compatible chat/completions request comes in, an SSE token stream goes
// out, and a clause-buffered guard loop stands between the model and the
// caller's ear. Forked from the reimburseos convai-llm-stream.mjs SHAPE only;
// nothing here imports from that repo at runtime, and the persona plus every
// floor live in this one file.
//
// Env, by NAME only, all fail closed:
//   ANSWERED_BRAIN_SECRET    Bearer auth on every request. Missing means a loud
//                            500 on every call. Wrong or absent bearer is 401.
//   ANTHROPIC_API_KEY_LIVE   direct Anthropic key (never ANTHROPIC_API_KEY,
//                            that org is disabled). Missing means the warm ping
//                            reports 503 (so /api/demo-health goes red and no
//                            dialable control renders) and any live turn speaks
//                            the honest breaker line instead of dead air.
//
// Reasoning chain: claude-haiku-4-5-20251001 first, claude-sonnet-5 on failure,
// both on the direct Anthropic API. The backup call carries NO temperature
// (Sonnet 5 rejects non-default sampling params) and disables thinking so a
// 120-token spoken turn is not eaten by a reasoning budget.
//
// The warm ping ({"warm": true} with the bearer) answers 200 without spending a
// single model token. It proves route + auth + key config, which is exactly
// what the demo-health brain_ready probe needs; a probe that burned tokens on
// every 60s health pass would be a slow leak, and a probe that skipped auth
// would prove nothing.

import { createHash, timingSafeEqual } from 'node:crypto';

const GEN_BUDGET_MS = 8400; // inside Netlify's 10s stream ceiling, closes at the last clean clause
const MAX_TOKENS = 120; // about 40 spoken words plus headroom for the guard to trim
const TEMPERATURE = 0.6; // primary model only; the backup call omits it on purpose
const MODEL_PRIMARY = 'claude-haiku-4-5-20251001';
const MODEL_BACKUP = 'claude-sonnet-5';
const SENTENCE_CAP = 2; // floor (h): spoken turns stay short
const WORD_CAP = 45;
const SOFT_CLOSE_AT = 8; // floor (j): after ~8 exchanges, steer toward goodbye
const HARD_CLOSE_AT = 11; // deterministic goodbye, no model involved

// ── THE PERSONA. It lives HERE and nowhere else. ────────────────────────────
const RILEY_SPEC = `You are Riley, the receptionist on the Answered demo line. You answer as Cedar Ridge Plumbing and Air, a clearly fictional demo shop. The caller is usually a contractor testing the product, so give them the real experience: warm, quick, useful.

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

// ── FLOORS, output side. Deterministic, run on every clause BEFORE it streams.
// A blocked clause ends the turn: the pivot is spoken, nothing after it is.
const PRICE_RE = /\$|\b(?:dollars?|bucks|cents)\b/i;
const PRICE_PIVOT = 'The office quotes prices, I only book the visit. Want me to grab you a window?';

const CONTACT_RE = /\b(?:i(?:'ll| will| can| am going to)? (?:text|email) you|(?:send|shoot)(?: you)?(?: a| an)? (?:text|sms|email)|text (?:you|that|it|this)|email (?:you|that|it|this)|call you (?:right )?back|ring you back|give you a (?:call|ring) back|(?:someone|the office|the team|we)(?: else)?(?:'ll| will) (?:call|text|email) you)\b/i;
const CONTACT_PIVOT = "I handle the whole thing right here on the call, so let's just knock it out now.";

const AI_DENY_RE = /\b(?:i(?:'m| am) (?:a real|an actual|a) (?:person|human)|i(?:'m| am) not (?:an? )?(?:ai|automated|artificial|a machine|a computer|a bot)|definitely (?:human|a person)|not automated)\b/i;
const AI_HONEST_PIVOT = "To be straight with you, I'm an AI receptionist on the Answered demo line. Now, where were we with that visit?";

const PAYMENT_OUT_RE = /\b(?:card number|credit card|debit card|social security|ssn|cvv|routing number|billing info|payment info|pay (?:over|on) the phone)\b/i;
const PAYMENT_PIVOT = 'No payment talk on this line. A name, an address, and a good number books the visit.';

const DAY_RE = /\b(?:monday|thursday|friday|saturday|sunday)\b/i;
const SLOT_PIVOT = "Here's what I have: Tuesday at eight in the morning, Tuesday at one thirty, or Wednesday at nine. Which one works?";

// floor (e), the numeral firewall: the only digits Riley may speak are the
// three fixed windows (and 911, which only the crisis line ever says) plus
// whatever digits the caller said first (read-backs of their own number or
// address). Everything else is a fabrication and the turn pivots.
const NUM_ALLOW = new Set(['8', '800', '1', '130', '9', '900', '30', '00', '911']);
function badNumeral(text, ctxDigits) {
  const toks = String(text).match(/\d[\d:.,-]*/g) || [];
  for (const t of toks) {
    const d = t.replace(/\D+/g, '');
    if (!d) continue;
    if (NUM_ALLOW.has(d)) continue;
    if (ctxDigits && ctxDigits.includes(d)) continue;
    return t;
  }
  return null;
}

function guardClause(text, ctxDigits) {
  if (PRICE_RE.test(text)) return { ok: false, by: 'price', pivot: PRICE_PIVOT };
  if (CONTACT_RE.test(text)) return { ok: false, by: 'contact-promise', pivot: CONTACT_PIVOT };
  if (AI_DENY_RE.test(text)) return { ok: false, by: 'ai-denial', pivot: AI_HONEST_PIVOT };
  if (PAYMENT_OUT_RE.test(text)) return { ok: false, by: 'payment', pivot: PAYMENT_PIVOT };
  if (DAY_RE.test(text)) return { ok: false, by: 'slot-invention', pivot: SLOT_PIVOT };
  if (badNumeral(text, ctxDigits)) return { ok: false, by: 'numeral', pivot: SLOT_PIVOT };
  return { ok: true };
}

// ── FLOORS, input side. Deterministic branches decided BEFORE any model call.
const CRISIS_RE = /\b(?:gas leak|smell(?:s|ing)? (?:like )?gas|carbon monoxide|co (?:alarm|detector)|on fire|house fire|fire in (?:the|my)|smoke (?:coming|pouring|filling|everywhere)|spark(?:s|ing)? (?:from|out of|in the)|flooding (?:right now|bad|fast)|actively flooding|water (?:pouring|gushing|shooting))\b/i;
const CRISIS_LINE = "That's an emergency, not a booking. Hang up and call 911 right now, or the gas company if you smell gas. We can talk once you're safe.";

const PAYMENT_IN_RE = /\b(?:card number|credit card|debit card|social security|ssn|cvv|routing number)\b|\b\d{13,16}\b/i;
const PAYMENT_IN_LINE = "Please don't read that out, I never take card or account numbers. A name, an address, and a good number is all a visit needs.";

// The bracketed [r] keeps a word Riley must never speak out of this file's own
// text, per the copy rule; the pattern still catches callers who say it.
// "are you real / a person / a machine" is the identity question; a bare
// "is this real" is the demo question and belongs to REAL_ASKED_RE below.
const AI_ASKED_RE = /\b(?:are you|am i (?:talking|speaking) (?:to|with))\b[^.!?]{0,50}\b(?:real|human|person|machine|computer|recording|automated|artificial|ai|bots?|[r]obots?)\b|\bis this (?:a |an )?(?:machine|computer|recording|ai|bots?|[r]obots?|real person|actual person|human)\b/i;
const AI_ASK_LINE = "I'm an AI receptionist, and this is Answered's demo line. Now, what's going on at your place?";

const REAL_ASKED_RE = /\bis this (?:real|for real|actually real|legit|a demo|the demo)\b|\b(?:did|will|would) (?:you|that|this) (?:really|actually) (?:book|schedule|happen)\b|\bis (?:that|the|this) (?:booking|appointment|visit) real\b/i;
const REAL_ASK_LINE = 'Straight answer: this is the demo line, the booking is pretend, the product is real. Want to play it through anyway?';

const ABUSE_RE = /\b(?:fuck\w*|shit\w*|asshole|bitch|bastard|dumbass|piece of (?:garbage|junk|crap)|stupid (?:bot|machine|thing))\b/gi;
const ABUSE_DIRECT_RE = /\byou(?:'re| are) (?:useless|worthless|garbage|trash|pathetic)\b/i;
const ABUSE_LINE = "I hear you, and I'm not going anywhere. We can keep working on it, or we can end the call here, your choice.";

const CLOSE_LINE = 'Alright, we should wrap up here. Thanks for calling Cedar Ridge Plumbing and Air, you take care now.';

// honest degradation when the whole model chain fails: no dead air, no promises
const BREAKER_LINE = "Well, that's embarrassing, my side of the demo just tripped over itself. Give me another ring in a minute and I'll be right here.";

function isAbusive(t) {
  const hits = (String(t).match(ABUSE_RE) || []).length;
  return hits >= 2 || ABUSE_DIRECT_RE.test(t);
}

function deterministicLine(lastUser, assistantTurns) {
  const t = String(lastUser || '');
  if (CRISIS_RE.test(t)) return { line: CRISIS_LINE, end: true }; // floor (f), end of branch
  if (PAYMENT_IN_RE.test(t)) return { line: PAYMENT_IN_LINE }; // floor (g)
  if (AI_ASKED_RE.test(t)) return { line: AI_ASK_LINE }; // floor (c), honest, never volunteered
  if (REAL_ASKED_RE.test(t)) return { line: REAL_ASK_LINE }; // floor (d)
  if (isAbusive(t)) return { line: ABUSE_LINE }; // floor (i)
  if (assistantTurns >= HARD_CLOSE_AT) return { line: CLOSE_LINE, end: true }; // floor (j)
  return null;
}

// instant-ack primer (forked mechanic): if nothing has streamed after 900ms,
// a short neutral lead-in lands so the caller never sits in dead air. Seeded
// per turn so it cannot become a fingerprint.
const ACK_BANK = ['Okay.', 'Sure.', 'Alright.', 'Yeah.', 'Got it.', 'Mm-hm.'];

// ── small forked helpers (clause boundary + sentence trim), kept lean ──────
const ABBREV = /(?:\b(?:dr|mr|mrs|ms|st|vs|etc|inc|llc|no)|\b[a-z])\.$/i;
function nextBoundary(buf) {
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
function trimToSentence(t) {
  const s = String(t || '').trim();
  if (!s) return s;
  if (/[.!?"')\]]$/.test(s)) return s;
  const m = s.match(/^[\s\S]*[.!?](?=\s|$)/);
  if (m && m[0].trim().length >= 20) return m[0].trim();
  return s;
}

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

// ── direct Anthropic caller, streaming and buffered ─────────────────────────
async function askAnthropic({ apiKey, model, system, messages, temperature, disableThinking, stream, signal, onDelta }) {
  const reqBody = { model, system, messages, max_tokens: MAX_TOKENS, stream: !!stream };
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
const OUT_MODEL = 'answered-riley';

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
}
function mkChunkFactory(id) {
  return (delta, finish) =>
    'data: ' +
    JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: OUT_MODEL,
      choices: [{ index: 0, delta, finish_reason: finish || null }],
    }) +
    '\n\n';
}
function jsonCompletion(id, text, toolCalls) {
  const message = { role: 'assistant', content: text };
  if (toolCalls) message.tool_calls = toolCalls;
  return json({
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: OUT_MODEL,
    choices: [{ index: 0, message, finish_reason: toolCalls ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}
function sseOneShot(id, text, toolCalls) {
  const mk = mkChunkFactory(id);
  let s = mk({ role: 'assistant', content: text });
  if (toolCalls) s += mk({ tool_calls: toolCalls });
  s += mk({}, toolCalls ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n';
  return new Response(s, { headers: SSE_HEADERS });
}

const sha = (s) => createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => timingSafeEqual(sha(a), sha(b));

function guardWhole(text, ctxDigits) {
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
      const g = guardClause(clause, ctxDigits);
      if (!g.ok) return (out ? out + ' ' : '') + g.pivot;
      out += (out ? ' ' : '') + clause;
      sentences += 1;
      if (sentences >= SENTENCE_CAP) break;
    }
    if (!rest.trim()) break;
  }
  return out;
}

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

  const apiKey = (process.env.ANTHROPIC_API_KEY_LIVE || '').trim();

  // warm ping: proves route + auth + key config without spending a model token
  if (body && body.warm === true) {
    if (!apiKey) {
      console.error('ANSWERED-BRAIN NOT READY: ANTHROPIC_API_KEY_LIVE is not set.');
      return json({ ok: false, reason: 'ANTHROPIC_API_KEY_LIVE not set' }, 503);
    }
    return json({ ok: true, warm: 'riley', ms: Date.now() - T0 });
  }

  const inMsgs = Array.isArray(body && body.messages) ? body.messages : [];
  const wantsStream = !!(body && body.stream === true);
  const id = 'chatcmpl-answered-' + Math.floor(T0 / 1000);

  const userTexts = inMsgs.filter((m) => m && m.role === 'user').map((m) => contentText(m.content));
  const lastUser = userTexts.length ? userTexts[userTexts.length - 1] : '';
  const ctxDigits = userTexts.join(' ').replace(/\D+/g, '');
  const assistantTurns = inMsgs.filter((m) => m && m.role === 'assistant' && contentText(m.content).trim().length > 1).length;

  const elTools = Array.isArray(body && body.tools) ? body.tools : [];
  const hasEndCall = elTools.some((t) => t && ((t.function && t.function.name === 'end_call') || t.name === 'end_call'));
  const endCallTC = [{ index: 0, id: 'call_end_' + Math.floor(T0 / 1000), type: 'function', function: { name: 'end_call', arguments: '{}' } }];

  // deterministic branches first: crisis, payment refusal, AI honesty, demo
  // honesty, abuse, hard close. No model, no drift, same answer every time.
  const det = deterministicLine(lastUser, assistantTurns);
  if (det) {
    const tc = det.end && hasEndCall ? endCallTC : null;
    return wantsStream ? sseOneShot(id, det.line, tc) : jsonCompletion(id, det.line, tc);
  }

  if (!apiKey) {
    console.error('ANSWERED-BRAIN DOWN: ANTHROPIC_API_KEY_LIVE is not set; speaking the honest breaker.');
    return wantsStream ? sseOneShot(id, BREAKER_LINE, null) : jsonCompletion(id, BREAKER_LINE, null);
  }

  // system prompt: persona first, then any notes from the call system, then the
  // wind-down nudge once the demo has run long. Persona rules always win.
  let system = RILEY_SPEC;
  const incomingSystem = inMsgs
    .filter((m) => m && m.role === 'system')
    .map((m) => contentText(m.content))
    .join('\n')
    .trim();
  if (incomingSystem) system += '\n\n## Notes from the call system (the rules above always win)\n' + incomingSystem.slice(0, 4000);
  if (assistantTurns >= SOFT_CLOSE_AT) {
    system += '\n\nThe demo call has run long. In your next reply or two, wrap up warmly: settle the held window if there is one, thank them, and say goodbye.';
  }

  const messages = toAnthropicMessages(inMsgs);
  const primaryReq = { apiKey, model: MODEL_PRIMARY, system, messages, temperature: TEMPERATURE };
  const backupReq = { apiKey, model: MODEL_BACKUP, system, messages, disableThinking: true };

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
    const finalText = guardWhole(text, ctxDigits) || BREAKER_LINE;
    return jsonCompletion(id, finalText, null);
  }

  // ── streaming path: clause-buffered guard loop ──
  const upstream = new AbortController();
  const encoder = new TextEncoder();
  const mk = mkChunkFactory(id);
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
          ackText = ACK_BANK[seed % ACK_BANK.length];
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
          const g = guardClause(out, ctxDigits);
          if (!g.ok) {
            // a blocked clause ends the turn: pivot spoken, nothing after it
            dead = true;
            upstream.abort();
            console.error('answered-brain guard fired:', g.by);
            say(g.pivot);
            return;
          }
          say(out);
          sentences += 1;
          if (sentences >= SENTENCE_CAP || spoken.split(/\s+/).length > WORD_CAP) {
            dead = true; // cadence cap, floor (h): the turn is complete
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
      if (!substantive) say(BREAKER_LINE); // chain exhausted: honest, never silent
      finish();
    },
    cancel() {
      upstream.abort();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
};

export const config = { path: ['/api/answered-brain', '/api/answered-brain/chat/completions'] };
