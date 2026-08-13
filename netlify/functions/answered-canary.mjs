// netlify/functions/answered-canary.mjs
//
// THE DEMO-LINE CANARY. Every run PLACES A REAL CALL across the whole
// integration seam: Twilio REST -> ANSWERED_DEMO_NUMBER -> the EL agent
// answers -> the first sentence out of its mouth carries the disclosure law
// (it must contain BOTH "AI assistant" and "recorded"). The result is written
// to Netlify Blobs store "canary" where /api/demo-health reads it as its
// fourth check. LAW (redesign verdict 2026-08-12): no dialable control
// renders unless a canary that placed a real call recently PASSED; two
// consecutive fails turn the site-wide gate red automatically.
//
// CADENCE: A DELIBERATE ADAPTATION, DOCUMENTED HERE ON PURPOSE. The verdict
// wrote "every 15 minutes". This runs every 2 HOURS ("0 */2 * * *") because a
// canary call is a REAL call: it spends ElevenLabs characters and Twilio
// money on every run, and 96 real calls a day is a character budget the demo
// line itself should be spending. The division of labor that makes 2 hours
// safe: the per-page-load /api/demo-health probes (EL subscription, warm
// bridge ping, Twilio lookup) catch account, bridge, and number failure in
// REAL TIME on every page view; the canary exists to catch the one thing
// those probes cannot see: the integration seam between them, where every
// part looks healthy and the call still dies. That seam breaks rarely and
// silently, and a 2-hour real-call sweep is the honest budget-priced watch
// on it.
//
// HONESTY RULES ENCODED BELOW:
//   - probe_landed facts are reported separately from assertion outcomes in
//     the record (probes.call_placed / conversation_found / disclosure each
//     carry {landed, ok, reason}; a probe that never landed cannot prove a
//     gate works).
//   - Missing env is a FAILING record ("env not set: <names>") and it is
//     rotated into the store like any other result. A canary that cannot run
//     is a failing canary, never a silent pass.
//   - NEVER From == To: EL register-call 400s on self-calls (measured). The
//     run refuses and records the refusal.
//   - Every red is console.error LOUD.
//
// Env, by NAME only (secrets live in the credentials vault and Netlify env):
//   TWILIO_ACCOUNT_SID    the account the call is placed under
//   TWILIO_API_SID        Basic auth username (API key pair)
//   TWILIO_API_SECRET     Basic auth password
//   CANARY_FROM_NUMBER    caller ID for the canary call (estate QA number)
//   ANSWERED_DEMO_NUMBER  the demo line being tested (the To)
//   ELEVENLABS_API_KEY    conversation poll
//   ANSWERED_EL_AGENT_ID  which agent's conversations to poll
//
// Blobs store "canary": key "latest" (newest record), key "prev" (the one
// before it, rotated on every write), plus a dated history key per run.

import { getStore } from '@netlify/blobs';

const TWIML = '<Response><Pause length="14"/></Response>';
const WAIT_MS = 22000; // let the call be answered and the conversation land

function probe(landed, ok, reason) {
  return { landed, ok, reason: reason || '' };
}

function e164(raw) {
  const clean = String(raw || '').trim().replace(/[^+\d]/g, '');
  return /^\+\d{10,15}$/.test(clean) ? clean : null;
}

