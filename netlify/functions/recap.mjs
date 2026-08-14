// POST /api/recap — what was said on the call, delivered to the people who own the line.
//
// The delivery channel is EMAIL, and that is not a preference. The A2P 10DLC campaign has failed
// three times, so a text message from this system does not arrive. Every surface that would
// naturally be a text is an email here, and it says so out loud rather than quietly degrading.
// When a campaign passes, this file gains an sms() call and the copy in RECAP_CHANNEL_TRUTH
// changes in one place.
//
// WHERE THE WORDS COME FROM, in order, and it never invents them:
//   1. `transcript` in the request body, when the caller already has the lines.
//   2. the call spine (sv_transcript), when ANSWERED_DB_* is configured.
//   3. nothing, in which case the email SAYS no transcript was captured and why.
// A recap with an empty body and no explanation would read as "the call had no words in it", and a
// zero that was never measured is a lie. So the absence is always labelled with its cause.
//
// IT IS NOT AN OPEN RELAY. An authenticated endpoint that emails an arbitrary address is a spam
// cannon with a password on it. Recaps go to ADMIN_EMAILS (David is the floor) and nowhere else.
// The day a shop owner has a verified address of their own, this is where that lookup goes, and
// not before: mailing an unverified address because a request body asked us to is the whole bug.

import * as out from './lib/outbox.mjs';
import { authorize } from './lib/bearer.mjs';
import { prettyPhone } from './lib/booking.mjs';

const MAX_BODY = 512 * 1024;   // a long call is a lot of lines
const MAX_LINES = 600;

export const RECAP_CHANNEL_TRUTH = 'This came by email because text messaging is not switched on yet. Nobody was sent a text about this call.';

const json = (status, obj) => new Response(JSON.stringify(obj, null, 2), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
});

// Best-effort duplicate suppression, honestly scoped: this Map lives in ONE warm instance, so a
// cold start or a second container will let a duplicate through. It is deliberately not sold as
// idempotency. A retrying webhook gets at most a second copy of an email, which is a nuisance;
// pretending to be idempotent when we are not would be a lie in a comment.
const sent = new Map();
const SEEN_MS = 6 * 3600 * 1000;
function alreadySent(key) {
  const now = Date.now();
  for (const [k, t] of sent) if (now - t > SEEN_MS) sent.delete(k);
  if (sent.has(key)) return true;
  sent.set(key, now);
  return false;
}

const SPEAKER = { them: 'Caller', us: 'Answered', caller: 'Caller', agent: 'Answered', user: 'Caller', assistant: 'Answered' };
const speakerOf = (s) => SPEAKER[String(s || '').toLowerCase()] || (s ? String(s).slice(0, 24) : 'Unknown');

/** Normalise every shape a transcript arrives in into { who, text }. */
export function normalizeLines(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => {
      if (typeof l === 'string') return { who: '', text: l.trim() };
      if (!l || typeof l !== 'object') return null;
      const text = String(l.text ?? l.message ?? l.transcript ?? '').trim();
      if (!text) return null;
      // Only final lines. Partials would print the same sentence four times, growing.
      if (l.is_final === false) return null;
      return { who: speakerOf(l.speaker ?? l.role ?? l.track), text: text.slice(0, 2000) };
    })
    .filter(Boolean)
    .slice(0, MAX_LINES);
}

async function fromSpine(callSid) {
  try {
    const db = await import('./lib/db.mjs');
    if (!db.dbConfigured()) {
      return { lines: [], reason: 'the call spine is not configured on this deploy (ANSWERED_DB_URL / ANSWERED_DB_ANON / ANSWERED_DB_SECRET)' };
    }
    const rows = await db.transcript(callSid, 0);
    const lines = normalizeLines(Array.isArray(rows) ? rows : []);
    return { lines, reason: lines.length ? '' : 'the call spine holds no transcript lines for this call' };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 180);
    console.error(`recap: transcript read failed: ${msg}`);
    return { lines: [], reason: `the transcript could not be read from the call spine (${msg})` };
  }
}

