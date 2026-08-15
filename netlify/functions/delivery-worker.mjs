// delivery-worker — drains the delivery queue. Scheduled, never in front of a caller.
//
// ── WHY THIS IS A SEPARATE FUNCTION AND NOT A FETCH INSIDE THE BOOKING ───────────────────────
//
// `booking.mjs` fans out five deliveries in an AWAITED Promise.all. That is correct for the
// customer email and the CRM log: those must be attempted while the request is alive, and their
// failure must never fail a booking that already happened.
//
// It is wrong for a webhook or a connector, for two separate reasons:
//
//   LATENCY. The booking response cannot finish before the slowest receiver answers. A customer's
//   endpoint having a bad afternoon becomes our booking being slow, which is a failure mode that
//   only ever shows up on someone else's bad day.
//
//   DURABILITY. A best-effort second write moves the failure from the request to nowhere. Marking a
//   connector write "non-fatal" means every vendor outage is invisible data loss under a green 201.
//
// So the intent is written into `delivery_queue` inside `sv_job_create`'s transaction, and this
// worker delivers it afterwards, retrying with backoff, carrying the SAME idempotency key on every
// attempt for the rest of time.
//
// ── WHAT THIS FUNCTION REFUSES TO DO ─────────────────────────────────────────────────────────
//
// 1. Invent an idempotency key. The key is on the row, minted before the first attempt. A key
//    generated in a retry loop is how a second van gets dispatched to the same address.
// 2. Send over http. The payload carries a customer's name, address and phone number.
// 3. Send unsigned. A receiver that cannot verify us cannot trust us.
// 4. Retry forever. After the attempt cap a row goes to `dead`, which is a state a human is meant
//    to look at, not one the system quietly recovers from. A queue that retries a permanently dead
//    endpoint forever is a queue that hides a permanently dead endpoint.

import { rpc } from './lib/db.mjs';
import { signWebhook, WEBHOOK_SIG_HEADER } from './lib/outbox.mjs';
import { pushJob } from './lib/jobber.mjs';

// ★ NO `path`. THIS IS DELIBERATE AND IT IS A SECURITY DECISION, NOT AN OMISSION.
//
// The first version declared a drain route, which would have made an anonymous
// endpoint that drains the queue and fires signed webhooks at a customer's endpoint on demand. It
// leaks nothing — the payload goes to OUR configured receiver with OUR signature — but it hands a
// stranger a button that burns retry attempts and can push a struggling receiver over its own rate
// limit. A scheduled function does not need a route to run, so the honest configuration is the one
// with no door in it.
//
// A schedule alone is enough. If a human ever needs to force a drain, it goes through /admin behind
// the session gate, not through an open path.
//
// ★ AND THE COMMENT ITSELF NO LONGER QUOTES A ROUTE, WHICH IS NOT PEDANTRY.
// The removed path used to be spelled out here, and _stage.sh's drift guard grepped this file,
// read the EXPLANATION as a live declaration, and refused every deploy on the estate until someone
// traced it. The guard now strips line comments, which is the right fix. This is the second one:
// a path-shaped literal in a comment is a trap for whatever greps next, and nothing is lost by
// describing the route instead of quoting it.
//
// The object is a LITERAL because Netlify reads this by static analysis at bundle time and silently
// drops a computed value; this repo has a function that shipped `path: routeTable()` and registered
// no routes at all.
export const config = {
  schedule: '*/2 * * * *',
};

const MAX_ATTEMPTS = 8;
const PER_RUN = 10;
const TIMEOUT_MS = 8000;

/**
 * Resolve a symbolic target to a real endpoint at DELIVERY time.
 *
 * The queue row stores `webhook:default`, not a URL. Two reasons: an endpoint that changes must not
 * require rewriting queue rows, and a customer's endpoint does not belong in the database next to
 * nothing that can sign it. The secret never leaves the runtime.
 */
