// /internal/cockpit — the operator console.
//
// GATED SERVER-SIDE. Nothing here is serialized before the PIN check passes, because a curtain
// drawn in CSS over bytes the server already sent is not a gate. Same posture, same cookie and
// the same fail-closed behaviour as /internal.
//
// THE ONE RULE THAT MAKES THIS DIFFERENT FROM EVERY OTHER DIALLER:
// every dial, manual or autopilot, runs through the same gate in research/lib/lane.mjs, and a
// refusal is written to the calls table exactly like a placed call. There is no operator
// override, no "dial anyway", no hidden path. If a number is RED it cannot be dialled from this
// interface, and the reason is printed on the button. The refusals are the evidence the gate ran.

import * as db from './lib/db.mjs';
import * as tw from './lib/twilio-rest.mjs';
import { SCRIPTS } from './lib/scripts.mjs';
import { gateFor, placeCall, site, dncReadiness } from './lib/dial.mjs';
import { BASE_HEADERS, mintCookie, cookieValid, pinValid, configured, readCookie, setCookieHeader, slow } from './lib/gate-auth.mjs';
import { PAGE, LOGIN } from './cockpit-ui.mjs';

const COOKIE = 'ans_cockpit';
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const ok = (data) => ({ statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(data) });
const bad = (code, message) => ({ statusCode: code, headers: JSON_HEADERS, body: JSON.stringify({ error: message }) });

const OPERATOR_NUMBER = () => (process.env.ANSWERED_OPERATOR_NUMBER || '').trim();

