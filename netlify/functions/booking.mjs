// POST /api/booking — a call becomes a job on somebody's calendar.
//
// This is the endpoint the whole product points at. Everything else on this site is an argument
// that a missed call can turn into a booked job; this is where that actually happens.
//
// THE ONE RULE THAT SHAPES THIS FILE: a booking is not booked until somebody has been told.
// So the owner notification is the only step allowed to fail the request. If Resend will not take
// the message, this returns 502 and says why, because a 201 the shop never sees is the worst
// possible outcome: the customer has been told a van is coming and nobody knows.
//
// Everything after that step is best effort AND IS REPORTED INDIVIDUALLY in the response body:
//
//   delivery.owner_email      required. 502 if it fails.
//   delivery.customer_email   only when the customer gave an address, with the .ics attached.
//   delivery.crm              HubSpot upsert + note + task (hard rule 6).
//   delivery.webhook          signed POST to ANSWERED_WEBHOOK_URL.
//   delivery.durable          best-effort telemetry copy. CANNOT break the link (see lib/booking).
//   delivery.job              the QUERYABLE, JOINED copy of this job (see lib/jobs.mjs). Second
//                             write, deliberately non-fatal, joined to accounts.id by the number
//                             that was DIALLED. Until this existed a booked job belonged to nobody
//                             and "show me this customer's jobs" had no answer.
//   delivery.sms              ALWAYS { skipped: true }, with the real reason, forever, until the
//                             A2P campaign passes. Nothing here may claim a text arrives.
//
// Nothing in that list is allowed to report `ok:true` unless it happened. `skipped:true` means it
// truthfully did not happen and is never dressed up as success.
//
// Auth: Authorization: Bearer <ANSWERED_BOOKING_SECRET | ANSWERED_COCKPIT_KEY | ANSWERED_BRAIN_SECRET>.
// See lib/bearer.mjs for why the third is accepted here and nowhere that dials or spends.

import * as bk from './lib/booking.mjs';
import * as out from './lib/outbox.mjs';
import * as jobs from './lib/jobs.mjs';
import { authorize } from './lib/bearer.mjs';

const MAX_BODY = 16 * 1024;

const json = (status, obj) => new Response(JSON.stringify(obj, null, 2), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
});

// The one sentence about texting, in one place, so it can never drift between surfaces.
export const SMS_TRUTH = 'Answered did not text anyone about this job. Text messaging is not switched on yet, so email is the channel that actually delivers.';

/**
 * Best effort, and it is allowed to fail. The customer's link does not depend on it.
 *
 * ★ A FAILURE IS NOT A SKIP, and the first version of this function reported one as the other.
 * It returned `{ skipped: true, reason: 'blob store FAILED' }`, which reads to anything parsing
 * the response as "we chose not to", when what actually happened was "we tried and could not".
 * That is the exact shape of dishonesty the rest of this file exists to prevent, and it got in
 * anyway because `skipped: !ok` collapses two different facts into one boolean. They are separate
 * fields now: `wrote` is what landed, `failed` is what was attempted and did not.
 */
async function durable(job, token) {
  const wrote = [];
  const failed = [];
  const skipped = [];

  if (job.cs) {
    try {
      const db = await import('./lib/db.mjs');
      if (db.dbConfigured()) {
        await db.addEvent(job.cs, 'job_booked', { job_id: job.id, mode: job.m, starts_at: job.t, service: job.w });
        wrote.push('call spine');
      } else {
        skipped.push('call spine (ANSWERED_DB_* not set)');
      }
    } catch (e) {
      console.error(`booking durable spine write failed: ${String((e && e.message) || e).slice(0, 160)}`);
      failed.push(`call spine (${String((e && e.message) || e).slice(0, 90)})`);
    }
  }

  try {
    const blobs = await import('@netlify/blobs');
    const store = blobs.getStore('bookings');
    await store.setJSON(`${job.t.slice(0, 10)}/${job.id}`, { job, token_length: token.length });
    wrote.push('blob store');
  } catch (e) {
    // MEASURED on prod 2026-08-14: @netlify/blobs does not resolve in this runtime. That is a
    // deploy defect, it is filed in .terminal-claims.md, and it is exactly why nothing
    // customer-facing in this flow reads from a store.
    console.error(`booking durable blob write failed: ${String((e && e.message) || e).slice(0, 160)}`);
    failed.push(`blob store (${String((e && e.message) || e).slice(0, 90)})`);
  }

  return {
    ok: wrote.length > 0,
    wrote,
    failed,
    skipped,
    reason: wrote.length
      ? `wrote to ${wrote.join(' and ')}`
      : `no durable copy was written. ${failed.length ? `Failed: ${failed.join('; ')}. ` : ''}${skipped.length ? `Not configured: ${skipped.join('; ')}. ` : ''}The job link does not depend on this.`,
  };
}

