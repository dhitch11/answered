// POST /api/answered-tool?tool=book_job — THE HANDS. This is the endpoint that turns a phone call
// into a row somebody drives to.
//
// Everything else on this site argues that a missed call can become a booked job. `/api/booking`
// makes a booking real. This file is the seam between them, and until it existed the demo line
// could take a name, an address, a number and a window, say something warm, and write NOTHING.
// Measured on the live agent before this shipped: `tool_ids: []`, `tools: []`, every
// `built_in_tools` entry null. The voice had no hands.
//
// THE CHAIN, END TO END:
//   Twilio  ->  /api/answered-voice  ->  ElevenLabs ConvAI agent  ->  (custom LLM)
//   /api/answered-brain  ->  Anthropic decides to call book_job  ->  ElevenLabs runs THIS webhook
//   ->  /api/booking  ->  Resend to the shop, HubSpot contact + note + task, signed job link
//   ->  a sentence comes back here  ->  Riley says it in her own words.
//
// ★ WHY THIS ANSWERS 200 WITH `ok:false` INSTEAD OF A 4xx WHEN A BOOKING IS REFUSED, and why that
// is NOT the fail-open 200 this estate keeps paying for. A non-2xx makes the vendor hand the model
// a generic "the tool failed" and the caller hears whatever the model invents around it. A 200
// carrying an explicit `booked:false` and a written sentence makes the voice say the true thing.
// So the rule here is not about the status code, it is about the body: NOTHING in this file emits a
// sentence containing the word booked unless `/api/booking` returned 201. The protocol failures
// that are not a booking outcome at all (wrong method, no credential, unparseable body, unknown
// tool) still answer 405 / 401 / 400 / 404, loudly.
//
// ★ IDEMPOTENCY IS A DATABASE ROW, NOT A CACHE. ElevenLabs retries a server tool that times out and
// a model can decide to call the same tool twice to be helpful. Either one sends a second van. A
// module-scope Map does not fix it, because the retry frequently lands on a cold instance that has
// never seen the first call. So the claim is `sv_tool_claim`, whose lock is a unique index, and a
// retry replays the stored result instead of acting. The one deliberate exception is written into
// the RPC: an unsettled claim older than ninety seconds is TAKEN OVER, because a run that died
// mid-flight must not wedge that caller out of ever being booked.
//
// ★ WHAT HAPPENS WHEN THE SPINE IS DOWN. The claim is best effort and the booking is not. If the
// database cannot be reached, this books the job anyway and says so in the response
// (`idempotency: "best effort"`). A duplicate visit is a phone call to fix. A visit that was never
// written down is the exact failure the entire product exists to prevent.
//
// Auth: Authorization: Bearer <ANSWERED_BOOKING_SECRET | ANSWERED_COCKPIT_KEY | ANSWERED_BRAIN_SECRET>
// via lib/bearer.mjs. The third is the credential ElevenLabs holds, and lib/bearer explains at
// length why booking is the one thing that secret is legitimately for.
//
// Env, by NAME only:
//   ANSWERED_BOOKING_SECRET / ANSWERED_COCKPIT_KEY / ANSWERED_BRAIN_SECRET   who may call this
//   ANSWERED_DB_URL / _ANON / _SECRET   the idempotency claim. Unset degrades loudly, never silently
//   ANSWERED_SITE_URL / URL             which origin /api/booking is reached on
//   ANSWERED_DEMO_NUMBER                the shop's own number, so the job page has a real tel: link

import * as tools from './lib/tools.mjs';
import { siteOrigin } from './lib/booking.mjs';
import { authorize } from './lib/bearer.mjs';
import * as db from './lib/db.mjs';

const MAX_BODY = 8 * 1024;
const BOOKING_TIMEOUT_MS = 15000;
const CLAIM_TIMEOUT_MS = 2500;
// An in-flight twin is rare (the vendor only retries after its own timeout) but it must never be
// answered by booking again. Wait a little for the first attempt to land, then say so honestly.
const INFLIGHT_POLL_MS = 700;
const INFLIGHT_TRIES = 6;

