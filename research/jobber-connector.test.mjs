// research/jobber-connector.test.mjs — what the Jobber connector actually does, measured.
//
// Run: node research/jobber-connector.test.mjs
//
// ── WHAT THESE TESTS ARE FOR, AND WHAT THEY REFUSE TO PRETEND ────────────────────────────────
//
// Every test here has a PRE-STATE it could have failed in. The question this estate keeps paying
// for is "what would this check have printed if the thing were broken?", so several of these are
// paired with a NEGATIVE CONTROL that proves the assertion can fail.
//
// The one thing these tests do NOT establish is that Jobber's mutation names and input fields are
// correct, because that cannot be established without credentials against a live account. That is
// why the connector introspects the schema at connect time and refuses to write until it matches.
// A green run here means the plumbing is right, not that the vendor agrees with us.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  tokenExpiry, isExpired, userErrors, nameParts, ensure, authorizeUrl,
  REQUIRED_SCHEMA, apiVersion, JOBBER_AUTHORIZE, JOBBER_TOKEN, JOBBER_GRAPHQL, VERSION_HEADER,
} from '../netlify/functions/lib/jobber.mjs';

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};
const ta = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

const jwt = (payload) => [
  Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
  Buffer.from(JSON.stringify(payload)).toString('base64url'),
  'sig',
].join('.');

console.log('\n── endpoints, against the values read out of Jobber\'s own official templates ──');

t('the endpoints are the ones in GetJobber\'s templates, not a paraphrase of them', () => {
  assert.equal(JOBBER_AUTHORIZE, 'https://api.getjobber.com/api/oauth/authorize');
  assert.equal(JOBBER_TOKEN, 'https://api.getjobber.com/api/oauth/token');
  assert.equal(JOBBER_GRAPHQL, 'https://api.getjobber.com/api/graphql');
  assert.equal(VERSION_HEADER, 'X-JOBBER-GRAPHQL-VERSION');
});

t('the API version is pinned to a dated version, never floating', () => {
  assert.match(apiVersion(), /^\d{4}-\d{2}-\d{2}$/,
    `a floating version means the shape of a customer's job write changes on a day nobody deployed; got ${apiVersion()}`);
});

console.log('\n── token lifetime: the JWT exp claim wins over expires_in ──');

t('the expiry comes from the JWT exp claim, which is what Jobber\'s own code reads', () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  // expires_in deliberately DISAGREES. If the implementation trusted it, this test fails.
  const got = tokenExpiry(jwt({ exp }), 60);
  assert.equal(got, new Date(exp * 1000).toISOString());
});

t('NEGATIVE CONTROL: a token with no readable exp falls back to expires_in rather than throwing', () => {
  const got = tokenExpiry('not-a-jwt', 3600);
  const drift = Math.abs(Date.parse(got) - (Date.now() + 3600_000));
  assert.ok(drift < 5000, `expected roughly an hour out, got ${got}`);
});

t('an unreadable token with no expires_in returns null, and null is treated as EXPIRED', () => {
  assert.equal(tokenExpiry('garbage', undefined), null);
  // ★ The important half. An unknown expiry that read as "valid" would be a token used forever.
  assert.equal(isExpired(null), true);
  assert.equal(isExpired('not a date'), true);
});

t('a token expiring inside the skew window is already expired', () => {
  assert.equal(isExpired(new Date(Date.now() + 30_000).toISOString()), true,
    'a token that expires in 30s must not be handed to a request that takes 15s');
  assert.equal(isExpired(new Date(Date.now() + 600_000).toISOString()), false);
});

console.log('\n── the second error channel: userErrors inside a 200 ──');

t('userErrors turns a "successful" mutation payload into a named failure', () => {
  const got = userErrors({ userErrors: [{ message: 'Street is required', path: ['input', 'address', 'street1'] }] });
  assert.match(got, /input\.address\.street1: Street is required/);
});

