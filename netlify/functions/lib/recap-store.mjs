// recap-store.mjs — where a finished conversation becomes a permanent record, and the ledger
// that proves the record was delivered.
//
// THE DEFECT THIS FILE EXISTS TO CLOSE. The demo line answered, a person spoke, ElevenLabs held
// every word, and this system held none of them: `public.calls` carried 11 rows with ZERO
// `direction='inbound'`, and `transcript_lines` carried 864 rows with ZERO from ElevenLabs. The
// recap path could read a transcript out of the spine, and nothing ever put one in. A read path
// over an empty table returns "no transcript" forever and every check passes.
//
// Two jobs, in this order, and the order matters:
//   1. PERSIST. The words go into the spine BEFORE anybody tries to deliver them. If Resend is
//      down, the transcript still exists and an operator can still read the call. Delivering
//      first and storing second means an outage costs a customer their record.
//   2. LEDGER. Every delivery attempt claims a row in `recap_deliveries` first, so two containers
//      handling the same webhook retry cannot both send. The claim goes stale after ten minutes
//      and a failed row is re-claimable, so a crash between claiming and sending can never
//      silently cost a shop its transcript. Only 'sent' and 'skipped' are terminal.
//
// THE SPINE KEY. A phone conversation is keyed by its Twilio CallSid, which is what the cockpit,
// the recording links and the live-transcript view already use. A conversation with no phone call
// behind it (the onboarding agent in a browser) has no CallSid, so it is keyed `el:<conversation
// id>` and no `calls` row is written for it: a row in `calls` whose sid cannot be fetched from
// Twilio is a trap for every operator surface that tries.

import * as db from './db.mjs';

const CA = /^CA[0-9a-f]{32}$/i;

/** The one identifier everything about this conversation hangs off. Empty means unrecordable. */
export function spineKey({ call_sid: callSid, conversation_id: conversationId } = {}) {
  const sid = String(callSid || '').trim();
  if (CA.test(sid)) return sid;
  const conv = String(conversationId || '').trim();
  if (conv) return `el:${conv.slice(0, 96)}`;
  return '';
}

export const isPhoneKey = (key) => CA.test(String(key || ''));

/**
 * Did we actually say the four words the law cares about, on the wire, in this call?
 *
 * ★ READ FROM THE TRANSCRIPT, NEVER FROM THE SCRIPT. A prompt can contain the disclosure, pass
 * every review, and produce a call where the agent said "Hi". Only the transcript knows. This
 * reads our OWN side of the conversation and is allowed to answer no.
 *
 * Inbound is scoped to three obligations. A callback number is an outbound-cold-call obligation:
 * the person dialled us, so reciting a number back at them proves nothing and its absence is not
 * a failure. Judging inbound against an outbound checklist would report a false red forever.
 */
export function disclosureFromTranscript(lines) {
  const ours = (Array.isArray(lines) ? lines : [])
    .filter((l) => /^(agent|assistant|us)$/i.test(String((l && l.speaker) || '')))
    .map((l) => String((l && l.text) || ''))
    .join(' ')
    .slice(0, 8000);

  const heard = {
    identified: /\bthis is\b/i.test(ours),
    ai_disclosed: /\ba\.? ?i\b|artificial intelligence|automated assistant/i.test(ours),
    recording_announced: /\brecord(ed|ing)\b/i.test(ours),
  };
  return { heard, all: Object.values(heard).every(Boolean), had_our_speech: Boolean(ours.trim()) };
}

/**
 * Write the conversation into the spine. Returns a plain report; NEVER throws for a condition a
 * caller should be able to describe, because the caller has to be able to say in its own response
 * body exactly what landed and what did not.
 */
