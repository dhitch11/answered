// account-notify.mjs : the email and the CRM write that ride along with every account event.
//
// Two rules shape this file.
//
// Rule 6 of the estate: a send that does not log is a bug. A business owner who signs up is a
// lead, and the moment he exists in our database he exists in HubSpot too, with a note that says
// what he asked for and a task that says what to do about it.
//
// The other rule is local and harder: THE LOGIN EMAIL IS NOT BEST EFFORT. Everything else here
// may fail quietly and be caught up later. If the link does not send, the person is standing in
// front of a page that says "check your email" with nothing coming, so `sendLoginLink` reports
// its failure to the caller and the caller tells the truth on the page.
//
// Association type ids and the from-address match netlify/functions/interest.js deliberately, so
// a contact is one contact whichever door he came through. If that file's CRM block is ever
// lifted into a shared module, this should follow it.

const NOTE_TO_CONTACT = 202;
const TASK_TO_CONTACT = 204;
const FROM = 'Answered <info@reddenda.com>';
const OPERATOR = 'David@Reddenda.com';

const tSig = (ms) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(ms) : undefined;

export const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').slice(0, 4000);

// ── email ────────────────────────────────────────────────────────────────────────────────────

async function send({ to, subject, html, text, replyTo }) {
  const KEY = (process.env.RESEND_API_KEY || '').trim();
  if (!KEY) return { ok: false, why: 'RESEND_API_KEY is not set' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: Array.isArray(to) ? to : [to], subject, html, text, reply_to: replyTo }),
      signal: tSig(6000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { ok: false, why: `resend ${r.status}`, detail: body.slice(0, 200) };
    }
    const j = await r.json().catch(() => ({}));
    return { ok: true, id: j.id || null };
  } catch (e) {
    return { ok: false, why: String((e && e.message) || e).slice(0, 160) };
  }
}

/**
 * The one email that is allowed to fail loudly. Returns { ok } and never throws; the endpoint
 * turns a false into an honest message rather than a cheerful "check your email".
 */
export function sendLoginLink({ email, businessName, url, isNew }) {
  const text = [
    isNew ? `Your Answered account for ${businessName} is started.` : 'Here is your sign-in link for Answered.',
    '',
    'Open this to sign in. It works once and it stops working in twenty minutes.',
    url,
    '',
    'If you did not ask for this, ignore it. Nothing happens until the link is opened.',
    '',
    'Answered',
    'https://answered.reddenda.com',
  ].join('\n');
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;color:#0B0C0E">
<p>${isNew ? `Your Answered account for <b>${esc(businessName)}</b> is started.` : 'Here is your sign-in link for Answered.'}</p>
<p><a href="${esc(url)}" style="display:inline-block;background:#0B0C0E;color:#E3FF4F;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Sign in</a></p>
<p style="color:#5A626B">It works once and it stops working in twenty minutes.</p>
<p style="color:#5A626B;word-break:break-all">${esc(url)}</p>
<p style="color:#5A626B">If you did not ask for this, ignore it. Nothing happens until the link is opened.</p>
<p>Answered<br><a href="https://answered.reddenda.com" style="color:#0B0C0E">answered.reddenda.com</a></p></div>`;
  return send({ to: email, subject: 'Your Answered sign-in link', html, text });
}

/** Operator mail. Best effort: it must never be the reason an owner's signup fails. */
export function notifyOperator({ subject, lines, replyTo }) {
  const text = lines.join('\n');
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;color:#0B0C0E">
${lines.map((l) => (l ? `<p style="margin:4px 0">${esc(l)}</p>` : '<p></p>')).join('\n')}</div>`;
  return send({ to: OPERATOR, subject, html, text, replyTo });
}

// ── HubSpot ──────────────────────────────────────────────────────────────────────────────────

