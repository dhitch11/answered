// hold-policy.mjs — who Hold may ring, when, and at which of the two published prices.
//
// ★ WHY THIS IS NOT research/lib/lane.mjs, AND WHY REUSING THAT WOULD HAVE BEEN WRONG TWICE.
//
// `classify()` in lane.mjs is an excellent gate for the thing it was built for: COLD OUTBOUND
// PROSPECTING to businesses that never asked to hear from us. Its defaults are a 9:00-16:30
// Mon-Fri window, a cap of ONE call per number per thirty days, and two condition-precedent flags
// (`dncScrubbed`, `dncProceduresInPlace`) that are both false today and deny every non-consented
// call outright. Pointed at Hold it fails in both directions at once:
//
//   TOO TIGHT  A redial after the queue drops you is a second call to the same number the same
//              hour, so the frequency cap refuses the one behaviour /hold sells by name
//              ("across redials and reconnects"). A customer stuck on a benefits line at 7pm gets
//              refused for being outside a window built around catching contractors at a desk.
//   TOO LOOSE  Nothing in it models the leg that actually carries TCPA exposure here, which is
//              the call to OUR OWN CUSTOMER when we ring them in.
//
// And the do-not-call machinery it enforces is aimed at a different animal. 47 CFR 64.1200(c)(2)
// governs "telephone solicitation" to a "residential telephone subscriber", and a solicitation is
// defined at 47 USC 227(a)(4) as a call to encourage the purchase, rental or investment in
// property, goods or services. A Hold call makes no offer to the party it reaches. It is the
// customer's own errand about the customer's own account, placed to a number that party publishes
// for exactly that purpose. Running a solicitation gate over it would refuse every call for
// failing a test it is not taking.
//
// ── SO WHAT DOES BIND, AND IT IS ENCODED BELOW ───────────────────────────────────────────────
//
//   THE LEG TO OUR CUSTOMER. We dial a consumer with an artificial voice on the line. That is
//   47 CFR 64.1200(a)(1) squarely, and the answer is prior express consent, captured server side,
//   in writing, before anything is dialled, with the exact words they agreed to stored alongside.
//   That is why `requireConsent` has no override and no environment variable.
//
//   THE LEG TO THE TARGET. An artificial voice reaches this party. Two facts decide it:
//     - A MOBILE target is refused outright. 64.1200(a)(1) reaches numbers assigned to cellular
//       service whatever the call is about, we hold no consent from that party, and no amount of
//       "it is a business" cures it.
//     - A TOLL-FREE target is the honest open question on this whole product, and it is recorded
//       rather than resolved. The same subsection reaches "any service for which the called party
//       is charged for the call", which is what toll-free means. The counter-argument, that a
//       body publishing an 800 number for public enquiries has consented to public enquiries on
//       it, is a good argument and it is still an argument. Most government queues ARE toll-free,
//       so this is not a footnote, it is the product. It is flagged on the session, surfaced to
//       the operator, and left for a decision above this file.
//
//   QUIET HOURS, BY THE CALLEE'S OWN LOCAL TIME, on both legs. 8:00 to 21:00, seven days, which is
//   the published TCPA window rather than the tighter prospecting one. Derived from the STATE on
//   the record, never from the area code, for the reason research/lib/geo.mjs already gives: an
//   area-code table is wrong in exactly the places that matter.
//
//   SUPPRESSION, on both numbers, read fresh from the database on every dial. Someone who said
//   stop is never rung, and a suppression read that FAILS is a refusal, not a shrug.
//
// ── THE DOOR ─────────────────────────────────────────────────────────────────────────────────
// `ANSWERED_HOLD_OPEN` decides whether a target this system has never seen is dialled
// automatically or waits for a human to approve it. Unset means waits. That is not a limitation
// of the runtime, which is complete either way: it is a deliberate refusal to let one lane decide
// the toll-free question above by shipping a default.

import * as db from './db.mjs';
import * as tw from './twilio-rest.mjs';
import { withinWindow, nextOpenTime, STATE_ZONES } from '../../../research/lib/geo.mjs';

