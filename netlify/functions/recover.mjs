// /api/recover — THE RUNTIME BEHIND THE /recover PAGE.
//
// The page sells four sentences. This file is the thing that has to make each one true:
//
//   "Calls every invoice past day thirty, in your name and on your caller ID"
//   "Knows the job, the address and the date, because it booked the work"
//   "Writes down every promise to pay, and follows up on the date"
//   "15% of dollars actually recovered. You pay nothing unless the money lands."
//
// So: an invoice is a RECORD, the call is placed in the CREDITOR'S OWN NAME, the promise is CAPTURED
// FROM WHAT WAS SAID with a date attached, and the fee exists only when a payment is recorded. Every
// one of those is a row somebody can read back.
//
// ═══ WHY THE COMPLIANCE CODE IN HERE IS THE PRODUCT AND NOT OVERHEAD ═════════════════════════════
//
// This is FIRST-PARTY collection. 15 U.S.C. 1692a(6) reaches people collecting debts owed to
// ANOTHER; an agent calling in the creditor's own name, about the creditor's own invoice, for work
// the creditor actually did, is on the other side of that line. Everything that keeps us there is
// mechanical and lives below:
//
//   THE NAME       every call opens "This is an A I assistant calling for <the business>". The
//                  business name comes off the invoice row. There is no code path that speaks a
//                  different name, and no path that speaks none.
//   THE CLOCK      8:00 to 21:00 in the DEBTOR'S local time (1692c(a)(1)), resolved from where the
//                  work was done before it is ever guessed from an area code. See lib/hours.mjs.
//   THE STOP       any stop word ends the call, writes an estate-wide suppression, and closes the
//                  invoice to further calls (1692c(c)). It is checked before anything else on every
//                  single turn, including before the language layer is consulted.
//   THE THREAT     lib/recover-script.mjs holds a filter, not an instruction. Nothing generated is
//                  spoken until it has been scanned for 1692e(5), 1692e(4) and 1692d language.
//   THE THIRD PARTY  the opening names no debt and no amount. Nothing about what is owed is said
//                  until the person confirms they are the named debtor (1692c(b)).
//   THE AMOUNT     comes from the invoice row. The language model is forbidden by filter from
//                  emitting any figure at all (1692e(2)).
//
// ★ AND THE ONE THAT DECIDES WHETHER WE MAY DIAL AT ALL: FCC 24-17 (2024) confirms an AI voice is an
// "artificial voice" under 47 U.S.C. 227(b), and 227(b)(1)(A)(iii) forbids an artificial-voice call
// to a WIRELESS number without prior express consent. Barr v. AAPC (2020) struck the government-debt
// carve-out, so there is no debt exemption. The consent that does exist is the FCC's 2008
// Declaratory Ruling (23 FCC Rcd 559): a wireless number the debtor gave the creditor IN CONNECTION
// WITH THE TRANSACTION carries consent for calls about that debt. That is a fact about one invoice,
// so it is a column (consent_basis / number_source / number_given_at), and an invoice that cannot
// say where the number came from DOES NOT GET AN ARTIFICIAL-VOICE CALL TO A MOBILE. It gets an
// honest refusal and the operator gets told to call it by hand.
//
// This inverts call-me.mjs's mobile-only rule, deliberately and for a documented reason: there, a
// person just typed their own number into our website and asked us to ring it, so the mobile is the
// consented line and the landline is the stranger's. Here nobody asked us to call, so the mobile is
// the restricted line and the landline is the one the artificial-voice exemption at 64.1200(a)(3)
// covers, subject to its own tighter ceiling.
//
// ═══ ROUTES ══════════════════════════════════════════════════════════════════════════════════════
//   POST /api/recover           the operator JSON API. Bearer. Every op below.
//   POST /api/recover/twiml     Twilio asks what to say. Capability token, hashed at rest.
//   POST /api/recover/turn      one conversational turn.
//   POST /api/recover/status    how the call ended.
//
// Declared as LITERALS in config.path, which is why there is no block for them in netlify.toml: a
// v2 function that declares a custom path loses its default /.netlify/functions route, so a forced
// redirect pointing there would shadow the live route with a dead target. Same lesson as
// answered-brain.mjs and bill-statement.mjs, written down again because it has cost this repo twice.
//
// Env, by NAME only, all fail closed:
//   ANSWERED_DB_URL / ANSWERED_DB_ANON / ANSWERED_DB_SECRET   the record spine
//   TWILIO_ACCOUNT_SID / TWILIO_API_SID / TWILIO_API_SECRET   placing the call, and the line lookup
//   ANSWERED_RECOVER_FROM                                     optional caller ID override for QA
//   ANSWERED_DEMO_NUMBER                                      fallback caller ID and callback
//   ANSWERED_QA_NUMBERS                                       estate-owned lines a proof may dial
//   ANSWERED_RECOVER_KILL                                     any value stops every dial
//   ANTHROPIC_API_KEY_LIVE                                    the language layer, filtered
//   ANSWERED_COCKPIT_KEY / ANSWERED_BOOKING_SECRET            who may drive this endpoint

import crypto from 'node:crypto';
import { authenticate, XML, SAY, esc, origin, transcriptionStart } from './lib/twilio-webhook.mjs';
import { authorize } from './lib/bearer.mjs';
import * as R from './lib/recover-db.mjs';
import * as ledger from './lib/ledger.mjs';
import { callingWindow, zonesFor } from './lib/hours.mjs';
import {
  opening, identityAsk, debtStatement, WRONG_PARTY, STOP_ACKNOWLEDGED, DISPUTE_ACKNOWLEDGED,
  NO_DATE_YET, PROMISE_CLOSE, CLOSE_UNRESOLVED, VOICEMAIL, BROKEN,
  isStop, isDispute, isWrongNumber, WRONG_NUMBER_ACKNOWLEDGED, askedIfAI, AI_ANSWER, saidYes, saidNo,
  extractPromise, parseDate, parseAmountCents, floorCheck, spokenMoney,
} from './lib/recover-script.mjs';

