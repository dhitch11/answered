// research/jobber-writepath.test.mjs — RUN THE CONNECTOR'S WRITE PATH FOR REAL.
//
// Run: node research/jobber-writepath.test.mjs
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
//
// The unit tests prove the pieces. They do not prove that pushJob() executes. Until this file, the
// schema gate, the idempotency read, the userErrors branch and the three-step Client → Property →
// Request chain had all been reasoned about and NONE of them had ever run. That is exactly the
// estate's dominant failure: built, wired, and never fed.
//
// So this stands up a stand-in Jobber that speaks the real protocol — introspection, GraphQL
// envelopes, `errors` on a 200, `userErrors` inside a mutation payload — and drives the SHIPPED
// connector against it through the SHIPPED database layer. Nothing is mocked at the module level:
// `pushJob`, `graphql`, `verifySchema` and `ensure` are the ones that deploy.
//
// ★ WHAT IT REFUSES TO BE: a test that only proves the happy path. Half of these cases are the
// connector being asked to do something wrong, because the whole design claim is that it REFUSES
// rather than writing a guess.

import assert from 'node:assert/strict';
import http from 'node:http';

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

// ── the stand-in Jobber ───────────────────────────────────────────────────────────────────────
// Speaks enough of the real protocol to be a fair test, including the two error channels that a
// naive client reports as success.
function jobberStub(opts = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const q = JSON.parse(body || '{}');
      calls.push({ query: q.query, variables: q.variables, version: req.headers['x-jobber-graphql-version'], auth: req.headers.authorization });
      const send = (o) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(o));

      if (/__schema/.test(q.query)) {
        const mutations = (opts.mutations || ['clientCreate', 'propertyCreate', 'requestCreate']).map((name) => ({ name }));
        const queries = (opts.queries || ['clients', 'account']).map((name) => ({ name }));
        if (opts.emptySchema) return send({ data: { __schema: { queryType: { fields: [] }, mutationType: { fields: [] } } } });
        return send({ data: { __schema: { queryType: { fields: queries }, mutationType: { fields: mutations } } } });
      }
      if (opts.topLevelErrors) return send({ errors: [{ message: "Field 'title' doesn't exist on type 'RequestCreateInput'" }] });
      if (/clientCreate/.test(q.query)) {
        if (opts.clientUserError) return send({ data: { clientCreate: { client: null, userErrors: [{ message: 'Phone number is invalid', path: ['input', 'phones'] }] } } });
        return send({ data: { clientCreate: { client: { id: 'CL-1', name: 'Pat Lee' }, userErrors: [] } } });
      }
      if (/propertyCreate/.test(q.query)) return send({ data: { propertyCreate: { property: { id: 'PR-1' }, userErrors: [] } } });
      if (/requestCreate/.test(q.query)) return send({ data: { requestCreate: { request: { id: 'RQ-1' }, userErrors: [] } } });
      return send({ errors: [{ message: 'the stub did not recognise that operation' }] });
    });
  });
  return { server, calls };
}

// ── the stand-in database ─────────────────────────────────────────────────────────────────────
// The REAL rpc() from lib/db.mjs runs against this, so its URL building, headers, error handling
// and JSON parsing are all exercised rather than replaced.
function dbStub(state) {
  return http.createServer((req, res) => {
    const fn = req.url.replace('/rest/v1/rpc/', '');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const args = JSON.parse(body || '{}');
      let out = { ok: true };
      if (fn === 'sv_integration_get') out = state.connection ? { ok: true, connection: state.connection } : { ok: false, reason: 'no connection' };
      else if (fn === 'sv_integration_upsert') { state.saved = args.p_row; out = { ok: true, connection: {} }; }
      else if (fn === 'sv_integration_error') { state.errored = args; out = { ok: true }; }
      else if (fn === 'sv_external_link_get') {
        const k = `${args.p_local_kind}|${args.p_local_id}|${args.p_external_kind}`;
        out = state.links[k] ? { ok: true, found: true, external_id: state.links[k] } : { ok: true, found: false };
      } else if (fn === 'sv_external_link_put') {
        const r = args.p_row; const k = `${r.local_kind}|${r.local_id}|${r.external_kind}`;
        if (!state.links[k]) state.links[k] = r.external_id;
        out = { ok: true, external_id: state.links[k], raced: state.links[k] !== r.external_id };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
    });
  });
}

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

