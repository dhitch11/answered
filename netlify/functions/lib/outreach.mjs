// outreach.mjs — call, text or email any lead, from the record it belongs to.
//
// ── THE ONE IDEA ─────────────────────────────────────────────────────────────────────────────
// Every channel answers "can I act on this person right now" BEFORE it renders a control, and the
// answer is measured rather than assumed. Two of the three channels are conditionally blocked
// today — cold-calling a mobile without consent is unlawful, and our A2P campaign has not been
// approved — and both of those conditions LIFT on their own when the underlying facts change.
// So nothing here hardcodes "blocked". It asks:
//
//   email  -> is a mail key present, do we hold an address, is the contact suppressed
//   sms    -> ask TWILIO for the live campaign status, not a constant in this file
//   call   -> ask the DATABASE for line type, consent, suppression and do-not-call readiness
//
// The day the A2P campaign is approved and the day the registry snapshot lands, these controls
// turn themselves on with no deploy. That is the difference between a console that reports a
// state and one that is wired to it.
//
// ── AND THE RULE UNDER IT ────────────────────────────────────────────────────────────────────
// A BLOCKED ATTEMPT IS RECORDED, NOT DISCARDED. Every refusal writes a crm_messages row with
// status='blocked' and the reason in words. "We did not contact them, and here is exactly why" is
// evidence an operator needs to answer a customer and a regulator needs to see. A console that
// silently disables a button teaches nobody anything.

import { rpc } from './db.mjs';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── channel readiness, from the runtime rather than from a listing or a constant ─────────────

export const emailConfigured = () => Boolean((process.env.RESEND_API_KEY || '').trim());
const FROM = () => (process.env.ANSWERED_FROM_EMAIL || 'Answered <info@reddenda.com>');

const twilioAuth = () => {
  const sid = process.env.TWILIO_API_SID, secret = process.env.TWILIO_API_SECRET;
  const account = process.env.TWILIO_ACCOUNT_SID;
  if (!account || !sid || !secret) return null;
  return { account, header: 'Basic ' + Buffer.from(`${sid}:${secret}`).toString('base64') };
};

/**
 * THE LIVE A2P STATE, ASKED OF TWILIO.
 *
 * The campaign was rejected three times today and is being resubmitted by another lane. Hardcoding
 * "SMS is blocked" would mean that the hour it is approved, this console still refuses to text and
 * somebody has to remember why. So we ask. Cached briefly because this sits behind a UI that
 * polls, and a messaging-service lookup per keystroke is rude to both Twilio and the operator.
 */
/**
 * ★ A 401 FROM TWILIO IS NOT NECESSARILY A CREDENTIAL PROBLEM, AND SAYING SO SENDS PEOPLE THE
 * WRONG WAY FOR AN HOUR.
 *
 * Measured 2026-08-14: this account returns `20003 Authenticate` on EVERY endpoint, including the
 * core Accounts read, using a key pair that has been working all day. Twilio returns the same
 * error for a wrong key, a deleted key, and an account it has suspended for non-payment. The last
 * of those is the true cause here, and it is not fixable by rotating anything.
 *
 * So this reports the SYMPTOM precisely and names the likely causes in the order worth checking,
 * rather than asserting "bad credentials" and sending an operator to regenerate a key that is
 * fine. The distinction matters because one of these is fixed in a console and the other is fixed
 * with a payment method.
 */
function twilioAuthFailure(status, bodyText) {
  const code = /"code"\s*:\s*(\d+)/.exec(String(bodyText || ''));
  const isAuth = status === 401 || (code && code[1] === '20003');
  if (!isAuth) return null;
  return {
    ok: false, state: 'provider_unavailable', http: status,
    why: 'Twilio is rejecting every request on this account with an authentication error, including a '
       + 'plain account read. Twilio returns the same error for a suspended or unfunded account as it '
       + 'does for a bad key, so the credentials are not necessarily the fault. Check the account '
       + 'balance and status first, then the key. Nothing can be called or texted until it clears.',
  };
}

