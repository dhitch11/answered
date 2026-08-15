// /admin — the operator business console.
//
// WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT.
//
//   /internal/cockpit   where calls are WORKED. Dialling, listening, barge, autopilot. Not this.
//   /internal/ops       "is anything broken right now". A health view. Not this.
//   /admin              who the customers ARE, what they used, what they owe, what to refund.
//
// Three surfaces, three questions, one database. This one is the business console: customers,
// accounts, usage, signups, recordings tied to the business that paid for them, behaviour,
// billing and refunds, the audit trail, and the system's own honest state.
//
// ── ROUTING ──────────────────────────────────────────────────────────────────────────────────
// The `config.path` array below is a LITERAL and must stay one. Netlify reads a v2 function's
// config by STATIC ANALYSIS at bundle time; it does not execute the module. A computed value it
// cannot evaluate is not an error and not a warning, it is silently dropped, and the function
// falls back to its default /.netlify/functions/<name> route. That exact mistake is live in this
// repo right now: `answered-brain.mjs` shipped `path: routeTable()`, registered no routes, and
// /api/answered-brain returns 404 while /.netlify/functions/answered-brain returns 405 — which
// took the demo-health bridge down and hid every call control on the public site.
//
// Because these paths are declared here, there is deliberately NO netlify.toml redirect for
// /admin. Declaring a custom path removes the default function route, so a forced redirect
// pointing at it would shadow a live route with a dead target. It also means this feature adds
// nothing to any shared file, which matters when three lanes are writing this repo at once.
//
// ── THE GATE ─────────────────────────────────────────────────────────────────────────────────
// Not one privileged byte is produced before a session resolves. The anonymous response is a
// login form and nothing else: no nav, no counts, no route list, no customer names, no hint of
// what is behind it. This estate has already shipped the other thing — a CSS "PIN curtain" over
// a page the server had sent in full, 303,451 bytes readable by any anonymous curl — and the
// lesson is that if the bytes reach the browser, the page is public. The assertion that matters
// is on the bytes an anonymous client receives, never on the presence of a check in the source.

import {
  configured, whyNotConfigured, currentAdmin, verifyPassword, hashToken, newToken,
  mintCookieValue, setCookie, clearCookie, readCookie, splitCookieValue,
  json, html, slow, audit, clientIp, clientUa, csrfOk, SESSION_HOURS, PRIVATE_HEADERS,
} from './lib/admin-auth.mjs';
import { rpc } from './lib/db.mjs';
import { loginPage, consolePage } from './lib/admin-ui.mjs';
import { CATALOG } from './lib/meter.mjs';
import * as outreach from './lib/outreach.mjs';
import * as ai from './lib/anthropic.mjs';
import { ask as askData } from './lib/ask.mjs';
import { renderSpec, getAccount } from './lib/accounts.mjs';
import { fitOwnerNotes } from './answered-brain.mjs';

export const config = {
  path: [
    '/admin',
    '/admin/login',
    '/admin/logout',
    '/api/admin/overview',
    '/api/admin/accounts',
    '/api/admin/account',
    '/api/admin/account-status',
    '/api/admin/notes-clipped',
    '/api/admin/deliveries',
    '/api/admin/delivery/replay',
    '/api/admin/calls',
    '/api/admin/call',
    '/api/admin/call/summarize',
    '/api/admin/ask',
    '/api/admin/usage',
    '/api/admin/billing',
    '/api/admin/events',
    '/api/admin/parley',
    '/api/admin/audit',
    '/api/admin/system',
    '/api/admin/compliance',
    '/api/admin/cockpit',
    '/api/admin/crm',
    '/api/admin/crm/facets',
    '/api/admin/crm/contact',
    '/api/admin/crm/update',
    '/api/admin/crm/bulk',
    '/api/admin/crm/note',
    '/api/admin/crm/task',
    '/api/admin/crm/tasks',
    '/api/admin/crm/timeline',
    '/api/admin/crm/thread',
    '/api/admin/crm/preflight',
    '/api/admin/crm/email',
    '/api/admin/crm/sms',
    '/api/admin/crm/call',
    '/api/admin/crm/draft',
    '/api/admin/views',
    '/api/admin/jobs',
    '/api/admin/ai/status',
    '/api/admin/recording',
    '/api/admin/refund',
    '/api/admin/attribute-backfill',
    '/api/admin/log',
  ],
};

/** The deploy that is serving this request, for the System panel. Netlify sets these. */
const buildInfo = () => ({
  deploy_id: process.env.DEPLOY_ID || process.env.COMMIT_REF || 'unknown',
  context: process.env.CONTEXT || 'unknown',
});

/**
 * Every environment variable this platform depends on, with what it is for and whether it is
 * REQUIRED for the console to function honestly.
 *
 * ★ READ FROM `process.env` INSIDE THIS RUNNING FUNCTION, NEVER FROM A CONTROL-PLANE LISTING.
 * `netlify env:list` on this site does not enumerate everything the runtime receives:
 * context-scoped variables are invisible to it, and this lane very nearly reported the live lead
 * form as broken on the strength of a listing that omitted RESEND_API_KEY while a real POST to
 * the live endpoint returned 303. A listing is not a measurement. Only this is.
 */
const ENV_SPEC = [
  { name: 'ANSWERED_ADMIN_KEY', purpose: 'Signs this console\'s session cookie. Its own secret, shared with nothing.', required: true },
  { name: 'ANSWERED_DB_URL', purpose: 'The database this console reads.', required: true },
  { name: 'ANSWERED_DB_ANON', purpose: 'Publishable key. Opens nothing on its own: RLS denies every table.', required: true },
  { name: 'ANSWERED_DB_SECRET', purpose: 'The secret the security-definer RPCs require.', required: true },
  { name: 'TWILIO_ACCOUNT_SID', purpose: 'Fetching a recording server side, so a media URL never leaves us.', required: false },
  { name: 'TWILIO_API_SID', purpose: 'Twilio API key for recording playback.', required: false },
  { name: 'TWILIO_API_SECRET', purpose: 'Twilio API secret for recording playback.', required: false },
  { name: 'STRIPE_SECRET_KEY', purpose: 'Refunds and billing reads.', required: false },
  { name: 'ANSWERED_BILLING_ARMED', purpose: 'Must be "1" before anything can move real money. Absent is the safe default.', required: false },
  { name: 'STRIPE_WEBHOOK_SECRET', purpose: 'Verifies Stripe webhooks. Without it a webhook cannot be trusted.', required: false },
  { name: 'RESEND_API_KEY', purpose: 'Outbound email: signup confirmation, notifications, receipts.', required: false },
  { name: 'HUBSPOT_TOKEN', purpose: 'CRM logging in the send loop.', required: false },
  { name: 'ANSWERED_ACCOUNT_KEY', purpose: 'Signs a CUSTOMER session. Without it no customer can sign in at all.', required: false },
  { name: 'ANSWERED_COCKPIT_KEY', purpose: 'Signs the cockpit session. A different privilege from this one.', required: false },
  { name: 'ANSWERED_AUTOPILOT_KILL', purpose: 'When set, no campaign can place a call.', required: false },
  { name: 'ANSWERED_LEGAL_ENTITY', purpose: 'The registered entity the opening names, for 47 CFR 64.1200(b)(1). Unset means a call identifies itself only by a product name.', required: false },
  { name: 'ELEVENLABS_API_KEY', purpose: 'The voice.', required: false },
  { name: 'ANTHROPIC_API_KEY_LIVE', purpose: 'The language layer.', required: false },
];

