// dial.mjs — the ONLY way a call gets placed in this system.
//
// The console imports this. The autopilot imports this. There is deliberately no second path,
// because the moment automated dialling has its own copy of the gate, the two drift, and the one
// that drifts is always the one nobody is watching.
//
// Every dial produces a row in `calls` whether or not it happened. A refusal is a record with
// placed=false and the full gate verdict attached. Those rows are the evidence the gate ran, and
// they are the first thing anyone auditing this should read.

import * as db from './db.mjs';
import * as tw from './twilio-rest.mjs';
import { SCRIPTS, scriptSatisfies } from './scripts.mjs';
import { classify, DEFAULT_POLICY, LANES } from '../../../research/lib/lane.mjs';

export const site = () => process.env.URL || 'https://answered.reddenda.com';

/**
 * Everything the gate needs, read fresh from the database on every single dial.
 * Never trust a caller-supplied suppression state, call count or consent record.
 */
export async function gateFor(phone, { state, lineType, lookupOk } = {}) {
  const ctx = await db.dialContext(phone).catch((e) => {
    console.error('dial context read failed:', String(e.message).slice(0, 160));
    return null;
  });
  if (!ctx) {
    return {
      verdict: { lane: LANES.RED, dialable: false, reasons: ['could not read the suppression list; refusing rather than guessing'] },
      lineType: null, lookupOk: false, context: null, contact: null,
    };
  }

  // ★ CHECK THE FIELD'S PRESENCE, NEVER ITS TRUTHINESS, for a control whose absence means
  // permission. `ctx.suppressed ? ... : []` produced an EMPTY suppression set for any payload
  // where the key was missing, null, or spelled differently, and `Number(ctx.calls_30d || 0)`
  // turned a missing frequency count into a free dial. Both failed OPEN, silently, on the two
  // checks that exist to stop us calling someone who asked us not to.
  if (typeof ctx.suppressed !== 'boolean' || !Number.isFinite(Number(ctx.calls_30d))) {
    return {
      verdict: {
        lane: LANES.RED,
        dialable: false,
        reasons: [`dial context is malformed (suppressed=${JSON.stringify(ctx.suppressed)}, calls_30d=${JSON.stringify(ctx.calls_30d)}); refusing rather than assuming`],
      },
      lineType: null, lookupOk: false, context: ctx, contact: ctx.contact || null,
    };
  }

  const contact = ctx.contact || null;
  let lt = lineType ?? contact?.line_type ?? null;
  let lo = lookupOk ?? contact?.lookup_ok ?? null;
  // A stored line type with no recorded successful lookup is not evidence. `lookup_ok` null means
  // nobody ever classified this number, and null is not false.
  if (lt != null && lo !== true) { lt = null; lo = null; }
  if (lt == null) {
    const res = await tw.lineType(phone);
    lt = res.lineType; lo = res.lookupOk;
  }

  const verdict = classify(
    {
      phone,
      // The number's OWN state wins. A caller-supplied state is only a fallback for a number we
      // have never seen, never an override that could move a shop into a friendlier timezone.
      state: contact?.state ?? state ?? null,
      lineType: lt,
      lookupOk: lo,
      consent: ctx.consent
        ? { grantedAt: ctx.consent.granted_at, expiresAt: ctx.consent.expires_at, scope: ctx.consent.scope, source: ctx.consent.source, written: ctx.consent.written }
        : null,
      callCount30d: Number(ctx.calls_30d || 0),
    },
    DEFAULT_POLICY,
    new Set(ctx.suppressed ? [phone] : []),
    new Date(),
  );
  return { verdict, lineType: lt, lookupOk: lo, context: ctx, contact };
}

/**
 * The call's CLASS, written on the row at dial time because billing and compliance evidence both
 * key on it, and because reconstructing it later from a transcript is guesswork.
 *
 * ★ `human_cold` IS DELIBERATELY NOT EMITTED YET, and that is the whole point of this function
 * being explicit rather than a ternary. `human_cold` means a person dialled and a person spoke,
 * with NO artificial voice on the call at all — that is what puts it outside 47 CFR
 * 64.1200(a)(1) and unlocks mobile numbers. Today's `conference` mode still speaks the AI
 * disclosure before joining, so an artificial voice IS on that call and labelling it human_cold
 * would be a false compliance record: the exact class of lie that gets discovered in a deposition
 * rather than in a code review. It becomes emittable when the silent-operator mode exists.
 */
