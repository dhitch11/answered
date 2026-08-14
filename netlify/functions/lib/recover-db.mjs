// recover-db.mjs — the only way the Recover runtime reaches its own records.
//
// Same posture as lib/db.mjs and lib/ledger.mjs: RLS is on with no policies, no browser role holds a
// grant, and every read and write is a security-definer function that takes the estate secret. This
// file adds no policy of its own. It is a set of names for RPCs that already exist.

import { rpc, dbConfigured } from './db.mjs';

export { dbConfigured };

export const upsertInvoice = (row) => rpc('sv_recover_upsert_invoice', { p_row: row });
export const getInvoice    = (id) => rpc('sv_recover_get', { p_id: id });
export const gateFacts     = (id) => rpc('sv_recover_gate_facts', { p_id: id });
export const logCall       = (row) => rpc('sv_recover_log_call', { p_row: row });
export const bindCall      = (id, patch) => rpc('sv_recover_bind_call', { p_id: id, p_patch: patch });
/** Keyed on OUR row id. This is what the conversation uses, on every turn. */
export const touchCall     = (id, patch) => rpc('sv_recover_update_call_by_id', { p_id: id, p_patch: patch });
/** Keyed on the vendor's id. Only the status webhook, which is handed nothing else. */
export const updateCall    = (callSid, patch) => rpc('sv_recover_update_call', { p_call_sid: callSid, p_patch: patch });
export const callContext   = (id, tokenSha) => rpc('sv_recover_call_context', { p_id: id, p_token_sha256: tokenSha });
export const promise       = (row) => rpc('sv_recover_promise', { p_row: row });
export const stop          = (id, reason, callSid, kind) => rpc('sv_recover_stop', { p_id: id, p_reason: reason, p_call_sid: callSid, p_kind: kind || 'stop' });
export const payment       = (row) => rpc('sv_recover_payment', { p_row: row });
export const paymentRated  = (id, rating, billingEvent) => rpc('sv_recover_payment_rated', { p_payment_id: id, p_rating: rating, p_billing_event: billingEvent || null });
export const board         = (f = {}) => rpc('sv_recover_board', {
  p_account_key: f.accountKey || null, p_status: f.status || null,
  p_limit: f.limit || 50, p_offset: f.offset || 0,
});
