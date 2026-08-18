// parley-sms.mjs — the transport that puts the negotiator in a real text thread.
//
// ═══ WHAT WAS MISSING, AND WHAT WAS NOT ═══
//
// The negotiator has been finished for days. truce.mjs:198 says what it was for, and the last
// clause is the part that matters here:
//
//     "You say something, and the OTHER side's agent answers, holding their sealed limit and never
//      revealing it. This is the product as it was specced: you haggle with their agent, not with a
//      form. The same call serves the web thread today and the SMS thread the moment the number is
//      live, because the transport is not this function's business."
//
// This file is that transport. It adds no negotiation logic of its own on purpose: every rule about
// what may be said, what a figure means and who is bound lives in lib/parley-agent.mjs and in the
// tr_* functions, and a second copy here would drift from the first.
//
// ═══ THE TWO THINGS THAT MAKE SMS DIFFERENT FROM THE WEB THREAD ═══
//
// 1. THE REPLY CANNOT RIDE IN THE WEBHOOK RESPONSE. signup.mjs answers inline with a TwiML
//    <Message>, which works because its next line is a lookup. A negotiation turn is a top-tier
//    model call with a fallback and a retry budget; Twilio will have given up long before it
//    returns. So the webhook acknowledges immediately with empty TwiML and the reply goes out
//    afterwards through outbox.sms() — the same path every delivered message on this account has
//    used, which means it gets the suppression check, the messaging service and the send log
//    rather than a second bare-From path with its own bugs.
//
// 2. AN SMS CARRIES A PHONE NUMBER, NOT A TOKEN. tr_party_by_phone turns one into the other, and
//    resolves ONLY to a live thread-mode deal, so a settled or expired negotiation cannot be woken
//    by an old number and this module can answer "not one of ours" cleanly.
//
// ═══ WHAT THIS FILE REFUSES TO DO ═══
//
// It never writes a party's phone number. Only tr_set_contact does that, only with that party's own
// token, and there is deliberately no path for one side to supply the other's number — that is the
// invitation model, and the last time it was weak the sender could read the counterparty's sealed
// limit. See feedback_an_invitation_is_not_a_credential.

import * as db from './db.mjs';

/** Is this inbound number one side of a live negotiation? Returns null when it is not. */
export async function partyForPhone(phone) {
  const e164 = String(phone || '').trim();
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) return null;
  try {
    const r = await db.rpc('tr_party_by_phone', { p_phone: e164 });
    return r && r.ok === true ? r : null;
  } catch (e) {
    // ★ FAIL CLOSED TOWARD THE OTHER PRODUCT, NOT TOWARD THIS ONE. If the lookup cannot be read we
    // return null, so the message falls through to the setup thread exactly as it did before this
    // file existed. The failure mode is "a negotiation turn was missed", which is recoverable by
    // the sender texting again. Guessing the other way would route a stranger's SETUP into
    // somebody's live negotiation, which is not.
    console.error(`parley-sms: phone lookup failed, treating as not-a-negotiation: ${String(e && e.message).slice(0, 140)}`);
    return null;
  }
}

/**
 * One inbound turn: record what they said, let the other side's agent answer, send it back.
 *
 * Returns { handled, sent, settled, reason }. `handled:true` means this message belonged to a
 * negotiation and the caller must NOT also hand it to the setup thread.
 */
export async function handleTurn({ party, body, from }) {
  const said = String(body || '').trim().slice(0, 1200);
  if (!said) return { handled: true, sent: false, reason: 'empty message' };

  // Same durable limiter the web thread uses, same bucket, same key. A negotiation that arrives by
  // text is not a different negotiation and must not get a second, more generous allowance.
  try {
    const gate = await db.rpc('sv_rate_take', {
      p_bucket: 'truce_say', p_key: party.token, p_limit: 60, p_window: '1 hour',
    });
    if (!gate || gate.allowed !== true) {
      return { handled: true, sent: false, reason: 'rate limited', notify:
        'That is a lot of messages on one deal in an hour. Give it a few minutes and send it again.' };
    }
  } catch (e) {
    console.error('parley-sms: rate limiter unreadable; refusing the turn rather than waving it through');
    return { handled: true, sent: false, reason: 'limiter unreadable' };
  }

  const wrote = await db.rpc('tr_say', { p_token: party.token, p_body: said });
  if (!wrote || wrote.ok !== true) {
    return { handled: true, sent: false, reason: (wrote && wrote.reason) || 'message not recorded' };
  }

  const brief = await db.rpc('tr_agent_brief', { p_token: party.token });
  if (!brief || brief.ok !== true) {
    // The message IS stored. Say nothing rather than invent a reply.
    return { handled: true, sent: false, recorded: true, reason: 'no brief' };
  }

  const { negotiate } = await import('./parley-agent.mjs');
  const answer = await negotiate(brief);
  if (!answer || !answer.ok || !answer.text) {
    console.error(`parley-sms: no agent reply on deal ${brief.deal && brief.deal.id}: ${answer && answer.reason}`);
    return { handled: true, sent: false, recorded: true, reason: 'agent produced nothing' };
  }

  // ★ THE CLOSE IS RECORDED BY THE DATABASE, NEVER BY THE MODEL. tr_agent_settle re-reads both
  // sealed limits and refuses anything on the wrong side of either, so an agent that is persuaded,
  // confused or attacked into agreeing below the floor still cannot bind anyone to it. This is a
  // straight copy of the web thread's ordering, deliberately: settle first, then send, so a
  // message can never announce a figure the record does not hold.
  let settled = null;
  if (answer.accept && Number.isFinite(Number(answer.amount)) && Number(answer.amount) > 0) {
    try {
      const s = await db.rpc('tr_agent_settle', {
        p_deal: brief.deal.id, p_side: brief.represents.side, p_amount: answer.amount,
      });
      if (s && s.ok) {
        settled = s.settled_value;
        if (s.already && Number(s.settled_value) !== Number(answer.amount)) {
          console.error(`parley-sms: deal ${brief.deal.id} was ALREADY settled at ${s.settled_value}; `
            + `the agent had just agreed ${answer.amount}. The record wins.`);
        }
      }
    } catch (e) {
      console.error(`parley-sms: settle failed on ${brief.deal.id}: ${String(e && e.message).slice(0, 140)}`);
    }
  }

  await db.rpc('tr_agent_say', {
    p_deal: brief.deal.id,
    p_side: brief.represents.side,
    p_body: answer.text,
    p_amount: settled ?? (Number.isFinite(Number(answer.amount)) && Number(answer.amount) > 0 ? answer.amount : null),
    p_move: settled ? 'accept' : 'counter',
  }).catch((e) => console.error(`parley-sms: tr_agent_say failed: ${String(e && e.message).slice(0, 140)}`));

  // Out through the one send path, so suppression, the messaging service and the log all apply.
  const outbox = await import('./outbox.mjs');
  const text = settled
    ? `${answer.text}\n\nThat is agreed at ${settled}. You will both get the sheet to sign.`
    : answer.text;
  const sent = await outbox.sms({ to: from, body: text });
  if (!sent || sent.ok !== true) {
    console.error(`parley-sms: reply NOT delivered for deal ${brief.deal.id}: ${sent && sent.reason}`);
  }
  return { handled: true, sent: Boolean(sent && sent.ok), settled, deal: brief.deal.id };
}
