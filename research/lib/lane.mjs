// lane.mjs — the gate every number passes through before the dialler ever sees it.
//
// THE RULE THIS ENCODES, from primary text read 2026-08-13:
//
//   47 CFR 64.1200(a)(1)  Artificial or prerecorded voice to a number assigned to a cellular or
//                         other radio common carrier service, or any service where the called
//                         party is charged, requires prior express consent. It does not matter
//                         what the call is about. A research call gets no relief here.
//   47 CFR 64.1200(a)(3)  The non-consented exemptions (non-commercial, or commercial with no
//                         advertisement and no telemarketing, each capped at three calls per
//                         consecutive 30 days) are written against a "residential line". By its
//                         terms that prong reaches neither a business landline nor a mobile.
//   47 CFR 64.1200(b)     An artificial or prerecorded voice message must identify who is
//                         responsible for the call at the start and give a callback number.
//   FCC 24-17 (2024-02-08) An AI-generated voice IS an "artificial voice" for all of the above.
//   Cal. AB 2905 (in force 2025-01-01) AI-generated voice must be disclosed at the start of the
//                         call. $500 per violation.
//
// So the dialable lane for a cold, non-promotional research call is: verified business landline
// or fixed VoIP, inside the calling window, not suppressed, under the frequency cap, with the
// identification and AI disclosure spoken at the open.
//
// Everything else needs consent first, and consent is cheap to get honestly. Guessing is $500
// a guess, trebled if wilful, uncapped, and class-actionable.
//
// FAIL CLOSED IS THE WHOLE DESIGN. An unclassifiable number is a RED number, not a maybe. A
// missing state is a RED number. A Lookup call that errored is a RED number. There is no code
// path in this file where uncertainty resolves to "dial it".

import { withinWindow, nextOpenTime } from './geo.mjs';

export const LANES = { GREEN: 'green', AMBER: 'amber', RED: 'red', HOLD: 'hold' };

/** Twilio Line Type Intelligence values, sorted into what they mean for us. */
const LINE_TYPES = {
  landline:        { fixed: true,  personal: false },
  fixedVoip:       { fixed: true,  personal: false },
  nonFixedVoip:    { fixed: false, personal: false },
  mobile:          { fixed: false, personal: true },
  personal:        { fixed: false, personal: true },
  tollFree:        { fixed: true,  personal: false, tollFree: true },
  premium:         { fixed: true,  personal: false, tollFree: true },
  sharedCost:      { fixed: true,  personal: false, tollFree: true },
  uan:             { fixed: true,  personal: false },
  voicemail:       { fixed: false, personal: false },
  pager:           { fixed: false, personal: true },
  unknown:         { fixed: false, personal: false },
};

/**
 * ★ STATES THAT REQUIRE A TELEPHONE-SOLICITOR REGISTRATION AND/OR A BOND BEFORE THE FIRST CALL.
 *
 * These are LICENSING gates, not conduct rules: no script, no disclosure and no dialing technique
 * cures them, and they bind before dial #1 rather than after some threshold.
 *   TX  Bus. & Com. Code 302.101 + 302.107 ($10,000 security). 302.251(b) makes each unregistered
 *       call a Class A misdemeanour and 302.252 extends that PERSONALLY to the individual rep.
 *   WA  RCW 19.158.050 — an unregistered solicitor may not "maintain OR DEFEND a lawsuit" in state.
 *   FL  Telemarketing Act 501.605 (FDACS licence, $1,500) + 501.611(2) ($50,000 minimum security).
 *
 * Texas and Florida are two of the largest contractor markets in the country, so suppressing them
 * is a revenue decision and not a footnote. It is recorded here as a decision rather than buried.
 */
export const LICENSING_REQUIRED_STATES = new Set(['TX', 'WA', 'FL']);

/**
 * ★ ILLINOIS: BIPA 740 ILCS 14/15(b) requires a WRITTEN release before a voiceprint is collected,
 * and no spoken call-open disclosure can supply one. Blocked until the transcription stack can
 * demonstrably prove it performs no voice-based speaker modelling (channel separation is fine;
 * a persisted voice embedding is not).
 */
