import { assertSyncTarget, TodoDomainError } from './errors.mjs';
import { normalizeStatus } from './service.mjs';
import { compatibilityTodo, normalizeTodoInput, projectList } from './http.mjs';
import { folderList, folderPath, resolveFolder } from './folders.mjs';

// Areas and venture tags were replaced by folders; they are still accepted from
// older callers but organise nothing the owner sees.
const S_VENTURE_TAG = Object.freeze({
  type: 'string',
  description: 'Retired: tasks are organised by folder now. Accepted from older callers only.',
});
const S_FOLDER = Object.freeze({
  type: ['string', 'null'],
  description: 'The folder to file the task under: one of the owner\'s chat projects or folders, by name ("Gizmo Labs"), path ("Work - Northwind / r+d") or id (see totem_get_projects). "Personal" or null leaves it unfiled, which the owner sees as Personal.',
});

const ANN_READ_LOCAL = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});
const ANN_WRITE_OPEN = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
});
const ANN_EDIT_OPEN = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
});
const S_STR = { type: 'string' };
const S_NUM = { type: 'number' };
const S_BOOL = { type: 'boolean' };
const S_OBJ = { type: 'object' };
const S_LIST = description => ({ type: 'array', items: S_OBJ, description });
const out = (properties, required = ['fetchedAt']) => ({
  type: 'object',
  properties: {
    fetchedAt: { type: 'string', description: 'ISO timestamp for this result.' },
    ...properties,
  },
  required,
});

function conflict(message, details) {
  throw new TodoDomainError('ALIAS_CONFLICT', message, { details });
}

function comparable(value) {
  return Array.isArray(value) ? JSON.stringify(value) : String(value);
}

function assertSameAlias(input, first, second, normalize = comparable) {
  if (!Object.hasOwn(input, first) || !Object.hasOwn(input, second)) return;
  if (normalize(input[first]) !== normalize(input[second])) {
    conflict(`${first} and ${second} disagree.`, { fields: [first, second] });
  }
}

function normalizedDueAlias(field, value) {
  return normalizeTodoInput({ [field]: value }, { update: true });
}

function assertDueAliases(input) {
  const fields = ['dueString', 'due', 'dueDate'].filter(field => Object.hasOwn(input, field));
  if (fields.length < 2) return;
  const normalized = fields.map(field => [field, normalizedDueAlias(field, input[field])]);
  const first = JSON.stringify(normalized[0][1]);
  const mismatch = normalized.find(([, value]) => JSON.stringify(value) !== first);
  if (mismatch) conflict(`${normalized[0][0]} and ${mismatch[0]} disagree.`, { fields });
}

function projectClassification(projectId) {
  return normalizeTodoInput({ projectId }, { update: true });
}

function assertClassificationAliases(input) {
  if (!Object.hasOwn(input, 'projectId') || !Object.hasOwn(input, 'area')) return;
  const legacy = projectClassification(input.projectId);
  if (legacy.area !== input.area) {
    conflict('projectId and area disagree.', { fields: ['projectId', 'area'] });
  }
  if (
    legacy.ventureTag != null &&
    Object.hasOwn(input, 'ventureTag') &&
    legacy.ventureTag !== input.ventureTag
  ) {
    conflict('projectId and ventureTag disagree.', { fields: ['projectId', 'ventureTag'] });
  }
}

function normalizeAliases(input = {}, { update = false } = {}) {
  assertSameAlias(input, 'content', 'title', value => String(value).trim());
  assertSameAlias(input, 'labels', 'tags', value => JSON.stringify(value));
  assertDueAliases(input);
  assertClassificationAliases(input);
  const normalized = normalizeTodoInput(input, { update });
  if (!update && Object.hasOwn(input, 'status')) normalized.status = input.status;
  for (const field of ['source']) {
    if (Object.hasOwn(input, field)) normalized[field] = input[field];
  }
  return normalized;
}

function contextFor(session, action) {
  const actor = session?.actor || session?.client || session?.clientInfo?.name || 'mcp';
  return { actor, reason: `MCP ${action}` };
}

function daysValue(value) {
  if (value == null || value === '') return 30;
  const days = Number(value);
  if (!Number.isFinite(days) || days < 0) {
    throw new TodoDomainError('INVALID_COMPLETED_WINDOW', 'days must be a non-negative number.');
  }
  return days;
}

// A task filed under a project that was since deleted is Personal, as every client shows it.
const liveFolder = (todo, projects) => (todo.folderId && projects.some(p => p.id === todo.folderId) ? todo.folderId : null);

