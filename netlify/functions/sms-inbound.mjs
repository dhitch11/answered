// /api/sms-inbound — the webhook Twilio calls when somebody texts our number.
//
// ── WHY THIS EXISTS, AND WHY IT EXISTS BEFORE THE FIRST MESSAGE IS EVER SENT ─────────────────
//
// Writing the A2P campaign evidence, I claimed our code honors STOP, STOPALL, UNSUBSCRIBE and the
// rest. It did not. There was no inbound message handler in this codebase at all, because no
// message had ever been received, so nothing had been built to receive one. That claim would have
// been disproved by a reviewer in a single test.
//
// The real gap underneath the false claim is worse than the claim was:
//
//   Twilio's Advanced Opt-Out honors STOP at the PLATFORM level, so the person stops receiving
//   texts. Our own suppression store never hears about it. That person is then opted out of
//   messaging and STILL REACHABLE BY VOICE, because the two facts live in different places.
//
// CONSENT WITHDRAWAL IS PER PERSON, NOT PER CHANNEL. Somebody who says stop has said stop, and the
// channel they happened to say it on is not a qualifier on their answer. So this mirrors a carrier
// STOP into the same `stop/<sha256(e164)>` key that the call path checks as gate 4, which makes one
// word shut every door at once.
//
// ── IT IS BUILT BEFORE IT IS NEEDED, ON PURPOSE ──────────────────────────────────────────────
//
// The messaging program is not registered yet and no message has been sent. The correct time to
// build the thing that honors an opt-out is BEFORE the first message goes out, not after the first
// person tries to stop one. A suppression path that arrives late is a suppression path that was
// missing exactly when it mattered.
//
// ── WHAT IT REFUSES TO DO ────────────────────────────────────────────────────────────────────
//
//  1. Trust the request. Twilio signs its webhooks; an unsigned or wrongly signed POST is refused,
//     because this endpoint writes a permanent record keyed by phone number and an open version of
//     it would let anyone suppress anyone.
//  2. Answer with a message. The reply is empty TwiML. Twilio's own Advanced Opt-Out sends the
//     confirmation, and a second one from us would be a duplicate to the person and, worse, an
//     unregistered outbound message from a program that is not yet approved.
//  3. Guess. A body it does not recognise is recorded and acknowledged, never interpreted.

import crypto from 'node:crypto';
import * as blobs from '@netlify/blobs';

export const config = {
  // A LITERAL. Netlify reads this by static analysis at bundle time and silently drops a computed
  // value; this repo has a function that shipped a computed path and registered no routes at all.
  path: ['/api/sms-inbound'],
};

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const nowIso = () => new Date().toISOString();

/** The same store and the same key shape the call path reads. One fact, one place. */
function consentStore(event) {
  if (typeof blobs.connectLambda === 'function') {
    try { blobs.connectLambda(event); } catch (e) { /* the first read or write is the verdict */ }
  }
  return blobs.getStore('consent');
}

/** E.164 for a US number, matching normalizeUs in call-me.mjs so the hashes agree. */
function e164(raw) {
  const d = String(raw || '').replace(/\D+/g, '');
  if (d.length === 11 && d[0] === '1') return '+' + d;
  if (d.length === 10) return '+1' + d;
  if (String(raw || '').startsWith('+') && d.length >= 10) return '+' + d;
  return null;
}

// The carrier keyword set. Twilio honors these at the platform level; we mirror the same list so
// our record agrees with the carrier's rather than being a second, narrower opinion.
const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'opt-out', 'revoke']);
const START_WORDS = new Set(['start', 'unstop', 'yes']);
const HELP_WORDS = new Set(['help', 'info']);

const firstWord = (body) => String(body || '').trim().toLowerCase().replace(/[^a-z-]/g, ' ').split(/\s+/)[0] || '';