export const BIOMETRIC_RISK_STATES = new Set(['IL']);

export const DEFAULT_POLICY = {
  // Tighter than the 8am-9pm TCPA telemarketing window on purpose: we are calling businesses
  // and we want them at a desk, not at breakfast.
  window: { startHour: 9, startMinute: 0, endHour: 16, endMinute: 30, days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] },
  // The residential exemption tops out at three calls per 30 days. One is comfortably inside it
  // and is also all a research campaign has any business needing.
  maxCallsPer30Days: 1,
  // A call with a pitch in it is telemarketing whatever we call the campaign, and telemarketing
  // by artificial voice needs prior express WRITTEN consent. Research scripts carry no offer of
  // sale; the free Shadow Week is framed and logged as a research incentive, not a sale.
  promotional: false,

  // ★ ADDED AFTER ADVERSARIAL VERIFICATION, 2026-08-14. Six independent lenses attacked the
  // position that a manually dialled human-voice call is lawful for cold B2B prospecting. All six
  // conceded the narrow statutory reading and all six rejected the conclusion, because the two
  // regimes that actually govern this program contain NO dialing-technology element at all:
  // 47 USC 227(c) / 47 CFR 64.1200(c)-(d) (the do-not-call program) and state all-party wiretap
  // law. Manual dialing buys nothing against either.
  //
  // 47 CFR 64.1200(d) is a CONDITION PRECEDENT: "No person or entity shall initiate any call for
  // telemarketing purposes ... UNLESS such person or entity has instituted procedures". A company
  // with no written procedures has no safe harbour to invoke, so its first wrong call is
  // unmitigated. These two flags are false because those programs do not exist yet.
  dncScrubbed: false,          // national DNC registry, snapshot no older than 31 days
  dncProceduresInPlace: false, // the six elements of 64.1200(d), written, trained, retained
};

/**
 * Decide the lane for one record.
 *
 * @param {object} rec           { phone, state, lineType, lookupOk, consent, callCount30d }
 * @param {object} policy        see DEFAULT_POLICY
 * @param {Set<string>} suppress E.164 numbers that must never be dialled again
 * @param {Date} at              evaluation instant (injectable so this is testable)
 */