/**
 * ★ WHEN THE PROVIDER IS DOWN, BACK OFF HARD. DO NOT KEEP ASKING.
 *
 * The Twilio account is currently unfunded and answers 401 to everything. A console that polls a
 * suspended provider every two minutes produces nothing but noise, and a retry storm against an
 * account with a billing problem is the one thing that could make it worse. So a provider-level
 * failure is cached for far longer than a normal answer.
 *
 * It is still a CACHE and not a switch: the moment the window lapses it asks again, so the day the
 * account is funded the text controls turn themselves back on with no deploy and nobody having to
 * remember. A capability behind a named, temporary gate is still a real capability.
 */
const PROVIDER_DOWN_BACKOFF_MS = 15 * 60_000;

let a2pCache = { at: 0, value: null };
export async function smsReadiness({ maxAgeMs = 120_000 } = {}) {
  const ttl = (a2pCache.value && a2pCache.value.state === 'provider_unavailable')
    ? PROVIDER_DOWN_BACKOFF_MS : maxAgeMs;
  if (a2pCache.value && Date.now() - a2pCache.at < ttl) return a2pCache.value;
  const auth = twilioAuth();
  if (!auth) {
    return (a2pCache = { at: Date.now(), value: {
      ok: false, state: 'unconfigured',
      why: 'Twilio credentials are not set on this deploy, so we cannot send or even ask whether we may.',
    } }).value;
  }
  try {
    const r = await fetch('https://messaging.twilio.com/v1/Services', {
      headers: { Authorization: auth.header }, signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      const authFail = twilioAuthFailure(r.status, body);
      if (authFail) return (a2pCache = { at: Date.now(), value: authFail }).value;
      throw new Error('messaging services ' + r.status);
    }
    const svc = (await r.json()).services || [];
    if (!svc.length) {
      return (a2pCache = { at: Date.now(), value: {
        ok: false, state: 'no_service',
        why: 'No Twilio messaging service exists on this account, so there is nothing a campaign could be attached to.',
      } }).value;
    }
    // Ask each service for its US A2P campaign and take the best answer.
    let best = { ok: false, state: 'no_campaign',
      why: 'A messaging service exists but no US A2P 10DLC campaign is registered on it. Carriers block unregistered application-to-person traffic.' };
    for (const s of svc.slice(0, 5)) {
      const c = await fetch(`https://messaging.twilio.com/v1/Services/${s.sid}/Compliance/Usa2p`, {
        headers: { Authorization: auth.header }, signal: AbortSignal.timeout(6000),
      });
      if (!c.ok) continue;
      const list = (await c.json()).compliance || [];
      for (const camp of list) {
        const st = String(camp.campaign_status || '').toUpperCase();
        if (st === 'VERIFIED' || st === 'APPROVED') {
          best = { ok: true, state: st.toLowerCase(), service_sid: s.sid, campaign_sid: camp.sid,
            why: 'The US A2P campaign reads ' + st + ', so carriers will accept our traffic.' };
          break;
        }
        if (st && !best.ok) {
          best = { ok: false, state: st.toLowerCase(), service_sid: s.sid, campaign_sid: camp.sid,
            errors: camp.errors || null,
            why: 'The US A2P campaign reads ' + st + '. Carriers block anything that is not approved, so no text can be delivered until it is. '
               + 'This turns itself on the moment the status changes; nothing here needs redeploying.' };
        }
      }
      if (best.ok) break;
    }
    return (a2pCache = { at: Date.now(), value: best }).value;
  } catch (e) {
    // An unanswerable question is a refusal, never a permission.
    return (a2pCache = { at: Date.now(), value: {
      ok: false, state: 'unknown',
      why: 'Twilio could not be reached to confirm the campaign status: ' + String(e.message).slice(0, 120)
         + '. We do not text on an unanswered question.',
    } }).value;
  }
}

export const callingDisarmed = () => process.env.ANSWERED_AUTOPILOT_KILL === '1';

/**
 * The complete per-contact answer for all three channels: the database's half merged with the
 * runtime's half. This is what the record page renders its buttons from.
 */
export async function preflight(contactId) {
  const db = await rpc('sv_crm_outreach_state', { p_contact_id: contactId });
  if (!db) return null;
  const sms = await smsReadiness();

  const emailOk = emailConfigured() && db.email_db.ok;
  const callOk = db.call.ok && !callingDisarmed();

  return {
    ...db,
    email: {
      ok: emailOk,
      why: !emailConfigured()
        ? 'RESEND_API_KEY is not set on this deploy, so nothing can be sent.'
        : db.email_db.why,
    },
    sms: {
      // Both halves must be true: the line must accept texts AND the carrier must accept us.
      ok: db.sms_db.ok && sms.ok,
      carrier: sms,
      why: !db.sms_db.ok ? db.sms_db.why : sms.why,
    },
    call: {
      ...db.call,
      ok: callOk,
      why: db.call.ok && callingDisarmed()
        ? 'This number is lawfully callable, but ANSWERED_AUTOPILOT_KILL is set, so nothing on this deploy can place a call.'
        : db.call.why,
    },
  };
}

// ── the send log ─────────────────────────────────────────────────────────────────────────────

const log = (row) => rpc('sv_crm_message', { p_row: row }).catch((e) => {
  // The send already happened. Losing the log is bad; failing the request after the money or the
  // message has moved would be worse, and silently swallowing it would be worst of all.
  console.error('OUTREACH LOG FAILED (the message itself already went):', e && e.message);
  return null;
});

/** Record a refusal. A blocked attempt is a fact worth keeping. */
export async function recordBlocked({ contactId, channel, to, reason, actor }) {
  await log({
    contact_id: contactId, channel, to_addr: to, status: 'blocked',
    failure_reason: reason, sent_by: actor,
  });
  return { ok: false, blocked: true, reason };
}

// ── email ────────────────────────────────────────────────────────────────────────────────────

/**
 * A real send through Resend, logged with the provider's real message id so a later webhook can
 * resolve delivery, bounce and complaint back onto this row.
 */
export async function sendEmail({ contactId, accountId, to, subject, body, html, template,
                                  actor, aiAssisted = false, aiModel = null, meta = {} }) {
  if (!emailConfigured()) {
    return recordBlocked({ contactId, channel: 'email', to,
      reason: 'RESEND_API_KEY is not set on this deploy', actor });
  }
  if (!to || String(to).indexOf('@') < 1) {
    return recordBlocked({ contactId, channel: 'email', to,
      reason: 'no usable email address for this record', actor });
  }
  if (!subject || !String(subject).trim()) {
    return { ok: false, error: 'an email needs a subject' };
  }

  const textBody = String(body || '').trim();
  const htmlBody = html || (
    '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;color:#1E1B17">' +
    textBody.split(/\n{2,}/).map((p) => '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>').join('') +
    '</div>');

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY.trim(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM(), to: [to], subject: String(subject).trim(), html: htmlBody, text: textBody }),
      signal: AbortSignal.timeout(12_000),
    });
    const text = await r.text();
    let out = null; try { out = JSON.parse(text); } catch { /* keep the text */ }

    if (!r.ok) {
      await log({ contact_id: contactId, account_id: accountId, channel: 'email', to_addr: to,
        from_addr: FROM(), subject, body: textBody, template, provider: 'resend',
        status: 'failed', failure_reason: `resend ${r.status}: ${String(text).slice(0, 200)}`,
        ai_assisted: aiAssisted, ai_model: aiModel, sent_by: actor, meta });
      return { ok: false, error: `Resend refused it: ${String(text).slice(0, 200)}` };
    }

    await log({ contact_id: contactId, account_id: accountId, channel: 'email', to_addr: to,
      from_addr: FROM(), subject, body: textBody, template, provider: 'resend',
      provider_id: out && out.id, status: 'sent', ai_assisted: aiAssisted, ai_model: aiModel,
      sent_by: actor, meta });
    return { ok: true, provider_id: out && out.id };
  } catch (e) {
    await log({ contact_id: contactId, account_id: accountId, channel: 'email', to_addr: to,
      subject, body: textBody, provider: 'resend', status: 'failed',
      failure_reason: String(e.message).slice(0, 200), sent_by: actor, meta });
    return { ok: false, error: String(e.message).slice(0, 200) };
  }
}

