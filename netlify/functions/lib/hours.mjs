// hours.mjs — WHAT TIME IS IT WHERE THE PERSON WE ARE ABOUT TO CALL ACTUALLY IS.
//
// Every outbound call in this system is gated on this file. For Recover it is not a courtesy, it is
// the statute: 15 U.S.C. 1692c(a)(1) forbids contacting a consumer about a debt before 8:00 a.m. or
// after 9:00 p.m. "at the consumer's location". The consumer's location. Not ours, not the caller
// ID's, and not the timezone of whatever machine happens to run the cron.
//
// ★ WHY THIS EXISTS SEPARATELY FROM THE TABLE INSIDE call-me.mjs, WHICH IS THE SAME 8-to-21 WINDOW.
// call-me.mjs resolves the zone from the AREA CODE alone, and for a person typing their own mobile
// number into our website that is the only signal there is, so it is the right call there. It is the
// WRONG call for a debtor. A mobile area code is a fact about where somebody bought a phone, often a
// decade ago, in another state. Recover knows something much better: the invoice carries the job
// address and the customer's state, because the work was physically done there. So this module
// resolves in that order:
//
//    1. an explicit IANA timezone on the record   (operator-set or geocoded; the best evidence)
//    2. the state the work was done in            (a fact about the debtor's location)
//    3. the area code                             (a guess about the debtor's location)
//    4. nothing                                   (A REFUSAL, never a default)
//
// An unknown zone is a REFUSAL in every caller. Getting it wrong costs a 6:40 a.m. phone call to
// somebody who is asleep and already unhappy with us, which is both a statutory violation and the
// single fastest way to turn a collectable invoice into a complaint.
//
// ★ SPLIT ZONES ARE CARRIED AS A LIST AND EVERY ONE OF THEM MUST BE INSIDE THE WINDOW. Florida,
// Indiana, Michigan, Kansas, Nebraska, the Dakotas, Idaho, Oregon, Nevada and Texas all straddle a
// boundary. "Probably Central" is how a Panhandle number gets dialled at 7:40 local. If we cannot be
// sure it is 8 a.m. everywhere the record could mean, it is not 8 a.m.

// 15 U.S.C. 1692c(a)(1), and the same window the rest of this estate already holds itself to.
export const WINDOW_START_MIN = 8 * 60;   // 08:00 local
export const WINDOW_END_MIN = 21 * 60;    // 21:00 local

const ET = ['America/New_York'];
const CT = ['America/Chicago'];
const MT = ['America/Denver'];
const PT = ['America/Los_Angeles'];
const AZ = ['America/Phoenix', 'America/Denver']; // Arizona skips DST, the Navajo Nation does not
const ET_CT = ['America/New_York', 'America/Chicago'];
const CT_MT = ['America/Chicago', 'America/Denver'];
const MT_PT = ['America/Denver', 'America/Los_Angeles'];
const AK = ['America/Anchorage', 'America/Adak'];
const HI = ['Pacific/Honolulu'];
const PR = ['America/Puerto_Rico'];

/**
 * State to zone. A state that straddles a boundary carries BOTH zones, so the window is only open
 * when it is open on both sides of the line. This is the primary resolver for Recover because the
 * invoice knows where the job was.
 */
export const STATE_ZONES = Object.freeze({
  AL: CT, AK: AK, AZ: AZ, AR: CT, CA: PT, CO: MT, CT: ET, DE: ET, DC: ET,
  FL: ET_CT, GA: ET, HI: HI, ID: MT_PT, IL: CT, IN: ET_CT, IA: CT, KS: CT_MT,
  KY: ET_CT, LA: CT, ME: ET, MD: ET, MA: ET, MI: ET_CT, MN: CT, MS: CT,
  MO: CT, MT: MT, NE: CT_MT, NV: MT_PT, NH: ET, NJ: ET, NM: MT, NY: ET,
  NC: ET, ND: CT_MT, OH: ET, OK: CT, OR: MT_PT, PA: ET, RI: ET, SC: ET,
  SD: CT_MT, TN: ET_CT, TX: CT_MT, UT: MT, VT: ET, VA: ET, WA: PT, WV: ET,
  WI: CT, WY: MT, PR: PR, VI: PR,
});

