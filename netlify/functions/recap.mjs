// POST /api/recap — what was said on the call, delivered to the people who own the line.
//
// The homepage makes one promise about this: "Sends you the transcript inside a minute, by email
// until texting clears." This file is that promise, and until today nothing had ever kept it.
//
// ── THE FOUR THINGS THIS FILE REFUSES TO GET WRONG ─────────────────────────────────────────────
//
// 1. THE WORDS ARE STORED BEFORE THEY ARE SENT. Persisting after delivering means a Resend outage
//    costs a shop the record of a call forever. The transcript goes into the spine first; delivery
//    is a second, independently reported step. See lib/recap-store.mjs.
//
// 2. THE CHANNEL IS CONFIGURATION. `ANSWERED_RECAP_CHANNELS` (default `email`) decides where a
//    recap goes. Email is the honest channel today because the A2P 10DLC campaign a carrier
//    requires is not approved, so a text does not reach a phone. The SMS code is written and real
//    in lib/outbox.mjs; switching it on is `ANSWERED_RECAP_CHANNELS=email,sms` plus
//    `ANSWERED_SMS_ENABLED=1` and a sender. No code changes, no rewrite, and no caller moves.
//
// 3. IT IS NOT AN OPEN RELAY, AND IT IS NOT ADMIN-ONLY EITHER. A recap goes to the shop that owns
//    the line that was called, looked up SERVER SIDE from the number in the call record against
//    `sv_account_for_number` — a live account with a provisioned number and a verified owner
//    email. When no account owns that line (the demo number today), it falls back to ADMIN_EMAILS
//    with David as the floor. An address supplied in the request body is NEVER mailed: that is
//    the whole bug, and it turns an authenticated endpoint into a spam cannon with a password.
//
// 4. AN ABSENCE IS ALWAYS LABELLED WITH ITS CAUSE. A recap with an empty body would read as "the
//    call had no words in it", and a zero that was never measured is a lie. Where the words come
//    from, in order: the request body, then the spine (sv_transcript), then nothing, and in the
//    last case the email says out loud that no transcript was captured and why.
//
// ★ ONE OPERATIONAL FACT ANY LANE READING THIS NEEDS. `answered-canary.mjs` places a REAL call to
// the demo line every two hours. Those are our own monitoring probes, not customers, and mailing
// twelve of them a day is how a real recap ends up in a spam folder. `ANSWERED_RECAP_SKIP_FROM`
// (a comma list of numbers) suppresses the SEND for those and nothing else: the transcript is
// still persisted in full, the ledger still records the skip and its reason, and the default is
// empty so nothing is suppressed unless an operator says so.

import * as out from './lib/outbox.mjs';
import * as store from './lib/recap-store.mjs';
import { authorize } from './lib/bearer.mjs';
import { prettyPhone } from './lib/booking.mjs';

const MAX_BODY = 512 * 1024;   // a long call is a lot of lines
const MAX_LINES = 600;

// ★ TEXTING WENT LIVE 2026-08-16. This said texting was not switched on, which is now false.
export const RECAP_CHANNEL_TRUTH = 'This came by email. Email is the record for a call recap.';

const json = (status, obj) => new Response(JSON.stringify(obj, null, 2), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
});

/** Which channels this deploy is configured to deliver on. Order is delivery order. */
export function channels() {
  const raw = String(process.env.ANSWERED_RECAP_CHANNELS || 'email').toLowerCase();
  const list = raw.split(/[,\s;]+/).map((s) => s.trim()).filter((s) => s === 'email' || s === 'sms');
  return list.length ? [...new Set(list)] : ['email'];
}

/** Numbers that are our own automated probes rather than customers. Empty by default. */
export function skipFrom() {
  return String(process.env.ANSWERED_RECAP_SKIP_FROM || '')
    .split(/[,\s;]+/).map((s) => s.trim()).filter((s) => /^\+\d{8,15}$/.test(s));
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

async function fromSpine(key) {
  try {
    const db = await import('./lib/db.mjs');
    if (!db.dbConfigured()) {
      return { lines: [], reason: 'the call spine is not configured on this deploy (ANSWERED_DB_URL / ANSWERED_DB_ANON / ANSWERED_DB_SECRET)' };
    }
    const rows = await db.transcript(key, 0);
    const lines = normalizeLines(Array.isArray(rows) ? rows : []);
    return { lines, reason: lines.length ? '' : 'the call spine holds no transcript lines for this call' };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 180);
    console.error(`recap: transcript read failed: ${msg}`);
    return { lines: [], reason: `the transcript could not be read from the call spine (${msg})` };
  }
}