// ── sms ──────────────────────────────────────────────────────────────────────────────────────

export async function sendSms({ contactId, accountId, to, body, actor, meta = {} }) {
  const state = await smsReadiness();
  if (!state.ok) {
    return recordBlocked({ contactId, channel: 'sms', to, actor,
      reason: state.why + (state.state ? ` (campaign status: ${state.state})` : '') });
  }
  const auth = twilioAuth();
  const from = (process.env.ANSWERED_SMS_FROM || process.env.ANSWERED_DEMO_NUMBER || '').trim();
  if (!auth || !from) {
    return recordBlocked({ contactId, channel: 'sms', to, actor,
      reason: 'no Twilio sending number is configured on this deploy' });
  }
  try {
    const form = new URLSearchParams({ To: to, From: from, Body: String(body || '').slice(0, 1500) });
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${auth.account}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: auth.header, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form, signal: AbortSignal.timeout(12_000),
    });
    const out = await r.json();
    if (!r.ok) {
      await log({ contact_id: contactId, account_id: accountId, channel: 'sms', to_addr: to,
        from_addr: from, body, provider: 'twilio', status: 'failed',
        failure_reason: `twilio ${r.status}: ${out && out.message}`, sent_by: actor, meta });
      return { ok: false, error: (out && out.message) || `twilio ${r.status}` };
    }
    await log({ contact_id: contactId, account_id: accountId, channel: 'sms', to_addr: to,
      from_addr: from, body, provider: 'twilio', provider_id: out.sid, status: 'sent',
      sent_by: actor, meta });
    return { ok: true, provider_id: out.sid };
  } catch (e) {
    await log({ contact_id: contactId, account_id: accountId, channel: 'sms', to_addr: to,
      body, provider: 'twilio', status: 'failed', failure_reason: String(e.message).slice(0, 200),
      sent_by: actor, meta });
    return { ok: false, error: String(e.message).slice(0, 200) };
  }
}