function resolveTarget(target) {
  if (target === 'webhook:default') {
    const url = String(process.env.ANSWERED_WEBHOOK_URL || '').trim();
    const secret = String(process.env.ANSWERED_WEBHOOK_SECRET || '').trim();
    if (!url) return { skip: true, why: 'ANSWERED_WEBHOOK_URL is not set on this deploy, so there is nowhere to deliver' };
    if (!secret) return { fail: true, why: 'ANSWERED_WEBHOOK_URL is set but ANSWERED_WEBHOOK_SECRET is not, and an unsigned webhook cannot be trusted by its receiver' };
    let parsed;
    try { parsed = new URL(url); } catch { return { fail: true, why: 'ANSWERED_WEBHOOK_URL is not a URL' }; }
    if (parsed.protocol !== 'https:') {
      return { fail: true, why: 'the webhook URL is not https, and this payload carries a customer name, address and phone number' };
    }
    return { url, secret };
  }

  // ── connectors ──────────────────────────────────────────────────────────────────────────────
  // `jobber:<account uuid>`. The account id is on the target rather than looked up from the row so
  // that a delivery is self-describing: reading the queue tells you where it is going without
  // joining anything, and a row cannot be redirected by a later edit to another table.
  if (target.startsWith('jobber:')) {
    const accountId = target.slice('jobber:'.length);
    if (!accountId) return { fail: true, why: 'a jobber target with no account id' };
    return { connector: 'jobber', accountId };
  }

  return { fail: true, why: `no resolver for target "${target}"` };
}

/**
 * A connector delivery. The vendor call is the connector's problem; this function's job is to turn
 * its verdict into the same three outcomes a webhook produces, so the caller below needs no special
 * case and the queue's state machine stays one machine.
 *
 * ★ `unknown:true` FROM THE CONNECTOR IS STILL A FAILURE HERE, ON PURPOSE. A timeout means the
 * vendor may have created the record, so it must be retried, and the retry is safe because the
 * connector reads `external_links` before every write. Treating an unknown as a success to avoid a
 * duplicate would be choosing silent data loss over a duplicate the idempotency layer already
 * prevents.
 */
async function deliverConnector(row, t) {
  if (t.connector !== 'jobber') return { ok: false, status: 0, body: '', error: `no connector named "${t.connector}"` };

  let r;
  try {
    r = await pushJob(row.payload || {}, t.accountId);
  } catch (e) {
    return { ok: false, status: 0, body: '', error: String((e && e.message) || e).slice(0, 300) };
  }

  if (r.ok) {
    return {
      ok: true, status: 200,
      // What actually happened, in the row, so a human reading the delivery log can tell a fresh
      // write from a replay of one that already existed.
      body: JSON.stringify({ request_id: r.request_id, client_id: r.client_id, property_id: r.property_id, reused: Boolean(r.reused) }),
      error: null,
    };
  }

  // ── PARKED vs FAILED, and the difference matters ────────────────────────────────────────────
  //
  // A connection that is revoked, expired, pending or never made will not become connected by
  // retrying. Burning eight attempts on "the customer has not reconnected Jobber yet" marks a
  // perfectly good job DEAD for a reason that has nothing to do with the job, and the customer who
  // reconnects tomorrow never receives it.
  //
  // ★ SO IT IS REQUEUED WITHOUT BURNING AN ATTEMPT — BUT IT IS NAMED, NOT HIDDEN. A queue that
  // silently requeues forever is the anti-pattern this file's own header warns about. The reason is
  // written to the row where the delivery log renders it, the count comes back in this function's
  // return, and the log line says how many are parked and why. A parked delivery is a customer
  // action item, and it is supposed to be readable as one.
  const why = String(r.reason || '');
  if (/has not connected|reconnect|revoked|is pending|is error|is expired|no tokens/i.test(why)) {
    return { parked: true, why };
  }

  return { ok: false, status: 0, body: '', error: (why || 'the connector failed without saying why').slice(0, 300) };
}