/** The published TCPA calling window, seven days a week, in the callee's own local time. */
export const HOLD_WINDOW = Object.freeze({
  startHour: 8, startMinute: 0, endHour: 21, endMinute: 0,
  days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
});

/** Line types we will point an artificial voice at without that party's own consent. */
const TARGET_OK = new Set(['landline', 'fixedVoip', 'uan', 'tollFree', 'sharedCost']);
const TARGET_REFUSED = new Set(['mobile', 'personal', 'pager', 'premium']);
const CHARGED_PARTY = new Set(['tollFree', 'sharedCost', 'premium']);

export const E164 = /^\+1\d{10}$/;

export const knownState = (s) => Object.prototype.hasOwnProperty.call(STATE_ZONES, String(s || '').toUpperCase());

/** The allowlist of targets that may be dialled with no human in the loop. */
export function targetAllowlist() {
  const raw = String(process.env.ANSWERED_HOLD_TARGETS || '').trim();
  const fromEnv = raw ? raw.split(/[\s,]+/).filter((n) => E164.test(n)) : [];
  // Our own lines are always safe to call: they are ours.
  for (const k of ['ANSWERED_DEMO_NUMBER', 'CANARY_FROM_NUMBER', 'ANSWERED_QA_NUMBER']) {
    const v = String(process.env[k] || '').trim();
    if (E164.test(v)) fromEnv.push(v);
  }
  return [...new Set(fromEnv)];
}

export const doorIsOpen = () => String(process.env.ANSWERED_HOLD_OPEN || '') === '1';

/**
 * The price class. Never inferred from a line type, because line type does not know whether a
 * number belongs to a county benefits office or a mattress shop.
 *
 * ★ THE DEFAULT IS THE CHEAPER PRICE, ON PURPOSE. $10 commercial is the floor and $20 government
 * is only ever reached from a recorded source, so an unproved upgrade falls toward the customer.
 * That is the same rule lib/meter.mjs already applies to an after-hours booking with no timestamp,
 * and it is the only direction a self-declared field can safely move a bill.
 */
export function priceClass({ declared, operatorVerified }) {
  if (operatorVerified === 'gov') return { line_class: 'gov', line_class_source: 'operator_verified' };
  if (operatorVerified === 'commercial') return { line_class: 'commercial', line_class_source: 'operator_verified' };
  if (declared === 'gov') return { line_class: 'gov', line_class_source: 'requester_declared' };
  return { line_class: 'commercial', line_class_source: 'default_commercial' };
}

const refuse = (reason, extra = {}) => ({ ok: false, dialable: false, reasons: [reason], ...extra });

/**
 * The gate for ONE leg. Returns a verdict, never throws, and every uncertain answer is a refusal.
 *
 * @param {string} phone   E.164
 * @param {object} o       { state, leg: 'target'|'user', at }
 */
