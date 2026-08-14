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

export const config = {
  path: [
    '/admin',
    '/admin/login',
    '/admin/logout',
    '/api/admin/overview',
    '/api/admin/accounts',
    '/api/admin/account',
    '/api/admin/account-status',
    '/api/admin/calls',
    '/api/admin/call',
    '/api/admin/usage',
    '/api/admin/billing',
    '/api/admin/events',
    '/api/admin/parley',
    '/api/admin/audit',
    '/api/admin/system',
    '/api/admin/compliance',
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

const MUTATING = new Set(['account-status', 'refund', 'attribute-backfill', 'log']);

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
      return json(200, row);
    }

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
  return {
    at: new Date().toISOString(),
    evidence,
    dnc,
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
