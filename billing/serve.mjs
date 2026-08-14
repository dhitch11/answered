// serve.mjs — the billing functions behind a real HTTP server, on this machine.
//
// This exists because the acceptance standard on this estate is "verify through the serving path",
// and a unit test that imports a handler and inspects the object it returns is not that. Here the
// request is a real socket, the headers are real headers, the body is real bytes, the database is
// the real answered-prod, and Stripe is the real live account. The only thing this stands in for
// is Netlify's own router, and that is checked separately by parsing the redirect table in
// netlify.toml and asserting each /api path resolves to the function that exports the handler.
//
//   ./billing/with-env.sh node billing/serve.mjs        (default port 8899)

import http from 'node:http';
import { handler as meterHandler } from '../netlify/functions/bill-meter.mjs';
import { handler as stripeHandler } from '../netlify/functions/bill-stripe.mjs';
import statementFn from '../netlify/functions/bill-statement.mjs';

const PORT = Number(process.env.PORT || 8899);

const read = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const body = await read(req);
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v]));

  try {
    // v2 functions declare their own paths; mirror exactly what config.path says.
    if (url.pathname === '/api/statement' || url.pathname.startsWith('/statement/')) {
      const request = new Request(`http://localhost:${PORT}${req.url}`, {
        method: req.method, headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      });
      const out = await statementFn(request);
      const text = await out.text();
      res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
      res.end(text);
      return;
    }

    // v1 functions, routed the way netlify.toml routes them.
    let fn = null;
    if (url.pathname === '/api/meter') fn = meterHandler;
    else if (url.pathname === '/api/billing' || url.pathname === '/api/billing/webhook') fn = stripeHandler;

    if (!fn) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"no route"}'); return; }

    const out = await fn({
      httpMethod: req.method, path: url.pathname, headers,
      queryStringParameters: Object.fromEntries(url.searchParams),
      body, isBase64Encoded: false,
    });
    res.writeHead(out.statusCode, out.headers || {});
    res.end(out.body || '');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(e.message) }));
  }
});

server.listen(PORT, () => console.log(`billing functions on http://localhost:${PORT}`));