// The area-code table, carried verbatim from the one measured and in production inside call-me.mjs.
// An unlisted overlay resolves to nothing, which is a refusal, which is the correct direction.
const AREA_ZONES = Object.create(null);
const zone = (zones, codes) => { for (const c of codes) AREA_ZONES[c] = zones; };

zone(ET, [
  '203', '475', '860', '959',
  '302',
  '202', '771',
  '239', '305', '321', '352', '386', '407', '561', '645', '656', '689',
  '727', '754', '772', '786', '813', '863', '904', '941', '954',
  '229', '404', '470', '478', '678', '706', '762', '770', '912', '943',
  '260', '317', '463', '574', '765',
  '502', '606', '859',
  '207',
  '227', '240', '301', '410', '443', '667',
  '339', '351', '413', '508', '617', '774', '781', '857', '978',
  '231', '248', '269', '313', '517', '586', '616', '679', '734', '810',
  '947', '989',
  '603',
  '201', '551', '609', '640', '732', '848', '856', '862', '908', '973',
  '212', '315', '332', '347', '363', '516', '518', '585', '607', '631',
  '646', '680', '716', '718', '838', '845', '914', '917', '929', '934',
  '252', '336', '472', '704', '743', '828', '910', '919', '980', '984',
  '216', '220', '234', '283', '326', '330', '380', '419', '436', '440',
  '513', '567', '614', '740', '937',
  '215', '223', '267', '272', '412', '445', '484', '570', '582', '610',
  '717', '724', '814', '835', '878',
  '401',
  '803', '839', '843', '854', '864',
  '423', '865',
  '276', '434', '540', '571', '686', '703', '757', '804', '826', '948',
  '802',
  '304', '681',
]);

zone(CT, [
  '205', '251', '256', '334', '483', '659', '938',
  '327', '479', '501', '870',
  '217', '224', '309', '312', '331', '447', '464', '618', '630', '708',
  '730', '773', '779', '815', '847', '872',
  '219',
  '319', '515', '563', '641', '712',
  '316', '913',
  '270', '364',
  '225', '318', '337', '457', '504', '985',
  '218', '320', '507', '612', '651', '763', '952',
  '314', '417', '557', '573', '636', '660', '816', '975',
  '228', '601', '662', '769',
  '402', '531',
  '405', '539', '572', '580', '918',
  '615', '629', '731', '901', '931',
  '210', '214', '254', '281', '325', '346', '361', '409', '430', '432',
  '469', '512', '682', '713', '726', '737', '806', '817', '830', '832',
  '903', '936', '940', '945', '956', '972', '979',
  '262', '274', '353', '414', '534', '608', '715', '920',
]);

zone(MT, ['303', '719', '720', '970', '983', '406', '505', '575', '385', '435', '801', '307', '915']);

zone(PT, [
  '209', '213', '279', '310', '323', '341', '350', '369', '408', '415',
  '424', '442', '510', '530', '559', '562', '619', '626', '628', '650',
  '657', '661', '669', '707', '714', '747', '760', '805', '818', '820',
  '831', '840', '858', '909', '916', '925', '949', '951',
  '702', '725',
  '503', '971',
  '206', '253', '360', '425', '509', '564',
]);

zone(AZ, ['480', '520', '602', '623', '928']);
zone(AK, ['907']);
zone(HI, ['808']);
zone(PR, ['787', '939', '340']);
zone(ET_CT, ['448', '850', '812', '930', '906']);
zone(CT_MT, ['620', '785', '308', '701', '605']);
zone(MT_PT, ['208', '986', '458', '541', '775']);

export { AREA_ZONES };