t('NEGATIVE CONTROL: a clean payload returns null, so the check is not simply always-fail', () => {
  assert.equal(userErrors({ userErrors: [] }), null);
  assert.equal(userErrors({ client: { id: 'x' } }), null);
  assert.equal(userErrors(null), null);
});

console.log('\n── names are split, never invented ──');

t('a single-word name does not get a fabricated surname', () => {
  assert.deepEqual(nameParts('Cher'), { firstName: 'Cher', lastName: '' });
});
t('a three-part name keeps the last token as the surname', () => {
  assert.deepEqual(nameParts('Maria de la Cruz'), { firstName: 'Maria de la', lastName: 'Cruz' });
});
t('an empty name produces two empty strings and no placeholder', () => {
  assert.deepEqual(nameParts('   '), { firstName: '', lastName: '' });
  assert.deepEqual(nameParts(undefined), { firstName: '', lastName: '' });
});

console.log('\n── the authorize URL refuses to be built without CSRF state ──');

t('authorizeUrl THROWS with no state, rather than quietly omitting it', () => {
  process.env.JOBBER_CLIENT_ID = 'test-client';
  assert.throws(() => authorizeUrl({ redirectUri: 'https://x/y' }), /state/,
    'without state, an attacker binds THEIR Jobber account to a logged-in customer and every job flows to their CRM');
});

t('a complete authorize URL carries client_id, redirect_uri, response_type=code and state', () => {
  process.env.JOBBER_CLIENT_ID = 'test-client';
  const u = new URL(authorizeUrl({ redirectUri: 'https://answered.reddenda.com/cb', state: 'abc.def' }));
  assert.equal(u.origin + u.pathname, JOBBER_AUTHORIZE);
  assert.equal(u.searchParams.get('client_id'), 'test-client');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('state'), 'abc.def');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://answered.reddenda.com/cb');
});

console.log('\n── ★ THE IDEMPOTENCY LAW: an existing link means NO vendor request at all ──');

// `ensure` reaches the database through rpc(), so these run against a stubbed transport. What is
// under test is the ORDER of operations, which is the part that dispatches a second van when wrong.

await ta('an existing link returns the recorded id and the write function is NEVER called', async () => {
  let writes = 0;
  const stubbed = await withRpc(
    { sv_external_link_get: () => ({ ok: true, found: true, external_id: 'JOB-EXISTING' }) },
    () => ensure(
      { localKind: 'job', localId: 'REF1', externalKind: 'Request' },
      async () => { writes++; return { ok: true, id: 'JOB-NEW' }; },
    ),
  );
  assert.equal(writes, 0, 'a vendor write happened despite a recorded link: this is the duplicate-dispatch bug');
  assert.equal(stubbed.id, 'JOB-EXISTING');
  assert.equal(stubbed.reused, true);
  assert.equal(stubbed.created, false);
});

await ta('NEGATIVE CONTROL: with no link, the write DOES run and the link is recorded', async () => {
  let writes = 0;
  let put = null;
  const r = await withRpc(
    {
      sv_external_link_get: () => ({ ok: true, found: false }),
      sv_external_link_put: (args) => { put = args.p_row; return { ok: true, external_id: 'JOB-NEW', raced: false }; },
    },
    () => ensure(
      { localKind: 'job', localId: 'REF2', externalKind: 'Request', idempotencyKey: 'k2', accountId: 'a1', connectionId: 'c1' },
      async () => { writes++; return { ok: true, id: 'JOB-NEW' }; },
    ),
  );
  assert.equal(writes, 1, 'the previous test would pass trivially if the write never ran in either case');
  assert.equal(r.id, 'JOB-NEW');
  assert.equal(r.created, true);
  assert.equal(put.provider, 'jobber');
  assert.equal(put.external_id, 'JOB-NEW');
  assert.equal(put.idempotency_key, 'k2');
});