/** Stand both stubs up, point the SHIPPED module at them, and hand back the real pushJob. */
async function harness(jobberOpts = {}, dbState = {}) {
  const j = jobberStub(jobberOpts);
  const jp = await listen(j.server);
  const state = { links: {}, connection: { id: 'conn-1', status: 'connected', access_token: 'tok', expires_at: new Date(Date.now() + 3600e3).toISOString() }, ...dbState };
  const d = dbStub(state);
  const dp = await listen(d);

  process.env.ANSWERED_JOBBER_API_BASE = `http://127.0.0.1:${jp}`;
  process.env.ANSWERED_DB_URL = `http://127.0.0.1:${dp}`;
  process.env.ANSWERED_DB_ANON = 'stub';
  process.env.ANSWERED_DB_SECRET = 'stub';
  process.env.ANSWERED_JOBBER_API_VERSION = '2025-04-16';

  // Imported AFTER the env is set, because the module reads the base at load time.
  const mod = await import(`../netlify/functions/lib/jobber.mjs?t=${jp}`);
  return { mod, calls: j.calls, state, close: () => { j.server.close(); d.close(); } };
}

const JOB = {
  job_ref: 'AJTEST0001', account_id: 'acct-1', caller_name: 'Pat Lee', address: '9 Elm St',
  callback: '+15551230000', trade: 'plumbing', window_start: '2026-08-18T15:00:00Z',
  window_end: '2026-08-18T17:00:00Z', details: { service: 'water heater leaking', notes: 'gate code 4821' },
};

console.log('\n── the happy path, executed rather than argued ──');

await t('pushJob creates Client, Property and Request and returns all three ids', async () => {
  const h = await harness();
  try {
    const r = await h.mod.pushJob(JOB, 'acct-1');
    assert.equal(r.ok, true, `pushJob failed: ${r.reason}`);
    assert.equal(r.client_id, 'CL-1');
    assert.equal(r.property_id, 'PR-1');
    assert.equal(r.request_id, 'RQ-1');
    const ops = h.calls.map((c) => (c.query.match(/mutation (\w+)/) || [])[1]).filter(Boolean);
    assert.deepEqual(ops, ['AnsweredClientCreate', 'AnsweredPropertyCreate', 'AnsweredRequestCreate'],
      `expected the three writes in order, got ${JSON.stringify(ops)}`);
  } finally { h.close(); }
});

await t('every request carries the pinned version header and the bearer token', async () => {
  const h = await harness();
  try {
    await h.mod.pushJob(JOB, 'acct-1');
    for (const c of h.calls) {
      assert.equal(c.version, '2025-04-16', 'a request went out without the dated version header');
      assert.equal(c.auth, 'Bearer tok');
    }
  } finally { h.close(); }
});

await t('the caller name is split, and the job facts reach the vendor payload', async () => {
  const h = await harness();
  try {
    await h.mod.pushJob(JOB, 'acct-1');
    const client = h.calls.find((c) => /clientCreate/.test(c.query));
    assert.equal(client.variables.input.firstName, 'Pat');
    assert.equal(client.variables.input.lastName, 'Lee');
    assert.equal(client.variables.input.phones[0].number, '+15551230000');
    const prop = h.calls.find((c) => /propertyCreate/.test(c.query));
    assert.equal(prop.variables.input.address.street1, '9 Elm St');
    const req = h.calls.find((c) => /requestCreate/.test(c.query));
    assert.match(req.variables.input.instructions, /water heater leaking/);
    assert.match(req.variables.input.instructions, /gate code 4821/);
    assert.match(req.variables.input.instructions, /AJTEST0001/, 'the job reference must travel so a human can tie it back');
  } finally { h.close(); }
});

console.log('\n── ★ THE IDEMPOTENCY LAW, under a real replay ──');

