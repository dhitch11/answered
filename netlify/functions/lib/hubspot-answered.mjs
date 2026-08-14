// lib/hubspot-answered.mjs — the ONLY door from Answered into HubSpot.
//
// DAVID'S RULE (2026-08-14): "If it's putting stuff in HubSpot, it's a whole
// separate section of HubSpot for Answered, separated from Reddenda. This
// should be obvious and apparent anywhere and everywhere it puts things in
// HubSpot."
//
// Reddenda and Answered share one HubSpot portal, so separation cannot be an
// intention: it has to be enforced at the only place writes happen. Every
// contact, note and task this product creates goes through this file and comes
// out stamped four ways, so a human looking at the record knows in one glance
// which business it belongs to:
//
//   1. PROPERTY GROUP     a dedicated "Answered (AI phone product)" section on
//                         the contact record, created in the portal, holding
//                         answered_product / answered_source / answered_first_seen.
//                         In the UI this renders as its own panel, not as
//                         fields mixed into Reddenda's.
//   2. TAGGED PROPERTIES  answered_product is always set (answered | hold |
//                         recover | parley), so every Answered contact is
//                         filterable and listable on its own, and a Reddenda
//                         contact has it empty.
//   3. TITLE PREFIX       every note and task subject begins with the same
//                         literal marker, so it is obvious in a timeline that
//                         is otherwise interleaved with Reddenda activity.
//   4. BODY HEADER        every note body opens with the product line and the
//                         surface it came from, because a timeline entry gets
//                         read on its own, far from the property panel.
//
// A write that cannot be stamped does not happen. If a caller forgets to say
// which product it is, this throws rather than quietly creating a contact that
// looks like Reddenda's.
//
// Env by NAME only: HUBSPOT_TOKEN.

const API = 'https://api.hubapi.com';
const MARK = 'ANSWERED';                       // the literal that makes it obvious
const PRODUCTS = new Set(['answered', 'hold', 'recover', 'parley']);

function token() {
  const t = (process.env.HUBSPOT_TOKEN || '').trim();
  if (!t) throw new Error('HUBSPOT_TOKEN is not set, so nothing is written to the CRM');
  return t;
}

async function hs(path, { method = 'GET', body, timeoutMs = 4000 } = {}) {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* keep the raw text below */ }
  if (!r.ok) {
    const detail = (json && (json.message || json.error)) || text.slice(0, 200);
    const err = new Error('hubspot ' + r.status + ': ' + detail);
    err.status = r.status;
    throw err;
  }
  return json;
}

function requireProduct(product) {
  const p = String(product || '').trim().toLowerCase();
  if (!PRODUCTS.has(p)) {
    throw new Error(
      'answered hubspot: product must be one of ' + [...PRODUCTS].join(', ') +
      '. An untagged write would be indistinguishable from Reddenda\'s records, which is the one thing this file exists to prevent.'
    );
  }
  return p;
}

// ── the separation stamp, applied to every contact ──────────────────────────
function stamp(product, source, extra = {}) {
  return {
    answered_product: product,
    answered_source: String(source || 'unknown').slice(0, 200),
    ...extra,
  };
}

/**
 * Upsert a contact into the Answered section. Never blanks an existing field.
 * Returns { id, created }.
 */
export async function upsertContact({ email, product, source, firstname, lastname, phone, extra = {} }) {
  const p = requireProduct(product);
  const addr = String(email || '').trim().toLowerCase();
  if (!addr || !addr.includes('@')) throw new Error('answered hubspot: a contact needs an email');

  const found = await hs('/crm/v3/objects/contacts/search', {
    method: 'POST',
    body: {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: addr }] }],
      properties: ['email', 'answered_product', 'answered_first_seen'],
      limit: 1,
    },
  });

  const hit = found && found.results && found.results[0];
  const props = stamp(p, source, extra);
  // only send fields we actually have, so an upsert never wipes a value
  if (firstname) props.firstname = String(firstname).slice(0, 100);
  if (lastname) props.lastname = String(lastname).slice(0, 100);
  if (phone) props.phone = String(phone).slice(0, 40);

  if (hit) {
    // first_seen is set once and never overwritten: it is a fact about the past
    if (!hit.properties || !hit.properties.answered_first_seen) {
      props.answered_first_seen = new Date().toISOString().slice(0, 10);
    }
    await hs('/crm/v3/objects/contacts/' + hit.id, { method: 'PATCH', body: { properties: props } });
    return { id: hit.id, created: false };
  }

  props.email = addr;
  props.answered_first_seen = new Date().toISOString().slice(0, 10);
  const made = await hs('/crm/v3/objects/contacts', { method: 'POST', body: { properties: props } });
  return { id: made.id, created: true };
}

/**
 * A timeline note, marked so it cannot be mistaken for Reddenda activity.
 * Association type 202 = note to contact (HubSpot defined).
 */
export async function addNote({ contactId, product, source, title, body }) {
  const p = requireProduct(product);
  const header =
    `[${MARK} · ${p.toUpperCase()}] ${String(title || 'activity').trim()}\n` +
    `Product: Answered (${p}). Surface: ${source || 'unknown'}. This record belongs to Answered, not Reddenda.\n` +
    '────────────────────────────────\n';
  return hs('/crm/v3/objects/notes', {
    method: 'POST',
    body: {
      properties: { hs_timestamp: Date.now(), hs_note_body: header + String(body || '') },
      associations: [{
        to: { id: contactId },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }],
      }],
    },
  });
}

/**
 * A task, prefixed so an operator sees which business it belongs to in a list
 * view that shows nothing but subjects. Association type 204 = task to contact.
 */
export async function addTask({ contactId, product, subject, body, dueInHours = 4, priority = 'HIGH' }) {
  const p = requireProduct(product);
  return hs('/crm/v3/objects/tasks', {
    method: 'POST',
    body: {
      properties: {
        hs_timestamp: Date.now() + dueInHours * 3600 * 1000,
        hs_task_subject: `[${MARK} · ${p.toUpperCase()}] ${String(subject || 'follow up').trim()}`,
        hs_task_body: String(body || ''),
        hs_task_status: 'NOT_STARTED',
        hs_task_priority: priority,
        hs_task_type: 'TODO',
      },
      associations: [{
        to: { id: contactId },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 204 }],
      }],
    },
  });
}

/**
 * The whole loop for one event, in the order that matters: the contact first,
 * then the note, then the task. Every step is stamped. Failures are returned
 * rather than thrown so a caller can keep serving the customer, but they are
 * never reported as success.
 */
export async function record({ email, product, source, firstname, lastname, phone, noteTitle, noteBody, taskSubject, taskBody, extra }) {
  const out = { contact: null, note: null, task: null, errors: [] };
  try {
    out.contact = await upsertContact({ email, product, source, firstname, lastname, phone, extra });
  } catch (e) {
    out.errors.push('contact: ' + (e && e.message));
    return out; // no contact means nothing to associate to
  }
  if (noteBody || noteTitle) {
    try {
      out.note = await addNote({ contactId: out.contact.id, product, source, title: noteTitle, body: noteBody });
    } catch (e) { out.errors.push('note: ' + (e && e.message)); }
  }
  if (taskSubject) {
    try {
      out.task = await addTask({ contactId: out.contact.id, product, subject: taskSubject, body: taskBody });
    } catch (e) { out.errors.push('task: ' + (e && e.message)); }
  }
  return out;
}

export const ANSWERED_MARK = MARK;
