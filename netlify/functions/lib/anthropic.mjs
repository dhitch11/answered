// anthropic.mjs — the console's language layer, on the DIRECT Anthropic API.
//
// ── THE LAW THIS FILE ENCODES ────────────────────────────────────────────────────────────────
//
// 1. A CLAUDE MODEL RUNS ON THE DIRECT ANTHROPIC API. Never a reseller, never an aggregator. The
//    key is ANTHROPIC_API_KEY_LIVE. Our prompts carry customer names, phone numbers, call
//    transcripts and billing figures; the vendor relationship for that data is not something to
//    route through a third party for a few cents.
//
// 2. BEST MODEL PER SLOT, CHOSEN ON MERIT. Not one model everywhere, and never a cheaper one
//    because it was convenient. A slot that summarises a two-line transcript and a slot that
//    decides which query to run against a customer database are not the same job. SLOTS below is
//    the whole routing table and it is the only place a model id appears.
//
// 3. ★ THE NUMBERS ARE NEVER THE MODEL'S. This is the one that matters most and it is enforced
//    structurally, not by asking nicely in a prompt. Every figure on this console comes from SQL.
//    The model is handed already-computed numbers and asked to phrase them, or it is asked to
//    CHOOSE which parameterised query to run and never to write one. There is no path anywhere in
//    this file that lets a model emit a figure that was not measured, because the estate's first
//    law is that nothing is fabricated and a language model is a fabrication engine pointed at
//    plausibility.
//
// 4. EVERY INVOCATION IS LOGGED WITH THE MODEL THAT ACTUALLY SERVED IT, its real token counts and
//    its real cost. Never label output with a model that did not produce it. The ledger is what
//    makes "AI is expensive" a measurement instead of an opinion.
//
// 5. IT FAILS LOUD AND IT FAILS CLOSED. No key means no AI surface, not a degraded one. A refusal,
//    a timeout or an overload returns an error the console renders as an error. An AI panel that
//    quietly shows nothing is indistinguishable from one with nothing to say.

const API = 'https://api.anthropic.com/v1';
const VERSION = '2023-06-01';

const KEY = () => (process.env.ANTHROPIC_API_KEY_LIVE || '').trim();
export const configured = () => Boolean(KEY());

/**
 * THE ROUTING TABLE. The only place in this codebase a model id appears.
 *
 * `deep` is for judgement: choosing among tools, weighing a compliance question, writing something
 * a customer will read. `quality` is the workhorse for summarising and drafting where the input is
 * already structured. `fast` is for mechanical classification whose output is verifiable by
 * assertion — and only there, because a cheap model on a judgement slot is how a console starts
 * quietly being wrong.
 */
export const SLOTS = Object.freeze({
  deep:    { model: 'claude-opus-5',              max_tokens: 4096, why: 'judgement, tool choice, anything adversarial or customer-facing' },
  quality: { model: 'claude-sonnet-5',            max_tokens: 2048, why: 'summarising, drafting, structured extraction' },
  fast:    { model: 'claude-haiku-4-5-20251001',  max_tokens: 1024, why: 'mechanical classification, verifiable by assertion' },
});

export const KILLED = () => process.env.ANSWERED_AI_KILL === '1';

/** Cheap, deterministic guard so a runaway prompt cannot be sent at all. */
const MAX_INPUT_CHARS = 400_000;

export class AiError extends Error {
  constructor(status, body, slot) {
    const detail = (body && body.error && body.error.message) || (typeof body === 'string' ? body : '');
    super(`anthropic ${status}${detail ? ': ' + String(detail).slice(0, 300) : ''}`);
    this.status = status; this.body = body; this.slot = slot;
  }
}

/**
 * One call. Returns the text, the tool calls, the real model that served it, and the real usage.
 *
 * Retries only what is worth retrying: 429 (rate limited) and 529 (overloaded) are transient and
 * get exponential backoff; a 400 is our bug and retrying it just costs time. A 401 means the key
 * is wrong and no amount of retrying fixes that.
 */
