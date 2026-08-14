// lib/parley-money.mjs — HOW THE FEE ACTUALLY GETS COLLECTED.
//
// David, 2026-08-14: "Make sure we can truly actually find a way to track it. Not just a promise,
// not just a signature. Actually track it and get it."
//
// THE ARGUMENT, because it decides the whole design. There are only two ways to know a negotiation
// produced money, and only one of them pays us:
//
//   OBSERVE IT   Both sides type their names on a sheet and we believe them. This is a PROMISE. It
//                cannot be verified, it cannot be collected, and the moment a fee depends on it the
//                honest answer for both parties is to click "it fell through". Every "self-reported
//                outcome" fee model in history has this hole.
//   CARRY IT     The money moves THROUGH us. Then the outcome is not reported, it is OBSERVED at
//                the only place that cannot lie: a payment processor's own ledger. The fee is not
//                invoiced, it is taken in the same movement. Nobody is trusted and nobody is billed.
//
// So Parley does not sell the negotiation. It sells the SETTLEMENT RAIL, and the rail is the
// tracking. A destination charge with an application fee does exactly this: the payer pays once,
// the payee's share lands in the payee's own Stripe account, and our cut is separated by Stripe
// before either party sees a balance. One movement, three outcomes, no invoice and no collections.
//
// ★ AND IT HAS TO BE WORTH USING, OR IT IS JUST A TAX PEOPLE ROUTE AROUND. The rail is the only
// part of this product that gives a stranger a reason to trust another stranger: the money is real
// before anybody drives anywhere, and each side gets a receipt naming the other. If two people
// would rather meet with cash, they will, and we earn nothing from that deal. That is the honest
// trade and it is better than a fee nobody can enforce.
//
// PRICING IS NOT SETTLED AND THIS FILE DOES NOT DECIDE IT. Estate rule: the live Stripe catalogue
// is the only authority, and `truce_deals.fee_cents` carries the figure for a given deal. Nothing
// here hardcodes a rate; the caller passes cents and this file moves them.
//
// Env by NAME only: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, URL.

const API = 'https://api.stripe.com/v1';

function key() {
  const k = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!k) throw new Error('STRIPE_SECRET_KEY is not set, so no money can move');
  return k;
}

/** Stripe wants form encoding, including for nested keys like transfer_data[destination]. */
function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const name = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) form(v, name, out);
    else out.append(name, String(v));
  }
  return out;
}

async function stripe(path, { method = 'POST', body, idempotencyKey } = {}) {
  const headers = {
    Authorization: 'Bearer ' + key(),
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  // Money moves are retried by every layer of the internet. An idempotency key is what stops a
  // retry becoming a second charge.
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const r = await fetch(API + path, {
    method,
    headers,
    body: body ? form(body).toString() : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(`stripe ${r.status}: ${String((j.error && j.error.message) || '').slice(0, 200)}`);
    e.status = r.status;
    e.code = j.error && j.error.code;
    throw e;
  }
  return j;
}

/**
 * A payout destination for the party RECEIVING the money. Express accounts keep the identity
 * checks with Stripe, which is the only sane place for them: we never see a bank number.
 */
export async function createPayeeAccount({ email, dealId }) {
  return stripe('/accounts', {
    body: {
      type: 'express',
      email: email || undefined,
      capabilities: { transfers: { requested: 'true' } },
      business_type: 'individual',
      metadata: { product: 'parley', deal_id: dealId || '' },
    },
    idempotencyKey: dealId ? `parley-acct-${dealId}` : undefined,
  });
}

/** The link the payee follows to finish identity checks with Stripe. Short lived by design. */
export async function onboardingLink({ accountId, dealId }) {
  const site = process.env.URL || 'https://answered.reddenda.com';
  return stripe('/account_links', {
    body: {
      account: accountId,
      type: 'account_onboarding',
      refresh_url: `${site}/truce/payout/refresh?deal=${encodeURIComponent(dealId || '')}`,
      return_url: `${site}/truce/payout/done?deal=${encodeURIComponent(dealId || '')}`,
    },
  });
}

/** Can this account actually receive money yet? Asked of Stripe, never assumed from onboarding. */
export async function payeeReady(accountId) {
  const a = await stripe('/accounts/' + encodeURIComponent(accountId), { method: 'GET' });
  return {
    ready: Boolean(a.payouts_enabled && a.charges_enabled),
    payouts_enabled: !!a.payouts_enabled,
    charges_enabled: !!a.charges_enabled,
    needs: (a.requirements && a.requirements.currently_due) || [],
  };
}

/**
 * THE CHARGE. The payer pays `amountCents`; `feeCents` is separated to us; the remainder lands in
 * the payee's connected account. One movement.
 */
export async function checkoutForSettlement({ payoutId, dealId, subject, amountCents, feeCents, payeeAccount, payerEmail }) {
  const site = process.env.URL || 'https://answered.reddenda.com';
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('amount must be positive cents');
  if (!Number.isInteger(feeCents) || feeCents < 0 || feeCents >= amountCents) throw new Error('fee must be smaller than the amount');
  if (!payeeAccount) throw new Error('there is nowhere to send the money yet');

  return stripe('/checkout/sessions', {
    body: {
      mode: 'payment',
      customer_email: payerEmail || undefined,
      // The metadata is how a webhook finds its way back to the deal. Without it a payment is an
      // orphan, which is the defect that already cost this estate a billing panel.
      metadata: { product: 'parley', deal_id: dealId, payout_id: payoutId },
      payment_intent_data: {
        application_fee_amount: feeCents,
        transfer_data: { destination: payeeAccount },
        metadata: { product: 'parley', deal_id: dealId, payout_id: payoutId },
        description: `Parley settlement: ${String(subject || '').slice(0, 120)}`,
      },
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: amountCents,
          product_data: { name: String(subject || 'Settled amount').slice(0, 120) },
        },
      }],
      success_url: `${site}/truce/paid?deal=${encodeURIComponent(dealId)}`,
      cancel_url: `${site}/truce/${''}`.replace(/\/$/, '') + `/paycancel?deal=${encodeURIComponent(dealId)}`,
    },
    idempotencyKey: `parley-checkout-${payoutId}`,
  });
}

/**
 * ★ THE SIGNATURE CHECK. A webhook is the only thing allowed to write `succeeded`, so it is also
 * the only thing worth forging. Verified with a constant-time compare over Stripe's scheme, and it
 * FAILS CLOSED: no secret configured means no event is trusted, ever.
 */
export async function verifyWebhook(rawBody, signatureHeader, { toleranceSec = 300 } = {}) {
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!secret) return { ok: false, reason: 'STRIPE_WEBHOOK_SECRET is not set, so no event can be trusted' };
  if (!signatureHeader) return { ok: false, reason: 'no signature header' };

  const parts = Object.fromEntries(
    String(signatureHeader).split(',').map((p) => p.split('=').map((s) => s.trim())),
  );
  const t = parts.t;
  const given = parts.v1;
  if (!t || !given) return { ok: false, reason: 'malformed signature header' };

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(t));
  if (!Number.isFinite(age) || age > toleranceSec) return { ok: false, reason: 'signature timestamp outside tolerance' };

  const crypto = await import('node:crypto');
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(given));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'signature does not match' };

  try {
    return { ok: true, event: JSON.parse(rawBody) };
  } catch (e) {
    return { ok: false, reason: 'signed body is not json' };
  }
}

export const stripeCall = stripe;
