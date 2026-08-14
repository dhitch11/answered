// consent-sync — mirrors the one-click consent store into the call spine.
//
// ★ THE HURDLE THIS REMOVES, AND IT WAS INVISIBLE FROM EVERY SURFACE.
//
// `call-me.mjs` captures explicit consent when a person taps "call me" and writes it to Netlify
// Blobs. The dial gate reads `public.consent` in Postgres. The two never spoke. So a contractor who
// typed their number, ticked the box and asked us to ring them was STILL classified RED by the gate
// — mobile, no consent on file — and the console would refuse to call the one person in the whole
// corpus who had explicitly asked to be called.
//
// Nobody would have caught it. The activation call still happened (call-me dials it itself), the
// consent record still existed, and the refusal looked exactly like correct compliance behaviour.
// It is the same shape as every other defect on this system: two halves that each work, and a seam
// between them that nobody asserted on.
//
// This reads their store and writes the consent through `sv_grant_consent_once`, keyed on the blob
// key so replaying is idempotent. It requires NO change to call-me.mjs, which is another lane's
// file — I would rather remove a hurdle today than wait on a one-line edit I do not own.
//
// SUPPRESSION STILL OUTRANKS CONSENT. `sv_grant_consent` refuses outright for any number ever
// suppressed, so a web form can never overturn a spoken "stop". That is enforced in the database,
// not here, so a bug in this file cannot undo it.

import * as db from './lib/db.mjs';

const PAGE = 500;

/** Their record shape, hashed by design: phone_sha256 and phone_last4, never the raw number. */
function usableNumber(rec) {
  // A consent record we cannot resolve to a dialable number is not actionable. call-me stores the
  // phone only as a SHA-256 plus the last four digits, deliberately, so the raw number is not
  // sitting in object storage. That is the right call for privacy and it means this sync can only
  // carry across records that also carry a raw number.
  return typeof rec?.phone === 'string' && /^\+1\d{10}$/.test(rec.phone) ? rec.phone : null;
}

export default async () => {
  if (!db.dbConfigured()) {
    console.error('consent-sync: call spine not configured; standing down.');
    return new Response('not configured', { status: 503 });
  }

  let store;
  try {
    const blobs = await import('@netlify/blobs');
    store = blobs.getStore('consent');
  } catch (e) {
    console.error('consent-sync: consent store would not open:', String(e.message).slice(0, 160));
    return new Response('store unavailable', { status: 502 });
  }

  const report = { at: new Date().toISOString(), seen: 0, carried: 0, already: 0, unresolvable: 0, refused: 0, errors: 0 };

  let cursor;
  do {
    let page;
    try {
      page = await store.list({ prefix: 'record/', cursor, paginate: true });
    } catch (e) {
      console.error('consent-sync: list failed:', String(e.message).slice(0, 160));
      return new Response(JSON.stringify({ ...report, fatal: 'list failed' }), { status: 502 });
    }

    for (const b of page.blobs || []) {
      report.seen += 1;
      let rec;
      try { rec = await store.get(b.key, { type: 'json' }); } catch { report.errors += 1; continue; }
      if (!rec) { report.errors += 1; continue; }

      const phone = usableNumber(rec);
      if (!phone) { report.unresolvable += 1; continue; }

      try {
        const r = await db.rpc('sv_grant_consent_once', {
          p_external_id: b.key,
          p_phone: phone,
          p_source: rec.method || 'one-click activation',
          p_evidence: {
            consent_text: rec.consent_text ?? null,
            consent_version: rec.consent_version ?? null,
            scope_text: rec.scope ?? null,
            page: rec.page ?? null,
            track: rec.track ?? null,
            line_type: rec.line_type ?? null,
            carrier: rec.carrier ?? null,
            call_sid: rec.call_sid ?? null,
            blob_key: b.key,
          },
          p_scope: 'research_call',
          p_written: true,                       // a ticked checkbox beside published wording
          p_granted_at: rec.at ?? null,
        });
        if (r?.refused) report.refused += 1;
        else if (r?.already) report.already += 1;
        else report.carried += 1;
      } catch (e) {
        report.errors += 1;
        console.error('consent-sync: write failed for', b.key, String(e.message).slice(0, 140));
      }
    }
    cursor = page.cursor;
  } while (cursor);

  if (report.unresolvable > 0) {
    // Said out loud rather than swallowed: these are real consents we cannot act on, because the
    // record stores only a hash. That is a deliberate privacy choice by the other lane and the fix
    // is theirs to make (store the E.164 alongside the hash, or call sv_grant_consent inline).
    console.error(`consent-sync: ${report.unresolvable} consent records carry no raw number and cannot be carried across.`);
  }
  console.log('consent-sync:', JSON.stringify(report));
  return new Response(JSON.stringify(report), { headers: { 'Content-Type': 'application/json' } });
};

export const config = { schedule: '*/5 * * * *' };
