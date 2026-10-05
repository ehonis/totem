import { TodoDomainError } from './errors.mjs';

const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' };
const LEGACY_PRIORITY = Object.freeze({ 4: 'p1', 3: 'p2', 2: 'p3', 1: 'p4' });

function send(res, status, body) {
  res.writeHead(status, JSON_TYPE);
  res.end(JSON.stringify(body));
}

function errorBody(error) {
  return { error: { code: error.code, message: error.message, details: error.details ?? {} } };
}

function bad(code, message, status = 400, details = {}) {
  return new TodoDomainError(code, message, { status, details });
}

function decodePart(value) {
  try { return decodeURIComponent(value); } catch { throw bad('INVALID_TODO_PATH', 'Malformed todo identifier.'); }
}

function dueLabel(value) {
  if (!value) return null;
  const [, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(2000, month - 1, day)));
}

export function compatibilityTodo(todo) {
  const link = todo.externalLinks[0] ?? null;
  return {
    id: todo.id,
    content: todo.title,
    description: todo.description,
    priority: todo.priority,
    priorityLabel: LEGACY_PRIORITY[todo.priority] ?? 'p4',
    due: todo.dueDate,
    dueString: todo.recurrence ?? dueLabel(todo.dueDate),
    isRecurring: Boolean(todo.recurrence),
    labels: todo.tags.map(tag => tag.name),
    projectId: todo.area.toLowerCase(),
    project: todo.area,
    url: link?.externalUrl ?? null,
  };
}

function canonicalDate(value) {
  if (value === null || value === '') return null;
  const string = String(value).trim();
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(string);
  if (!match) throw bad('INVALID_DATE', 'due must start with a YYYY-MM-DD date.', 400, { field: 'due' });
  return match[1];
}

function recurrenceFromDueString(value) {
  const string = String(value ?? '').trim();
  if (!string) return {};
  if (/^no date$/i.test(string)) return { dueDate: null, recurrence: null };
  const starting = /\s+starting\s+(\d{4}-\d{2}-\d{2})$/i.exec(string);
  if (starting) return { dueDate: starting[1], recurrence: string.slice(0, starting.index).trim() };
  if (/^\d{4}-\d{2}-\d{2}/.test(string)) return { dueDate: canonicalDate(string) };
  throw bad('UNSUPPORTED_DUE_STRING', 'Natural-language due dates require an explicit YYYY-MM-DD date.');
}

function classification(projectId, area, ventureTag) {
  if (area !== undefined || ventureTag !== undefined) return { area, ventureTag };
  if (projectId === undefined || projectId === null || projectId === '' || String(projectId).toLowerCase() === 'personal') {
    return projectId === undefined ? {} : { area: 'Personal', ventureTag: null };
  }
  const value = String(projectId).trim();
  if (value.toLowerCase() === 'ventures') return { area: 'Ventures', ventureTag };
  // Anything else names a venture tag. The configured list lives in the service,
  // which checks it (and fixes the case) on create and update.
  return { area: 'Ventures', ventureTag: value };
}

/** Personal, Ventures, and one entry per configured venture tag. */
export function projectList(ventureTags = []) {
  return [
    { id: 'personal', name: 'Personal' },
    { id: 'ventures', name: 'Ventures' },
    ...ventureTags.map(tag => ({ id: tag.name, name: tag.name, area: 'Ventures', color: tag.color ?? null })),
  ];
}

export function normalizeTodoInput(input = {}, { update = false } = {}) {
  if (!input || Array.isArray(input) || typeof input !== 'object') throw bad('INVALID_TODO_INPUT', 'Todo input must be an object.');
  const result = {};
  if (Object.hasOwn(input, 'content') || Object.hasOwn(input, 'title')) result.title = input.title ?? input.content;
  if (Object.hasOwn(input, 'description')) result.description = input.description;
  if (Object.hasOwn(input, 'priority')) result.priority = Number(input.priority);
  if (Object.hasOwn(input, 'labels') || Object.hasOwn(input, 'tags')) result.tags = input.tags ?? input.labels;
  Object.assign(result, classification(input.projectId, input.area, input.ventureTag));
  if (Object.hasOwn(input, 'dueDate')) result.dueDate = canonicalDate(input.dueDate);
  else if (Object.hasOwn(input, 'dueString')) Object.assign(result, recurrenceFromDueString(input.dueString));
  else if (Object.hasOwn(input, 'due')) result.dueDate = canonicalDate(input.due);
  if (Object.hasOwn(input, 'recurrence')) result.recurrence = input.recurrence;
  if (Object.hasOwn(input, 'snoozedUntil')) result.snoozedUntil = input.snoozedUntil;
  if (Object.hasOwn(input, 'position')) result.position = input.position;
  if (Object.hasOwn(input, 'syncTarget')) result.syncTarget = input.syncTarget;
  // Connector-only creation option. The local service ignores unknown fields,
  // while the GitHub adapter validates this as owner/repository.
  if (Object.hasOwn(input, 'repo')) result.repo = input.repo;
  if (!update && !Object.hasOwn(result, 'title')) throw bad('INVALID_TODO_FIELD', 'content or title is required.');
  return result;
}

