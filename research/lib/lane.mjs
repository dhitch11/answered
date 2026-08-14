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
