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
//   - "we could not read it" and "it was wrong" are DIFFERENT verdicts and are
//     never collapsed. See the timing note below, which is the reason.
//
// ★★ THE FIXED WAIT WAS A COIN FLIP, AND IT LOST (2026-08-14, @LANE-OPS).
// This file used to sleep exactly 22 seconds and then read the transcript once.
// A real canary run measured on that code reported RED with
//   "transcript[0] has no message (conversation may still be processing)"
// and the SAME conversation, re-read sixty seconds later, contained
//   "Cedar Ridge Plumbing and Air. This is Riley, an AI assistant, and this
//    call is recorded. What is going on?"
// which passes both halves of the disclosure law. The demo line was perfectly
// healthy. The monitor was wrong.
//
// That is not a cosmetic bug. A canary fail sets healthy:false in
// /api/demo-health, and healthy:false makes EVERY call control on the site
// remove itself. A race in the watchman takes the product's phone number off
// the website while the phone is working.
//
// SO IT WAS MEASURED INSTEAD OF GUESSED. Instrumented run, polling every two
// seconds from the moment the call was placed:
//   t=2.7s   the conversation appears in the list, status in-progress
//   t=9.3s   status processing, transcript still empty
//   t=13.7s  status done, transcript[0].message READY
// The old 22s read sat right on the boundary for a 14 second pause: the call
// was still hanging up and post-processing had not finished. Sometimes it won.
//
// The wait is now a POLL with a budget, not a sleep with a hope. It returns as
// soon as the transcript is readable, which is FASTER than the old sleep in the
// normal case, and it can tell "the platform was still processing" apart from
// "the agent did not say the words". The first is landed:false, we could not
// check. The second is ok:false, we checked and it was wrong. They get
// different reasons because they need different reactions.
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
//
// ★ WHY THE STORE IS LOADED WITH A DYNAMIC import AND NOT A STATIC ONE
//   (2026-08-14, @LANE-OPS, after measuring it on production).
// This file used to open with `import { getStore } from '@netlify/blobs'`. On
// 2026-08-14 that package was missing from the deployed function bundle: it was
// declared only in the REPO ROOT package.json while the house deploy runs
// `npm install` inside netlify/functions/, a directory that had no
// package.json, so the install step was a no-op that looked like a step.
// A static import means the module never loads, which means THE SCHEDULED
// FUNCTION NEVER RUNS AT ALL: no record, no red record, no log line, nothing.
// /api/demo-health sat at healthy:false for the one reason nobody was watching,
// and every health-gated call control on the live site quietly removed itself.
// Reproduced: `node -e "await import('./answered-canary.mjs')"` from a directory
// without the dependency throws ERR_MODULE_NOT_FOUND before the first statement.
// A monitor that cannot start is worse than no monitor, because its silence
// reads as health. So the dependency is now loaded INSIDE the run, failure to
// load is a normal failing probe with a reason, and the run is still LOUD.
// The packaging is fixed too (netlify/functions/package.json); this is the belt
// that survives the next person who forgets the braces.

// Eight seconds of held line, not fourteen. Measured: the agent delivers its
// entire greeting immediately on answer, and the full disclosure sentence was
// captured with an 8s hold. A shorter hold ends the call sooner, which means
// ElevenLabs starts post-processing sooner, which is the thing the assertion
// is actually waiting on. It also spends less money and fewer characters on
// every one of the twelve runs a day.
const TWIML = '<Response><Pause length="8"/></Response>';