function build({ callSid, from, to, startedAt, seconds, disposition, summary, lines, missingReason, recordingSid, jobUrl, site }) {
  const when = startedAt ? new Date(startedAt) : null;
  const mins = Number.isFinite(seconds) && seconds > 0
    ? `${Math.floor(seconds / 60)}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`
    : '';

  const rows = [
    from ? ['From', prettyPhone(from) || from] : null,
    to ? ['To', prettyPhone(to) || to] : null,
    when && !Number.isNaN(when.getTime()) ? ['When', when.toUTCString()] : null,
    mins ? ['Length', mins] : null,
    disposition ? ['Outcome', disposition] : null,
    callSid ? ['Call', callSid] : null,
  ].filter(Boolean);

  const transcriptHtml = lines.length
    ? `<div style="border:1px solid #D7DBD3;border-radius:9px;padding:4px 14px;margin:0 0 18px;background:#F7F8F5">${
      lines.map((l) => `<p style="margin:11px 0"><span style="display:inline-block;min-width:74px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#57534B;font-weight:700;vertical-align:top">${out.esc(l.who || '')}</span> <span style="color:#0B0C0E">${out.esc(l.text)}</span></p>`).join('')
    }</div>`
    : `<p style="margin:0 0 18px;padding:12px 14px;background:#FFF8D6;border-left:3px solid #0B0C0E;font-size:14px"><b>No transcript was captured for this call.</b><br>${out.esc(missingReason || 'No reason was recorded, which is itself a defect worth chasing.')}</p>`;

  const extras = [];
  if (jobUrl) extras.push(`<p style="margin:0 0 9px"><b>This call became a job.</b> <a href="${out.esc(jobUrl)}" style="color:#0B0C0E">Open the job page</a></p>`);
  if (recordingSid) {
    extras.push(`<p style="margin:0 0 9px"><b>Recording:</b> <a href="${out.esc(`${site}/api/recording?sid=${encodeURIComponent(recordingSid)}`)}" style="color:#0B0C0E">play it in the console</a>. You have to be signed in to the operator console first, on purpose: a recording link that plays for anyone who has the URL is a customer's voice loose on the internet.</p>`);
  }

  const summaryHtml = summary
    ? `<p style="margin:0 0 18px;padding:12px 14px;background:#fff;border:1px solid #D7DBD3;border-radius:9px"><b>Summary:</b> ${out.esc(summary)}</p>`
    : '';

  const html = out.shell({
    title: lines.length ? 'Here is the call, word for word.' : 'A call came in, and here is what we know.',
    intro: '',
    rows,
    body: summaryHtml + transcriptHtml + extras.join(''),
    footer: `${out.esc(RECAP_CHANNEL_TRUTH)}<br>Answered${callSid ? ` &middot; ${out.esc(callSid)}` : ''}`,
  });

  const text = [
    lines.length ? 'Call transcript' : 'Call recap (no transcript captured)',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    summary ? `Summary: ${summary}\n` : '',
    lines.length
      ? lines.map((l) => `${(l.who || '').padEnd(9)} ${l.text}`).join('\n')
      : `No transcript was captured. ${missingReason || ''}`,
    '',
    jobUrl ? `This call became a job: ${jobUrl}` : '',
    recordingSid ? `Recording (sign in to the console first): ${site}/api/recording?sid=${recordingSid}` : '',
    '',
    RECAP_CHANNEL_TRUTH,
  ].filter((s) => s !== '').join('\n');

  const who = from ? (prettyPhone(from) || from) : 'an unknown number';
  const subject = `Call recap: ${who}${disposition ? `, ${disposition}` : ''}${mins ? `, ${mins}` : ''}`;

  return { html, text, subject };
}

/**
 * The whole recap flow, exported so a webhook receiver can reuse it without an HTTP hop.
 * Returns a plain object describing exactly what happened on each channel.
 */