async function deliver(row) {
  const t = resolveTarget(row.target);
  // A connector target that failed to resolve carries `fail`, not `connector`, so it falls through
  // to the shared skip/fail handling below rather than being special-cased twice.
  if (t.connector) return deliverConnector(row, t);

  // Nowhere to send is NOT a failure of this delivery. Counting it as one would burn the attempt
  // budget and mark a perfectly good row dead because an env var is unset.
  if (t.skip) return { skipped: true, why: t.why };
  if (t.fail) return { ok: false, status: 0, body: '', error: t.why };

  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    event: row.event,
    sent_at: new Date().toISOString(),
    // The receiver deduplicates on this. It is the same value on attempt one and attempt eight.
    idempotency_key: row.idempotency_key,
    attempt: row.attempts,
    data: row.payload,
  });

  try {
    const r = await fetch(t.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Answered-Webhooks/1.0',
        'X-Answered-Event': row.event,
        // Belt and braces: the key is in the body AND the header, so a receiver can deduplicate
        // before parsing.
        'X-Answered-Idempotency-Key': row.idempotency_key,
        [WEBHOOK_SIG_HEADER]: signWebhook(t.secret, ts, body),
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = (await r.text().catch(() => '')).slice(0, 2000);
    return { ok: r.ok, status: r.status, body: text, error: r.ok ? null : `receiver returned ${r.status}` };
  } catch (e) {
    // ★ A TIMEOUT IS NOT A FAILED DELIVERY, IT IS AN UNKNOWN ONE. The receiver may well have
    // created the record. This is why retrying is only safe with a stable key: we retry knowing we
    // may be sending a second time, and the key is what makes that harmless.
    return { ok: false, status: 0, body: '', error: String((e && e.message) || e).slice(0, 300) };
  }
}

export default async function handler(req) {
  const started = Date.now();
  let claimed = [];
  try {
    const c = await rpc('sv_delivery_claim', { p_limit: PER_RUN, p_lease_seconds: 120 });
    claimed = (c && c.rows) || [];
  } catch (e) {
    console.error('delivery-worker: could not claim:', e && e.message);
    return Response.json({ ok: false, error: 'claim failed', detail: String(e && e.message).slice(0, 200) }, { status: 500 });
  }

  const out = { claimed: claimed.length, delivered: 0, failed: 0, skipped: 0, parked: 0, dead: 0 };
  const parkedWhy = new Map();

  for (const row of claimed) {
    const r = await deliver(row);

    // Parked: waiting on the CUSTOMER, not on us. Requeued without burning an attempt, exactly like
    // a skip, but counted and named separately so "nothing is configured" never reads the same as
    // "three customers need to reconnect Jobber".
    if (r.parked) {
      out.parked++;
      parkedWhy.set(r.why, (parkedWhy.get(r.why) || 0) + 1);
      await rpc('sv_delivery_failed', {
        p_id: row.id, p_status: 0, p_body: '', p_error: r.why, p_max_attempts: 10_000,
      }).catch((e) => console.error('delivery-worker: could not requeue a parked row:', e && e.message));
      continue;
    }

    if (r.skipped) {
      out.skipped++;
      // Push it back to pending without burning an attempt: nothing was wrong with the delivery.
      await rpc('sv_delivery_failed', {
        p_id: row.id, p_status: 0, p_body: '', p_error: r.why, p_max_attempts: 10_000,
      }).catch((e) => console.error('delivery-worker: could not requeue a skipped row:', e && e.message));
      continue;
    }

    if (r.ok) {
      out.delivered++;
      await rpc('sv_delivery_delivered', { p_id: row.id, p_status: r.status, p_body: r.body })
        .catch((e) => console.error('delivery-worker: delivered but could not record it:', e && e.message));
    } else {
      out.failed++;
      const res = await rpc('sv_delivery_failed', {
        p_id: row.id, p_status: r.status, p_body: r.body, p_error: r.error, p_max_attempts: MAX_ATTEMPTS,
      }).catch((e) => { console.error('delivery-worker: could not record a failure:', e && e.message); return null; });
      if (res && res.state === 'dead') {
        out.dead++;
        // Loud, because a dead delivery is a customer's CRM missing a job it should have.
        console.error(`delivery-worker: delivery ${row.id} (${row.event} ${row.idempotency_key}) is DEAD after ${MAX_ATTEMPTS} attempts: ${r.error}`);
      }
    }
  }

  out.ms = Date.now() - started;
  if (out.claimed) console.log('delivery-worker:', JSON.stringify(out));

  // Named, every run, because a parked delivery is a customer who has to do something and nobody
  // finds that out by reading a counter.
  for (const [why, n] of parkedWhy) {
    console.log(`delivery-worker: ${n} ${n === 1 ? 'delivery is' : 'deliveries are'} PARKED, waiting on the customer: ${why}`);
  }
  return Response.json({ ok: true, ...out });
}
