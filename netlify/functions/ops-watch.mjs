// ops-watch.mjs — the scheduled watch. Every 10 minutes, forever.
//
// THE ONE THING THIS EXISTS TO PREVENT. On 2026-08-14 the site wide call gate
// was RED on production and had been for an unknown length of time. Every call
// control on the live site was hiding itself. No page said so, no email went
// out, and the scheduled canary that was supposed to notice could not even
// load. Nothing was on fire; it was just quiet. Silence is how this estate
// breaks. So something has to look, on a clock, and say a name out loud.
//
// HOW IT DECIDES TO SPEAK, and why it is not simply "email me when it is red":
//
//   ON A STATE CHANGE          it emails. A new problem is news. A problem that
//                              cleared is also news, because "it is fixed" is
//                              the thing you actually want to hear.
//   ON THE SAME STATE          it says nothing. An alert that repeats every ten
//                              minutes is an alert that gets a filter rule
//                              written for it, and then the estate has a
//                              monitor nobody reads, which is worse than none.
//   ON A RED THAT WILL NOT DIE it speaks again after six hours, once, labelled
//                              as a reminder. Silence and amnesia are different
//                              failures and this is the seam between them.
//
// The comparison is on a FINGERPRINT that deliberately excludes timestamps,
// durations, byte counts and ages. Those change on every single run, so
// including them would make every run look like a change, which is the fastest
// route to a channel nobody trusts.
//
// IT CANNOT PRETEND TO BE ARMED. If RESEND_API_KEY is unset this function
// cannot send anything. It does not skip quietly and it does not log a cheerful
// line. It shouts on every run and it writes armed:false into the record, which
// /internal/ops renders as a red at the top of the page.
//
// Env, by NAME only:
//   RESEND_API_KEY   how it sends. Without it the watch is blind and says so.
//   OPS_ALERT_TO     optional, comma separated. Defaults to David@Reddenda.com.
//   URL              supplied by the platform, the site it measures.

import { collect, summarize, fingerprint } from './lib/ops-status.mjs';

const REMIND_AFTER_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TO = 'David@Reddenda.com';
const OPS_PATH = '/internal/ops';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function loadStore() {
  try {
    const blobs = await import('@netlify/blobs');
    if (typeof blobs.getStore !== 'function') return { store: null, error: '@netlify/blobs exports no getStore' };
    return { store: blobs.getStore('ops'), error: '' };
  } catch (e) {
    return { store: null, error: '@netlify/blobs failed to load: ' + String(e && e.message).slice(0, 120) };
  }
}

// What changed since last time, in the words a person would use.
function diff(prevVerdict, verdict) {
  const was = new Set([...(prevVerdict?.reds || []), ...(prevVerdict?.ambers || [])]);
  const now = new Set([...verdict.reds, ...verdict.ambers]);
  return {
    started: [...now].filter((x) => !was.has(x)),
    cleared: [...was].filter((x) => !now.has(x)),
  };
}

function subjectFor(verdict, d, isReminder) {
  if (isReminder) return 'Answered: still broken, ' + verdict.reds.length + ' red after six hours';
  if (verdict.level === 'green') return 'Answered: back to green, everything measured is up';
  if (d.started.length && d.cleared.length) return 'Answered: ' + d.started.length + ' new, ' + d.cleared.length + ' cleared';
  if (d.cleared.length && !d.started.length) return 'Answered: ' + d.cleared.length + ' cleared, ' + (verdict.reds.length ? verdict.reds.length + ' red left' : 'nothing red left');
  return 'Answered: ' + (verdict.reds.length ? verdict.reds.length + ' red' : verdict.ambers.length + ' amber');
}

