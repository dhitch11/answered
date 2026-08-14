// The interest form's real endpoint.
// Netlify's automatic form detection is OFF for this site, so a form that
// relied on it would render perfectly and silently drop every submission.
// This function owns the whole path instead, and it fails LOUD rather than
// fail open: if the mail provider is unreachable the submitter is told so.
//
// Rule 6 (log everything to HubSpot, in the send loop) lives HERE, in this
// same request, not in a batch job later:
//   1. HubSpot contact upsert (search by email, then create or update).
//   2. A note engagement on that contact carrying the full form payload
//      (product, phone, note, page source) plus a code-computed lead score
//      written into the note body. Rubric, computed in code below:
//      investor or partner +40, business product +25, phone provided +15,
//      note longer than 80 chars +10. No custom CRM properties are invented;
//      the score lives in the note text.
//   3. A task engagement: "Answered interest: <product> - reply today".
//   4. An autoresponder to the submitter via Resend.
// Each of those fails LOUD with its own distinct console.error line, but none
// of them may block the 303 redirect once the notification email to David has
// gone out: a lost CRM log is a bug to fix, a lost lead would be worse.
//
// Secrets by env var name only, never logged, never hardcoded:
//   RESEND_API_KEY - Resend send key (already set on this site).
//   HUBSPOT_TOKEN  - HubSpot private-app token. INTEGRATOR ACTION REQUIRED,
//     this is not set on this site yet. Set it with:
//     netlify env:set HUBSPOT_TOKEN <value> --site 2c9f4ae6-f61c-4c1f-96ba-2a467fec00f3
//     Until it is set, every submission logs
//     "HUBSPOT_TOKEN not set - rule-6 logging skipped" and continues.

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').slice(0, 4000);