const TABLES = [
  'accounts', 'account_config', 'account_numbers', 'account_events',
  'billing_accounts', 'billing_events', 'billing_invoices', 'billing_refunds',
  'calls', 'call_events', 'transcript_lines', 'contacts', 'consent', 'suppression',
  'lines', 'campaigns', 'app_events', 'truce_deals', 'admin_users', 'admin_audit',
];

// ── the request ──────────────────────────────────────────────────────────────────────────────

export default async function handler(req) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/admin';

  if (!configured()) {
    const missing = whyNotConfigured();
    console.error('admin console unconfigured; missing:', missing.join(', '));
    // Fails CLOSED and says which name is missing. Not a degraded console. No console.
    if (path.startsWith('/api/')) {
      return json(503, { error: 'The admin console is not configured on this deploy.', missing });
    }
    return html(503, loginPage({
      error: 'This console is not configured on this deploy, so it is refusing every request rather than '
        + 'accepting any. Missing: ' + missing.join(', ') + '.',
    }));
  }

  try {
    if (path === '/admin/login') return await postLogin(req);
    if (path === '/admin/logout') return await postLogout(req);
    if (path === '/admin') return await getConsole(req, url);
    if (path.startsWith('/api/admin/')) return await apiRoute(req, url, path.slice('/api/admin/'.length));
    return json(404, { error: 'no such route' });
  } catch (e) {
    console.error('admin console error on', path, ':', e && e.stack ? e.stack.slice(0, 900) : e);
    if (path.startsWith('/api/')) return json(500, { error: 'Something failed on our side. Nothing was changed.' });
    return html(500, loginPage({ error: 'Something failed on our side. Nothing was changed.' }));
  }
}

// ── sign in ──────────────────────────────────────────────────────────────────────────────────

/**
 * The error text is IDENTICAL for an unknown email and a wrong password, and the delay is
 * identical too. Telling a stranger which half they got right turns a login form into an
 * account enumerator, and a fast "no such user" against a slow "wrong password" leaks the same
 * thing through timing.
 */
const SAME_ANSWER = 'That email and password do not match an operator on this console.';

async function postLogin(req) {
  const started = Date.now();
  const form = await readForm(req);
  const email = String(form.email || '').trim().toLowerCase();
  const password = String(form.password || '');

  const settle = async (result) => {
    // Every answer, right or wrong, takes at least this long.
    const spent = Date.now() - started;
    if (spent < 700) await slow(700 - spent);
    return result;
  };

  if (!email || !password) {
    return settle(html(400, loginPage({ error: 'Enter both an email and a password.', email })));
  }

  let user = null;
  try {
    user = await rpc('sv_admin_by_email', { p_email: email });
  } catch (e) {
    console.error('admin login: user lookup failed:', e && e.message);
    return settle(html(503, loginPage({
      error: 'The database could not be reached, so we cannot sign anyone in. This is not a wrong password.',
      email,
    })));
  }

  if (!user) {
    // Spend comparable work on a non-existent account so timing does not distinguish the cases.
    verifyPassword(password, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '=');
    return settle(html(401, loginPage({ error: SAME_ANSWER, email })));
  }
  if (user.status !== 'active') {
    return settle(html(403, loginPage({ error: 'That operator account is disabled.', email })));
  }
  if (user.locked) {
    return settle(html(429, loginPage({ email, locked: true })));
  }

  const ok = verifyPassword(password, user.password_hash);

  try {
    await rpc('sv_admin_login_attempt', { p_admin_id: user.id, p_ok: ok, p_ip: clientIp(req) });
  } catch (e) {
    console.error('admin login: attempt accounting failed:', e && e.message);
    // Accounting failing must not turn a wrong password into a right one.
    if (!ok) return settle(html(401, loginPage({ error: SAME_ANSWER, email })));
  }

  if (!ok) {
    await auditRaw(null, req, 'admin.login.failed', { targetKind: 'admin_user', targetId: user.id, result: 'denied', payload: { email } });
    return settle(html(401, loginPage({ error: SAME_ANSWER, email })));
  }

  const raw = newToken();
  await rpc('sv_admin_session_create', {
    p_admin_id: user.id, p_token_hash: hashToken(raw), p_hours: SESSION_HOURS,
    p_ip: clientIp(req), p_ua: clientUa(req),
  });
  await auditRaw({ admin_id: user.id, email: user.email }, req, 'admin.login', {
    targetKind: 'admin_user', targetId: user.id,
  });

  return settle(new Response('', {
    status: 303,
    headers: { ...PRIVATE_HEADERS, Location: '/admin', 'Set-Cookie': setCookie(mintCookieValue(raw)) },
  }));
}

async function postLogout(req) {
  const cookie = readCookie(req);
  const raw = cookie ? splitCookieValue(cookie) : null;
  if (raw) {
    const me = await currentAdmin(req).catch(() => ({ ok: false }));
    try { await rpc('sv_admin_session_revoke', { p_token_hash: hashToken(raw), p_all_for: null }); }
    catch (e) { console.error('admin logout: revoke failed:', e && e.message); }
    if (me.ok) await audit(me.admin, req, 'admin.logout');
  }
  const accept = req.headers.get('accept') || '';
  if (accept.includes('application/json') || req.method === 'POST') {
    return json(200, { ok: true }, { 'Set-Cookie': clearCookie() });
  }
  return new Response('', { status: 303, headers: { ...PRIVATE_HEADERS, Location: '/admin', 'Set-Cookie': clearCookie() } });
}

// ── the document ─────────────────────────────────────────────────────────────────────────────

async function getConsole(req, url) {
  const me = await currentAdmin(req);
  if (!me.ok) {
    // ★ The console HTML is not merely hidden here. It is never built. Nothing about customers,
    // counts, routes or navigation exists in this response at all.
    const notice = url.searchParams.get('signedout') ? 'You are signed out.' : '';
    const error = url.searchParams.get('expired')
      ? 'That session has ended. Sign in again.'
      : (me.reason === 'revoked' ? 'That session was revoked. Sign in again.' : '');
    const headers = (me.reason === 'expired' || me.reason === 'revoked' || me.reason === 'bad_signature')
      ? { 'Set-Cookie': clearCookie() } : {};
    return html(200, loginPage({ error, notice }), headers);
  }
  return html(200, consolePage({ admin: me.admin, buildInfo: buildInfo() }));
}

// ── the API ──────────────────────────────────────────────────────────────────────────────────

const MUTATING = new Set([
  'account-status', 'refund', 'attribute-backfill', 'log',
  'crm/update', 'crm/bulk', 'crm/note', 'crm/task', 'crm/email', 'crm/sms', 'crm/call',
  'crm/draft', 'call/summarize', 'ask', 'delivery/replay',
]);