const json = (status, obj) => new Response(JSON.stringify(obj, null, 2), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The strongest credential this deploy actually has, for the hop to /api/booking. */
function bookingCredential() {
  for (const n of ['ANSWERED_BOOKING_SECRET', 'ANSWERED_COCKPIT_KEY', 'ANSWERED_BRAIN_SECRET']) {
    const v = String(process.env[n] || '').trim();
    if (v) return { name: n, value: v };
  }
  return null;
}

/**
 * Claim the key. Returns what to do next and never throws: a spine that is down degrades this to
 * best-effort idempotency, LOUDLY, rather than refusing to book.
 */
async function claim(key, clean, conversationId, callSid) {
  if (!db.dbConfigured()) {
    console.error('answered-tool: ANSWERED_DB_* not set, so idempotency is best effort on this deploy');
    return { mode: 'best effort', reason: 'the call spine is not configured on this deploy' };
  }
  try {
    const r = await db.rpc('sv_tool_claim', {
      p_key: key,
      p_tool: tools.BOOK_TOOL,
      p_conversation: conversationId || null,
      p_call_sid: callSid || null,
      p_args: clean,
    }, { timeoutMs: CLAIM_TIMEOUT_MS });
    if (r && r.claimed) return { mode: 'claimed', tookOver: !!r.took_over };
    return { mode: 'replay', status: (r && r.status) || 'unknown', result: r && r.result };
  } catch (e) {
    console.error(`answered-tool: idempotency claim FAILED, booking anyway with best-effort dedupe: ${String((e && e.message) || e).slice(0, 160)}`);
    return { mode: 'best effort', reason: 'the call spine could not be reached' };
  }
}

async function settle(key, status, result) {
  if (!db.dbConfigured()) return;
  try {
    await db.rpc('sv_tool_settle', { p_key: key, p_status: status, p_result: result }, { timeoutMs: CLAIM_TIMEOUT_MS });
  } catch (e) {
    // The job is already booked at this point. Losing the ledger write means a retry could book a
    // second one, which is worth a loud line and is not worth failing the caller's booking over.
    console.error(`answered-tool: could not settle claim ${key.slice(0, 12)}: ${String((e && e.message) || e).slice(0, 160)}`);
  }
}

/** Wait for a twin that is mid-flight, so a retry never books a second van. */
async function awaitTwin(key) {
  for (let i = 0; i < INFLIGHT_TRIES; i += 1) {
    await sleep(INFLIGHT_POLL_MS);
    try {
      const r = await db.rpc('sv_tool_claim', {
        p_key: key, p_tool: tools.BOOK_TOOL, p_conversation: null, p_call_sid: null, p_args: null,
      }, { timeoutMs: CLAIM_TIMEOUT_MS });
      if (r && r.replay && r.status && r.status !== 'running') return r;
    } catch (e) { /* the loop below reports the honest unknown */ }
  }
  return null;
}

// ── the one tool that exists today ──────────────────────────────────────────────────────────────

async function bookJob(args, meta) {
  const norm = tools.normalizeBooking(args);
  if (!norm.ok) {
    // NOT a failure of this endpoint. The model was asked for five things and does not have all
    // five, or filled one in itself. Either way nothing is written and Riley is told what to ask
    // for. This is the branch that stops "123 Main Street" becoming a real address.
    console.error(`answered-tool book_job refused: missing=${norm.missing.join('|')} problems=${norm.problems.join('|')}`);
    return json(200, {
      ok: false,
      booked: false,
      result: tools.RESULTS.missing(norm.missing),
      still_needed: norm.missing,
      problems: norm.problems,
    });
  }
  const clean = norm.clean;
  const key = tools.idemKey(clean, meta.conversationId);

  const held = await claim(key, clean, meta.conversationId, meta.callSid);
  if (held.mode === 'replay') {
    if (held.status === 'running') {
      const late = await awaitTwin(key);
      if (!late) {
        console.error(`answered-tool book_job: a twin for ${key.slice(0, 12)} is still in flight; refusing to book twice`);
        return json(200, {
          ok: false,
          booked: false,
          in_flight: true,
          result: [
            'NOT CONFIRMED. Another attempt to write this exact visit down is still going,',
            'so this one did nothing rather than book it twice.',
            'Tell the caller you are just making sure it went through, then try once more in a moment.',
          ].join(' '),
        });
      }
      held.status = late.status;
      held.result = late.result;
    }
    const prior = held.result || {};
    if (held.status === 'done' && prior.ok) {
      console.log(`answered-tool book_job REPLAY of ${prior.id} (idem ${key.slice(0, 12)})`);
      return json(200, { ok: true, booked: true, replay: true, result: tools.RESULTS.replayed(clean.spoken_window) });
    }
    // the earlier attempt failed; let this one try again rather than inheriting a failure
    console.error(`answered-tool book_job: prior attempt on ${key.slice(0, 12)} did not book; retrying`);
  }

  const cred = bookingCredential();
  if (!cred) {
    console.error('answered-tool: no booking credential configured, so nothing can be written down');
    await settle(key, 'failed', { ok: false, reason: 'no booking credential configured' });
    return json(200, { ok: false, booked: false, result: tools.RESULTS.failed });
  }

  const body = {
    shop_name: tools.DEMO_SHOP,                       // server constant: the model cannot name the shop
    shop_phone: String(process.env.ANSWERED_DEMO_NUMBER || '').trim() || undefined,
    customer_name: clean.customer_name,
    customer_phone: clean.customer_phone,
    address: clean.address,
    service: clean.service,
    starts_at: clean.starts_at,                       // server clock: the model cannot name a date
    minutes: tools.VISIT_MINUTES,
    tz: tools.SHOP_TZ,
    notes: clean.notes || undefined,
    mode: 'demo',                                     // server constant: the demo line is always demo
    source: `answered-brain/riley/${tools.BOOK_TOOL}`,
  };

  let res;
  let payload = null;
  try {
    res = await fetch(`${siteOrigin()}/api/booking`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cred.value}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(BOOKING_TIMEOUT_MS),
    });
    payload = await res.json().catch(() => null);
  } catch (e) {
    console.error(`answered-tool book_job: /api/booking unreachable: ${String((e && e.message) || e).slice(0, 160)}`);
    await settle(key, 'failed', { ok: false, reason: String((e && e.message) || e).slice(0, 200) });
    return json(200, { ok: false, booked: false, result: tools.RESULTS.failed });
  }

  if (res.status !== 201 || !payload || payload.ok !== true) {
    console.error(`answered-tool book_job NOT BOOKED: /api/booking ${res.status} ${JSON.stringify(payload || {}).slice(0, 300)}`);
    await settle(key, 'failed', { ok: false, status: res.status, body: payload });
    return json(200, { ok: false, booked: false, upstream_status: res.status, result: tools.RESULTS.failed });
  }

  // The full /api/booking response is stored verbatim, so the written record of this call can be
  // read back later without trusting anybody's summary of it.
  await settle(key, 'done', payload);
  console.log(`answered-tool book_job BOOKED ${payload.id} for ${clean.spoken_window} (idem ${key.slice(0, 12)}, ${held.mode})`);

  return json(200, {
    ok: true,
    booked: true,
    // Deliberately NOT in `result`: the job id and the link both carry digits, and Riley's numeral
    // firewall blocks any digit the caller did not say first. A job number in the sentence the
    // model reads comes back out of the guard as a pivot in the middle of the confirmation.
    job_id: payload.id,
    job_url: payload.url,
    idempotency: held.mode,
    result: tools.RESULTS.booked(clean.spoken_window),
  });
}

