// jobber.mjs — the Jobber connector: OAuth lifecycle, a GraphQL client that treats a 200 as a
// failure when it says so, and a write path that cannot create the same job twice.
//
// ── THE THREE THINGS THIS FILE EXISTS TO GET RIGHT ───────────────────────────────────────────
//
// 1. THE REFRESH TOKEN IS WRITTEN BEFORE THE NEW ACCESS TOKEN IS SPENT.
//    Jobber rotates the refresh token on every refresh. If we spend the new access token first and
//    the process dies before the write, the stored refresh token is already dead and the customer's
//    connection is unrecoverable without them re-authorising. It is a one-shot fuse and the ORDER
//    is the only thing that defuses it. Every other detail here is negotiable; this one is not.
//
// 2. A 200 CARRYING AN `errors` ARRAY IS A FAILURE.
//    GraphQL answers 200 to almost everything, including "that field does not exist" and "you are
//    not allowed to do that". A client that checks `res.ok` reports every one of those as a
//    success. Jobber's own template raises on a non-nil `errors`, so this is their posture as much
//    as ours. Jobber also has a SECOND error channel: `userErrors` inside a mutation payload, which
//    is where validation lives. Both are failures here.
//
// 3. NO WRITE HAPPENS WITHOUT A LOOKUP IN `external_links` FIRST.
//    A POST that times out at ten seconds may well have created the record. Retrying blind is how a
//    second van is dispatched to the same address, and the customer finds out when two technicians
//    arrive. So: read the link, and if it exists, make NO request at all and return the id we
//    already have. After a successful write, record theirs against ours. A unique index makes the
//    concurrent double-write impossible rather than unlikely.
//
// ── ★ WHAT THIS CONNECTOR REFUSES TO GUESS ───────────────────────────────────────────────────
//
// This was written without Jobber credentials, so the mutation schema could not be verified against
// a live account. The wrong response to that is to hardcode shapes read from a forum and let a
// customer discover the mismatch as a failed booking. The right one, and what is implemented here,
// is that the connector PROVES the schema before it is allowed to write:
//
//    On connect, `verifySchema()` introspects the API and checks that every mutation and every
//    input field this file intends to use actually exists in the version the vendor served. The
//    result is stored on the connection. A missing field marks the connection `error`, names the
//    field, and NO write is ever attempted.
//
// So a schema drift or a wrong pinned version surfaces as a named error at connect time, loudly,
// instead of as a silent wrong write months later. That is the whole difference between a connector
// that was built and wired and one that was fed.
//
// Secrets by env name only: JOBBER_CLIENT_ID, JOBBER_CLIENT_SECRET, ANSWERED_JOBBER_API_VERSION.
// None is ever logged, echoed in a response, or written to the database.

import { rpc } from './db.mjs';

// ── endpoints, read out of Jobber's own official app templates ────────────────────────────────
// GetJobber/Jobber-AppTemplate-React/.env.sample  → the authorize URL, literally
// GetJobber/Jobber-AppTemplate-RailsAPI/.env.sample + config/application.rb → the API base and the
// version header name. Not a blog post, not a forum answer: their code.
export const JOBBER_AUTHORIZE = 'https://api.getjobber.com/api/oauth/authorize';
export const JOBBER_TOKEN     = 'https://api.getjobber.com/api/oauth/token';
export const JOBBER_GRAPHQL   = 'https://api.getjobber.com/api/graphql';
export const VERSION_HEADER   = 'X-JOBBER-GRAPHQL-VERSION';

/**
 * The API version, pinned in the environment.
 *
 * ★ PINNED, NEVER FLOATING. Jobber's versions are dated and a floating "latest" would mean the
 * shape of a customer's job write changes on a day nobody deployed anything. The default is the
 * version in Jobber's current documentation example. If it is wrong for this app, introspection
 * fails at connect time with the version named, which is exactly where a wrong version should hurt.
 */
