// /api/parley-webhook — Stripe's own account of what happened, and the ONLY thing in this system
// permitted to record that money moved.
//
// WHY IT IS BUILT THIS WAY. A browser arriving at a success page proves a browser arrived. It does
// not prove a card cleared, and it is trivially forged by typing the URL. So the success page tells
// the customer something reassuring and writes NOTHING, and this endpoint, which the customer never
// sees and cannot reach without Stripe's signing secret, is what moves a payout to `succeeded`.
//
// It fails CLOSED in every direction: no signing secret, no trust; bad signature, 400 and nothing
// written; unknown payment intent, recorded as a miss rather than guessed at.
//
// Env by NAME only: STRIPE_WEBHOOK_SECRET, and the database credentials by way of lib/db.mjs.

import { rpc } from './lib/db.mjs';
import { verifyWebhook } from './lib/parley-money.mjs';

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: JSON_HEADERS });

export default async (req) => {
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });

  // The RAW body, byte for byte. Parsing first and re-serialising would change the bytes and every
  // signature would fail for a reason that looks like an attack.
  const raw = await req.text();
  const sig = req.headers.get('stripe-signature');

  const v = await verifyWebhook(raw, sig);
  if (!v.ok) {
    console.error('parley-webhook REFUSED:', v.reason);
    return reply(400, { error: 'signature', reason: v.reason });
  }

  const event = v.event;
  const obj = (event.data && event.data.object) || {};
  const meta = obj.metadata || {};

  try {
    switch (event.type) {
      // The money cleared. This is the fact everything else is downstream of.
      case 'payment_intent.succeeded': {
        const r = await rpc('tr_payout_settle', {
          p_intent: obj.id,
          p_status: 'succeeded',
          p_fee_id: obj.application_fee_amount ? String(obj.application_fee_amount) : null,
          p_evidence: {
            event_id: event.id,
            type: event.type,
            amount_received: obj.amount_received,
            application_fee_amount: obj.application_fee_amount,
            currency: obj.currency,
            livemode: event.livemode,
            deal_id: meta.deal_id || null,
          },
        });
        if (!r || r.ok !== true) {
          // A payment we cannot attribute is worse than no payment: it is money in the account with
          // nothing to point it at. Say so loudly rather than returning a cheerful 200.
          console.error(`parley-webhook: payment ${obj.id} succeeded and could NOT be attributed to a payout (${(r && r.reason) || 'unknown'}).`);
        }
        break;
      }

      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled': {
        await rpc('tr_payout_settle', {
          p_intent: obj.id,
          p_status: event.type.endsWith('canceled') ? 'cancelled' : 'failed',
          p_fee_id: null,
          p_evidence: {
            event_id: event.id,
            type: event.type,
            reason: (obj.last_payment_error && obj.last_payment_error.message) || 'no reason given',
            livemode: event.livemode,
          },
        });
        break;
      }

      case 'charge.refunded': {
        if (obj.payment_intent) {
          await rpc('tr_payout_settle', {
            p_intent: obj.payment_intent,
            p_status: 'refunded',
            p_fee_id: null,
            p_evidence: { event_id: event.id, type: event.type, amount_refunded: obj.amount_refunded },
          });
        }
        break;
      }

      default:
        // Everything else is acknowledged and ignored on purpose. Stripe retries anything we do not
        // 200, and retrying an event we will never act on is noise for both sides.
        break;
    }
  } catch (e) {
    // A 500 makes Stripe retry, which is what we want when OUR side broke.
    console.error('parley-webhook: handling failed:', String(e && e.message).slice(0, 200));
    return reply(500, { error: 'could not record that event' });
  }

  return reply(200, { received: true });
};

export const config = { path: '/api/parley-webhook' };
