// hold.mjs — the Hold product's HTTP surface: the API, the customer's three pages, and the
// operator's console.
//
// @ANSWERED-BUILD owns /hold.html and every word on it. This file does not touch it. What this
// file does is make the thing that page describes exist and be reachable, at routes of its own:
//
//   GET  /hold/start            start an errand. The form the marketing page can point at.
//   GET  /hold/s/:token         watch it happen, live.
//   GET  /hold/receipt/:token   the Hold Receipt, rendered from the record, after it is over.
//   GET  /internal/hold         the operator console. Server-gated, and the human in the loop.
//   POST /api/hold              everything above, plus the operator's actions.
//
// ── AUTHENTICATION, AND WHY IT IS TWO DIFFERENT THINGS ───────────────────────────────────────
// A Hold customer has no account, no password and no card, which is the entire reason a stranger
// will use this at all. So the session token IS the credential for that one session, 192 bits of
// it, the same posture /api/truce already uses for a party link. Operator actions are a different
// door with a different key, and no token can ever reach one.
//
// ── WHAT THE CUSTOMER IS NEVER SHOWN ─────────────────────────────────────────────────────────
// hd_view in Postgres is the narrow read: no gate verdict, no consent id, no account key, no
// operator notes, and their own number reduced to four digits. A capability link gets forwarded,
// pasted into support threads and left open on shared screens, and none of those should hand over
// a phone number. The page cannot leak what it is never able to fetch.

import * as store from './lib/hold-store.mjs';
import * as policy from './lib/hold-policy.mjs';
import * as db from './lib/db.mjs';
import * as tw from './lib/twilio-rest.mjs';
import * as gate from './lib/gate-auth.mjs';
import { esc } from './lib/outbox.mjs';

const site = () => process.env.URL || 'https://answered.reddenda.com';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
};
const ok = (d) => new Response(JSON.stringify(d), { status: 200, headers: JSON_HEADERS });
const bad = (c, m, extra = {}) => new Response(JSON.stringify({ error: m, ...extra }), { status: c, headers: JSON_HEADERS });
const html = (body, status = 200, extraHeaders = {}) => new Response(body, {
  status,
  headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    ...extraHeaders,
  },
});

const E164 = policy.E164;
const clean = (v, max = 200) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const digitsOnly = (v) => String(v || '').replace(/\D/g, '');

/** A US number typed by a human, in any of the shapes humans type it. */
function toE164(raw) {
  const d = digitsOnly(raw);
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}

// ── the exact words somebody agrees to before we dial anything ───────────────────────────────
// ★ STORED VERBATIM, AS AGREED, NOT SUMMARISED. A consent record whose text was reconstructed
// afterwards from a template is not evidence of what this person actually saw.
export function consentText({ targetLabel, targetPhone, requesterPhone }) {
  return `I am asking Answered to call ${targetLabel} at ${targetPhone} for me, work the phone menu, `
    + `and wait on hold. When a person is on the line, Answered may call me back at ${requesterPhone} `
    + `to put me through. I understand an A I voice speaks on this call, that it says so out loud, `
    + `that the conversation is recorded from the moment a person answers, and that I can say stop `
    + `at any time to end calls to my number.`;
}

const operatorKey = () => (process.env.ANSWERED_ADMIN_KEY || process.env.ANSWERED_COCKPIT_KEY || '').trim();

