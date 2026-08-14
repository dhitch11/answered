// /api/parley-terms — the OTHER half of the artifact /parley sells. (@LANE-PARLEY)
//
// WHY THIS IS ITS OWN DOOR AND NOT A SIXTH OP ON /api/truce. `truce.mjs` is @ANSWERED-RESEARCH's
// file, uncontested, and this lane is not writing another lane's runtime behind its back. The RPC
// underneath (`tr_terms`) is a new name, so it cannot change `tr_view`, and their fourteen property
// tests are untouched. Fold this in as a sixth op whenever they want it; the shape will not move.
//
// WHAT IT IS FOR. `must_haves` live in `sealed.limits`, next to the sealed amount, and `tr_view`
// returns only your own. So the terms a party types are visible to nobody but the author, while
// /parley sells the artifact as "One page. Plain words. Both names." and sells step two as "the
// number you will not cross, plus the terms you actually care about". A settled deal was producing
// a money line and no terms. The seal belongs on the NUMBER, not on the sentence.
//
// ★ THE PROPERTY THIS FILE MUST NEVER BREAK, SAME AS ITS NEIGHBOUR: no response ever carries a
// limit, an opening, or anything a limit can be computed from. It cannot: `tr_terms` returns text
// lines only, it opens the other side's lines only once the deal is OVER, and it redacts any line
// whose digits contain either sealed number. Do not add an op here that takes a deal id.

import { dbConfigured } from './lib/db.mjs';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
};
const ok = (d) => ({ statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(d) });
const bad = (c, m) => ({ statusCode: c, headers: JSON_HEADERS, body: JSON.stringify({ error: m }) });

// The same shape gate the neighbouring runtime uses, so a malformed token never reaches the
// database and a scan gets a 400 instead of a timing signal.
const TOKEN = /^[0-9a-f]{32,96}$/;

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return bad(405, 'POST only');
  if (!dbConfigured()) return bad(503, 'not configured');

  let body;
  try {
    body = JSON.parse(event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body || '{}');
  } catch { return bad(400, 'bad json'); }

  const token = String(body.token || '');
  if (!TOKEN.test(token)) return bad(400, 'that link is not valid');

  try {
    const url = process.env.ANSWERED_DB_URL;
    const anon = process.env.ANSWERED_DB_ANON;
    const res = await fetch(`${url}/rest/v1/rpc/tr_terms`, {
      method: 'POST',
      headers: { apikey: anon, Authorization: `Bearer ${anon}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_token: token }),
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`tr_terms ${res.status}`);
    return ok(text ? JSON.parse(text) : null);
  } catch (e) {
    console.error('parley-terms failed:', String(e.message).slice(0, 200));
    return bad(500, 'something went wrong on our side');
  }
};