// Per-call timeout so a hung third party can never eat the whole function
// budget and turn a successful submission into a gateway error.
const tSig = (ms) =>
  (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(ms) : undefined;

// HubSpot v3 defined association type ids (HUBSPOT_DEFINED category).
const NOTE_TO_CONTACT = 202;
const TASK_TO_CONTACT = 204;

const hubspotCall = async (token, method, path, payload) => {
  const r = await fetch('https://api.hubapi.com' + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: tSig(2500),
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* non-JSON error body, kept as text */ }
  return { ok: r.ok, status: r.status, data, text: text.slice(0, 300) };
};

// The lead score is computed in code, from the payload alone. It is written
// into the note body, never into an invented CRM property.
const scoreLead = (product, phone, note) => {
  let score = 0;
  const parts = [];
  if (/investor|partner/i.test(product)) { score += 40; parts.push('investor or partner +40'); }
  if (/\b(answered|hold|recover|all three)\b/i.test(product)) { score += 25; parts.push('business product +25'); }
  if (phone) { score += 15; parts.push('phone provided +15'); }
  if (note.length > 80) { score += 10; parts.push('note over 80 chars +10'); }
  return { score, parts };
};

const logToHubSpot = async (token, { email, name, phone, product, note, source }) => {
  // 1. Upsert: search by email first, then update or create.
  let contactId = null;
  const search = await hubspotCall(token, 'POST', '/crm/v3/objects/contacts/search', {
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
    properties: ['email'],
    limit: 1,
  }).catch((e) => ({ ok: false, status: 0, text: String(e && e.message || e) }));
  if (!search.ok) {
    console.error('rule-6 HubSpot contact search failed: status ' + search.status + ' ' + search.text);
    return; // no contact id is reachable, nothing downstream can associate
  }

  const props = { email ,
    // DAVID'S RULE 2026-08-14: Answered and Reddenda share one HubSpot portal,
    // so every Answered record is stamped into its own property group and is
    // obvious on sight. An untagged contact would be indistinguishable from a
    // Reddenda one, which is the whole thing this prevents.
    answered_product: 'answered',
    answered_source: 'interest form, ' + source,
    // set on every write: HubSpot keeps the earliest value on a date property
    // it already holds, and a first-seen that is only set on create is missing
    // on every contact that existed before this stamp shipped.
    answered_first_seen: new Date().toISOString().slice(0, 10),
  };
  if (name) {
    const sp = name.lastIndexOf(' ');
    props.firstname = sp > 0 ? name.slice(0, sp) : name;
    if (sp > 0) props.lastname = name.slice(sp + 1);
  }
  if (phone) props.phone = phone;

  const found = search.data && search.data.results && search.data.results[0];
  if (found && found.id) {
    contactId = found.id;
    const upd = await hubspotCall(token, 'PATCH', '/crm/v3/objects/contacts/' + contactId, { properties: props })
      .catch((e) => ({ ok: false, status: 0, text: String(e && e.message || e) }));
    if (!upd.ok) {
      console.error('rule-6 HubSpot contact update failed: status ' + upd.status + ' ' + upd.text);
      // the contact still exists, so keep going: note + task can still land
    }
  } else {
    const crt = await hubspotCall(token, 'POST', '/crm/v3/objects/contacts', { properties: props })
      .catch((e) => ({ ok: false, status: 0, text: String(e && e.message || e) }));
    if (!crt.ok || !(crt.data && crt.data.id)) {
      console.error('rule-6 HubSpot contact create failed: status ' + crt.status + ' ' + crt.text);
      return;
    }
    contactId = crt.data.id;
  }

  // 2. Note engagement: full payload + the code-computed lead score.
  const { score, parts } = scoreLead(product, phone, note);
  const noteBody =
    '<p><b>[ANSWERED &middot; ANSWERED] interest form submission</b></p>' +
    '<p><i>This record belongs to Answered (the AI phone product), not Reddenda.</i></p>' +
    '<p>Product: ' + esc(product || 'not chosen') + '<br>' +
    'Phone: ' + esc(phone || 'not given') + '<br>' +
    'Note: ' + esc(note || 'none') + '<br>' +
    'Page source: ' + esc(source) + '</p>' +
    '<p><b>Lead score: ' + score + '</b> (' +
    (parts.length ? parts.join(', ') : 'no scoring signals matched') + ')</p>' +
    '<p>Scored in code by netlify/functions/interest.js. Rubric: investor or partner +40, ' +
    'business product +25, phone provided +15, note over 80 chars +10.</p>';
  const noteRes = await hubspotCall(token, 'POST', '/crm/v3/objects/notes', {
    properties: { hs_timestamp: new Date().toISOString(), hs_note_body: noteBody },
    associations: [{
      to: { id: contactId },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_CONTACT }],
    }],
  }).catch((e) => ({ ok: false, status: 0, text: String(e && e.message || e) }));
  if (!noteRes.ok) {
    console.error('rule-6 HubSpot note create failed: status ' + noteRes.status + ' ' + noteRes.text);
  }

  // 3. Task engagement, due today.
  const taskRes = await hubspotCall(token, 'POST', '/crm/v3/objects/tasks', {
    properties: {
      hs_timestamp: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
      hs_task_subject: '[ANSWERED] interest: ' + (product || 'no product chosen') + ' - reply today',
      hs_task_body: 'Reply personally today. One reply, not a sequence. Lead score ' + score +
        '. The note on this contact carries the full submission.',
      hs_task_status: 'NOT_STARTED',
      hs_task_priority: 'HIGH',
      hs_task_type: 'TODO',
    },
    associations: [{
      to: { id: contactId },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: TASK_TO_CONTACT }],
    }],
  }).catch((e) => ({ ok: false, status: 0, text: String(e && e.message || e) }));
  if (!taskRes.ok) {
    console.error('rule-6 HubSpot task create failed: status ' + taskRes.status + ' ' + taskRes.text);
  }
};