// ── the handler ─────────────────────────────────────────────────────────────────────────────────

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { Allow: 'POST, OPTIONS' } });
  if (req.method !== 'POST') {
    return json(405, {
      ok: false,
      error: 'POST only.',
      how: `POST /api/answered-tool?tool=${tools.BOOK_TOOL} with Authorization: Bearer <secret> and the tool's declared parameters as JSON.`,
      tools: [tools.BOOK_TOOL],
    });
  }

  const auth = authorize(Object.fromEntries(req.headers.entries()));
  if (!auth.ok) return json(auth.status, { ok: false, error: auth.message });

  let raw = '';
  try { raw = await req.text(); } catch { return json(400, { ok: false, error: 'Could not read the request body.' }); }
  if (raw.length > MAX_BODY) return json(413, { ok: false, error: `Body is over the ${MAX_BODY} byte cap.` });

  let input;
  try { input = JSON.parse(raw || '{}'); } catch { return json(400, { ok: false, error: 'Body must be JSON.' }); }
  if (!input || typeof input !== 'object') return json(400, { ok: false, error: 'Body must be a JSON object.' });

  // ElevenLabs sends only the DECLARED parameters in the body, never the tool name, so the name
  // travels in the URL. The reference implementation in the estate learned this the same way.
  let url;
  try { url = new URL(req.url); } catch { url = null; }
  const fromPath = url && /\/api\/answered-tool\/([a-z_]+)$/.exec(url.pathname);
  const tool = String(
    (url && url.searchParams.get('tool')) || (fromPath && fromPath[1]) || input.tool || input.name || '',
  ).trim();

  // Some vendors nest the arguments. Take the nest when it is there, the body when it is not.
  const args = (input.parameters && typeof input.parameters === 'object') ? input.parameters
    : (input.arguments && typeof input.arguments === 'object') ? input.arguments
      : input;

  const meta = {
    conversationId: String(input.conversation_id || args.conversation_id || input.conversationId || '').trim().slice(0, 120),
    callSid: String(input.call_sid || args.call_sid || '').trim().slice(0, 40),
    authorizedBy: auth.as,
  };

  if (tool === tools.BOOK_TOOL) return bookJob(args, meta);

  console.error(`answered-tool: no tool named ${JSON.stringify(tool).slice(0, 60)}`);
  return json(404, { ok: false, error: `This server has no tool named ${JSON.stringify(tool)}.`, tools: [tools.BOOK_TOOL] });
};

// ★★ STATIC LITERAL, for the same reason answered-brain.mjs says so at length: Netlify reads a v2
// function's `config` export by STATIC ANALYSIS at bundle time and silently drops anything it has
// to execute. A computed path array is not an error and not a warning, it is a 404 on the route
// you declared and a live default route you did not. It cost this repo an outage on 2026-08-14.
export const config = {
  path: ['/api/answered-tool', '/api/answered-tool/book_job'],
};