export const config = {
  path: ['/api/recover', '/api/recover/twiml', '/api/recover/turn', '/api/recover/status'],
};

const JSONH = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };
const ok = (d) => ({ statusCode: 200, headers: JSONH, body: JSON.stringify(d) });
const bad = (c, m, extra) => ({ statusCode: c, headers: JSONH, body: JSON.stringify({ ok: false, error: m, ...(extra || {}) }) });

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const nowIso = () => new Date().toISOString();
const e164 = (raw) => {
  const clean = String(raw || '').trim().replace(/[^+\d]/g, '');
  return /^\+\d{10,15}$/.test(clean) ? clean : null;
};
const callbackNumber = () => e164(process.env.ANSWERED_RECOVER_FROM || process.env.ANSWERED_DEMO_NUMBER);

/** Lines this estate owns. A proof call may reach one of these and nothing else. */
function qaNumbers() {
  const raw = String(process.env.ANSWERED_QA_NUMBERS || '').split(',').map((s) => e164(s)).filter(Boolean);
  const defaults = [e164(process.env.CANARY_FROM_NUMBER), e164(process.env.ANSWERED_DEMO_NUMBER)].filter(Boolean);
  return new Set([...raw, ...defaults]);
}

// ── the language layer, and the only thing it is allowed to do ───────────────────────────────
// It writes ONE acknowledging sentence so the call does not sound like a form. It never states an
// amount, never names a date, never decides anything, and every sentence it produces is scanned by
// floorCheck() before it can be spoken. A sentence that trips the filter is DISCARDED, not edited:
// a model that has to be corrected once will do it again on a call nobody is listening to.
const ANTHROPIC_KEY = () => (process.env.ANTHROPIC_API_KEY_LIVE || process.env.ANTHROPIC_API_KEY || '').trim();

async function acknowledge(heard, { businessName }) {
  const key = ANTHROPIC_KEY();
  if (!key) return null;
  const system = [
    `You are an AI assistant on a live phone call, placed on behalf of ${businessName}, about one of their own unpaid invoices.`,
    'You have ALREADY said you are an AI and that the call is recorded. Do not repeat it unless asked.',
    'Your ONLY job is one short, warm, human sentence that acknowledges what the person just said.',
    'HARD RULES, all absolute: never state any amount of money. Never state or suggest a date.',
    'Never mention lawyers, courts, lawsuits, liens, credit reports, collections agencies, late fees or interest.',
    'Never threaten anything. Never argue. Never claim to be human. Never apologise for calling.',
    'Reply with ONE spoken sentence, under 20 words. No lists, no markdown, no stage directions.',
  ].join(' ');
  const call = async (model) => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      signal: AbortSignal.timeout(4500),
      body: JSON.stringify({ model, max_tokens: 60, system, messages: [{ role: 'user', content: heard || '(silence)' }] }),
    });
    if (!r.ok) throw new Error(`anthropic ${r.status}`);
    const j = await r.json();
    return (j.content || []).map((c) => c.text || '').join(' ').trim();
  };
  // Best model per slot, and the vendor follows the model: both are Claude, both direct Anthropic.
  let text = null;
  try { text = await call('claude-haiku-4-5-20251001'); }
  catch { try { text = await call('claude-sonnet-5'); } catch { return null; } }
  if (!text) return null;
  const one = text.split(/(?<=[.!?])\s+/)[0].slice(0, 160);
  const floor = floorCheck(one);
  if (!floor.ok) {
    console.error(`RECOVER: a generated sentence was DISCARDED for ${floor.why}. Nothing was spoken.`);
    return null;
  }
  return one;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE GATE. Cheap and certain first, vendor calls last. Every branch returns a REASON a person