/**
 * Who owns the line this call happened on, and therefore who this recap belongs to.
 *
 * The lookup key is the SHOP's number: the number that was dialled on an inbound call, the number
 * we called from on an outbound one. Never the customer's. Returns the operator floor when no
 * account owns the line, and says which of the two it used.
 */
export async function resolveRecipients({ lineNumber }) {
  const fallback = { email: out.owners(), sms: [], source: 'admin', business: '', reason: '' };
  const phone = String(lineNumber || '').trim();
  if (!/^\+\d{8,15}$/.test(phone)) {
    fallback.reason = 'no usable line number on this call, so the recap went to the operator addresses';
    return fallback;
  }
  try {
    const db = await import('./lib/db.mjs');
    if (!db.dbConfigured()) {
      fallback.reason = 'the account directory is unavailable (the call spine is not configured), so the recap went to the operator addresses';
      return fallback;
    }
    const acct = await db.rpc('sv_account_for_number', { p_phone: phone });
    if (!acct || !acct.owner_email) {
      fallback.reason = `no live account owns ${phone}, so the recap went to the operator addresses`;
      return fallback;
    }
    // ★ A VERIFIED ADDRESS OR NOTHING. An account reaches status 'live' through an emailed token,
    // so owner_email is an address its owner proved they read. Mailing an unverified one would be
    // the request-body bug wearing a database.
    if (!acct.email_verified_at) {
      fallback.reason = `the account that owns ${phone} has not verified its email address, so the recap went to the operator addresses instead`;
      return fallback;
    }
    return {
      email: [String(acct.owner_email)],
      sms: /^\+\d{8,15}$/.test(String(acct.owner_phone || '')) ? [String(acct.owner_phone)] : [],
      source: 'account',
      business: String(acct.business_name || ''),
      account_id: acct.id || null,
      reason: '',
    };
  } catch (e) {
    fallback.reason = `the account directory could not be read (${String((e && e.message) || e).slice(0, 120)}), so the recap went to the operator addresses`;
    return fallback;
  }
}

function build({ callSid, from, to, startedAt, seconds, disposition, summary, lines, missingReason, recordingSid, jobUrl, site, smsNote, business }) {
  const when = startedAt ? new Date(startedAt) : null;
  const mins = Number.isFinite(seconds) && seconds > 0
    ? `${Math.floor(seconds / 60)}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`
    : '';

  const rows = [
    business ? ['Line', business] : null,
    from ? ['From', prettyPhone(from) || from] : null,
    to ? ['To', prettyPhone(to) || to] : null,
    when && !Number.isNaN(when.getTime()) ? ['When', when.toUTCString()] : null,
    mins ? ['Length', mins] : null,
    disposition ? ['Outcome', disposition] : null,
    callSid ? ['Call', callSid] : null,
  ].filter(Boolean);

  // ★ A TABLE, NOT AN INLINE-BLOCK LABEL. Rendered at 390px and looked at: a `min-width` span
  // reserves its width on the FIRST line only, so every wrapped line of a long sentence ran back
  // under the speaker label and the two columns stopped being columns. Email clients also drop
  // flex and grid, so the layout that survives Gmail, Outlook and Mail is a table with a fixed
  // first cell. This is the difference between a transcript a contractor can skim in a truck and
  // one he has to re-read to work out who said what.
  const transcriptHtml = lines.length
    ? `<table width="100%" style="width:100%;table-layout:fixed;border-collapse:collapse;border:1px solid #D7DBD3;border-radius:9px;margin:0 0 18px;background:#F7F8F5">${
      lines.map((l) => '<tr>'
        + `<td width="80" style="width:80px;padding:9px 10px 9px 14px;vertical-align:top;font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;color:#57534B;font-weight:700">${out.esc(l.who || '')}</td>`
        + `<td style="padding:9px 14px 9px 0;vertical-align:top;color:#0B0C0E;overflow-wrap:anywhere">${out.esc(l.text)}</td>`
        + '</tr>').join('')
    }</table>`
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
    footer: `${out.esc(smsNote || RECAP_CHANNEL_TRUTH)}<br>Answered${callSid ? ` &middot; ${out.esc(callSid)}` : ''}`,
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
    smsNote || RECAP_CHANNEL_TRUTH,
  ].filter((s) => s !== '').join('\n');

  const who = from ? (prettyPhone(from) || from) : 'an unknown number';
  const subject = `Call recap: ${who}${disposition ? `, ${disposition}` : ''}${mins ? `, ${mins}` : ''}`;

  // The phone version. Short on purpose: a contractor reads this at a job site, and the words
  // themselves are in the email. It never claims to be the full transcript.
  const smsBody = [
    `Answered: call from ${who}${mins ? `, ${mins}` : ''}.`,
    summary ? String(summary).replace(/\s+/g, ' ').slice(0, 320) : '',
    lines.length ? `Full transcript (${lines.length} lines) is in your email.` : `No transcript was captured. ${missingReason || ''}`.trim(),
  ].filter(Boolean).join(' ').slice(0, 900);

  return { html, text, subject, smsBody };
}

