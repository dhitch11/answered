// /api/billing — the money layer. Stripe, on the live estate account, with the dangerous half
// disarmed by default.
//
// THE SHAPE OF THE CHARGE, AND WHY IT IS THIS SHAPE. The published price book is "$0 base, pay for
// outcomes, capped". There is therefore NO subscription object anywhere in this file, and there
// never should be: a Stripe subscription would be a recurring charge, and this company has told
// every visitor there is not one. Instead:
//
//   1. The owner saves a card through a setup-mode Checkout Session. Nothing is charged. That is
//      what "$0 base" looks like in an API call.
//   2. Every outcome lands on the ledger through /api/meter, rated from /terms, capped, voidable.
//   3. At the end of a cycle, the open lines become invoice items on ONE draft invoice, and the
//      draft is left as a draft. A human confirms, and only then is it finalized and charged.
//
// Step 3 stops at the draft unless ANSWERED_BILLING_ARMED=1 AND the caller passes confirm:true.
// Two independent switches, because this key is live and a mistake here is somebody's money.

import crypto from 'node:crypto';
import {
  context, openLines, mark, unmark, setCustomer, setCard, saveInvoice, statement, usd, dbConfigured,
} from './lib/ledger.mjs';
import * as stripe from './lib/stripe-rest.mjs';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
};
const ok = (d) => ({ statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(d) });
const bad = (c, m, extra = {}) => ({ statusCode: c, headers: JSON_HEADERS, body: JSON.stringify({ error: m, ...extra }) });

const SECRET = () => (process.env.ANSWERED_METER_SECRET || '').trim();
const site = () => process.env.URL || 'https://answered.reddenda.com';

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

const rawBody = (event) => (event.isBase64Encoded
  ? Buffer.from(event.body || '', 'base64').toString('utf8')
  : (event.body || ''));

/**
 * The account's Stripe customer, created once and remembered.
 *
 * ★ A REMEMBERED ID IS NOT A LIVING ONE. This used to return ctx.stripe_customer_id on sight, and
 * the moment a customer was deleted on the Stripe side, every op on that account died with an
 * unhelpful 500: "No such customer". Reproduced here after a QA cleanup deleted the customer while
 * the ledger kept the id. A billing system that cannot survive somebody tidying the Stripe
 * dashboard is a billing system that will be down on the day somebody tidies the Stripe dashboard.
 *
 * ★ AND THE REPLACEMENT NEEDS A NEW IDEMPOTENCY KEY. Stripe replays a stored response for 24 hours
 * against the same key, so recreating under `answered-customer-${key}` would hand back the very
 * dead customer we are replacing. The key carries the reason it is being reissued.
 */
async function ensureCustomer(key, ctx) {
  if (ctx.stripe_customer_id) {
    try {
      const existing = await stripe.getCustomer(ctx.stripe_customer_id);
      if (existing && !existing.deleted) return existing.id;
    } catch (e) {
      if (e.status !== 404) throw e;      // a network blip is not a missing customer
    }
    console.error(`billing: stripe customer ${ctx.stripe_customer_id} for ${key} is gone, reissuing`);
  }
  const s = await statement(key);
  const c = await stripe.createCustomer({
    account_key: key,
    business_name: s?.account?.business_name || key,
    email: s?.account?.email,
    phone: s?.account?.phone,
  }, `answered-customer-${key}-${ctx.stripe_customer_id ? `reissue-${Date.now()}` : 'first'}`);
  await setCustomer(key, c.id);
  return c.id;
}

/**
 * One draft per account per cycle, found before it is created.
 *
 * A close is a RE-RUNNABLE operation whose parameters legitimately change between runs: a line got
 * voided, a new outcome landed, the customer was reissued. So it cannot be protected by a fixed
 * idempotency key, which is what "answered-invoice-{key}-{cycle}" was. Stripe rejected the second
 * close outright with a parameter-mismatch 400, and the cycle became permanently unclosable for 24
 * hours. Stripe is the authority on what exists in Stripe, so ask it, then fall back to creating
 * one under a key that includes every parameter that can vary.
 */