function ownerMail(job, links) {
  const w = bk.whenParts(job);
  const rows = [
    ['When', `${w.day}, ${w.window}${w.zone ? ` ${w.zone}` : ''}`],
    ['Customer', job.c],
    ...(job.cp ? [['Phone', bk.prettyPhone(job.cp)]] : []),
    ...(job.ce ? [['Email', job.ce]] : []),
    ...(job.a ? [['Address', job.a]] : []),
    ['Job', job.w],
    ...(job.n ? [['Notes', job.n]] : []),
    ['Job number', job.id],
  ];
  const demoBand = job.m === 'demo'
    ? '<p style="margin:0 0 18px;padding:12px 14px;background:#FFF8D6;border-left:3px solid #0B0C0E;font-size:14px"><b>This is a demo booking.</b> It came from the Answered demo line, where the booking is pretend. Nobody is being dispatched.</p>'
    : '';
  const callLine = job.cp
    ? `<p style="margin:0 0 6px">Call them back: <a href="tel:${out.esc(job.cp)}" style="color:#0B0C0E"><b>${out.esc(bk.prettyPhone(job.cp))}</b></a></p>`
    : '<p style="margin:0 0 6px">No phone number was captured on this call, so there is no number to call back.</p>';

  return {
    subject: `${job.m === 'demo' ? '[demo] ' : ''}Booked: ${job.w} for ${job.c}, ${w.day} ${w.window}`,
    html: out.shell({
      title: 'A call turned into a job.',
      intro: `<b>${out.esc(job.s)}</b> has a new booking. The calendar file is attached, and the job page is below.`,
      rows,
      body: demoBand + callLine,
      cta: { href: links.job, label: 'Open the job page' },
      footer: `${out.esc(SMS_TRUTH)}<br>Answered &middot; job ${out.esc(job.id)} &middot; booked ${out.esc(job.at)}`,
    }),
    text: [
      `${job.m === 'demo' ? 'DEMO BOOKING (nobody is being dispatched).\n' : ''}A call turned into a job for ${job.s}.`,
      '',
      ...rows.map(([k, v]) => `${k}: ${v}`),
      '',
      `Job page: ${links.job}`,
      `Calendar file: ${links.ics}`,
      '',
      SMS_TRUTH,
    ].join('\n'),
  };
}

