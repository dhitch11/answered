// stripe-rest.mjs — Stripe over fetch. No SDK, so no dependency lands in the function bundle and
// the deploy procedure this repo already documents does not change.
//
// ★ READ THIS BEFORE YOU CALL ANYTHING HERE. `STRIPE_SECRET_KEY` on this Netlify project is a LIVE
// key on acct_1TLTWp2Nr7S99RW5 (TwinFlame Investments LLC), with charges_enabled and
// payouts_enabled both true. Verified against GET /v1/account on 2026-08-14. There is no test key
// in this environment. Every call in this file therefore touches the real account, and the two
// calls that actually MOVE MONEY are behind an explicit arming flag that is off by default:
//
//     ANSWERED_BILLING_ARMED=1        finalize an invoice, and charge a card
//
// Everything else is safe by construction. Creating a customer, saving a card, and writing draft
// invoice items move nothing: a draft invoice can be deleted and nobody is ever charged from it.
// This mirrors ANSWERED_AUTOPILOT_KILL on the dialer. A billing system whose dangerous operation
// is one typo away from firing is not a billing system, it is an incident waiting for a date.

const API = 'https://api.stripe.com/v1';
const KEY = () => (process.env.STRIPE_SECRET_KEY || '').trim();

export const stripeConfigured = () => Boolean(KEY());
export const stripeLiveMode = () => KEY().startsWith('sk_live');
/** Money may only move when an operator has said so out loud, in the environment. */
export const billingArmed = () => process.env.ANSWERED_BILLING_ARMED === '1';

/** Stripe's form encoding: nested objects are a[b], arrays are a[0][b]. */
export function form(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === 'object') form(item, `${key}[${i}]`, out);
        else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof v === 'object') {
      form(v, key, out);
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return out.join('&');
}

export class StripeError extends Error {
  constructor(status, body) {
    const msg = body?.error?.message || `stripe ${status}`;
    super(msg);
    this.status = status;
    this.code = body?.error?.code || null;
    this.type = body?.error?.type || null;
  }
}

/**
 * @param {string} method  GET | POST | DELETE
 * @param {string} path    e.g. 'customers' or `invoices/${id}/finalize`
 * @param {object} params  form body for POST, query for GET
 * @param {object} opts    idempotencyKey
 */
