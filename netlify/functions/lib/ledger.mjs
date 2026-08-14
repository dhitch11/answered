// ledger.mjs — the billing ledger, over the same RPC posture as the rest of this database.
//
// Nothing in here decides a price. The price comes from meter.mjs, which is a transcription of
// /terms; this file only records what was decided and reads it back. The split matters: pricing is
// a published promise and belongs in one readable file, while recording is plumbing.
//
// Two doors, deliberately different credentials:
//   sv_bill_*   the estate secret. Operator actions: create an account, record an outcome, invoice.
//   bl_*        the account's own statement token. Everything a customer may do to their own bill,
//               and nothing they may do to anyone else's. Same shape as the truce party token.

import { rpc, dbConfigured } from './db.mjs';
import { rate, usd, CATALOG } from './meter.mjs';

export { dbConfigured, rate, usd, CATALOG };

const URL_ = () => process.env.ANSWERED_DB_URL;
const ANON = () => process.env.ANSWERED_DB_ANON;

/** The customer's own door. Takes a statement token, never the estate secret. */
export async function open(fn, args, { timeoutMs = 8000 } = {}) {
  const res = await fetch(`${URL_()}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: ANON(), Authorization: `Bearer ${ANON()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ledger ${fn} ${res.status}`);
  return text ? JSON.parse(text) : null;
}

// ── operator ─────────────────────────────────────────────────────────────────────────────────────
export const account       = (row) => rpc('sv_bill_account', { p_row: row });
export const context       = (key, at) => rpc('sv_bill_context', { p_account_key: key, p_at: at || null });
export const setCap        = (key, cents) => rpc('sv_bill_set_cap', { p_account_key: key, p_cap_cents: cents });
export const quietNotice   = (key) => rpc('sv_bill_quiet_notice', { p_account_key: key });
export const statement     = (key, cycle) => rpc('sv_bill_statement', { p_account_key: key, p_cycle: cycle || null });
export const openLines     = (key, cycle) => rpc('sv_bill_open_lines', { p_account_key: key, p_cycle: cycle });
export const mark          = (ids, state, invoiceId) => rpc('sv_bill_mark', { p_ids: ids, p_state: state, p_invoice_id: invoiceId || null });
/** Hand a discarded draft's lines back to 'open'. Never touches a paid or voided line. */
export const unmark        = (invoiceId) => rpc('sv_bill_unmark', { p_invoice_id: invoiceId });
export const setCustomer   = (key, customer) => rpc('sv_bill_stripe_customer', { p_account_key: key, p_customer: customer });
export const setCard       = (customer, brand, last4, onFile) => rpc('sv_bill_card', { p_customer: customer, p_brand: brand, p_last4: last4, p_on_file: onFile });
export const saveInvoice   = (key, cycle, row) => rpc('sv_bill_invoice', { p_account_key: key, p_cycle: cycle, p_row: row });

// ── customer ─────────────────────────────────────────────────────────────────────────────────────
export const readStatement = (token, cycle) => open('bl_statement', { p_token: token, p_cycle: cycle || null });
export const voidCharge    = (token, id, reason) => open('bl_void', { p_token: token, p_event: id, p_reason: reason || null });

/**
 * Rate an outcome against the live account, then record it. One call, because rating without
 * recording is a quote and recording without rating is a number nobody can defend.
 *
 * ★ THE LEDGER IS AUTHORITATIVE ON CAP AND CREDIT, NOT THIS FUNCTION. The engine is called here
 * with the account context so the returned preview is honest, but the RPC recomputes both under a
 * row lock and its answer is the one that lands. If they disagree the divergence is returned as
 * `divergence` rather than being quietly papered over: two concurrent bookings arriving at the cap
 * boundary SHOULD disagree with a preview taken a moment earlier, and that is the ledger doing its
 * job, not a bug to hide.
 *
 * @param {string} key    the account
 * @param {object} event  {kind, idem_key, occurred_at, evidence, ...} as meter.mjs expects
 */
export async function meterAndRecord(key, event) {
  const idem = String(event.idem_key || '').trim();
  if (!idem) throw new Error('every billable outcome needs an idempotency key, usually the call sid or the deal id');

  const ctx = await context(key, event.occurred_at || null);
  if (!ctx || ctx.error) throw new Error(ctx?.error || 'unknown account');

  const rating = rate(event, {
    plan: ctx.plan,
    cap_cents: ctx.cap_cents,
    month_charged_cents: ctx.month_charged_cents,
    first_hold_used: ctx.first_hold_used,
    quiet_credit_cents: ctx.quiet_credit_cents,
    quiet_notice_at: ctx.quiet_notice_at,
    bookings_last_90d: ctx.bookings_last_90d,
  });

  const recorded = await rpc('sv_bill_record', {
    p_account_key: key,
    p_row: {
      idem_key: idem,
      kind: rating.kind || event.kind,
      product: rating.product || null,
      label: rating.label || null,
      occurred_at: event.occurred_at || new Date().toISOString(),
      // The engine's price BEFORE cap and credit. The ledger applies both, atomically.
      gross_cents: rating.gross_cents || 0,
      counts_toward_cap: Boolean(rating.counts_toward_cap),
      credit_created_cents: rating.creates_credit_cents || 0,
      rated_ok: rating.ok !== false,
      reason: rating.reason,
      evidence: event.evidence || {},
      rating,
    },
  });

  const divergence = (!recorded.replay && typeof rating.cents === 'number' && recorded.cents !== rating.cents)
    ? { preview_cents: rating.cents, recorded_cents: recorded.cents,
        note: 'the ledger recomputed cap and credit under a lock and its number is the one on the bill' }
    : null;

  return { ...recorded, rating, divergence };
}
