// booking.mjs — a booked job is a SIGNED LINK, not a database row.
//
// WHY THIS SHAPE, AND WHY IT IS NOT LAZINESS.
// The whole value of Answered is that a missed call turns into a job on the calendar. So the
// artifact that proves it happened is the single most load-bearing customer-facing surface in the
// product, and on 2026-08-14 this repo demonstrated, live, what a storage dependency does to one:
// /api/demo-health reported `@netlify/blobs failed to load: Cannot find package '@netlify/blobs'`
// on production, which took the whole event collector down with it and nobody noticed, because a
// collector that fails reads later as a measured zero.
//
// A booking link that 500s because a package did not resolve is worse than useless: the customer
// has already been told to click it. So the job travels INSIDE the URL, HMAC-signed, and the
// landing page and the .ics are both computed from the token alone. Zero reads. Nothing to be
// down. A durable copy is written elsewhere as telemetry and can never break the link.
//
// The signing key never leaves the server and is never transmitted. ANSWERED_BOOKING_KEY is the
// real one; ANSWERED_COCKPIT_KEY is the fallback because it is ours alone. It deliberately does
// NOT fall back to ANSWERED_BRAIN_SECRET, which is pasted into a third party's dashboard: anyone
// holding that could forge a job link. With neither set this module FAILS CLOSED, because an
// unsigned booking link is a forgery surface, and an honest 503 beats a fake confirmation.

import crypto from 'node:crypto';

export const TOKEN_VERSION = 'v1';
export const MAX_TOKEN_CHARS = 4000;   // a URL nobody can use is a broken URL
const SKEW_PAST_MS = 36 * 3600 * 1000; // a job "booked" more than a day and a half ago is a bug
const SKEW_FUTURE_MS = 730 * 24 * 3600 * 1000;

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function signingKey() {
  const own = String(process.env.ANSWERED_BOOKING_KEY || '').trim();
  if (own) return own;
  const fallback = String(process.env.ANSWERED_COCKPIT_KEY || '').trim();
  if (fallback) {
    console.error('booking: ANSWERED_BOOKING_KEY is not set; signing with ANSWERED_COCKPIT_KEY. Set a dedicated key.');
    return fallback;
  }
  return '';
}

export const canSign = () => Boolean(signingKey());

const mac = (payload) => b64u(crypto.createHmac('sha256', signingKey()).update(payload).digest());

// ── field hygiene ────────────────────────────────────────────────────────────────────────────

// Strip control characters but keep \n and \t: a note typed on a phone has newlines in it, and
// a stray vertical tab is exactly what turns a valid .ics into one Apple Calendar refuses
// without ever saying why.
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const clean = (s, cap) => String(s == null ? '' : s)
  .replace(CTRL, '')
  .replace(/\r\n?/g, '\n')
  .trim()
  .slice(0, cap);

/**
 * US-leaning E.164 normalisation. Returns '' when it cannot be sure, and '' is honest: a tel:
 * link that dials the wrong number is worse than no tel: link. The redesign war room's number one
 * finding was a phone company you cannot call, so where we DO have a number it becomes a real
 * tel: href, and where we do not, the page says so instead of rendering a dead control.
 */
export function e164(raw) {
  const d = String(raw == null ? '' : raw).replace(/[^\d+]/g, '');
  if (/^\+\d{8,15}$/.test(d)) return d;
  const n = d.replace(/\D/g, '');
  if (n.length === 10) return `+1${n}`;
  if (n.length === 11 && n.startsWith('1')) return `+${n}`;
  return '';
}

export function prettyPhone(e) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(String(e || ''));
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : String(e || '');
}

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;.]+\.[^\s@,;]{2,}$/;
export const looksLikeEmail = (s) => EMAIL_RE.test(String(s || '').trim());

// A timezone we cannot format in is a timezone we refuse to claim.
function usableZone(tz) {
  const z = String(tz || '').trim();
  if (!z) return '';
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }).format(new Date()); return z; }
  catch { return ''; }
}

export const DEFAULT_TZ = 'America/Los_Angeles';

// ── normalise ────────────────────────────────────────────────────────────────────────────────

/**
 * Turn whatever a caller posted into a job, or into a list of honest reasons why it is not one.
 * Never guesses a missing required field, never invents a default time, never silently truncates
 * a date it could not parse into "now".
 *
 * `mode` defaults to 'demo' ON PURPOSE. Today the only line that books anything is the demo line,
 * where the booking is explicitly pretend, and the landing page says so in a band you cannot miss.
 * A caller has to assert mode:'live' to lose that label, so the failure direction is honesty.
 */