async function apiRoute(req, url, name) {
  const me = await currentAdmin(req);
  if (!me.ok) return json(401, { error: 'not signed in', reason: me.reason });

  if (MUTATING.has(name)) {
    if (req.method !== 'POST') return json(405, { error: 'POST only' });
    // SameSite=Strict already blocks the cross-site post; this is the second lock. A cross-origin
    // form cannot set a custom header without a preflight this origin will not grant.
    if (!csrfOk(req)) return json(403, { error: 'missing the console header' });
  }

  const q = url.searchParams;
  const admin = me.admin;
  const num = (v, d) => { const x = parseInt(v, 10); return Number.isFinite(x) ? x : d; };
  const tri = (v) => (v === 'true' ? true : v === 'false' ? false : null);
  const nz = (v) => (v && String(v).trim() ? String(v).trim() : null);

  switch (name) {
    case 'overview':
      return json(200, await rpc('sv_admin_overview'));

    case 'accounts':
      return json(200, await rpc('sv_admin_accounts', {
        p_q: nz(q.get('q')), p_status: nz(q.get('status')),
        p_sort: nz(q.get('sort')) || 'recent',
        p_limit: num(q.get('limit'), 50), p_offset: num(q.get('offset'), 0),
      }));

    case 'account': {
      const id = nz(q.get('id'));
      if (!id) return json(400, { error: 'an account id is required' });
      const row = await rpc('sv_admin_account', { p_id: id });
      if (!row) return json(404, { error: 'no such account' });
      await audit(admin, req, 'account.view', { targetKind: 'account', targetId: id });
      return json(200, { ...row, notes_fit: await notesFit(row) });
    }

    case 'deliveries':
      return json(200, await rpc('sv_admin_deliveries', {
        p_state: nz(q.get('state')), p_limit: num(q.get('limit'), 100),
      }));

    case 'delivery/replay': {
      const b = await readJson(req);
      if (!b.id) return json(400, { error: 'a delivery id is required' });
      const r = await rpc('sv_delivery_replay', { p_id: b.id, p_actor: admin.email });
      await audit(admin, req, 'delivery.replay', { targetKind: 'delivery', targetId: b.id,
        result: r && r.ok ? 'ok' : 'failed' });
      return json(200, r);
    }

    case 'notes-clipped':
      return json(200, await rpc('sv_admin_notes_clipped', { p_line: nz(q.get('line')) }));

    case 'calls':
      return json(200, await rpc('sv_admin_calls', {
        p_account: nz(q.get('account')), p_q: nz(q.get('q')),
        p_direction: nz(q.get('direction')), p_recorded: tri(q.get('recorded')),
        p_limit: num(q.get('limit'), 50), p_offset: num(q.get('offset'), 0),
      }));

    case 'call': {
      const sid = nz(q.get('sid'));
      if (!sid) return json(400, { error: 'a call sid is required' });
      const row = await rpc('sv_admin_call', { p_call_sid: sid });
      await audit(admin, req, 'call.view', { targetKind: 'call', targetId: sid });
      return json(200, row);
    }

    case 'usage':
      return json(200, await rpc('sv_admin_usage', {
        p_account: nz(q.get('account')), p_since: nz(q.get('since')),
      }));

    case 'events':
      return json(200, await rpc('sv_admin_events', {
        p_account: nz(q.get('account')), p_name: nz(q.get('name')), p_since: nz(q.get('since')),
        p_limit: num(q.get('limit'), 100), p_offset: num(q.get('offset'), 0),
      }));

    case 'parley':
      // Through the projection that cannot reach a sealed limit. There is no argument, flag or
      // query string on this route that turns the numbers on, because "trusted not to" is not a
      // control and this page's whole claim depends on that being structurally true.
      return json(200, await rpc('sv_truce_admin', { p_limit: num(q.get('limit'), 200) }));

    case 'audit':
      return json(200, await rpc('sv_admin_audit_list', {
        p_target_kind: nz(q.get('kind')), p_target_id: nz(q.get('id')),
        p_limit: num(q.get('limit'), 200), p_offset: num(q.get('offset'), 0),
      }));

    case 'billing':
      return json(200, await billingPanel());

    case 'system':
      return json(200, await systemPanel());

    case 'compliance':
      return json(200, await compliancePanel(nz(q.get('since'))));

    case 'cockpit':
      return json(200, await cockpitBoard());

    case 'recording':
      return await streamRecording(req, q.get('sid'), admin);

    case 'refund':
      return await doRefund(req, admin);

    case 'account-status': {
      const b = await readJson(req);
      if (!b.id || !b.status) return json(400, { error: 'an account id and a status are required' });
      const r = await rpc('sv_admin_account_status', {
        p_id: b.id, p_status: b.status, p_actor: admin.email, p_reason: b.reason || null,
      });
      await audit(admin, req, 'account.status', {
        targetKind: 'account', targetId: b.id,
        payload: { to: b.status, reason: b.reason || null },
        result: r && r.ok ? 'ok' : 'refused',
      });
      if (!r || !r.ok) return json(400, { error: (r && r.error) || 'that status could not be set' });
      return json(200, r);
    }

    case 'attribute-backfill': {
      const r = await rpc('sv_admin_attribute_backfill');
      await audit(admin, req, 'calls.attribute_backfill', { payload: r });
      return json(200, r);
    }

    case 'log': {
      const b = await readJson(req);
      if (!b.action) return json(400, { error: 'an action is required' });
      await audit(admin, req, String(b.action).slice(0, 80), {
        targetKind: b.target_kind || null, targetId: b.target_id || null, payload: b.payload || {},
      });
      return json(200, { ok: true });
    }

    // ── CRM ────────────────────────────────────────────────────────────────────────────────
    case 'crm': {
      // `reach` collapses three related questions an operator actually asks into one control.
      // The RPC keeps them as separate columns; only the vocabulary is collapsed, so the filter
      // stays explainable in the query it runs.
      const reach = nz(q.get('reach'));
      return json(200, await rpc('sv_admin_contacts', {
        p_q: nz(q.get('q')), p_lane: nz(q.get('lane')), p_disposition: nz(q.get('disposition')),
        p_state: nz(q.get('state')), p_trade: nz(q.get('trade')), p_line_type: nz(q.get('line_type')),
        p_owner: nz(q.get('owner')), p_tag: nz(q.get('tag')),
        p_suppressed: tri(q.get('suppressed')),
        p_reach: reach,
        p_enriched: nz(q.get('enriched')),
        p_sort: nz(q.get('sort')) || 'recent',
        p_limit: num(q.get('limit'), 50), p_offset: num(q.get('offset'), 0),
      }));
    }

    case 'crm/facets':
      return json(200, await rpc('sv_admin_contact_facets'));

    case 'crm/contact': {
      const id = nz(q.get('id'));
      if (!id) return json(400, { error: 'a contact id is required' });
      const row = await rpc('sv_admin_contact', { p_id: id });
      if (!row) return json(404, { error: 'no such contact' });
      await audit(admin, req, 'contact.view', { targetKind: 'contact', targetId: id });
      return json(200, row);
    }

    case 'crm/update': {
      const b = await readJson(req);
      if (!b.id) return json(400, { error: 'a contact id is required' });
      const r = await rpc('sv_admin_contact_update', { p_id: b.id, p_patch: b.patch || {}, p_actor: admin.email });
      await audit(admin, req, 'contact.update', {
        targetKind: 'contact', targetId: b.id, payload: b.patch || {},
        result: r && r.ok ? 'ok' : 'refused',
      });
      return json(r && r.ok ? 200 : 400, r);
    }

    case 'crm/bulk': {
      const b = await readJson(req);
      const r = await rpc('sv_admin_contacts_bulk', {
        p_ids: b.ids || [], p_action: b.action, p_value: b.value == null ? null : String(b.value),
        p_actor: admin.email,
      });
      await audit(admin, req, 'contact.bulk', {
        targetKind: 'contact', targetId: `${(b.ids || []).length} selected`,
        payload: { action: b.action, value: b.value, result: r },
        result: r && r.ok ? 'ok' : 'refused',
      });
      return json(r && r.ok ? 200 : 400, r);
    }

    case 'crm/note': {
      const b = await readJson(req);
      const r = await rpc('sv_admin_note_add', {
        p_contact_id: b.contact_id || null, p_call_sid: b.call_sid || null,
        p_body: b.body || '', p_author: admin.email, p_pinned: Boolean(b.pinned),
      });
      await audit(admin, req, 'contact.note', { targetKind: 'contact', targetId: b.contact_id });
      return json(r && r.ok ? 200 : 400, r);
    }

    case 'crm/task': {
      const b = await readJson(req);
      const r = b.id
        ? await rpc('sv_admin_task_set', { p_id: b.id, p_status: b.status, p_actor: admin.email })
        : await rpc('sv_admin_task_add', { p_row: { ...b, created_by: admin.email } });
      await audit(admin, req, b.id ? 'task.set' : 'task.add', {
        targetKind: 'task', targetId: b.id || null, payload: b,
      });
      return json(r && r.ok ? 200 : 400, r);
    }

    case 'crm/tasks':
      return json(200, await rpc('sv_admin_tasks', {
        p_status: nz(q.get('status')), p_assignee: nz(q.get('assignee')),
        p_limit: num(q.get('limit'), 200),
      }));

    case 'crm/timeline':
      return json(200, await rpc('sv_crm_timeline', {
        p_contact_id: nz(q.get('contact')), p_account_id: nz(q.get('account')),
        p_limit: num(q.get('limit'), 100), p_before: nz(q.get('before')),
      }));

    // The conversation, as opposed to the timeline. Same business, different question: the timeline
    // is everything that happened to them, this is only what was said between us, in order.
    case 'crm/thread': {
      const id = nz(q.get('contact'));
      if (!id) return json(400, { error: 'a contact id is required' });
      return json(200, await rpc('sv_crm_thread', {
        p_contact_id: id, p_limit: num(q.get('limit'), 200),
      }));
    }

    case 'crm/preflight': {
      const id = nz(q.get('id'));
      if (!id) return json(400, { error: 'a contact id is required' });
      const pre = await outreach.preflight(id);
      if (!pre) return json(404, { error: 'no such contact' });
      return json(200, pre);
    }

    case 'crm/email': {
      const b = await readJson(req);
      const r = await outreach.sendEmail({
        contactId: b.contact_id, to: b.to, subject: b.subject, body: b.body,
        template: b.template || null, actor: admin.email,
        aiAssisted: Boolean(b.ai_assisted), aiModel: b.ai_model || null,
      });
      await audit(admin, req, 'outreach.email', {
        targetKind: 'contact', targetId: b.contact_id,
        payload: { to: b.to, subject: b.subject, ai_assisted: Boolean(b.ai_assisted) },
        result: r.ok ? 'ok' : (r.blocked ? 'blocked' : 'failed'),
      });
      return json(r.ok ? 200 : 400, r);
    }

    case 'crm/sms': {
      const b = await readJson(req);
      const r = await outreach.sendSms({ contactId: b.contact_id, to: b.to, body: b.body, actor: admin.email });
      await audit(admin, req, 'outreach.sms', {
        targetKind: 'contact', targetId: b.contact_id, payload: { to: b.to },
        result: r.ok ? 'ok' : (r.blocked ? 'blocked' : 'failed'),
      });
      return json(r.ok ? 200 : 400, r);
    }

    case 'crm/call': {
      const b = await readJson(req);
      const r = await outreach.callIntent({ contactId: b.contact_id, to: b.to, actor: admin.email, note: b.note });
      await audit(admin, req, 'outreach.call', {
        targetKind: 'contact', targetId: b.contact_id, payload: { to: b.to },
        result: r.ok ? 'ok' : 'blocked',
      });
      return json(200, r);
    }

    // ASK YOUR DATA. The model chooses which measured query to run and phrases the result; it
    // never writes a number, only slot references the server substitutes. See lib/ask.mjs.
    case 'ask': {
      const b = await readJson(req);
      const r = await askData({ question: b.question, actor: admin.email });
      await audit(admin, req, 'ask', {
        result: r.ok ? 'ok' : 'refused',
        payload: { question: String(b.question || '').slice(0, 300), refused: r.refused || null,
                   detail: r.detail || null, model: r.model || null, cost_usd: r.cost_usd || null,
                   tools: (r.trail || []).map((x) => x.tool) },
      });
      return json(200, r);
    }

    case 'call/summarize':
      return await summarizeCall(req, admin);

    case 'crm/draft':
      return await draftMessage(req, admin);

    case 'views': {
      if (req.method === 'POST') {
        // Saving a view is a mutation, so it carries the same second lock as every other write.
        if (!csrfOk(req)) return json(403, { error: 'missing the console header' });
        const b = await readJson(req);
        const r = b.delete
          ? await rpc('sv_admin_view_delete', { p_owner: admin.admin_id, p_id: b.id })
          : await rpc('sv_admin_view_save', {
              p_owner: admin.admin_id, p_scope: b.scope, p_name: b.name,
              p_filters: b.filters || {}, p_shared: Boolean(b.shared),
            });
        return json(r && r.ok ? 200 : 400, r);
      }
      return json(200, await rpc('sv_admin_views', { p_owner: admin.admin_id, p_scope: nz(q.get('scope')) }));
    }

    case 'jobs':
      return json(200, await rpc('sv_admin_jobs', {
        p_q: nz(q.get('q')), p_status: nz(q.get('status')), p_account: nz(q.get('account')),
        p_limit: num(q.get('limit'), 50), p_offset: num(q.get('offset'), 0),
      }));

    case 'ai/status':
      return json(200, { ...ai.status(), probe: q.get('probe') === '1' ? await ai.probe() : null });

    default:
      return json(404, { error: 'no such endpoint' });
  }
}

