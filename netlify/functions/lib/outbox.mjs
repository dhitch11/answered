// outbox.mjs — the ONE way anything in this codebase tells the outside world something happened.
//
// Three channels, one path, one honest report:
//   email(...)      Resend. Real attachments, real failures surfaced to the caller.
//   crmLog(...)     HubSpot contact upsert + note + task. Hard rule 6, in the send loop.
//   webhook(...)    an HMAC-signed POST to whatever URL the operator configured.
//
// EVERY function here returns { ok, skipped?, reason, ... } and NEVER throws for an expected
// condition. That is the point. A caller has to be able to say, in the response body it hands
// back, exactly which of the three landed and which did not, because the alternative is the
// failure mode this estate keeps paying for: a cheerful 200 over a channel that did nothing.
// `skipped:true` means "not configured, so it truthfully did not happen" and is never dressed up
// as success.
//
// SMS IS NOT A CHANNEL HERE, ON PURPOSE. The A2P 10DLC campaign has failed three times, so a text
// message from this system does not arrive. Nothing in this file may claim one will. Email is the
// honest channel until a campaign passes; when it does, an sms() sibling goes here and the callers
// change one line.
//
// Secrets by env name only: RESEND_API_KEY, HUBSPOT_TOKEN, ANSWERED_WEBHOOK_URL,
// ANSWERED_WEBHOOK_SECRET, ADMIN_EMAILS. None of them is ever logged or echoed in a response.

import crypto from 'node:crypto';

const tSig = (ms) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

export const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Where operator notifications go. ADMIN_EMAILS is a comma list; David is the floor, never zero. */
export function owners() {
  const raw = String(process.env.ADMIN_EMAILS || '').trim();
  const list = raw.split(/[,\s;]+/).map((s) => s.trim()).filter((s) => s.includes('@'));
  return list.length ? list : ['David@Reddenda.com'];
}

// ── email ────────────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} m
 * @param {string[]} m.to
 * @param {string} m.subject
 * @param {string} m.html
 * @param {string} m.text        always send one; a text/plain part is what makes a receipt
 *                               readable in a truck, and its absence hurts deliverability
 * @param {string} [m.replyTo]
 * @param {{filename:string, content:string|Buffer, contentType?:string}[]} [m.attachments]
 */
export async function email(m) {
  const KEY = String(process.env.RESEND_API_KEY || '').trim();
  if (!KEY) return { ok: false, skipped: true, reason: 'RESEND_API_KEY is not set' };

  const to = (Array.isArray(m.to) ? m.to : [m.to]).map((s) => String(s || '').trim()).filter((s) => s.includes('@'));
  if (!to.length) return { ok: false, skipped: true, reason: 'no usable recipient' };

  const body = {
    from: m.from || 'Answered <info@reddenda.com>',
    to,
    subject: String(m.subject || '(no subject)').slice(0, 200),
    html: m.html,
    text: m.text,
  };
  if (m.replyTo) body.reply_to = m.replyTo;
  if (m.attachments && m.attachments.length) {
    body.attachments = m.attachments.map((a) => ({
      filename: a.filename,
      content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : Buffer.from(String(a.content), 'utf8').toString('base64'),
      ...(a.contentType ? { content_type: a.contentType } : {}),
    }));
  }

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: tSig(8000),
    });
    const text = await r.text().catch(() => '');
    if (!r.ok) {
      console.error(`outbox email failed: status ${r.status} ${text.slice(0, 240)}`);
      return { ok: false, reason: `resend ${r.status}`, detail: text.slice(0, 240) };
    }
    let id = '';
    try { id = (JSON.parse(text) || {}).id || ''; } catch { /* an id we cannot read is not a failure */ }
    return { ok: true, id, to };
  } catch (e) {
    console.error(`outbox email threw: ${String((e && e.message) || e).slice(0, 200)}`);
    return { ok: false, reason: 'resend unreachable' };
  }
}

// ── HubSpot ──────────────────────────────────────────────────────────────────────────────────

const NOTE_TO_CONTACT = 202;
const TASK_TO_CONTACT = 204;