const sendAutoresponder = async (KEY, email, name) => {
  const first = name ? name.split(' ')[0] : '';
  const text =
    (first ? 'Hi ' + first + ',\n\n' : 'Hi,\n\n') +
    'Your note reached a person at Answered. A person reads this today and replies within one business day. One reply, not a sequence.\n\n' +
    'If you want to add anything, just reply to this email.\n\n' +
    'Answered\nhttps://answered.reddenda.com';
  const html =
    '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;color:#1E1B17">' +
    '<p>' + (first ? 'Hi ' + esc(first) + ',' : 'Hi,') + '</p>' +
    '<p>Your note reached a person at Answered. A person reads this today and replies within one business day. One reply, not a sequence.</p>' +
    '<p>If you want to add anything, just reply to this email.</p>' +
    '<p>Answered<br><a href="https://answered.reddenda.com" style="color:#1E1B17">answered.reddenda.com</a></p></div>';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Answered <info@reddenda.com>',
      to: [email],
      subject: 'Got it. A person reads this today.',
      html,
      text,
    }),
    signal: tSig(4000),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    console.error('autoresponder send failed: status ' + r.status + ' ' + body.slice(0, 300));
  }
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { Allow: 'POST' }, body: 'Method not allowed' };
  }

  let f = {};
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : (event.body || '');
    const ct = (event.headers['content-type'] || event.headers['Content-Type'] || '');
    if (ct.indexOf('application/json') === 0) {
      f = JSON.parse(raw || '{}');
    } else {
      new URLSearchParams(raw).forEach((v, k) => { f[k] = v; });
    }
  } catch (e) {
    return { statusCode: 400, body: 'Could not read that submission.' };
  }

  if (f['bot-field']) { return { statusCode: 303, headers: { Location: '/thanks.html' }, body: '' }; }

  const email = String(f.email || '').trim();
  if (!email || email.indexOf('@') < 1) {
    return { statusCode: 400, body: 'An email address is required.' };
  }

  const KEY = process.env.RESEND_API_KEY;
  if (!KEY) {
    // No silent success. If we cannot deliver it, the person is told.
    return { statusCode: 503, body: 'We could not record that right now. Please email info@reddenda.com and we will pick it up.' };
  }

  const rows = [
    ['Name', f.name], ['Email', email], ['Phone', f.phone],
    ['Which part', f.product], ['Note', f.note],
  ].filter((r) => r[1]);

  const html =
    '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1E1B17">' +
    '<h2 style="font-size:18px;margin:0 0 14px">Answered: new interest</h2><table style="border-collapse:collapse">' +
    rows.map((r) =>
      '<tr><td style="padding:6px 18px 6px 0;color:#6B6459;vertical-align:top;white-space:nowrap">' + esc(r[0]) +
      '</td><td style="padding:6px 0"><b>' + esc(r[1]) + '</b></td></tr>').join('') +
    '</table><p style="font-size:12px;color:#6B6459;margin-top:18px">answered.reddenda.com</p></div>';

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Answered <info@reddenda.com>',
        to: ['David@Reddenda.com'],
        reply_to: email,
        subject: 'Answered: ' + (f.product || 'interest') + ' from ' + (f.name || email),
        html,
      }),
    });
    if (!r.ok) {
      return { statusCode: 502, body: 'We could not record that right now. Please email info@reddenda.com and we will pick it up.' };
    }
  } catch (e) {
    return { statusCode: 502, body: 'We could not record that right now. Please email info@reddenda.com and we will pick it up.' };
  }

  // ── Rule 6, in the send loop ─────────────────────────────────────────────
  // David's notification is out, so from here nothing may block the redirect.
  // HubSpot logging and the autoresponder run together, each catching and
  // shouting its own failures.
  const payload = {
    email,
    name: String(f.name || '').trim().slice(0, 200),
    phone: String(f.phone || '').trim().slice(0, 100),
    product: String(f.product || '').trim().slice(0, 200),
    note: String(f.note || '').trim().slice(0, 4000),
    source: String((event.headers && (event.headers.referer || event.headers.Referer)) || '').trim().slice(0, 500)
      || 'unknown (no referer header)',
  };
  const HS_TOKEN = process.env.HUBSPOT_TOKEN;
  const work = [];
  if (!HS_TOKEN) {
    console.error('HUBSPOT_TOKEN not set - rule-6 logging skipped');
  } else {
    work.push(logToHubSpot(HS_TOKEN, payload).catch((e) => {
      console.error('rule-6 HubSpot logging threw: ' + String(e && e.message || e));
    }));
  }
  work.push(sendAutoresponder(KEY, email, payload.name).catch((e) => {
    console.error('autoresponder send threw: ' + String(e && e.message || e));
  }));
  try { await Promise.all(work); } catch (e) {
    // every branch above catches for itself; this is belt and braces only
    console.error('rule-6 post-send block threw: ' + String(e && e.message || e));
  }

  return { statusCode: 303, headers: { Location: '/thanks.html' }, body: '' };
};
