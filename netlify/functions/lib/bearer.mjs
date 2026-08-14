// bearer.mjs — who is allowed to make this system do something, on the integration endpoints.
//
// Three secrets can authorise a write, and WHICH ONE arrived is recorded by NAME (never by value)
// so a log line can answer "who booked this" months later:
//
//   ANSWERED_BOOKING_SECRET   the dedicated one. Prefer it. Give it to anything new.
//   ANSWERED_COCKPIT_KEY      the operator console's own key. Ours alone, never handed out.
//   ANSWERED_BRAIN_SECRET     the token pasted into the ElevenLabs custom-LLM config.
//
// The third one is accepted here DELIBERATELY, and the reasoning is not the same as gate-auth's.
// gate-auth refuses ANSWERED_BRAIN_SECRET as a cookie key because holding it would let a third
// party mint an OPERATOR SESSION and place calls. Booking a job is different: the voice agent is
// the legitimate author of a booking, it is the only party that was on the call, and that secret
// is exactly its credential. Accepting it here grants only what the agent is already for. It must
// never be accepted anywhere that dials, spends, or reads another customer's data.
//
// FAILS CLOSED. No secret configured means no writes, 503, and a console line saying so. An
// endpoint that accepts anything because nothing was set up is the fail-open pattern this estate
// has paid for repeatedly.

import crypto from 'node:crypto';

const NAMES = ['ANSWERED_BOOKING_SECRET', 'ANSWERED_COCKPIT_KEY', 'ANSWERED_BRAIN_SECRET'];

const eq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function configuredSecrets() {
  return NAMES.filter((n) => String(process.env[n] || '').trim());
}

export function presented(headers) {
  const h = {};
  for (const k in (headers || {})) h[k.toLowerCase()] = headers[k];
  const raw = String(h.authorization || h['x-answered-secret'] || '');
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return (m ? m[1] : raw).trim();
}

/**
 * @returns {{ok:true, as:string} | {ok:false, status:number, message:string}}
 */
export function authorize(headers, { allow = NAMES } = {}) {
  const usable = allow.filter((n) => String(process.env[n] || '').trim());
  if (!usable.length) {
    console.error(`bearer: none of ${allow.join(', ')} is set, so this endpoint cannot authorise anyone`);
    return { ok: false, status: 503, message: 'This endpoint has no credential configured, so it is refusing every request rather than accepting any.' };
  }
  const token = presented(headers);
  if (!token) return { ok: false, status: 401, message: 'Send Authorization: Bearer <secret>.' };
  for (const n of usable) {
    if (eq(token, String(process.env[n]).trim())) return { ok: true, as: n };
  }
  return { ok: false, status: 401, message: 'That credential is not one this endpoint accepts.' };
}