async function hs(token, method, path, payload) {
  const r = await fetch(`https://api.hubapi.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: tSig(4000),
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* non-JSON error body, kept as text */ }
  return { ok: r.ok, status: r.status, data, text: text.slice(0, 300) };
}

/**
 * Contact upsert + note + task, associated, in this request.
 *
 * ★ DEDUPE ON WHATEVER IDENTIFIER WE ACTUALLY HAVE. A booked job usually arrives with a phone and
 * no email, because the caller spoke it. The obvious implementation searches by email, finds
 * nothing, creates a contact, and does that again on the next call from the same person: HubSpot
 * fills with duplicates of one customer and the CRM stops being worth reading. So: search by email
 * when there is one, otherwise search by phone, and refuse to write at all when there is neither
 * rather than minting an anonymous contact nobody can ever match.
 */
export async function crmLog({ email: addr, phone, name, noteHtml, taskSubject, taskBody, taskHours = 4 }) {
  const token = String(process.env.HUBSPOT_TOKEN || '').trim();
  if (!token) return { ok: false, skipped: true, reason: 'HUBSPOT_TOKEN is not set' };

  const cleanEmail = String(addr || '').trim().toLowerCase();
  const cleanPhone = String(phone || '').trim();
  if (!cleanEmail && !cleanPhone) {
    return { ok: false, skipped: true, reason: 'no email and no phone, so nothing could be deduped against' };
  }

  const by = cleanEmail
    ? { propertyName: 'email', operator: 'EQ', value: cleanEmail }
    : { propertyName: 'phone', operator: 'EQ', value: cleanPhone };

  const search = await hs(token, 'POST', '/crm/v3/objects/contacts/search', {
    filterGroups: [{ filters: [by] }],
    properties: ['email', 'phone'],
    limit: 1,
  }).catch((e) => ({ ok: false, status: 0, text: String((e && e.message) || e) }));
  if (!search.ok) {
    console.error(`rule-6 HubSpot search failed: status ${search.status} ${search.text}`);
    return { ok: false, reason: `hubspot search ${search.status}` };
  }

  const props = {    // Answered/Reddenda separation (David 2026-08-14): every record this
    // product writes lands in its own HubSpot property group and is obvious on
    // sight. Untagged would be indistinguishable from a Reddenda contact.
    answered_product: 'answered',
    answered_source: 'outbox',
};
  if (cleanEmail) props.email = cleanEmail;
  if (cleanPhone) props.phone = cleanPhone;
  if (name) {
    const sp = String(name).lastIndexOf(' ');
    props.firstname = sp > 0 ? String(name).slice(0, sp) : String(name);
    if (sp > 0) props.lastname = String(name).slice(sp + 1);
  }

  const found = search.data && search.data.results && search.data.results[0];
  let contactId = found && found.id ? found.id : null;
  if (contactId) {
    const upd = await hs(token, 'PATCH', `/crm/v3/objects/contacts/${contactId}`, { properties: props })
      .catch((e) => ({ ok: false, status: 0, text: String((e && e.message) || e) }));
    if (!upd.ok) console.error(`rule-6 HubSpot update failed: status ${upd.status} ${upd.text}`);
  } else {
    const crt = await hs(token, 'POST', '/crm/v3/objects/contacts', { properties: props })
      .catch((e) => ({ ok: false, status: 0, text: String((e && e.message) || e) }));
    if (!crt.ok || !(crt.data && crt.data.id)) {
      console.error(`rule-6 HubSpot create failed: status ${crt.status} ${crt.text}`);
      return { ok: false, reason: `hubspot create ${crt.status}` };
    }
    contactId = crt.data.id;
  }

  const out = { ok: true, contactId, note: false, task: false };

  if (noteHtml) {
    const n = await hs(token, 'POST', '/crm/v3/objects/notes', {
      properties: { hs_timestamp: new Date().toISOString(), hs_note_body: '<p><b>[ANSWERED]</b> <i>This record belongs to Answered, not Reddenda.</i></p>' + noteHtml },
      associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_CONTACT }] }],
    }).catch((e) => ({ ok: false, status: 0, text: String((e && e.message) || e) }));
    if (!n.ok) console.error(`rule-6 HubSpot note failed: status ${n.status} ${n.text}`);
    out.note = Boolean(n.ok);
  }

  if (taskSubject) {
    const t = await hs(token, 'POST', '/crm/v3/objects/tasks', {
      properties: {
        hs_timestamp: new Date(Date.now() + taskHours * 3600 * 1000).toISOString(),
        hs_task_subject: '[ANSWERED] ' + String(taskSubject).slice(0, 240),
        hs_task_body: String(taskBody || '').slice(0, 4000),
        hs_task_status: 'NOT_STARTED',
        hs_task_priority: 'HIGH',
        hs_task_type: 'TODO',
      },
      associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: TASK_TO_CONTACT }] }],
    }).catch((e) => ({ ok: false, status: 0, text: String((e && e.message) || e) }));
    if (!t.ok) console.error(`rule-6 HubSpot task failed: status ${t.status} ${t.text}`);
    out.task = Boolean(t.ok);
  }

  return out;
}

// ── outbound webhook ─────────────────────────────────────────────────────────────────────────

export const WEBHOOK_SIG_HEADER = 'X-Answered-Signature';

/**
 * The signature covers `${timestamp}.${body}`, not the body alone, so a captured payload cannot be
 * replayed a week later against a receiver that checks the clock. Receivers should reject a
 * timestamp more than five minutes old and compare in constant time.
 */
export function signWebhook(secret, timestamp, body) {
  return `t=${timestamp},v1=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export async function webhook(eventName, payload) {
  const url = String(process.env.ANSWERED_WEBHOOK_URL || '').trim();
  if (!url) return { ok: false, skipped: true, reason: 'ANSWERED_WEBHOOK_URL is not set, so nothing was notified' };

  // An operator pasting an http:// URL would ship a customer's name, address and phone number in
  // clear text across the internet. Refuse, loudly, rather than doing it quietly.
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, reason: 'ANSWERED_WEBHOOK_URL is not a URL' }; }
  if (parsed.protocol !== 'https:') {
    console.error('outbox webhook refused: ANSWERED_WEBHOOK_URL is not https, and this payload carries customer contact details');
    return { ok: false, reason: 'webhook URL must be https' };
  }

  const secret = String(process.env.ANSWERED_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    console.error('outbox webhook refused: ANSWERED_WEBHOOK_URL is set but ANSWERED_WEBHOOK_SECRET is not, and an unsigned webhook cannot be trusted by its receiver');
    return { ok: false, reason: 'ANSWERED_WEBHOOK_SECRET is not set' };
  }

  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ event: eventName, sent_at: new Date().toISOString(), data: payload });

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Answered-Webhooks/1.0',
        'X-Answered-Event': eventName,
        [WEBHOOK_SIG_HEADER]: signWebhook(secret, ts, body),
      },
      body,
      signal: tSig(6000),
    });
    if (!r.ok) {
      console.error(`outbox webhook ${eventName} rejected: status ${r.status}`);
      return { ok: false, reason: `receiver returned ${r.status}` };
    }
    return { ok: true, status: r.status };
  } catch (e) {
    console.error(`outbox webhook ${eventName} unreachable: ${String((e && e.message) || e).slice(0, 160)}`);
    return { ok: false, reason: 'receiver unreachable' };
  }
}