async function findOrCreateDraft(customerId, key, cycle) {
  const list = await stripe.listInvoices({ customer: customerId, status: 'draft', limit: 20 });
  const existing = (list.data || []).find((i) => i.metadata?.answered_cycle === cycle
    && i.metadata?.answered_account_key === key);
  if (existing) return existing;
  return stripe.createDraftInvoice(customerId, {
    description: `Answered, outcomes for ${cycle}. Every line is an outcome you can see on your statement.`,
    metadata: { answered_account_key: key, answered_cycle: cycle },
  }, `answered-invoice-${key}-${cycle}-${customerId}`);
}

// ── the webhook ──────────────────────────────────────────────────────────────────────────────────
async function webhook(event) {
  const raw = rawBody(event);
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  const v = await stripe.verifyWebhook(raw, sig, (process.env.STRIPE_WEBHOOK_SECRET || '').trim());
  // An unverified webhook is refused, never processed "just in case". This endpoint writes to a
  // billing ledger; an open door here is an open door onto somebody's bill.
  if (!v.ok) return bad(400, `webhook refused: ${v.reason}`);

  const e = v.event;
  const obj = e?.data?.object || {};
  try {
    switch (e.type) {
      case 'checkout.session.completed': {
        if (obj.mode !== 'setup') break;
        const si = obj.setup_intent ? await stripe.getSetupIntent(obj.setup_intent) : null;
        const pmId = si?.payment_method;
        if (!pmId || !obj.customer) break;
        const pm = await stripe.getPaymentMethod(pmId);
        await stripe.setDefaultPaymentMethod(obj.customer, pmId);
        // card_on_file is set HERE and nowhere else: only a completed setup intent proves a card
        // exists. The page that opened checkout must never set it, because opening checkout is not
        // finishing it, and a bill that thinks it can charge a card that was never saved fails at
        // the worst possible moment.
        await setCard(obj.customer, pm.card?.brand || null, pm.card?.last4 || null, true);
        break;
      }
      case 'invoice.paid': {
        const key = obj.metadata?.answered_account_key;
        const cycle = obj.metadata?.answered_cycle;
        if (key && cycle) {
          await saveInvoice(key, cycle, {
            stripe_invoice_id: obj.id, status: 'paid', total_cents: obj.amount_paid,
            hosted_url: obj.hosted_invoice_url, paid_at: new Date().toISOString(),
          });
          const lines = await openLines(key, cycle);
          if (Array.isArray(lines) && lines.length) await mark(lines.map((l) => l.id), 'paid', obj.id);
        }
        break;
      }
      case 'invoice.payment_failed': {
        const key = obj.metadata?.answered_account_key;
        const cycle = obj.metadata?.answered_cycle;
        if (key && cycle) {
          await saveInvoice(key, cycle, {
            stripe_invoice_id: obj.id, status: 'payment_failed',
            total_cents: obj.amount_due, hosted_url: obj.hosted_invoice_url,
          });
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error('webhook handling failed:', e.type, String(err.message).slice(0, 200));
    // 200 on a handling failure would tell Stripe to stop retrying a thing that did not happen.
    return bad(500, 'webhook handling failed');
  }
  return ok({ received: true, type: e.type });
}

export const handler = async (event) => {
  const path = event.path || '';

  if (path.endsWith('/webhook')) {
    if (event.httpMethod !== 'POST') return bad(405, 'POST only');
    return webhook(event);
  }

  if (event.httpMethod !== 'POST') return bad(405, 'POST only');
  if (!SECRET()) return bad(503, 'billing is not configured on this deploy: ANSWERED_METER_SECRET is unset');
  if (!authed(event.headers || {})) return bad(401, 'unauthorized');
  if (!stripe.stripeConfigured()) return bad(503, 'STRIPE_SECRET_KEY is not set');
  if (!dbConfigured()) return bad(503, 'the ledger is not configured');

  let body;
  try { body = JSON.parse(rawBody(event) || '{}'); } catch { return bad(400, 'bad json'); }
  const op = String(body.op || '');
  const key = String(body.account_key || '').trim().toLowerCase();

  try {
    switch (op) {
      // What is actually true about this deploy's ability to charge. No guessing on any surface.
      case 'status': {
        const acct = await stripe.account();
        return ok({
          stripe: {
            account: acct.id,
            business: acct.business_profile?.name || null,
            live_mode: stripe.stripeLiveMode(),
            charges_enabled: acct.charges_enabled,
            payouts_enabled: acct.payouts_enabled,
          },
          armed: stripe.billingArmed(),
          webhook_secret_set: Boolean((process.env.STRIPE_WEBHOOK_SECRET || '').trim()),
          can_charge_today: stripe.billingArmed() && acct.charges_enabled,
          note: stripe.billingArmed()
            ? 'ARMED. Finalizing a cycle on this deploy charges a real card on a live account.'
            : 'Disarmed. Cycles can be drafted and totalled, and nothing can be charged, until ANSWERED_BILLING_ARMED=1.',
        });
      }

      // The one link an owner needs to become chargeable. Saves a card, charges nothing.
      case 'card_link': {
        if (!key) return bad(400, 'card_link needs an account_key');
        const ctx = await context(key);
        if (!ctx || ctx.error) return bad(404, ctx?.error || 'unknown account');
        const customer = await ensureCustomer(key, ctx);
        const session = await stripe.createSetupCheckout(customer, {
          accountKey: key,
          successUrl: `${site()}/statement/${ctx.statement_token}`,
          cancelUrl: `${site()}/pricing`,
        }, `answered-setup-${key}-${Date.now()}`);
        return ok({
          url: session.url, session: session.id, customer,
          charges_nothing: session.mode === 'setup',
          note: 'This is a setup session. It saves a card and charges $0, which is what the published base price is.',
        });
      }

      // Turn a cycle's open lines into ONE draft invoice. Stops at the draft on purpose.
      case 'close': {
        if (!key) return bad(400, 'close needs an account_key');
        const cycle = String(body.cycle || '').trim() || new Date().toISOString().slice(0, 8) + '01';

        // ★ THE ARMING CHECK COMES FIRST, BEFORE ANY WORK. It used to sit at the bottom, after the
        // draft was built, which meant a close with nothing left to invoice returned the cheerful
        // "nothing chargeable" 200 and never reached the disarm at all. A caller asking to charge
        // money on a disarmed deploy must be told no by the FIRST thing that reads the request,
        // not by the last, or the refusal depends on the state of the ledger rather than on the
        // state of the switch.
        if (body.confirm && !stripe.billingArmed()) {
          return bad(409, 'confirm:true was passed but this deploy is disarmed. Nothing was drafted and nothing was charged. Set ANSWERED_BILLING_ARMED=1 to allow a charge.', { charged: false });
        }

        const ctx = await context(key);
        if (!ctx || ctx.error) return bad(404, ctx?.error || 'unknown account');

        const lines = await openLines(key, cycle);
        if (!Array.isArray(lines) || !lines.length) {
          return ok({ cycle, lines: 0, total_cents: 0, total: usd(0), invoice: null,
            note: 'Nothing chargeable in this cycle, so no invoice exists. That is a normal month here, not an error.' });
        }
        const total = lines.reduce((n, l) => n + l.cents, 0);
        const customer = await ensureCustomer(key, ctx);

        const draft = await findOrCreateDraft(customer, key, cycle);

        const items = [];
        for (const l of lines) {
          // The idempotency key pairs the LEDGER EVENT ID with the invoice it is going onto. The
          // event id alone was wrong: Stripe replays a stored response for 24 hours against the
          // same key ONLY when the parameters match, and a rebuilt draft has a different invoice
          // id, so the second close died with a parameter-mismatch 400 instead of adding the line.
          // Pairing them keeps the real guarantee, which is that one close cannot add the same
          // outcome to the same invoice twice, while letting a rebuilt draft be filled at all.
          const item = await stripe.createInvoiceItem(customer, {
            amountCents: l.cents,
            description: `${l.label} — ${new Date(l.occurred_at).toISOString().slice(0, 10)}`,
            invoiceId: draft.id,
            metadata: { answered_event_id: l.id, answered_account_key: key },
          }, `answered-item-${l.id}-${draft.id}`);
          items.push(item.id);
        }
        await mark(lines.map((l) => l.id), 'invoiced', draft.id);
        const fresh = await stripe.getInvoice(draft.id);
        await saveInvoice(key, cycle, {
          stripe_invoice_id: draft.id, status: 'draft', total_cents: fresh.amount_due,
          hosted_url: fresh.hosted_invoice_url || null,
        });

        if (!body.confirm) {
          return ok({
            cycle, lines: lines.length, total_cents: total, total: usd(total),
            invoice: draft.id, invoice_total_cents: fresh.amount_due, items: items.length,
            charged: false,
            note: 'Drafted, not charged. Nobody has been billed. Send confirm:true, with ANSWERED_BILLING_ARMED=1, to finalize and charge.',
          });
        }
        if (!ctx.card_on_file) {
          return bad(409, 'no card is on file for this account, so nothing can be charged. The draft invoice is saved.',
            { invoice: draft.id, total: usd(total), charged: false });
        }

        const finalized = await stripe.finalizeInvoice(draft.id, `answered-finalize-${key}-${cycle}`);
        const paid = await stripe.payInvoice(finalized.id, `answered-pay-${key}-${cycle}`);
        await saveInvoice(key, cycle, {
          stripe_invoice_id: paid.id, status: paid.status, total_cents: paid.amount_paid,
          hosted_url: paid.hosted_invoice_url, finalized_at: new Date().toISOString(),
          paid_at: paid.status === 'paid' ? new Date().toISOString() : null,
        });
        if (paid.status === 'paid') await mark(lines.map((l) => l.id), 'paid', paid.id);
        return ok({
          cycle, lines: lines.length, total_cents: paid.amount_paid, total: usd(paid.amount_paid),
          invoice: paid.id, status: paid.status, charged: paid.status === 'paid',
          receipt: paid.hosted_invoice_url || null,
        });
      }

      // Throw away a draft that should not exist. Refuses anything already finalized, because a
      // finalized invoice is a document a customer may already be holding.
      case 'discard_draft': {
        const id = String(body.invoice || '');
        if (!id.startsWith('in_')) return bad(400, 'discard_draft needs a stripe invoice id');
        const inv = await stripe.getInvoice(id);
        if (inv.status !== 'draft') return bad(409, `that invoice is ${inv.status}, not a draft, so it is not mine to delete`);
        await stripe.deleteDraftInvoice(id);
        // ★ THE LEDGER MUST GET ITS LINES BACK, or this is a one-way door. `close` moved every one
        // of those outcomes to 'invoiced'; deleting the draft in Stripe without reopening them
        // would leave them pointing at an invoice that no longer exists, skipped by every future
        // close, and the customer would never be billed for work that really happened.
        const reopened = await unmark(id);
        return ok({ deleted: id, reopened_lines: reopened,
          note: 'The draft is gone and its lines are back to open, so the next close picks them up again.' });
      }

      default:
        return bad(400, `unknown op "${op}"`, { ops: ['status', 'card_link', 'close', 'discard_draft'] });
    }
  } catch (e) {
    if (e.disarmed) return bad(409, e.message, { charged: false });
    console.error(`billing ${op} failed:`, String(e.message).slice(0, 300));
    return bad(500, String(e.message).slice(0, 220));
  }
};