export function classify(rec, policy = DEFAULT_POLICY, suppress = new Set(), at = new Date()) {
  const reasons = [];
  const deny = (reason) => { reasons.push(reason); return { lane: LANES.RED, dialable: false, reasons }; };

  if (!rec.phone || !/^\+1\d{10}$/.test(rec.phone)) return deny('not a valid US E.164 number');
  if (suppress.has(rec.phone)) return deny('on the suppression list');

  // --- consent short-circuits the line-type question entirely -------------------------------
  const consent = rec.consent && rec.consent.grantedAt ? rec.consent : null;
  const consentValid = consent
    && (!consent.expiresAt || new Date(consent.expiresAt) > at)
    && consent.scope === 'research_call';

  // --- line type ----------------------------------------------------------------------------
  if (!consentValid) {
    if (rec.lookupOk === false) return deny('line-type lookup failed; unclassified numbers are never dialled');
    const type = LINE_TYPES[rec.lineType];
    if (!type) return deny(`line type "${rec.lineType || 'missing'}" is unknown to the gate`);
    if (type.tollFree) return deny('toll-free: the called party pays for the call');
    if (type.personal) return deny(`${rec.lineType}: artificial voice to a mobile needs prior express consent, 47 CFR 64.1200(a)(1)`);
    if (!type.fixed) return deny(`${rec.lineType}: not a verified fixed business line`);
  }

  if (policy.promotional && !(consentValid && consent.written)) {
    return deny('promotional content requires prior express WRITTEN consent');
  }

  // --- frequency ----------------------------------------------------------------------------
  const cap = policy.maxCallsPer30Days ?? DEFAULT_POLICY.maxCallsPer30Days;
  if ((rec.callCount30d || 0) >= cap) return deny(`already called ${rec.callCount30d} time(s) in the last 30 days (cap ${cap})`);

  // --- the preconditions manual dialling does NOT cure ---------------------------------------
  // Six adversarial lenses attacked "a human dials and speaks, therefore it is lawful". All six
  // conceded the narrow 227(b) reading and all six rejected the conclusion, because the regimes
  // that actually govern have no dialling-technology element. These run for every non-consented
  // call, AI-voiced or human-voiced, because none of them care which it is.
  const st = String(rec.state || '').toUpperCase();
  if (!consentValid) {
    if (LICENSING_REQUIRED_STATES.has(st)) {
      return deny(`${st} requires a telephone-solicitor registration and bond before the first call; a licensing gate no script or dialling method cures`);
    }
    if (BIOMETRIC_RISK_STATES.has(st)) {
      return deny(`${st}: BIPA 740 ILCS 14/15(b) needs a WRITTEN release before any voiceprint, which a spoken disclosure cannot supply`);
    }
    if (!policy.dncScrubbed) {
      return deny('the national do-not-call registry has not been scrubbed; 47 CFR 64.1200(c)(2) has no business exemption and the FCC expressly refused to create one in 2005');
    }
    // The per-number answer is three-state. `null` means we could not check, and an unanswerable
    // question is a refusal here exactly as it is everywhere else in this gate.
    if (rec.dncListed === true) {
      return deny('this number is on the national Do-Not-Call Registry');
    }
    if (rec.dncListed !== false) {
      return deny('could not check this number against a fresh registry snapshot; unanswerable is not permission');
    }
    if (!policy.dncProceduresInPlace) {
      return deny('47 CFR 64.1200(d) is a condition precedent: without the written policy, training, internal list, identification, affiliate scope and five-year retention there is no safe harbour to invoke');
    }
  }

  // --- hour of day. Not a refusal, a deferral. ----------------------------------------------
  if (!rec.state) return deny('no source state on the record, so the local time cannot be established');
  const win = withinWindow(rec.state, policy.window, at);
  if (!win.ok) {
    return {
      lane: LANES.HOLD,
      dialable: false,
      reasons: [win.reason],
      retryAt: nextOpenTime(rec.state, policy.window, at),
      zones: win.zones,
    };
  }

  const lane = consentValid ? LANES.GREEN : LANES.AMBER;
  reasons.push(
    consentValid
      ? `consent on file (${consent.source}, ${consent.grantedAt})`
      : `${rec.lineType}: fixed business line, non-promotional script, inside window`,
  );

  return {
    lane,
    dialable: true,
    reasons,
    zones: win.zones,
    // Obligations the dialler MUST satisfy on this call. The dialler asserts these are met and
    // refuses to place the call if any is missing, so the requirement cannot drift out of the
    // script during a rewrite.
    obligations: [
      'identify_caller_at_open',      // 64.1200(b)(1)
      'state_callback_number',        // 64.1200(b)(2)
      'disclose_ai_at_open',          // FCC 24-17 posture + Cal. AB 2905
      'announce_recording_if_recorded',
      'honour_stop_immediately',
    ],
  };
}

/** Run the gate over a whole corpus and return the tally plus the dialable set. */
export function gateAll(records, policy = DEFAULT_POLICY, suppress = new Set(), at = new Date()) {
  const tally = { green: 0, amber: 0, red: 0, hold: 0 };
  const byReason = new Map();
  const out = records.map((rec) => {
    const v = classify(rec, policy, suppress, at);
    tally[v.lane] += 1;
    for (const r of v.reasons) byReason.set(r, (byReason.get(r) || 0) + 1);
    return { ...rec, verdict: v };
  });
  return {
    records: out,
    tally,
    dialable: out.filter((r) => r.verdict.dialable),
    reasons: [...byReason.entries()].sort((a, b) => b[1] - a[1]),
  };
}