// ── panels that assemble more than one source ────────────────────────────────────────────────

async function billingPanel() {
  const overview = await rpc('sv_admin_overview');

  // Stripe is PROBED, not assumed. "The key is set" and "the key works" are different claims and
  // only one of them is worth putting on a dashboard.
  const stripe = { configured: Boolean(process.env.STRIPE_SECRET_KEY), reachable: false, live_mode: false, note: '' };
  if (!stripe.configured) {
    stripe.note = 'STRIPE_SECRET_KEY is not set on this deploy, so nothing can charge or refund.';
  } else {
    stripe.live_mode = String(process.env.STRIPE_SECRET_KEY).startsWith('sk_live');
    try {
      const s = await import('./lib/stripe-rest.mjs');
      const acct = await s.account();
      stripe.reachable = true;
      stripe.note = (stripe.live_mode ? 'Live mode. Real money. ' : 'Test mode. ')
        + 'Connected as ' + (acct.business_profile?.name || acct.settings?.dashboard?.display_name || acct.id) + '.';
    } catch (e) {
      stripe.note = 'The key is set but Stripe could not be reached: ' + String(e.message).slice(0, 120);
    }
  }

  // ★ Driven FROM billing_accounts, never from customers. The first version walked customers and
  // kept the ones with a billing record, which meant a billing row with no customer attached was
  // invisible to the one panel whose job is to find exactly that. It rendered "No billing accounts
  // yet, this is a measured zero" underneath a tile reading "97 charges recorded". An orphan
  // cannot be seen by a query that walks the parent.
  const billing = await rpc('sv_admin_billing_accounts', { p_q: null, p_limit: 200, p_offset: 0 });

  return {
    at: new Date().toISOString(),
    stripe,
    billing_armed: process.env.ANSWERED_BILLING_ARMED === '1',
    totals: overview.billing,
    accounts: billing.rows,
    accounts_total: billing.total,
    orphans: billing.orphans,
    catalog: Object.entries(CATALOG).map(([kind, v]) => ({ kind, ...v })),
  };
}