// ── operations ───────────────────────────────────────────────────────────────────────────────
async function run(op, body, operator) {
  switch (op) {
    case 'board': {
      const b = await db.board();
      // ★ READINESS RIDES ON THE BOARD, because until now nothing outside lib/dial.mjs ever CALLED
      // dncReadiness(). I had written that the 64.1200(b)(1) legal-entity gap was "surfaced to an
      // operator screen"; it was computed and then read by nobody, which is a dormant instrument
      // dressed as a control. A gap that reaches no screen is a comment. It reaches one now.
      const readiness = await dncReadiness().catch(() => ({ read_failed: true }));
      return { ...b, readiness,
        operator_number: OPERATOR_NUMBER() ? `…${OPERATOR_NUMBER().slice(-4)}` : null,
        modes: Object.keys(SCRIPTS).filter((k) => k !== 'voicemail') };
    }
    // The opening exactly as it will be SPOKEN, so an operator can read the words the callee hears
    // without placing a call. Every legally operative sentence in this program lives in that string,
    // and the only honest way to check it is to render it from the same function the dialler uses.
    case 'opening': return { text: SCRIPTS.discovery.disclosure() };
    case 'contacts':   return db.contacts(body);
    case 'contact':    return db.contact(body.id);
    case 'transcript': return { lines: await db.transcript(body.call_sid, body.since || 0) };
    case 'calls':      return { rows: await db.calls(body) };

    case 'gatecheck': {
      const g = await gateFor(body.phone, { state: body.state });
      return {
        verdict: g.verdict, line_type: g.lineType, lookup_ok: g.lookupOk,
        suppressed: Boolean(g.context && g.context.suppressed),
        calls_30d: Number((g.context && g.context.calls_30d) || 0),
        known_contact: g.contact ? { id: g.contact.id, name: g.contact.name, state: g.contact.state, disposition: g.contact.disposition } : null,
      };
    }

    case 'dial': {
      let contact = null;
      if (body.contact_id) {
        const c = await db.contact(body.contact_id);
        contact = c?.contact || null;
      }
      const phone = body.phone || contact?.phone;
      if (!phone) return { error: 'no number' };
      // A hand-typed number has no state on file, and the calling-hours check cannot run without
      // one. The operator asserts it; it is carried onto the call record as an assertion rather
      // than as sourced data, so an audit can tell the two apart.
      return placeCall({
        phone, contact, mode: body.mode || 'measure', operator,
        assertedState: body.state || null,
        campaignId: body.campaign_id, lineId: body.line_id, fromNumber: body.from,
      });
    }

    case 'hangup': {
      await tw.updateCall(body.call_sid, { Status: 'completed' });
      await db.addEvent(body.call_sid, 'operator_hangup', { operator });
      return { ok: true };
    }

    // ── listen, whisper, barge. All three are the same Twilio primitive with different flags. ──
    case 'monitor': case 'whisper': case 'barge': {
      // ★ The destination is the OPERATOR NUMBER FROM THE ENVIRONMENT, never a number in the
      // request body. `body.to || OPERATOR_NUMBER()` turned these three operations into an
      // ungated dialler: any authenticated session could dial an arbitrary number, with no lane
      // check, no suppression check and no row in the call log.
      const to = OPERATOR_NUMBER();
      if (!to) return { error: 'ANSWERED_OPERATOR_NUMBER is not set, so there is nowhere to send the operator leg. Set it to your mobile.' };
      const conf = body.conference_name;
      if (!conf) return { error: 'this call is not in a conference yet. Take it over first, then listen or barge.' };
      const params = {
        From: process.env.CANARY_FROM_NUMBER || process.env.ANSWERED_DEMO_NUMBER,
        To: to,
        Beep: 'false',
        EndConferenceOnExit: 'false',
        StartConferenceOnEnter: 'false',
        Label: `operator-${op}`,
      };
      if (op === 'monitor') params.Muted = 'true';
      if (op === 'barge') params.Muted = 'false';
      if (op === 'whisper') {
        // Coaching means the coached participant is the ONLY one who can hear the coach. Pointing
        // CallSidToCoach at the prospect's leg meant "whisper" was heard by the prospect and by
        // nobody else, which is the exact opposite of what the button says. On an AI call there
        // is no colleague leg to coach, so this refuses rather than doing something surprising.
        const coach = body.coach_call_sid;
        if (!coach || coach === body.call_sid) {
          return { error: 'whisper needs a colleague already in the conference to whisper to. On an AI call there is nobody to coach, so take the call over or barge in instead.' };
        }
        params.Coaching = 'true';
        params.CallSidToCoach = coach;
        params.Muted = 'false';
      }
      const participant = await tw.addParticipant(conf, params);
      await db.addEvent(body.call_sid, `operator_${op}`, { operator, participant: participant.call_sid, to_last4: String(to).slice(-4) });
      return { ok: true, participant_sid: participant.call_sid };
    }

    // ── the takeover. A live AI call is redirected into a conference and the operator is dialled
    //    in. This is the only way to get live audio on a bridged AI call, and it is the whole
    //    reason every operator-touched call runs as a conference.
    case 'takeover': {
      const conf = body.conference_name || `ans-${body.call_sid}`;
      await tw.updateCall(body.call_sid, {
        Url: `${site()}/api/call-voice?mode=conference&disclosed=1&conf=${encodeURIComponent(conf)}`,
        Method: 'POST',
      });
      await db.updateCall(body.call_sid, { conference_name: conf });
      await db.addEvent(body.call_sid, 'operator_takeover', { operator, conference: conf });

      const to = OPERATOR_NUMBER();
      let participant = null;
      if (to) {
        // A moment for the redirect to land before the operator leg arrives at the conference.
        await new Promise((r) => setTimeout(r, 1200));
        try {
          participant = await tw.addParticipant(conf, {
            From: process.env.CANARY_FROM_NUMBER || process.env.ANSWERED_DEMO_NUMBER,
            To: to, Beep: 'false', EndConferenceOnExit: 'true', StartConferenceOnEnter: 'true',
            Label: 'operator',
          });
        } catch (e) { return { ok: true, conference_name: conf, operator_leg_error: e.message }; }
      }
      return { ok: true, conference_name: conf, participant_sid: participant?.call_sid || null };
    }

    case 'sms': {
      const from = body.from || process.env.CANARY_FROM_NUMBER;
      const msg = await tw.sendMessage({
        To: body.to, From: from, Body: body.body,
        StatusCallback: `${site()}/api/call-status?kind=sms`,
      });
      await db.exec('messages', {
        message_sid: msg.sid, contact_id: body.contact_id || null, direction: 'outbound',
        from_number: from, to_number: body.to, body: body.body, status: msg.status, operator,
      });
      return { ok: true, sid: msg.sid, status: msg.status };
    }

    case 'suppress':
      await db.suppress(body.phone, body.reason || `suppressed by ${operator}`, 'cockpit');
      return { ok: true };

    case 'disposition':
      return { contact: await db.exec('contact_patch', { id: body.id, disposition: body.disposition, owner: body.owner, tags: body.tags, score: body.score }) };

    case 'note':
      return { note: await db.exec('notes', { contact_id: body.contact_id, call_sid: body.call_sid, body: body.body, author: operator, pinned: body.pinned }) };

    // ── lines ────────────────────────────────────────────────────────────────────────────────
    case 'searchnumbers':
      return { numbers: await tw.availableNumbers({ areaCode: body.area_code, contains: body.contains, limit: body.limit || 10 }) };

    case 'provision': {
      const bought = await tw.buyNumber({
        phoneNumber: body.phone_number,
        friendlyName: body.label || `Answered ${body.purpose || 'research'}`,
        voiceUrl: `${site()}/api/answered-voice`,
        statusCallback: `${site()}/api/call-status`,
      });
      const line = await db.exec('lines', {
        phone: bought.phone_number, twilio_sid: bought.sid, label: body.label,
        purpose: body.purpose || 'research', status: 'active',
        area_code: String(bought.phone_number).slice(2, 5), daily_cap: body.daily_cap || 80,
      });
      return { ok: true, line };
    }

    case 'lineupdate': {
      // A quarantined number is quarantined because a carrier flagged it. A label edit must not
      // put it back into rotation as a side effect.
      const current = ((await db.board()).lines || []).find((l) => l.phone === body.phone);
      if (current && current.status === 'quarantined' && body.status && body.status !== 'quarantined' && !body.unquarantine) {
        return { error: `${body.phone} is quarantined. Reactivating it needs an explicit unquarantine, not a label edit.` };
      }
      return { line: await db.exec('lines', body) };
    }

    case 'syncnumbers': {
      // Adopt every number the Twilio account already owns, so the board is the truth rather
      // than a second list that drifts from it.
      const owned = await tw.ownedNumbers();
      const rows = [];
      for (const n of owned) {
        rows.push(await db.exec('lines', {
          phone: n.phone_number, twilio_sid: n.sid, label: n.friendly_name,
          purpose: n.phone_number === process.env.ANSWERED_DEMO_NUMBER ? 'demo' : 'research',
          status: 'active', area_code: String(n.phone_number).slice(2, 5),
        }));
      }
      return { ok: true, synced: rows.length };
    }

    // ── campaigns and autopilot ──────────────────────────────────────────────────────────────
    case 'campaign':
      return { campaign: await db.exec('campaigns', body) };

    case 'autopilot': {
      // ★ This used to go through the same upsert as campaign creation, whose ON CONFLICT set
      // policy, script and line_ids from the incoming row with no coalesce. Arming a campaign
      // therefore wiped its policy and its disclosure script to '{}', and it silently un-halted a
      // campaign the safety checks had stopped. Arming is now a narrow patch that cannot resurrect
      // a halt without an explicit, deliberate resume.
      const res = await db.rpc('sv_set_autopilot', {
        p_id: body.id,
        p_on: Boolean(body.on),
        p_resume: Boolean(body.resume),
      });
      if (res && res.refused) return { error: res.refused };
      return { campaign: res };
    }

    case 'nextbatch':
      return { rows: await db.nextBatch(body.limit || 25, body.lane || null) };

    default:
      return { error: `unknown op "${op}"` };
  }
}