/** Local wall-clock minutes in an IANA zone at an instant. */
export function localMinutes(tz, at) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(at).map((p) => [p.type, p.value]),
  );
  return (Number(parts.hour) % 24) * 60 + Number(parts.minute);
}

/** A readable local time, for the operator surface and for the refusal sentence. */
export function localClock(tz, at) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(at);
}

/**
 * Resolve the zones for one debtor, in order of how much the evidence is worth.
 * @returns {{zones:string[]|null, source:string, why:string}}
 */
export function zonesFor({ timezone, state, phone } = {}) {
  const tz = String(timezone || '').trim();
  if (tz) {
    // A named zone is only evidence if the platform actually knows it. An invented string would
    // throw inside Intl on every later call, which is a crash, not a gate.
    try {
      localMinutes(tz, new Date());
      return { zones: [tz], source: 'timezone', why: `the timezone recorded on the invoice (${tz})` };
    } catch {
      return { zones: null, source: 'none', why: `"${tz}" is not a timezone this platform recognises` };
    }
  }

  const st = String(state || '').trim().toUpperCase();
  if (st && STATE_ZONES[st]) {
    return { zones: STATE_ZONES[st], source: 'state', why: `the state the work was done in (${st})` };
  }

  const digits = String(phone || '').replace(/\D+/g, '');
  const ten = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
  const area = ten.length === 10 ? ten.slice(0, 3) : '';
  if (area && AREA_ZONES[area]) {
    return { zones: AREA_ZONES[area], source: 'area_code', why: `the area code ${area}, which is a guess about where they are, not a fact` };
  }

  return {
    zones: null,
    source: 'none',
    why: st
      ? `"${st}" is not a state this table knows`
      : (area ? `area code ${area} is not in the table` : 'no state, no timezone and no usable area code'),
  };
}

/** True only when the window is open in EVERY zone the record could mean. */
export function insideWindow(zones, at = new Date()) {
  if (!Array.isArray(zones) || !zones.length) return { ok: false, reason: 'no zone' };
  for (const tz of zones) {
    const m = localMinutes(tz, at);
    if (m < WINDOW_START_MIN || m >= WINDOW_END_MIN) {
      return { ok: false, tz, minutes: m, local: localClock(tz, at) };
    }
  }
  return { ok: true, local: localClock(zones[0], at), tz: zones[0] };
}

/** Seconds until every zone is inside the window again. Stepped, not solved. */
export function secondsUntilOpen(zones, from = new Date()) {
  if (!Array.isArray(zones) || !zones.length) return null;
  for (let i = 1; i <= 24 * 60; i += 5) {
    if (insideWindow(zones, new Date(from.getTime() + i * 60000)).ok) return i * 60;
  }
  return null;
}

/**
 * The whole question in one call: may we ring this person right now, and if not, why not and when.
 * Every field is reported, including the source of the zone, because "we called at 7:50 because we
 * trusted an area code" is an answer somebody may have to give out loud one day.
 */
export function callingWindow({ timezone, state, phone, at = new Date() } = {}) {
  const z = zonesFor({ timezone, state, phone });
  if (!z.zones) {
    return {
      ok: false, code: 'unknown_zone', zones: null, source: z.source,
      reason: `We could not tell what time it is where they are: ${z.why}. We do not guess a calling window.`,
    };
  }
  const win = insideWindow(z.zones, at);
  if (win.ok) {
    return { ok: true, zones: z.zones, source: z.source, local: win.local, tz: win.tz, reason: `It is ${win.local} where they are, inside the 8am to 9pm window.` };
  }
  const wait = secondsUntilOpen(z.zones, at);
  return {
    ok: false, code: 'outside_window', zones: z.zones, source: z.source,
    local: win.local, tz: win.tz, retry_after_seconds: wait,
    reason: `It is ${win.local} in ${win.tz}, which is outside the 8am to 9pm window where they are.`,
  };
}
