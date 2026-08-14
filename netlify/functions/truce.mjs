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
// every read is a function that can only reach the limit belonging to the token it was given. This
// file cannot leak what it is never able to fetch. Keep it that way: do not add an op that takes a
// deal id instead of a token.

import { rpc, dbConfigured } from './lib/db.mjs';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
};
const ok = (d) => ({ statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(d) });
const bad = (c, m) => ({ statusCode: c, headers: JSON_HEADERS, body: JSON.stringify({ error: m }) });

const TOKEN = /^[0-9a-f]{32,96}$/;

/** Public RPCs take the party token instead of the estate secret. */
async function open(fn, args) {
  const url = process.env.ANSWERED_DB_URL;
  const anon = process.env.ANSWERED_DB_ANON;
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: anon, Authorization: `Bearer ${anon}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`truce ${fn} ${res.status}`);
  return text ? JSON.parse(text) : null;
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
  const needsToken = ['view', 'set_limit', 'sign', 'leak_check', 'terms'];
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
        return ok(await open('tr_set_limit', {
          p_token: token, p_direction: body.direction, p_amount: amount,
          p_must_haves: musts, p_opening: opening,
        }));
      }

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