async function systemPanel() {
  const env = ENV_SPEC.map((e) => ({
    name: e.name, purpose: e.purpose, required: e.required,
    present: Boolean(String(process.env[e.name] || '').trim()),
  }));

  // Row counts come from the same overview query the rest of the console uses, so the System
  // panel and every other panel can never disagree about how many customers exist.
  const o = await rpc('sv_admin_overview');
  const tables = [
    { name: 'accounts', rows: o.accounts.total },
    { name: 'calls', rows: o.calls.total },
    { name: 'app_events', rows: o.events.total },
    { name: 'billing_accounts', rows: o.billing.accounts },
    { name: 'billing_events', rows: o.billing.events },
    { name: 'billing_refunds', rows: o.billing.refunds },
    { name: 'truce_deals', rows: o.parley.deals },
    { name: 'contacts', rows: o.pipeline.contacts },
    { name: 'suppression', rows: o.pipeline.suppression_list },
    { name: 'consent', rows: o.pipeline.consent_rows },
    { name: 'lines', rows: o.pipeline.lines },
    { name: 'admin_users', rows: o.operators.total },
  ];

  return {
    at: o.at,
    autopilot_kill: process.env.ANSWERED_AUTOPILOT_KILL === '1',
    env,
    tables,
    build: { ...buildInfo(), ui: 'served' },
  };
}

/**
 * Compliance evidence. Built by the outbound lane, rendered here, never re-derived.
 *
 * ★ THE DENOMINATOR TRAVELS WITH THE HEADLINE NUMBER, ALWAYS.
 * `ai_listened_without_verified_disclosure` is the exposure figure, and a zero means one of two
 * completely different things: nothing is wrong, or nothing has been measured. The columns behind
 * it are new, so most existing rows carry NULL. This attaches `checked` and `total` so the console
 * can say which zero it is rather than printing a reassuring one.
 */
async function compliancePanel(since) {
  const [evidence, dnc] = await Promise.all([
    rpc('sv_compliance_evidence', { p_since: since || null }),
    rpc('sv_dnc_readiness'),
  ]);
  const classes = evidence.by_class || [];
  const sum = (k) => classes.reduce((n, c) => n + (Number(c[k]) || 0), 0);

  // ★ THE CALLER-IDENTITY DUTY, READ FROM THE RUNTIME AND PUT ON A SCREEN.
  //
  // dial.mjs already computes this and its own comment says the gap is "surfaced as a named
  // readiness gap so it reaches an operator screen rather than dying in a comment". It was not
  // reaching one: nothing in this console rendered it, so the gap lived in a field nobody read,
  // which is the same fate as the comment it was written to escape.
  //
  // 47 CFR 64.1200(b)(1) requires the responsible entity to be named at the start of the call, and
  // the (b) chapeau carries no line-type limit, so it binds on business lines too. The value is
  // read from process.env inside this running function, never from a control-plane listing — this
  // lane twice filed a set variable as missing by reading `netlify env:list`, which silently omits
  // context-scoped values.
  const entity = String(process.env.ANSWERED_LEGAL_ENTITY || '').trim();

  return {
    at: new Date().toISOString(),
    evidence,
    dnc,
    caller_identity: {
      entity: entity || null,
      named: Boolean(entity),
      rule: '47 CFR 64.1200(b)(1)',
      what_the_line_says: entity
        ? `"Hi, this is Answered, a service of ${entity}."`
        : '"Hi, this is Answered." — a product name, which may not be the responsible entity.',
      why: entity
        ? 'The opening names the registered entity responsible for the call. No deploy was needed: the script reads this value at call time, so it took effect the moment the variable was set.'
        : 'ANSWERED_LEGAL_ENTITY is unset, so the opening identifies the caller only by a product name. This does not refuse calls — an unset config value should not silently become an outage — but it is a decision, not a defect.',
    },
    totals: {
      placed: sum('placed'),
      refused: sum('refused'),
      ai_listened: sum('ai_listened'),
      ai_spoke: sum('ai_spoke'),
      disclosure_verified: sum('disclosure_verified'),
      disclosure_failed: sum('disclosure_failed'),
      disclosure_unchecked: sum('disclosure_unchecked'),
    },
  };
}

// ── recording playback ───────────────────────────────────────────────────────────────────────

/**
 * The audio is fetched server side and streamed back. The stored recording_url on a call row
 * points HERE, never at Twilio, because a Twilio media URL is effectively a bearer token for a
 * customer's voice: the moment one is pasted into a ticket or a browser history it has escaped.
 * A leaked link to this route is worth nothing to anyone who is not signed in.
 *
 * Playing a customer's recording is an ACT, not a read, so it is written to the audit log with
 * the operator's name on it before a byte of audio is returned.
 */
async function streamRecording(req, sid, admin) {
  if (!sid || !/^RE[0-9a-f]{32}$/i.test(String(sid))) {
    return json(400, { error: 'that is not a recording id' });
  }
  await audit(admin, req, 'recording.stream', { targetKind: 'recording', targetId: sid });
  try {
    const t = await import('./lib/twilio-rest.mjs');
    const audio = await t.fetchRecording(sid);
    return new Response(audio, {
      status: 200,
      headers: {
        ...PRIVATE_HEADERS,
        'Content-Type': 'audio/mpeg',
        'Content-Disposition': `inline; filename="${sid}.mp3"`,
        'Cache-Control': 'no-store, private',
      },
    });
  } catch (e) {
    console.error('admin recording fetch failed:', String(e.message).slice(0, 160));
    await audit(admin, req, 'recording.stream', {
      targetKind: 'recording', targetId: sid, result: 'failed',
      payload: { error: String(e.message).slice(0, 200) },
    });
    return json(502, { error: 'That recording could not be fetched from the carrier.' });
  }
}

// ── refunds ──────────────────────────────────────────────────────────────────────────────────

/**
 * THE ORDER HERE IS THE WHOLE SAFETY OF THE FUNCTION.
 *
 *   1. Record the intent in Postgres, status `pending`, keyed on a unique idempotency key.
 *   2. Only then call Stripe.
 *   3. Settle the row with what actually happened.
 *
 * A refund written only AFTER success is a refund you cannot reconcile when success is exactly
 * what you failed to observe: the network dies, the money moved, and the database has no idea. A
 * refund written first leaves evidence either way, and the unique index means the retry, the
 * double-clicked button and the replayed request all collide instead of refunding twice.
 *
 * When ANSWERED_BILLING_ARMED is not set, this records the intent and does NOT call Stripe, and
 * says so in those words. It never reports money moved that did not move.
 */