async function runCanary() {
  const startedAt = new Date();
  const record = {
    ok: false,
    at: startedAt.toISOString(),
    call_sid: null,
    conversation_id: null,
    reason: '',
    // probe_landed facts, separate from assertion outcomes, always
    probes: {
      call_placed: probe(false, false, 'not attempted'),
      conversation_found: probe(false, false, 'not attempted'),
      disclosure: probe(false, false, 'not attempted'),
    },
  };

  // ── env: missing = a failing record, never a silent pass ─────────────────
  const NEED = [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_API_SID',
    'TWILIO_API_SECRET',
    'CANARY_FROM_NUMBER',
    'ANSWERED_DEMO_NUMBER',
    'ELEVENLABS_API_KEY',
    'ANSWERED_EL_AGENT_ID',
  ];
  const missing = NEED.filter((n) => !(process.env[n] || '').trim());
  if (missing.length) {
    record.reason = 'env not set: ' + missing.join(', ');
    return record;
  }

  const from = e164(process.env.CANARY_FROM_NUMBER);
  const to = e164(process.env.ANSWERED_DEMO_NUMBER);
  if (!from) { record.reason = 'CANARY_FROM_NUMBER is not E.164'; return record; }
  if (!to) { record.reason = 'ANSWERED_DEMO_NUMBER is not E.164'; return record; }
  if (from === to) {
    record.reason = 'refusing self-call: CANARY_FROM_NUMBER equals ANSWERED_DEMO_NUMBER (EL register-call 400s on self-calls, measured)';
    return record;
  }

  // ── 1. place the REAL call ───────────────────────────────────────────────
  const accountSid = process.env.TWILIO_ACCOUNT_SID.trim();
  const auth = 'Basic ' + Buffer.from(
    process.env.TWILIO_API_SID.trim() + ':' + process.env.TWILIO_API_SECRET.trim()
  ).toString('base64');
  try {
    const form = new URLSearchParams({ From: from, To: to, Twiml: TWIML });
    const r = await fetch(
      'https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(accountSid) + '/Calls.json',
      {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(8000),
      }
    );
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.sid) {
      const detail = j && j.message ? ': ' + String(j.message).slice(0, 120) : '';
      record.probes.call_placed = probe(true, false, 'Twilio answered ' + r.status + detail);
      record.reason = record.probes.call_placed.reason;
      return record;
    }
    record.call_sid = j.sid;
    record.probes.call_placed = probe(true, true, '');
  } catch (e) {
    record.probes.call_placed = probe(false, false, 'call POST failed: ' + String(e && e.message).slice(0, 100));
    record.reason = record.probes.call_placed.reason;
    return record;
  }

  // ── 2. let the call ride the whole seam ──────────────────────────────────
  await new Promise((resolve) => setTimeout(resolve, WAIT_MS));

  // ── 3. find the conversation this call created ───────────────────────────
  const elKey = process.env.ELEVENLABS_API_KEY.trim();
  const agentId = process.env.ANSWERED_EL_AGENT_ID.trim();
  const startSecs = Math.floor(startedAt.getTime() / 1000);
  try {
    const r = await fetch(
      'https://api.elevenlabs.io/v1/convai/conversations?agent_id=' + encodeURIComponent(agentId) + '&page_size=3',
      { headers: { 'xi-api-key': elKey }, signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) {
      record.probes.conversation_found = probe(true, false, 'conversation list returned ' + r.status);
      record.reason = record.probes.conversation_found.reason;
      return record;
    }
    const j = await r.json().catch(() => null);
    const list = (j && Array.isArray(j.conversations)) ? j.conversations : [];
    // 5s of slack for clock skew between us and EL; at a 2-hour cadence no
    // earlier conversation can be inside that window.
    const hit = list.find(
      (c) => c && typeof c.start_time_unix_secs === 'number' && c.start_time_unix_secs >= startSecs - 5
    );
    if (!hit || !hit.conversation_id) {
      record.probes.conversation_found = probe(true, false, 'no conversation started after the canary call was placed (call_sid ' + record.call_sid + ')');
      record.reason = record.probes.conversation_found.reason;
      return record;
    }
    record.conversation_id = hit.conversation_id;
    record.probes.conversation_found = probe(true, true, '');
  } catch (e) {
    record.probes.conversation_found = probe(false, false, 'conversation list failed: ' + String(e && e.message).slice(0, 100));
    record.reason = record.probes.conversation_found.reason;
    return record;
  }

  // ── 4. the disclosure law: first sentence must self-identify ─────────────
  try {
    const r = await fetch(
      'https://api.elevenlabs.io/v1/convai/conversations/' + encodeURIComponent(record.conversation_id),
      { headers: { 'xi-api-key': elKey }, signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) {
      record.probes.disclosure = probe(true, false, 'conversation detail returned ' + r.status);
      record.reason = record.probes.disclosure.reason;
      return record;
    }
    const j = await r.json().catch(() => null);
    const first = (j && Array.isArray(j.transcript) && j.transcript.length) ? j.transcript[0] : null;
    const msg = (first && typeof first.message === 'string') ? first.message : '';
    if (!msg) {
      record.probes.disclosure = probe(true, false, 'transcript[0] has no message (conversation may still be processing)');
      record.reason = record.probes.disclosure.reason;
      return record;
    }
    const hasAi = msg.includes('AI assistant');
    const hasRecorded = msg.includes('recorded');
    if (hasAi && hasRecorded) {
      record.probes.disclosure = probe(true, true, '');
      record.ok = true;
      record.reason = '';
    } else {
      const lacking = [!hasAi ? '"AI assistant"' : '', !hasRecorded ? '"recorded"' : ''].filter(Boolean).join(' and ');
      record.probes.disclosure = probe(true, false, 'first sentence missing ' + lacking + ': "' + msg.slice(0, 140) + '"');
      record.reason = record.probes.disclosure.reason;
    }
  } catch (e) {
    record.probes.disclosure = probe(false, false, 'conversation detail failed: ' + String(e && e.message).slice(0, 100));
    record.reason = record.probes.disclosure.reason;
  }

  return record;
}

// Rotate: old latest becomes prev, new record becomes latest, and every run
// leaves a dated history key so a bad week is reconstructable.
async function persist(record) {
  const store = getStore('canary');
  let previousLatest = null;
  try {
    previousLatest = await store.get('latest', { type: 'json' });
  } catch (e) {
    console.error('ANSWERED CANARY: could not read previous latest (rotation degrades to overwrite): ' + String(e && e.message).slice(0, 100));
  }
  if (previousLatest) await store.setJSON('prev', previousLatest);
  await store.setJSON('latest', record);
  await store.setJSON('history/' + record.at.replace(/[:.]/g, '-'), record);
}

export default async () => {
  const record = await runCanary();

  if (record.ok) {
    console.log('answered-canary GREEN call_sid=' + record.call_sid + ' conversation_id=' + record.conversation_id);
  } else {
    console.error('ANSWERED CANARY RED: ' + JSON.stringify(record));
  }

  try {
    await persist(record);
  } catch (e) {
    // If this write fails the gate cannot see the result; demo-health will go
    // red on staleness within 3 hours, but say it NOW, loudly.
    console.error('ANSWERED CANARY: blob write FAILED, the gate cannot see this run: ' + String(e && e.message).slice(0, 140));
  }

  return new Response(JSON.stringify(record), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config = { schedule: '0 */2 * * *' };
