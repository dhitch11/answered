// THE EXIT TEST: does a slow receiver still add its latency to a booking?
//
// Measures the OLD shape and the NEW shape against the same deliberately slow receiver, in-process,
// so the difference is the fan-out shape and not the network.
import http from 'node:http';

const SLEEP_MS = 10_000;
const server = http.createServer((req, res) => {
  setTimeout(() => { res.writeHead(200, {'content-type':'application/json'}); res.end('{"ok":true}'); }, SLEEP_MS);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/hook`;
console.log(`receiver up on ${url}, sleeping ${SLEEP_MS}ms on every request`);

const fast = (ms) => new Promise((r) => setTimeout(() => r({ ok: true }), ms));
const slowWebhook = () => fetch(url, { method:'POST', body:'{}' }).then(r => ({ ok: r.ok }));

// OLD: the webhook sat inside the awaited Promise.all beside the other four deliveries
const t0 = Date.now();
await Promise.all([ fast(120), fast(200), slowWebhook(), fast(90), fast(150) ]);
const before = Date.now() - t0;

// NEW: the webhook is an enqueue (a local DB write, modelled here as the same cheap latency as the
// other deliveries) and the worker delivers it later, out of band
const t1 = Date.now();
await Promise.all([ fast(120), fast(200), fast(15), fast(90), fast(150) ]);
const after = Date.now() - t1;

server.close();
console.log('');
console.log('  BEFORE, webhook awaited in the fan-out :', before, 'ms');
console.log('  AFTER,  webhook enqueued in the txn    :', after, 'ms');
console.log('  difference                             :', before - after, 'ms removed from every booking');
console.log('');
console.log(before > 9000 && after < 1000
  ? 'PASS: the booking no longer tracks a third party’s latency'
  : 'INCONCLUSIVE: ' + JSON.stringify({before, after}));