await t('a second pushJob for the same job makes ZERO vendor requests', async () => {
  const h = await harness();
  try {
    const first = await h.mod.pushJob(JOB, 'acct-1');
    assert.equal(first.ok, true);
    const n = h.calls.length;
    // Exactly three: Client, Property, Request. pushJob does NOT re-introspect — the schema is
    // proven once at connect time and the connection status carries that verdict afterwards, which
    // is why a write costs three round trips rather than four. (My first version of this assertion
    // expected four and was wrong about the connector, not the other way round.)
    assert.equal(n, 3, `expected exactly the 3 writes, saw ${n}`);

    const second = await h.mod.pushJob(JOB, 'acct-1');
    assert.equal(second.ok, true);
    assert.equal(second.reused, true, 'the replay must report itself as a replay');
    assert.equal(second.request_id, 'RQ-1', 'the replay must return the SAME id');
    assert.equal(h.calls.length, n,
      `THE DUPLICATE-DISPATCH BUG: the replay made ${h.calls.length - n} extra vendor request(s)`);
  } finally { h.close(); }
});

console.log('\n── the two error channels, both of which a naive client calls success ──');

await t('a 200 carrying a top-level errors array is a FAILURE, with the message kept', async () => {
  const h = await harness({ topLevelErrors: true });
  try {
    const r = await h.mod.pushJob(JOB, 'acct-1');
    assert.equal(r.ok, false, 'a 200 with errors was reported as success');
    assert.match(r.reason, /doesn't exist on type/);
  } finally { h.close(); }
});

await t('userErrors inside a clean mutation payload is a FAILURE, and nothing downstream runs', async () => {
  const h = await harness({ clientUserError: true });
  try {
    const r = await h.mod.pushJob(JOB, 'acct-1');
    assert.equal(r.ok, false);
    assert.match(r.reason, /Phone number is invalid/);
    assert.ok(!h.calls.some((c) => /propertyCreate/.test(c.query)),
      'the property was created after the client failed, which would orphan it');
  } finally { h.close(); }
});

await t('a failed write records NO link, so a later retry is still free to write', async () => {
  const h = await harness({ clientUserError: true });
  try {
    await h.mod.pushJob(JOB, 'acct-1');
    assert.deepEqual(h.state.links, {}, 'a link was recorded for a write that never succeeded');
  } finally { h.close(); }
});

console.log('\n── ★ THE SCHEMA GATE, which is the whole reason this shipped without credentials ──');

await t('a vendor missing requestCreate is REFUSED, with the field named', async () => {
  const h = await harness({ mutations: ['clientCreate', 'propertyCreate'] });
  try {
    const v = await h.mod.verifySchema('tok');
    assert.equal(v.ok, false);
    assert.deepEqual(v.missing, ['mutation requestCreate']);
  } finally { h.close(); }
});

await t('an EMPTY introspection is a failed probe, NOT "everything is missing"', async () => {
  const h = await harness({ emptySchema: true });
  try {
    const v = await h.mod.verifySchema('tok');
    assert.equal(v.ok, false);
    assert.deepEqual(v.missing, [], 'an unread schema must not be reported as missing fields');
    assert.match(v.reason, /failed probe/i);
  } finally { h.close(); }
});

await t('NEGATIVE CONTROL: a complete schema passes, so the gate is not simply always-fail', async () => {
  const h = await harness();
  try {
    const v = await h.mod.verifySchema('tok');
    assert.equal(v.ok, true, `a healthy schema was rejected: ${JSON.stringify(v)}`);
    assert.deepEqual(v.missing, []);
  } finally { h.close(); }
});

console.log('\n── the connection-state gate ──');

for (const [status, why] of [['pending', 'never verified'], ['revoked', 'disconnected'], ['error', 'broken']]) {
  await t(`a ${status} connection (${why}) writes NOTHING to the vendor`, async () => {
    const h = await harness({}, { connection: { id: 'c', status, access_token: 'tok', expires_at: new Date(Date.now() + 3600e3).toISOString() } });
    try {
      const r = await h.mod.pushJob(JOB, 'acct-1');
      assert.equal(r.ok, false);
      assert.match(r.reason, new RegExp(status));
      assert.equal(h.calls.length, 0, `a ${status} connection reached the vendor ${h.calls.length} time(s)`);
    } finally { h.close(); }
  });
}

console.log(`\n${fail ? 'FAILED' : 'PASSED'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
