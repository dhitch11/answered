// db.mjs — the only way anything in this codebase reaches the call spine.
//
// Every table has RLS on with no policies, so the publishable key opens nothing. Access runs
// through security-definer RPCs that take a shared secret held only in the Netlify environment.
// If ANSWERED_DB_SECRET is unset, every call here throws rather than degrading to a silent no-op:
// a telemetry layer that fails quietly is worse than none, because you trust the empty chart.

const URL_ = () => process.env.ANSWERED_DB_URL;
const ANON = () => process.env.ANSWERED_DB_ANON;
const SECRET = () => process.env.ANSWERED_DB_SECRET;

export function dbConfigured() {
  return Boolean(URL_() && ANON() && SECRET());
}

export async function rpc(fn, args = {}, { timeoutMs = 8000 } = {}) {
  if (!dbConfigured()) {
    throw new Error('db not configured: ANSWERED_DB_URL / ANSWERED_DB_ANON / ANSWERED_DB_SECRET');
  }
  const res = await fetch(`${URL_()}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: ANON(),
      Authorization: `Bearer ${ANON()}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ p_secret: SECRET(), ...args }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    // Never echo the body of an auth failure; it can carry the argument list back.
    throw new Error(`db ${fn} ${res.status}${res.status === 401 || res.status === 403 ? '' : `: ${text.slice(0, 300)}`}`);
  }
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

// ── writes ───────────────────────────────────────────────────────────────────────────────────
export const upsertContacts = (rows) => rpc('sv_upsert_contacts', { p_rows: rows });
export const recordCall     = (row) => rpc('sv_record_call', { p_row: row });
export const updateCall     = (callSid, patch) => rpc('sv_update_call', { p_call_sid: callSid, p_patch: patch });
export const addTranscript  = (callSid, rows) => rpc('sv_add_transcript', { p_call_sid: callSid, p_rows: rows });
export const addEvent       = (callSid, kind, payload) => rpc('sv_add_event', { p_call_sid: callSid, p_kind: kind, p_payload: payload || {} });
export const suppress       = (phone, reason, source) => rpc('sv_suppress', { p_phone: phone, p_reason: reason, p_source: source || 'system' });
export const exec           = (table, row) => rpc('sv_exec', { p_table: table, p_row: row });

// ── reads ────────────────────────────────────────────────────────────────────────────────────
export const board      = () => rpc('sv_board');
export const contacts   = (f = {}) => rpc('sv_contacts', {
  p_q: f.q || null, p_lane: f.lane || null, p_disposition: f.disposition || null,
  p_state: f.state || null, p_trade: f.trade || null, p_line_type: f.lineType || null,
  p_limit: f.limit || 100, p_offset: f.offset || 0,
});
export const contact    = (id) => rpc('sv_contact', { p_id: id });
export const transcript = (callSid, since = 0) => rpc('sv_transcript', { p_call_sid: callSid, p_since: since });
export const nextBatch  = (limit = 25, lane = null) => rpc('sv_next_batch', { p_limit: limit, p_lane: lane });
export const calls      = (f = {}) => rpc('sv_calls', {
  p_answered_by: f.answeredBy || null, p_campaign: f.campaign || null,
  p_disposition: f.disposition || null, p_limit: f.limit || 100,
});
