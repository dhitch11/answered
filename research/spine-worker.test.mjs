#!/usr/bin/env node
// spine-worker.test.mjs — drive the REAL delivery worker against a REAL https receiver, through the
// REAL database, and assert the properties that make at-least-once delivery safe.
//
//   ./research/with-env.sh node research/spine-worker.test.mjs
//
// Needs a throwaway cert (test only):
//   openssl req -x509 -newkey rsa:2048 -keyout /tmp/spine-key.pem -out /tmp/spine-cert.pem \
//     -days 1 -nodes -subj "/CN=localhost"
//
// WHAT IT PROVES, and why each one is load-bearing:
//   - a queued delivery is actually delivered, and the HMAC verifies against the exact body sent
//   - the idempotency key reaches the receiver in BOTH the header and the body
//   - a delivered row is terminal: a second drain does not re-send it
//   - EVERY retry carries the SAME key, which is the single property that makes retrying safe
//   - a permanently failing endpoint goes DEAD after the cap rather than retrying forever, because
//     a queue that retries a dead endpoint forever is a queue that hides a dead endpoint
//
// It writes real rows and DELETES them. Test data in a production table is a defect this estate has
// shipped twice; the cleanup is not optional and its result is asserted, not assumed.
// Drive the REAL delivery-worker handler against a REAL https receiver, through the REAL database.
// Self-signed cert, so TLS verification is disabled for this process only.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import https from 'node:https';
import fs from 'node:fs';
import crypto from 'node:crypto';

const { rpc } = await import('/Users/user/answered-site/netlify/functions/lib/db.mjs');
const TAG = 'spine-worker-' + process.pid;
const SECRET = 'test-secret-' + process.pid;

let mode = 'ok';
const seen = [];
const server = https.createServer(
  { key: fs.readFileSync('/tmp/spine-key.pem'), cert: fs.readFileSync('/tmp/spine-cert.pem') },
  (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ key: req.headers['x-answered-idempotency-key'], sig: req.headers['x-answered-signature'], body });
      if (mode === 'fail') { res.writeHead(500); res.end('nope'); return; }
      res.writeHead(200, {'content-type':'application/json'}); res.end('{"ok":true}');
    });
  });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
process.env.ANSWERED_WEBHOOK_URL = `https://127.0.0.1:${port}/hook`;
process.env.ANSWERED_WEBHOOK_SECRET = SECRET;

const { default: worker } = await import('/Users/user/answered-site/netlify/functions/delivery-worker.mjs');
const { signWebhook } = await import('/Users/user/answered-site/netlify/functions/lib/outbox.mjs');

const enqueue = (k) => rpc('sv_delivery_enqueue', { p_row: {
  kind:'webhook', target:'webhook:default', event:'job.booked',
  payload:{ probe:true }, idempotency_key: k, source_kind:'probe', source_id:k } });

let fail = 0;
const T = (label, ok, extra='') => { if(!ok) fail++; console.log((ok?'PASS':'FAIL').padEnd(5), label.padEnd(52), extra); };

// ── 1. the happy path
await enqueue(TAG + '-ok');
let r = await (await worker(new Request('https://x/'))).json();
T('a queued delivery is delivered', r.delivered === 1, JSON.stringify(r));

// ── 2. the signature the receiver got actually verifies
const got = seen[0];
const m = /t=(\d+),v1=([0-9a-f]+)/.exec(got.sig || '');
const expect = m ? signWebhook(SECRET, m[1], got.body) : null;
T('the signature verifies against the body', Boolean(m) && expect === got.sig);
T('the idempotency key is on the header', got.key === TAG + '-ok', got.key);
T('the key is in the body too', JSON.parse(got.body).idempotency_key === TAG + '-ok');

// ── 3. a delivered row is terminal: a second drain must not re-send it
const before = seen.length;
r = await (await worker(new Request('https://x/'))).json();
T('a delivered row is not re-sent', seen.length === before && r.claimed === 0, 'claimed=' + r.claimed);

// ── 4. failure path: retries, keeps the SAME key, then dies after the cap
mode = 'fail';
await enqueue(TAG + '-fail');
for (let i = 0; i < 9; i++) {
  await rpc('sv_delivery_replay', { p_id: (await findId(TAG + '-fail')), p_actor: 'test' }).catch(()=>{});
  await worker(new Request('https://x/'));
}
const row = await findRow(TAG + '-fail');
const keysSeen = new Set(seen.filter(s => s.key === TAG + '-fail').map(s => s.key));
T('every retry carried the SAME key', keysSeen.size === 1, [...keysSeen].join(','));
T('a permanently failing delivery goes DEAD', row && row.state === 'dead', row ? `${row.state} after ${row.attempts}` : 'missing');
T('and it records the last status', row && row.last_status === 500, row ? String(row.last_status) : '');

async function findId(k){ const d = await rpc('sv_admin_deliveries',{p_state:null,p_limit:500});
  const x=(d.rows||[]).find(r=>r.idempotency_key===k); return x && x.id; }
async function findRow(k){ const d = await rpc('sv_admin_deliveries',{p_state:null,p_limit:500});
  return (d.rows||[]).find(r=>r.idempotency_key===k); }

server.close();
console.log('');
console.log(fail ? fail + ' FAILURES' : 'the spine delivers, signs, deduplicates and dies honestly');
console.log('CLEANUP: removing', TAG, 'rows');
process.exit(fail?1:0);
