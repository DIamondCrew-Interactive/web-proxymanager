// Local test server: static frontend only, no production API connection.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
const root = resolve('.build/frontend/dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.jpg': 'image/jpeg' };
createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  if (pathname.startsWith('/api/')) { res.writeHead(503); res.end('{}'); return; }
  const file = resolve(root, `.${decodeURIComponent(pathname)}`);
  if (!file.startsWith(root + '/') && !file.startsWith(root + '\\') && file !== root) { res.writeHead(403); res.end(); return; }
  const asset = extname(file) && existsSync(file) ? file : resolve(root, 'index.html');
  try { res.writeHead(200, { 'Content-Type': types[extname(asset)] || 'application/octet-stream' }); res.end(readFileSync(asset)); }
  catch { res.writeHead(404); res.end(); }
}).listen(4173, '127.0.0.1', () => console.log('Local frontend: http://127.0.0.1:4173'));