const hs = async (token, method, path, payload) => {
  try {
    const r = await fetch(`https://api.hubapi.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: tSig(3000),
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* non-JSON error body */ }
    return { ok: r.ok, status: r.status, data, text: text.slice(0, 300) };
  } catch (e) {
    return { ok: false, status: 0, text: String((e && e.message) || e).slice(0, 200) };
  }
};

/**
 * Score in code, from the payload alone, and write the rubric into the note. Never into an
 * invented CRM property: a number in a custom field nobody can explain is worse than no number.
 */
export function scoreAccount(a) {
  let score = 0;
  const parts = [];
  if (a.status === 'awaiting_line') { score += 45; parts.push('asked for a line +45'); }
  else if (a.status === 'ready') { score += 30; parts.push('rules complete +30'); }
  else if (a.email_verified_at) { score += 15; parts.push('email confirmed +15'); }
  if (a.owner_phone) { score += 15; parts.push('phone given +15'); }
  if (a.trade) { score += 10; parts.push('trade given +10'); }
  const svc = a.config && Array.isArray(a.config.services) ? a.config.services.length : 0;
  if (svc >= 3) { score += 10; parts.push('three or more services listed +10'); }
  return { score, parts };
}

/** Contact upsert + scored note + task. Best effort, loud on failure, never throws. */
export async function logAccountToHubSpot(account, event) {
  const token = (process.env.HUBSPOT_TOKEN || '').trim();
  if (!token) { console.error('rule-6: HUBSPOT_TOKEN not set, account logging skipped'); return { ok: false }; }

  const email = account.owner_email;
  const search = await hs(token, 'POST', '/crm/v3/objects/contacts/search', {
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
    properties: ['email'], limit: 1,
  });
  if (!search.ok) { console.error(`rule-6 contact search failed ${search.status} ${search.text}`); return { ok: false }; }

  const props = { email, company: account.business_name };
  if (account.owner_name) {
    const sp = account.owner_name.lastIndexOf(' ');
    props.firstname = sp > 0 ? account.owner_name.slice(0, sp) : account.owner_name;
    if (sp > 0) props.lastname = account.owner_name.slice(sp + 1);
  }
  if (account.owner_phone) props.phone = account.owner_phone;

  const found = search.data?.results?.[0];
  let contactId = found?.id || null;
  if (contactId) {
    const upd = await hs(token, 'PATCH', `/crm/v3/objects/contacts/${contactId}`, { properties: props });
    if (!upd.ok) console.error(`rule-6 contact update failed ${upd.status} ${upd.text}`);
  } else {
    const crt = await hs(token, 'POST', '/crm/v3/objects/contacts', { properties: props });
    if (!crt.ok || !crt.data?.id) { console.error(`rule-6 contact create failed ${crt.status} ${crt.text}`); return { ok: false }; }
    contactId = crt.data.id;
  }

  const { score, parts } = scoreAccount(account);
  const missing = Array.isArray(account.missing) ? account.missing : [];
  const noteBody = `<p><b>Answered account: ${esc(event)}</b></p>`
    + `<p>Business: ${esc(account.business_name)}<br>`
    + `Trade: ${esc(account.trade || 'not given')}<br>`
    + `State: ${esc(account.status)}<br>`
    + `Still missing: ${missing.length ? esc(missing.join(', ')) : 'nothing'}<br>`
    + `Account id: ${esc(account.id)}</p>`
    + `<p><b>Lead score: ${score}</b> (${parts.length ? esc(parts.join(', ')) : 'no scoring signals matched'})</p>`
    + '<p>Scored in code by netlify/functions/lib/account-notify.mjs. Rubric: asked for a line +45, '
    + 'rules complete +30, email confirmed +15, phone given +15, trade given +10, three or more services +10.</p>';

  const note = await hs(token, 'POST', '/crm/v3/objects/notes', {
    properties: { hs_timestamp: new Date().toISOString(), hs_note_body: noteBody },
    associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_CONTACT }] }],
  });
  if (!note.ok) console.error(`rule-6 note create failed ${note.status} ${note.text}`);

  // Only the moments that need a human get a task. A saved rule does not.
  if (event === 'signed_up' || event === 'line_requested') {
    const urgent = event === 'line_requested';
    const task = await hs(token, 'POST', '/crm/v3/objects/tasks', {
      properties: {
        hs_timestamp: new Date(Date.now() + (urgent ? 1 : 4) * 3600 * 1000).toISOString(),
        hs_task_subject: urgent
          ? `Answered: assign a number to ${account.business_name}`
          : `Answered: new account ${account.business_name}`,
        hs_task_body: urgent
          ? `${account.business_name} finished its rules and asked for a line. Assigning a number is a manual step today. Account id ${account.id}.`
          : `${account.business_name} started an account. Lead score ${score}. The note carries the full state.`,
        hs_task_status: 'NOT_STARTED',
        hs_task_priority: urgent ? 'HIGH' : 'MEDIUM',
        hs_task_type: 'TODO',
      },
      associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: TASK_TO_CONTACT }] }],
    });
    if (!task.ok) console.error(`rule-6 task create failed ${task.status} ${task.text}`);
  }
  return { ok: true, contactId, score };
}