function matchesReadFilters(todo, input, projects = []) {
  // `doing` was retired: a filter on it means open (normalizeStatus).
  if (input.status && todo.status !== normalizeStatus(input.status)) return false;
  if (input.outcome && todo.outcome !== input.outcome) return false;
  if (input.area && todo.area !== input.area) return false;
  if (input.ventureTag && todo.ventureTag !== input.ventureTag) return false;
  if (Object.hasOwn(input, 'folderId') && input.folderId !== undefined && liveFolder(todo, projects) !== input.folderId) return false;
  if (input.source === 'local' && todo.externalLinks.length !== 0) return false;
  if (input.source && input.source !== 'local' && !todo.externalLinks.some(link => link.connector === input.source)) return false;
  return true;
}

function mcpTodo(todo, projects = []) {
  // A folder that was deleted reads as unfiled, as it does in every client.
  const folder = folderPath(projects, todo.folderId);
  return {
    ...todo,
    ...compatibilityTodo(todo),
    folderId: folder ? todo.folderId : null,
    folder: folder ?? 'Personal',
    source: todo.externalLinks[0]?.connector ?? 'local',
  };
}

function openTodos(service, input, projects) {
  return service.list({ snoozed: false, sort: 'manual' })
    .filter(todo => todo.status === 'todo')
    .filter(todo => matchesReadFilters(todo, input, projects))
    .map(todo => mcpTodo(todo, projects));
}

function completedTodos(service, days, now, input, projects) {
  const cutoff = new Date(new Date(now).getTime() - days * 86_400_000).toISOString();
  return service.list({ status: 'done', includeArchived: true })
    .filter(todo => todo.completedAt && todo.completedAt >= cutoff)
    .filter(todo => matchesReadFilters(todo, { ...input, status: 'done' }, projects))
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt))
    .map(todo => ({ ...mcpTodo(todo, projects), completed: true, completedAt: todo.completedAt }));
}

/**
 * `folders` (optional) knows the owner's chat projects and the chat a call came
 * from: { list(): projects, chat(session): { threadId, projectId, taskId } | null,
 * linkChat(session, chat, taskId) }. Without it every task reads as Personal and
 * a `folder` name cannot be resolved (an id still can).
 */