export async function deliverRecap(input, { site = 'https://answered.reddenda.com' } = {}) {
  const callSid = String(input.call_sid || input.callSid || '').trim();
  const key = callSid || `noSid:${input.from || ''}:${input.started_at || ''}`;

  let lines = normalizeLines(input.transcript);
  let missingReason = '';
  if (!lines.length) {
    if (callSid && /^CA[0-9a-f]{32}$/i.test(callSid)) {
      const got = await fromSpine(callSid);
      lines = got.lines;
      missingReason = got.reason;
    } else {
      missingReason = 'no transcript was sent with this recap, and there is no Twilio call sid to look one up with';
    }
  }

  if (alreadySent(key)) {
    return { ok: true, duplicate: true, note: 'A recap for this call already went out from this instance, so nothing was sent again. Duplicate suppression is per warm instance and is best effort.', lines: lines.length };
  }

  const built = build({
    callSid,
    from: input.from, to: input.to,
    startedAt: input.started_at || input.startedAt,
    seconds: Number(input.duration_seconds ?? input.seconds),
    disposition: input.disposition ? String(input.disposition).slice(0, 80) : '',
    summary: input.summary ? String(input.summary).slice(0, 1500) : '',
    lines,
    missingReason,
    recordingSid: /^RE[0-9a-f]{32}$/i.test(String(input.recording_sid || '')) ? String(input.recording_sid) : '',
    jobUrl: /^https:\/\//.test(String(input.job_url || '')) ? String(input.job_url) : '',
    site,
  });

  const [mail, hook] = await Promise.all([
    out.email({ to: out.owners(), subject: built.subject, html: built.html, text: built.text }),
    out.webhook('call.recap', {
      call_sid: callSid, from: input.from, to: input.to,
      started_at: input.started_at, duration_seconds: input.duration_seconds,
      disposition: input.disposition, summary: input.summary,
      transcript_lines: lines.length, job_url: input.job_url || null,
    }).catch((e) => ({ ok: false, reason: String((e && e.message) || e).slice(0, 160) })),
  ]);

  return {
    ok: Boolean(mail.ok),
    lines: lines.length,
    transcript_missing_reason: lines.length ? null : missingReason,
    delivery: {
      email: mail,
      webhook: hook,
      sms: { ok: false, skipped: true, reason: RECAP_CHANNEL_TRUTH },
    },
  };
}

export default async (req) => {
  if (req.method !== 'POST') {
    return json(405, {
      ok: false,
      error: 'POST only.',
      how: 'POST /api/recap with Authorization: Bearer <secret> and { call_sid } or { call_sid, transcript: [{speaker,text}], from, to, started_at, duration_seconds, disposition, summary, recording_sid, job_url }.',
      note: 'Recaps go to ADMIN_EMAILS only. This endpoint will not mail an address supplied in the request.',
    });
  }

  const headers = Object.fromEntries(req.headers.entries());
  const auth = authorize(headers);
  if (!auth.ok) return json(auth.status, { ok: false, error: auth.message });

  let raw = '';
  try { raw = await req.text(); } catch { return json(400, { ok: false, error: 'Could not read the request body.' }); }
  if (raw.length > MAX_BODY) return json(413, { ok: false, error: `Body is over the ${MAX_BODY} byte cap.` });

  let input;
  try { input = JSON.parse(raw || '{}'); } catch { return json(400, { ok: false, error: 'Body must be JSON.' }); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return json(400, { ok: false, error: 'Body must be a JSON object.' });

  const site = new URL(req.url).origin.startsWith('http://127.0.0.1')
    ? 'https://answered.reddenda.com'
    : new URL(req.url).origin;

  const result = await deliverRecap(input, { site });
  if (!result.ok && !result.duplicate) {
    return json(502, { ...result, error: 'The recap could not be delivered to anyone, so nothing is claiming it was.' });
  }
  return json(200, { ...result, authorized_by: auth.as });
};

export const config = { path: '/api/recap' };
