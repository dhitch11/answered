// /api/meter — the operator door onto the meter and the ledger.
//
// This is the endpoint an outcome producer calls when something good happened: the voice side when
// a job is booked with all four pieces, the truce engine when a deal settles, the Recover side when
// money lands. It rates the outcome against the published price book, records it once, and hands
// back the exact sentence the customer will read on their statement.
//
// THREE RULES THIS FILE KEEPS:
//   1. It never invents a price. Everything comes from lib/meter.mjs, which is a transcription of
//      /terms, and an event not on the published list is REFUSED rather than guessed at.
//   2. It is idempotent at the caller's key. A webhook that fires twice bills once. The ledger's
//      unique index is the enforcement; this file just insists a key is present.
//   3. It fails closed. No ANSWERED_METER_SECRET means no endpoint, never an open one. A billing
//      write endpoint that degrades to open is the worst failure mode in this repo.

import crypto from 'node:crypto';
import {
  meterAndRecord, account as upsertAccount, context, setCap, quietNotice, statement,
  dbConfigured, rate, usd, CATALOG,
} from './lib/ledger.mjs';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
};
const ok = (d) => ({ statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(d) });
const bad = (c, m, extra = {}) => ({ statusCode: c, headers: JSON_HEADERS, body: JSON.stringify({ error: m, ...extra }) });

const SECRET = () => (process.env.ANSWERED_METER_SECRET || '').trim();

/** Constant time, and never a fallback to a secret somebody else holds. */
function authed(headers) {
  const want = SECRET();
  if (!want) return false;
  const raw = String(headers.authorization || headers.Authorization || '');
  const given = raw.startsWith('Bearer ') ? raw.slice(7).trim() : raw.trim();
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const site = () => process.env.URL || 'https://answered.reddenda.com';

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return bad(405, 'POST only');

  if (!SECRET()) {
    // Honest, and closed. The caller learns the door is not configured, not that it is open.
    return bad(503, 'the meter is not configured on this deploy: ANSWERED_METER_SECRET is unset');
  }
  if (!authed(event.headers || {})) return bad(401, 'unauthorized');
  if (!dbConfigured()) return bad(503, 'the ledger is not configured: ANSWERED_DB_URL / ANSWERED_DB_ANON / ANSWERED_DB_SECRET');

  let body;
  try {
    body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body || '{}');
  } catch { return bad(400, 'bad json'); }

  const op = String(body.op || '');
  const key = String(body.account_key || '').trim().toLowerCase();

  try {
    switch (op) {
      // The published price book, from the one file that holds it, so no surface has to retype it.
      case 'catalog':
        return ok({
          catalog: Object.fromEntries(Object.entries(CATALOG).map(([k, v]) => [k, { ...v, price: v.cents === null ? 'a share of what landed' : usd(v.cents) }])),
          note: 'These prices are transcribed from /terms. If this list and /terms ever disagree, /terms wins.',
        });

      // What would this cost. No write, no side effect, so a caller can show a number before it
      // commits to one. If an account is named the preview uses that account's live cap and credit.
      case 'preview': {
        const ctx = key ? await context(key, body.event?.occurred_at || null) : null;
        if (key && (!ctx || ctx.error)) return bad(404, ctx?.error || 'unknown account');
        const r = rate(body.event || {}, ctx ? {
          plan: ctx.plan, cap_cents: ctx.cap_cents, month_charged_cents: ctx.month_charged_cents,
          first_hold_used: ctx.first_hold_used, quiet_credit_cents: ctx.quiet_credit_cents,
          quiet_notice_at: ctx.quiet_notice_at, bookings_last_90d: ctx.bookings_last_90d,
        } : {});
        return ok({ rating: r, price: usd(r.cents), against_account: Boolean(ctx) });
      }

      case 'record': {
        if (!key) return bad(400, 'record needs an account_key');
        const ev = body.event || {};
        if (!ev.idem_key) return bad(400, 'every billable outcome needs an idem_key, usually the call sid or the deal id');
        const r = await meterAndRecord(key, ev);
        return ok({
          recorded: !r.replay, replay: Boolean(r.replay), id: r.id,
          cents: r.cents, price: usd(r.cents), billable: r.billable,
          reason: r.reason, cycle_month: r.cycle_month, divergence: r.divergence || null,
        });
      }

      case 'account': {
        if (!body.account_key || !body.email) return bad(400, 'an account needs an account_key and an email');
        const a = await upsertAccount({
          account_key: body.account_key, business_name: body.business_name,
          email: body.email, phone: body.phone, plan: body.plan, cap_cents: body.cap_cents,
        });
        return ok({ ...a, statement_url: `${site()}/statement/${a.statement_token}` });
      }

      case 'cap': {
        if (!key || !Number.isFinite(Number(body.cap_cents))) return bad(400, 'cap needs an account_key and cap_cents');
        const r = await setCap(key, Math.round(Number(body.cap_cents)));
        return ok({
          ...r,
          note: 'A new cap takes effect at your next billing cycle, never in the middle of one. That is what /terms promises and what the ledger does.',
        });
      }

      // The quiet line cannot be billed until this is on record, and it is on record only once.
      case 'quiet_notice': {
        if (!key) return bad(400, 'quiet_notice needs an account_key');
        return ok(await quietNotice(key));
      }

      case 'statement': {
        if (!key) return bad(400, 'statement needs an account_key');
        const s = await statement(key, body.cycle || null);
        if (s?.error) return bad(404, s.error);
        return ok({ ...s, statement_url: `${site()}/statement/${s.statement_token}` });
      }

      default:
        return bad(400, `unknown op "${op}"`, { ops: ['catalog', 'preview', 'record', 'account', 'cap', 'quiet_notice', 'statement'] });
    }
  } catch (e) {
    console.error(`meter ${op} failed:`, String(e.message).slice(0, 300));
    return bad(500, String(e.message).slice(0, 200));
  }
};
