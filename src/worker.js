// Cloudflare Worker: static files in ./public are served automatically by
// Workers Static Assets; only /api/* reaches this code.
import { estimate } from '../api/estimate.js';

const SECURITY = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' };
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...SECURITY, ...extra } });

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/estimate') {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
      if (Number(request.headers.get('content-length') || 0) > 6e6) return json({ error: 'too_large' }, 413);
      let body = {};
      try { body = await request.json(); } catch {}
      const { status, data } = await estimate(body, env);
      return json(data, status);
    }
    if (pathname === '/healthz') return json({ ok: true });
    return env.ASSETS.fetch(request);
  },
};