export function classifyCall({ mode, hasConsent, operator }) {
  if (operator === 'canary' || operator === 'smoke' || operator === 'e2e-verify') return 'demo';
  if (hasConsent) return 'consented';
  return 'ai_cold';
}

export async function placeCall(opts) {
  const { phone, mode, operator, campaignId, lineId, fromNumber, assertedState } = opts;
  let contact = opts.contact;

  // An unrecognised mode must never quietly become a different call than was asked for. Falling
  // back to 'measure' would mean choosing "Discovery" and placing a measurement call, and nobody
  // would ever notice because both calls sound plausible on the recording.
  if (!SCRIPTS[mode] || mode === 'voicemail') return { placed: false, error: `unknown script "${mode}"` };

  const gated = await gateFor(phone, { state: contact?.state || assertedState });
  const { verdict, lineType, lookupOk } = gated;
  contact = gated.contact || contact;

  // The script has to actually speak every obligation the gate attached, or the call is refused.
  const sat = verdict.dialable ? scriptSatisfies(mode, verdict.obligations || []) : { ok: true, missing: [] };
  if (!sat.ok) {
    verdict.lane = LANES.RED;
    verdict.dialable = false;
    verdict.reasons = [...(verdict.reasons || []), `script "${mode}" does not carry: ${sat.missing.join(', ')}`];
  }

  const hasConsent = Boolean(gated.context && gated.context.consent);
  const callClass = classifyCall({ mode, hasConsent, operator });

  const gateRecord = {
    lane: verdict.lane, dialable: verdict.dialable, reasons: verdict.reasons,
    call_class: callClass, has_consent: hasConsent,
    line_type: lineType, lookup_ok: lookupOk, obligations: verdict.obligations || [],
    script: mode, policy: DEFAULT_POLICY, decided_at: new Date().toISOString(),
    // Which state was used for the calling-hours check, and whether anybody actually knew it.
    state_used: contact?.state || assertedState || null,
    state_source: contact?.state ? 'sourced' : (assertedState ? `asserted by ${operator}` : 'none'),
  };

  if (!verdict.dialable) {
    await db.recordCall({
      contact_id: contact?.id || null, campaign_id: campaignId || null, to_number: phone,
      from_number: fromNumber || null, status: 'refused', gate: gateRecord, operator,
      call_class: callClass,
      placed: false, refused_reason: (verdict.reasons || []).join('; '),
    });
    return { placed: false, gate: gateRecord, retryAt: verdict.retryAt || null, contact };
  }

  const from = fromNumber || process.env.CANARY_FROM_NUMBER || process.env.ANSWERED_DEMO_NUMBER;
  if (!from) return { placed: false, error: 'no outbound number configured' };

  const call = await tw.createCall({
    To: phone,
    From: from,
    Url: `${site()}/api/call-voice?mode=${encodeURIComponent(mode)}`,
    Method: 'POST',
    StatusCallback: `${site()}/api/call-status`,
    StatusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    StatusCallbackMethod: 'POST',
    MachineDetection: 'DetectMessageEnd',
    MachineDetectionTimeout: 15,
    AsyncAmd: 'false',
    Timeout: 30,
    Record: 'true',
    RecordingStatusCallback: `${site()}/api/call-recording`,
    RecordingStatusCallbackMethod: 'POST',
    RecordingChannels: 'dual',
  });

  await db.recordCall({
    call_sid: call.sid, contact_id: contact?.id || null, campaign_id: campaignId || null,
    line_id: lineId || null, to_number: phone, from_number: from, status: call.status,
    gate: gateRecord, operator, call_class: callClass, placed: true,
  });

  return { placed: true, call_sid: call.sid, status: call.status, gate: gateRecord, contact };
}