function customerMail(job, links) {
  const w = bk.whenParts(job);
  const changeIt = job.sp
    ? `Need to move it or cancel? Call ${bk.prettyPhone(job.sp)}.`
    : 'Need to move it or cancel? Reply to this email.';
  const rows = [
    ['When', `${w.day}, ${w.window}${w.zone ? ` ${w.zone}` : ''}`],
    ['Who is coming', job.s],
    ...(job.a ? [['Where', job.a]] : []),
    ['What for', job.w],
    ['Job number', job.id],
  ];
  const demoBand = job.m === 'demo'
    ? '<p style="margin:0 0 18px;padding:12px 14px;background:#FFF8D6;border-left:3px solid #0B0C0E;font-size:14px"><b>Heads up: this is a demo.</b> You reached the Answered demo line, so this booking is pretend and nobody is coming out.</p>'
    : '';
  const callBtn = job.sp
    ? `<p style="margin:0 0 14px">Call the shop: <a href="tel:${out.esc(job.sp)}" style="color:#0B0C0E"><b>${out.esc(bk.prettyPhone(job.sp))}</b></a></p>`
    : '';

  return {
    subject: `${job.m === 'demo' ? '[demo] ' : ''}You are booked with ${job.s}: ${w.day}, ${w.window}`,
    html: out.shell({
      title: 'You are on the schedule.',
      intro: `Here is your booking with <b>${out.esc(job.s)}</b>. The calendar file is attached, so you can add it to your phone in one tap.`,
      rows,
      body: demoBand + callBtn,
      cta: { href: links.job, label: 'See it and add it to your calendar' },
      footer: `${out.esc(changeIt)}<br>Booked for you by Answered. We did not send you a text, because text messaging is not switched on yet.`,
    }),
    text: [
      `${job.m === 'demo' ? 'DEMO: you reached the Answered demo line, so this booking is pretend and nobody is coming out.\n' : ''}You are on the schedule with ${job.s}.`,
      '',
      ...rows.map(([k, v]) => `${k}: ${v}`),
      '',
      changeIt,
      `Add it to your calendar: ${links.ics}`,
      `Your job page: ${links.job}`,
      '',
      'Booked for you by Answered. We did not send you a text, because text messaging is not switched on yet.',
    ].join('\n'),
  };
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { Allow: 'POST, OPTIONS' } });
  if (req.method !== 'POST') {
    return json(405, {
      ok: false,
      error: 'POST only.',
      how: 'POST /api/booking with Authorization: Bearer <secret> and a JSON body: { shop_name, shop_phone, line_number, customer_name, customer_phone, customer_email, address, service, starts_at, minutes, tz, notes, call_sid, source, mode }.',
      required: ['shop_name', 'customer_name', 'service', 'starts_at'],
      notes: {
        line_number: 'The number the caller DIALLED. This is how the job finds its owning account, so a booking without it is recorded with no owner and will not appear in a customer portal. shop_phone is used as the fallback.',
        source: 'Free text. It is categorised into one of voice, form, operator, api for the job record, and the raw string you sent is kept beside it.',
      },
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

  const { ok, errors, job } = bk.normalize(input);
  if (!ok) return json(422, { ok: false, error: 'That is not a bookable job yet.', problems: errors });

  if (!bk.canSign()) {
    console.error('booking: refusing to book because no signing key is configured (ANSWERED_BOOKING_KEY)');
    return json(503, {
      ok: false,
      error: 'Bookings are off because no signing key is configured on this deploy.',
      fix: 'Set ANSWERED_BOOKING_KEY. Nothing is being minted unsigned.',
    });
  }

  let token;
  try { token = bk.mint(job); } catch (e) {
    return json(500, { ok: false, error: String((e && e.message) || e) });
  }
  const links = { job: bk.jobUrl(token), ics: bk.icsUrl(token) };
  const calendar = bk.ics(job, { url: links.job });
  const attachment = { filename: `${job.id}.ics`, content: calendar, contentType: 'text/calendar; charset=utf-8; method=PUBLISH' };

  // ── step one, and the only one allowed to fail the request ────────────────────────────────
  const om = ownerMail(job, links);
  const ownerRes = await out.email({
    to: out.owners(),
    subject: om.subject,
    html: om.html,
    text: om.text,
    replyTo: job.ce || undefined,
    attachments: [attachment],
  });
  if (!ownerRes.ok) {
    console.error(`booking ${job.id} NOT CONFIRMED: the shop could not be notified (${ownerRes.reason})`);
    return json(502, {
      ok: false,
      error: 'The job was not booked, because the shop could not be told about it.',
      reason: ownerRes.reason,
      note: 'Nothing was confirmed to the customer. Retry, or take this one by hand.',
    });
  }

  // ── everything else: parallel, individually reported, never fatal ─────────────────────────
  const noteHtml =
    `<p><b>Answered booked a job${job.m === 'demo' ? ' (demo line, pretend booking)' : ''}</b></p>` +
    `<p>Shop: ${out.esc(job.s)}<br>` +
    `When: ${out.esc(`${bk.whenParts(job).day}, ${bk.whenParts(job).window}`)}<br>` +
    `Job: ${out.esc(job.w)}<br>` +
    `Address: ${out.esc(job.a || 'not captured')}<br>` +
    `Notes: ${out.esc(job.n || 'none')}<br>` +
    `Job number: ${out.esc(job.id)}${job.cs ? `<br>Call: ${out.esc(job.cs)}` : ''}</p>` +
    `<p>Job page: <a href="${out.esc(links.job)}">${out.esc(links.job)}</a></p>` +
    `<p>${out.esc(SMS_TRUTH)}</p>`;

  const [customerRes, crmRes, hookRes, durableRes, jobRes] = await Promise.all([
    job.ce
      ? (async () => {
        const cm = customerMail(job, links);
        return out.email({ to: [job.ce], subject: cm.subject, html: cm.html, text: cm.text, attachments: [attachment] });
      })()
      : Promise.resolve({ ok: false, skipped: true, reason: 'the customer did not give an email address' }),
    out.crmLog({
      email: job.ce, phone: job.cp, name: job.c,
      noteHtml,
      taskSubject: `${job.m === 'demo' ? '[demo] ' : ''}Job booked by Answered: ${job.w} for ${job.c}`,
      taskBody: `${bk.whenParts(job).day}, ${bk.whenParts(job).window}. ${job.a || 'No address captured.'} Job page: ${links.job}`,
    }).catch((e) => ({ ok: false, reason: String((e && e.message) || e).slice(0, 160) })),
    out.webhook('job.booked', {
      id: job.id, mode: job.m, shop: job.s, customer: job.c, phone: job.cp, email: job.ce,
      address: job.a, service: job.w, starts_at: job.t, minutes: job.d, tz: job.tz,
      notes: job.n, call_sid: job.cs, url: links.job, ics_url: links.ics,
    }).catch((e) => ({ ok: false, reason: String((e && e.message) || e).slice(0, 160) })),
    durable(job, token).catch((e) => ({ ok: false, reason: String((e && e.message) || e).slice(0, 160) })),
    // ── THE JOB RECORD: the second write, and the one that gives this booking an owner ────────
    //
    // It runs beside the raw log, never in front of it, and it can never fail the request. The
    // customer has already been emailed by the time this line runs. lib/jobs.mjs never throws, and
    // this .catch() is the belt on top of the braces because a booking that already succeeded must
    // not be able to 500 on the way out of the building.
    jobs.recordBooking(job).catch((e) => ({
      ok: false, landed: false, reason: String((e && e.message) || e).slice(0, 160),
    })),
  ]);

  // A job that landed with no owner is invisible to every query that walks accounts, so it is said
  // out loud at the moment it is created rather than discovered later underneath a confident empty
  // state. This is the orphan defect that already cost this estate a billing panel.
  if (jobRes && jobRes.landed && !jobRes.account_matched) {
    console.warn(`booking ${job.id}: recorded with NO OWNING ACCOUNT. ${jobRes.orphan_warning}`);
  }
  if (jobRes && !jobRes.landed) {
    console.error(`booking ${job.id}: the queryable job row did NOT land (${jobRes.reason}). The booking itself succeeded: the customer has the link and the shop has the email.`);
  }

  return json(201, {
    ok: true,
    id: job.id,
    mode: job.m,
    url: links.job,
    ics_url: links.ics,
    starts_at: job.t,
    authorized_by: auth.as,
    delivery: {
      owner_email: { ok: true, to: ownerRes.to, id: ownerRes.id },
      customer_email: customerRes,
      crm: crmRes,
      webhook: hookRes,
      durable: durableRes,
      job: jobRes,
      sms: { ok: false, skipped: true, reason: SMS_TRUTH },
    },
  });
};

export const config = { path: '/api/booking' };