export async function call(method, path, params = {}, opts = {}) {
  if (!stripeConfigured()) throw new Error('STRIPE_SECRET_KEY is not set');
  const headers = {
    Authorization: `Bearer ${KEY()}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Stripe-Version': '2024-06-20',
  };
  // Stripe's own retry protection. Every write in this repo passes one, keyed on the ledger event,
  // so a Netlify function retry cannot create a second invoice item for the same outcome.
  if (opts.idempotencyKey) headers['Idempotency-Key'] = String(opts.idempotencyKey).slice(0, 255);

  const body = method === 'GET' ? undefined : form(params);
  const qs = method === 'GET' && Object.keys(params).length ? `?${form(params)}` : '';
  const res = await fetch(`${API}/${path}${qs}`, {
    method, headers, body, signal: AbortSignal.timeout(opts.timeoutMs || 15000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* fall through to the status */ }
  if (!res.ok) throw new StripeError(res.status, json);
  return json;
}

// ── the safe half: nothing here moves money ──────────────────────────────────────────────────────

export const account = () => call('GET', 'account');

export const createCustomer = (row, idem) => call('POST', 'customers', {
  email: row.email, name: row.business_name, phone: row.phone || undefined,
  metadata: { answered_account_key: row.account_key, source: 'answered.reddenda.com' },
}, { idempotencyKey: idem });

export const getCustomer = (id) => call('GET', `customers/${id}`);
export const deleteCustomer = (id) => call('DELETE', `customers/${id}`);

/**
 * Card on file, charging nothing. This is the whole of "$0 base": a setup-mode Checkout Session
 * saves a payment method and creates no charge and no subscription. If this ever becomes
 * mode=payment or mode=subscription, the published price book has been broken.
 */
export const createSetupCheckout = (customerId, { successUrl, cancelUrl, accountKey }, idem) =>
  call('POST', 'checkout/sessions', {
    mode: 'setup',
    customer: customerId,
    currency: 'usd',
    success_url: successUrl,
    cancel_url: cancelUrl,
    payment_method_types: ['card'],
    metadata: { answered_account_key: accountKey },
  }, { idempotencyKey: idem });

export const getSession = (id) => call('GET', `checkout/sessions/${id}`);
export const getSetupIntent = (id) => call('GET', `setup_intents/${id}`);
export const getPaymentMethod = (id) => call('GET', `payment_methods/${id}`);
export const listPaymentMethods = (customerId) =>
  call('GET', `customers/${customerId}/payment_methods`, { type: 'card', limit: 3 });

export const setDefaultPaymentMethod = (customerId, pmId) =>
  call('POST', `customers/${customerId}`, { invoice_settings: { default_payment_method: pmId } });

/**
 * One line on a draft invoice. Inline amount rather than a Price object on purpose: an outcome
 * price is quoted from /terms at the moment it happened and frozen onto the ledger event, so
 * pointing it at a catalog Price would let a future catalog edit rewrite an old bill. The terms
 * say we never bill backwards, and this is what that looks like in an API call.
 */
export const createInvoiceItem = (customerId, { amountCents, description, invoiceId, metadata }, idem) =>
  call('POST', 'invoiceitems', {
    customer: customerId,
    amount: amountCents,
    currency: 'usd',
    description: String(description || '').slice(0, 250),
    invoice: invoiceId || undefined,
    metadata: metadata || undefined,
  }, { idempotencyKey: idem });

export const deleteInvoiceItem = (id) => call('DELETE', `invoiceitems/${id}`);

export const createDraftInvoice = (customerId, { description, metadata, daysUntilDue }, idem) =>
  call('POST', 'invoices', {
    customer: customerId,
    auto_advance: false,          // never let Stripe finalize this on its own schedule
    collection_method: 'charge_automatically',
    description: String(description || '').slice(0, 1500),
    metadata: metadata || undefined,
    days_until_due: daysUntilDue || undefined,
  }, { idempotencyKey: idem });

export const getInvoice = (id) => call('GET', `invoices/${id}`);
export const deleteDraftInvoice = (id) => call('DELETE', `invoices/${id}`);

// ── the armed half: these two move real money ────────────────────────────────────────────────────

function requireArmed(what) {
  if (!billingArmed()) {
    const e = new Error(`${what} would move real money on a live Stripe account. Set ANSWERED_BILLING_ARMED=1 to allow it.`);
    e.disarmed = true;
    throw e;
  }
}

export function finalizeInvoice(id, idem) {
  requireArmed('finalizing an invoice');
  return call('POST', `invoices/${id}/finalize`, { auto_advance: false }, { idempotencyKey: idem });
}

export function payInvoice(id, idem) {
  requireArmed('charging a card');
  return call('POST', `invoices/${id}/pay`, {}, { idempotencyKey: idem });
}

// ── webhook signature ────────────────────────────────────────────────────────────────────────────
/**
 * Stripe signs the raw body. Verify against the raw bytes, never a re-serialized object, and
 * compare in constant time. An unverified webhook is an open write endpoint with a friendly name.
 */
export async function verifyWebhook(rawBody, signatureHeader, secret) {
  if (!secret) return { ok: false, reason: 'STRIPE_WEBHOOK_SECRET is not set, so no webhook can be trusted' };
  const parts = Object.fromEntries(String(signatureHeader || '').split(',').map((p) => {
    const i = p.indexOf('=');
    return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  }));
  if (!parts.t || !parts.v1) return { ok: false, reason: 'malformed signature header' };

  const crypto = await import('node:crypto');
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'signature does not match' };

  // Replay window. Stripe's own guidance is five minutes.
  const age = Math.abs(Date.now() / 1000 - Number(parts.t));
  if (!Number.isFinite(age) || age > 300) return { ok: false, reason: 'timestamp outside the five minute window' };

  try { return { ok: true, event: JSON.parse(rawBody) }; }
  catch { return { ok: false, reason: 'signed body is not json' }; }
}
