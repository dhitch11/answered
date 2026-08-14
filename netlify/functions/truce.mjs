// /api/truce — the text-negotiation product's HTTP surface.
//
// @ANSWERED-BUILD owns parley.html and the copy. This is the runtime behind it. The page calls
// this with fetch and never touches the database.
//
// AUTHENTICATION IS THE LINK ITSELF. The other side has no account, no app, no password and no
// card — they tap a link and type a number, which is the whole reason a stranger agrees to use
// this. So a party token (192 bits of randomness) IS the credential for that one party, on that
// one deal. Creating a deal is an operator action and keeps the estate's shared-secret posture.
//
// ★ THE PROPERTY THIS FILE MUST NEVER BREAK: no response ever contains the other party's limit.
// That is enforced in Postgres — the limits live in a `sealed` schema nothing can select from, and
// every read is a function that can only reach the limit belonging to the token it was given.
//
// ★★ AND THAT DEFENCE IS NOW WEAKER THAN IT WAS, DELIBERATELY, SO SAY SO RATHER THAN LEAVE A
// COMMENT CLAIMING A PROPERTY THE CODE NO LONGER HAS. This file used to be unable to leak a limit
// because it was never able to FETCH one. The `say` op ends that: an agent cannot haggle on
// somebody's behalf without knowing the floor it must not cross, so `tr_agent_brief` hands this
// process the represented side's sealed limit, under the OPERATOR credential, never the party
// token. The secret is now in memory here, and structural impossibility has been traded for two
// controls that must therefore be treated as load bearing:
//   1. the brief is fetched with rpc(), never open(), so a party token can never reach it; and
//   2. lib/parley-agent.mjs runs a deterministic firewall over every generated reply and refuses
//      to return text containing that number in any written or spoken form. It fails CLOSED: if it
//      cannot produce a safe reply it sends none and says so.
// If you add an op, keep it token-first, and never return a brief, or any part of one, to a caller.

import { rpc, dbConfigured } from './lib/db.mjs';
import { negotiate } from './lib/parley-agent.mjs';
import { createPayeeAccount, onboardingLink, payeeReady, checkoutForSettlement } from './lib/parley-money.mjs';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
};
const ok = (d) => ({ statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(d) });
const bad = (c, m) => ({ statusCode: c, headers: JSON_HEADERS, body: JSON.stringify({ error: m }) });

const TOKEN = /^[0-9a-f]{32,96}$/;

/**
 * The token-authenticated RPCs. TWO credentials, and neither substitutes for the other:
 * the party TOKEN is the user's (it is what makes a link work with no account), and the shared
 * SECRET proves the call came from our server.
 *
 * ★ The secret was added after @ANSWERED-INTEL measured that every tr_* function was invokable by
 * anyone holding the publishable key. A Postgres function is born PUBLIC EXECUTE — the opposite
 * default from a table — so revoking anon on every table, as all three lanes had done, closed the
 * wrong door. It was not a data breach, because the 192-bit token is still the boundary, but it
 * meant the rate limiting in this file could be walked straight around by calling PostgREST direct.
 */
