// gate-auth.mjs — the server-side PIN gate, shared by every internal surface.
//
// The lesson this encodes is expensive and was learned elsewhere in the estate: a CSS "PIN
// curtain" over content the server already sent protects nothing. 303,451 bytes were readable by
// any anonymous curl behind one. So nothing gated is ever serialized before the check passes, and
// the check happens here, on the server, every request.
//
// Wrong PIN answers slowly and honestly. Missing env fails CLOSED: no PIN configured means no
// page, never an open door.

import crypto from 'node:crypto';

const PIN = () => (process.env.ANSWERED_DIRECTORY_PIN || '').trim();
const KEY = () => process.env.ANSWERED_BRAIN_SECRET || '';
const TTL_HOURS = 12;

export const BASE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

const hmac = (s) => crypto.createHmac('sha256', KEY()).update(s).digest('base64url');

export function mintCookie(name) {
  const exp = Date.now() + TTL_HOURS * 3600 * 1000;
  return `${exp}.${hmac(`${name}|${exp}`)}`;
}

export function cookieValid(name, value) {
  if (!value || !KEY()) return false;
  const [exp, sig] = String(value).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const want = hmac(`${name}|${exp}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function pinValid(given) {
  const pin = PIN();
  if (!pin || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(pin);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const configured = () => Boolean(PIN() && KEY());

export function readCookie(headers, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(String(headers.cookie || headers.Cookie || ''));
  return m ? decodeURIComponent(m[1]) : null;
}

export function setCookieHeader(name, value) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL_HOURS * 3600}`;
}

export const slow = (ms = 600) => new Promise((r) => setTimeout(r, ms));