export function createTodoMcpTools({ service, commands, folders = null, fetchedAt = () => new Date().toISOString() } = {}) {
  if (!service || !commands) throw new TypeError('createTodoMcpTools requires service and commands');
  async function projects() {
    if (!folders?.list) return [];
    try { return folderList(await folders.list()); } catch { return []; }
  }
  async function chatOf(session) {
    if (!folders?.chat) return null;
    try { return await folders.chat(session); } catch { return null; }
  }
  // `folder` (a name) and `folderId` both become `folderId`; a name that fits no
  // folder, or several, is refused with the names that do exist.
  function applyFolder(input, fields, list) {
    if (!Object.hasOwn(input, 'folder')) return;
    const found = resolveFolder(list, input.folder);
    if (!found || found.ambiguous) {
      const names = list.map(p => folderPath(list, p.id));
      throw new TodoDomainError(
        found?.ambiguous ? 'AMBIGUOUS_FOLDER' : 'FOLDER_NOT_FOUND',
        found?.ambiguous
          ? `"${input.folder}" fits several folders: ${found.ambiguous.join(', ')}. Name one by its path.`
          : `There is no folder called "${input.folder}". Folders: ${names.length ? names.join(', ') : 'none yet'}; "Personal" leaves a task unfiled.`,
        { details: { folder: input.folder } },
      );
    }
    if (Object.hasOwn(fields, 'folderId') && (fields.folderId || null) !== found.id) {
      conflict('folder and folderId disagree.', { fields: ['folder', 'folderId'] });
    }
    fields.folderId = found.id;
  }
  return {
    async totem_get_tasks(input = {}) {
      const now = fetchedAt();
      const list = await projects();
      const filters = { ...input };
      delete filters.folder;
      if (Object.hasOwn(input, 'folder')) applyFolder(input, filters, list);
      const todos = openTodos(service, filters, list);
      const result = { todos, count: todos.length };
      if (input.includeCompleted) {
        const days = daysValue(input.days);
        const completed = completedTodos(service, days, now, filters, list);
        Object.assign(result, {
          completed,
          completedCount: completed.length,
          completedWindowDays: days,
        });
      }
      return { ...result, fetchedAt: now };
    },
    async totem_get_projects() {
      const list = await projects();
      return {
        folders: [
          { id: null, name: 'Personal', path: 'Personal', note: 'Unfiled: a task with no folder.' },
          ...list.map(p => ({ id: p.id, name: p.name, path: folderPath(list, p.id), parentId: p.parentId })),
        ],
        projects: projectList(service.listVentureTags()),
        fetchedAt: fetchedAt(),
      };
    },
    async totem_create_task(input = {}, session) {
      const list = await projects();
      const fields = normalizeAliases(input);
      applyFolder(input, fields, list);
      // A task made from a chat lands in that chat's folder, unless one was named.
      const chat = await chatOf(session);
      const filedFromChat = !Object.hasOwn(fields, 'folderId') && !!chat?.projectId && list.some(p => p.id === chat.projectId);
      if (filedFromChat) fields.folderId = chat.projectId;
      const todo = await commands.create(fields, contextFor(session, 'create task'));
      // ...and the chat names it, when it names no task yet (a chat names at most one).
      let linkedToChat = false;
      if (chat?.threadId && !chat.taskId && folders?.linkChat) {
        try { await folders.linkChat(session, chat, todo.id); linkedToChat = true; } catch { /* the task stands */ }
      }
      return {
        ok: true,
        todo: mcpTodo(todo, list),
        ...(filedFromChat ? { filedFromChat: true } : {}),
        ...(linkedToChat ? { linkedToChat: true } : {}),
        fetchedAt: fetchedAt(),
      };
    },
    async totem_update_task(input = {}, session) {
      if (!input.id) throw new TodoDomainError('MISSING_TODO_ID', 'id is required.');
      const { id } = input;
      const list = await projects();
      const fields = normalizeAliases(input, { update: true });
      applyFolder(input, fields, list);
      // Before any change: a refused share (github, sheet, anything unknown) must not
      // leave the task renamed or completed behind an error.
      assertSyncTarget(fields.syncTarget);
      let requestedStatus = Object.hasOwn(input, 'status') ? normalizeStatus(input.status) : null;
      // "Not doing" is how a task reached done, not a different place it went, so it
      // rides the same status change and only adds the outcome.
      const notDoing = input.notDoing === true;
      if (notDoing) {
        if (requestedStatus && requestedStatus !== 'done') {
          conflict('notDoing and status disagree.', { fields: ['notDoing', 'status'] });
        }
        if (input.complete === false) {
          conflict('notDoing and complete disagree.', { fields: ['notDoing', 'complete'] });
        }
        requestedStatus = 'done';
      }
      if (Object.hasOwn(input, 'complete')) {
        if (input.complete === true && requestedStatus && requestedStatus !== 'done') {
          conflict('complete and status disagree.', { fields: ['complete', 'status'] });
        }
        if (input.complete === false && requestedStatus === 'done') {
          conflict('complete and status disagree.', { fields: ['complete', 'status'] });
        }
        if (input.complete === true) requestedStatus = 'done';
      }
      delete fields.source;
      delete fields.syncTarget;
      const changedFields = Object.keys(fields).length > 0;
      let todo = changedFields
        ? await commands.update(id, fields, contextFor(session, 'update task'))
        : service.get(id);
      if (!todo) throw new TodoDomainError('TODO_NOT_FOUND', `Todo ${id} was not found.`, { status: 404 });
      const statusChanged = requestedStatus != null && requestedStatus !== todo.status;
      if (statusChanged) {
        todo = await commands.move(
          id,
          requestedStatus,
          contextFor(session, notDoing ? 'stop doing task' : 'change task status'),
          notDoing ? { outcome: 'not_doing' } : undefined,
        );
      }
      const result = {
        ok: true,
        updated: changedFields || (statusChanged && !Object.hasOwn(input, 'complete')),
        todo: mcpTodo(todo, list),
        fetchedAt: fetchedAt(),
      };
      if (requestedStatus === 'done') result.completed = true;
      if (notDoing) result.notDoing = true;
      return result;
    },
  };
}

const CREATE_PROPERTIES = {
  content: { type: 'string', description: 'Legacy task title.' },
  title: { type: 'string', description: 'Task title.' },
  description: { type: 'string' },
  dueString: { type: 'string', description: 'Explicit YYYY-MM-DD, recurrence ending in "starting YYYY-MM-DD", or "no date".' },
  due: { type: ['string', 'null'], description: 'YYYY-MM-DD or ISO datetime.' },
  dueDate: { type: ['string', 'null'], description: 'YYYY-MM-DD.' },
  priority: { type: 'number', minimum: 1, maximum: 4 },
  labels: { type: 'array', items: S_STR },
  tags: { type: 'array', items: S_STR },
  folder: S_FOLDER,
  folderId: { type: ['string', 'null'], description: 'A folder id from totem_get_projects; prefer folder.' },
  projectId: { type: 'string', description: 'Retired (area/venture tag). Use folder.' },
  area: { type: 'string', enum: ['Personal', 'Ventures'], description: 'Retired. Use folder.' },
  ventureTag: S_VENTURE_TAG,
  source: { type: 'string' },
  status: {
    type: 'string',
    enum: ['todo', 'doing', 'done'],
    description: 'A task is open (todo) or done. "doing" is accepted from older callers and stored as todo.',
  },
  syncTarget: {
    type: 'string',
    enum: ['local'],
    default: 'local',
    description: 'Tasks stay in Totem. Sharing a task to GitHub or the sheet was removed and is refused.',
  },
};