export async function persistConversation(input = {}) {
  const key = spineKey(input);
  const report = {
    key,
    configured: db.dbConfigured(),
    call_row: { ok: false, skipped: true, reason: '' },
    transcript: { ok: false, written: 0, reason: '' },
    event: { ok: false, reason: '' },
    disclosure: null,
  };

  if (!key) {
    report.call_row.reason = report.transcript.reason = 'the payload carried neither a Twilio call sid nor a conversation id, so there is no key to file this conversation under';
    return report;
  }
  if (!report.configured) {
    const why = 'the call spine is not configured on this deploy (ANSWERED_DB_URL / ANSWERED_DB_ANON / ANSWERED_DB_SECRET)';
    report.call_row.reason = report.transcript.reason = report.event.reason = why;
    return report;
  }

  const lines = Array.isArray(input.transcript) ? input.transcript : [];
  const disclosure = disclosureFromTranscript(lines);
  report.disclosure = disclosure;

  // ── 1. the call row ─────────────────────────────────────────────────────────────────────────
  // Only for a real phone call. sv_update_call inserts the row when it is missing, so this is the
  // one call that both creates and completes it.
  if (isPhoneKey(key)) {
    const seconds = Number(input.duration_seconds);
    const startedAt = input.started_at || '';
    const endedAt = startedAt && Number.isFinite(seconds) && seconds >= 0
      ? new Date(new Date(startedAt).getTime() + seconds * 1000).toISOString()
      : '';

    const patch = {
      direction: input.direction === 'outbound' ? 'outbound' : 'inbound',
      status: 'completed',
      answered_by: 'ai',
      from_number: input.from || null,
      to_number: input.to || null,
      started_at: startedAt || null,
      answered_at: startedAt || null,
      ended_at: endedAt || null,
      duration_seconds: Number.isFinite(seconds) ? Math.round(seconds) : null,
      ai_speaking: true,
      ai_listening: true,
      call_class: input.call_class || 'inbound',
      summary: input.summary || null,
      // The flattened transcript on the row itself, so a single-row read in any operator surface
      // shows the words without a second query.
      transcript: lines.length
        ? lines.map((l) => `${l.speaker === 'user' || l.speaker === 'them' ? 'Caller' : 'Answered'}: ${l.text}`).join('\n').slice(0, 60000)
        : null,
      outcome: {
        source: 'elevenlabs_post_call_webhook',
        conversation_id: input.conversation_id || null,
        call_successful: input.disposition || null,
        termination_reason: input.termination_reason || null,
        transcript_lines: lines.length,
      },
      ai_notes: {
        elevenlabs_conversation_id: input.conversation_id || null,
        elevenlabs_agent_id: input.agent_id || null,
        summary_title: input.summary_title || null,
      },
      disclosure_evidence: { ...disclosure.heard, scope: 'inbound', verified_from: 'elevenlabs_transcript', at: new Date().toISOString() },
    };
    // ★ Only ever written TRUE. sv_update_call coalesces, so writing false here would stamp a
    // "we checked and we did not disclose" over another writer's verified true. Absence reads as
    // "nobody has confirmed it", which is the honest state when the check did not pass.
    if (disclosure.all) patch.disclosure_verified = true;

    for (const k of Object.keys(patch)) if (patch[k] === null) delete patch[k];

    try {
      await db.updateCall(key, patch);
      report.call_row = { ok: true, skipped: false, reason: '' };
    } catch (e) {
      report.call_row = { ok: false, skipped: false, reason: String((e && e.message) || e).slice(0, 200) };
      console.error(`recap-store: call row write failed for ${key}: ${report.call_row.reason}`);
    }
  } else {
    report.call_row.reason = 'this conversation had no phone call behind it, so no row was written to `calls`. A calls row whose sid Twilio cannot fetch breaks every operator surface that tries.';
  }

  // ── 2. the transcript ───────────────────────────────────────────────────────────────────────
  // track = 'elevenlabs' on purpose. The unique key is (call_sid, seq, track) and Twilio's live
  // transcription writes 'inbound_track'/'outbound_track'. A shared track name would let one
  // source silently overwrite the other's rows on matching sequence numbers.
  if (lines.length) {
    const rows = lines.map((l, i) => ({
      seq: i,
      track: 'elevenlabs',
      speaker: l.speaker === 'user' ? 'them' : l.speaker === 'agent' || l.speaker === 'assistant' ? 'us' : String(l.speaker || 'unknown').slice(0, 24),
      text: String(l.text || '').slice(0, 4000),
      confidence: null,
      is_final: true,
    })).filter((r) => r.text.trim());

    try {
      const n = await db.addTranscript(key, rows);
      report.transcript = { ok: true, written: Number.isFinite(Number(n)) ? Number(n) : rows.length, reason: '' };
    } catch (e) {
      report.transcript = { ok: false, written: 0, reason: String((e && e.message) || e).slice(0, 200) };
      console.error(`recap-store: transcript write failed for ${key}: ${report.transcript.reason}`);
    }
  } else {
    report.transcript.reason = 'ElevenLabs sent no transcript lines for this conversation';
  }

  // ── 3. the event ────────────────────────────────────────────────────────────────────────────
  try {
    await db.addEvent(key, 'el_post_call', {
      conversation_id: input.conversation_id || null,
      agent_id: input.agent_id || null,
      from: input.from || null,
      to: input.to || null,
      duration_seconds: input.duration_seconds ?? null,
      transcript_lines: lines.length,
      disclosure: disclosure.heard,
      disclosure_verified: disclosure.all,
    });
    report.event = { ok: true, reason: '' };
  } catch (e) {
    report.event = { ok: false, reason: String((e && e.message) || e).slice(0, 200) };
  }

  return report;
}