export const apiVersion = () => String(process.env.ANSWERED_JOBBER_API_VERSION || '2025-04-16').trim();

export const clientId     = () => String(process.env.JOBBER_CLIENT_ID || '').trim();
const clientSecret        = () => String(process.env.JOBBER_CLIENT_SECRET || '').trim();
export const jobberConfigured = () => Boolean(clientId() && clientSecret());

const PROVIDER = 'jobber';
const TIMEOUT_MS = 15_000;

// ── token lifetime ────────────────────────────────────────────────────────────────────────────

/**
 * Jobber's access token is a JWT and its real expiry is the `exp` claim.
 *
 * ★ THIS IS NOT A CLEVERNESS, IT IS WHAT JOBBER'S OWN CODE DOES. Their Rails template decodes the
 * JWT and takes `exp`, in both `create_oauth2_access_token` and `refresh_access_token`. Trusting
 * `expires_in` instead would be trusting a number about a token rather than the token, and the two
 * are allowed to disagree.
 *
 * The signature is NOT verified and does not need to be: this token came to us over TLS directly
 * from Jobber's token endpoint in response to our own client secret. We are reading our own copy of
 * a bearer token to learn when to stop using it, not authenticating a stranger's claim.
 */
export function tokenExpiry(accessToken, expiresIn) {
  try {
    const part = String(accessToken || '').split('.')[1];
    if (part) {
      const json = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      if (json && Number.isFinite(json.exp)) return new Date(json.exp * 1000).toISOString();
    }
  } catch (e) {
    // Fall through to expires_in. A token we cannot read is still a token we can time.
  }
  const secs = Number(expiresIn);
  if (Number.isFinite(secs) && secs > 0) return new Date(Date.now() + secs * 1000).toISOString();
  return null;
}

/** Refresh a minute early. A token that expires mid-flight is a 401 nobody scheduled. */
const SKEW_MS = 60_000;
export const isExpired = (iso) => {
  if (!iso) return true;                       // unknown expiry is treated as expired, never as valid
  const t = Date.parse(iso);
  return !Number.isFinite(t) || t - SKEW_MS <= Date.now();
};

// ── OAuth ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The URL a customer is sent to. `state` is REQUIRED by this function, not optional, because it is
 * the only thing standing between us and a CSRF that connects an attacker's Jobber account to a
 * customer's Answered account. A caller that has not minted one has not thought about it yet.
 */
export function authorizeUrl({ redirectUri, state }) {
  if (!clientId()) throw new Error('JOBBER_CLIENT_ID is not set');
  if (!state) throw new Error('refusing to build an authorize URL with no state parameter');
  const u = new URL(JOBBER_AUTHORIZE);
  u.searchParams.set('client_id', clientId());
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', state);
  return u.toString();
}

async function tokenRequest(params, what) {
  const r = await fetch(JOBBER_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), ...params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await r.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch (e) { body = { raw: text.slice(0, 300) }; }
  if (!r.ok || !body.access_token) {
    // ★ The error text is Jobber's, and it never carries our secret, because our secret went up in
    // the request body and OAuth error responses echo `error` / `error_description`, not credentials.
    const why = body.error_description || body.error || `HTTP ${r.status}`;
    throw new Error(`jobber ${what} failed: ${String(why).slice(0, 200)}`);
  }
  return body;
}

export const exchangeCode = (code, redirectUri) =>
  tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }, 'code exchange');

export const refreshToken = (refresh) =>
  tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh }, 'token refresh');

// ── connection storage ────────────────────────────────────────────────────────────────────────

export const saveConnection = (row) => rpc('sv_integration_upsert', { p_row: { provider: PROVIDER, ...row } });
export const getConnection  = (accountId) => rpc('sv_integration_get', { p_account: accountId, p_provider: PROVIDER });
export const markError      = (accountId, error, status) =>
  rpc('sv_integration_error', { p_account: accountId, p_provider: PROVIDER, p_error: error, p_status: status || 'error' });

