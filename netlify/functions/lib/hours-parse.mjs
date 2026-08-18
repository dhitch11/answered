// hours-parse.mjs — turn what a contractor types into the structure the account model wants.
//
// ★ WHY THIS EXISTS. The signup thread asks "what hours do you want it answering?" and a person
// answers "weekdays 7 to 5". `saveConfig` was never given a `hours` value at all, and even if it
// had been handed that string it would not have helped: `describeHours()` in accounts.mjs wants
// `{ mon: [['07:00','17:00']], ... }` keyed by day, and the database's `account_missing` view
// lists `hours` until that structure exists. Measured on a real completed signup: status `draft`,
// missing `["services","hours","email_verified"]`. So the front door could not produce a usable
// account no matter how many questions it asked.
//
// ★ WHAT THIS DELIBERATELY DOES NOT DO. It does not guess. Every contractor phrasing it cannot
// parse with confidence returns null, and the caller keeps the raw text and leaves `hours` unset
// so the operator surface still says it is missing. An invented schedule is worse than a blank
// one: a line that answers at the wrong hours is a line that misses jobs, and nobody would know
// where the times came from. Honest empty state over a plausible fabrication.

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const DAY_ALIASES = {
  sun: 'sun', sund: 'sun', sunday: 'sun', su: 'sun',
  mon: 'mon', monday: 'mon', mo: 'mon',
  tue: 'tue', tues: 'tue', tuesday: 'tue', tu: 'tue',
  wed: 'wed', weds: 'wed', wednesday: 'wed', we: 'wed',
  thu: 'thu', thur: 'thu', thurs: 'thu', thursday: 'thu', th: 'thu',
  fri: 'fri', friday: 'fri', fr: 'fri',
  sat: 'sat', satur: 'sat', saturday: 'sat', sa: 'sat',
};

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const WEEKEND = ['sat', 'sun'];
const ALL = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** "7" -> 07:00 · "7:30" -> 07:30 · "7pm" -> 19:00 · "noon" -> 12:00 · "midnight" -> 00:00 */
function clock(raw, inferPm) {
  const s = String(raw || '').trim().toLowerCase();
  if (/^noon|^12\s*noon/.test(s)) return '12:00';
  if (/^midnight/.test(s)) return '00:00';
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] || '00';
  const mer = (m[3] || '').replace(/^a$/, 'am').replace(/^p$/, 'pm');
  if (h > 24 || Number(min) > 59) return null;
  if (mer === 'pm' && h < 12) h += 12;
  else if (mer === 'am' && h === 12) h = 0;
  else if (!mer && inferPm && h < 12) h += 12;
  if (h === 24) h = 0;
  return `${String(h).padStart(2, '0')}:${min}`;
}

/**
 * Parse a free-text answer into { hours, confident }.
 *
 * Returns `{ hours: null }` whenever it is not sure. That is the point: the caller writes the
 * structure only when `hours` is non-null, and otherwise leaves the field missing on purpose.
 */
export function parseHours(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return { hours: null, why: 'empty' };

  // The time span is found FIRST, because it vetoes the always-on branch below.
  const spanMatch = /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)?|noon|midnight)\s*(?:-|–|to|thru|through|til|till|until)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)?|noon|midnight)\b/.exec(t);

  // ★ ALWAYS-ON, AND THE WORD THAT NEARLY FABRICATED A SCHEDULE. This list used to include a bare
  // `any ?time` and `always`, and "call anytime before 5" therefore parsed as 24/7 — a line
  // answering around the clock for someone who had just said they stop at five. Caught by the
  // refusal half of hours-parse.test.mjs, which exists for exactly this.
  //
  // Two guards now. A bare "anytime"/"always" counts only as a WHOLE utterance, and any phrase
  // here is vetoed by the presence of a real span or a bounding word, because "24 hours" inside
  // "we answer 24 hours on weekends but 8 to 5 otherwise" is not a description of 24/7.
  const explicitAllDay = /\b(24\s*\/\s*7|24-7|24x7|all day every day|round the clock|24 hours a day)\b/.test(t);
  const bareAllDay = /^\s*(any ?time|always|all the time|whenever|24 ?hours)[\s.!]*$/.test(t);
  const bounded = /\b(before|after|until|til|till|except|but|otherwise|weekdays?|weekends?)\b/.test(t);
  if ((explicitAllDay && !spanMatch && !bounded) || bareAllDay) {
    const h = {};
    for (const d of ALL) h[d] = [['00:00', '23:59']];
    return { hours: h, why: '24/7' };
  }

  // Which days are being talked about. Ranges ("mon-fri", "monday through friday") and lists
  // ("mon, tue, wed") both appear in real answers.
  let days = null;
  if (/\b(week ?days?|mon(day)?\s*(-|–|to|thru|through)\s*fri(day)?|m\s*-\s*f)\b/.test(t)) days = [...WEEKDAYS];
  else if (/\b(week ?ends?|sat(urday)?\s*(-|–|to|thru|through)\s*sun(day)?)\b/.test(t)) days = [...WEEKEND];
  else if (/\b(every ?day|all week|7 days|seven days|daily)\b/.test(t)) days = [...ALL];
  else {
    const range = /\b([a-z]{2,9})\s*(?:-|–|to|thru|through)\s*([a-z]{2,9})\b/.exec(t);
    const a = range && DAY_ALIASES[range[1]];
    const b = range && DAY_ALIASES[range[2]];
    if (a && b) {
      const order = ALL;
      const i = order.indexOf(a); const j = order.indexOf(b);
      days = i <= j ? order.slice(i, j + 1) : order.slice(i).concat(order.slice(0, j + 1));
    } else {
      const named = [];
      for (const word of t.split(/[^a-z]+/)) {
        const d = DAY_ALIASES[word];
        if (d && !named.includes(d)) named.push(d);
      }
      if (named.length) days = named;
    }
  }

  // The time span. "7 to 5", "7am-5pm", "8:30 to 6".
  const span = spanMatch;
  if (!span) return { hours: null, why: 'no time span found' };

  const rawStart = span[1].trim();
  const rawEnd = span[2].trim();

  // ★ THE BUSINESS-HOURS INFERENCE, AND ITS LIMIT. "7 to 5" from a plumber means 07:00-17:00, not
  // 07:00-05:00. So a bare end hour that would otherwise produce a span running backwards is read
  // as pm. This is applied ONLY to resolve an impossible ordering, never to reinterpret a time the
  // person actually qualified: "7am to 5am" stays exactly that and is rejected below.
  let start = clock(rawStart, false);
  let end = clock(rawEnd, false);
  if (!start || !end) return { hours: null, why: 'unreadable time' };
  const qualified = /am|pm|a\b|p\b|noon|midnight/.test(rawEnd);
  if (end <= start && !qualified) end = clock(rawEnd, true);
  if (!end) return { hours: null, why: 'unreadable end time' };
  if (end <= start) return { hours: null, why: 'span does not move forward' };

  if (!days) days = [...WEEKDAYS]; // "7 to 5" with no days named is the working week
  const hours = {};
  for (const d of DAYS) hours[d] = days.includes(d) ? [[start, end]] : [];
  return { hours, why: `${days.length} day(s) ${start}-${end}` };
}

export default parseHours;