// ── the delivery ledger ────────────────────────────────────────────────────────────────────────

/**
 * Take the right to deliver this recap on this channel. Race free: the winner is decided by a
 * unique index inside one statement, not by a read followed by a write.
 * Returns { claimed, row, ok, reason }. `claimed:false` with `ok:true` means somebody else has it.
 */
export async function claimDelivery(key, channel, conversationId) {
  if (!db.dbConfigured()) {
    // ★ FAIL OPEN, LOUDLY, AND SAY SO. With no ledger there is no way to know whether this recap
    // already went. Refusing to send would mean a spine outage silently costs every shop its
    // transcript; sending is the lesser harm, and the caller reports that it was unguarded.
    return { ok: false, claimed: true, unguarded: true, reason: 'the delivery ledger is unavailable (the call spine is not configured), so this send is not protected against a duplicate' };
  }
  try {
    const r = await db.rpc('sv_recap_claim', { p_key: key, p_channel: channel, p_conversation_id: conversationId || null });
    return { ok: true, claimed: Boolean(r && r.claimed), row: (r && r.row) || null, reason: '' };
  } catch (e) {
    const reason = String((e && e.message) || e).slice(0, 200);
    console.error(`recap-store: claim failed for ${key}/${channel}: ${reason}`);
    return { ok: false, claimed: true, unguarded: true, reason: `the delivery ledger could not be reached (${reason}), so this send is not protected against a duplicate` };
  }
}

export async function settleDelivery(key, channel, { status, target, providerId, reason, lines } = {}) {
  if (!db.dbConfigured()) return { ok: false, reason: 'spine not configured' };
  try {
    const row = await db.rpc('sv_recap_settle', {
      p_key: key, p_channel: channel, p_status: status,
      p_target: target || null, p_provider_id: providerId || null,
      p_reason: reason ? String(reason).slice(0, 400) : null,
      p_lines: Number.isFinite(Number(lines)) ? Number(lines) : null,
    });
    return { ok: true, row };
  } catch (e) {
    const why = String((e && e.message) || e).slice(0, 200);
    console.error(`recap-store: settle failed for ${key}/${channel}: ${why}`);
    return { ok: false, reason: why };
  }
}

export async function deliveries(key) {
  if (!db.dbConfigured()) return [];
  try { return await db.rpc('sv_recap_deliveries', { p_key: key }); } catch { return []; }
}