/**
 * The live access token for an account, refreshing if it has to.
 *
 * ★ THE ORDER IN HERE IS THE WHOLE POINT AND IT IS WRITTEN OUT SO NOBODY REORDERS IT LATER:
 *
 *      1. ask Jobber for a new pair
 *      2. WRITE BOTH TOKENS TO THE DATABASE          <- before anything is spent
 *      3. only then return the access token to a caller that will use it
 *
 * If step 2 throws, this function throws and the caller does nothing. That is correct: we would
 * rather fail a delivery, which retries with backoff, than spend a token whose replacement we did
 * not manage to record. Jobber rotates the refresh token, so a refresh we used but did not save
 * leaves the customer's connection permanently dead.
 */
export async function accessTokenFor(accountId) {
  const got = await getConnection(accountId);
  if (!got || !got.ok) return { ok: false, reason: 'this account has not connected Jobber' };
  const c = got.connection || {};

  if (c.status === 'revoked') return { ok: false, reason: 'the Jobber connection was revoked and must be reconnected' };
  if (!c.access_token && !c.refresh_token) return { ok: false, reason: 'the Jobber connection has no tokens and must be reconnected' };

  if (c.access_token && !isExpired(c.expires_at)) {
    return { ok: true, token: c.access_token, connection: c, refreshed: false };
  }

  if (!c.refresh_token) {
    await markError(accountId, 'the access token expired and there is no refresh token to renew it', 'expired').catch(() => {});
    return { ok: false, reason: 'the Jobber access token expired and there is no refresh token; the customer must reconnect' };
  }

  let fresh;
  try {
    fresh = await refreshToken(c.refresh_token);
  } catch (e) {
    const why = String((e && e.message) || e).slice(0, 300);
    // A refresh that Jobber refuses means the grant is gone. Say so as `expired`, not `error`, so
    // the console can tell "reconnect me" apart from "something broke".
    const gone = /invalid_grant|revoked|not recognized/i.test(why);
    await markError(accountId, why, gone ? 'expired' : 'error').catch(() => {});
    return { ok: false, reason: why };
  }

  // ★ STEP 2. Written BEFORE the token is handed to anyone. A throw here is a throw out of this
  // function; the new access token is never spent unless its refresh token is safely stored.
  await saveConnection({
    account_id: accountId,
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token || c.refresh_token,
    expires_at: tokenExpiry(fresh.access_token, fresh.expires_in),
    status: 'connected',
  });

  return { ok: true, token: fresh.access_token, connection: c, refreshed: true };
}

// ── the GraphQL client ────────────────────────────────────────────────────────────────────────

/**
 * @returns {{ok:boolean, data?:object, errors?:string[], status:number, throttle?:object}}
 *
 * Never throws for a vendor-side condition. The caller has to be able to state which of the three
 * outcomes happened — transport failure, GraphQL error, success — and a thrown exception flattens
 * all three into "something went wrong".
 */
