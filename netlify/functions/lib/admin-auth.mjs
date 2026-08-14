// admin-auth.mjs — how the operator of this business proves who he is.
//
// This is a THIRD trust boundary and it is deliberately not either of the other two:
//
//   gate-auth.mjs      a shared PIN. Proves someone knows a secret, never WHICH someone.
//                      Right for the cockpit, where the question is "is this us".
//   account-auth.mjs   a customer's magic link. Proves a business owner owns an inbox.
//   admin-auth.mjs     an operator's EMAIL AND PASSWORD, and a session row that can be revoked.
//                      Right for a console that can read a customer's recordings and refund
//                      their money, where the question is "who exactly did that, and when".
//
// FIVE THINGS THIS FILE REFUSES TO DO:
//
//  1. Store a password. Only a scrypt verifier reaches the database. Nothing in this database,
//     in a backup, or in a log line can be replayed as a credential.
//  2. Serialize a privileged byte before the check. The estate has shipped a CSS "PIN curtain"
//     over a page the server had already sent in full: 303,451 bytes readable by any anonymous
//     curl. The anonymous response here is a login form and nothing else, and the console HTML
//     is not built, let alone written, until a session resolves.
//  3. Trust a cookie on its own. A signed stateless cookie cannot be taken back before it
//     expires, so a stolen one is valid until it is not. Every request resolves against a
//     session ROW, which means logout and revoke-all are real.
//  4. Rate-limit in memory. A Netlify function has no memory between invocations, so an
//     in-process counter counts to one forever and limits nothing. Failure accounting lives in
//     Postgres, on the user row, where it survives a cold start.
//  5. Fail open. No ANSWERED_ADMIN_KEY, or no database, means no console. Not a degraded
//     console, not a read-only console. No console.
//
// SESSION KEY SEPARATION. ANSWERED_ADMIN_KEY is this boundary's own secret. It is never
// ANSWERED_COCKPIT_KEY (a different privilege), never ANSWERED_DIRECTORY_PIN (a shared secret),
// and never ANSWERED_BRAIN_SECRET, which is pasted into a vendor's console and travels on every
// conversational turn. gate-auth.mjs carries the note about what that last mistake nearly cost.

import crypto from 'node:crypto';
import { rpc, dbConfigured } from './db.mjs';

const KEY = () => (process.env.ANSWERED_ADMIN_KEY || '').trim();

export const COOKIE = 'ans_admin';
export const SESSION_HOURS = 12;

/** scrypt parameters. N=16384 is roughly 100ms per verify on this runtime: slow enough to make
 *  offline cracking expensive, fast enough that a login does not time out a function. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

export const configured = () => Boolean(KEY() && dbConfigured());

/** What is missing, in words, so a 503 can say why instead of just failing. */
export function whyNotConfigured() {
  const missing = [];
  if (!KEY()) missing.push('ANSWERED_ADMIN_KEY');
  if (!process.env.ANSWERED_DB_URL) missing.push('ANSWERED_DB_URL');
  if (!process.env.ANSWERED_DB_ANON) missing.push('ANSWERED_DB_ANON');
  if (!process.env.ANSWERED_DB_SECRET) missing.push('ANSWERED_DB_SECRET');
  return missing;
}

// ── passwords ────────────────────────────────────────────────────────────────────────────────

/** scrypt$N$r$p$salt_b64$hash_b64 — the parameters travel with the hash so they can be raised
 *  later without invalidating every existing verifier. */
export function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * Constant-time verify. Returns false for a malformed stored value rather than throwing, because
 * a thrown error on a login path is a 500 that tells an attacker the account exists.
 */
export function verifyPassword(plain, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const want = Buffer.from(hashB64, 'base64');
    if (!salt.length || !want.length) return false;
    const got = crypto.scryptSync(String(plain), salt, want.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
    });
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

// ── sessions ─────────────────────────────────────────────────────────────────────────────────

export const hashToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

/**
 * The cookie value is `token.signature`. The signature is belt to the database's braces: a forged
 * or truncated cookie is rejected here, before a database round trip, so an unauthenticated flood
 * costs us CPU rather than connections.
 */
export function mintCookieValue(rawToken) {
  const sig = crypto.createHmac('sha256', KEY()).update(rawToken).digest('base64url');
  return `${rawToken}.${sig}`;
}

