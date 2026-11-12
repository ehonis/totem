/**
 * The authenticated `/api/recs*` adapter, mounted in bridge.mjs behind the dashboard's
 * auth check. This is the owner's front door, so it is the one place that passes
 * `via: OWNER_VIA` and with it the right to decide. The BRIDGE_SECRET bearer reaches
 * it too, and an agent that can read .env holds that, so the bearer alone is not the
 * owner here: deciding and grading are approval routes (auth/approval-routes.mjs:
 * a signed-in session or the approval code), and a record is the owner's only when
 * `ownerProof(req)` says so. Otherwise it is an agent's, and the declined hold applies.
 * Every write is logged with how it was authenticated in `detail.auth` (`authMethod`).
 */
import { OWNER_ACTOR } from '../logs/store.mjs';
import { RecDomainError } from './errors.mjs';
import { OWNER_VIA } from './service.mjs';

const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' };
const send = (res, status, body) => { res.writeHead(status, JSON_TYPE); res.end(JSON.stringify(body)); };

async function readJson(req, maxBodyBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) throw new RecDomainError('REC_BODY_TOO_LARGE', `Request body exceeds ${maxBodyBytes} bytes.`, { status: 413 });
    chunks.push(chunk);
  }
  if (!bytes) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RecDomainError('INVALID_JSON', 'Request body must be valid JSON.'); }
}

const decode = (value) => {
  try { return decodeURIComponent(value); }
  catch { throw new RecDomainError('INVALID_REC_PATH', 'Malformed recommendation identifier.'); }
};

function filterFrom(params) {
  const filter = {};
  if (params.has('decision')) filter.decision = params.getAll('decision');
  if (params.has('source')) filter.source = params.get('source');
  if (params.has('similarTo')) filter.similarTo = params.get('similarTo');
  if (params.has('declinedWithinDays')) filter.declinedWithinDays = params.get('declinedWithinDays');
  if (params.has('limit')) filter.limit = params.get('limit');
  return filter;
}

export function createRecHttpHandler({ service, authMethod = () => 'unknown', ownerProof = async () => true, maxBodyBytes = 200_000 } = {}) {
  if (!service) throw new TypeError('createRecHttpHandler requires service');
  return async function recHttpHandler(req, res, suppliedUrl) {
    const url = suppliedUrl instanceof URL ? suppliedUrl : new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (path !== '/api/recs' && !path.startsWith('/api/recs/')) return false;
    const auth = authMethod(req) || 'unknown';
    const context = { actor: OWNER_ACTOR, via: OWNER_VIA, auth, reason: `${req.method} ${path}` };
    try {
      if (path === '/api/recs/ledger' && req.method === 'GET') {
        send(res, 200, await service.ledger({ limit: url.searchParams.get('limit'), before: url.searchParams.get('before') }));
        return true;
      }
      if (path === '/api/recs') {
        if (req.method === 'GET') { send(res, 200, await service.list(filterFrom(url.searchParams))); return true; }
        if (req.method === 'POST') {
          const body = await readJson(req, maxBodyBytes);
          const owner = await ownerProof(req);
          send(res, 200, await service.record(
            { source: owner ? 'owner' : 'api', ...body },
            owner ? context : { actor: 'agent', auth, reason: context.reason },
          ));
          return true;
        }
      }
      const action = /^\/api\/recs\/([^/]+)\/(decision|outcome)$/.exec(path);
      if (action && req.method === 'POST') {
        const id = decode(action[1]);
        const body = await readJson(req, maxBodyBytes);
        send(res, 200, action[2] === 'decision'
          ? await service.decide(id, body, context)
          : await service.setOutcome(id, body, context));
        return true;
      }
      const byId = /^\/api\/recs\/([^/]+)$/.exec(path);
      if (byId && req.method === 'GET') { send(res, 200, { rec: await service.get(decode(byId[1])) }); return true; }
      return false;
    } catch (error) {
      if (error instanceof RecDomainError) {
        send(res, error.status, { error: { code: error.code, message: error.message, details: error.details } });
        return true;
      }
      throw error;
    }
  };
}