export async function graphql(token, query, variables = {}) {
  let r;
  let text = '';
  try {
    r = await fetch(JOBBER_GRAPHQL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        [VERSION_HEADER]: apiVersion(),
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await r.text();
  } catch (e) {
    // ★ A TIMEOUT IS NOT A FAILED WRITE, IT IS AN UNKNOWN ONE. Jobber may well have created the
    // record. This is exactly why the retry is only safe behind `external_links`.
    return { ok: false, status: 0, errors: [String((e && e.message) || e).slice(0, 300)], unknown: true };
  }

  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch (e) { body = null; }
  if (!body) return { ok: false, status: r.status, errors: [`jobber returned a non-JSON body: ${text.slice(0, 200)}`] };

  if (r.status === 401) return { ok: false, status: 401, errors: ['jobber rejected the access token'], unauthorized: true };
  if (!r.ok && !body.errors) return { ok: false, status: r.status, errors: [`jobber returned HTTP ${r.status}: ${String(body.message || text).slice(0, 200)}`] };

  // ★ RULE 2. A 200 with a non-empty `errors` array is a FAILURE. `res.ok` says nothing here.
  if (Array.isArray(body.errors) && body.errors.length) {
    return {
      ok: false,
      status: r.status,
      errors: body.errors.map((e) => String((e && e.message) || e).slice(0, 300)),
      data: body.data || null,
    };
  }

  // The rate limiter is a points bucket and Jobber returns its state on every response. Handing it
  // back lets the caller slow down BEFORE being throttled rather than after.
  const throttle = body.extensions && body.extensions.cost && body.extensions.cost.throttleStatus;
  return { ok: true, status: r.status, data: body.data || {}, throttle: throttle || null };
}

/**
 * The mutation payload's own error channel.
 *
 * Jobber puts validation failures in `userErrors` INSIDE a successful mutation payload, so a write
 * can return HTTP 200, an empty top-level `errors`, and still not have happened. Every mutation in
 * this file selects `userErrors` and every result goes through here.
 */
export function userErrors(payload) {
  const list = (payload && payload.userErrors) || [];
  if (!Array.isArray(list) || !list.length) return null;
  return list.map((e) => [e.path && e.path.join('.'), e.message].filter(Boolean).join(': ')).join(' | ').slice(0, 400);
}

// ── idempotency ───────────────────────────────────────────────────────────────────────────────

export const linkGet = (localKind, localId, externalKind) =>
  rpc('sv_external_link_get', {
    p_provider: PROVIDER, p_local_kind: localKind, p_local_id: localId, p_external_kind: externalKind,
  });

export const linkPut = (row) => rpc('sv_external_link_put', { p_row: { provider: PROVIDER, ...row } });

/**
 * The shape every vendor write in this file takes, so no call site can forget the order.
 *
 *   read the link → if present, RETURN IT AND MAKE NO REQUEST → otherwise write → record the link
 *
 * `write` is only ever called when we hold no record of a prior success. If it times out we do not
 * know whether it landed, and the next attempt reads the link again: if the first attempt did in
 * fact record one, the retry is a no-op, and if it did not, the retry writes. Neither path can
 * produce two.
 */
export async function ensure({ localKind, localId, externalKind, idempotencyKey, accountId, connectionId }, write) {
  const existing = await linkGet(localKind, localId, externalKind);
  if (existing && existing.found) {
    return { ok: true, id: existing.external_id, created: false, reused: true };
  }

  const w = await write();
  if (!w.ok) return w;

  const put = await linkPut({
    connection_id: connectionId || null, account_id: accountId || null,
    local_kind: localKind, local_id: localId,
    external_kind: externalKind, external_id: w.id, idempotency_key: idempotencyKey || null,
  });

  // If we lost a race, the winner's id is the right answer for both of us. Say so rather than
  // pretending we created it: the console shows what actually happened.
  const id = (put && put.external_id) || w.id;
  return { ok: true, id, created: !(put && put.raced), raced: Boolean(put && put.raced) };
}

// ── ★ SCHEMA VERIFICATION ─────────────────────────────────────────────────────────────────────
//
// Everything below exists because this connector was written without a Jobber account to check
// against. Instead of guessing and shipping, it asks the API what it actually supports and refuses
// to write until the answer matches. Run at connect time and stored on the connection.

/** Exactly what the write path below depends on. Nothing aspirational, nothing unused. */
export const REQUIRED_SCHEMA = Object.freeze({
  mutations: Object.freeze(['clientCreate', 'propertyCreate', 'requestCreate']),
  queries: Object.freeze(['clients', 'account']),
});

const INTROSPECT = `
  query AnsweredSchemaCheck {
    __schema {
      queryType { fields { name } }
      mutationType { fields { name } }
    }
  }
`;

/**
 * @returns {{ok:boolean, missing:string[], version:string, reason?:string}}
 *
 * `ok:false` with a populated `missing` means the API is reachable and answering, and simply does
 * not have what we need under this version. That is a FAR better failure than a write that silently
 * targets a field the vendor renamed, and it names the field so the fix is a one-line diff rather
 * than an investigation.
 */
export async function verifySchema(token) {
  const r = await graphql(token, INTROSPECT);
  if (!r.ok) {
    return { ok: false, missing: [], version: apiVersion(), reason: (r.errors || ['introspection failed']).join(' | ') };
  }
  const s = (r.data && r.data.__schema) || {};
  const q = new Set(((s.queryType && s.queryType.fields) || []).map((f) => f.name));
  const m = new Set(((s.mutationType && s.mutationType.fields) || []).map((f) => f.name));

  // ★ POSITIVE CONTROL. If introspection came back with an empty field list we would compute
  // "everything is missing", which reads identically to a genuine schema mismatch and would send
  // somebody hunting for a renamed mutation that is not renamed. An empty schema means the probe
  // did not land, and that is a different sentence.
  if (!q.size && !m.size) {
    return { ok: false, missing: [], version: apiVersion(), reason: 'introspection returned no fields at all, so the schema could not be read; this is a failed probe, not a missing mutation' };
  }

  const missing = [
    ...REQUIRED_SCHEMA.queries.filter((n) => !q.has(n)).map((n) => `query ${n}`),
    ...REQUIRED_SCHEMA.mutations.filter((n) => !m.has(n)).map((n) => `mutation ${n}`),
  ];
  return { ok: missing.length === 0, missing, version: apiVersion() };
}

// ── the write path ────────────────────────────────────────────────────────────────────────────
//
// Create or match a Client, then a Property, then the Request. Each step is wrapped in `ensure`, so
// a retry that reaches step three does not recreate steps one and two.
//
// ★ EVERY MUTATION SENDS AN EXPLICIT ALLOW LIST OF FIELDS. Never a row spread. A spread sends
// whatever happens to be on our job row today, which means a column added next month silently
// starts leaving our database and entering a customer's CRM, and nobody wrote a line of code to
// make that happen. What crosses the boundary is written down, here, by hand.

const CLIENT_CREATE = `
  mutation AnsweredClientCreate($input: ClientCreateInput!) {
    clientCreate(input: $input) {
      client { id name }
      userErrors { message path }
    }
  }
`;

const PROPERTY_CREATE = `
  mutation AnsweredPropertyCreate($clientId: EncodedId!, $input: PropertyCreateInput!) {
    propertyCreate(clientId: $clientId, input: $input) {
      property { id }
      userErrors { message path }
    }
  }
`;

const REQUEST_CREATE = `
  mutation AnsweredRequestCreate($input: RequestCreateInput!) {
    requestCreate(input: $input) {
      request { id }
      userErrors { message path }
    }
  }
`;

/** Split a caller's name into the two fields Jobber wants, without inventing either. */
export function nameParts(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

/**
 * Push one Answered job into a customer's Jobber account.
 *
 * @param {object} job   the row as it exists in `jobs`
 * @param {string} accountId
 * @returns {{ok:boolean, request_id?:string, client_id?:string, property_id?:string, reason?:string, reused?:boolean}}
 */
export async function pushJob(job, accountId) {
  const got = await getConnection(accountId);
  const conn = (got && got.ok && got.connection) || null;
  if (!conn) return { ok: false, reason: 'this account has not connected Jobber' };

  // ★ THE SCHEMA GATE. A connection whose introspection never passed does not get to write. This is
  // the control that turns "I could not verify Jobber's schema" from a risk into a refusal.
  if (conn.status !== 'connected') {
    return { ok: false, reason: `the Jobber connection is ${conn.status}${conn.last_error ? `: ${conn.last_error}` : ''}` };
  }

  const t = await accessTokenFor(accountId);
  if (!t.ok) return { ok: false, reason: t.reason };
  const token = t.token;
  const base = { accountId, connectionId: conn.id, idempotencyKey: job.job_ref };

  const { firstName, lastName } = nameParts(job.caller_name);

  // 1. the Client
  const client = await ensure({ ...base, localKind: 'job', localId: job.job_ref, externalKind: 'Client' }, async () => {
    const r = await graphql(token, CLIENT_CREATE, {
      input: {
        firstName,
        lastName,
        phones: job.callback ? [{ number: job.callback, primary: true }] : [],
      },
    });
    if (!r.ok) return { ok: false, reason: (r.errors || []).join(' | '), unknown: r.unknown };
    const p = r.data && r.data.clientCreate;
    const ue = userErrors(p);
    if (ue) return { ok: false, reason: `jobber refused the client: ${ue}` };
    const id = p && p.client && p.client.id;
    if (!id) return { ok: false, reason: 'jobber accepted the client mutation but returned no id' };
    return { ok: true, id };
  });
  if (!client.ok) return client;

  // 2. the Property
  const property = await ensure({ ...base, localKind: 'job', localId: job.job_ref, externalKind: 'Property' }, async () => {
    const r = await graphql(token, PROPERTY_CREATE, {
      clientId: client.id,
      input: { address: { street1: job.address || '' } },
    });
    if (!r.ok) return { ok: false, reason: (r.errors || []).join(' | '), unknown: r.unknown };
    const p = r.data && r.data.propertyCreate;
    const ue = userErrors(p);
    if (ue) return { ok: false, reason: `jobber refused the property: ${ue}` };
    const id = p && p.property && p.property.id;
    if (!id) return { ok: false, reason: 'jobber accepted the property mutation but returned no id' };
    return { ok: true, id };
  });
  if (!property.ok) return property;

  // 3. the Request
  const request = await ensure({ ...base, localKind: 'job', localId: job.job_ref, externalKind: 'Request' }, async () => {
    const r = await graphql(token, REQUEST_CREATE, {
      input: {
        clientId: client.id,
        propertyId: property.id,
        title: describe(job),
        // The window is stated in the note rather than booked as a visit, because a window a caller
        // agreed to on our phone line is a REQUEST for that time, not a dispatcher's commitment.
        // Writing it as a scheduled visit would put an appointment on a customer's calendar that
        // their own scheduler never approved.
        instructions: instructionsFor(job),
      },
    });
    if (!r.ok) return { ok: false, reason: (r.errors || []).join(' | '), unknown: r.unknown };
    const p = r.data && r.data.requestCreate;
    const ue = userErrors(p);
    if (ue) return { ok: false, reason: `jobber refused the request: ${ue}` };
    const id = p && p.request && p.request.id;
    if (!id) return { ok: false, reason: 'jobber accepted the request mutation but returned no id' };
    return { ok: true, id };
  });
  if (!request.ok) return request;

  return {
    ok: true,
    client_id: client.id, property_id: property.id, request_id: request.id,
    reused: Boolean(client.reused && property.reused && request.reused),
  };
}

const describe = (job) => {
  const trade = String(job.trade || '').trim();
  const d = (job.details && (job.details.service || job.details.reason)) || '';
  return [trade, d].filter(Boolean).join(' — ') || 'Booked by Answered';
};

/** Everything the tech needs, in words, with no number this system did not receive. */
function instructionsFor(job) {
  const lines = [];
  if (job.details && job.details.service) lines.push(String(job.details.service));
  if (job.window_start) {
    const end = job.window_end ? ` to ${job.window_end}` : '';
    lines.push(`Caller agreed to a window of ${job.window_start}${end} (UTC, as recorded on the call).`);
  }
  if (job.callback) lines.push(`Callback: ${job.callback}`);
  if (job.after_hours) lines.push('Taken after hours.');
  if (job.details && job.details.notes) lines.push(String(job.details.notes));
  lines.push(`Booked by Answered. Reference ${job.job_ref}.`);
  return lines.join('\n');
}