function isOperator(req) {
  const want = operatorKey();
  if (!want) return false;
  const given = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (given && given.length === want.length) {
    let same = 0;
    for (let i = 0; i < want.length; i += 1) same |= given.charCodeAt(i) ^ want.charCodeAt(i);
    if (same === 0) return true;
  }
  const cookie = gate.readCookie(Object.fromEntries(req.headers.entries()), 'ans_hold');
  return gate.cookieValid('hold', cookie);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/api/hold') return api(req, url);
  if (path === '/hold/start') return startPage(url);
  if (path === '/internal/hold') return operatorConsole(req, url);

  let m = /^\/hold\/s\/([0-9a-f]{48})$/i.exec(path);
  if (m) return livePage(m[1]);
  m = /^\/hold\/receipt\/([0-9a-f]{48})$/i.exec(path);
  if (m) return receiptPage(m[1]);

  // A malformed token is told it is malformed rather than 404ing, so somebody who mangled a
  // pasted link knows which half of the problem is theirs.
  // Same reason as the 410 above: a 404 here is eaten by the static fallthrough, so a malformed
  // link would answer with a platform page rather than telling somebody what went wrong.
  if (/^\/hold\/(s|receipt)\//.test(path)) return html(shell('That link is not valid', notice('That is not a Hold link. Check you copied the whole thing, all forty eight characters of it.')), 400);
  return new Response('hold: no such route', { status: 404 });
};

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE API
// ═════════════════════════════════════════════════════════════════════════════════════════════
async function api(req, url) {
  if (req.method !== 'POST') return bad(405, 'POST only');
  if (!db.dbConfigured()) return bad(503, 'the Hold runtime is not configured on this deploy');

  let body = {};
  try { body = await req.json(); } catch { return bad(400, 'bad json'); }
  const op = clean(body.op, 40);

  switch (op) {
    case 'start':    return opStart(req, body, url);
    case 'view':     return opView(body);
    case 'cancel':   return opCancel(body);
    // operator only
    case 'list':     return opList(req, body);
    case 'session':  return opSession(req, body);
    case 'bridge':   return opCommand(req, body, 'bridge');
    case 'abandon':  return opCommand(req, body, 'abandon');
    case 'approve':  return opApprove(req, body);
    default:         return bad(400, `unknown op "${op.slice(0, 30)}"`);
  }
}

// ── start ────────────────────────────────────────────────────────────────────────────────────
async function opStart(req, body, url) {
  const target = toE164(body.target);
  const requester = toE164(body.callback);
  const targetLabel = clean(body.label, 90);
  const reason = clean(body.reason, 400);
  const reference = clean(body.reference, 60) || null;
  const name = clean(body.name, 80);
  const email = clean(body.email, 120).toLowerCase();
  const requesterState = clean(body.state, 2).toUpperCase();
  const targetState = clean(body.target_state, 2).toUpperCase() || requesterState;
  const declared = body.line_class === 'gov' ? 'gov' : 'commercial';

  const missing = [];
  if (!target) missing.push('the number to call');
  if (!requester) missing.push('your own number');
  if (!targetLabel) missing.push('whose line it is');
  if (!reason) missing.push('what it is about');
  if (!name) missing.push('your name');
  if (!policy.knownState(requesterState)) missing.push('your state');
  if (missing.length) return bad(400, `We still need ${missing.join(', ')}.`, { missing });

  if (target === requester) return bad(400, 'That is your own number. Give us the line you want us to wait on.');
  if (body.consent !== true) return bad(400, 'We cannot call anybody until you agree to the line above.');

  const text = consentText({ targetLabel, targetPhone: target, requesterPhone: requester });
  const ip = (req.headers.get('x-nf-client-connection-ip') || req.headers.get('client-ip') || '').split(',')[0].trim() || null;
  const ua = clean(req.headers.get('user-agent'), 300);

  // ★ CONSENT IS WRITTEN BEFORE ANY GATE RUNS AND LONG BEFORE ANYTHING IS DIALLED. If the write
  // fails, nothing is dialled. This is the leg where an artificial voice reaches a consumer, and
  // it is the one place in this product with no environment variable and no override.
  let consent = null;
  try {
    consent = await db.rpc('sv_grant_consent', {
      p_phone: requester,
      p_source: 'hold_start_form',
      p_evidence: { consent_text: text, page: '/hold/start', target, target_label: targetLabel, agreed_at: new Date().toISOString(), ua },
      p_scope: policy.HOLD_CONSENT_SCOPE,
      p_written: true,
      p_expires_at: null,
      p_ip: ip,
      p_user_agent: ua,
    });
  } catch (e) {
    console.error('hold start: consent write failed:', String(e.message).slice(0, 160));
    return bad(503, 'We could not record your permission, so we have not called anybody. Please try again in a minute.');
  }
  if (!consent || consent.error) return bad(400, consent && consent.error ? consent.error : 'we could not record your permission');
  if (consent.refused) return bad(400, consent.refused);

  const verdict = await policy.gateSession({ target, requester, targetState, requesterState });
  const priced = policy.priceClass({ declared });

  const token = store.newToken();
  const created = await store.create({
    token,
    requester_phone: requester, requester_email: email || null, requester_name: name,
    requester_state: requesterState,
    target_phone: target, target_label: targetLabel, target_state: targetState,
    reason, reference,
    ...priced,
    line_type: verdict.target.line_type || null,
    lookup_ok: verdict.target.lookup_ok ?? null,
    tree_plan: Array.isArray(body.plan) ? body.plan.slice(0, 8) : [],
    status: verdict.dialable ? 'queued' : 'refused',
    gate: verdict,
    consent_id: consent.consent_id || null,
  });
  if (!created || created.error) return bad(503, (created && created.error) || 'could not open a session');

  const watch = `${site()}/hold/s/${token}`;

  if (!verdict.dialable) {
    await store.event(created.id, 'gate_verdict', verdict);
    await store.patch(created.id, { outcome: 'refused', outcome_reason: verdict.reasons.join(' ') || 'the gate refused this one', ended_at: new Date().toISOString() });
    return ok({
      ok: false, id: created.id, token, watch,
      status: 'refused',
      deferred: verdict.deferred,
      retry_at: verdict.retryAt,
      why: verdict.reasons,
    });
  }

  await store.event(created.id, 'gate_verdict', verdict);

  if (verdict.needs_operator) {
    // ★ NOT A REFUSAL AND NOT A LIE. The errand is real, recorded, and waiting on a person rather
    // than on a machine. The door that decides whether an unknown line is dialled automatically
    // is deliberately shut by default; see the header of lib/hold-policy.mjs for exactly which
    // question it is holding open.
    await store.event(created.id, 'awaiting_operator', { door: verdict.door });
    return ok({
      ok: true, id: created.id, token, watch, status: 'queued', awaiting_operator: true,
      message: 'We have your errand. Somebody here is checking the line before we dial. You will see it start on this page.',
    });
  }

  const placed = await placeTarget(created);
  return ok({ ok: placed.ok, id: created.id, token, watch, status: placed.ok ? 'dialing' : 'refused', why: placed.ok ? null : [placed.reason] });
}

/** The one place a Hold call is created. Both the automatic path and the operator path come here. */
async function placeTarget(s) {
  const from = process.env.CANARY_FROM_NUMBER || process.env.ANSWERED_DEMO_NUMBER;
  if (!from) {
    await store.event(s.id, 'dial_failed', { reason: 'no outbound number configured' });
    return { ok: false, reason: 'no outbound number is configured on this deploy' };
  }
  try {
    const call = await tw.createCall({
      To: s.target_phone,
      From: from,
      Url: `${site()}/api/hold/voice?s=${encodeURIComponent(s.id)}`,
      Method: 'POST',
      StatusCallback: `${site()}/api/hold/status?kind=target&s=${encodeURIComponent(s.id)}`,
      StatusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      StatusCallbackMethod: 'POST',
      // No answering-machine detection, and no recording of the hold. See lib/hold-detect.mjs
      // for why AMD answers a different question, and hold-voice.mjs onJoin() for why the
      // recording starts at the conference rather than at the dial.
      Timeout: 40,
    });
    await store.patch(s.id, { call_sid: call.sid, status: 'dialing', dialed_at: new Date().toISOString(), attempts: Number(s.attempts || 0) + 1 });
    await store.event(s.id, 'dialled', { call_sid: call.sid, to_last4: String(s.target_phone).slice(-4), from_last4: String(from).slice(-4) });
    // The row in `calls`, so this session is visible to every operator surface in the estate and
    // carries the same compliance evidence every other call here does.
    try {
      await db.recordCall({
        call_sid: call.sid, to_number: s.target_phone, from_number: from, status: call.status,
        direction: 'outbound', operator: 'hold', call_class: 'consented', placed: true,
        ai_speaking: true, ai_listening: true,
        gate: { product: 'hold', session: s.id, line_class: s.line_class, verdict: s.gate },
      });
    } catch (e) { console.error('hold: calls row write failed:', String(e.message).slice(0, 140)); }
    return { ok: true, call_sid: call.sid };
  } catch (e) {
    await store.event(s.id, 'dial_failed', { error: String(e.message).slice(0, 240) });
    await store.patch(s.id, { status: 'refused', outcome: 'refused', outcome_reason: `we could not place the call (${String(e.message).slice(0, 120)})`, ended_at: new Date().toISOString() });
    return { ok: false, reason: String(e.message).slice(0, 200) };
  }
}

// ── the customer's own ops ───────────────────────────────────────────────────────────────────
async function opView(body) {
  const token = clean(body.token, 64);
  if (!store.TOKEN_RE.test(token)) return bad(400, 'that link is not valid');
  const v = await store.view(token);
  if (!v || v.error) return bad(404, (v && v.error) || 'unknown link');
  return ok({ ...v, receipt: store.receipt(v.session, v.events) });
}

async function opCancel(body) {
  const token = clean(body.token, 64);
  if (!store.TOKEN_RE.test(token)) return bad(400, 'that link is not valid');
  const v = await store.view(token);
  if (!v || v.error) return bad(404, 'unknown link');
  const id = v.session.id;
  const full = await store.get(id, 10);
  if (!full || full.error) return bad(404, 'unknown link');
  const s = full.session;
  if (s.status === 'ended') return ok({ ok: true, already: true, status: 'ended' });

  await store.event(id, 'cancelled_by_customer', {});
  await store.patch(id, { outcome: 'cancelled', outcome_reason: 'you called this one off' });
  const { endLeg } = await import('./lib/hold-runtime.mjs');
  if (s.call_sid) await endLeg(s.call_sid);
  if (s.bridge_call_sid) await endLeg(s.bridge_call_sid);
  await store.settle({ ...s, outcome: 'cancelled' }, { operator: 'customer' });
  return ok({ ok: true, status: 'ended' });
}

// ── operator ops ─────────────────────────────────────────────────────────────────────────────
async function opList(req, body) {
  if (!isOperator(req)) return bad(401, 'unauthorized');
  const rows = await store.list(clean(body.status, 20) || null, Number(body.limit) || 50);
  return ok({ ok: true, sessions: rows || [] });
}

async function opSession(req, body) {
  if (!isOperator(req)) return bad(401, 'unauthorized');
  const id = clean(body.id, 40);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return bad(400, 'bad id');
  const r = await store.get(id, 300);
  if (!r || r.error) return bad(404, 'unknown session');
  return ok({ ok: true, ...r, receipt: store.receipt(r.session, r.events) });
}

/**
 * The human in the loop. An operator watching a live session can say "that is a person" or "give
 * up", and the waiting loop obeys on its next tick, within seconds.
 *
 * ★ IT WRITES A COMMAND, IT DOES NOT DIAL. The runtime owns every call this product places, so
 * there is exactly one code path that rings a customer and exactly one that ends a leg. An
 * operator button that placed its own call would be a second dialler, and the second dialler is
 * always the one nobody is watching.
 */
async function opCommand(req, body, action) {
  if (!isOperator(req)) return bad(401, 'unauthorized');
  const id = clean(body.id, 40);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return bad(400, 'bad id');
  const r = await store.get(id, 5);
  if (!r || r.error) return bad(404, 'unknown session');
  const s = r.session;
  if (s.status === 'ended') return bad(409, 'that session is already over');

  await store.patch(id, { detector: { ...(s.detector || {}), operator_action: action, commanded_at: new Date().toISOString() } });
  await store.event(id, 'operator_command', { action, note: clean(body.note, 200) || null });

  // Nudge the live leg so the command lands now rather than at the end of the current pause.
  const { moveLeg } = await import('./lib/hold-runtime.mjs');
  if (s.call_sid) await moveLeg(s.call_sid, '/api/hold/tick', id, '&t=1&by=operator');
  return ok({ ok: true, action, id });
}

async function opApprove(req, body) {
  if (!isOperator(req)) return bad(401, 'unauthorized');
  const id = clean(body.id, 40);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return bad(400, 'bad id');
  const r = await store.get(id, 5);
  if (!r || r.error) return bad(404, 'unknown session');
  const s = r.session;
  if (s.call_sid) return bad(409, 'that one is already running');
  if (s.status === 'ended') return bad(409, 'that session is already over');

  // The class an operator sets is EVIDENCE and it is recorded as such, which is the only way the
  // dearer of the two prices is ever reached.
  if (body.line_class === 'gov' || body.line_class === 'commercial') {
    const priced = policy.priceClass({ operatorVerified: body.line_class });
    await store.patch(id, priced);
    await store.event(id, 'price_class_set', { ...priced, by: 'operator', note: clean(body.note, 200) || null });
  }
  await store.event(id, 'operator_approved', { note: clean(body.note, 200) || null });
  const fresh = await store.get(id, 1);
  const placed = await placeTarget(fresh.session);
  return ok({ ok: placed.ok, id, status: placed.ok ? 'dialing' : 'refused', why: placed.reason || null });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE PAGES
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// These link the site's own stylesheet rather than carrying a copy of it. @ANSWERED-BUILD owns
// the palette and the type, and a second copy of a design system is a second one to forget to
// update. Everything below adds only the few components these three pages need.

const CSS = `
:root{--ink:#0B0C0E;--paper:#F7F7F5;--dim:#6B6459;--line:rgba(255,255,255,.14);--hi:#E3FF4F}
*{box-sizing:border-box}
body{margin:0;background:var(--ink);color:var(--paper);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;-webkit-font-smoothing:antialiased}
.wrap{max-width:660px;margin:0 auto;padding:32px 20px 72px}
a{color:var(--hi)}
h1{font-size:clamp(26px,6vw,36px);line-height:1.15;letter-spacing:-.02em;margin:0 0 10px;font-weight:700}
h2{font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:rgba(247,247,245,.62);margin:34px 0 12px;font-weight:600}
p{margin:0 0 14px;color:rgba(247,247,245,.86)}
.lede{font-size:18px;color:rgba(247,247,245,.94)}
.card{border:1px solid var(--line);border-radius:14px;padding:20px;margin:0 0 16px;background:rgba(255,255,255,.03)}
label{display:block;font-size:13.5px;letter-spacing:.02em;color:rgba(247,247,245,.72);margin:16px 0 6px}
input,select,textarea{width:100%;max-width:100%;background:rgba(255,255,255,.05);border:1px solid var(--line);border-radius:10px;color:var(--paper);padding:13px 14px;font:inherit;font-size:16px}
/* ★ THIS SELECTOR WAS WRONG AND ONLY A SCREENSHOT SHOWED IT. It read
   "input:focus,select,textarea:focus", so the bare "select" matched ALWAYS and every dropdown on
   the page wore a permanent yellow focus ring whether or not it had focus. Two controls looked
   focused at once, which is exactly the state a keyboard user relies on being unambiguous. */
input:focus,select:focus,textarea:focus{outline:2px solid var(--hi);outline-offset:1px}
/* appearance:none removes the platform caret, so one is drawn back in. A select with no caret is
   a select nobody knows they can open. */
select{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23E3FF4F' stroke-width='1.8' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center;padding-right:38px;text-overflow:ellipsis}
textarea{min-height:88px;resize:vertical}
.row{display:grid;grid-template-columns:1fr;gap:0}
@media(min-width:560px){.row{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 16px}}
button{background:var(--hi);color:var(--ink);border:0;border-radius:10px;padding:15px 22px;font:inherit;font-weight:700;font-size:16px;cursor:pointer;width:100%;margin-top:22px}
button:disabled{opacity:.55;cursor:progress}
button.ghost{background:transparent;color:var(--paper);border:1px solid var(--line);font-weight:600}
.consent{display:flex;gap:12px;align-items:flex-start;margin:18px 0 0;font-size:14px;color:rgba(247,247,245,.8)}
.consent input{width:22px;height:22px;flex:0 0 22px;margin-top:2px}
.note{font-size:13.5px;color:rgba(247,247,245,.6)}
.err{border:1px solid #ff8a7a;background:rgba(255,138,122,.09);color:#ffd8d1;border-radius:10px;padding:14px;margin:16px 0;font-size:14.5px}
.okbox{border:1px solid rgba(227,255,79,.4);background:rgba(227,255,79,.07);border-radius:10px;padding:14px;margin:16px 0;font-size:14.5px}
table{width:100%;border-collapse:collapse;table-layout:fixed}
td{padding:9px 0;border-bottom:1px solid rgba(255,255,255,.08);vertical-align:top;font-size:15px;overflow-wrap:anywhere}
td.k{width:44%;color:rgba(247,247,245,.6);font-size:14px;padding-right:14px}
.steps{list-style:none;padding:0;margin:0}
.steps li{padding:11px 0 11px 26px;border-bottom:1px solid rgba(255,255,255,.08);position:relative;font-size:15px;overflow-wrap:anywhere}
.steps li:before{content:"";position:absolute;left:6px;top:19px;width:7px;height:7px;border-radius:50%;background:var(--hi);opacity:.8}
.steps time{display:block;font-size:12.5px;color:rgba(247,247,245,.5);letter-spacing:.03em}
.big{font-size:clamp(34px,9vw,52px);font-weight:700;letter-spacing:-.03em;line-height:1;margin:0 0 4px}
.pill{display:inline-block;font-size:12px;letter-spacing:.12em;text-transform:uppercase;border:1px solid var(--line);border-radius:999px;padding:5px 12px;color:rgba(247,247,245,.75)}
.foot{margin-top:44px;padding-top:18px;border-top:1px solid rgba(255,255,255,.1);font-size:13px;color:rgba(247,247,245,.5)}
`;

function shell(title, body, { head = '' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<!-- The site mark, inline as a data URI. A missing favicon is a console error at every
     viewport, and a console error on a page a customer is watching a live call on is not
     something to leave for later. -->
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230B0C0E'/%3E%3Crect x='4' y='5' width='5.4' height='22' rx='2.4' fill='%23E3FF4F'/%3E%3Cpath d='M 12 7.6 A 8.6 8.6 0 0 1 12 24.4' fill='none' stroke='%23E3FF4F' stroke-width='5.4' stroke-linecap='round'/%3E%3Cpath d='M 20.4 10.2 A 11.4 11.4 0 0 1 20.4 21.8' fill='none' stroke='%23E3FF4F' stroke-width='3' stroke-linecap='round'/%3E%3Cpath d='M 25.2 6.9 A 15.6 15.6 0 0 1 25.2 25.1' fill='none' stroke='%23E3FF4F' stroke-width='2.1' stroke-linecap='round'/%3E%3C/svg%3E">
<style>${CSS}</style>${head}</head>
<body><main class="wrap">${body}
<p class="foot">Answered. It answers, it waits, it follows the money. Priced per outcome, never per minute.
Your first hold is free. After that: $20 when a person picks up on a government line, $10 on a
commercial one, and $0 whenever nobody does.</p></main></body></html>`;
}

const notice = (t) => `<div class="err">${esc(t)}</div>`;

const STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DC', 'DE', 'FL', 'GA', 'HI', 'IA', 'ID', 'IL', 'IN',
  'KS', 'KY', 'LA', 'MA', 'MD', 'ME', 'MI', 'MN', 'MO', 'MS', 'MT', 'NC', 'ND', 'NE', 'NH', 'NJ', 'NM', 'NV',
  'NY', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VA', 'VT', 'WA', 'WI', 'WV', 'WY'];

// ── /hold/start ──────────────────────────────────────────────────────────────────────────────
function startPage() {
  const body = `
<h1>Give us the line. Go do something else.</h1>
<p class="lede">We call it, work the menu, and wait. Your phone rings when a person picks up.</p>

<form id="f" class="card" autocomplete="on">
  <label for="label">Whose line is it?</label>
  <input id="label" name="label" required maxlength="90" placeholder="State benefits office">

  <label for="target">The number to call</label>
  <input id="target" name="target" type="tel" inputmode="tel" required placeholder="800 555 0134">

  <label for="line_class">Is it a government line or a business? The price is $10 either way unless it is government, which is $20.</label>
  <select id="line_class" name="line_class">
    <option value="commercial">A business, $10</option>
    <option value="gov">Government, $20</option>
  </select>

  <label for="reason">What is it about?</label>
  <textarea id="reason" name="reason" required maxlength="400" placeholder="My claim has been stalled for six weeks and nobody has called me back."></textarea>

  <label for="reference">Reference or case number, if you have one</label>
  <input id="reference" name="reference" maxlength="60" placeholder="Optional">

  <div class="row">
    <div><label for="name">Your name</label><input id="name" name="name" required maxlength="80" autocomplete="name"></div>
    <div><label for="callback">Your number</label><input id="callback" name="callback" type="tel" inputmode="tel" required autocomplete="tel" placeholder="916 555 0180"></div>
  </div>
  <div class="row">
    <div><label for="state">Your state</label><select id="state" name="state" required>
      <!-- ★ NO DEFAULT. A select that opens on Alabama submits Alabama for everybody who does not
           notice it, and this field decides the quiet-hours check on the number we ring back.
           A silently wrong state is a call placed at the wrong hour in somebody's own timezone. -->
      <option value="" disabled selected>Pick one</option>
      ${STATES.map((s) => `<option>${s}</option>`).join('')}</select></div>
    <div><label for="email">Your email, for the receipt</label><input id="email" name="email" type="email" maxlength="120" autocomplete="email" placeholder="Optional"></div>
  </div>

  <div class="consent">
    <input type="checkbox" id="consent" required>
    <label for="consent" style="margin:0">I am asking Answered to call this line for me, work the menu, wait on hold, and call me back on my number when a person is on the line. An A I voice speaks on the call and says so out loud. The conversation is recorded from the moment a person answers. I can say stop at any time.</label>
  </div>

  <button type="submit" id="go">Start waiting for me</button>
  <p class="note" style="margin-top:14px">Your first hold is free. $0 any time nobody picks up. Never a charge for the waiting itself.</p>
</form>
<div id="out"></div>

<script>
const f=document.getElementById('f'),out=document.getElementById('out'),go=document.getElementById('go');
f.addEventListener('submit',async e=>{
  e.preventDefault();out.innerHTML='';go.disabled=true;go.textContent='Setting it up...';
  const d=Object.fromEntries(new FormData(f).entries());
  d.consent=document.getElementById('consent').checked;d.op='start';
  try{
    const r=await fetch('/api/hold',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});
    const j=await r.json();
    if(!r.ok||j.ok===false){
      const why=Array.isArray(j.why)?j.why.join(' '):(j.error||'Something went wrong.');
      out.innerHTML='<div class="err">'+esc(why)+(j.watch?' <a href="'+j.watch+'">See the record</a>':'')+'</div>';
    }else{
      out.innerHTML='<div class="okbox">'+esc(j.message||'We are on it.')+' <a href="'+j.watch+'">Watch it happen</a></div>';
      setTimeout(()=>{location.href=j.watch;},1200);
    }
  }catch(err){out.innerHTML='<div class="err">We could not reach our own server. Nothing was called. Try again in a moment.</div>';}
  go.disabled=false;go.textContent='Start waiting for me';
});
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
</script>`;
  return html(shell('Start a hold', body));
}

// ── /hold/s/:token ───────────────────────────────────────────────────────────────────────────
// ★ RENDERED EMPTY AND FILLED BY A FETCH, ON PURPOSE. Every byte of session data on this page
// comes from hd_view, which is the only read that knows how to narrow it. A server-rendered first
// paint here would need a second copy of that narrowing, and the second copy is the one that
// leaks.
function livePage(token) {
  const body = `
<span class="pill" id="pill">Connecting</span>
<h1 id="head">Working the line for you</h1>
<p class="lede" id="sub">Getting the session...</p>
<div class="card"><table id="facts"><tbody></tbody></table></div>
<h2>What has happened</h2>
<ul class="steps" id="steps"><li>Loading the record.</li></ul>
<button class="ghost" id="stop">Call it off</button>
<p class="note" id="err"></p>
<script>
const T=${JSON.stringify(token)};
const $=id=>document.getElementById(id);
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function when(t){if(!t)return'';const d=new Date(t);return d.toLocaleTimeString([], {hour:'numeric',minute:'2-digit',second:'2-digit'});}
const SAY={session_created:'We took down your errand.',gate_verdict:'We checked the line and the hour.',
awaiting_operator:'Somebody here is checking the line before we dial.',operator_approved:'Checked. Dialling now.',
dialled:'We dialled the line.',answered:'The line picked up.',digit_sent:'We worked the menu.',
menu_unmatched:'A menu offered choices and none of them matched your errand, so we waited.',
announced:'A person came on. We said who we are and what this is about.',
user_ringing:'Your phone is ringing.',user_answered:'You picked up.',user_accepted:'You pressed a key.',
connected:'You are connected.',still_holding:'Still holding.',redialled:'The line dropped us, so we called back.',
no_human:'Nobody ever picked up.',bridge_failed:'We could not get you onto the call.',
apologised:'We told them we could not reach you, so nobody was left hanging.',
gave_up:'We stopped: that line is not going to reach a person.',
stop_heard:'That line asked not to be called again, so we stopped.',
cancelled_by_customer:'You called it off.',settled:'Done.',recording_ready:'The recording is saved.'};
async function tick(){
  try{
    const r=await fetch('/api/hold',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'view',token:T})});
    const j=await r.json();
    if(!r.ok){$('err').textContent=j.error||'We cannot read that link.';return;}
    const s=j.session,rc=j.receipt;
    $('pill').textContent=({queued:'Queued',dialing:'Dialling',ringing:'Ringing',navigating:'Working the menu',
      holding:'On hold',announcing:'Talking to a person',bridging:'Ringing you',bridged:'Connected',ended:'Finished'})[s.status]||s.status;
    $('head').textContent=s.target_label;
    $('sub').textContent=s.status==='ended'
      ?(s.outcome==='connected'?'You were connected. Your receipt is ready.':(s.outcome_reason||'This one is finished.'))
      :'Your time on this call so far: '+(rc.your_wait||'none of it')+'.';
    const rows=[['Line called',s.target_label],['Number',s.target_phone],['What it is about',s.reason],
      ['Menu depth',String(s.menu_depth)+' level'+(s.menu_depth===1?'':'s')],['Attempts',String(s.attempts)],
      ['Time your A I has waited',rc.machine_wait||'not started'],['Time you have waited',rc.your_wait||'none of it'],
      ['Price if a person picks up',s.line_class==='gov'?'$20.00':'$10.00']];
    if(s.status==='ended')rows.push(['Charged',rc.charged==null?'nothing yet':rc.charged]);
    $('facts').innerHTML=rows.map(r=>'<tr><td class="k">'+esc(r[0])+'</td><td>'+esc(r[1])+'</td></tr>').join('');
    const shown=(j.events||[]).filter(e=>SAY[e.kind]);
    $('steps').innerHTML=shown.length?shown.map(e=>'<li>'+esc(SAY[e.kind])+'<time>'+esc(when(e.at))+'</time></li>').join('')
      :'<li>Nothing has happened yet. This page updates itself.</li>';
    if(s.status==='ended'){
      $('stop').textContent='See the receipt';
      $('stop').onclick=()=>{location.href='/hold/receipt/'+T;};
      return;
    }
    setTimeout(tick,4000);
  }catch(e){$('err').textContent='We lost the connection to our own server. Retrying.';setTimeout(tick,8000);}
}
$('stop').onclick=async()=>{
  $('stop').disabled=true;
  await fetch('/api/hold',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'cancel',token:T})});
  $('stop').disabled=false;tick();
};
tick();
</script>`;
  return html(shell('Your hold, live', body));
}

/**
 * ★ THE RECORDING LINE HAS THREE ANSWERS, NOT TWO, AND A SCREENSHOT IS WHAT FOUND IT.
 * It used to read "none, because nobody was reached" whenever no recording existed, and printed
 * that sentence directly underneath a row saying "Human reached 1:09:39 PM" on the same receipt.
 * Every assertion in the suite passed while the artifact contradicted itself two rows apart.
 * Absence of a recording and absence of a person are different facts, and the receipt now says
 * which one it is looking at.
 */
function recordingLine(r) {
  if (r.has_recording) return `${r.recording_seconds || 0} seconds, kept from the moment a person answered`;
  if (r.connected_at) return 'no audio was saved for this one';
  if (r.human_reached_at) return 'none, because you were never connected';
  return 'none, because nobody was reached';
}

// ── /hold/receipt/:token ─────────────────────────────────────────────────────────────────────
async function receiptPage(token) {
  let v = null;
  try { v = await store.view(token); } catch (e) { return html(shell('Hold receipt', notice('We could not reach the record just now. Try again in a moment.')), 503); }
  // ★ 410, NOT 404, AND IT IS NOT PEDANTRY. Netlify treats a 404 from a matched function as
  // "carry on looking", falls through to the static handler, and serves ITS generic 404 page
  // instead. Measured: the honest sentence below was replaced by a blank platform 404, and the
  // person holding a mistyped link learned nothing. Any status that is not 404 is delivered.
  if (!v || v.error) return html(shell('Hold receipt', notice('That link does not match a hold we have. Check you pasted the whole thing.')), 410);

  const s = v.session;
  const r = store.receipt(s, v.events || []);
  const row = (k, val) => (val == null || val === '' ? '' : `<tr><td class="k">${esc(k)}</td><td>${esc(String(val))}</td></tr>`);

  const finished = s.status === 'ended';
  const charged = r.charged == null ? null : r.charged;

  const body = `
