// geo.mjs — where the callee is, and whether it is a decent hour to ring them.
//
// The timezone is derived from the STATE THE NUMBER WAS SOURCED FROM, never guessed from the
// area code. Every source in research/sources/ queries one state at a time, so the state is a
// fact carried on the record rather than an inference. Area-code-to-timezone tables are ~350
// entries of the kind of detail that is wrong in exactly the places that matter.
//
// Thirteen states span more than one US timezone. For those, a call is only allowed when the
// local hour is inside the window in EVERY zone the state touches. That is deliberately
// conservative: it costs us a little reach at the edges of the day and it means we can never
// ring a Texan at 07:40 because we assumed Central.

const EASTERN = ['America/New_York'];
const CENTRAL = ['America/Chicago'];
const MOUNTAIN = ['America/Denver'];
const PACIFIC = ['America/Los_Angeles'];

export const STATE_ZONES = {
  AL: CENTRAL, AR: CENTRAL, IA: CENTRAL, IL: CENTRAL, LA: CENTRAL, MN: CENTRAL,
  MO: CENTRAL, MS: CENTRAL, OK: CENTRAL, WI: CENTRAL,

  CT: EASTERN, DC: EASTERN, DE: EASTERN, GA: EASTERN, MA: EASTERN, MD: EASTERN,
  ME: EASTERN, NC: EASTERN, NH: EASTERN, NJ: EASTERN, NY: EASTERN, OH: EASTERN,
  PA: EASTERN, RI: EASTERN, SC: EASTERN, VA: EASTERN, VT: EASTERN, WV: EASTERN,

  CO: MOUNTAIN, MT: MOUNTAIN, NM: MOUNTAIN, UT: MOUNTAIN, WY: MOUNTAIN,
  AZ: ['America/Phoenix'],           // no DST
  CA: PACIFIC, WA: PACIFIC,
  HI: ['Pacific/Honolulu'],          // no DST

  // Split states. Both zones must clear the window.
  AK: ['America/Anchorage', 'America/Adak'],
  FL: ['America/New_York', 'America/Chicago'],
  ID: ['America/Denver', 'America/Los_Angeles'],
  IN: ['America/New_York', 'America/Chicago'],
  KS: ['America/Chicago', 'America/Denver'],
  KY: ['America/New_York', 'America/Chicago'],
  MI: ['America/New_York', 'America/Chicago'],
  ND: ['America/Chicago', 'America/Denver'],
  NE: ['America/Chicago', 'America/Denver'],
  NV: ['America/Los_Angeles', 'America/Denver'],
  OR: ['America/Los_Angeles', 'America/Denver'],
  SD: ['America/Chicago', 'America/Denver'],
  TN: ['America/New_York', 'America/Chicago'],
  TX: ['America/Chicago', 'America/Denver'],
};

export const MULTI_ZONE_STATES = Object.entries(STATE_ZONES)
  .filter(([, z]) => z.length > 1)
  .map(([s]) => s);

/** Local wall-clock hour, minute and weekday in an IANA zone, at a given instant. */
export function localParts(zone, at = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  return {
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: parts.weekday,               // 'Mon' … 'Sun'
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
  };
}

/**
 * Is it inside the calling window in EVERY zone this state touches?
 * Returns { ok, zones:[{zone,local,inside}], reason }
 */
export function withinWindow(state, window, at = new Date()) {
  const zones = STATE_ZONES[String(state || '').toUpperCase()];
  if (!zones) {
    return { ok: false, zones: [], reason: `no timezone known for state "${state}"` };
  }
  const startM = window.startHour * 60 + (window.startMinute || 0);
  const endM = window.endHour * 60 + (window.endMinute || 0);
  const days = window.days || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

  const detail = zones.map((zone) => {
    const p = localParts(zone, at);
    const inside = days.includes(p.weekday) && p.minutes >= startM && p.minutes < endM;
    return {
      zone,
      local: `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} ${p.weekday}`,
      inside,
    };
  });

  const failing = detail.filter((d) => !d.inside);
  return {
    ok: failing.length === 0,
    zones: detail,
    reason: failing.length
      ? `outside window in ${failing.map((f) => `${f.zone} (${f.local})`).join(', ')}`
      : null,
  };
}

/** The next instant, in whole minutes, at which withinWindow would pass. Null if > 8 days out. */
export function nextOpenTime(state, window, from = new Date()) {
  for (let i = 0; i <= 8 * 24 * 4; i += 1) {
    const t = new Date(from.getTime() + i * 15 * 60 * 1000);
    if (withinWindow(state, window, t).ok) return t;
  }
  return null;
}
