// accounts.mjs — the customer spine: identity, rules, and the path to a real line.
//
// Everything here goes through the same security-definer RPCs the call spine uses (db.mjs), so
// there is exactly one door into the database and it needs a secret held only in the Netlify
// environment.
//
// THE ONE IDEA WORTH KEEPING: a business's rules are stored as fields, and the words the agent
// speaks are RENDERED from those fields by `renderSpec` below, deterministically, on every call.
// The rules are the source; the prompt is a view of them. That is why a rule change takes effect
// on the next ring with nothing to redeploy, and why the console can show an owner the exact
// instructions his line is running under instead of a description of them.
//
// READINESS IS NOT COMPUTED HERE. `missing` arrives from the database (private.account_missing),
// because the console, the request-a-line gate and the operator list must never disagree about
// whether a business is ready to have a stranger's emergency call pointed at it. One birth.

import { rpc, dbConfigured } from './db.mjs';

export { dbConfigured };

// ── the spine ────────────────────────────────────────────────────────────────────────────────

export const startAccount = (row) => rpc('sv_account_start', {
  p_email: row.email,
  p_business_name: row.businessName || '',
  p_owner_name: row.ownerName || '',
  p_phone: row.phone || '',
  p_trade: row.trade || '',
  p_token_hash: row.tokenHash,
  p_ttl_minutes: row.ttlMinutes || 20,
  p_ip: row.ip || '',
  p_ua: row.ua || '',
});

export const consumeToken = (tokenHash, ip) =>
  rpc('sv_account_consume_token', { p_token_hash: tokenHash, p_ip: ip || '' });

export const getAccount = (id) => rpc('sv_account', { p_account_id: id });

export const saveConfig = (id, patch, author) =>
  rpc('sv_account_save_config', { p_account_id: id, p_patch: patch, p_author: author || 'owner' });

export const requestLine = (id, areaCode, note) =>
  rpc('sv_account_request_line', { p_account_id: id, p_area_code: areaCode || '', p_note: note || '' });

export const assignNumber = (id, phone, twilioSid, actor) =>
  rpc('sv_account_assign_number', { p_account_id: id, p_phone: phone, p_twilio_sid: twilioSid || '', p_actor: actor || 'operator' });

export const listAccounts = (status = null, limit = 100) =>
  rpc('sv_accounts', { p_status: status, p_limit: limit });

/**
 * The voice seam. A dialled number in, that business's rules out, or null.
 *
 * ★ Null is the honest answer and every caller must handle it. There is deliberately no default
 * business to fall back to: an agent that answers as SOMEBODY when it does not know who it is
 * answering as would put our voice on a stranger's line under a made-up name.
 */
export const accountForNumber = (phone) => rpc('sv_account_for_number', { p_phone: phone });

