// jobber-oauth — the three doors of the Jobber connection: start it, finish it, disconnect it.
//
// ── WHAT MAKES THIS DIFFERENT FROM A NORMAL OAUTH CALLBACK ───────────────────────────────────
//
// A callback that stores a token and redirects to a green tick is the version that fails silently.
// It reports "connected" for a connection that has never proved it can do the one thing it exists
// to do. This estate's dominant failure is built-and-wired-but-never-fed, so this callback does
// FOUR things before it will say the word connected:
//
//   1. exchanges the code, and stores the token pair FIRST, before spending anything
//   2. reads the account back from Jobber, so "connected" means a real API call succeeded
//   3. ★ INTROSPECTS THE SCHEMA and proves every mutation the write path needs actually exists
//   4. only then marks the connection `connected`
//
// A schema that does not match marks the connection `error` with the missing field named, and the
// page says so in words. That is a connection that tells the truth about itself on the day it is
// made, rather than on the day a customer's job fails to arrive.
//
// ── THE CSRF DEFENCE IS NOT DECORATIVE ───────────────────────────────────────────────────────
//
// Without `state`, an attacker walks their own Jobber authorization code into a logged-in
// customer's callback and binds THEIR Jobber account to the customer's Answered account. Every job
// that customer books then flows into the attacker's CRM: names, addresses, phone numbers. So the
// state is bound to the session cookie by HMAC, carries a timestamp, and a callback whose state
// does not verify writes nothing at all.

import crypto from 'node:crypto';
import { readSession, readCookie, PRIVATE_HEADERS } from './lib/account-auth.mjs';
import { shell, esc } from './lib/portal-ui.mjs';
import {
  authorizeUrl, exchangeCode, tokenExpiry, saveConnection, getConnection, markError,
  graphql, verifySchema, jobberConfigured, apiVersion,
} from './lib/jobber.mjs';

// ★ A LITERAL. Netlify reads this by static analysis at bundle time and silently drops a computed
// value; this repo has shipped a function whose computed path registered no routes at all.
//
// The PAGE lives here rather than in portal.mjs on purpose: portal.mjs is another lane's file, and
// an integrations page that ships inside the integrations function is one that cannot be half
// deployed. `shell` and `esc` are imported from portal-ui so the page is the same page, in the same
// house style, without editing a file this lane does not own.
export const config = {
  path: [
    '/portal/integrations',
    '/api/integrations/jobber/start',
    '/api/integrations/jobber/callback',
    '/api/integrations/jobber/disconnect',
    '/api/integrations/status',
  ],
};

const STATE_TTL_MS = 10 * 60 * 1000;

const key = () => String(process.env.ANSWERED_ACCOUNT_KEY || process.env.ANSWERED_DB_SECRET || '').trim();

const redirectUri = (req) => `${new URL(req.url).origin}/api/integrations/jobber/callback`;

/**
 * state = <issued-at>.<hmac(issued-at | account id)>
 *
 * Bound to the account, so a state minted for one session cannot complete a connection for another,
 * and timestamped, so a state that leaks into a log or a referrer header stops working in ten
 * minutes rather than never.
 */
function mintState(accountId) {
  const ts = Date.now().toString(36);
  const mac = crypto.createHmac('sha256', key()).update(`jobber|${ts}|${accountId}`).digest('base64url').slice(0, 32);
  return `${ts}.${mac}`;
}

function checkState(state, accountId) {
  const [ts, mac] = String(state || '').split('.');
  if (!ts || !mac) return 'the state parameter is missing or malformed';
  const age = Date.now() - parseInt(ts, 36);
  if (!Number.isFinite(age) || age < 0 || age > STATE_TTL_MS) return 'the connection link expired, please start again';
  const want = crypto.createHmac('sha256', key()).update(`jobber|${ts}|${accountId}`).digest('base64url').slice(0, 32);
  const a = Buffer.from(mac);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'the state parameter does not match this session';
  return null;
}

const ACCOUNT_QUERY = `query AnsweredAccount { account { id name } }`;

const seeOther = (to) => new Response('', { status: 303, headers: { Location: to, ...PRIVATE_HEADERS } });
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...PRIVATE_HEADERS } });

/** Back to the integrations page carrying a message the page renders verbatim. */
const back = (kind, msg) =>
  seeOther(`/portal/integrations?${kind}=${encodeURIComponent(String(msg).slice(0, 300))}`);

/**
 * What is true about Jobber for this account, read once and rendered by both the page and the API.
 *
 * A read that throws is reported as a read that threw. It is NOT reported as "not connected": a
 * database hiccup rendering as a disconnected integration would invite somebody to reconnect, which
 * mints a new token pair and can orphan the old one.
 */
