/**
 * /api/away — the owner's own edits from the dashboard and the app. Behind the bridge's
 * auth gate like every /api route; agents use the propose-only MCP tools instead.
 */

import { todayKey } from '../goals/periods.mjs';
import { AwayError } from './store.mjs';

const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' };
const send = (res, status, body) => { res.writeHead(status, JSON_TYPE); res.end(JSON.stringify(body)); };

async function readJson(req, maxBodyBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) throw new AwayError('AWAY_BODY_TOO_LARGE', `Request body exceeds ${maxBodyBytes} bytes.`, { status: 413 });
    chunks.push(chunk);
  }
  if (!bytes) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AwayError('INVALID_JSON', 'Request body must be valid JSON.'); }
}

export function createAwayHttpHandler({ store, tz, now = () => new Date(), maxBodyBytes = 64_000 } = {}) {
  if (!store) throw new TypeError('createAwayHttpHandler requires store');
  return async function awayHttpHandler(req, res, suppliedUrl) {
    const url = suppliedUrl instanceof URL ? suppliedUrl : new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (path !== '/api/away' && !path.startsWith('/api/away/')) return false;
    const context = { actor: 'owner', source: 'owner', reason: `${req.method} ${path}` };
    try {
      if (path === '/api/away') {
        if (req.method === 'GET') {
          const today = todayKey(now(), tz);
          // The calendar asks for a window it is showing, which may be in the past.
          const from = url.searchParams.get('from') || (url.searchParams.get('all') === '1' ? null : today);
          send(res, 200, { today, spans: store.list({ from }) });
          return true;
        }
        if (req.method === 'POST') { send(res, 200, { span: store.create(await readJson(req, maxBodyBytes), context) }); return true; }
      }
      const byId = /^\/api\/away\/([^/]+)$/.exec(path);
      if (byId) {
        let id;
        try { id = decodeURIComponent(byId[1]); } catch { throw new AwayError('INVALID_AWAY_PATH', 'Malformed away span id.'); }
        if (req.method === 'GET') { send(res, 200, { span: store.get(id) }); return true; }
        if (req.method === 'PATCH') { send(res, 200, { span: store.update(id, await readJson(req, maxBodyBytes), context) }); return true; }
        if (req.method === 'DELETE') { send(res, 200, store.remove(id, context)); return true; }
      }
      send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: `${req.method} ${path} is not supported.` } });
      return true;
    } catch (error) {
      if (error instanceof AwayError) {
        send(res, error.status, { error: { code: error.code, message: error.message, details: error.details } });
        return true;
      }
      throw error;
    }
  };
}
