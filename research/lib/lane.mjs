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
export const LICENSING_REQUIRED_STATES = new Set(['TX', 'WA', 'FL', 'AZ']);

/**
 * ★ ARIZONA was added to the set above on 2026-08-14, from primary text.
 * A.R.S. 44-1272(A) and 44-1272.01(A) both bind "before the seller solicits any consumer located
 * in this state." Soliciting unregistered as a full-registration-class seller is a CLASS 5 FELONY
 * (44-1277(C)), and 44-1279 lets any consumer rescind and recover damages plus fees. There is a
 * plausible exemption we have NOT established (44-1273(B)(9), "telephone answering services"),
 * and the identical exemption exists in Nevada at NRS 599B.010(10)(s) — one written question to
 * both regulators likely resolves the registration analysis in two states at once. Until an
 * answer is on file, Arizona is a licensing gate like the other three.
 *
 * ★ CALIFORNIA REQUIRES A LIVE HUMAN TO OPEN EVERY CALL BEFORE THE AI MAY SPEAK.
 *
 * This is the finding that decides where the program can start, so it is written out in full.
 * Cal. Pub. Util. Code 2874, as amended by AB 2905 (approved 2024-09-20, effective 2025-01-01):
 * an automatic dialing-announcing device "may be operated only after an unrecorded, natural voice
 * announcement has been made to the person called by the person calling," stating the nature of
 * the call, the business name, address and telephone number, disclosing the artificial voice, and
 * obtaining consent to continue.
 *
 * Every other state in our first four has a limit that lets a business-line program through, and
 * California has none of them:
 *   AZ  44-1278(B)(4) reaches RESIDENTIAL lines only.
 *   OR  646A.370(7) attaches duties to a "subscriber", defined as residential or wireless only.
 *   NV  the ADAD definition is conjunctive and needs a random/sequential generator, so a curated
 *       list of businesses falls outside it.
 *   CA  2874 has no business-line carve-out at all, and 2872(f) exempts only an established
 *       business relationship, which a cold call by definition is not.
 *
 * So this is a PRODUCT blocker, not a paperwork one: there is no autonomous version of a live
 * human announcement, and California is where we were asked to start. Cal. Pen. Code 637.2 prices
 * a defect here at $5,000 per call with no actual damages required, against a uniform script — the
 * textbook class-certification fact pattern.
 *
 * The gate therefore refuses California for an autonomous call and ALLOWS it the moment a human
 * opener is really in the loop, which is what `policy.humanOpener` asserts.
 */
export const HUMAN_OPENER_REQUIRED_STATES = new Set(['CA']);

/**
 * ★ NEVADA: NRS 200.620 is all-party for wire communications, and the only escape is Ditech,
 * which is a CHOICE-OF-LAW ruling rather than a permission: it protects a recorder "located AND
 * using recording equipment outside of Nevada", and then hands the question to the law of
 * wherever the equipment actually sits. Escaping Nevada is not the same as being clear, and no
 * candidate recording state has been verified as one-party for this stack.
 *
 * "Intercept" is AURAL ACQUISITION at each point (NRS 179.430), so every hop that hears audio
 * counts: the carrier media region, the speech-to-text region, and the model region. That is a
 * per-vendor, contractual, written attestation of processing region — not a marketing page and
 * not an assumption. `policy.recordingRegionAttested` is that evidence, and it is false until the
 * attestations exist.
 */
export const ALL_PARTY_RECORDING_STATES = new Set(['NV']);

/**
 * ★ STATE CALLING-WINDOW FLOORS, tighter than the federal 8am-9pm.
 * Cal. Pub. Util. Code 2872(c) bars ADAD calls between 9pm and 9am California time. Our default
 * window (09:00-16:30) already sits inside it, so this changes nothing today. It is encoded so
 * that widening the default window later cannot silently violate a state floor — the constraint
 * lives next to the rule it constrains rather than in a comment somebody has to remember.
 */