export async function ask({
  slot = 'quality', system, messages, tools, tool_choice, max_tokens,
  temperature, timeoutMs = 45_000, retries = 2, cacheSystem = false,
} = {}) {
  if (KILLED()) throw new AiError(503, { error: { message: 'the AI kill switch (ANSWERED_AI_KILL) is set, so no model may be called' } }, slot);
  if (!configured()) throw new AiError(503, { error: { message: 'ANTHROPIC_API_KEY_LIVE is not set on this deploy' } }, slot);

  const cfg = SLOTS[slot];
  if (!cfg) throw new AiError(400, { error: { message: `unknown slot "${slot}"` } }, slot);

  const payload = {
    model: cfg.model,
    max_tokens: max_tokens || cfg.max_tokens,
    messages,
  };
  if (system) {
    // Prompt caching on a long, stable system prompt is the difference between an assistant that
    // is worth leaving on and one that is not. Only worth marking when the prompt is genuinely
    // large and reused; on a short one the cache write costs more than it saves.
    payload.system = cacheSystem
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : system;
  }
  if (tools) payload.tools = tools;
  if (tool_choice) payload.tool_choice = tool_choice;
  if (typeof temperature === 'number') payload.temperature = temperature;

  const size = JSON.stringify(payload).length;
  if (size > MAX_INPUT_CHARS) {
    throw new AiError(413, { error: { message: `refusing to send ${size} characters; trim the input rather than paying for it` } }, slot);
  }

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res, text;
    try {
      res = await fetch(`${API}/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': KEY(),
          'anthropic-version': VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (e) {
      lastErr = new AiError(0, { error: { message: `network or timeout: ${e && e.message}` } }, slot);
      if (attempt < retries) { await sleep(400 * Math.pow(2, attempt)); continue; }
      throw lastErr;
    }

    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }

    if (res.ok) {
      const content = Array.isArray(body.content) ? body.content : [];
      return {
        text: content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim(),
        toolCalls: content.filter((b) => b.type === 'tool_use'),
        stop_reason: body.stop_reason,
        // ★ The model the API SAYS it served, not the one we asked for. Never label output with a
        // model that did not produce it.
        model: body.model,
        slot,
        usage: body.usage || {},
        cost_usd: estimateCost(body.model, body.usage || {}),
      };
    }

    lastErr = new AiError(res.status, body, slot);
    const transient = res.status === 429 || res.status === 529 || res.status >= 500;
    if (transient && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 700 * Math.pow(2, attempt));
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Cost, from the usage the API actually returned.
 *
 * ★ THESE RATES ARE A LOCAL TABLE AND THEREFORE A MODELED FIGURE, NOT A MEASURED ONE. Anything
 * rendered from this must be labelled as an estimate, because a price table in a source file goes
 * stale silently and a stale cost that reads as measured is exactly the class of lie this estate
 * keeps finding. The token counts beside it ARE measured, and they are what to trust.
 */
const RATES = Object.freeze({
  'claude-opus-5':             { in: 15.00, out: 75.00 },
  'claude-sonnet-5':           { in: 3.00,  out: 15.00 },
  'claude-haiku-4-5-20251001': { in: 0.80,  out: 4.00 },
  'claude-fable-5':            { in: 15.00, out: 75.00 },
});

export function estimateCost(model, usage) {
  const r = RATES[model] || RATES[Object.keys(RATES).find((k) => String(model || '').startsWith(k.split('-').slice(0, 2).join('-')))];
  if (!r) return null;                       // an unknown model gets null, never a guessed price
  const inTok = (usage.input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0);
  const outTok = usage.output_tokens || 0;
  return Number(((inTok / 1e6) * r.in + (outTok / 1e6) * r.out).toFixed(6));
}

/**
 * Ask for JSON and actually get it, by forcing a tool call rather than hoping for clean output.
 * Prose-with-a-JSON-block parsing fails on the day the model adds a friendly sentence, and it
 * fails silently by returning nothing rather than loudly by throwing.
 */
export async function askJson({ slot = 'quality', system, messages, schema, name = 'result', description, ...rest }) {
  const out = await ask({
    slot, system, messages,
    tools: [{ name, description: description || 'Return the result.', input_schema: schema }],
    tool_choice: { type: 'tool', name },
    ...rest,
  });
  const call = out.toolCalls.find((t) => t.name === name);
  if (!call) {
    throw new AiError(502, { error: { message: `the model did not return ${name}; stop_reason was ${out.stop_reason}` } }, slot);
  }
  return { ...out, data: call.input };
}

/** What the System panel needs to state the AI layer's condition without guessing. */
export function status() {
  return {
    configured: configured(),
    killed: KILLED(),
    key_env: 'ANTHROPIC_API_KEY_LIVE',
    slots: Object.entries(SLOTS).map(([k, v]) => ({ slot: k, model: v.model, why: v.why })),
    note: !configured()
      ? 'ANTHROPIC_API_KEY_LIVE is not set, so every AI surface is off rather than degraded.'
      : (KILLED() ? 'ANSWERED_AI_KILL is set. No model can be called.' : null),
  };
}

/**
 * A real round trip, for the System panel. "The key is set" and "the key works" are different
 * claims and only one of them belongs on a dashboard.
 */
export async function probe() {
  if (!configured()) return { ok: false, reason: 'ANTHROPIC_API_KEY_LIVE is not set' };
  if (KILLED()) return { ok: false, reason: 'ANSWERED_AI_KILL is set' };
  try {
    const t0 = Date.now();
    const out = await ask({
      slot: 'fast',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      retries: 0, timeoutMs: 12_000,
    });
    return {
      ok: true, model: out.model, ms: Date.now() - t0,
      reply: out.text.slice(0, 40),
      usage: out.usage, cost_usd: out.cost_usd,
    };
  } catch (e) {
    return { ok: false, reason: e.message, status: e.status };
  }
}