// ── shared chrome for every email this system sends ──────────────────────────────────────────
//
// Inline styles only, a table nobody has to scroll, and a text/plain twin. No web fonts, no
// remote images, no tracking pixel: an email that phones home is an email a contractor's spam
// filter throws away, and we do not need to know when he opened it.

/**
 * ★ MEASURED AT 390px, AND THE FIRST VERSION OVERFLOWED BY 37 PIXELS.
 * The detail-rows table had no width and no layout algorithm, so it sized itself to its content
 * and pushed 409px of table through a 354px column. A phone shows that as a body you have to drag
 * sideways to read, which on a job receipt is the difference between a contractor trusting the
 * thing and deleting it. Three properties fix it and all three matter:
 *   width:100%          stop shrink-to-fit sizing the table to its widest cell
 *   table-layout:fixed  honour the declared column width instead of the content's opinion
 *   overflow-wrap:anywhere  a long street address or a job id has to be allowed to break
 * `width` is also set on the label cell as an attribute-style value because Outlook's Word engine
 * ignores table-layout and needs the column width stated outright.
 */
export function shell({ title, intro, rows = [], body = '', footer = '', cta = null }) {
  const line = (label, value) =>
    `<tr><td width="96" style="width:96px;padding:7px 16px 7px 0;color:#6B6459;vertical-align:top;font-size:13px;overflow-wrap:anywhere">${esc(label)}</td>` +
    `<td style="padding:7px 0;color:#0B0C0E;font-size:15px;overflow-wrap:anywhere"><b>${esc(value)}</b></td></tr>`;
  return [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#0B0C0E;max-width:640px">',
    `<h2 style="font-size:19px;margin:0 0 10px;font-weight:700">${esc(title)}</h2>`,
    intro ? `<p style="margin:0 0 18px;color:#3A3730">${intro}</p>` : '',
    rows.length ? `<table width="100%" style="width:100%;table-layout:fixed;border-collapse:collapse;margin:0 0 18px">${rows.map((r) => line(r[0], r[1])).join('')}</table>` : '',
    body,
    cta ? `<p style="margin:22px 0"><a href="${esc(cta.href)}" style="background:#0B0C0E;color:#E3FF4F;text-decoration:none;padding:13px 22px;border-radius:8px;font-weight:700;display:inline-block">${esc(cta.label)}</a></p>` : '',
    footer ? `<p style="font-size:12.5px;color:#6B6459;margin:24px 0 0;padding-top:14px;border-top:1px solid #E4E8E2">${footer}</p>` : '',
    '</div>',
  ].filter(Boolean).join('');
}