// ── handler ──────────────────────────────────────────────────────────────────────────────────
export const handler = async (event) => {
  if (!configured()) {
    console.error('cockpit: ANSWERED_DIRECTORY_PIN or ANSWERED_BRAIN_SECRET not set; refusing (fail closed).');
    return { statusCode: 503, headers: BASE_HEADERS, body: LOGIN('This console is not configured. Nothing to see.') };
  }

  const authed = cookieValid(COOKIE, readCookie(event.headers, COOKIE));
  const isJson = String(event.headers['content-type'] || event.headers['Content-Type'] || '').includes('application/json');

  // login
  if (event.httpMethod === 'POST' && !isJson) {
    const params = new URLSearchParams(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || ''));
    if (pinValid(params.get('pin'))) {
      return {
        statusCode: 200,
        headers: { ...BASE_HEADERS, 'Set-Cookie': setCookieHeader(COOKIE, mintCookie(COOKIE)) },
        body: PAGE(),
      };
    }
    await slow();
    return { statusCode: 401, headers: BASE_HEADERS, body: LOGIN('Not it. Try again.') };
  }

  if (!authed) {
    if (isJson) return bad(401, 'not signed in');
    return { statusCode: 200, headers: BASE_HEADERS, body: LOGIN() };
  }

  // api
  if (event.httpMethod === 'POST' && isJson) {
    if (!db.dbConfigured()) return bad(503, 'call spine not configured (ANSWERED_DB_URL / ANSWERED_DB_ANON / ANSWERED_DB_SECRET)');
    let body;
    try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body || '{}'); }
    catch { return bad(400, 'bad json'); }
    const op = String(body.op || '');
    const operator = String(body.operator || 'operator').slice(0, 40);
    try {
      const result = await run(op, body, operator);
      if (result && result.error) return bad(400, result.error);
      return ok(result);
    } catch (e) {
      console.error(`cockpit op ${op} failed:`, String(e.message).slice(0, 240));
      return bad(500, String(e.message).slice(0, 240));
    }
  }

  return { statusCode: 200, headers: BASE_HEADERS, body: PAGE() };
};
