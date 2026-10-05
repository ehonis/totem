import { TodoDomainError } from './errors.mjs';
import { compatibilityTodo, normalizeTodoInput, projectList } from './http.mjs';

// Venture tags are configured per install, so the schema takes any string and the
// service checks it against the list totem_get_projects returns.
const S_VENTURE_TAG = Object.freeze({
  type: 'string',
  description: 'One of the venture tags configured on this install (see totem_get_projects). Requires area "Ventures".',
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
  for (const field of ['source', 'github', 'sheet']) {
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

function matchesReadFilters(todo, input) {
  if (input.status && todo.status !== input.status) return false;
  if (input.outcome && todo.outcome !== input.outcome) return false;
  if (input.area && todo.area !== input.area) return false;
  if (input.ventureTag && todo.ventureTag !== input.ventureTag) return false;
  if (input.source === 'local' && todo.externalLinks.length !== 0) return false;
  if (input.source && input.source !== 'local' && !todo.externalLinks.some(link => link.connector === input.source)) return false;
  return true;
}

function mcpTodo(todo) {
  return {
    ...todo,
    ...compatibilityTodo(todo),
    source: todo.externalLinks[0]?.connector ?? 'local',
  };
}

function openTodos(service, input) {
  return service.list({ snoozed: false, sort: 'manual' })
    .filter(todo => todo.status === 'todo' || todo.status === 'doing')
    .filter(todo => matchesReadFilters(todo, input))
    .map(mcpTodo);
}

function completedTodos(service, days, now, input) {
  const cutoff = new Date(new Date(now).getTime() - days * 86_400_000).toISOString();
  return service.list({ status: 'done', includeArchived: true })
    .filter(todo => todo.completedAt && todo.completedAt >= cutoff)
    .filter(todo => matchesReadFilters(todo, { ...input, status: 'done' }))
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt))
    .map(todo => ({ ...mcpTodo(todo), completed: true, completedAt: todo.completedAt }));
}

export function createTodoMcpTools({ service, commands, fetchedAt = () => new Date().toISOString() } = {}) {
  if (!service || !commands) throw new TypeError('createTodoMcpTools requires service and commands');
  return {
    async totem_get_tasks(input = {}) {
      const now = fetchedAt();
      const todos = openTodos(service, input);
      const result = { todos, count: todos.length };
      if (input.includeCompleted) {
        const days = daysValue(input.days);
        const completed = completedTodos(service, days, now, input);
        Object.assign(result, {
          completed,
          completedCount: completed.length,
          completedWindowDays: days,
        });
      }
      return { ...result, fetchedAt: now };
    },
    async totem_get_projects() {
      return { projects: projectList(service.listVentureTags()), fetchedAt: fetchedAt() };
    },
    async totem_create_task(input = {}, session) {
      const todo = await commands.create(
        normalizeAliases(input),
        contextFor(session, 'create task'),
      );
      return { ok: true, todo: mcpTodo(todo), fetchedAt: fetchedAt() };
    },
    async totem_update_task(input = {}, session) {
      if (!input.id) throw new TodoDomainError('MISSING_TODO_ID', 'id is required.');
      const { id } = input;
      const fields = normalizeAliases(input, { update: true });
      const shareTarget = fields.syncTarget ?? 'local';
      const shareOptions = { github: fields.github, sheet: fields.sheet };
      let requestedStatus = Object.hasOwn(input, 'status') ? input.status : null;
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
      delete fields.github;
      delete fields.sheet;
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
      const shared = shareTarget !== 'local';
      if (shared) {
        todo = await commands.share(id, shareTarget, contextFor(session, `share task with ${shareTarget}`), shareOptions);
      }
      const result = {
        ok: true,
        updated: changedFields || shared || (statusChanged && !Object.hasOwn(input, 'complete')),
        todo: mcpTodo(todo),
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
  projectId: { type: 'string' },
  area: { type: 'string', enum: ['Personal', 'Ventures'] },
  ventureTag: S_VENTURE_TAG,
  source: { type: 'string' },
  status: { type: 'string', enum: ['todo', 'doing', 'done'] },
  syncTarget: { type: 'string', enum: ['local', 'github', 'sheet'], default: 'local' },
  github: { type: 'object' },
  sheet: { type: 'object' },
};

export const TODO_MCP_TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'totem_get_tasks',
    title: 'Read tasks',
    description: 'Read Totem tasks. Returns local todo and doing tasks by default and optionally recent completions — including archived ones, since completed work is swept into the archive at the end of each day. Each finished task carries `outcome`: "completed" if it happened, "not_doing" if he decided against it.',
    inputSchema: {
      type: 'object',
      properties: {
        includeCompleted: { type: 'boolean' },
        days: { type: 'number', minimum: 0, description: 'Completed-task look-back window. Default 30.' },
        status: { type: 'string', enum: ['todo', 'doing'] },
        outcome: {
          type: 'string',
          enum: ['completed', 'not_doing'],
          description: 'Filter completions by how they ended. Only meaningful with includeCompleted.',
        },
        area: { type: 'string', enum: ['Personal', 'Ventures'] },
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
    title: 'Read task areas',
    description: 'List Totem task areas and the venture tags configured on this install. New work tasks are intentionally unsupported.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: ANN_READ_LOCAL,
    outputSchema: out({ projects: S_LIST('Personal, Ventures, and each configured venture tag.') }, ['fetchedAt', 'projects']),
  },
  {
    name: 'totem_create_task',
    title: 'Create a task',
    description: 'Create a Totem task. It stays local unless syncTarget is explicitly github or sheet.',
    inputSchema: {
      type: 'object', properties: CREATE_PROPERTIES, anyOf: [{ required: ['content'] }, { required: ['title'] }], additionalProperties: false,
    },
    annotations: ANN_WRITE_OPEN,
    outputSchema: out({ ok: S_BOOL, todo: S_OBJ }, ['fetchedAt', 'ok', 'todo']),
  },
  {
    name: 'totem_update_task',
    title: 'Update or complete a task',
    description: 'Update a Totem task or change its status. Pass complete for work that happened and notDoing for work he has decided against — both land in Done, and `outcome` on the task says which. Externally linked tasks retain their connector completion rules.',
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
