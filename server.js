// Tiny zero-dependency server for Render (or any Node host):
// serves the app from ./public and the Gemini proxy at /api/estimate.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import estimate from './api/estimate.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const PORT = process.env.PORT || 3000;
const MAX_BODY = 6 * 1024 * 1024;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

// Give the handler the res.status().json() helpers it was written against.
function wrap(res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); return res; };
  return res;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveStatic(req, res) {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not a file');
    const ext = extname(file);
    res.writeHead(200, {
      'content-type': TYPES[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
    });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found');
  }
}

http.createServer(async (req, res) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  wrap(res);
  try {
    if (req.url.startsWith('/api/estimate')) {
      if (req.method === 'POST') {
        const raw = await readBody(req);
        try { req.body = JSON.parse(raw || '{}'); } catch { req.body = {}; }
      }
      return await estimate(req, res);
    }
    if (req.url === '/healthz') return res.status(200).json({ ok: true });
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return await serveStatic(req, res);
  } catch (e) {
    if (!res.headersSent) res.status(e.status === 413 ? 413 : 500).json({ error: e.status === 413 ? 'too_large' : 'server_error' });
  }
}).listen(PORT, () => console.log(`Macro Lens on :${PORT}`));