await ta('losing the race returns the WINNER\'s id, not ours', async () => {
  const r = await withRpc(
    {
      sv_external_link_get: () => ({ ok: true, found: false }),
      // The unique index kept the winner's row; the RPC hands it back.
      sv_external_link_put: () => ({ ok: true, external_id: 'JOB-WINNER', raced: true }),
    },
    () => ensure(
      { localKind: 'job', localId: 'REF3', externalKind: 'Request' },
      async () => ({ ok: true, id: 'JOB-OURS' }),
    ),
  );
  assert.equal(r.id, 'JOB-WINNER', 'two workers must converge on ONE external id');
  assert.equal(r.raced, true);
  assert.equal(r.created, false, 'a raced write must not report itself as the creator');
});

await ta('a failed write records NO link, so the next attempt tries again', async () => {
  let puts = 0;
  const r = await withRpc(
    {
      sv_external_link_get: () => ({ ok: true, found: false }),
      sv_external_link_put: () => { puts++; return { ok: true, external_id: 'x' }; },
    },
    () => ensure(
      { localKind: 'job', localId: 'REF4', externalKind: 'Request' },
      async () => ({ ok: false, reason: 'jobber refused the client: Street is required' }),
    ),
  );
  assert.equal(r.ok, false);
  assert.equal(puts, 0, 'recording a link for a write that failed would permanently suppress the retry');
});

console.log('\n── the schema gate names exactly what the write path uses ──');

t('REQUIRED_SCHEMA lists every mutation the write path calls, and nothing aspirational', () => {
  assert.deepEqual([...REQUIRED_SCHEMA.mutations].sort(), ['clientCreate', 'propertyCreate', 'requestCreate']);
  assert.ok(REQUIRED_SCHEMA.queries.includes('account'),
    'the callback reads the account back to prove the token works; that query must be verified too');
});

console.log('\n── the CSRF state, reimplemented here to prove the scheme, not the code ──');

t('a state minted for one account does not verify for another', () => {
  const KEY = 'test-key';
  const mint = (acct) => {
    const ts = Date.now().toString(36);
    return `${ts}.${crypto.createHmac('sha256', KEY).update(`jobber|${ts}|${acct}`).digest('base64url').slice(0, 32)}`;
  };
  const check = (state, acct) => {
    const [ts, mac] = state.split('.');
    const want = crypto.createHmac('sha256', KEY).update(`jobber|${ts}|${acct}`).digest('base64url').slice(0, 32);
    return mac === want;
  };
  const s = mint('account-A');
  assert.equal(check(s, 'account-A'), true);
  assert.equal(check(s, 'account-B'), false,
    'a state that verified for any account would let an attacker bind their Jobber to a customer');
});

// ── the stub ──────────────────────────────────────────────────────────────────────────────────
//
// `ensure` calls rpc() from lib/db.mjs. Rather than mock the module graph, this points the DB at a
// local server that answers the RPCs by name, so the REAL rpc() runs: its URL building, its headers,
// its JSON handling and its error path are all exercised. A mock of rpc() would test the test.
async function withRpc(handlers, fn) {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    const name = req.url.replace('/rest/v1/rpc/', '');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const args = JSON.parse(body || '{}');
      const h = handlers[name];
      if (!h) { res.writeHead(404).end(JSON.stringify({ message: `no stub for ${name}` })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(h(args)));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const prev = [process.env.ANSWERED_DB_URL, process.env.ANSWERED_DB_ANON, process.env.ANSWERED_DB_SECRET];
  process.env.ANSWERED_DB_URL = `http://127.0.0.1:${port}`;
  process.env.ANSWERED_DB_ANON = 'stub';
  process.env.ANSWERED_DB_SECRET = 'stub';
  try { return await fn(); }
  finally {
    [process.env.ANSWERED_DB_URL, process.env.ANSWERED_DB_ANON, process.env.ANSWERED_DB_SECRET] = prev;
    server.close();
  }
}

console.log(`\n${fail ? 'FAILED' : 'PASSED'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