async function doRefund(req, admin) {
  const b = await readJson(req);
  const amount = parseInt(b.amount_cents, 10);
  if (!b.charge_id) return json(400, { error: 'a charge is required' });
  if (!Number.isFinite(amount) || amount <= 0) return json(400, { error: 'a refund needs a positive amount' });

  // Resolve the charge's billing account from the account the drawer is showing, so a typo in a
  // client-side field cannot aim a refund at a different customer.
  let billingAccountId = null;
  if (b.account_id) {
    const acct = await rpc('sv_admin_account', { p_id: b.account_id });
    if (!acct) return json(404, { error: 'no such account' });
    const charge = (acct.charges || []).find((c) => c.id === b.charge_id);
    if (!charge) return json(400, { error: 'that charge does not belong to this customer' });
    billingAccountId = acct.billing && acct.billing.balance ? acct.billing.balance.billing_account_id : null;
  }
  if (!billingAccountId) return json(400, { error: 'this customer has no billing account, so there is nothing to refund' });

  // Deterministic, so a retry of the same intent collides rather than refunding twice.
  const idem = `refund:${b.charge_id}:${amount}`;

  const opened = await rpc('sv_admin_refund_open', {
    p_row: {
      account_id: billingAccountId, billing_event_id: b.charge_id, amount_cents: amount,
      reason: b.reason || null, note: b.note || null, idem_key: idem, created_by: admin.email,
    },
  });
  if (!opened || !opened.ok) {
    await audit(admin, req, 'billing.refund', {
      targetKind: 'billing_event', targetId: b.charge_id, result: 'refused',
      payload: { amount_cents: amount, error: opened && opened.error },
    });
    return json(400, { error: (opened && opened.error) || 'that refund was refused' });
  }
  if (opened.replay) {
    await audit(admin, req, 'billing.refund', {
      targetKind: 'billing_event', targetId: b.charge_id, result: 'replay',
      payload: { amount_cents: amount },
    });
    return json(200, { ok: true, replay: true, stripe: false, refund: opened.refund });
  }

  const refundId = opened.refund.id;

  if (process.env.ANSWERED_BILLING_ARMED !== '1' || !process.env.STRIPE_SECRET_KEY) {
    await rpc('sv_admin_refund_settle', {
      p_id: refundId, p_status: 'recorded_offline', p_stripe_refund_id: null,
      p_failure: null,
    });
    await audit(admin, req, 'billing.refund', {
      targetKind: 'billing_event', targetId: b.charge_id, result: 'recorded_offline',
      payload: { amount_cents: amount, reason: b.reason || null },
    });
    return json(200, {
      ok: true, replay: false, stripe: false,
      note: 'Recorded. ANSWERED_BILLING_ARMED is not set, so Stripe was not called and no money moved.',
    });
  }

  try {
    const s = await import('./lib/stripe-rest.mjs');
    const charge = await rpc('sv_admin_account', { p_id: b.account_id });
    const row = (charge.charges || []).find((c) => c.id === b.charge_id);
    if (!row || !row.stripe_invoice_id) {
      await rpc('sv_admin_refund_settle', {
        p_id: refundId, p_status: 'failed', p_stripe_refund_id: null,
        p_failure: 'that charge has never been invoiced through Stripe, so there is nothing there to refund',
      });
      return json(400, {
        error: 'That charge has never been invoiced through Stripe, so there is nothing on their side to refund. '
          + 'The intent is recorded and can be settled offline.',
      });
    }
    const inv = await s.getInvoice(row.stripe_invoice_id);
    const chargeId = inv.charge || (inv.payment_intent && inv.payment_intent.latest_charge);
    if (!chargeId) {
      await rpc('sv_admin_refund_settle', {
        p_id: refundId, p_status: 'failed', p_stripe_refund_id: null,
        p_failure: 'that invoice has no settled charge to refund against',
      });
      return json(400, { error: 'That invoice has no settled charge to refund against.' });
    }
    const out = await s.call('POST', 'refunds', {
      charge: chargeId, amount, reason: 'requested_by_customer',
      'metadata[billing_event_id]': b.charge_id, 'metadata[operator]': admin.email,
    }, { idempotencyKey: idem });
    await rpc('sv_admin_refund_settle', {
      p_id: refundId, p_status: out.status === 'succeeded' ? 'succeeded' : 'pending',
      p_stripe_refund_id: out.id, p_failure: null,
    });
    await audit(admin, req, 'billing.refund', {
      targetKind: 'billing_event', targetId: b.charge_id, result: 'ok',
      payload: { amount_cents: amount, stripe_refund_id: out.id, reason: b.reason || null },
    });
    return json(200, { ok: true, replay: false, stripe: true, refund_id: out.id, status: out.status });
  } catch (e) {
    await rpc('sv_admin_refund_settle', {
      p_id: refundId, p_status: 'failed', p_stripe_refund_id: null,
      p_failure: String(e.message).slice(0, 300),
    });
    await audit(admin, req, 'billing.refund', {
      targetKind: 'billing_event', targetId: b.charge_id, result: 'failed',
      payload: { amount_cents: amount, error: String(e.message).slice(0, 200) },
    });
    return json(502, { error: 'Stripe refused that refund: ' + String(e.message).slice(0, 200) });
  }
}

/**
 * AI DRAFTING — the language layer, and only the language layer.
 *
 * ★ THE MODEL IS HANDED FACTS AND ASKED TO PHRASE THEM. It is never asked to recall, infer or
 * supply one. Everything in the prompt below is read out of the database first, and the system
 * prompt forbids inventing anything not in it, because the failure mode of a drafting tool is not
 * bad prose, it is a confident sentence about a business that is not true — sent, in our name, to
 * that business.
 *
 * Nothing is ever auto-sent. The draft lands in an editable box and a human presses send. That is
 * a product decision, not a limitation: an operator who edits a draft has read it, and an operator
 * who approves a queue has not.
 */
/**
 * SUMMARISE A REAL CALL FROM ITS REAL TRANSCRIPT.
 *
 * Three rules make this safe to put in front of an operator, and all three are enforced in code
 * rather than requested in the prompt.
 *
 * 1. ONLY FINAL LINES ARE READ. A streaming transcript is mostly interim hypotheses: one call in
 *    this database has 471 lines of which 6 are final. Interim lines are the same sentence being
 *    revised in public, so summarising them means summarising a stutter, and the model would
 *    dutifully find meaning in it. If a call has interim lines but no final ones, this REFUSES and
 *    says which, rather than producing a confident summary of noise.
 *
 * 2. EVERY QUOTE IS CHECKED AGAINST THE TRANSCRIPT BEFORE ANYTHING IS STORED. A quote is the one
 *    part of a summary that reads as evidence, so it is the one part that must not be paraphrased.
 *    Any quote that does not appear verbatim in the source fails the whole request: the summary is
 *    not stored, and the offending text is returned so the failure is visible instead of averaged
 *    away. This is the same principle as the numbers rule - the model may choose what to highlight,
 *    it may not author the underlying fact.
 *
 * 3. THE MODEL THAT SERVED IT IS STORED WITH IT. A summary with no provenance is a claim with no
 *    author, and this estate has already had a live phone line quietly running on backup models
 *    with nobody able to tell from the output.
 */
/**
 * WILL THIS OWNER'S INSTRUCTIONS FIT DOWN THE PHONE, AND HAVE THEY ALREADY FAILED TO?
 *
 * Those are two different facts and the console needs both, because the operator's next action
 * differs depending on which is true:
 *
 *   owner_notes_clipped   it HAS happened, on a real call. The voice lane writes this.
 *   the length right now   it WILL happen on the next call. Derived here from the same
 *                          renderSpec() the call path uses, so it cannot drift from reality.
 *
 * A stored flag alone would say nothing about an account that has never been called, and would keep
 * accusing an owner who has since trimmed their notes. Together they separate "was clipped once,
 * since fixed" from "is still over right now", which is the whole point of telling anyone.
 *
 * ★ THE LIMIT IS DERIVED FROM THE VOICE LANE'S OWN FUNCTION, NOT COPIED FROM IT. Feeding
 * fitOwnerNotes a string of known filler and counting what survives yields their constant exactly,
 * so this number cannot silently disagree with the one the phone actually applies. A copied
 * constant is a second source of truth waiting to go stale, and this estate has been bitten by
 * exactly that more than once today.
 */
let CACHED_LIMIT = null;
function ownerNoteLimit() {
  if (CACHED_LIMIT != null) return CACHED_LIMIT;
  try {
    const probe = fitOwnerNotes('x'.repeat(50_000), { id: 'limit-probe' });
    const kept = (probe.match(/x/g) || []).length;
    CACHED_LIMIT = kept > 0 ? kept : null;
  } catch { CACHED_LIMIT = null; }
  return CACHED_LIMIT;
}