<span class="pill">${finished ? 'Hold receipt' : 'Not finished yet'}</span>
<h1>${esc(s.target_label)}</h1>
${finished ? '' : '<div class="err">This hold is still running. Everything below is what has happened so far.</div>'}

<div class="card">
  <p class="big">${esc(r.machine_wait || '0s')}</p>
  <p class="note">Time your A I waited. Time you waited: <b>${esc(r.your_wait || '0s')}</b>.</p>
</div>

<h2>The record</h2>
<div class="card"><table><tbody>
${row('Line called', s.target_label)}
${row('Number', s.target_phone)}
${row('What it was about', s.reason)}
${row('Reference', r.reference_on_file ? 'on file' : null)}
${row('Menu depth', `${r.menu_depth} level${r.menu_depth === 1 ? '' : 's'}`)}
${row('Keys pressed', r.keys_pressed.length ? r.keys_pressed.join(', ') : 'none')}
${row('Attempts', r.attempts)}
${row('Human reached', r.human_reached_at ? new Date(r.human_reached_at).toLocaleString() : 'no')}
${row('You were connected', r.connected_at ? new Date(r.connected_at).toLocaleString() : 'no')}
${row('Recording', recordingLine(r))}
</tbody></table></div>

<h2>What it cost</h2>
<div class="card">
  <p class="big">${esc(charged == null ? 'nothing yet' : charged)}</p>
  <p>${esc(r.charge_reason || 'This hold has not been settled yet.')}</p>
  ${r.list_price && r.charged === '$0.00' && r.list_price !== '$0.00'
    ? `<p class="note">The list price for this one is ${esc(r.list_price)}. You were not charged it.</p>` : ''}
  <p class="note">Priced ${s.line_class === 'gov' ? 'as a government line, $20' : 'as a commercial line, $10'}${
    s.line_class_source === 'default_commercial' ? ', which is the cheaper of the two and what we use unless somebody records a reason not to' : ''}.</p>