async function jobberStatus(accountId) {
  if (!jobberConfigured()) {
    // ★ HONEST, NOT HIDDEN. "Not available on this deploy" is a true sentence; a Connect button that
    // leads to a Jobber error page is not.
    return { available: false, reason: 'this deploy has no Jobber app credentials, so connecting is not available yet' };
  }
  let got;
  try {
    got = await getConnection(accountId);
  } catch (e) {
    return { available: true, connected: false, status: 'unknown', last_error: `the connection could not be read: ${String(e && e.message).slice(0, 160)}` };
  }
  if (!got || !got.ok) return { available: true, connected: false };
  const c = got.connection || {};
  return {
    available: true,
    connected: c.status === 'connected',
    status: c.status,
    account_name: c.external_account_name || null,
    last_ok_at: c.last_ok_at || null,
    last_error: c.last_error || null,
    api_version: apiVersion(),
  };
}

// ── the page ──────────────────────────────────────────────────────────────────────────────────

/**
 * One card per integration, and the card says what is TRUE about this deploy.
 *
 * ★ THERE IS NO CONNECT BUTTON WHEN CONNECTING CANNOT WORK. A control that cannot act is the exact
 * defect this estate has shipped more than once: a dead play button over a missing file, a
 * one-click activation rendering live while the provider was unfunded. If the deploy has no Jobber
 * credentials, this page says so in a sentence and renders no button at all, because a button that
 * leads to a vendor error page is a worse answer than an honest one.
 */
function integrationsPage({ jobber, flash }) {
  const band = flash
    ? `<div class="band ${flash.kind === 'err' ? 'stop' : 'note'}"><b class="${flash.kind === 'err' ? 'err' : 'ok'}">${
      esc(flash.kind === 'err' ? 'That did not work' : 'Done')}</b>${esc(flash.text)}</div>`
    : '';

  let card;
  if (!jobber.available) {
    card = `<p class="none">${esc(jobber.reason)}</p>`;
  } else if (jobber.connected) {
    card = `
      <p class="switch state on">Connected${jobber.account_name ? ` to ${esc(jobber.account_name)}` : ''}</p>
      <p class="small">Every job booked on your line is created in Jobber as a request, with the caller,
        the address, the callback number and the window they agreed to. A job that is already there is
        never created twice, even if we retry.</p>
      ${jobber.last_ok_at ? `<p class="small">Last confirmed working ${esc(new Date(jobber.last_ok_at).toUTCString())}.</p>` : ''}
      <form method="POST" action="/api/integrations/jobber/disconnect">
        <button class="cta ghost danger" type="submit">Disconnect Jobber</button>
      </form>`;
  } else if (jobber.status && jobber.status !== 'connected') {
    // ★ A BROKEN CONNECTION SAYS WHAT BROKE, IN JOBBER'S OWN WORDS. "Something went wrong" turns a
    // one-line fix into a support ticket.
    card = `
      <p class="switch state blocked">Not sending${jobber.status ? ` (${esc(jobber.status)})` : ''}</p>
      ${jobber.last_error ? `<p class="small err">${esc(jobber.last_error)}</p>` : ''}
      <p class="small">Nothing is being written to Jobber while this says anything other than connected.</p>
      <a class="cta" href="/api/integrations/jobber/start">Reconnect Jobber</a>`;
  } else {
    card = `
      <p class="small">Connect your Jobber account and every job booked on your line arrives there as a
        request: the caller, the address, the callback number, and the window they agreed to on the
        call. We create a request rather than a scheduled visit, because a window a caller agreed to
        is a request for that time, not a commitment your scheduler made.</p>
      <a class="cta" href="/api/integrations/jobber/start">Connect Jobber</a>`;
  }

  return shell({
    title: 'Integrations · Answered',
    body: `
      <div class="top"><div class="mark"><span class="dot"></span>Answered</div>
        <a class="small" href="/portal">Back to jobs</a></div>
      <h1>Integrations</h1>
      ${band}
      <div class="card">
        <h3>Jobber</h3>
        ${card}
      </div>
      <p class="foot small">Only the jobs booked on your line are sent. We never read your customer
        list, and we never write anything you did not book through Answered.</p>`,
  });
}