async function notesFit(row) {
  const out = { measurable: false };
  try {
    // ★ MEASURE THE STRING THE PHONE ACTUALLY SENDS, NOT A PLAUSIBLE NEIGHBOUR OF IT.
    //
    // The obvious move is renderSpec(row) on the admin row already in hand. Measured, that returns
    // 2,225 characters where the voice path's own getAccount() shape returns 2,266 — a 41-character
    // gap, because the admin projection drops a line the call path includes. Small, and exactly
    // large enough to report "fits" on an account the phone is clipping.
    //
    // So this re-reads through getAccount(), the same call account-voice.mjs makes, and pays one
    // extra round trip to be measuring the same bytes. A number from the wrong source is worse than
    // no number, because it gets believed.
    const forVoice = await getAccount((row.account && row.account.id) || row.id);
    const spec = renderSpec(forVoice || row);
    const limit = ownerNoteLimit();
    if (typeof spec !== 'string' || !limit) return out;
    out.measurable = true;
    out.chars_now = spec.length;
    out.limit = limit;
    out.over_by = Math.max(0, spec.length - limit);
    out.will_clip = spec.length > limit;
  } catch (e) {
    out.error = String(e && e.message).slice(0, 160);
  }
  // What actually happened on a real call, if anything, for this account's own line.
  try {
    const line = (row.numbers && row.numbers[0] && (row.numbers[0].phone || row.numbers[0])) || null;
    if (line) {
      const seen = await rpc('sv_admin_notes_clipped', { p_line: String(line) });
      out.happened = (seen && seen.rows && seen.rows[0]) || null;
    }
  } catch (e) {
    out.happened_error = String(e && e.message).slice(0, 160);
  }
  return out;
}

async function summarizeCall(req, admin) {
  const b = await readJson(req);
  const sid = String(b.call_sid || '').trim();
  if (!sid) return json(400, { error: 'a call sid is required' });
  if (!ai.configured()) {
    return json(503, { error: 'ANTHROPIC_API_KEY_LIVE is not set on this deploy, so nothing can be summarised.' });
  }

  const row = await rpc('sv_admin_call', { p_call_sid: sid });
  const call = row && row.call;
  if (!call) return json(404, { error: 'no call has that sid' });

  const all = Array.isArray(row.transcript) ? row.transcript : [];
  const finals = all.filter((t) => t.is_final);

  if (!finals.length) {
    // An honest refusal, with the numbers that justify it. Not an error: there is simply nothing
    // here that is safe to read.
    return json(200, {
      ok: false,
      refused: 'no_final_transcript',
      lines_total: all.length,
      lines_final: 0,
      why: all.length
        ? `This call has ${all.length} transcript lines and none of them are final. Interim lines are the ` +
          'same sentence being revised as it is recognised, so a summary of them would be a summary of a ' +
          'stutter. Nothing was sent to a model and nothing was stored.'
        : 'This call has no transcript at all, so there is nothing to summarise. That is a measured ' +
          'absence rather than a failure: not every call is transcribed.',
    });
  }

  const script = finals
    .map((t) => `${(t.speaker || t.track || 'unknown')}: ${String(t.text || '').trim()}`)
    .filter((l) => l.length > 12)
    .join('\n');

  const out = await ai.askJson({
    slot: 'deep',
    system:
      'You summarise recorded business phone calls for the operator of a small telephone-answering ' +
      'company. You are reading a real conversation with a real business.\n\n' +
      'RULES THAT DO NOT BEND:\n' +
      '- Every quote you return must be copied EXACTLY from the transcript, character for character. ' +
      'Do not tidy grammar, do not join two lines, do not trim a word. Quotes are checked against the ' +
      'source and any mismatch discards your entire answer.\n' +
      '- Never state anything the transcript does not support. If the purpose of the call is not clear, ' +
      'say it is not clear in the "unclear" field. An honest "I could not tell" is a correct answer here ' +
      'and is more useful than a confident guess.\n' +
      '- This is a machine transcription of speech. Expect mishearings. Where a word is obviously ' +
      'garbled, say so rather than inventing the intended word.',
    messages: [{
      role: 'user',
      content:
        `Call ${sid}. Direction: ${call.direction || 'unknown'}. Duration: ` +
        `${call.duration_seconds == null ? 'unknown' : call.duration_seconds + ' seconds'}. ` +
        `${finals.length} final transcript lines of ${all.length} total.\n\n` +
        `TRANSCRIPT:\n${script}`,
    }],
    name: 'call_summary',
    description: 'The summary of this call.',
    schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Two or three sentences an operator can read in five seconds.' },
        caller_wanted: { type: 'string', description: 'What the other party was trying to achieve, or that it is unclear.' },
        outcome: { type: 'string', description: 'How the call ended, from the transcript only.' },
        sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative', 'unclear'] },
        follow_ups: { type: 'array', items: { type: 'string' }, description: 'Concrete actions, empty if none are warranted.' },
        quotes: {
          type: 'array',
          description: 'Up to three VERBATIM lines that carry the call. Copied exactly.',
          items: {
            type: 'object',
            properties: { speaker: { type: 'string' }, text: { type: 'string' } },
            required: ['speaker', 'text'],
          },
        },
        unclear: { type: 'string', description: 'What you could not determine. Empty string if nothing.' },
      },
      required: ['summary', 'caller_wanted', 'outcome', 'sentiment', 'follow_ups', 'quotes', 'unclear'],
    },
  });

  // ── the quote check. Normalise whitespace only; anything else would be forgiving a paraphrase.
  const hay = finals.map((t) => String(t.text || '')).join('\n').replace(/\s+/g, ' ').toLowerCase();
  const bad = (out.data.quotes || [])
    .map((q) => String(q.text || ''))
    .filter((t) => t.trim() && !hay.includes(t.replace(/\s+/g, ' ').toLowerCase().trim()));

  if (bad.length) {
    await audit(admin, req, 'call.summarize', {
      targetKind: 'call', targetId: sid, result: 'rejected',
      payload: { reason: 'quote_not_in_transcript', quotes: bad, model: out.model },
    });
    return json(200, {
      ok: false,
      refused: 'quote_not_in_transcript',
      quotes: bad,
      model: out.model,
      why: 'The model returned ' + bad.length + ' quote(s) that do not appear in the transcript. A quote ' +
           'is the part of a summary that reads as evidence, so a paraphrased one is worse than none. ' +
           'Nothing was stored. Run it again, or read the transcript directly.',
    });
  }

  const payload = {
    ...out.data,
    model: out.model,
    slot: out.slot,
    cost_usd: out.cost_usd,
    usage: out.usage,
    lines_final: finals.length,
    lines_total: all.length,
    actor: admin.email,
    at: new Date().toISOString(),
  };
  const stored = await rpc('sv_admin_call_summary', { p_call_sid: sid, p_row: payload });

  await audit(admin, req, 'call.summarize', {
    targetKind: 'call', targetId: sid,
    result: stored && stored.ok ? 'ok' : 'failed',
    payload: { model: out.model, cost_usd: out.cost_usd, lines_final: finals.length },
  });

  return json(200, { ok: Boolean(stored && stored.ok), stored, ...payload });
}