/**
 * Twilio's signature scheme: the full URL, then each POST param as key immediately followed by
 * value with keys sorted, HMAC-SHA1 with the auth token, base64.
 *
 * ★ THIS FAILS CLOSED. There is a function elsewhere in this repo named validTwilioSignature that
 * returns TRUE when the auth token is unset. That posture is defensible where a second gate carries
 * the weight, and it is not defensible here: this endpoint writes a permanent suppression record
 * keyed by a phone number, so an unverified caller could silently opt anybody out, or worse, opt
 * somebody back IN. No token means no writes.
 */
function verify(event, params) {
  const token = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  if (!token) return { ok: false, why: 'TWILIO_AUTH_TOKEN is not set, so this webhook cannot verify Twilio and will not write' };
  const sig = (event.headers['x-twilio-signature'] || event.headers['X-Twilio-Signature'] || '').trim();
  if (!sig) return { ok: false, why: 'no X-Twilio-Signature header' };

  const proto = event.headers['x-forwarded-proto'] || 'https';
  const host = event.headers.host || '';
  const url = `${proto}://${host}${event.rawUrl ? new URL(event.rawUrl).pathname : (event.path || '')}`;
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  const want = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');

  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, why: 'signature mismatch' };
  return { ok: true };
}

// Empty TwiML. Twilio's own opt-out confirmation is the reply the person gets; ours would be a
// duplicate and an unregistered outbound message from a program that is not approved yet.
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const twiml = () => ({
  statusCode: 200,
  headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' },
  body: EMPTY_TWIML,
});