export function normalize(input) {
  const i = input && typeof input === 'object' ? input : {};
  const errors = [];

  const shopName = clean(i.shop_name ?? (i.shop && i.shop.name), 120);
  const customerName = clean(i.customer_name ?? (i.customer && i.customer.name), 120);
  const service = clean(i.service ?? i.job ?? i.reason, 200);
  if (!shopName) errors.push('shop_name is required (the business the customer booked with)');
  if (!customerName) errors.push('customer_name is required');
  if (!service) errors.push('service is required (what the visit is for, in the customer\'s words)');

  const startsRaw = i.starts_at ?? i.start ?? i.when;
  const start = startsRaw ? new Date(startsRaw) : null;
  if (!start || Number.isNaN(start.getTime())) {
    errors.push('starts_at is required and must be a date this server can parse (ISO 8601 is safest)');
  } else {
    const delta = start.getTime() - Date.now();
    if (delta < -SKEW_PAST_MS) errors.push('starts_at is in the past by more than 36 hours; refusing to book backwards');
    if (delta > SKEW_FUTURE_MS) errors.push('starts_at is more than two years out; refusing');
  }

  let minutes = Number(i.minutes ?? i.duration_minutes ?? 60);
  if (!Number.isFinite(minutes)) minutes = 60;
  minutes = Math.round(minutes);
  if (minutes < 5 || minutes > 600) errors.push('minutes must be between 5 and 600');

  const mode = String(i.mode || '').toLowerCase() === 'live' ? 'live' : 'demo';

  const customerEmail = clean(i.customer_email ?? (i.customer && i.customer.email), 200).toLowerCase();
  if (customerEmail && !looksLikeEmail(customerEmail)) errors.push('customer_email is not a usable address');

  const callSid = clean(i.call_sid, 40);
  if (callSid && !/^CA[0-9a-f]{32}$/i.test(callSid)) errors.push('call_sid is not a Twilio call sid');

  if (errors.length) return { ok: false, errors, job: null };

  const job = {
    v: 1,
    id: `AJ${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
    m: mode,
    s: shopName,
    sp: e164(i.shop_phone ?? (i.shop && i.shop.phone)),
    c: customerName,
    cp: e164(i.customer_phone ?? (i.customer && i.customer.phone)),
    ce: customerEmail,
    a: clean(i.address ?? (i.customer && i.customer.address), 240),
    w: service,
    t: start.toISOString(),
    d: minutes,
    tz: usableZone(i.tz ?? i.timezone) || DEFAULT_TZ,
    n: clean(i.notes, 700),
    cs: callSid,
    src: clean(i.source, 60) || 'api',
    at: new Date().toISOString(),
  };
  return { ok: true, errors: [], job };
}

// ── token ────────────────────────────────────────────────────────────────────────────────────

/**
 * MEASURED SIZES, so nobody is surprised by a long link later: a realistic job (shop, customer,
 * phone, street address, one line of notes) mints at about 680 characters, and a job with EVERY
 * field pushed to its cap mints at about 2,100. Both are far inside what browsers, Netlify's
 * router and email clients carry, and the reader never sees the string because it sits behind a
 * button. MAX_TOKEN_CHARS is the hard stop that turns "too big" into a loud throw rather than a
 * link that silently truncates in somebody's mail client.
 *
 * Empty fields are dropped before signing. A job with no notes, no address and no email carried
 * `"n":"","a":"","ce":""` in every token, which is pure weight in a string whose whole job is to
 * survive being pasted. Every reader here already treats a missing field and an empty one the
 * same way, so this is invisible to the rest of the system.
 */
export function mint(job) {
  if (!canSign()) throw new Error('booking: no signing key (set ANSWERED_BOOKING_KEY)');
  const lean = {};
  for (const [k, v] of Object.entries(job)) if (v !== '' && v !== null && v !== undefined) lean[k] = v;
  const payload = b64u(Buffer.from(JSON.stringify(lean), 'utf8'));
  const token = `${TOKEN_VERSION}.${payload}.${mac(payload)}`;
  if (token.length > MAX_TOKEN_CHARS) {
    throw new Error(`booking: this job needs ${token.length} characters and the link cap is ${MAX_TOKEN_CHARS}; shorten the notes or the address`);
  }
  return token;
}

/**
 * Returns the job, or null. Never throws, never partially trusts. A tampered payload and a
 * truncated one and a token minted under a rotated key all land in the same place: not a job.
 */
export function verify(token) {
  if (!canSign()) return null;
  const t = String(token || '');
  if (!t || t.length > MAX_TOKEN_CHARS) return null;
  const parts = t.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
  const [, payload, sig] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(sig)) return null;

  const want = Buffer.from(mac(payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;

  try {
    const job = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!job || typeof job !== 'object' || job.v !== 1) return null;
    if (!job.t || Number.isNaN(new Date(job.t).getTime())) return null;
    return job;
  } catch { return null; }
}

// ── time, said the way a person says it ──────────────────────────────────────────────────────

export function endOf(job) {
  return new Date(new Date(job.t).getTime() + (Number(job.d) || 60) * 60000);
}

const fmt = (date, tz, opts) => {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(date); }
  catch { return new Intl.DateTimeFormat('en-US', opts).format(date); }
};

/** { day: 'Saturday, August 16', window: '8:00 AM to 9:00 AM', zone: 'PDT' } */
export function whenParts(job) {
  const tz = job.tz || DEFAULT_TZ;
  const start = new Date(job.t);
  const end = endOf(job);
  const day = fmt(start, tz, { weekday: 'long', month: 'long', day: 'numeric' });
  const t1 = fmt(start, tz, { hour: 'numeric', minute: '2-digit' });
  const t2 = fmt(end, tz, { hour: 'numeric', minute: '2-digit' });
  let zone = '';
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(start);
    zone = (p.find((x) => x.type === 'timeZoneName') || {}).value || '';
  } catch { zone = ''; }
  return { day, window: `${t1} to ${t2}`, zone, start, end };
}

// ── RFC 5545 ─────────────────────────────────────────────────────────────────────────────────
//
// Two details that are the difference between a file a calendar opens and a file it rejects:
// CRLF line endings everywhere, and folding at 75 OCTETS rather than 75 characters. Fold on a
// character boundary computed in bytes, or one accented street name produces a corrupt file that
// Apple Calendar silently refuses.

const icsEsc = (s) => String(s == null ? '' : s)
  .replace(/\\/g, '\\\\')
  .replace(/;/g, '\\;')
  .replace(/,/g, '\\,')
  .replace(/\r?\n/g, '\\n');

export function foldLine(line) {
  const out = [];
  let cur = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of String(line)) {          // iterate code points, never UTF-16 units
    const w = Buffer.byteLength(ch, 'utf8');
    if (bytes + w > limit) { out.push(cur); cur = ' '; bytes = 1; limit = 75; }
    cur += ch; bytes += w;
  }
  out.push(cur);
  return out.join('\r\n');
}

const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function ics(job, { url = '', prodid = '-//Answered//Booked job//EN' } = {}) {
  const start = new Date(job.t);
  const end = endOf(job);
  const who = job.c || 'the customer';
  const descLines = [
    `Booked by Answered for ${job.s}.`,
    `Customer: ${who}${job.cp ? ` (${prettyPhone(job.cp)})` : ''}`,
    job.a ? `Address: ${job.a}` : '',
    job.n ? `Notes: ${job.n}` : '',
    job.m === 'demo'
      ? 'DEMO BOOKING. This came from the Answered demo line, so no one is being dispatched.'
      : '',
    url ? `Job page: ${url}` : '',
  ].filter(Boolean);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${prodid}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${job.id}@answered.reddenda.com`,
    `DTSTAMP:${stamp(job.at || new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${icsEsc(`${job.m === 'demo' ? 'DEMO: ' : ''}${job.w} - ${who}`)}`,
    `DESCRIPTION:${icsEsc(descLines.join('\n'))}`,
    job.a ? `LOCATION:${icsEsc(job.a)}` : '',
    url ? `URL:${icsEsc(url)}` : '',
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'TRANSP:OPAQUE',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsEsc(`${job.w} at ${job.a || 'the address on the job page'}`)}`,
    'TRIGGER:-PT60M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);

  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

// ── links ────────────────────────────────────────────────────────────────────────────────────

export function siteOrigin() {
  const raw = String(process.env.ANSWERED_SITE_URL || process.env.URL || 'https://answered.reddenda.com').trim();
  return raw.replace(/\/+$/, '');
}

export const jobUrl = (token) => `${siteOrigin()}/job/${token}`;
export const icsUrl = (token) => `${siteOrigin()}/job/${token}/calendar.ics`;