function bodyFor(status, verdict, d, isReminder, base) {
  const lines = [];
  lines.push(verdict.headline);
  lines.push('');
  if (isReminder) {
    lines.push('This is a reminder, not a new problem. Nothing has changed in six hours.');
    lines.push('');
  }
  if (d.started.length) {
    lines.push('NEW SINCE THE LAST EMAIL');
    d.started.forEach((x) => lines.push('  - ' + x));
    lines.push('');
  }
  if (d.cleared.length) {
    lines.push('CLEARED SINCE THE LAST EMAIL');
    d.cleared.forEach((x) => lines.push('  - ' + x));
    lines.push('');
  }
  if (verdict.reds.length) {
    lines.push('BROKEN RIGHT NOW');
    verdict.reds.forEach((x) => lines.push('  - ' + x));
    lines.push('');
  }
  if (verdict.ambers.length) {
    lines.push('OFF RIGHT NOW, not broken, just not switched on');
    verdict.ambers.forEach((x) => lines.push('  - ' + x));
    lines.push('');
  }
  lines.push('THE FACTS BEHIND IT');
  lines.push('  call gate healthy: ' + (status.gate.landed ? String(status.gate.healthy) : 'could not be read'));
  lines.push('  one click activation ready: ' + (status.gate.landed ? String(status.gate.outbound_ready) : 'could not be read'));
  lines.push('  last real call canary: ' + (status.canary.latest
    ? (status.canary.latest.ok ? 'passed' : 'FAILED') + ', ' + (status.canary.age_minutes == null ? 'age unknown' : status.canary.age_minutes + ' minutes ago')
    : 'no record has ever been written'));
  const badRoutes = status.routes.filter((r) => !r.skipped && !r.ok);
  lines.push('  routes not answering properly: ' + badRoutes.length + ' of ' + status.routes.length
    + (badRoutes.length ? ' (' + badRoutes.map((r) => r.path).join(', ') + ')' : ''));
  lines.push('');
  lines.push('The full view, with the runbook attached to each line: ' + base + OPS_PATH);
  lines.push('');
  lines.push('Measured ' + status.at + '. This email is sent only when the state changes, or once every six hours while something stays red.');
  return lines.join('\n');
}

async function send(subject, text) {
  const key = (process.env.RESEND_API_KEY || '').trim();
  if (!key) return { sent: false, reason: 'RESEND_API_KEY is not set' };
  const to = (process.env.OPS_ALERT_TO || DEFAULT_TO).split(',').map((s) => s.trim()).filter(Boolean);
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Answered Operations <info@reddenda.com>',
        to,
        subject,
        text,
        html: '<pre style="font:14px/1.5 ui-monospace,Menlo,monospace;color:#1E1B17;white-space:pre-wrap">' + esc(text) + '</pre>',
      }),
      signal: AbortSignal.timeout(9000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { sent: false, reason: 'Resend answered ' + r.status + ' ' + String(j.message || '').slice(0, 140) };
    return { sent: true, id: j.id || null };
  } catch (e) {
    return { sent: false, reason: 'the send never completed: ' + String(e && e.message).slice(0, 140) };
  }
}

