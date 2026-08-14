// account-auth.mjs — how a business owner proves who he is.
//
// No passwords. A contractor checks email on a phone between jobs; a password is one more thing
// to lose and one more thing for us to store badly. He types his email, he gets a link, the link
// works once, and it mints a signed cookie.
//
// THREE THINGS THIS FILE REFUSES TO DO:
//   1. Store a usable token. Only the sha256 of the emailed token reaches the database, so a
//      database read can never mint a session.
//   2. Share a key across trust boundaries. The customer session key is its own secret, never
//      ANSWERED_COCKPIT_KEY (operator) and never ANSWERED_BRAIN_SECRET (which is pasted into a
//      vendor's console and travels on every conversational turn). gate-auth.mjs carries the
//      note about what that mistake cost; this file does not repeat it.
//   3. Fail open. No ANSWERED_ACCOUNT_KEY means no sessions at all. An unsigned session cookie is
//      an account takeover with extra steps.

import crypto from 'node:crypto';

const KEY = () => (process.env.ANSWERED_ACCOUNT_KEY || '').trim();
const SESSION_HOURS = 24 * 14;
export const COOKIE = 'aw_acct';

export const configured = () => Boolean(KEY());

// ── the emailed link ─────────────────────────────────────────────────────────────────────────

/** A fresh login token. The raw half is emailed and never persisted; the hash is stored. */
export function mintLoginToken() {
  const raw = crypto.randomBytes(32).toString('base64url');
  return { raw, hash: hashToken(raw) };
}

export const hashToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

// ── the session ──────────────────────────────────────────────────────────────────────────────

const sign = (s) => crypto.createHmac('sha256', KEY()).update(s).digest('base64url');

export function mintSession(accountId) {
  if (!configured()) throw new Error('ANSWERED_ACCOUNT_KEY is not set; refusing to mint a session');
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  return `${accountId}.${exp}.${sign(`${accountId}|${exp}`)}`;
}

/** The account id this cookie proves, or null. Never throws, never guesses. */
export function readSession(cookieValue) {
  if (!configured() || !cookieValue) return null;
  const parts = String(cookieValue).split('.');
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  if (!/^\d{10,16}$/.test(exp) || Number(exp) < Date.now()) return null;
  const want = sign(`${id}|${exp}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return id;
}

export const setCookie = (value) =>
  `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}`;

export const clearCookie = () =>
  `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export function readCookie(headers, name = COOKIE) {
  const raw = typeof headers?.get === 'function'
    ? (headers.get('cookie') || '')
    : String(headers?.cookie || headers?.Cookie || '');
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(raw);
  return m ? decodeURIComponent(m[1]) : null;
}

// ── shared response furniture ────────────────────────────────────────────────────────────────

/**
 * Nothing an owner sees is cacheable and nothing is indexable. The account console carries a
 * business's phone rules and its owner's mobile number; a CDN copy of that page is a leak with a
 * long life.
 */
export const PRIVATE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
};

export const json = (status, body, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...PRIVATE_HEADERS, ...extra },
});

export const html = (status, body, extra = {}) => new Response(body, {
  status,
  headers: { 'Content-Type': 'text/html; charset=utf-8', ...PRIVATE_HEADERS, ...extra },
});

export const slow = (ms = 400) => new Promise((r) => setTimeout(r, ms));

/** Client IP as the platform reports it, first hop only. Used for the token audit trail. */
export function clientIp(req) {
  const h = req.headers;
  const xf = (h.get('x-nf-client-connection-ip') || h.get('x-forwarded-for') || '').split(',')[0].trim();
  return xf.slice(0, 60);
}