// could read out loud, because every refusal is written to a row somebody may have to defend.
// ═════════════════════════════════════════════════════════════════════════════════════════════
async function gate(invoiceId, { operator }) {
  const reasons = [];
  const deny = (code, reason, extra) => ({ ok: false, code, reason, reasons: [...reasons, reason], ...(extra || {}) });

  if (String(process.env.ANSWERED_RECOVER_KILL || '').trim()) {
    return deny('paused', 'Recover calling is switched off by the kill switch.');
  }

  const facts = await R.gateFacts(invoiceId);
  if (!facts || facts.error) return deny('no_invoice', facts?.error || 'no such invoice');
  const inv = facts.invoice;
  const balance = Number(facts.balance_cents);

  if (!inv.business_name || !String(inv.business_name).trim()) {
    return deny('no_creditor_name', 'This invoice has no business name on it, and a Recover call has to open by naming the business it is calling for. Refusing rather than calling anonymously.');
  }
  if (inv.status === 'stopped') return deny('stopped', 'This person asked us to stop, so this invoice is closed to calls permanently.');
  if (inv.status === 'disputed') return deny('disputed', 'This invoice is disputed. Calls stop and a person takes it from here.');
  if (inv.status === 'paid') return deny('paid', 'This invoice is paid.');
  if (inv.status === 'closed') return deny('closed', 'This invoice is closed.');
  if (!Number.isFinite(balance) || balance <= 0) return deny('nothing_owed', 'There is no balance left on this invoice, so there is nothing to call about.');

  if (facts.suppressed) return deny('suppressed', 'This number is on the suppression list, so it is never dialled again by anything in this system.');

  // The promise IS the schedule. "Thursday's follow up happens without you" means nothing rings
  // before Thursday, and this is the line that makes that true.
  if (inv.next_action_at && new Date(inv.next_action_at).getTime() > Date.now()) {
    return deny('promise_pending', `They promised a date and we are holding to it. Nothing calls this invoice again before ${String(inv.next_action_at).slice(0, 10)}.`, { retry_at: inv.next_action_at });
  }

  // Frequency. 12 CFR 1006.14(b)(2)(i) presumes harassment above seven calls in seven days on one
  // debt, and (b)(2)(ii) above a call within seven days of a conversation about it. We are not the
  // party that rule binds, and we hold to it anyway, because it is a good rule and because "we were
  // not technically covered" is a sentence nobody wants to say out loud.
  if (Number(facts.placed_today) >= 1) {
    return deny('called_today', 'This invoice has already been called today. One a day is the rule we hold ourselves to.');
  }
  if (Number(facts.placed_7d) >= 7) {
    return deny('too_many_7d', 'Seven calls have gone to this invoice in seven days, which is the ceiling, so nothing else goes out this week.');
  }
  if (inv.last_conversation_at) {
    const since = Date.now() - new Date(inv.last_conversation_at).getTime();
    if (since < 7 * 24 * 3600 * 1000) {
      return deny('recent_conversation', 'We actually spoke to them about this within the last seven days, so we wait. Calling again this week would be harassment, not follow up.');
    }
  }

  // The clock, in THEIR time, from where the work was done first.
  const win = callingWindow({ timezone: inv.debtor_timezone, state: inv.debtor_state, phone: inv.debtor_phone, at: new Date() });
  if (!win.ok) return deny(win.code, win.reason, { retry_after_seconds: win.retry_after_seconds || null, zone_source: win.source });

  const to = e164(inv.debtor_phone);
  if (!to) return deny('bad_number', 'The number on this invoice is not a number we can dial.');
  const from = e164(process.env.ANSWERED_RECOVER_FROM || process.env.ANSWERED_DEMO_NUMBER);
  if (!from) return deny('not_configured', 'There is no outbound number configured, so nothing can be dialled.');
  if (to === from) return deny('self_call', 'That is our own outbound number.');

  // ── the line type, and the consent question it decides ─────────────────────────────────────
  // A line THIS ESTATE OWNS is not classified by asking a vendor what it is. We already know: we
  // bought it. Spending a paid lookup to be told about our own number is a round trip that can
  // only fail, and the whole reason to classify a number is the consent question below, which an
  // estate-owned line answers by definition because no consumer is on the other end of it.
  const qa = qaNumbers();
  const isQaLine = qa.has(to);
  let lineType = 'estate_line';
  if (!isQaLine) {
    const look = await lookupLine(to);
    if (!look.landed) {
      return deny('lookup_failed', 'We could not check what kind of line that is, and an artificial voice may not call a mobile without a recorded basis, so we did not dial.');
    }
    if (look.valid !== true) return deny('bad_number', 'That number does not look like a working number.');
    lineType = look.lineType || 'unknown';
  }
  // VoIP and unknown fail CLOSED into the wireless rule. Carriers hand out non-fixed VoIP numbers
  // that ring a pocket, and guessing in the permissive direction here is a $500-per-call guess.
  const treatedAsWireless = lineType !== 'landline';
  let consentNote;
  if (treatedAsWireless) {
    if (isQaLine) {
      consentNote = 'estate_qa_line: this number is a line this estate owns, dialled to prove the runtime. No consumer is on it.';
    } else if (inv.consent_basis === 'provided_in_transaction' && inv.number_source) {
      consentNote = `provided_in_transaction: ${inv.number_source}${inv.number_given_at ? ` on ${String(inv.number_given_at).slice(0, 10)}` : ''}`;
    } else {
      return deny(
        'no_wireless_consent',
        `That is a ${lineType} line, and an AI voice may not call one about a debt without prior express consent. `
        + 'This invoice does not record where the number came from, so we did not dial. Record that the customer gave the business this number for the job, or have a person call it by hand.',
        { line_type: lineType },
      );
    }
  } else {
    // 64.1200(a)(3)(iii): an artificial-voice call to a residential line for a commercial purpose
    // that is not telemarketing is exempt, and the exemption carries its own ceiling of three calls
    // in any consecutive 30 days. The tighter of the two ceilings always wins.
    consentNote = 'residential line, non-telemarketing artificial voice exemption, 47 CFR 64.1200(a)(3)(iii)';
    if (Number(facts.placed_total) >= 3) {
      const recent = Number(facts.placed_7d);
      if (recent >= 3) {
        return deny('landline_ceiling', 'Three artificial-voice calls have already gone to this residential line recently, which is the ceiling the exemption carries.');
      }
    }
  }

  return {
    ok: true, invoice: inv, facts, balance_cents: balance, to, from,
    line_type: lineType, lookup_ok: true, is_qa_line: isQaLine,
    call_class: isQaLine ? 'demo' : 'first_party_collection',
    window: win,
    record: {
      decided_at: nowIso(), operator: operator || null,
      creditor_named: inv.business_name,
      window: { local: win.local, tz: win.tz, zone_source: win.source, why: zonesFor({ timezone: inv.debtor_timezone, state: inv.debtor_state, phone: inv.debtor_phone }).why },
      line_type: lineType, treated_as_wireless: treatedAsWireless, consent_basis: consentNote,
      frequency: { placed_today: facts.placed_today, placed_7d: facts.placed_7d, placed_total: facts.placed_total },
      ai_speaking: true, ai_listening: true,
      authorities: ['15 USC 1692a(6)', '15 USC 1692c(a)(1)', '15 USC 1692c(b)', '47 USC 227(b)', 'FCC 24-17', '12 CFR 1006.14(b)(2)'],
    },
  };
}

// ── Twilio ───────────────────────────────────────────────────────────────────────────────────
function twilioAuth() {
  const sid = (process.env.TWILIO_API_SID || '').trim();
  const secret = (process.env.TWILIO_API_SECRET || '').trim();
  return 'Basic ' + Buffer.from(`${sid}:${secret}`).toString('base64');
}