export default async () => {
  const status = await collect({ event: {}, timeoutMs: 7000, historyLimit: 4 });
  const verdict = summarize(status);
  const print = fingerprint(status);
  const base = status.base || 'https://answered.reddenda.com';

  const { store, error: storeError } = await loadStore();

  // A watch that cannot remember cannot tell a new problem from an old one. It
  // can still shout, so it does, on every run, rather than going quiet.
  if (!store) {
    console.error('ANSWERED OPS-WATCH: cannot reach its own memory, so every run will look like a change: ' + storeError);
    if (verdict.level !== 'green') {
      const r = await send('Answered: ' + verdict.headline + ' (the watch has no memory)',
        bodyFor(status, verdict, { started: verdict.reds.concat(verdict.ambers), cleared: [] }, false, base)
        + '\n\nNOTE: this watch could not read its own store (' + storeError + '), so it cannot tell you what changed, only what is true now.');
      console.error('ANSWERED OPS-WATCH: memoryless alert ' + (r.sent ? 'sent' : 'NOT SENT, ' + r.reason));
    }
    return new Response(JSON.stringify({ verdict, armed: Boolean((process.env.RESEND_API_KEY || '').trim()), memory: false }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  let prev = null;
  try { prev = await store.get('latest', { type: 'json' }); }
  catch (e) { console.error('ANSWERED OPS-WATCH: could not read the previous state: ' + String(e && e.message).slice(0, 120)); }

  const changed = !prev || prev.fingerprint !== print;
  const lastEmailAt = prev && prev.last_email_at ? Date.parse(prev.last_email_at) : 0;
  const stale = verdict.level === 'red' && lastEmailAt && (Date.now() - lastEmailAt) > REMIND_AFTER_MS;
  const shouldEmail = changed || stale;

  // "we chose not to send" and "we tried to send and could not" are different
  // facts and they must not share a log line. Conflating them puts a routine,
  // correct silence into the error log, and an error log with routine lines in
  // it is an error log nobody reads.
  let mail = { sent: false, deliberate: true, reason: 'no change, nothing to say' };
  if (shouldEmail) {
    const d = diff(prev ? prev.verdict : null, verdict);
    // A first ever run on a green site is not news. Record it and stay quiet.
    if (!prev && verdict.level === 'green') {
      mail = { sent: false, deliberate: true, reason: 'first run and everything is up, nothing worth an email' };
    } else {
      mail = { deliberate: false, ...(await send(subjectFor(verdict, d, stale && !changed), bodyFor(status, verdict, d, stale && !changed, base))) };
    }
  }

  if (!mail.sent && !mail.deliberate) {
    console.error('ANSWERED OPS-WATCH: the state changed and the email did NOT go out: ' + mail.reason);
  }

  const record = {
    at: status.at,
    fingerprint: print,
    verdict,
    armed: Boolean((process.env.RESEND_API_KEY || '').trim()),
    emailed: mail.sent,
    email_reason: mail.sent ? '' : mail.reason,
    last_email_at: mail.sent ? status.at : (prev ? prev.last_email_at || null : null),
    facts: {
      gate_healthy: status.gate.landed ? status.gate.healthy : null,
      outbound_ready: status.gate.landed ? status.gate.outbound_ready : null,
      canary_ok: status.canary.latest ? status.canary.latest.ok : null,
      canary_age_minutes: status.canary.age_minutes ?? null,
      bad_routes: status.routes.filter((r) => !r.skipped && !r.ok).map((r) => r.path),
      env_missing: status.env.vars.filter((v) => !v.set).map((v) => v.name),
    },
  };

  try {
    if (prev) await store.setJSON('prev', prev);
    await store.setJSON('latest', record);
    await store.setJSON('history/' + record.at.replace(/[:.]/g, '-'), record);
    const back = await store.get('latest', { type: 'json' });
    if (!back || back.at !== record.at) throw new Error('the ops store accepted a write that did not read back');
  } catch (e) {
    console.error('ANSWERED OPS-WATCH: could not write its own state, so the next run will re-alert: ' + String(e && e.message).slice(0, 140));
  }

  // One line per run, always, green or red. A log you can grep for a bad week.
  const line = 'answered-ops-watch ' + verdict.level.toUpperCase()
    + ' reds=' + verdict.reds.length + ' ambers=' + verdict.ambers.length
    + ' changed=' + changed + ' emailed=' + mail.sent + (mail.sent ? '' : ' (' + mail.reason + ')');
  if (verdict.level === 'green') console.log(line); else console.error(line + ' :: ' + verdict.reds.join(' | '));

  if (!record.armed) {
    console.error('ANSWERED OPS-WATCH IS UNARMED: RESEND_API_KEY is not set, so nobody is being told about any of this. Set it.');
  }

  return new Response(JSON.stringify(record), { headers: { 'Content-Type': 'application/json' } });
};

export const config = { schedule: '*/10 * * * *' };