// ── call ─────────────────────────────────────────────────────────────────────────────────────

/**
 * ★ THIS CONSOLE DOES NOT PLACE AN AI COLD CALL, AND THAT IS A DESIGN DECISION.
 *
 * The outbound runtime, its compliance gate, its disclosure obligations and its kill switch belong
 * to the lane that built them, and duplicating a dial path here would create a second way to place
 * a call that does not go through the gate. That is precisely how a compliance control gets
 * bypassed by accident.
 *
 * What this DOES do is answer, per contact, whether a call is lawful right now and why, record the
 * intent, and hand the operator a tel: link so a HUMAN can dial — which is a different call class
 * with different obligations and is always available. When the registry snapshot lands and the
 * kill switch comes off, the same button becomes a real placement through the existing gate rather
 * than through anything new written here.
 */
export async function callIntent({ contactId, to, actor, note }) {
  const pre = await preflight(contactId);
  if (!pre) return { ok: false, error: 'no such contact' };

  if (!pre.call.ok) {
    await recordBlocked({ contactId, channel: 'call', to, actor, reason: pre.call.why });
    return { ok: false, blocked: true, reason: pre.call.why, human_dial_ok: true, tel: 'tel:' + to };
  }

  await log({ contact_id: contactId, channel: 'call', to_addr: to, status: 'queued',
    body: note || null, sent_by: actor,
    meta: { class: pre.call.class, basis: pre.call.why, consent_records: pre.consent_records } });

  return {
    ok: true, class: pre.call.class, basis: pre.call.why, tel: 'tel:' + to,
    note: 'The intent is recorded and this number is lawfully callable. Placement runs through the '
        + 'outbound gate, which is the only path that may dial.',
  };
}