async function readJson(req, maxBodyBytes) {
  const advertised = Number(req.headers['content-length']);
  if (Number.isFinite(advertised) && advertised > maxBodyBytes) {
    throw bad('TODO_BODY_TOO_LARGE', `Todo request body exceeds ${maxBodyBytes} bytes.`, 413);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) throw bad('TODO_BODY_TOO_LARGE', `Todo request body exceeds ${maxBodyBytes} bytes.`, 413);
    chunks.push(chunk);
  }
  if (!bytes) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw bad('INVALID_JSON', 'Request body must be valid JSON.'); }
}

function queryFrom(url) {
  const params = url.searchParams;
  const result = {};
  for (const key of ['search', 'area', 'ventureTag', 'source', 'status', 'sort', 'due']) {
    if (params.has(key)) result[key] = params.get(key);
  }
  if (params.has('priority')) result.priority = Number(params.get('priority'));
  if (params.has('snoozed')) result.snoozed = params.get('snoozed') === 'true';
  if (params.has('archived')) result.archived = params.get('archived') === 'true';
  if (params.has('deleted')) result.deleted = params.get('deleted') === 'true';
  return result;
}

export function createTodoHttpHandler({ service, commands, now = () => new Date().toISOString(), maxBodyBytes = 1_000_000 } = {}) {
  if (!service || !commands) throw new TypeError('createTodoHttpHandler requires service and commands');
  return async function todoHttpHandler(req, res, suppliedUrl) {
    const url = suppliedUrl instanceof URL ? suppliedUrl : new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (path !== '/api/todos' && !path.startsWith('/api/todos/')) return false;
    if (path === '/api/todos/prompt') return false;
    const context = { actor: 'http', reason: `${req.method} ${path}` };
    try {
      if (req.method === 'GET' && path === '/api/todos') {
        const todos = service.list({ snoozed: false, sort: 'manual' })
          .filter(todo => todo.status !== 'done')
          .sort((a, b) => a.position - b.position || String(a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.createdAt.localeCompare(b.createdAt));
        send(res, 200, { todos: todos.map(compatibilityTodo) });
        return true;
      }
      if (req.method === 'GET' && path === '/api/todos/projects') {
        send(res, 200, { projects: projectList(commands.listVentureTags()) });
        return true;
      }
      if (req.method === 'GET' && path === '/api/todos/completed') {
        const days = Number(url.searchParams.get('days')) || 30;
        const cutoff = new Date(new Date(now()).getTime() - days * 86_400_000).toISOString();
        const todos = service.list({ status: 'done', includeArchived: true })
          .filter(todo => todo.completedAt && todo.completedAt >= cutoff)
          .sort((a, b) => b.completedAt.localeCompare(a.completedAt))
          .map(todo => ({ ...compatibilityTodo(todo), completed: true, completedAt: todo.completedAt }));
        send(res, 200, { todos });
        return true;
      }
      if (req.method === 'GET' && path === '/api/todos/board') {
        send(res, 200, { todos: service.list(queryFrom(url)) });
        return true;
      }
      if (req.method === 'GET' && path === '/api/todos/venture-tags') {
        send(res, 200, { ventureTags: commands.listVentureTags() });
        return true;
      }
      if (req.method === 'PUT' && path === '/api/todos/venture-tags') {
        const body = await readJson(req, maxBodyBytes);
        send(res, 200, { ventureTags: commands.saveVentureTags(body?.ventureTags, context) });
        return true;
      }
      if (req.method === 'GET' && path === '/api/todos/preferences') {
        send(res, 200, { preferences: commands.getPreferences() });
        return true;
      }
      if (req.method === 'GET' && path === '/api/todos/connectors/sheet') {
        send(res, 200, commands.sheetHealth());
        return true;
      }
      if (req.method === 'GET' && path === '/api/todos/connectors/github') {
        send(res, 200, commands.githubHealth());
        return true;
      }
      if (req.method === 'GET' && path === '/api/todos/connectors/github/search') {
        send(res, 200, await commands.githubSearch({
          query: url.searchParams.get('q') ?? '',
          ...(url.searchParams.has('repo') ? { selectedRepo: url.searchParams.get('repo') } : {}),
          ...(url.searchParams.get('assigned') === 'true' ? { assigned: true } : {}),
        }));
        return true;
      }

      if (req.method === 'POST' && path === '/api/todos/close') {
        const { id } = await readJson(req, maxBodyBytes);
        if (!id) throw bad('MISSING_TODO_ID', 'missing id');
        await commands.close(id, context);
        send(res, 200, { ok: true });
        return true;
      }
      if (req.method === 'POST' && path === '/api/todos') {
        const todo = await commands.create(normalizeTodoInput(await readJson(req, maxBodyBytes)), context);
        send(res, 200, { ok: true, todo: compatibilityTodo(todo) });
        return true;
      }
      if (req.method === 'PATCH' && path === '/api/todos') {
        const { id, ...input } = await readJson(req, maxBodyBytes);
        if (!id) throw bad('MISSING_TODO_ID', 'missing id');
        const todo = await commands.update(id, normalizeTodoInput(input, { update: true }), context);
        send(res, 200, { ok: true, todo: compatibilityTodo(todo) });
        return true;
      }
      if (req.method === 'DELETE' && path === '/api/todos') {
        const { id } = await readJson(req, maxBodyBytes);
        if (!id) throw bad('MISSING_TODO_ID', 'missing id');
        await commands.softDelete(id, context);
        send(res, 200, { ok: true });
        return true;
      }
      if (req.method === 'POST' && path === '/api/todos/bulk') {
        send(res, 200, { todos: await commands.bulk({ ...(await readJson(req, maxBodyBytes)), context }) });
        return true;
      }
      if (req.method === 'POST' && path === '/api/todos/reorder') {
        send(res, 200, { todos: await commands.reorder({ ...(await readJson(req, maxBodyBytes)), context }) });
        return true;
      }
      if (req.method === 'PATCH' && path === '/api/todos/preferences') {
        send(res, 200, { preferences: await commands.updatePreferences(await readJson(req, maxBodyBytes), context) });
        return true;
      }
      if (req.method === 'POST' && path === '/api/todos/purge') {
        send(res, 200, await commands.purge({ ...(await readJson(req, maxBodyBytes)), context }));
        return true;
      }
      if (req.method === 'POST' && path === '/api/todos/connectors/sheet/refresh') {
        send(res, 200, { result: await commands.sheetRefresh() });
        return true;
      }
      if (req.method === 'POST' && path === '/api/todos/connectors/sheet/bootstrap') {
        send(res, 200, { result: await commands.sheetBootstrap(await readJson(req, maxBodyBytes)) });
        return true;
      }
      if (req.method === 'POST' && path === '/api/todos/connectors/github/link') {
        send(res, 200, { todo: await commands.githubLink(await readJson(req, maxBodyBytes), context) });
        return true;
      }
      if (req.method === 'POST' && path === '/api/todos/connectors/github/refresh') {
        send(res, 200, { result: await commands.githubRefresh() });
        return true;
      }
      if (req.method === 'PATCH' && path === '/api/todos/connectors/github/settings') {
        send(res, 200, { settings: await commands.githubSettings(await readJson(req, maxBodyBytes)) });
        return true;
      }

      const publishDescription = /^\/api\/todos\/([^/]+)\/publish-description$/.exec(path);
      if (req.method === 'POST' && publishDescription) {
        send(res, 200, { todo: await commands.githubPublishFirstNote(decodePart(publishDescription[1])) });
        return true;
      }

      const item = /^\/api\/todos\/([^/]+)$/.exec(path);
      if (item) {
        const id = decodePart(item[1]);
        if (req.method === 'GET') {
          const todo = service.get(id);
          if (!todo) throw bad('TODO_NOT_FOUND', `Todo ${id} was not found.`, 404, { id });
          send(res, 200, { todo });
          return true;
        }
        if (req.method === 'PATCH') {
          const todo = await commands.update(id, normalizeTodoInput(await readJson(req, maxBodyBytes), { update: true }), context);
          send(res, 200, { todo });
          return true;
        }
        if (req.method === 'DELETE') {
          const todo = await commands.softDelete(id, context);
          send(res, 200, { todo });
          return true;
        }
      }

      const match = /^\/api\/todos\/([^/]+)\/(move|archive|unarchive|delete|restore|notes|relations|unlink-relation|external-links|share|refresh)$/.exec(path);
      if (match) {
        const id = decodePart(match[1]);
        const action = match[2];
        const input = action === 'refresh' ? {} : await readJson(req, maxBodyBytes);
        let result;
        // `outcome` rides on the move rather than getting its own verb: "not doing"
        // is how a task reached Done, not a separate place it went.
        if (action === 'move') result = await commands.move(id, input.status, context, { outcome: input.outcome });
        else if (action === 'archive') result = await commands.archive(id, context);
        else if (action === 'unarchive') result = await commands.unarchive(id, context);
        else if (action === 'delete') result = await commands.softDelete(id, context);
        else if (action === 'restore') result = await commands.restore(id, context);
        else if (action === 'notes') result = await commands.addNote(id, input.body, context);
        else if (action === 'relations') result = await commands.linkRelated(id, input.relatedId, context);
        else if (action === 'unlink-relation') result = await commands.unlinkRelated(id, input.relatedId, context);
        else if (action === 'external-links') result = await commands.attachExternalLink(id, input, context);
        else if (action === 'share') result = await commands.share(id, input.target, context, input);
        else result = await commands.refresh(id);
        send(res, 200, action === 'notes' ? { note: result } : { todo: result });
        return true;
      }
      const unlink = /^\/api\/todos\/([^/]+)\/external-links\/([^/]+)$/.exec(path);
      if (unlink && req.method === 'DELETE') {
        const result = await commands.detachExternalLink(decodePart(unlink[1]), decodePart(unlink[2]), context);
        send(res, 200, { todo: result });
        return true;
      }
      return false;
    } catch (error) {
      if (error instanceof TodoDomainError) {
        send(res, error.status, errorBody(error));
        return true;
      }
      throw error;
    }
  };
}
