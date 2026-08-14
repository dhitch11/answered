// lib/provider-down.mjs — stop hammering a provider that is down.
//
// WHY THIS EXISTS (2026-08-14). The Twilio account ran out of credits. Twilio
// answers a suspended account with exactly the same 401 (`20003 Authenticate`)
// it uses for a bad key, so every probe we own read it as a credential fault
// and simply tried again on its next tick:
//
//   demo-health   two Lookups per uncached invocation, 60s cache
//                 -> up to ~2,880 requests a day against a suspended account
//   canary        a real call attempt every two hours
//
// That is a retry storm aimed at an account with a payment problem, which is
// the one thing that can make a payment problem worse. David's instruction was
// explicit: stop testing against live Twilio, and do not drop the capability.
//
// So this is a BACKOFF, not a feature flag and not a deletion. The rule the
// estate agreed today: a capability behind a named, temporary gate is a real
// capability; a capability you deleted is gone. The moment the account is
// funded, the first probe past the window succeeds, the marker is cleared, and
// everything turns itself back on with no deploy and nobody having to remember.
//
// It is deliberately NOT a circuit breaker on error rate. It fires only on the
// signals that mean "this provider will not serve us until a human acts", so a
// transient network blip still retries normally.

const STORE = 'provider-state';
const WINDOW_MS = 30 * 60 * 1000; // 30 minutes: long enough to stop a storm, short enough to notice recovery

async function store(event) {
  const blobs = await import('@netlify/blobs');
  if (typeof blobs.connectLambda === 'function') {
    try { blobs.connectLambda(event); } catch (e) { /* the read is the verdict */ }
  }
  return blobs.getStore(STORE);
}

/**
 * True when the named provider answered with "not until a human acts" recently.
 * Fails OPEN (returns false) if the marker cannot be read: a probe that cannot
 * check its own backoff should still run, because being unable to read a
 * counter is not evidence that a provider is down.
 */
export async function isDown(name, event) {
  try {
    const s = await store(event);
    const row = await s.get('down/' + name, { type: 'json' });
    if (!row || !row.at) return false;
    const age = Date.now() - Date.parse(row.at);
    if (!Number.isFinite(age) || age > WINDOW_MS) return false;
    return { since: row.at, reason: row.reason, minutes: Math.round(age / 60000) };
  } catch (e) {
    return false;
  }
}

/**
 * Record that a provider is refusing everything. Call this ONLY for signals
 * that a retry cannot fix: an auth refusal, a suspension, a hard quota stop.
 * Never for a timeout or a 5xx, which are worth retrying.
 */
export async function markDown(name, reason, event) {
  try {
    const s = await store(event);
    await s.setJSON('down/' + name, { at: new Date().toISOString(), reason: String(reason || '').slice(0, 200) });
  } catch (e) {
    console.error('provider-down: could not record backoff for ' + name + ':', String(e && e.message).slice(0, 120));
  }
}

/** Clear the marker the moment the provider serves us again. */
export async function markUp(name, event) {
  try {
    const s = await store(event);
    await s.delete('down/' + name);
  } catch (e) { /* a stale marker expires on its own within the window */ }
}

/**
 * The signals that mean "stop asking". Twilio returns 20003 for a suspended
 * account AND for a bad key, so we treat both the same way: back off and say
 * so honestly, rather than guessing which one it is on the customer's behalf.
 */
export function isHardRefusal(status, body) {
  if (status === 401 || status === 403) return true;
  const t = String(body || '');
  return /\b20003\b|\b20005\b|\b70051\b|suspended|not authorized/i.test(t);
}

export const BACKOFF_WINDOW_MS = WINDOW_MS;