export const TODO_MCP_TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'totem_get_tasks',
    title: 'Read tasks',
    description: 'Read Totem tasks. Returns open tasks by default and optionally recent completions — including archived ones, since completed work is swept into the archive at the end of each day. Each task carries `folder` (the chat project or folder it is filed under, or "Personal" when unfiled). Each finished task carries `outcome`: "completed" if it happened, "not_doing" if he decided against it.',
    inputSchema: {
      type: 'object',
      properties: {
        includeCompleted: { type: 'boolean' },
        days: { type: 'number', minimum: 0, description: 'Completed-task look-back window. Default 30.' },
        status: { type: 'string', enum: ['todo', 'doing'], description: 'Open tasks are todo; "doing" is accepted as todo.' },
        outcome: {
          type: 'string',
          enum: ['completed', 'not_doing'],
          description: 'Filter completions by how they ended. Only meaningful with includeCompleted.',
        },
        folder: { ...S_FOLDER, description: 'Only tasks filed under this folder (name, path or id); "Personal" for unfiled ones.' },
        area: { type: 'string', enum: ['Personal', 'Ventures'], description: 'Retired. Use folder.' },
        ventureTag: S_VENTURE_TAG,
        source: { type: 'string', enum: ['local', 'github', 'sheet'] },
      },
      additionalProperties: false,
    },
    annotations: ANN_READ_LOCAL,
    outputSchema: out({
      todos: S_LIST('Open local tasks in the legacy Totem task shape.'),
      count: S_NUM,
      completed: S_LIST('Recently completed local tasks.'),
      completedCount: S_NUM,
      completedWindowDays: S_NUM,
    }, ['fetchedAt', 'todos', 'count']),
  },
  {
    name: 'totem_get_projects',
    title: 'Read task folders',
    description: 'List the folders tasks are filed under: the owner\'s chat projects and the folders inside them, by name, path and id. An unfiled task is Personal. `projects` is the retired area list, kept for older callers.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: ANN_READ_LOCAL,
    outputSchema: out({
      folders: S_LIST('Personal (unfiled), then each chat project and folder: id, name, path, parentId.'),
      projects: S_LIST('Retired: Personal, Ventures, and each venture tag.'),
    }, ['fetchedAt', 'folders', 'projects']),
  },
  {
    name: 'totem_create_task',
    title: 'Create a task',
    description: 'Create a Totem task. Pass folder to file it under one of the owner\'s chat projects or folders. Created from a chat in a project, it is filed there when no folder is named, and linked to that chat if the chat has no task yet. Tasks stay local; the shared task sheet is read-only.',
    inputSchema: {
      type: 'object', properties: CREATE_PROPERTIES, anyOf: [{ required: ['content'] }, { required: ['title'] }], additionalProperties: false,
    },
    annotations: ANN_WRITE_OPEN,
    outputSchema: out({ ok: S_BOOL, todo: S_OBJ, filedFromChat: S_BOOL, linkedToChat: S_BOOL }, ['fetchedAt', 'ok', 'todo']),
  },
  {
    name: 'totem_update_task',
    title: 'Update or complete a task',
    description: 'Update a Totem task or change its status. Pass complete for work that happened and notDoing for work he has decided against — both land in Done, and `outcome` on the task says which. A task linked to an Action Items row is completed in the sheet; a GitHub issue link is only a link.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        complete: { type: 'boolean' },
        notDoing: {
          type: 'boolean',
          description: 'Finish the task by deciding against it. It lands in Done marked "not doing" rather than claiming the work happened, and a repeating task ends its series instead of rolling forward. Never infer this: only when the owner says he is not doing something.',
        },
        ...CREATE_PROPERTIES,
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: ANN_EDIT_OPEN,
    outputSchema: out({ ok: S_BOOL, updated: S_BOOL, completed: S_BOOL, notDoing: S_BOOL, todo: S_OBJ }, ['fetchedAt', 'ok', 'updated', 'todo']),
  },
]);

export function todoMcpResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

export function createTodoMcpClient(options) {
  const tools = createTodoMcpTools(options);
  const definitions = TODO_MCP_TOOL_DEFINITIONS.map(definition => ({
    ...definition,
    name: definition.name.replace(/^totem_/, ''),
  }));
  const index = new Map(definitions.map(definition => [definition.name, definition]));
  return {
    async start() {},
    async listTools() { return definitions; },
    async callTool(name, args) {
      if (!index.has(name)) throw new Error(`unknown task tool: ${name}`);
      return todoMcpResult(await tools[`totem_${name}`](args, { actor: 'mcp-gateway' }));
    },
    close() {},
  };
}