export default async function handler(req) {
  const path = new URL(req.url).pathname;

  const accountId = readSession(readCookie(req.headers));
  if (!accountId) {
    // The status route is the one a page polls, so it answers in JSON; the rest are browser doors.
    return path.endsWith('/status')
      ? json(401, { ok: false, reason: 'not signed in' })
      : seeOther('/portal/login');
  }

  // ── status ──────────────────────────────────────────────────────────────────────────────────
  // ★ ONE SOURCE FOR BOTH THE PAGE AND THE API. Two readers computing "connected" separately is how
  // a page renders a green tick over an API that says error.
  if (path === '/api/integrations/status') return json(200, { ok: true, jobber: await jobberStatus(accountId) });

  // ── the page ────────────────────────────────────────────────────────────────────────────────
  if (path === '/portal/integrations') {
    const url = new URL(req.url);
    const err = url.searchParams.get('error');
    const ok = url.searchParams.get('ok');
    const notice = url.searchParams.get('notice');
    const flash = err ? { kind: 'err', text: err } : (ok || notice ? { kind: 'ok', text: ok || notice } : null);
    return new Response(integrationsPage({ jobber: await jobberStatus(accountId), flash }), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...PRIVATE_HEADERS },
    });
  }

  // ── start ───────────────────────────────────────────────────────────────────────────────────
  if (path === '/api/integrations/jobber/start') {
    if (!jobberConfigured()) return back('error', 'Jobber is not configured on this deploy yet.');
    if (!key()) return back('error', 'This deploy cannot sign a connection request. Nothing was changed.');
    try {
      return seeOther(authorizeUrl({ redirectUri: redirectUri(req), state: mintState(accountId) }));
    } catch (e) {
      return back('error', String((e && e.message) || e));
    }
  }

  // ── disconnect ──────────────────────────────────────────────────────────────────────────────
  if (path === '/api/integrations/jobber/disconnect') {
    if (req.method !== 'POST') return json(405, { ok: false, reason: 'POST only' });
    // ★ THE TOKENS ARE NOT DELETED, THE CONNECTION IS MARKED REVOKED. The write path refuses any
    // status other than `connected`, so revoked is a real stop. Keeping the row means the console
    // can still say when it was connected and when it stopped, which a deleted row cannot.
    await markError(accountId, 'disconnected by the account owner', 'revoked').catch(() => {});
    return json(200, { ok: true, status: 'revoked' });
  }

  // ── callback ────────────────────────────────────────────────────────────────────────────────
  if (path !== '/api/integrations/jobber/callback') return json(404, { ok: false });

  const url = new URL(req.url);
  const denied = url.searchParams.get('error');
  if (denied) {
    return back('notice', url.searchParams.get('error_description') || 'The Jobber connection was not approved.');
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code) return back('error', 'Jobber did not send an authorization code back. Nothing was changed.');

  const bad = checkState(state, accountId);
  if (bad) {
    // Loud on the server, plain to the person. A state failure is either an expired link or an
    // attempt to bind somebody else's Jobber account to this one, and both end here.
    console.error('jobber-oauth: REFUSED a callback,', bad, '— nothing was written.');
    return back('error', bad);
  }

  let tokens;
  try {
    tokens = await exchangeCode(code, redirectUri(req));
  } catch (e) {
    return back('error', String((e && e.message) || e));
  }

  // ★ STORED FIRST, AS `pending`, BEFORE THE ACCESS TOKEN IS SPENT ON ANYTHING.
  // Jobber rotates the refresh token, so a pair we received but did not record is a pair we can
  // never renew. `pending` is deliberate: the write path only accepts `connected`, so a crash
  // between here and the verification below leaves a connection that cannot write rather than one
  // that claims it can.
  try {
    await saveConnection({
      account_id: accountId,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      expires_at: tokenExpiry(tokens.access_token, tokens.expires_in),
      status: 'pending',
      connected_by: 'portal',
    });
  } catch (e) {
    return back('error', `Jobber approved the connection but it could not be saved: ${String(e && e.message).slice(0, 160)}`);
  }

  // 2. prove the token actually works, by reading the account back
  const acct = await graphql(tokens.access_token, ACCOUNT_QUERY);
  if (!acct.ok) {
    const why = (acct.errors || ['Jobber would not answer with this token']).join(' | ');
    await markError(accountId, why, 'error').catch(() => {});
    return back('error', `Jobber returned the connection but the first API call failed: ${why.slice(0, 200)}`);
  }
  const jAcct = (acct.data && acct.data.account) || {};

  // 3. ★ PROVE THE SCHEMA. This is the step that stops a connector shipping a guess.
  const schema = await verifySchema(tokens.access_token);
  if (!schema.ok) {
    const why = schema.missing.length
      ? `the Jobber API version ${schema.version} does not have: ${schema.missing.join(', ')}`
      : (schema.reason || 'the schema could not be verified');
    await markError(accountId, why, 'error').catch(() => {});
    console.error('jobber-oauth: schema verification FAILED —', why);
    return back('error', `Connected to ${jAcct.name || 'Jobber'}, but jobs cannot be sent yet: ${why}. Nothing will be written until this is fixed.`);
  }

  // 4. only now is it connected
  await saveConnection({
    account_id: accountId,
    external_account_id: jAcct.id || null,
    external_account_name: jAcct.name || null,
    status: 'connected',
  });

  console.log(`jobber-oauth: connected account ${String(accountId).slice(0, 8)} to Jobber "${jAcct.name || '?'}", schema verified against ${schema.version}.`);
  return back('ok', `Connected to ${jAcct.name || 'your Jobber account'}. New jobs will be sent there.`);
}