</div>

<h2>What the line actually said</h2>
<div class="card">
${r.heard.length
    ? `<ul class="steps">${r.heard.slice(-25).map((h) => `<li>${esc(h.text)}<time>${esc(new Date(h.at).toLocaleTimeString())}${h.state ? ` &middot; read as ${esc(h.state)}` : ''}</time></li>`).join('')}</ul>`
    : '<p class="note">Nothing was transcribed from the far end. Hold music sounds like silence to a transcriber, so this is normal on a call that never reached a person.</p>'}
</div>
<p class="note">Every line above is read from the session record as it was written during the call. Nothing here is reconstructed afterwards.</p>`;
  return html(shell('Hold receipt', body));
}

// ── /internal/hold ───────────────────────────────────────────────────────────────────────────
// ★ NOTHING GATED IS SERIALIZED BEFORE THE CHECK PASSES. The anonymous response is a login form
// and its own stylesheet, and it contains no session, no number, no id and no operator control.
// A curtain drawn over bytes the server already sent is not a gate; this estate has the 303,451
// byte receipt to prove it.
async function operatorConsole(req, url) {
  if (!gate.configured()) {
    return html(shell('Operator', notice('This console has no PIN configured, so it is closed. Set ANSWERED_DIRECTORY_PIN and ANSWERED_COCKPIT_KEY.')), 503, gate.BASE_HEADERS);
  }
  const headers = Object.fromEntries(req.headers.entries());

  if (req.method === 'POST') {
    const form = new URLSearchParams(await req.text());
    await gate.slow();
    if (!gate.pinValid(form.get('pin'))) return html(loginPage('That PIN is not right.'), 401, gate.BASE_HEADERS);
    return html(consolePage(), 200, { ...gate.BASE_HEADERS, 'Set-Cookie': gate.setCookieHeader('ans_hold', gate.mintCookie('hold')) });
  }
  if (!gate.cookieValid('hold', gate.readCookie(headers, 'ans_hold'))) {
    return html(loginPage(''), 200, gate.BASE_HEADERS);
  }
  return html(consolePage(), 200, gate.BASE_HEADERS);
}

function loginPage(msg) {
  return shell('Operator', `<h1>Hold operations</h1><p class="lede">This page is internal.</p>