export async function gateLeg(phone, o = {}) {
  const at = o.at instanceof Date ? o.at : new Date();
  const leg = o.leg === 'user' ? 'user' : 'target';

  if (!E164.test(String(phone || ''))) return refuse(`not a valid US number: ${String(phone || '').slice(0, 20)}`);

  // Suppression and the registry come from the database, read fresh. A read that fails is a
  // refusal: a gate that opens because it could not check is not a gate.
  let ctx = null;
  try { ctx = await db.dialContext(phone); } catch (e) {
    return refuse(`could not read the suppression list for this number (${String(e.message).slice(0, 90)}); refusing rather than guessing`);
  }
  if (!ctx || typeof ctx.suppressed !== 'boolean') {
    return refuse(`the suppression answer for this number came back malformed (${JSON.stringify(ctx && ctx.suppressed)}); refusing rather than assuming`);
  }
  if (ctx.suppressed) return refuse('this number is on our do-not-call list');

  // ★ THE NUMBER'S OWN STATE WINS, exactly as lib/dial.mjs decided for the same reason: a state
  // asserted on a form is a fallback for a number nobody has ever sourced, never an override that
  // could move a line into a friendlier timezone and open the quiet-hours gate.
  const state = String(ctx.contact?.state || o.state || '').toUpperCase();
  if (!knownState(state)) {
    return refuse(`no state on record for this number, so its local time cannot be established`, { needs: 'state' });
  }
  const win = withinWindow(state, HOLD_WINDOW, at);
  if (!win.ok) {
    return {
      ok: true, dialable: false, deferred: true,
      reasons: [`quiet hours where this number is: ${win.reason}`],
      retryAt: nextOpenTime(state, HOLD_WINDOW, at), state, zones: win.zones, leg,
    };
  }

  // ── the target's own line type ─────────────────────────────────────────────────────────────
  if (leg === 'target') {
    const lt = await tw.lineType(phone);
    if (!lt.lookupOk) {
      return refuse(`could not classify this line (${String(lt.error || 'lookup failed').slice(0, 80)}); an unclassified number is never dialled with an artificial voice`,
        { lookup_ok: false, line_type: null, state, leg });
    }
    if (TARGET_REFUSED.has(lt.lineType)) {
      return refuse(`${lt.lineType}: an artificial voice to a mobile or paging number needs that party's own prior express consent, 47 CFR 64.1200(a)(1), and we do not have it`,
        { lookup_ok: true, line_type: lt.lineType, state, leg });
    }
    if (!TARGET_OK.has(lt.lineType)) {
      return refuse(`line type "${lt.lineType || 'unknown'}" is not one this gate knows how to reason about`,
        { lookup_ok: true, line_type: lt.lineType, state, leg });
    }
    return {
      ok: true, dialable: true, reasons: [`${lt.lineType}, inside the calling window in ${state}`],
      line_type: lt.lineType, lookup_ok: true, carrier: lt.carrier || null, state, zones: win.zones, leg,
      // Recorded, not resolved. See the header.
      charged_party_prong: CHARGED_PARTY.has(lt.lineType) ? 'unresolved' : 'not_engaged',
    };
  }

  // ── our own customer's leg ─────────────────────────────────────────────────────────────────
  // The one place consent is not optional and has no environment variable.
  const consent = ctx.consent || null;
  const valid = consent && consent.granted_at
    && (!consent.expires_at || new Date(consent.expires_at) > at)
    && String(consent.scope || '').startsWith('hold');
  if (!valid) {
    return refuse('we have no recorded consent from this number for a Hold call back, so we will not ring it',
      { state, leg, consent_scope: consent ? consent.scope : null });
  }
  return {
    ok: true, dialable: true, state, zones: win.zones, leg,
    reasons: [`consent on file (${consent.source}, ${consent.granted_at})`],
    consent_source: consent.source, consent_at: consent.granted_at,
  };
}

/**
 * Both legs at once, plus the door. This is what /api/hold calls before it creates anything.
 * A refusal here is still a recorded session, because "we would not dial this and here is why"
 * is the answer the customer and the operator both need.
 */
export async function gateSession({ target, requester, targetState, requesterState, at }) {
  const [t, u] = await Promise.all([
    gateLeg(target, { state: targetState, leg: 'target', at }),
    gateLeg(requester, { state: requesterState, leg: 'user', at }),
  ]);

  const allow = targetAllowlist();
  const onList = allow.includes(target);
  const auto = onList || doorIsOpen();

  const reasons = [];
  if (!t.dialable) reasons.push(`the line you asked us to call: ${t.reasons.join('; ')}`);
  if (!u.dialable) reasons.push(`your own number: ${u.reasons.join('; ')}`);

  return {
    target: t,
    user: u,
    // Deferred means "not now", which for a Hold errand is a schedule, not a refusal.
    deferred: Boolean(t.deferred || u.deferred),
    retryAt: t.retryAt || u.retryAt || null,
    dialable: Boolean(t.dialable && u.dialable),
    // ★ The door is a SEPARATE answer from the gate, and keeping them separate is the point.
    // A session can be perfectly lawful to dial and still wait for a human, and the customer is
    // told it is being checked rather than told no.
    auto_dial: Boolean(t.dialable && u.dialable && auto),
    needs_operator: Boolean(t.dialable && u.dialable && !auto),
    door: onList ? 'allowlisted_target' : (doorIsOpen() ? 'open' : 'operator_approval'),
    reasons,
    decided_at: new Date().toISOString(),
  };
}