export const STATE_WINDOW_FLOOR = {
  CA: { startHour: 9, endHour: 21 },
};

/**
 * ★ STATES WHOSE LAW WE HAVE ACTUALLY READ. EVERYTHING ELSE IS REFUSED.
 *
 * This set exists because measuring the book exposed a fail-open seam in this very file. Every
 * other rule here is written as "refuse unless proven", and then state law was handled as "allow
 * unless listed" — so 774 numbers came back dialable, in NY, PA, NC, MI, OH and VA, not one of
 * which anybody had read. The gate would have placed those calls.
 *
 * The base rate says that is not a theoretical risk. Of the first four states examined from
 * primary text, three carried a real blocker and one of those (AZ) makes an unregistered call a
 * CLASS 5 FELONY. Assuming the unread twenty-six are clean is the same bet, twenty-six times.
 *
 * Membership means the state's own text was read for: telephone-solicitor registration, bonding,
 * artificial-voice restrictions, recording consent, its DNC treatment, and its damages exposure.
 * It does NOT mean the state is open — TX, WA, FL, IL, CA, NV and AZ are all here and all refuse.
 * It means the answer is known rather than assumed.
 */
export const VERIFIED_STATES = new Set([
  'TX', 'WA', 'FL', // telephone-solicitor registration and bond, verified 2026-08-13
  'IL',             // BIPA voiceprint, verified 2026-08-13
  'CA', 'NV', 'AZ', 'OR', // four-state primary-law verification, 2026-08-14
]);

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

  // ★ THE AREA CODES OUR DNC SUBSCRIPTION ACTUALLY COVERS. `null` means no subscription exists.
  //
  // This is a SEPARATE control from `dncScrubbed`, and conflating them is the trap. 16 CFR 310.8(a)
  // makes calling into an area code you have NOT subscribed to a violation IN ITSELF, independent of
  // whether the number dialled is registered — and unlike a mis-scrub, it has NO safe harbour and no
  // "it was an error" defence. A flawless 31-day scrub of five area codes gives exactly zero
  // protection for one call into a sixth.
  //
  // So the subscription is a HARD FENCE around which numbers may be dialled at all, not a data-
  // coverage preference, and the dialler needs an allowlist interlock rather than only a suppression
  // list. The billable unit is the NPA, never the geography: 15 U.S.C. 6152(b)(1)(A) and 16 CFR
  // 310.8(c) both read "each area code of data". Overlays are therefore two subscriptions, not one —
  // 503 does not get you 971 — which means five free codes is not five markets, and in overlay-heavy
  // geography it is closer to two and a half.
  subscribedAreaCodes: null,

  // ★ THE HUMAN-DIALED LANE (David 2026-08-14: "still keep all mobile numbers. we will be calling
  // them"). A PERSON presses dial and a PERSON speaks. No artificial voice anywhere on the call.
  //
  // WHY THIS OPENS MOBILE AND THE AI PATH DOES NOT. 47 U.S.C. 227(b)(1)(A)(iii) reaches a call made
  // "using any automatic telephone dialing system or an artificial or prerecorded voice". A human
  // manually dialling and speaking is neither, and *Facebook v. Duguid*, 592 U.S. 395 (2021) held an
  // ATDS must use "a random or sequential number generator" — a curated list of contractors is not
  // that. So the single provision that blocks every AI call to a mobile does not reach this lane.
  //
  // ★ WHAT MANUAL DIALLING BUYS NOTHING AGAINST, and this is the part that matters more:
  //   - 47 CFR 64.1200(c)(2), the DO-NOT-CALL REGISTRY. 64.1200(e) applies the (c) and (d) rules to
  //     wireless numbers, and *Chennette v. Porch.com*, 50 F.4th 1217 (9th Cir. 2022) held that cell
  //     numbers used for BOTH business and personal purposes are presumptively "residential" and may
  //     sue. A contractor's cell is the exact fact pattern of that case. Mobiles are also registered
  //     on the DNC at far higher rates than landlines, so this lane needs the scrub MORE, not less.
  //   - STATE law. Every licensing, artificial-voice and all-party-recording rule in this file has no
  //     dialling-technology element. Arizona is stricter here than the TCPA: A.R.S. 44-1278(B)(3)
  //     bars unsolicited sales calls to any mobile or paging device with NO consent exception at all.
  //   - WIRETAP law. If the call is recorded or transcribed, the AI is still a listener on the line
  //     even when it is not a speaker, and that was already the largest exposure in this program.
  //
  // So this flag relaxes exactly ONE thing — the line-type refusal — and nothing else. It is a
  // separate named lane with its own audit trail rather than a quiet exemption, because the moment
  // "a human is on it" silently unlocks a wider pool, autopilot has a loophole to drive through.
  // It is FALSE by default and the dialler must assert it per call, never per campaign.
  humanDialed: false,

  // ★ ADDED 2026-08-14 from the four-state primary-law verification (CA / NV / AZ / OR).
  //
  // A live human personally makes the Pub. Util. Code 2874 announcement before the AI speaks:
  // nature of the call, business name, address, phone, the artificial-voice disclosure, and a
  // captured consent to continue. This is the ONLY thing that opens California. It is false
  // because it describes a staffing arrangement, and no code change can make it true.
  humanOpener: false,

  // Written, per-vendor, contractual attestation of the processing region for every hop that
  // aurally acquires the audio — carrier media, speech-to-text, and model. Opens Nevada.
  recordingRegionAttested: false,

  // Whether this campaign may make the free-week offer at all. It is an "inducement or incentive
  // to purchase", which is the statutory definition of a PREMIUM in NRS 599B.010(6) and
  // A.R.S. 44-1271(10) and a trigger in ORS 646.551(2)(b)(B) — and in Nevada, selling with a
  // premium while unregistered is a CATEGORY D FELONY (NRS 599B.255(3)), not a misdemeanour.
  // Default false: the outbound call measures and asks, and anyone who wants the free week is
  // routed to an inbound path where the relationship, and the registration analysis, are
  // different. This is a business decision with legal consequences and it is David's to make,
  // so it is a flag he can flip rather than a deletion I made on his behalf.
  mayOfferIncentive: false,
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
    // ★ The ONE thing policy.humanDialed relaxes: WHICH LINE TYPES ARE REACHABLE. A person dialling
    // and speaking is neither an ATDS nor an artificial voice, so 227(b)(1)(A)(iii) does not reach
    // the call. Every other refusal below still runs, because none of them turns on how it was dialled.
    //
    // Deliberately NOT widened to nonFixedVoip, even though the same 227(b) reasoning would carry:
    // that is another 1,529 numbers and it is a scope decision for David, not one to take quietly
    // on the back of a ruling about mobiles.
    const reachable = policy.humanDialed
      ? (type.fixed || type.personal)   // a human may call a business line or a mobile
      : type.fixed;                     // an artificial voice may only call a verified fixed line
    if (!reachable) {
      return deny(type.personal
        ? `${rec.lineType}: an artificial voice to a mobile needs prior express consent, 47 CFR 64.1200(a)(1). A human-dialled, human-voiced call to this number is a separate lane and is permitted there`
        : `${rec.lineType}: not a verified fixed business line`);
    }
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
    // Fail closed on the map itself, before any per-state rule runs. An unread state is an
    // unanswered question, and this file answers those the same way everywhere else: no.
    if (!VERIFIED_STATES.has(st)) {
      return deny(`${st || 'unknown state'}: nobody has read this state's telephone-solicitation, artificial-voice and recording law yet, and three of the first four states read carried a real blocker; an unverified state is a refusal, not a default yes`);
    }
    if (LICENSING_REQUIRED_STATES.has(st)) {
      return deny(`${st} requires a telephone-solicitor registration and bond before the first call; a licensing gate no script or dialling method cures`);
    }
    if (BIOMETRIC_RISK_STATES.has(st)) {
      return deny(`${st}: BIPA 740 ILCS 14/15(b) needs a WRITTEN release before any voiceprint, which a spoken disclosure cannot supply`);
    }
    // ★ The four-state verification, enforced. Each of these is a state whose own text closes the
    // door on the program AS DESIGNED, and each names the exact condition that reopens it.
    if (HUMAN_OPENER_REQUIRED_STATES.has(st) && !policy.humanOpener) {
      return deny(`${st}: Pub. Util. Code 2874 requires an UNRECORDED, NATURAL-VOICE announcement by the person calling before the device may operate — there is no business-line exemption and no autonomous version of it. Opens only with a live human opener on every call`);
    }
    if (ALL_PARTY_RECORDING_STATES.has(st) && !policy.recordingRegionAttested) {
      return deny(`${st}: all-party recording under NRS 200.620, and the Ditech escape is a choice-of-law ruling that needs a written per-vendor attestation that every point of aural acquisition sits outside the state`);
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
    // ★ THE SUBSCRIPTION FENCE. Checked separately from the scrub because it is a different
    // violation with a different defence: a perfect scrub does not excuse one call into an NPA we
    // never bought. Fails closed on a missing list, like everything else here.
    const npa = rec.phone.slice(2, 5);
    if (!policy.subscribedAreaCodes) {
      return deny('no DNC area-code subscription is on file, and 16 CFR 310.8(a) makes a call into an unsubscribed area code a violation in itself, with no safe harbour');
    }
    if (!policy.subscribedAreaCodes.has(npa)) {
      return deny(`area code ${npa} is not in our do-not-call subscription; 16 CFR 310.8(a) makes that call a violation independently of whether the number is registered, and there is no error defence for it`);
    }
  }

  // --- hour of day. Not a refusal, a deferral. ----------------------------------------------
  if (!rec.state) return deny('no source state on the record, so the local time cannot be established');
  // A state floor tightens our window; it can never widen it. Enforced by intersection rather than
  // by replacement, so a future edit to the default window cannot loosen a statutory limit.
  const floor = STATE_WINDOW_FLOOR[st];
  const win = withinWindow(rec.state, floor
    ? {
      ...policy.window,
      startHour: Math.max(policy.window.startHour, floor.startHour),
      endHour: Math.min(policy.window.endHour, floor.endHour),
    }
    : policy.window, at);
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
  const humanLane = policy.humanDialed && LINE_TYPES[rec.lineType]?.personal && !consentValid;
  reasons.push(
    consentValid
      ? `consent on file (${consent.source}, ${consent.grantedAt})`
      : humanLane
        ? `${rec.lineType}: HUMAN-DIALLED lane — a person dials and a person speaks, so 47 USC 227(b)(1)(A)(iii) does not reach it; registry, state law and window all still applied`
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
      // ★ On the human-dialled lane there is no artificial voice to disclose, and claiming one
      // would be its own false statement. What REPLACES it is stricter, not looser: the call must
      // carry no artificial voice at all, or the whole basis for reaching this mobile evaporates
      // mid-call. The recording/transcription disclosure is unaffected — the AI is still a LISTENER
      // even when it is not a speaker, and that was always the larger exposure.
      ...(policy.humanDialed
        ? ['no_artificial_voice_on_this_call', 'live_human_must_speak']
        : ['disclose_ai_at_open']),   // FCC 24-17 posture + Cal. AB 2905
      'announce_recording_if_recorded',
      'honour_stop_immediately',
      // The free week is a statutory PREMIUM in three of our first four states. When the campaign
      // is not cleared to offer it, that is an obligation ON THE CALL, carried next to the other
      // five, so the dialler refuses rather than relying on whoever last edited the script.
      ...(policy.mayOfferIncentive ? [] : ['make_no_incentive_offer']),
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