export function splitCookieValue(value) {
  const s = String(value || '');
  const dot = s.lastIndexOf('.');
  if (dot < 32) return null;
  const raw = s.slice(0, dot);
  const sig = s.slice(dot + 1);
  const want = crypto.createHmac('sha256', KEY()).update(raw).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return raw;
}

export const newToken = () => crypto.randomBytes(32).toString('base64url');

export const setCookie = (value) =>
  `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}`;

export const clearCookie = () =>
  `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

export function readCookie(req, name = COOKIE) {
  const raw = typeof req?.headers?.get === 'function'
    ? (req.headers.get('cookie') || '')
    : String(req?.headers?.cookie || req?.headers?.Cookie || '');
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(raw);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Resolve the caller. Returns the operator, or a reason. Never throws on a bad cookie.
 *
 * ★ SameSite=Strict, not Lax. This console has no legitimate cross-site entry: nobody should ever
 * arrive at a refund screen by following a link from somewhere else. Strict costs a re-login when
 * you click a link from an email, which for an operator tool is the correct trade.
 */
export async function currentAdmin(req) {
  if (!configured()) return { ok: false, reason: 'unconfigured' };
  const cookie = readCookie(req);
  if (!cookie) return { ok: false, reason: 'anonymous' };
  const raw = splitCookieValue(cookie);
  if (!raw) return { ok: false, reason: 'bad_signature' };
  let row;
  try {
    row = await rpc('sv_admin_session', { p_token_hash: hashToken(raw) });
  } catch (e) {
    console.error('admin-auth: session lookup failed:', e && e.message);
    return { ok: false, reason: 'db_unavailable' };
  }
  if (!row) return { ok: false, reason: 'unknown_session' };
  if (row.revoked) return { ok: false, reason: 'revoked' };
  if (row.expired) return { ok: false, reason: 'expired' };
  if (row.disabled) return { ok: false, reason: 'disabled' };
  return { ok: true, admin: row, rawToken: raw };
}

// ── request furniture ────────────────────────────────────────────────────────────────────────

/**
 * Nothing this console serves is cacheable, indexable, framable, or referrer-leaking. A CDN copy
 * of a page listing customers and their recordings is a leak with a long life.
 */
export const PRIVATE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), payment=()',
  // Everything is inline and same-origin. No CDN, no font host, no analytics, no image host.
  // 'unsafe-inline' is required because the page ships its own style and script in the document;
  // there is no external origin this page may reach, which is the property that matters.
  'Content-Security-Policy':
    "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; " +
    "img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
    // font-src 'self' adds ZERO external origins: the brand faces are same-origin files.
    "font-src 'self'; " +
    "connect-src 'self'; media-src 'self'",
});

export const json = (status, body, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...PRIVATE_HEADERS, ...extra },
});

export const html = (status, body, extra = {}) => new Response(body, {
  status,
  headers: { 'Content-Type': 'text/html; charset=utf-8', ...PRIVATE_HEADERS, ...extra },
});

/** A deliberate, uniform delay on every authentication answer, right or wrong. */
export const slow = (ms = 600) => new Promise((r) => setTimeout(r, ms));

export function clientIp(req) {
  const h = req.headers;
  const xf = (h.get('x-nf-client-connection-ip') || h.get('x-forwarded-for') || '').split(',')[0].trim();
  return xf.slice(0, 60);
}

export const clientUa = (req) => String(req.headers.get('user-agent') || '').slice(0, 300);

/**
 * Write to the audit log. Never blocks the response and never swallows its own failure silently:
 * an audit trail that fails quietly is worse than none, because it reads later as "nothing
 * happened".
 */
export async function audit(admin, req, action, extra = {}) {
  try {
    await rpc('sv_admin_audit', {
      p_row: {
        admin_id: admin?.admin_id || null,
        actor_email: admin?.email || null,
        action,
        target_kind: extra.targetKind || null,
        target_id: extra.targetId == null ? null : String(extra.targetId),
        payload: extra.payload || {},
        result: extra.result || 'ok',
        ip: clientIp(req),
        ua: clientUa(req),
      },
    });
  } catch (e) {
    console.error(`AUDIT WRITE FAILED for action "${action}":`, e && e.message);
  }
}

/**
 * CSRF. SameSite=Strict already blocks the cross-site form post, and every mutating route here is
 * JSON-only. This adds the third condition: a header a cross-origin form cannot set without a
 * preflight the CSP and same-origin policy will not grant.
 */
export const CSRF_HEADER = 'x-answered-admin';
export const csrfOk = (req) => req.headers.get(CSRF_HEADER) === '1';