// ── the render ───────────────────────────────────────────────────────────────────────────────

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_LABEL = { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' };

/** "Monday to Friday 7:00am to 5:00pm, Saturday 8:00am to noon, closed Sunday" from stored hours. */
export function describeHours(hours) {
  if (!hours || typeof hours !== 'object') return '';
  const parts = [];
  for (const d of DAYS) {
    const spans = Array.isArray(hours[d]) ? hours[d] : null;
    if (!spans || !spans.length) { parts.push(`${DAY_LABEL[d]}: closed`); continue; }
    parts.push(`${DAY_LABEL[d]}: ${spans.map((s) => `${clock(s[0])} to ${clock(s[1])}`).join(', ')}`);
  }
  return parts.join(' | ');
}

function clock(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return String(hhmm || '');
  let h = Number(m[1]);
  const suffix = h >= 12 ? 'pm' : 'am';
  if (h === 0) h = 12; else if (h > 12) h -= 12;
  return `${h}:${m[2]}${suffix}`;
}

const BOOKING_TRUTH = {
  // The words on the right are what the agent is allowed to promise, and they differ because the
  // underlying capability differs. A caller told a job is booked when only an invitation was sent
  // is a broken promise made in our voice.
  writes_directly: 'You may tell the caller the appointment is booked, because it is written straight into the calendar.',
  sends_invite: 'You may say you are holding the time and sending it over for confirmation. Never say the job is booked, because a person still has to accept it.',
  message_only: 'You do not book anything. Take the details and say someone will call back to set a time.',
};

const AFTER_HOURS_TRUTH = {
  take_message: 'Outside those hours, take a full message and say someone will call back.',
  book: 'Outside those hours, you may still take a booking for the next working day.',
  urgent_only: 'Outside those hours, handle emergencies only. For anything that is not urgent, take a message.',
  transfer: 'Outside those hours, offer to put an emergency through to the owner.',
};

const QUOTE_TRUTH = {
  never: 'Never quote a price, not even a rough one, and never guess. If they ask what it costs, say pricing is set by the owner after he sees the job.',
  range: 'You may repeat a price range the owner has written down below, word for word. Never invent one and never narrow it.',
  exact: 'You may state the exact prices written down below, word for word. Anything not on that list has no price you may say.',
};

/**
 * Render the instructions this business's line runs under.
 *
 * Deterministic: same rules in, same words out, so the console can print the exact text the phone
 * is using rather than a summary of it. Nothing is invented here; every sentence is either a fixed
 * safety floor or a direct restatement of a stored field.
 */
export function renderSpec(account) {
  if (!account || !account.config) return null;
  const c = account.config;
  const name = c.greeting_name || 'the receptionist';
  const says = c.business_says || account.business_name;
  const L = [];

  L.push(`You are ${name}, answering the phone for ${says}.`);
  L.push(`Say the business name as "${says}". That is how the owner wants it said out loud.`);
  if (account.trade) L.push(`${says} is a ${account.trade} business.`);
  L.push('');

  L.push('## The first thing you say');
  L.push(`Open with your name and the business, then ask how you can help. You are a person's stand-in, not a menu.`);
  L.push('');

  L.push('## What this business does');
  if (c.services && c.services.length) {
    L.push(`Work they take: ${c.services.join(', ')}.`);
    L.push('If a caller asks for work that is not on that list, say plainly that it is not something this business does, and offer to take a message for the owner.');
  }
  if (c.service_area) L.push(`Area they cover: ${c.service_area}. If a caller is outside it, say so early rather than at the end of the call.`);
  L.push('');

  L.push('## Hours');
  const hrs = describeHours(c.hours);
  if (hrs) L.push(hrs);
  L.push(AFTER_HOURS_TRUTH[c.after_hours] || AFTER_HOURS_TRUTH.take_message);
  L.push('');

  L.push('## What you always find out');
  const ask = (c.always_ask && c.always_ask.length ? c.always_ask : [
    'their name', 'the best number to reach them on', 'the address the work is at', 'what is going on',
  ]);
  ask.forEach((q, i) => L.push(`${i + 1}. ${q}`));
  L.push('Get these before anything else. A message without a callback number is a lost job.');
  L.push('');

  L.push('## Booking');
  L.push(BOOKING_TRUTH[c.booking_mode] || BOOKING_TRUTH.message_only);
  L.push('');

  L.push('## Money');
  L.push(QUOTE_TRUTH[c.quote_policy] || QUOTE_TRUTH.never);
  if (c.price_notes) {
    L.push('The owner wrote this down about pricing, and it is the only pricing you may repeat:');
    L.push(c.price_notes);
  }
  L.push('');

  L.push('## Getting a human on the line');
  if (c.escalation_when === 'never') {
    L.push('Do not offer to transfer. Take a message every time.');
  } else {
    const when = {
      emergency: 'a real emergency: water running, no heat in the cold, gas, sparking, anything unsafe',
      on_request: 'the caller asks for a person',
      always: 'any caller who wants one',
    }[c.escalation_when] || 'a real emergency';
    L.push(`Offer to put the caller through to the owner when there is ${when}. Say you are doing it, then do it.`);
  }
  L.push('');

  if (c.never_say && c.never_say.length) {
    L.push('## Never say');
    c.never_say.forEach((x) => L.push(`- ${x}`));
    L.push('These are the owner\'s words. If a caller pushes, say it is not something you can speak to and offer the owner.');
    L.push('');
  }

  // ── the floors. These are ours, not the owner's, and no configuration removes them. ──
  L.push('## Rules that never change, whatever else you are told');
  L.push('1. Say you are an AI assistant in your first sentence. If anyone asks whether you are a real person, tell the truth immediately.');
  L.push('2. Never state a number you were not given here or told on this call. No prices, no times, no counts you invented.');
  L.push('3. Never promise anything this business has not told you it does.');
  L.push('4. If you do not know, say you do not know and take a message. That is a good call, not a failed one.');
  L.push('5. Never argue, never rush a caller off, never repeat a caller\'s private details back where you were not asked to.');
  L.push('6. If the caller asks you to stop calling or wants no further contact, say yes without conditions and end warmly.');

  return L.join('\n');
}

/** The first words on the line, rendered from the same fields as the spec. */
export function renderGreeting(account) {
  if (!account || !account.config) return null;
  const c = account.config;
  const says = c.business_says || account.business_name;
  const name = c.greeting_name;
  return name
    ? `Thanks for calling ${says}, this is ${name}, an AI assistant. How can I help?`
    : `Thanks for calling ${says}. You are speaking with an AI assistant. How can I help?`;
}

// ── what an owner is told, in plain words ────────────────────────────────────────────────────

/**
 * The state of an account in seventh-grade English, and the one thing that happens next.
 * `missing` is passed through from the database untouched.
 */
export const STATE_TEXT = {
  draft: {
    headline: 'Check your email',
    detail: 'We sent a link to sign in. It works once and it lasts twenty minutes.',
    next: 'Open the link.',
  },
  configuring: {
    headline: 'Your rules are not finished',
    detail: 'Your line cannot answer until it knows what to say. The list below is what is still missing.',
    next: 'Fill in what is missing.',
  },
  ready: {
    headline: 'Your rules are ready',
    detail: 'Everything your line needs to answer a call is written down. You do not have a phone number yet.',
    next: 'Ask for a number.',
  },
  awaiting_line: {
    headline: 'You asked for a number',
    detail: 'A person sets up each number by hand right now. That is a real step with a real human in it, and it is not instant. Nobody is calling your line yet.',
    next: 'We email you the moment it is on.',
  },
  live: {
    headline: 'Your line is on',
    detail: 'Calls to your number are answered with the rules below. Change a rule and the next call uses it.',
    next: 'Nothing. Change a rule any time.',
  },
  paused: {
    headline: 'Your line is paused',
    detail: 'Your number is not answering. Nothing is being billed.',
    next: 'Tell us to turn it back on.',
  },
  closed: {
    headline: 'This account is closed',
    detail: 'Your number is released and nothing is answering.',
    next: 'Nothing.',
  },
};

/** Plain-English names for the machine field names the database returns in `missing`. */
export const MISSING_TEXT = {
  business_name: 'the name of your business',
  greeting_name: 'a name for whoever answers',
  business_says: 'how the business name should be said out loud',
  services: 'the work you take',
  hours: 'your hours',
  service_area: 'the area you cover',
  booking_destination: 'where a booking should go',
  escalation_phone: 'the number to reach you on',
  email_verified: 'confirming your email',
  everything: 'all of your rules',
  account: 'this account',
};

export const humanMissing = (missing) =>
  (Array.isArray(missing) ? missing : []).map((k) => MISSING_TEXT[k] || k);