async function open(fn, args) {
  const url = process.env.ANSWERED_DB_URL;
  const anon = process.env.ANSWERED_DB_ANON;
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: anon, Authorization: `Bearer ${anon}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_secret: process.env.ANSWERED_DB_SECRET, ...args }),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`truce ${fn} ${res.status}`);
  return text ? JSON.parse(text) : null;
}

// ── telling both people it settled ───────────────────────────────────────────
//
// WHY THIS EXISTS. David created a real deal, sent the link to somebody, and the product did
// nothing a person could perceive: she opened a page, and when a number was finally agreed
// NOBODY WAS TOLD. A negotiation that never tells you it finished is not a negotiation, it is a
// page you have to keep reopening and hope.
//
// Each side leaves their own email if they want one, so this sends what it can and says so
// honestly when it cannot. It never texts: texting is not switched on, and implying otherwise
// would be a promise the system cannot keep.
async function notifySettled(dealId) {
  const notice = await rpc('tr_settlement_notice', { p_deal: dealId });
  // Claimed exactly once, in Postgres, so a retry or a race cannot send a second copy.
  if (!notice || notice.claimed !== true) return;

  const key = (process.env.RESEND_API_KEY || '').trim();
  const parties = Array.isArray(notice.parties) ? notice.parties : [];
  if (!key) {
    if (parties.length) console.error(`truce ${dealId}: settled and ${parties.length} party(ies) asked to be told, but RESEND_API_KEY is not set.`);
    return;
  }
  const site = process.env.URL || 'https://answered.reddenda.com';
  const money = (n) => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

  for (const p of parties) {
    const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#111">
<p>Hi ${escapeHtml(p.name || 'there')},</p>
<p><b>You have a number.</b> ${escapeHtml(notice.subject || 'Your negotiation')} settled at <b>${money(notice.settled_value)}</b>.</p>
<p>It sits between what you were each willing to do. <b>Neither of you was shown the other's number, and neither of you ever will be.</b></p>
<p><a href="${site}/truce/${p.token}" style="display:inline-block;background:#0B0C0E;color:#E3FF4F;padding:12px 20px;border-radius:8px;text-decoration:none"><b>Open the agreement</b></a></p>
<p style="color:#555;font-size:14px">That link is yours. Anyone who opens it can act as you, so keep it to yourself. It stops working when the deal expires.</p>
<p style="color:#555;font-size:14px">Sent by Parley because you asked to be told how this one ended. We did not text anyone about it.</p>
</div>`;
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Parley <info@reddenda.com>',
          to: [p.contact],
          subject: `Settled at ${money(notice.settled_value)}: ${notice.subject || 'your negotiation'}`,
          html,
        }),
        signal: AbortSignal.timeout(8000),
      });
      // A send that failed must never read as sent.
      if (!r.ok) console.error(`truce ${dealId}: Resend refused the ${p.side} notice (${r.status}).`);
    } catch (e) {
      console.error(`truce ${dealId}: the ${p.side} notice did not send:`, String(e && e.message).slice(0, 120));
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return bad(405, 'POST only');
  if (!dbConfigured()) return bad(503, 'not configured');

  let body;
  try {
    body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body || '{}');
  } catch { return bad(400, 'bad json'); }

  const op = String(body.op || '');
  const token = String(body.token || '');
  const ip = (event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || '').split(',')[0].trim() || null;

  // Every token-authenticated op validates the shape first, so a malformed token never reaches
  // the database and a scan gets a 400 rather than a timing signal.
  const needsToken = ['view', 'set_limit', 'sign', 'leak_check', 'terms', 'set_contact', 'say', 'payout_setup', 'payout_status', 'pay'];
  if (needsToken.includes(op) && !TOKEN.test(token)) return bad(400, 'that link is not valid');

  try {
    switch (op) {
      case 'view':
        return ok(await open('tr_view', { p_token: token }));

      // Two numbers, not one. `opening` is PUBLIC — what you are asking or offering, shown to the
      // other side. `amount` is the SEALED limit — the number you will not cross, which no
      // response on any path will ever hand to the other party.
      case 'set_limit': {
        const amount = Number(body.amount);
        if (!Number.isFinite(amount) || amount < 0) return bad(400, 'a limit needs a number');
        if (!['max', 'min'].includes(body.direction)) return bad(400, 'direction must be max or min');
        const opening = body.opening === undefined || body.opening === null || body.opening === ''
          ? null : Number(body.opening);
        if (opening !== null && (!Number.isFinite(opening) || opening < 0)) {
          return bad(400, 'an opening needs a number');
        }
        const musts = Array.isArray(body.must_haves) ? body.must_haves.slice(0, 8).map((s) => String(s).slice(0, 120)) : [];
        // THREE numbers now, and only the opening is public: the anchor you start at, the GOAL you
        // are driving for, and the floor you will not cross. David, 2026-08-14: "it's going to try
        // to push for the goal and then maybe even a high goal price too, where you want it to
        // start trying to get to it, and then the ultimate fallback."
        const target = body.target === undefined || body.target === null || body.target === ''
          ? null : Number(body.target);
        if (target !== null && (!Number.isFinite(target) || target < 0)) {
          return bad(400, 'a goal needs a number');
        }
        const res = await open('tr_set_limit', {
          p_token: token, p_direction: body.direction, p_amount: amount,
          p_must_haves: musts, p_opening: opening, p_target: target,
        });
        if (res && res.error) return bad(400, res.error);
        // Setting the second limit is what settles a deal, so this is the moment both people need
        // to hear about. It is deliberately AFTER the limit is stored and it never blocks the
        // answer: a mail outage must not cost somebody their settlement.
        if (res && res.deal && res.deal.status === 'settled') {
          await notifySettled(res.deal.id).catch((e) => {
            console.error('truce: settled but could not notify:', String(e && e.message).slice(0, 160));
          });
        }
        return ok(res);
      }

      // A party leaving THEIR OWN address so we can tell them how it ended. There is no path for
      // one side to supply the other side's contact, here or anywhere: the token identifies one
      // row, and the whole invitation model is that the sender passes the link on themselves.
      // ★ THE NEGOTIATION ITSELF. You say something, and the OTHER side's agent answers, holding
      // their sealed limit and never revealing it. This is the product as it was specced: you
      // haggle with their agent, not with a form. The same call serves the web thread today and the
      // SMS thread the moment the number is live, because the transport is not this function's
      // business.
      case 'say': {
        const said = String(body.body || '').trim();
        if (!said) return bad(400, 'say something first');
        if (said.length > 1200) return bad(400, 'that message is too long');

        // Rate limited on the TOKEN, because the door is open by design: a party has no account,
        // and every reply costs a top-tier model call. Durable, so a cold start cannot reset it.
        try {
          const gate = await rpc('sv_rate_take', {
            p_bucket: 'truce_say', p_key: token, p_limit: 60, p_window: '1 hour',
          });
          if (!gate || gate.allowed !== true) {
            return bad(429, 'that is a lot of messages on one deal in an hour. Give it a few minutes.');
          }
        } catch (e) {
          console.error('truce say: rate limiter unreadable; refusing rather than waving through');
          return bad(503, 'we cannot take that message right now. Try again shortly.');
        }

        const wrote = await open('tr_say', { p_token: token, p_body: said });
        if (!wrote || wrote.ok !== true) return bad(400, (wrote && wrote.reason) || 'that message did not send');

        // Everything the replying agent needs, including a sealed limit, so it is fetched with the
        // OPERATOR credential and never with the party token.
        const brief = await rpc('tr_agent_brief', { p_token: token });
        if (!brief || brief.ok !== true) {
          return ok({ ok: true, sent: true, reply: null, note: 'Your message is in. No reply could be prepared.' });
        }

        const answer = await negotiate(brief);
        if (!answer.ok) {
          // The message IS stored. Say plainly that no reply came rather than inventing one.
          console.error('truce say: no agent reply:', answer.reason);
          return ok({
            ok: true, sent: true, reply: null,
            note: 'Your message is in. The other side\'s agent could not answer just now, so nothing was said back.',
          });
        }
        let settled = null;
        if (answer.generated) {
          // ★ THE CLOSE IS RECORDED, NOT LEFT IN THE PROSE. Measured 2026-08-14: the agent said
          // "Deal at 8600, cash on pickup tonight" and the deal still read `negotiating` an hour
          // later. A negotiation that concludes and records nothing has no settlement, no sheet to
          // sign, no notification and nothing to charge a success fee on. The DATABASE decides,
          // never the model: tr_agent_settle re-reads both sealed limits and refuses anything on
          // the wrong side of either, so an agent that is persuaded, confused or attacked into
          // agreeing below the floor still cannot bind anyone to it.
          if (answer.accept && answer.amount !== null) {
            const s = await rpc('tr_agent_settle', {
              p_deal: brief.deal.id, p_side: brief.represents.side, p_amount: answer.amount,
            });
            if (s && s.ok) settled = s.settled_value;
            else console.error(`truce say: agent tried to settle at ${answer.amount} and the database refused: ${(s && s.reason) || 'unknown'}`);
          }
          await rpc('tr_agent_say', {
            p_deal: brief.deal.id, p_side: brief.represents.side,
            p_body: answer.text, p_amount: answer.amount, p_move: settled ? 'accept' : 'agent',
          });
          if (settled) {
            await notifySettled(brief.deal.id).catch((e) => {
              console.error('truce: settled in conversation but could not notify:', String(e && e.message).slice(0, 160));
            });
          }
        }
        return ok({ ok: true, sent: true, reply: answer.text, generated: !!answer.generated, settled });
      }

      // ── THE SETTLEMENT RAIL ────────────────────────────────────────────────
      //
      // David: "Not just a promise, not just a signature. Actually track it and get it." A sheet
      // both people sign is a promise, and a fee that depends on somebody reporting their own
      // outcome is a fee they will decline to report. So the money moves THROUGH us: the payer pays
      // once, the payee's share lands in the payee's own Stripe account, and our cut is separated
      // by Stripe in the same movement. Nobody is invoiced and nobody is trusted.
      //
      // The rail is optional and always will be. Two people who would rather meet with cash will,
      // and we earn nothing from that deal. That is the honest trade: a fee we can actually collect
      // on the deals we genuinely carried, instead of one we can only ask for.

      // The party RECEIVING the money sets up somewhere for it to land.
      case 'payout_setup': {
        const v = await open('tr_view', { p_token: token });
        if (!v || v.error) return bad(400, (v && v.error) || 'that link is not valid');
        if (v.deal.status !== 'settled') return bad(400, 'there is nothing to pay yet: this deal has not settled');
        try {
          const acct = await createPayeeAccount({ dealId: v.deal.id });
          const link = await onboardingLink({ accountId: acct.id, dealId: v.deal.id });
          await open('tr_payee_account', { p_token: token, p_account: acct.id });
          return ok({ ok: true, account: acct.id, onboarding_url: link.url });
        } catch (e) {
          console.error('truce payout_setup:', String(e && e.message).slice(0, 200));
          return bad(502, 'we could not open a payout account just now. Nothing was charged.');
        }
      }

      // Is that account actually able to receive money? Asked of Stripe, never assumed because
      // somebody came back from an onboarding page.
      case 'payout_status': {
        const st = await open('tr_payee_state', { p_token: token });
        if (!st || !st.account) return ok({ ok: true, ready: false, started: false });
        try {
          const r = await payeeReady(st.account);
          if (r.ready !== st.ready) await open('tr_payee_ready', { p_token: token, p_ready: r.ready });
          return ok({ ok: true, started: true, ...r });
        } catch (e) {
          return ok({ ok: true, started: true, ready: false, reason: 'we could not check with the payment processor just now' });
        }
      }

      // The payer's checkout. Fee comes from the DEAL ROW, never from a number typed here.
      case 'pay': {
        const v = await open('tr_view', { p_token: token });
        if (!v || v.error) return bad(400, (v && v.error) || 'that link is not valid');
        if (v.deal.status !== 'settled') return bad(400, 'this deal has not settled, so there is nothing to pay');
        const payee = await open('tr_payee_state', { p_token: token, p_other: true });
        if (!payee || !payee.account || !payee.ready) {
          return ok({ ok: false, waiting_on_payee: true, note: 'The other side has not finished setting up somewhere to receive the money.' });
        }
        const opened = await rpc('tr_payout_open', {
          p_deal: v.deal.id, p_payer_side: v.me.side, p_fee_cents: Number(v.deal.fee_cents) || 0,
        });
        if (!opened || opened.ok !== true) return bad(400, (opened && opened.reason) || 'a payout could not be opened');
        try {
          const session = await checkoutForSettlement({
            payoutId: opened.payout_id, dealId: v.deal.id, subject: v.deal.subject,
            amountCents: opened.amount_cents, feeCents: opened.fee_cents, payeeAccount: payee.account,
          });
          await rpc('tr_payout_intent', {
            p_payout: opened.payout_id, p_session: session.id, p_intent: session.payment_intent || null,
            p_account: payee.account,
          });
          return ok({ ok: true, checkout_url: session.url, amount_cents: opened.amount_cents, fee_cents: opened.fee_cents });
        } catch (e) {
          console.error('truce pay:', String(e && e.message).slice(0, 200));
          return bad(502, 'we could not open a checkout just now. Nothing was charged.');
        }
      }

      case 'set_contact':
        return ok(await open('tr_set_contact', { p_token: token, p_contact: String(body.contact || '') }));

      case 'sign': {
        const name = String(body.name || '').trim();
        if (!name) return bad(400, 'type your name to sign');
        return ok(await open('tr_sign', {
          p_token: token, p_name: name.slice(0, 120), p_ip: ip,
          p_ua: String(event.headers['user-agent'] || '').slice(0, 300),
        }));
      }

      // The instrument behind the "show me every message that mentions my limit" control. It
      // returns real counts and it CAN come back non-zero. A claim you cannot measure is a slogan.
      case 'leak_check':
        return ok(await open('tr_leak_check', { p_token: token }));

      // The terms half of the artifact. Sealed until the negotiation finishes, and any line whose
      // digits contain its own author's sealed figure is withheld, so a free-text box cannot
      // reopen the leak the public-opening fix closed.
      case 'terms':
        return ok(await open('tr_terms', { p_token: token }));

      // Creating a deal is the owner's action, so it keeps the operator secret.
      case 'create': {
        const subject = String(body.subject || '').trim();
        if (!subject) return bad(400, 'say what the deal is, in one line');

        // ★ THIS DOOR HAS TO BE OPEN: the whole product is that a stranger can start a deal with
        // no account, no app and no card. So it is rate limited rather than authenticated, and the
        // limiter is DURABLE in Postgres rather than in module memory — an in-memory counter
        // resets on every cold start, which is a control that looks real and fails open.
        // It also fails CLOSED: an unattributable request, or a limiter we cannot read, is refused.
        if (!ip) return bad(429, 'we could not attribute this request; try again');
        let gate;
        try {
          gate = await rpc('sv_rate_take', {
            p_bucket: 'truce_create', p_key: ip, p_limit: 20, p_window: '1 hour',
            // 20/hour: a person starting real negotiations will never approach it, a scripted
            // loop hits it in seconds, and the property suite (7 deals per run) has headroom for
            // two runs. Deliberately NOT exempting the test path: a limiter with a bypass in it
            // is not a limiter, and a suite that can trip it is the suite proving it works.
          });
        } catch (e) {
          console.error('rate limiter unreadable; refusing rather than waving through:', String(e.message).slice(0, 120));
          return bad(503, 'we cannot start a new deal right now. Try again shortly.');
        }
        if (!gate || gate.allowed !== true) {
          return bad(429, 'that is a lot of deals from one place in an hour. Try again later, or email info@reddenda.com.');
        }
        const r = await rpc('sv_truce_create', {
          p_subject: subject.slice(0, 200),
          p_kind: body.kind || 'other',
          p_a_name: String(body.a_name || 'You').slice(0, 80),
          p_a_role: String(body.a_role || 'side a').slice(0, 40),
          p_b_name: String(body.b_name || 'Them').slice(0, 80),
          p_b_role: String(body.b_role || 'side b').slice(0, 40),
        });
        const site = process.env.URL || 'https://answered.reddenda.com';
        return ok({
          deal_id: r.deal_id,
          // Your link and their link. Only ever hand out the one that belongs to that person.
          you: `${site}/truce/${r.a_token}`,
          them: `${site}/truce/${r.b_token}`,
        });
      }

      // Teardown for the property suite. It can only remove a deal whose own subject begins with
      // the run tag it was given, and the tag has to match the test-run shape, so it is incapable
      // of touching a real negotiation rather than merely trusted not to.
      case 'purge_test_deal':
        return ok(await rpc('sv_truce_purge_test', { p_deal: body.deal_id, p_run: body.run }));

      default:
        return bad(400, `unknown op "${op}"`);
    }
  } catch (e) {
    console.error(`truce ${op} failed:`, String(e.message).slice(0, 200));
    return bad(500, 'something went wrong on our side');
  }
};
