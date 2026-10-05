import { ListDomainError } from './errors.mjs';

const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' };
const send = (res, status, body) => { res.writeHead(status, JSON_TYPE); res.end(JSON.stringify(body)); };

async function readJson(req, maxBodyBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) throw new ListDomainError('LIST_BODY_TOO_LARGE', `List request body exceeds ${maxBodyBytes} bytes.`, { status: 413 });
    chunks.push(chunk);
  }
  if (!bytes) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ListDomainError('INVALID_JSON', 'Request body must be valid JSON.'); }
}

const decode = (value) => {
  try { return decodeURIComponent(value); }
  catch { throw new ListDomainError('INVALID_LIST_PATH', 'Malformed list identifier.'); }
};

export function createListHttpHandler({ service, maxBodyBytes = 1_000_000 } = {}) {
  if (!service) throw new TypeError('createListHttpHandler requires service');
  return async function listHttpHandler(req, res, suppliedUrl) {
    const url = suppliedUrl instanceof URL ? suppliedUrl : new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (path !== '/api/lists' && !path.startsWith('/api/lists/')) return false;
    const context = { actor: 'http', reason: `${req.method} ${path}` };
    try {
      if (req.method === 'GET' && path === '/api/lists') { send(res, 200, { lists: await service.listLists() }); return true; }
      if (req.method === 'POST' && path === '/api/lists') { send(res, 200, await service.createList(await readJson(req, maxBodyBytes), context)); return true; }

      const item = /^\/api\/lists\/items\/([^/]+)$/.exec(path);
      if (item) {
        const id = decode(item[1]);
        if (req.method === 'PATCH') { send(res, 200, await service.updateItem(id, await readJson(req, maxBodyBytes), context)); return true; }
        if (req.method === 'DELETE') { send(res, 200, await service.deleteItem(id, context)); return true; }
      }

      const todo = /^\/api\/lists\/([^/]+)\/todos\/([^/]+)$/.exec(path);
      if (todo) {
        const listId = decode(todo[1]);
        const todoId = decode(todo[2]);
        if (req.method === 'POST') { send(res, 200, await service.linkTodo(listId, todoId, context)); return true; }
        if (req.method === 'DELETE') { send(res, 200, await service.unlinkTodo(listId, todoId, context)); return true; }
      }

      const items = /^\/api\/lists\/([^/]+)\/items$/.exec(path);
      if (items && req.method === 'POST') {
        const body = await readJson(req, maxBodyBytes);
        send(res, 200, await service.addItems(decode(items[1]), body.items ?? body.item ?? body, context));
        return true;
      }

      const byId = /^\/api\/lists\/([^/]+)$/.exec(path);
      if (byId) {
        const id = decode(byId[1]);
        if (req.method === 'GET') { send(res, 200, { list: await service.getList(id) }); return true; }
        if (req.method === 'PATCH') { send(res, 200, await service.updateList(id, await readJson(req, maxBodyBytes), context)); return true; }
        if (req.method === 'DELETE') { send(res, 200, await service.deleteList(id, context)); return true; }
      }
      return false;
    } catch (error) {
      if (error instanceof ListDomainError) {
        send(res, error.status, { error: { code: error.code, message: error.message, details: error.details } });
        return true;
      }
      throw error;
    }
  };
}