/**
 * The whole recap flow, exported so a webhook receiver can reuse it without an HTTP hop.
 * Returns a plain object describing exactly what happened on each channel.
 */
export async function deliverRecap(input, { site = 'https://answered.reddenda.com', persist = false } = {}) {
  const callSid = String(input.call_sid || input.callSid || '').trim();
  const key = store.spineKey({ call_sid: callSid, conversation_id: input.conversation_id });

  // ── 1. STORE FIRST. The record must survive a delivery outage. ───────────────────────────────
  const stored = persist ? await store.persistConversation(input) : null;

  // ── 2. the words ────────────────────────────────────────────────────────────────────────────
  let lines = normalizeLines(input.transcript);
  let missingReason = '';
  if (!lines.length) {
    if (key) {
      const got = await fromSpine(key);
      lines = got.lines;
      missingReason = got.reason;
    } else {
      missingReason = 'no transcript was sent with this recap, and there is no call sid or conversation id to look one up with';
    }
  }

  // ── 3. who it belongs to ────────────────────────────────────────────────────────────────────
  const lineNumber = String(input.direction === 'outbound' ? (input.from || '') : (input.to || '')).trim();
  const who = await resolveRecipients({ lineNumber });

  // ── 4. our own probes are recorded, not mailed ──────────────────────────────────────────────
  const probe = skipFrom().includes(String(input.from || '').trim());
  const wanted = channels();
  const result = {
    ok: false,
    key,
    lines: lines.length,
    transcript_missing_reason: lines.length ? null : missingReason,
    stored,
    recipients: { source: who.source, email_count: who.email.length, sms_count: who.sms.length, why: who.reason || undefined },
    channels_configured: wanted,
    delivery: {},
  };

  if (probe) {
    const reason = `this call came from ${input.from}, which ANSWERED_RECAP_SKIP_FROM lists as one of our own automated probes rather than a customer. The transcript was stored in full; no recap was sent.`;
    for (const ch of wanted) {
      result.delivery[ch] = { ok: false, skipped: true, reason };
      // ★ CLAIM BEFORE SETTLING, even though nothing is being sent. sv_recap_settle only UPDATES,
      // so settling a row that was never claimed writes nothing at all and the skip becomes
      // invisible: the operator sees no delivery and no record of why there was none, which is
      // indistinguishable from the bug this whole file exists to fix.
      //
      // ★ AND ONLY SETTLE IF THE CLAIM WAS WON. Settling unconditionally would let a number added
      // to the skip list later rewrite an older row that already recorded a real delivery, turning
      // "we sent this shop their transcript, here is the provider id" into "we skipped it". A
      // ledger you can overwrite is not a ledger.
      if (key) {
        const claim = await store.claimDelivery(key, ch, input.conversation_id).catch(() => ({ claimed: false }));
        if (claim.claimed) {
          await store.settleDelivery(key, ch, { status: 'skipped', reason, lines: lines.length })
            .catch(() => { /* the ledger note is not worth failing the request over */ });
        } else {
          result.delivery[ch] = { ok: true, duplicate: true, reason: `${reason} A delivery record for this call already exists and was left untouched.` };
        }
      }
    }
    result.ok = true;
    result.probe = true;
    return result;
  }

  // ── 5. SMS FIRST, so the email can tell the truth about it ──────────────────────────────────
  // Building the email before attempting the text would force the footer to describe a channel
  // whose outcome is not known yet, and a sentence that guesses is a sentence that lies.
  let smsNote = '';
  if (wanted.includes('sms')) {
    const claim = key ? await store.claimDelivery(key, 'sms', input.conversation_id) : { ok: true, claimed: true };
    if (!claim.claimed) {
      result.delivery.sms = { ok: true, duplicate: true, reason: 'a text for this call was already sent or is being sent right now' };
    } else {
      const built = build({ callSid: key, from: input.from, to: input.to, startedAt: input.started_at, seconds: Number(input.duration_seconds), disposition: input.disposition, summary: input.summary, lines, missingReason, site, business: who.business });
      const target = who.sms[0] || '';
      const r = target ? await out.sms({ to: target, body: built.smsBody, transactional: true })
        : { ok: false, skipped: true, reason: 'nobody on this line has a phone number on file to text' };
      result.delivery.sms = { ...r, unguarded: claim.unguarded || undefined };
      if (key) await store.settleDelivery(key, 'sms', { status: r.ok ? 'sent' : (r.skipped ? 'skipped' : 'failed'), target, providerId: r.id, reason: r.reason, lines: lines.length }).catch(() => {});
      smsNote = r.ok ? `We also texted a short version of this to ${target}.` : `We did not text you: ${r.reason || 'the text could not be sent'}`;
    }
  }

  const built = build({
    callSid: key,
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
    smsNote,
    business: who.business,
  });

  // ── 6. email ────────────────────────────────────────────────────────────────────────────────
  if (wanted.includes('email')) {
    const claim = key ? await store.claimDelivery(key, 'email', input.conversation_id) : { ok: true, claimed: true };
    if (!claim.claimed) {
      result.delivery.email = { ok: true, duplicate: true, reason: 'a recap email for this call was already sent or is being sent right now' };
    } else {
      const mail = await out.email({ to: who.email, subject: built.subject, html: built.html, text: built.text });
      result.delivery.email = { ...mail, unguarded: claim.unguarded || undefined };
      if (key) await store.settleDelivery(key, 'email', { status: mail.ok ? 'sent' : (mail.skipped ? 'skipped' : 'failed'), target: who.email.join(', '), providerId: mail.id, reason: mail.reason, lines: lines.length }).catch(() => {});
    }
  }

  // ── 7. the operator fan-out, unchanged and still optional ───────────────────────────────────
  result.delivery.webhook = await out.webhook('call.recap', {
    call_sid: callSid, key, from: input.from, to: input.to,
    started_at: input.started_at, duration_seconds: input.duration_seconds,
    disposition: input.disposition, summary: input.summary,
    transcript_lines: lines.length, job_url: input.job_url || null,
    delivered_to: who.source,
  }).catch((e) => ({ ok: false, reason: String((e && e.message) || e).slice(0, 160) }));

  const em = result.delivery.email;
  const sm = result.delivery.sms;
  result.ok = Boolean((em && (em.ok || em.duplicate)) || (sm && (sm.ok || sm.duplicate)));
  return result;
}

export default async (req) => {
  if (req.method !== 'POST') {
    return json(405, {
      ok: false,
      error: 'POST only.',
      how: 'POST /api/recap with Authorization: Bearer <secret> and { call_sid } or { call_sid, transcript: [{speaker,text}], from, to, started_at, duration_seconds, disposition, summary, recording_sid, job_url, persist }.',
      note: 'A recap goes to the account that owns the line that was called, looked up server side, or to ADMIN_EMAILS when no account owns it. This endpoint will never mail an address supplied in the request.',
      channels: channels(),
      sms: out.smsStatus(),
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

  const result = await deliverRecap(input, { site, persist: input.persist === true });
  if (!result.ok) {
    return json(502, { ...result, error: 'The recap could not be delivered to anyone, so nothing is claiming it was.' });
  }
  return json(200, { ...result, authorized_by: auth.as });
};

export const config = { path: '/api/recap' };