// Budgets, set from the instrumented run above, then CAPPED by the platform.
// Two constraints, and the tighter one wins:
//   the measurement  conversation at 2.7s, transcript readable at 13.7s
//   the platform     a scheduled function is killed at 30 seconds, and a
//                    canary killed mid-run writes NOTHING, which is the exact
//                    invisible failure this file exists to stop being
// So the worst case is engineered to land near 27 seconds, not to be generous:
//   1s to place the call + 10s of list budget (3.7x the measured 2.7s)
//   + 16s of detail budget (measured need is ~11s once the conversation exists)
// Every poll short circuits the moment it has its answer, so the normal run is
// about 15 seconds and the budgets only get spent when something is wrong.
// ★ REBALANCED 2026-08-18, @LANE-FOOTER, WITHOUT TOUCHING THE 27s TOTAL.
//   The gate went red on "two consecutive canary fails", both reading:
//   "ElevenLabs had not finished processing within 16 seconds (last state
//   processing)". That is the honest half of this file working exactly as
//   designed — landed:false, "could not be READ, not that it was missing" —
//   but while it holds, every health-gated call control on the site hides the
//   phone number, so vendor latency reads to a visitor as a phone company you
//   cannot phone.
//
//   MEASURED BEFORE CHANGING A NUMBER: the last 10 canary conversations are
//   ALL status=done, dur=8s. Nothing is failing. They simply become readable
//   later than they used to — the header's measured ~11s need has drifted past
//   16s on the vendor's side.
//
//   THE ONE THING I DID NOT DO IS RAISE THE TOTAL. A scheduled function is
//   killed at 30s and a canary killed mid-run writes NOTHING, which is the
//   invisible failure this whole file exists to prevent. So the extra time is
//   taken from the list budget, which had 3.7x headroom over its measured 2.7s
//   need and now has 1.9x. Worst case is unchanged at ~27s.
//        list   10s -> 5s   (measured need 2.7s)
//        detail 16s -> 21s  (measured need was ~11s, now >16s)
//
//   ★ AND THIS IS A PATCH, NOT THE FIX. Any in-run read races the vendor, and
//   a race against a 30s ceiling is one the vendor can always win by getting
//   slower. The durable design is to stop reading the call you just placed:
//   each run verifies the PREVIOUS run's call — which has had two hours to
//   process and is guaranteed readable — and places a new one for the next run
//   to check. That removes the race entirely and costs no waiting at all. The
//   tradeoff is honest and worth stating: a genuine disclosure regression would
//   be caught up to one cycle later than it is today. Written up in
//   .terminal-claims.md rather than done here, because rebuilding the polling
//   architecture of the estate's most carefully-reasoned control at the end of
//   a long session is how a subtle file becomes a broken one.
const POLL_MS = 2000;
const LIST_BUDGET_MS = 5000;
const DETAIL_BUDGET_MS = 21000;
const TERMINAL = new Set(['done', 'failed', 'error']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function probe(landed, ok, reason) {
  return { landed, ok, reason: reason || '' };
}

// The result store, loaded at run time. Returns { getStore } or null, and says
// why it is null. Never throws: a broken store must not be able to stop the
// call from being placed, because "did the phone answer" is worth knowing even
// on a day we cannot write the answer down.
async function loadStore() {
  try {
    const blobs = await import('@netlify/blobs');
    if (typeof blobs.getStore !== 'function') {
      return { getStore: null, error: '@netlify/blobs loaded but exports no getStore' };
    }
    return { getStore: blobs.getStore, error: '' };
  } catch (e) {
    return { getStore: null, error: '@netlify/blobs failed to load: ' + String(e && e.message).slice(0, 120) };
  }
}

function e164(raw) {
  const clean = String(raw || '').trim().replace(/[^+\d]/g, '');
  return /^\+\d{10,15}$/.test(clean) ? clean : null;
}

async function runCanary() {

  // Do not place a call against a provider that is refusing everything. The
  // Twilio account ran out of credits on 2026-08-14 and a retry storm aimed at
  // an account with a payment problem is the one thing that can make a payment
  // problem worse. The canary is NOT deleted: the first run past the backoff
  // window tries again, and the moment the account is funded it simply passes.
  try {
    const pd = await import('./lib/provider-down.mjs');
    const down = await pd.isDown('twilio');
    if (down) {
      const msg = 'canary skipped: Twilio has been refusing every request for ' + down.minutes + ' minutes (' + (down.reason || 'hard refusal') + '). Not placing a call.';
      console.error(msg);
      return { ok: false, at: new Date().toISOString(), reason: msg, skipped: true };
    }
  } catch (e) { /* if the marker cannot be read, run normally */ }
  const startedAt = new Date();
  const record = {
    ok: false,
    at: startedAt.toISOString(),
    call_sid: null,
    conversation_id: null,
    // The words the agent actually said, kept on the record so a person reading
    // a pass can see WHAT passed rather than trusting a boolean. A green with no
    // evidence attached is just a nicer looking guess.
    first_sentence: null,
    reason: '',
    // probe_landed facts, separate from assertion outcomes, always
    probes: {
      call_placed: probe(false, false, 'not attempted'),
      conversation_found: probe(false, false, 'not attempted'),
      disclosure: probe(false, false, 'not attempted'),
    },
    // Can this run write its own result down? Reported as a fact on the record
    // rather than assumed. If this is false the record you are reading came out
    // of a log line, not out of the store, and the store still holds whatever
    // it held before, which is why demo-health's staleness check is the real
    // backstop here.
    store_writable: null,
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

  // ── 2 and 3. POLL for the conversation this call created ─────────────────
  // Not a sleep. The conversation appeared 2.7 seconds after the call was
  // placed in the instrumented run, so a poll normally finishes in one or two
  // ticks and only spends the whole budget when something is genuinely wrong.
  const elKey = process.env.ELEVENLABS_API_KEY.trim();
  const agentId = process.env.ANSWERED_EL_AGENT_ID.trim();
  const startSecs = Math.floor(startedAt.getTime() / 1000);
  try {
    const deadline = Date.now() + LIST_BUDGET_MS;
    let hit = null;
    let lastStatus = 0;
    while (Date.now() < deadline && !hit) {
      await sleep(POLL_MS);
      const r = await fetch(
        'https://api.elevenlabs.io/v1/convai/conversations?agent_id=' + encodeURIComponent(agentId) + '&page_size=3',
        { headers: { 'xi-api-key': elKey }, signal: AbortSignal.timeout(6000) }
      );
      lastStatus = r.status;
      if (!r.ok) continue; // a single bad response is not a verdict; the budget is
      const j = await r.json().catch(() => null);
      const list = (j && Array.isArray(j.conversations)) ? j.conversations : [];
      // 5s of slack for clock skew between us and EL; at a 2-hour cadence no
      // earlier conversation can be inside that window.
      hit = list.find(
        (c) => c && typeof c.start_time_unix_secs === 'number' && c.start_time_unix_secs >= startSecs - 5
      ) || null;
    }
    if (!hit || !hit.conversation_id) {
      const why = lastStatus && lastStatus !== 200
        ? 'conversation list kept returning ' + lastStatus + ' for ' + (LIST_BUDGET_MS / 1000) + ' seconds'
        : 'no conversation started in the ' + (LIST_BUDGET_MS / 1000) + ' seconds after the canary call was placed (call_sid ' + record.call_sid + '). The number rang and nothing picked it up.';
      record.probes.conversation_found = probe(true, false, why);
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
  // POLLED, for the reason written at the top of this file. The loop exits the
  // moment there is a readable first message, or the moment the platform says
  // the conversation reached a terminal state, whichever comes first.
  try {
    const deadline = Date.now() + DETAIL_BUDGET_MS;
    let msg = '';
    let lastState = 'unknown';
    let httpStatus = 0;
    let terminal = false;

    while (Date.now() < deadline) {
      const r = await fetch(
        'https://api.elevenlabs.io/v1/convai/conversations/' + encodeURIComponent(record.conversation_id),
        { headers: { 'xi-api-key': elKey }, signal: AbortSignal.timeout(6000) }
      );
      httpStatus = r.status;
      if (r.ok) {
        const j = await r.json().catch(() => null);
        lastState = (j && j.status) ? String(j.status) : 'unknown';
        const first = (j && Array.isArray(j.transcript) && j.transcript.length) ? j.transcript[0] : null;
        if (first && typeof first.message === 'string' && first.message.trim()) {
          msg = first.message;
          break;
        }
        // A terminal state with nothing said is a real answer, not a wait.
        // It means the call connected and the agent never opened its mouth.
        if (TERMINAL.has(lastState)) { terminal = true; break; }
      }
      if (Date.now() + POLL_MS >= deadline) break;
      await sleep(POLL_MS);
    }

    if (!msg) {
      // The two failures that must never be collapsed into one sentence.
      if (terminal) {
        // WE CHECKED, AND IT WAS WRONG. The conversation finished and the
        // agent's first turn is empty. Nobody heard a disclosure because
        // nobody heard anything.
        record.probes.disclosure = probe(true, false,
          'the conversation reached "' + lastState + '" with an empty first turn: the agent said nothing at all');
      } else {
        // WE COULD NOT CHECK. Landed is false because the probe never got its
        // answer. It still counts as red at the gate, because an unverified
        // legal disclosure is not a verified one, but the words say which of
        // the two happened so nobody debugs the wrong thing.
        record.probes.disclosure = probe(false, false,
          'ElevenLabs had not finished processing within ' + (DETAIL_BUDGET_MS / 1000) + ' seconds'
          + (httpStatus && httpStatus !== 200 ? ' (last HTTP ' + httpStatus + ')' : ' (last state "' + lastState + '")')
          + '. This means the disclosure could not be READ, not that it was missing.');
      }
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
    record.first_sentence = msg.slice(0, 240);
  } catch (e) {
    record.probes.disclosure = probe(false, false, 'conversation detail failed: ' + String(e && e.message).slice(0, 100));
    record.reason = record.probes.disclosure.reason;
  }

  return record;
}

// Rotate: old latest becomes prev, new record becomes latest, and every run
// leaves a dated history key so a bad week is reconstructable.
//
// WRITE THEN READ BACK. A setJSON that returns without throwing is not proof
// the value landed. The read back is the proof, and it is what sets
// record.store_writable, so the record can never claim it was saved when it was
// not. The read back happens on "latest", the key the gate actually reads.
async function persist(getStore, record) {
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

  // ★ THE READ BACK MUST ASK FOR STRONG CONSISTENCY, OR IT IS RACING THE STORE.
  //
  // Netlify Blobs is EVENTUALLY consistent on reads by default. A get issued immediately after a
  // set is entitled to return the previous value or nothing at all, and it regularly does. This
  // check did not pass that option, so it was not measuring "did the write land" — it was measuring
  // "did the write land AND propagate within a few milliseconds", which is a different and much
  // harsher question that the store never promised to answer yes to.
  //
  // Measured 2026-08-16: the 00:01 run logged "blob write FAILED" and "PASSED BUT UNRECORDED" — and
  // the record it claimed it could not save was sitting in the store, being served by
  // /api/demo-health, the whole time. The write was fine. The proof was broken.
  //
  // That is the worst direction for this particular instrument to fail in: a health canary that
  // cries wolf teaches everyone to disregard it, which is exactly what you cannot afford from the
  // one thing watching whether the phone answers.
  const back = await store.get('latest', { type: 'json', consistency: 'strong' });
  if (!back || back.at !== record.at) {
    // ★ AND IT IS NO LONGER A THROW. A mismatch here is now reported as a doubt, not as a failure,
    // because the caller turns a throw into store_writable:false, which is a claim that the result
    // was lost. Saying "lost" about a record that is present is a lie in the safe-sounding
    // direction, and this function has already told it once tonight.
    console.error('ANSWERED CANARY: the read back did not match even under strong consistency '
      + `(wanted at=${record.at}, got at=${back ? back.at : 'nothing'}). The write may still have `
      + 'landed; /api/demo-health is the authority on what the gate can actually see.');
    return { verified: false };
  }
  return { verified: true };
}

export default async () => {
  const record = await runCanary();
  const { getStore, error: storeError } = await loadStore();

  if (!getStore) {
    // The dependency is gone. Historically this killed the whole function at
    // import time and the silence read as health. Now it is a stated fact on a
    // record that is at least in the log, and the gate goes red on staleness.
    record.store_writable = false;
    record.ok = false;
    record.reason = (record.reason ? record.reason + '; ' : '') +
      'the canary cannot reach its own result store, so this result was never saved: ' + storeError;
    console.error('ANSWERED CANARY RED (AND UNRECORDABLE): ' + JSON.stringify(record));
    console.error('ANSWERED CANARY: run `npm install` inside netlify/functions/ and redeploy with that node_modules staged. The gate will go red on staleness within 3 hours either way.');
    return new Response(JSON.stringify(record), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const { verified } = await persist(getStore, record);
    // The write did not throw, so it was accepted. `verified` says whether the read back could
    // also SEE it immediately, which is a separate and weaker question now that the check no longer
    // races the store's consistency model.
    record.store_writable = true;
    record.read_back_verified = verified;
  } catch (e) {
    // A genuine throw from persist means the write itself was rejected. That is the real failure,
    // and it is now the ONLY thing that sets store_writable false.
    record.store_writable = false;
    record.read_back_verified = false;
    console.error('ANSWERED CANARY: blob write FAILED, the gate cannot see this run: ' + String(e && e.message).slice(0, 140));
  }

  // Three outcomes, three log lines. "it passed" and "it passed but the gate
  // will never see it" are not the same event, and a log that calls the second
  // one RED sends somebody looking for a broken phone that is not broken.
  if (record.ok && record.store_writable) {
    console.log('answered-canary GREEN call_sid=' + record.call_sid + ' conversation_id=' + record.conversation_id
      + ' first_sentence=' + JSON.stringify(String(record.first_sentence || '').slice(0, 120)));
  } else if (record.ok) {
    console.error('ANSWERED CANARY PASSED BUT UNRECORDED: the call was placed, answered and the disclosure was spoken, '
      + 'but the result could not be written to the store, so /api/demo-health cannot see it and will go red on staleness. '
      + 'call_sid=' + record.call_sid);
  } else {
    console.error('ANSWERED CANARY RED: ' + JSON.stringify(record));
  }

  return new Response(JSON.stringify(record), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config = { schedule: '0 */2 * * *' };