export default async function handler(req, context) {
  const event = context && context.event ? context.event : null;

  // Netlify v2 gives a Request. Read the form body Twilio posts.
  let params = {};
  let raw = '';
  try {
    raw = await req.text();
    params = Object.fromEntries(new URLSearchParams(raw));
  } catch (e) {
    console.error('sms-inbound: unreadable body:', String(e && e.message).slice(0, 120));
    return new Response(EMPTY_TWIML, { status: 200, headers: { 'Content-Type': 'text/xml' } });
  }

  const headers = {};
  req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const shim = { headers, rawUrl: req.url, path: new URL(req.url).pathname };

  const v = verify(shim, params);
  if (!v.ok) {
    // Loud, and it writes nothing. A webhook that cannot prove who called it must not be able to
    // change a person's contact permissions.
    console.error('sms-inbound: REFUSED, ' + v.why + '. Nothing was written.');
    return new Response(EMPTY_TWIML, { status: 200, headers: { 'Content-Type': 'text/xml' } });
  }

  const from = e164(params.From);
  const word = firstWord(params.Body);
  if (!from) {
    console.error('sms-inbound: no usable From on a verified request; recorded nothing.');
    return new Response(EMPTY_TWIML, { status: 200, headers: { 'Content-Type': 'text/xml' } });
  }

  const store = consentStore(event);
  const h = sha(from);

  try {
    if (STOP_WORDS.has(word)) {
      // ★ TWO STORES, BECAUSE THERE ARE TWO GATES. FIXED 2026-08-17.
      //
      // This block used to write ONE key and claim "one word, every door". Measured, that comment
      // was true for exactly one door out of five. `call-me.mjs` reads this Blobs key as its gate 4.
      // Every OTHER path that places a call - lib/dial.mjs, lib/outbox.mjs, lib/hold-runtime.mjs,
      // lib/jobs.mjs and recover.mjs - gates on `sv_dial_context` in Postgres and has never read
      // this key. `consent-sync.mjs` bridges `record/` and not `stop/`, so nothing carried it over.
      //
      // So a person who texted STOP stopped getting texts (Twilio's platform opt-out) and stopped
      // getting the website's setup call, and could still be DIALLED by four other paths. One of
      // those is recover.mjs, which makes debt-collection calls, where stop-means-stop is not a
      // preference: FDCPA 1692c(c) ends contact on the first hearing, and this file's own knowledge
      // module says exactly that.
      //
      // Both writes are attempted independently and neither is allowed to swallow the other.
      const blobWrite = store.setJSON(`stop/${h}`, {
        at: nowIso(),
        source: 'sms',
        keyword: word,
        message_sid: params.MessageSid || null,
        phone_last4: from.slice(-4),
      }).then(() => true).catch((e) => {
        console.error(`sms-inbound: STOP BLOBS WRITE FAILED for ${from.slice(-4)}: ${String(e && e.message).slice(0, 140)}`);
        return false;
      });

      // ★ IMPORTED LAZILY, ON THIS BRANCH ONLY. A STOP must never fail because a database module
      // could not load on a path that had nothing to do with it, and the vast majority of inbound
      // messages are not STOPs.
      const pgWrite = import('./lib/db.mjs')
        .then((db) => db.suppress(from, `sms ${word}`, 'sms-inbound'))
        .then(() => true)
        .catch((e) => {
          console.error(`sms-inbound: STOP POSTGRES WRITE FAILED for ${from.slice(-4)}: ${String(e && e.message).slice(0, 140)}. The dial paths gated on sv_dial_context will NOT see this stop.`);
          return false;
        });

      const [blobOk, pgOk] = await Promise.all([blobWrite, pgWrite]);
      if (blobOk && pgOk) {
        console.log(`sms-inbound: STOP recorded from ${from.slice(-4)} via "${word}" in BOTH stores; every dial path and text path is suppressed for this number.`);
      } else {
        // ★ A PARTIAL STOP IS AN INCIDENT, NOT A WARNING. Say which door is still open, by name,
        // because the next reader needs to know what to close by hand.
        console.error(`sms-inbound: PARTIAL STOP for ${from.slice(-4)} — blobs=${blobOk ? 'ok' : 'FAILED'} postgres=${pgOk ? 'ok' : 'FAILED'}. ` +
          `${!pgOk ? 'recover/dial/outbox/hold-runtime/jobs can still call this number. ' : ''}${!blobOk ? 'call-me can still call this number. ' : ''}Close it by hand.`);
      }

      // ★ THREE STORES NOW, BECAUSE DELEGATION OPENED A THIRD DOOR. ADDED 2026-08-17.
      //
      // The moment this function began handing non-keyword bodies to the setup thread, signup.mjs
      // stopped seeing STOP: it is intercepted here, one branch earlier. signup keeps its OWN
      // `stopped` flag on its own blob record, and with nothing to set it the thread stayed open.
      //
      // MEASURED on prod immediately after the delegation shipped, which is the only reason this
      // is not live right now:
      //     SETUP      -> "This is Answered. I will set your line up..."
      //     STOP       -> (silent)                     <- looked correct
      //     "are you there?" -> "Hi, this is the AI phone line setup for..."   <- IT REPLIED
      // A person who had just opted out was answered on the next message. That is the exact
      // failure the two-store block above exists to prevent, reintroduced one layer up by a fix
      // for something else.
      //
      // Delegating the STOP itself is what closes it: signup runs isStop() before anything else
      // and marks its record with strong consistency. Its reply is discarded - the person has
      // asked us to stop, so the only correct response is the silence Twilio already sends.
      try {
        const { default: signupHandler } = await import('./signup.mjs');
        await signupHandler(
          new Request(req.url, { method: 'POST', headers: req.headers, body: raw }),
          context,
        );
      } catch (e) {
        console.error(`sms-inbound: PARTIAL STOP for ${from.slice(-4)} — the setup thread was not `
          + `marked stopped and can still reply. Close it by hand. `
          + String(e && e.message).slice(0, 100));
      }
    } else if (START_WORDS.has(word)) {
      // ★ A RESTART IS NOT A DELETE. The stop row is kept and marked, because "this person asked us
      // to stop on 2026-08-15 and asked us back on 2026-09-02" is the record a dispute needs, and a
      // deleted row cannot tell that story. The call path reads the presence of the key, so the
      // record is rewritten with an explicit resumed marker rather than removed.
      const prior = await store.get(`stop/${h}`, { type: 'json' }).catch(() => null);
      if (prior) {
        await store.setJSON(`resumed/${h}`, {
          at: nowIso(), source: 'sms', keyword: word,
          stopped_at: prior.at || null, message_sid: params.MessageSid || null,
        });
        await store.delete(`stop/${h}`);
        // ★ STOP AND START ARE NOT SYMMETRIC, AND THAT IS THE SAFE DIRECTION. As of 2026-08-17 a
        // STOP writes to BOTH stores, but db.mjs exposes `suppress` and no lift: `sv_suppress` is
        // the only suppression RPC that exists, and there is deliberately no `sv_unsuppress`. So a
        // START lifts the Blobs key that call-me.mjs reads, and CANNOT lift the Postgres row that
        // dial/outbox/hold-runtime/jobs/recover gate on.
        //
        // The person is therefore resumed for the website's setup call and still suppressed for
        // every outbound campaign path. That is over-suppression, which is the correct direction to
        // fail for a legal control, and it is said out loud here rather than left for somebody to
        // discover as a bug. Lifting the Postgres row is an operator action, on purpose.
        console.log(`sms-inbound: START from ${from.slice(-4)}; Blobs suppression lifted, prior stop preserved under resumed/. NOTE: the Postgres suppression is NOT lifted (no unsuppress RPC exists) so outbound campaign paths remain suppressed until an operator clears it.`);
      }
    } else if (HELP_WORDS.has(word)) {
      // Twilio answers HELP at the platform level. Recorded so the volume is visible, not answered.
      console.log(`sms-inbound: HELP from ${from.slice(-4)}.`);
    } else {
      // ★ THE FRONT DOOR. FIXED 2026-08-17 — THIS BRANCH WAS SWALLOWING EVERY SIGNUP.
      //
      // The comment below used to end "a person talking to a number that does not yet run a
      // conversation", and on 2026-08-16 that was true. On 2026-08-17 signup.mjs shipped, the
      // waitlist was removed, and thirteen places across index/setup/pricing/trades began telling
      // contractors to "Text SETUP to (916) 282-5278". Nothing repointed the webhook.
      //
      // Measured on the live Messaging Service MGab661e...:
      //     inbound_request_url          = https://answered.reddenda.com/api/sms-inbound
      //     use_inbound_webhook_on_number = false
      //     senders                       = +18778060626, +19162825278
      // So every inbound text lands HERE, and "SETUP" fell to this else branch: logged, empty
      // TwiML, no reply. The seven-question thread, the account write and the operator email were
      // all unreachable in production. 100% of self-serve signups were lost in silence.
      //
      // ★ AND IT WAS INVISIBLE BECAUSE OF HOW IT WAS TESTED. Every proof of the signup flow,
      // including my own burst test and my 8-turn happy path, was a signed POST fired directly at
      // /api/signup — which bypasses the routing question entirely. The Messages log shows ZERO
      // real inbound texts ever, so no contractor had yet hit it. Reproduce through the serving
      // path or do not publish.
      //
      // ★ WHY DELEGATE HERE RATHER THAN REPOINT THE SERVICE AT /api/signup. Two senders share this
      // messaging service. Repointing moves STOP and START off this handler too, and the Postgres
      // suppression mirror above is the one write that must never be skipped — Twilio honours the
      // keyword at its own level, but the voice side only learns about it here. Keeping one inbound
      // door and delegating the conversation leaves the legal writes exactly where they are.
      //
      // The signature still validates: Twilio signs the URL it POSTs to, we hand signup the same
      // url, headers and raw body, and signup rebuilds the identical string.
      // ★ A NEGOTIATION TURN IS TRIED BEFORE THE SETUP THREAD, ADDED 2026-08-18.
      //
      // Two products now share this one door. The tell is the SENDER'S NUMBER: tr_party_by_phone
      // resolves it only to a LIVE thread-mode deal, so a person mid-negotiation is answered by
      // their counterparty's agent, and everybody else falls through to setup exactly as before.
      //
      // Order matters and this order is deliberate. Someone in a live negotiation typing "yes" or
      // "8500" would otherwise be read as an answer to a setup question, and the setup thread is
      // stateful — it would advance, ask the next question, and their negotiation would go silent.
      // Checking the narrower, provable condition first is the only ordering that cannot do that.
      //
      // It fails toward SETUP, never toward the negotiation: an unreadable lookup returns null and
      // the message goes where it went yesterday. Missing a negotiation turn is recoverable by
      // texting again; routing a stranger's SETUP into somebody's live deal is not.
      try {
        const parley = await import('./lib/parley-sms.mjs');
        const party = await parley.partyForPhone(from);
        if (party) {
          console.log(`sms-inbound: ${from.slice(-4)} is side ${party.side} of live deal ${party.deal_id}; this is a negotiation turn.`);
          // ★ ACKNOWLEDGE NOW, ANSWER AFTER. The reply is a top-tier model call with a fallback
          // and a retry budget; Twilio's webhook window closes long before it returns. Holding the
          // response open would time out and Twilio would REDELIVER the same message, which lands
          // the turn twice in the thread. So the turn runs detached and the reply goes out through
          // outbox.sms(), which is the path with the suppression check and the send log on it.
          const work = parley.handleTurn({ party, body: params.Body, from })
            .then((r) => console.log(`parley-sms: deal ${r.deal || party.deal_id} turn -> sent=${r.sent} settled=${r.settled ?? 'no'} ${r.reason || ''}`))
            .catch((e) => console.error(`parley-sms: turn threw for deal ${party.deal_id}: ${String(e && e.message).slice(0, 160)}`));

          // ★ waitUntil IS USED ONLY IF IT REALLY EXISTS, AND THAT IS NOT A STYLE CHOICE.
          // Nothing else in this codebase calls context.waitUntil, so nobody has ever proven it is
          // there. It is an Edge-runtime API; on a Lambda-backed Netlify function it may simply be
          // undefined, and calling it would THROW — into the catch below, which falls through to
          // the setup thread. A person mid-negotiation would have their message answered by the
          // eight-question contractor questionnaire, which is the one outcome this whole branch
          // exists to prevent. So it is feature-detected, and the fallback is a BOUNDED await:
          // Twilio's webhook window is ~15s and it REDELIVERS on timeout, which would land the
          // same turn in the thread twice.
          if (typeof context?.waitUntil === 'function') {
            context.waitUntil(work);
          } else {
            await Promise.race([work, new Promise((r) => setTimeout(r, 9000))]);
          }
          return twiml();
        }
      } catch (e) {
        console.error(`sms-inbound: negotiation routing failed, falling through to setup: ${String(e && e.message).slice(0, 140)}`);
      }

      console.log(`sms-inbound: body from ${from.slice(-4)} is not a keyword; handing it to the setup thread.`);
      try {
        const { default: signupHandler } = await import('./signup.mjs');
        return await signupHandler(
          new Request(req.url, { method: 'POST', headers: req.headers, body: raw }),
          context,
        );
      } catch (e) {
        // A throw here is a 502, and Twilio answers a 502 by redelivering the same message, which
        // walks the contractor's answer one question to the right. Silence costs one turn.
        console.error('sms-inbound: setup thread failed, staying silent rather than 502ing: '
          + String(e && e.message).slice(0, 140));
      }
    }
  } catch (e) {
    // A store failure on a STOP is the one error here that matters, so it is loud. Twilio has
    // already honored the keyword at its own level, so the person is not receiving messages either
    // way; what is lost is the voice-side mirror, and that must be visible rather than swallowed.
    console.error('sms-inbound: STORE WRITE FAILED for a ' + word + ' from ' + from.slice(-4) + ': '
      + String(e && e.message).slice(0, 160)
      + ' — the carrier has honored it for messaging, but the voice path did NOT receive this stop.');
  }

  return new Response(EMPTY_TWIML, { status: 200, headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' } });
}
