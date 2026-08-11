// A static server for the verification loop.
// python -m http.server was dropping connections partway through a 35-request
// sweep, and a dropped connection reads exactly like a broken page, which cost
// two false failures. This one keeps alive and never blocks.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT || 8908);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png', '.ico': 'image/x-icon' };

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('no'); return; }
    const s = await stat(file).catch(() => null);
    if (!s || !s.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Content-Length': body.length, 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
    res.end(body);
  } catch (e) { res.writeHead(500).end('error'); }
}).listen(PORT, '127.0.0.1', () => console.log('serving ' + ROOT + ' on ' + PORT));