async function draftMessage(req, admin) {
  const b = await readJson(req);
  if (!b.contact_id) return json(400, { error: 'a contact is required' });
  if (!ai.configured()) {
    return json(503, { error: 'ANTHROPIC_API_KEY_LIVE is not set on this deploy, so no draft can be written.' });
  }
  if (ai.KILLED()) return json(503, { error: 'The AI kill switch is set.' });

  const rec = await rpc('sv_admin_contact', { p_id: b.contact_id });
  if (!rec) return json(404, { error: 'no such contact' });
  const c = rec.contact;

  // Only what we actually hold. A null stays null and is labelled as unknown rather than omitted,
  // so the model cannot mistake absence for something it may fill in.
  const facts = {
    business_name: c.name || null,
    trade: c.trade || null,
    city: c.city || null,
    state: c.state || null,
    website: c.website || null,
    person_name: c.contact_name || null,
    person_role: c.contact_role || null,
    line_type: c.line_type || null,
    times_we_have_called: c.call_count || 0,
    last_contacted_at: c.last_contacted_at || null,
    disposition: c.disposition,
    notes: (rec.notes || []).slice(0, 5).map((n) => n.body),
    previous_calls: (rec.calls || []).slice(0, 3).map((x) => ({
      when: x.created_at, outcome: x.disposition || x.status, summary: x.summary || null,
    })),
  };

  const system = [
    'You draft a short outreach email for an operator at Answered, an AI phone receptionist for',
    'trades and small businesses. The operator edits and sends it. You never send anything.',
    '',
    'ABSOLUTE RULES:',
    '1. Use ONLY the facts in the FACTS object. If a field is null, you do not know it, and you must',
    '   not guess it, infer it from the business name, or write around it with a vague claim.',
    '2. Never invent a statistic, a customer count, a price, a case study, a mutual connection, or a',
    '   claim about their business you were not given. If you have little to work with, write a',
    '   shorter email. A short honest email is the correct output; a longer invented one is a defect.',
    '3. Never promise a text message. Never state a price.',
    '4. Address a person by name only if person_name is present. Otherwise address the business.',
    '5. Plain, direct, human. No marketing voice, no exclamation marks, no em dashes. Sixth to',
    '   eighth grade reading level. Under 120 words unless the operator asked for more.',
    '6. The product truth you may use: Answered picks up the phone when they cannot, takes the job',
    '   details, and texts or emails them the message. It exists because trades people are on a roof',
    '   or under a sink when the phone rings, and a missed call is a lost job.',
  ].join('\n');

  const intent = String(b.intent || 'a first, brief outreach email').slice(0, 400);

  try {
    const out = await ai.askJson({
      // Judgement slot: this is customer-facing text going out under our name.
      slot: b.slot === 'fast' ? 'quality' : 'deep',
      system,
      messages: [{ role: 'user', content:
        `INTENT: ${intent}\n\nFACTS (the only things you know):\n${JSON.stringify(facts, null, 1)}` }],
      name: 'draft',
      description: 'The drafted email, plus an honest account of what you could not say.',
      schema: {
        type: 'object', additionalProperties: false,
        required: ['subject', 'body', 'facts_used', 'could_not_say'],
        properties: {
          subject: { type: 'string' },
          body: { type: 'string' },
          facts_used: { type: 'array', items: { type: 'string' },
            description: 'Which FACTS fields you actually used.' },
          could_not_say: { type: 'array', items: { type: 'string' },
            description: 'Anything you would normally include but had no fact for. Be specific.' },
        },
      },
      max_tokens: 1200,
    });

    await audit(admin, req, 'ai.draft', {
      targetKind: 'contact', targetId: b.contact_id,
      payload: { model: out.model, slot: out.slot, usage: out.usage, cost_usd: out.cost_usd },
    });

    return json(200, {
      ok: true, draft: out.data,
      // Every AI output is labelled with the model that ACTUALLY served it and its real usage.
      ai: { model: out.model, slot: out.slot, usage: out.usage, cost_usd: out.cost_usd,
            cost_label: 'ESTIMATED from a local rate table; the token counts are measured' },
    });
  } catch (e) {
    await audit(admin, req, 'ai.draft', {
      targetKind: 'contact', targetId: b.contact_id, result: 'failed',
      payload: { error: String(e.message).slice(0, 200) },
    });
    return json(502, { error: String(e.message).slice(0, 300) });
  }
}

/**
 * THE COCKPIT BOARD: the database's half merged with the runtime's half.
 *
 * The database knows the line bank, what is in flight, the queue and the compliance state. Only
 * the running function knows whether a provider is actually answering right now. Every lamp gets
 * BOTH its state and the sentence explaining it, because a lamp that cannot explain itself is
 * decoration, and this console is not allowed decoration that looks like instrumentation.
 *
 * The provider probes run in parallel and each one is individually failure-tolerant: a dead
 * provider must render as a dead lamp, never as a broken page.
 */
async function cockpitBoard() {
  const [board, sms, ai] = await Promise.all([
    rpc('sv_admin_cockpit'),
    outreach.smsReadiness().catch((e) => ({ ok: false, state: 'unknown', why: String(e.message).slice(0, 140) })),
    // The AI probe is a real round trip, not a key-presence check. "The key is set" and "the key
    // works" are different claims and only one of them belongs on a cockpit.
    ai_probeCached(),
  ]);

  // Telephony and SMS share one account, so one authentication failure explains both. Saying so
  // is more useful than showing two red lamps with unrelated-looking reasons.
  const telephonyDown = sms.state === 'provider_unavailable' || sms.state === 'unconfigured';

  return {
    ...board,
    autopilot_kill: process.env.ANSWERED_AUTOPILOT_KILL === '1',
    providers: {
      telephony: telephonyDown
        ? { ok: false, why: sms.why }
        : { ok: true, why: 'Twilio is answering on this account.' },
      sms: { ok: Boolean(sms.ok), state: sms.state, why: sms.why },
      // ★ THIS LAMP SAID "N leads in the book are reachable by email right now" AND THAT WAS A
      // PERMISSION CLAIM COMPUTED FROM A PROPERTY. The count is has-an-address minus suppressed;
      // the outbound lane's classifyEmail() refuses every one of them. The lamp now reports the
      // provider AND the programme separately, because a working mail key is not a cleared channel.
      email: !outreach.emailConfigured()
        ? { ok: false, why: 'RESEND_API_KEY is not set on this deploy, so nothing can be sent.' }
        : process.env.ANSWERED_EMAIL_PROGRAM_READY === '1'
          ? { ok: true, why: 'Resend is configured and the email programme is marked cleared. ' +
                (board.book ? board.book.emailable : 0) + ' leads hold an address and are not suppressed.' }
          : { ok: false, why: 'Resend is configured, but the email programme is NOT cleared, so no ' +
                'address in the book is permission to send. ' + (board.book ? board.book.emailable : 0) +
                ' leads hold an address: that is a property. CAN-SPAM applies in full to a cold ' +
                'commercial message, and California carries $1,000 per message with a private right ' +
                'a business may bring. Arm it with ANSWERED_EMAIL_PROGRAM_READY=1 once the postal ' +
                'address, opt-out, suppression list, domain authentication and state reading are real.' },
      ai: ai,
    },
  };
}

/**
 * The AI probe costs a real API call, and a cockpit that polls would pay for one every tick. Cached
 * for two minutes: long enough that watching the board is free, short enough that the lamp is not
 * lying about a provider that recovered a moment ago.
 */
let aiProbeCache = { at: 0, value: null };
async function ai_probeCached() {
  if (aiProbeCache.value && Date.now() - aiProbeCache.at < 120000) return aiProbeCache.value;
  let v;
  try {
    const r = await ai.probe();
    v = r.ok
      ? { ok: true, why: 'Answered in ' + r.ms + 'ms on ' + r.model + ', direct Anthropic API.', model: r.model, ms: r.ms }
      : { ok: false, why: r.reason || 'The model did not answer.' };
  } catch (e) {
    v = { ok: false, why: String(e.message).slice(0, 160) };
  }
  aiProbeCache = { at: Date.now(), value: v };
  return v;
}

// ── body readers ─────────────────────────────────────────────────────────────────────────────

async function readForm(req) {
  const ct = req.headers.get('content-type') || '';
  const raw = await req.text();
  if (ct.includes('application/json')) {
    try { return JSON.parse(raw || '{}'); } catch { return {}; }
  }
  const out = {};
  new URLSearchParams(raw).forEach((v, k) => { out[k] = v; });
  return out;
}

async function readJson(req) {
  try { return JSON.parse((await req.text()) || '{}'); } catch { return {}; }
}

/** An audit write that does not need a resolved session, for the failed-login path. */
async function auditRaw(who, req, action, extra) {
  return audit(who ? { admin_id: who.admin_id, email: who.email } : null, req, action, extra);
}