async function lookupLine(phone) {
  try {
    const r = await fetch(`https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(phone)}?Fields=line_type_intelligence`,
      { headers: { Authorization: twilioAuth() }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) {
      console.error('RECOVER: lookup returned', r.status);
      return { landed: false, status: r.status };
    }
    const j = await r.json();
    const lti = j.line_type_intelligence || {};
    if (lti.error_code) return { landed: false, error_code: lti.error_code };
    return { landed: true, valid: j.valid === true, lineType: lti.type || null, carrier: lti.carrier_name || null };
  } catch (e) {
    console.error('RECOVER: lookup failed:', String(e.message).slice(0, 160));
    return { landed: false, error: String(e.message).slice(0, 160) };
  }
}

async function createCall(params) {
  const account = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => form.append(k, String(x)));
    else form.set(k, String(v));
  }
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(account)}/Calls.json`, {
    method: 'POST',
    headers: { Authorization: twilioAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(10000),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = null; }
  if (!r.ok || !j || !j.sid) throw new Error(`twilio ${r.status}: ${(j && j.message) || text.slice(0, 180)}`);
  return j;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// PLACING THE CALL
// ═════════════════════════════════════════════════════════════════════════════════════════════
async function placeCall(invoiceId, { operator, base }) {
  const g = await gate(invoiceId, { operator });

  if (!g.ok) {
    // A REFUSAL IS A ROW. These rows are the evidence the gate ran, and a Recover programme that
    // cannot show its refusals cannot show anything.
    const row = await R.logCall({
      invoice_id: invoiceId, placed: false, refused_reason: g.reason,
      gate: { code: g.code, reason: g.reason, decided_at: nowIso(), operator: operator || null },
      disposition: 'refused',
    }).catch((e) => ({ error: String(e.message).slice(0, 160) }));
    return { placed: false, code: g.code, reason: g.reason, call_row: row, retry_at: g.retry_at || null, retry_after_seconds: g.retry_after_seconds || null };
  }

  const inv = g.invoice;
  // The exact sentence, computed here and STORED, because it is the legal artifact of this call.
  const openingLine = opening({
    businessName: inv.business_name,
    callbackNumber: inv.business_phone || callbackNumber(),
    debtorName: inv.debtor_name,
  });

  const row = await R.logCall({
    invoice_id: invoiceId, placed: false, gate: g.record, opening_spoken: openingLine,
    from_number: g.from, to_number: g.to, disposition: 'placing',
  });
  if (!row || row.error) return { placed: false, code: 'log_failed', reason: 'could not write the call row, so nothing was dialled' };

  const token = crypto.randomBytes(24).toString('hex');
  await R.bindCall(row.id, { token_sha256: sha(token), call_class: g.call_class });
  // ★ THE CAPABILITY URL GOES BACK TO THE OPERATOR WHO JUST MINTED IT, AND THAT IS DELIBERATE.
  // This endpoint is bearer-gated on an estate secret, so the caller already holds strictly more
  // power over this invoice than the token grants: the token can produce the document for ONE
  // call, for ten minutes, and nothing else. Handing it back is what lets an operator read exactly
  // what the person on the other end will hear, and it is what makes the conversation runtime
  // testable through its own serving path rather than by importing the module and hoping.
  const webhook = `${base}/api/recover/twiml?c=${row.id}&t=${token}`;

  // The kill switch is asserted a second time, here, at the moment of the dial. Every gate above is
  // a decision about this invoice; this one is a decision about the whole system.
  if (String(process.env.ANSWERED_RECOVER_KILL || '').trim()) {
    await R.bindCall(row.id, { refused_reason: 'kill switch set between the gate and the dial', outcome: { disposition: 'refused' } });
    return { placed: false, code: 'paused', reason: 'Recover calling was switched off between the gate and the dial.' };
  }

  let call;
  try {
    call = await createCall({
      To: g.to,
      From: g.from,
      Url: `${base}/api/recover/twiml?c=${row.id}&t=${token}`,
      Method: 'POST',
      // Four minutes. A collection conversation that has not finished in four minutes needs a
      // person, and an artificial voice that keeps someone on the line is 1692d(5) territory.
      TimeLimit: 240,
      Timeout: 30,
      MachineDetection: 'DetectMessageEnd',
      MachineDetectionTimeout: 14,
      AsyncAmd: 'false',
      Record: 'true',
      RecordingChannels: 'dual',
      StatusCallback: `${base}/api/recover/status?c=${row.id}&t=${token}`,
      StatusCallbackEvent: ['completed'],
      StatusCallbackMethod: 'POST',
    });
  } catch (e) {
    const msg = String(e.message).slice(0, 200);
    console.error('RECOVER: the dial failed:', msg);
    await R.bindCall(row.id, { refused_reason: `dial failed: ${msg}`, outcome: { disposition: 'dial_failed' } });
    return { placed: false, code: 'dial_failed', reason: msg, call_row_id: row.id, opening_spoken: openingLine, webhook, gate: g.record };
  }

  const bound = await R.bindCall(row.id, { call_sid: call.sid, placed: true, status: call.status });
  return {
    placed: true, call_sid: call.sid, status: call.status, call_row_id: row.id,
    opening_spoken: openingLine, gate: g.record, to: g.to, from: g.from, webhook, bound,
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE WEBHOOKS
// ═════════════════════════════════════════════════════════════════════════════════════════════
const q = (event, k) => {
  const p = event.queryStringParameters || {};
  if (p[k]) return String(p[k]);
  try { return new URL(event.rawUrl).searchParams.get(k) || ''; } catch { return ''; }
};

/** Load the call and its invoice, or nothing at all. A wrong token cannot learn the row exists. */
async function contextFor(event) {
  const id = q(event, 'c');
  const token = q(event, 't');
  if (!id || !token) return null;
  const ctx = await R.callContext(id, sha(token)).catch((e) => {
    console.error('RECOVER webhook: context read failed:', String(e.message).slice(0, 160));
    return null;
  });
  if (!ctx || ctx.error) return null;
  return ctx;
}

/**
 * Write what just happened onto OUR row, and shout if it does not land.
 *
 * ★ THIS USED TO BE `.catch(() => {})` ON EVERY CALL SITE AND THAT WAS A REAL DEFECT, not tidiness.
 * A swallowed rejection here means the disposition, the identity confirmation and the link between a
 * promise and its call all vanish while the caller hears a perfectly normal, warm, correct phone
 * call. The failure is completely invisible from the outside: the conversation still works, and the
 * record it exists to produce is simply empty. It still never ends the call, because a logging
 * failure must not hang up on somebody, but it is LOUD.
 */
async function note(rowId, patch) {
  try {
    const res = await R.touchCall(rowId, patch);
    if (res && res.error) console.error(`RECOVER: call row write refused: ${res.error}`);
    return res;
  } catch (e) {
    console.error('RECOVER: call row write FAILED, the conversation continues but the record does not:', String(e.message).slice(0, 180));
    return null;
  }
}

const gatherTo = (base, event, step, prompt, seconds = 8) =>
  `<Gather input="speech" speechTimeout="auto" timeout="${seconds}" `
  + `action="${esc(`${base}/api/recover/turn?c=${q(event, 'c')}&t=${q(event, 't')}&step=${step}`)}" `
  + `method="POST" actionOnEmptyResult="true" language="en-US">${SAY(prompt)}</Gather>`;

async function handleTwiml(event) {
  const gateway = authenticate(event, '/api/recover/twiml');
  if (!gateway.ok) return gateway.reject;
  const p = gateway.params;
  const base = origin(event);

  const ctx = await contextFor(event);
  if (!ctx) {
    console.error('RECOVER TwiML: no capability record for this request; refusing.');
    return { statusCode: 403, body: 'no token' };
  }
  const inv = ctx.invoice;
  const row = ctx.call;
  const age = Date.now() - Date.parse(row.created_at || '');
  if (!Number.isFinite(age) || age > 10 * 60 * 1000) {
    console.error('RECOVER TwiML: capability token is stale; refusing.');
    return { statusCode: 403, body: 'stale token' };
  }
  if (row.call_sid && p.CallSid && row.call_sid !== p.CallSid) {
    console.error('RECOVER TwiML: token presented for a different call sid; refusing.');
    return { statusCode: 403, body: 'wrong call' };
  }

  const cb = inv.business_phone || callbackNumber();
  const answeredBy = String(p.AnsweredBy || 'unknown');
  // The CallSid is recorded here rather than trusted as a key: this is the first moment the vendor
  // and our row are both in hand, so it is where they get bound together.
  await note(row.id, { answered_by: answeredBy, call_sid: p.CallSid || null });

  if (answeredBy.startsWith('machine')) {
    if (answeredBy === 'machine_end_beep' || answeredBy === 'machine_end_silence' || answeredBy === 'machine_end_other') {
      await note(row.id, { disposition: 'voicemail' });
      return XML(`<Response>${SAY(VOICEMAIL({ businessName: inv.business_name, callbackNumber: cb, debtorName: inv.debtor_name }))}<Hangup/></Response>`);
    }
    return XML('<Response><Hangup/></Response>');
  }
  if (answeredBy === 'fax') return XML('<Response><Hangup/></Response>');

  // ★ THE OPENING SITS OUTSIDE THE <Gather>. A nested <Say> is cut off the instant the other party
  // makes a sound, and every real call opens with a human saying "hello". lib/scripts.mjs measured
  // this on a live call and lost the entire disclosure to the word "Hey there". Keep it here.
  const line = row.opening_spoken || opening({ businessName: inv.business_name, callbackNumber: cb, debtorName: inv.debtor_name });
  return XML(
    '<Response>'
    + transcriptionStart(base, { callSid: p.CallSid, mode: 'recover', to: p.To })
    + SAY(line)
    + gatherTo(base, event, 'identity', identityAsk(inv.debtor_name), 7)
    + '</Response>',
  );
}

async function handleTurn(event) {
  const gateway = authenticate(event, '/api/recover/turn');
  if (!gateway.ok) return gateway.reject;
  const p = gateway.params;
  const base = origin(event);
  const step = q(event, 'step') || 'identity';
  const heard = String(p.SpeechResult || '').trim();

  const ctx = await contextFor(event);
  if (!ctx) return { statusCode: 403, body: 'no token' };
  const inv = ctx.invoice;
  const row = ctx.call;
  const balance = Number(ctx.balance_cents);
  const cb = inv.business_phone || callbackNumber();
  const say = (text) => XML(`<Response>${SAY(text)}<Hangup/></Response>`);

  // ── 0. THE WRONG NUMBER, CHECKED FIRST OF ALL ─────────────────────────────────────────────
  // Before stop and before dispute, because this person is not our debtor and the whole rest of
  // this function is written for somebody who is. Measured on a live call: without this branch,
  // "no, wrong number" matched the dispute list and froze a valid invoice as disputed while the
  // number that does not reach anybody stayed on it, ready to be dialled again tomorrow.
  if (isWrongNumber(heard)) {
    await R.stop(inv.id, `wrong number reported on call ${p.CallSid}: "${heard.slice(0, 200)}"`, p.CallSid, 'stop')
      .catch((e) => console.error('RECOVER: wrong-number stop write failed:', String(e.message).slice(0, 140)));
    await note(row.id, { disposition: 'wrong_number', identity_confirmed: false, call_sid: p.CallSid || null, outcome: { wrong_number: true, heard } });
    return say(WRONG_NUMBER_ACKNOWLEDGED);
  }

  // ── 1. STOP OUTRANKS EVERYTHING ELSE, ON EVERY TURN, BEFORE ANYTHING ELSE RUNS ─────────────
  // 1692c(c) is immediate and unconditional. It is checked before identity, because somebody who
  // says "stop calling me" has said it whether or not they ever confirmed their name.
  if (isStop(heard)) {
    await R.stop(inv.id, `stop requested on call ${p.CallSid}: "${heard.slice(0, 200)}"`, p.CallSid, 'stop').catch((e) => console.error('RECOVER: stop write failed:', String(e.message).slice(0, 140)));
    await note(row.id, { disposition: 'stopped', call_sid: p.CallSid || null, outcome: { stopped: true, heard } });
    return say(STOP_ACKNOWLEDGED);
  }
  // A dispute stops this debt and says nothing about the person, so it never writes a suppression.
  if (isDispute(heard)) {
    await R.stop(inv.id, `disputed on call ${p.CallSid}: "${heard.slice(0, 200)}"`, p.CallSid, 'dispute').catch(() => {});
    await note(row.id, { disposition: 'disputed', call_sid: p.CallSid || null, outcome: { disputed: true, heard } });
    return say(DISPUTE_ACKNOWLEDGED);
  }

  const prefix = askedIfAI(heard) ? `${AI_ANSWER} ` : '';

  // ── 2. IDENTITY, BEFORE ONE WORD ABOUT THE DEBT (1692c(b)) ─────────────────────────────────
  if (step === 'identity' || step === 'identity2') {
    if (saidNo(heard) || (step === 'identity2' && !saidYes(heard))) {
      await note(row.id, { disposition: 'wrong_party', identity_confirmed: false, outcome: { heard } });
      return say(prefix + WRONG_PARTY(inv.business_name, cb));
    }
    if (!saidYes(heard)) {
      // One re-ask, then we treat it as the wrong party and say nothing. Ambiguity is not consent
      // to discuss somebody's debt with whoever answered.
      return XML(`<Response>${gatherTo(base, event, 'identity2', `${prefix}Sorry, I did not catch that. ${identityAsk(inv.debtor_name)}`, 7)}</Response>`);
    }
    await note(row.id, { identity_confirmed: true, disposition: 'reached_debtor', outcome: { identity_heard: heard } });
    return XML(`<Response>${gatherTo(base, event, 'ask', prefix + debtStatement({
      businessName: inv.business_name, amountCents: balance, invoiceNumber: inv.invoice_number,
      jobDescription: inv.job_description, issuedAt: inv.issued_at, jobAddress: inv.job_address,
    }), 10)}</Response>`);
  }

  // ── 3. THE PROMISE ─────────────────────────────────────────────────────────────────────────
  if (step === 'ask' || step === 'ask2') {
    const got = extractPromise(heard, { balanceCents: balance, timezone: promiseZone(inv) });
    if (got.promise) return await recordPromise(inv, row.id, p.CallSid, got, prefix, balance);
    if (got.needs_date) {
      return XML(`<Response>${gatherTo(base, event, 'date', prefix + NO_DATE_YET, 9)}</Response>`);
    }
    if (step === 'ask') {
      const ack = await acknowledge(heard, { businessName: inv.business_name });
      const lead = prefix + (ack ? `${ack} ` : '');
      return XML(`<Response>${gatherTo(base, event, 'ask2', `${lead}What day works for getting it paid?`, 9)}</Response>`);
    }
    await note(row.id, { disposition: 'no_promise', outcome: { last_heard: heard } });
    return say(prefix + CLOSE_UNRESOLVED(inv.business_name, cb));
  }

  // ── 4. THEY WERE WILLING BUT HAD NOT NAMED A DAY ───────────────────────────────────────────
  if (step === 'date') {
    const date = parseDate(heard, { timezone: promiseZone(inv) });
    if (date.iso) {
      const amount = parseAmountCents(heard, balance);
      return await recordPromise(inv, row.id, p.CallSid, {
        promise: { amount_cents: amount.cents ?? balance, promised_for: date.iso, spoken_text: heard.slice(0, 1000), method: 'spoken_on_call' },
        reason: `${date.how}; ${amount.how}`,
      }, prefix, balance);
    }
    await note(row.id, { disposition: 'no_promise', outcome: { last_heard: heard, date_parse: date.how } });
    return say(prefix + CLOSE_UNRESOLVED(inv.business_name, cb));
  }

  return say(CLOSE_UNRESOLVED(inv.business_name, cb));
}

/** The debtor's own zone, so "Friday" is their Friday. Falls back only to something knowable. */
function promiseZone(inv) {
  const z = zonesFor({ timezone: inv.debtor_timezone, state: inv.debtor_state, phone: inv.debtor_phone });
  return (z.zones && z.zones[0]) || 'America/Los_Angeles';
}

async function recordPromise(inv, rowId, callSid, got, prefix, balance) {
  const amount = Number.isFinite(got.promise.amount_cents) ? got.promise.amount_cents : balance;
  const saved = await R.promise({
    invoice_id: inv.id, call_sid: callSid, amount_cents: amount,
    promised_for: got.promise.promised_for, spoken_text: got.promise.spoken_text, method: 'spoken_on_call',
  }).catch((e) => {
    console.error('RECOVER: promise write failed:', String(e.message).slice(0, 160));
    return null;
  });
  await note(rowId, {
    disposition: 'promise_to_pay', identity_confirmed: true, call_sid: callSid || null,
    outcome: { promise: got.promise, how: got.reason, saved: Boolean(saved && !saved.error) },
  });
  // ★ THE CLOSE READS THE PROMISE BACK OUT LOUD. It is the one moment the person can correct it,
  // and a promise nobody heard confirmed is a follow-up date we invented for them.
  return XML(`<Response>${SAY(prefix + PROMISE_CLOSE(amount, got.promise.promised_for, inv.business_name))}<Hangup/></Response>`);
}

async function handleStatus(event) {
  const gateway = authenticate(event, '/api/recover/status');
  if (!gateway.ok) return gateway.reject;
  const p = gateway.params;
  if (p.CallSid) {
    await R.updateCall(p.CallSid, {
      status: p.CallStatus || null,
      duration_seconds: Number(p.CallDuration || 0) || 0,
      answered_by: p.AnsweredBy || null,
      ended_at: nowIso(),
    }).catch((e) => console.error('RECOVER status: could not record the outcome:', String(e.message).slice(0, 160)));
  }
  return { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: 'ok' };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE OPERATOR API
// ═════════════════════════════════════════════════════════════════════════════════════════════
async function handleApi(event) {
  if (event.httpMethod === 'GET') {
    // Enough to prove the endpoint is alive and configured, and nothing about anybody's invoices.
    return ok({
      ok: true,
      what: 'Recover: first-party invoice calls, in the creditor own name.',
      configured: {
        db: R.dbConfigured(),
        twilio: Boolean((process.env.TWILIO_ACCOUNT_SID || '').trim() && (process.env.TWILIO_API_SID || '').trim()),
        from_number: Boolean(e164(process.env.ANSWERED_RECOVER_FROM || process.env.ANSWERED_DEMO_NUMBER)),
        language_layer: Boolean(ANTHROPIC_KEY()),
        paused: Boolean(String(process.env.ANSWERED_RECOVER_KILL || '').trim()),
      },
      ops: ['invoice.upsert', 'invoice', 'gate', 'call', 'promise', 'payment', 'stop', 'board'],
    });
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: { Allow: 'GET, POST' }, body: 'Method not allowed' };

  const auth = authorize(event.headers, { allow: ['ANSWERED_BOOKING_SECRET', 'ANSWERED_COCKPIT_KEY'] });
  if (!auth.ok) return bad(auth.status, auth.message);
  if (!R.dbConfigured()) return bad(503, 'The record spine is not configured, so nothing here can run.');

  let body;
  try {
    body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '{}');
  } catch { return bad(400, 'bad json'); }
  const op = String(body.op || '');
  const base = origin(event);

  try {
    if (op === 'invoice.upsert') {
      const need = ['account_key', 'business_name', 'invoice_number', 'amount_cents', 'issued_at', 'debtor_name', 'debtor_phone', 'band'];
      const missing = need.filter((k) => body[k] === undefined || body[k] === null || String(body[k]).trim() === '');
      if (missing.length) return bad(400, `an invoice needs ${missing.join(', ')}`, { missing });
      if (!e164(body.debtor_phone)) return bad(400, 'debtor_phone must be E.164, like +19165550123');
      if (!['newer', 'most', 'oldest'].includes(String(body.band))) return bad(400, 'band must be newer, most or oldest');
      const res = await R.upsertInvoice(body);
      if (res && res.error) return bad(409, res.error);
      return ok({ ok: true, ...res });
    }

    if (op === 'invoice') {
      if (!body.id) return bad(400, 'need id');
      const res = await R.getInvoice(body.id);
      if (res && res.error) return bad(404, res.error);
      return ok({ ok: true, ...res });
    }

    if (op === 'gate') {
      if (!body.invoice_id) return bad(400, 'need invoice_id');
      // The gate, run and REPORTED, without dialling. This is what an operator reads before they
      // press the button, and it is the same code path the button runs.
      const g = await gate(body.invoice_id, { operator: `${auth.as}:dry-run` });
      return ok({ ok: true, dialable: Boolean(g.ok), ...g });
    }

    if (op === 'call') {
      if (!body.invoice_id) return bad(400, 'need invoice_id');
      const res = await placeCall(body.invoice_id, { operator: body.operator || auth.as, base });
      return ok({ ok: true, ...res });
    }

    if (op === 'promise') {
      // An operator recording a promise taken off-system. The call records its own.
      if (!body.invoice_id || !body.promised_for || !body.spoken_text) {
        return bad(400, 'a promise needs invoice_id, promised_for and spoken_text, which is what they actually said');
      }
      const res = await R.promise({ ...body, method: body.method || 'operator_recorded' });
      return ok({ ok: true, promise: res });
    }

    if (op === 'stop') {
      if (!body.invoice_id) return bad(400, 'need invoice_id');
      const res = await R.stop(body.invoice_id, body.reason || 'stop recorded by an operator', body.call_sid || null, body.kind || 'stop');
      if (res && res.error) return bad(404, res.error);
      return ok({ ok: true, invoice: res });
    }

    if (op === 'payment') return await handlePayment(body, auth);

    if (op === 'board') {
      const res = await R.board({ accountKey: body.account_key, status: body.status, limit: body.limit, offset: body.offset });
      return ok({ ok: true, ...res });
    }

    return bad(400, `"${op || '(none)'}" is not an op this endpoint has.`);
  } catch (e) {
    console.error('RECOVER api:', String(e && e.stack || e).slice(0, 400));
    return bad(500, String(e.message).slice(0, 200));
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE MONEY. A RECOVER FEE EXISTS ONLY BECAUSE A PAYMENT LANDED, AND ONLY IF WE DID SOMETHING.
// ═════════════════════════════════════════════════════════════════════════════════════════════
async function handlePayment(body, auth) {
  if (!body.invoice_id || !Number.isFinite(Number(body.amount_cents)) || Number(body.amount_cents) <= 0) {
    return bad(400, 'a payment needs invoice_id and amount_cents, and nothing lands for zero');
  }
  const idem = String(body.idem_key || '').trim();
  if (!idem) return bad(400, 'every payment needs an idem_key, usually the bank reference or the invoice and date');

  const res = await R.payment({
    invoice_id: body.invoice_id, amount_cents: Number(body.amount_cents),
    landed_at: body.landed_at || nowIso(), source: body.source || 'operator_confirmed',
    reference: body.reference || null, recorded_by: body.recorded_by || auth.as, idem_key: idem,
  });
  if (res && res.error) return bad(404, res.error);

  const inv = res.invoice;
  const m = res.meter_inputs;

  // ★ THE FEE IS REFUSED WHEN WE DID NOTHING. meter.mjs will happily rate a recover_landed event
  // that has a band and a payment, because it has no way to know whether a call was ever placed.
  // This does. A customer who loads an invoice, never lets us dial, and then gets paid by their own
  // customer owes us nothing, and the honest place to enforce that is here, before the ledger.
  if (!Number(res.placed_calls)) {
    const reason = 'No Recover call was ever placed on this invoice, so this money is not ours to take a share of. Recorded, not billed.';
    await R.paymentRated(res.payment.id, { ok: true, billable: false, cents: 0, reason, refused_because: 'no_call_placed' }, null);
    return ok({ ok: true, recorded: true, billed: false, reason, payment: res.payment, invoice: inv, balance_cents: res.balance_cents });
  }

  // ★ SPOKEN IS NOT WRITTEN, AND THIS IS THE LINE THAT HOLDS IT.
  // /terms: "the payment lands within 30 days of our last contact on that invoice, OR by a date the
  // payer promised IN WRITING." A promise captured off a recorded call is spoken. The transcript of
  // it is written, and calling that "promised in writing" is exactly the kind of stretch that reads
  // fine in code review and terrible in a dispute. So promised_by is NOT passed to the meter from a
  // spoken promise. The consequence is real and it favours the customer: a payment that lands more
  // than 30 days after our last contact, on a promise somebody made out loud, is FREE.
  const event = {
    kind: inv.fee_mode === 'flat' ? 'autopilot_invoice_paid' : 'recover_landed',
    idem_key: `recover-pay-${res.payment.id}`,
    occurred_at: m.landed_at,
    recovered_cents: m.recovered_cents,
    band: m.band,
    band_shown_at: m.band_shown_at,
    first_call_at: m.first_call_at,
    last_contact_at: m.last_contact_at,
    landed_at: m.landed_at,
    paid_at: inv.fee_mode === 'flat' ? m.landed_at : undefined,
    evidence: {
      invoice_id: inv.id, invoice_number: inv.invoice_number, business_name: inv.business_name,
      calls_placed: res.placed_calls, conversations: res.conversations,
      spoken_promise: res.spoken_promise
        ? { promised_for: res.spoken_promise.promised_for, spoken_text: res.spoken_promise.spoken_text,
            note: 'spoken on a recorded call, which is not "promised in writing", so it did not extend the window' }
        : null,
    },
  };

  let rated = null; let billingEventId = null; let ledgerError = null;
  try {
    rated = await ledger.meterAndRecord(inv.account_key, event);
    billingEventId = rated && rated.id ? rated.id : null;
  } catch (e) {
    ledgerError = String(e.message).slice(0, 200);
    console.error('RECOVER: the ledger refused or failed:', ledgerError);
  }
  await R.paymentRated(res.payment.id, rated ? { ...rated.rating, recorded_cents: rated.cents, replay: rated.replay } : { error: ledgerError }, billingEventId).catch(() => {});

  return ok({
    ok: true, recorded: true, billed: Boolean(rated && rated.cents > 0),
    payment: res.payment, invoice: inv, balance_cents: res.balance_cents,
    fee: rated ? { cents: rated.cents, gross_cents: rated.gross_cents, reason: rated.reason, usd: ledger.usd(rated.cents || 0), replay: rated.replay } : null,
    ledger_error: ledgerError,
    spoken_promise_note: res.spoken_promise ? 'A spoken promise was recorded and deliberately NOT used to extend the recovered window, because /terms says "in writing".' : null,
  });
}

// ── the front door ───────────────────────────────────────────────────────────────────────────
function roleOf(event) {
  let path = String(event.path || '');
  try { path = new URL(event.rawUrl).pathname || path; } catch { /* event.path stands */ }
  const p = path.replace(/\/+$/, '');
  if (p.endsWith('/twiml')) return 'twiml';
  if (p.endsWith('/turn')) return 'turn';
  if (p.endsWith('/status')) return 'status';
  return 'api';
}

async function route(event) {
  const role = roleOf(event);
  try {
    if (role === 'twiml') return await handleTwiml(event);
    if (role === 'turn') return await handleTurn(event);
    if (role === 'status') return await handleStatus(event);
    return await handleApi(event);
  } catch (e) {
    console.error('RECOVER unhandled:', String(e && e.stack || e).slice(0, 400));
    if (role === 'twiml' || role === 'turn') {
      // Somebody is holding a phone. They get an honest sentence, never silence.
      return XML(`<Response>${SAY(BROKEN('the business that sent your invoice', callbackNumber()))}<Hangup/></Response>`);
    }
    return bad(500, 'Something broke on our side.');
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// ★★ THE EXPORT SHAPE IS LOAD-BEARING, AND GETTING IT WRONG IS A SILENT 404 ON EVERY ROUTE.
//
// `config.path` is a NETLIFY V2 FEATURE. A v2 function is `export default async (req, context)`
// taking a Request and returning a Response. This file was first written with the v1 shape,
// `export const handler = async (event) => ...`, WITH a perfectly correct static literal
// `config.path` sitting right above it, and every one of the four declared routes answered 404
// while `/.netlify/functions/recover` answered 200. No error. No warning. The bundle built, the
// deploy went green, and `_stage.sh`'s drift check PASSED, because that check greps the file for
// declared paths and confirms they are monitored: it proves a route was DECLARED, never that it
// EXISTS. Measured on a real draft deploy, which is the only thing that caught it.
//
// So the estate note that a computed `config.path` is silently dropped has a twin, and this is it:
// a correct `config.path` on a v1 handler is silently dropped too.
//
// The shim below is deliberate rather than a rewrite. `lib/twilio-webhook.mjs` is shared with five
// other functions and its `authenticate()` / `origin()` / signature validation all read the v1
// event shape, including `rawUrl` and `rawQuery`, which the Twilio signature check needs to
// reconstruct the signed URL. Changing that library to suit this file would be changing a
// compliance control under four other lanes. Adapting at this boundary changes nothing but this
// function.
// ═════════════════════════════════════════════════════════════════════════════════════════════
async function toEvent(req) {
  const url = new URL(req.url);
  const headers = {};
  for (const [k, v] of req.headers.entries()) headers[k] = v;
  const body = (req.method === 'GET' || req.method === 'HEAD') ? '' : await req.text();
  return {
    httpMethod: req.method,
    headers,
    body,
    isBase64Encoded: false,
    rawUrl: req.url,
    rawQuery: url.search.replace(/^\?/, ''),
    path: url.pathname,
    queryStringParameters: Object.fromEntries(url.searchParams.entries()),
  };
}

export default async (req) => {
  const event = await toEvent(req);
  const r = await route(event);
  return new Response(r.body ?? '', { status: r.statusCode || 200, headers: r.headers || {} });
};
