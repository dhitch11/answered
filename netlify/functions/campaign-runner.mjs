// campaign-runner — autopilot. Runs every minute and dials, or stops itself.
//
// It places calls to strangers with no human watching, so the interesting part of this file is
// not the dialling. It is the five conditions under which it refuses to.
//
//   1. ANSWERED_AUTOPILOT_KILL is set          one env var stops every campaign, everywhere
//   2. the stop rate is climbing               people are asking to be removed: the script is
//                                              wrong, and no amount of volume fixes a wrong script
//   3. almost everything is being refused       the corpus or the gate is misconfigured; dialling
//                                              on would just burn line reputation for nothing
//   4. the daily cap is reached                 per campaign and per line
//   5. too many calls are already in flight     concurrency
//
// Conditions 2 and 3 HALT the campaign and write the reason where an operator will read it.
// Halting is deliberately sticky: a halted campaign does not resume on its own, because whatever
// caused it needs a human to look at it.
//
// Outside calling hours the gate returns HOLD for every number and the runner simply does
// nothing. That is not an error state and it does not halt anything.

import * as db from './lib/db.mjs';
import { placeCall } from './lib/dial.mjs';

const KILL = () => Boolean((process.env.ANSWERED_AUTOPILOT_KILL || '').trim());
const DAILY_CAP = () => Number(process.env.ANSWERED_AUTOPILOT_DAILY_CAP || 250);

// Health thresholds. Deliberately conservative: this is a research campaign, not a sales floor.
const STOP_RATE_LIMIT = 0.05;   // 5% of recent attempts asking to be removed
const STOP_RATE_MIN_N = 20;     // ...measured over at least this many attempts
const REFUSAL_RATE_LIMIT = 0.9; // 90% of recent attempts refused by the gate
const REFUSAL_MIN_N = 25;

function healthCheck(c) {
  const r = c.recent || {};
  const n = Number(r.attempts || 0);
  if (n >= STOP_RATE_MIN_N) {
    const stopRate = Number(r.stopped || 0) / n;
    if (stopRate > STOP_RATE_LIMIT) {
      return `halted automatically: ${(stopRate * 100).toFixed(0)}% of the last ${n} calls asked to be removed. `
        + 'That is the script being wrong, not the list. Read the transcripts before resuming.';
    }
  }
  if (n >= REFUSAL_MIN_N) {
    const refusalRate = Number(r.refused || 0) / n;
    if (refusalRate > REFUSAL_RATE_LIMIT) {
      return `halted automatically: the gate refused ${(refusalRate * 100).toFixed(0)}% of the last ${n} numbers. `
        + 'The list is the wrong shape or the line-type sweep has not run. Nothing to fix by dialling more.';
    }
  }
  return null;
}

export default async () => {
  if (!db.dbConfigured()) {
    console.error('campaign-runner: call spine not configured; standing down.');
    return new Response('not configured', { status: 503 });
  }
  if (KILL()) {
    console.error('campaign-runner: ANSWERED_AUTOPILOT_KILL is set; every campaign stands down.');
    return new Response(JSON.stringify({ killed: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  const report = { at: new Date().toISOString(), campaigns: [] };

  let state;
  try {
    state = await db.rpc('sv_autopilot_state');
  } catch (e) {
    console.error('campaign-runner: could not read state:', String(e.message).slice(0, 160));
    return new Response('state read failed', { status: 502 });
  }

  for (const c of state || []) {
    const line = { id: c.id, name: c.name, placed: 0, refused: 0, skipped: null };

    const halt = healthCheck(c);
    if (halt) {
      await db.rpc('sv_halt', { p_id: c.id, p_reason: halt });
      console.error(`campaign-runner: HALTED "${c.name}" — ${halt}`);
      line.skipped = 'halted';
      line.halt_reason = halt;
      report.campaigns.push(line);
      continue;
    }

    if (Number(c.placed_today || 0) >= DAILY_CAP()) { line.skipped = 'daily cap'; report.campaigns.push(line); continue; }

    const room = Math.max(0, Number(c.max_concurrent || 3) - Number(c.in_flight || 0));
    if (room === 0) { line.skipped = 'at concurrency'; report.campaigns.push(line); continue; }

    const budget = Math.min(room, Number(c.pacing_per_min || 4), DAILY_CAP() - Number(c.placed_today || 0));
    if (budget <= 0) { line.skipped = 'no budget this minute'; report.campaigns.push(line); continue; }

    let batch;
    try {
      batch = await db.rpc('sv_claim', { p_campaign: c.id, p_limit: budget });
    } catch (e) {
      console.error('campaign-runner: claim failed:', String(e.message).slice(0, 160));
      line.skipped = 'claim failed';
      report.campaigns.push(line);
      continue;
    }
    if (!batch || !batch.length) { line.skipped = 'queue empty'; report.campaigns.push(line); continue; }

    for (const contact of batch) {
      try {
        const res = await placeCall({
          phone: contact.phone,
          contact,
          mode: c.mode,
          operator: 'autopilot',
          campaignId: c.id,
        });
        if (res.placed) {
          line.placed += 1;
        } else {
          line.refused += 1;
          // A number held for the hour goes back in the queue rather than being consumed. A
          // number refused on its merits stays claimed so it is not tried again every minute.
          if (res.retryAt) await db.rpc('sv_release', { p_id: contact.id });
        }
      } catch (e) {
        // ★ DO NOT RELEASE ON AN UNKNOWN FAILURE. createCall can succeed (the phone is already
        // ringing) and the row write can then throw on an RPC timeout. Releasing here put the
        // contact back in the claimable queue, and the next minute's tick redialled someone who
        // was mid-conversation. A contact left claimed costs one missed call; a contact released
        // wrongly costs a redial loop against a real person.
        console.error(`campaign-runner: dial failed for ${contact.phone}:`, String(e.message).slice(0, 160));
        await db.addEvent(null, 'dial_failed_left_claimed', { phone: contact.phone, contact: contact.id, error: String(e.message).slice(0, 200) }).catch(() => {});
      }
    }
    report.campaigns.push(line);
  }

  // Roll the per-line daily counters over at the start of the Pacific day.
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', hour12: false }).format(new Date()));
  const minute = new Date().getMinutes();
  if (hour === 0 && minute < 2) {
    try { report.rolled = await db.rpc('sv_roll_day'); } catch { /* the counters are cosmetic */ }
  }

  return new Response(JSON.stringify(report), { headers: { 'Content-Type': 'application/json' } });
};

export const config = { schedule: '* * * * *' };