${msg ? notice(msg) : ''}
<form method="POST" class="card"><label for="pin">PIN</label>
<input id="pin" name="pin" type="password" autocomplete="off" autofocus><button type="submit">Open</button></form>`);
}

function consolePage() {
  const body = `
<h1>Hold operations</h1>
<p class="lede">Every session, live. You can overrule the detector from here.</p>
<div id="list"><p class="note">Loading.</p></div>
<script>
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
async function call(op,extra){
  const r=await fetch('/api/hold',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({op:op},extra||{}))});
  return {status:r.status,body:await r.json().catch(()=>({}))};
}
function mins(a,b){if(!a)return'';const t=Math.round(((b?new Date(b):new Date())-new Date(a))/60000);return t+'m';}
async function draw(){
  const {status,body}=await call('list',{limit:60});
  const el=document.getElementById('list');
  if(status===401){el.innerHTML='<p class="err">This console is not signed in.</p>';return;}
  const all=body.sessions||[];
  if(!all.length){el.innerHTML='<p class="note">No hold sessions yet. This is a measured zero, not a loading state and not a failure.</p>';return;}
  // ★ LIVE FIRST, AND THE FINISHED ONES TRIMMED. This console is read while somebody is on hold,
  // so the running errands are the whole job and a finished one from yesterday is history. An
  // unsorted list of everything pushed the only card anyone needed below thirty five others.
  const live=all.filter(s=>s.status!=='ended');
  const done=all.filter(s=>s.status==='ended');
  const rows=live.concat(done.slice(0,8));
  el.innerHTML='<p class="note">'+live.length+' running, '+done.length+' finished'
    +(done.length>8?' (showing the last 8)':'')+'.</p>'+rows.map(s=>{
    const live=s.status!=='ended';
    const waiting=s.status==='queued'&&!s.call_sid;
    return '<div class="card"><p><b>'+esc(s.target_label)+'</b> <span class="pill">'+esc(s.status)+'</span></p>'
      +'<table><tbody>'
      +'<tr><td class="k">Errand</td><td>'+esc(s.reason)+'</td></tr>'
      +'<tr><td class="k">Number</td><td>'+esc(s.target_phone)+' &middot; '+esc(s.line_type||'line type unknown')+'</td></tr>'
      +'<tr><td class="k">Customer</td><td>'+esc(s.requester_name||'')+' &middot; '+esc(String(s.requester_phone).slice(-4))+'</td></tr>'
      +'<tr><td class="k">Price class</td><td>'+esc(s.line_class)+' ('+esc(s.line_class_source)+')</td></tr>'
      +'<tr><td class="k">Holding for</td><td>'+esc(mins(s.dialed_at,s.ended_at)||'not dialled')+' &middot; attempt '+esc(s.attempts)+'</td></tr>'
      +(s.detector&&s.detector.deaf?'<tr><td class="k">Warning</td><td>Transcription failed on this call. The detector is blind and this one needs a person.</td></tr>':'')
      +(s.charge_reason?'<tr><td class="k">Charge</td><td>'+esc(s.charge_reason)+'</td></tr>':'')
      +'</tbody></table>'
      +(waiting?'<button data-approve="'+s.id+'">Approve and dial</button>':'')
      +(live&&!waiting?'<button data-bridge="'+s.id+'">A person is on the line. Bridge them in.</button>'
        +'<button class="ghost" data-abandon="'+s.id+'">Give up on this one</button>':'')
      +'<p class="note"><a href="/hold/receipt/'+esc(s.token)+'">receipt</a> &middot; <a href="/hold/s/'+esc(s.token)+'">what the customer sees</a></p>'
      +'</div>';
  }).join('');
}
document.addEventListener('click',async e=>{
  const b=e.target.closest('button[data-bridge],button[data-abandon],button[data-approve]');
  if(!b)return;b.disabled=true;
  if(b.dataset.bridge)await call('bridge',{id:b.dataset.bridge});
  else if(b.dataset.abandon)await call('abandon',{id:b.dataset.abandon});
  else await call('approve',{id:b.dataset.approve});
  draw();
});
draw();setInterval(draw,6000);
</script>`;
  return shell('Hold operations', body);
}

// ★ STATIC LITERAL. Netlify evaluates this by static analysis and silently drops anything
// computed; a dropped path is a 404 on a page a customer was sent a link to.
export const config = {
  path: [
    '/api/hold',
    '/hold/start',
    '/hold/s/:token',
    '/hold/receipt/:token',
    '/internal/hold',
  ],
};
