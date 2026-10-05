import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { Gateway } from '../mcp-gateway.mjs';
import { createTodoCommands } from './commands.mjs';
import { closeTodoDatabase, openTodoDatabase } from './db.mjs';
import {
  TODO_MCP_TOOL_DEFINITIONS,
  createTodoMcpClient,
  createTodoMcpTools,
} from './mcp.mjs';
import { createTodoService } from './service.mjs';
import { seedVentureTags } from './test-support.mjs';

const NOW = '2026-09-11T12:00:00.000Z';
const cleanups = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'totem-todo-mcp-'));
  const db = openTodoDatabase({ file: join(directory, 'todos.db'), now: () => NOW });
  seedVentureTags(db);
  let sequence = 0;
  const audit = [];
  const service = createTodoService({
    db,
    now: () => NOW,
    makeId: () => `mcp-${++sequence}`,
    actionLog: { record(entry) { audit.push(entry); } },
  });
  const calls = { github: [], sheet: [] };
  const connector = name => ({
    async create(input, context) {
      calls[name].push({ method: 'create', input, context });
      return service.create(input, context);
    },
    async rename(id, title, context) { return service.update(id, { title }, context); },
    async updateLinked(id, patch, context) { return service.update(id, patch, context); },
    async appendNote(id, body, context) { return service.addNote(id, body, context); },
    async bulk(input) { return service.bulk(input); },
    async refreshTask(id) { return service.get(id); },
    async share(id, context, options) {
      calls[name].push({ method: 'share', id, context, options });
      return service.get(id);
    },
  });
  const commands = createTodoCommands({
    service,
    github: connector('github'),
    sheet: connector('sheet'),
    maintenance: { async purgeDeleted() { return { purged: 0 }; } },
  });
  const tools = createTodoMcpTools({ service, commands, fetchedAt: () => NOW });
  cleanups.push(() => {
    closeTodoDatabase(db);
    rmSync(directory, { recursive: true, force: true });
  });
  return { service, commands, tools, calls, audit };
}

test('MCP create stays private unless syncTarget is explicit', async () => {
  const { tools, calls } = fixture();
  await tools.totem_create_task({ content: 'Initech pricing', area: 'Ventures', ventureTag: 'Initech' });
  assert.equal(calls.sheet.length, 0);
  await tools.totem_create_task({
    content: 'Initech launch', area: 'Ventures', ventureTag: 'Initech', syncTarget: 'sheet',
  });
  assert.equal(calls.sheet.length, 1);
});

test('projects are Personal, Ventures, and each configured venture tag', async () => {
  const { tools } = fixture();
  const result = await tools.totem_get_projects({});
  assert.deepEqual(result.projects.map(project => project.name), ['Personal', 'Ventures', 'Acme', 'Globex', 'Initech']);
});

test('MCP legacy reads and writes preserve keys, tags, and complete-only task results', async () => {
  const { service, tools } = fixture();
  const doing = service.create({ title: 'Already moving', status: 'doing', area: 'Personal', tags: ['focus'] });
  const created = await tools.totem_create_task({
    content: 'Legacy create', due: '2026-09-12T16:30:00-04:00', labels: ['home'], projectId: 'personal',
  });
  assert.deepEqual(Object.keys(created).sort(), ['fetchedAt', 'ok', 'todo']);
  assert.equal(created.todo.content, 'Legacy create');
  assert.equal(created.todo.title, 'Legacy create');
  assert.equal(created.todo.due, '2026-09-12');
  assert.equal(created.todo.dueDate, '2026-09-12');
  assert.deepEqual(created.todo.labels, ['home']);
  assert.deepEqual(created.todo.tags.map(tag => tag.name), ['home']);
  assert.equal(created.todo.status, 'todo');
  assert.equal(created.todo.source, 'local');

  const read = await tools.totem_get_tasks({ includeCompleted: true, days: 14 });
  assert.deepEqual(Object.keys(read).sort(), [
    'completed', 'completedCount', 'completedWindowDays', 'count', 'fetchedAt', 'todos',
  ]);
  assert.deepEqual(new Set(read.todos.map(todo => todo.id)), new Set([doing.id, created.todo.id]));
  assert.deepEqual(read.todos.find(todo => todo.id === doing.id).labels, ['focus']);

  const completed = await tools.totem_update_task({ id: created.todo.id, complete: true });
  assert.deepEqual(Object.keys(completed).sort(), ['completed', 'fetchedAt', 'ok', 'todo', 'updated']);
  assert.equal(completed.completed, true);
  assert.equal(completed.updated, false);
  assert.equal(completed.todo.id, created.todo.id);
  assert.equal(service.get(created.todo.id).status, 'done');
});

test('MCP supports canonical aliases, field updates, combined completion, and archived completion reads', async () => {
  const { commands, service, tools } = fixture();
  const created = await tools.totem_create_task({
    title: 'Canonical', dueDate: '2026-09-13', tags: ['Initech', 'Launch'],
    area: 'Ventures', ventureTag: 'Initech', priority: 4,
  });
  assert.deepEqual(created.todo.labels, ['Initech', 'Launch']);
  assert.deepEqual(created.todo.tags.map(tag => tag.name), ['Initech', 'Launch']);
  assert.equal(created.todo.area, 'Ventures');
  assert.equal(created.todo.ventureTag, 'Initech');
  const updated = await tools.totem_update_task({
    id: created.todo.id, title: 'Canonical renamed', tags: ['Launch'], status: 'done',
  });
  assert.equal(updated.updated, true);
  assert.equal(updated.completed, true);
  assert.equal(updated.todo.content, 'Canonical renamed');
  assert.deepEqual(updated.todo.labels, ['Launch']);
  await commands.archive(created.todo.id, { actor: 'test' });

  const read = await tools.totem_get_tasks({ includeCompleted: true, days: 14 });
  assert.equal(read.completedCount, 1);
  assert.equal(read.completed[0].id, created.todo.id);
  assert.equal(read.completed[0].completedAt, NOW);
  assert.equal(service.get(created.todo.id).archivedAt, NOW);
});

test('canonical read filters and create status are honored', async () => {
  const { service, tools } = fixture();
  await tools.totem_create_task({ title: 'Personal todo', status: 'todo' });
  await tools.totem_create_task({ title: 'Initech doing', status: 'doing', area: 'Ventures', ventureTag: 'Initech' });
  service.create({ title: 'Acme doing', status: 'doing', area: 'Ventures', ventureTag: 'Acme' });
  const result = await tools.totem_get_tasks({ status: 'doing', area: 'Ventures', ventureTag: 'Initech', source: 'local' });
  assert.deepEqual(result.todos.map(todo => todo.content), ['Initech doing']);
});

test('alias conflicts and invalid sync targets fail before mutations', async () => {
  const { service, tools } = fixture();
  await assert.rejects(
    tools.totem_create_task({ content: 'one', title: 'two' }),
    error => error.code === 'ALIAS_CONFLICT',
  );
  await assert.rejects(
    tools.totem_create_task({ title: 'bad target', syncTarget: 'todoist' }),
    error => error.code === 'INVALID_SYNC_TARGET',
  );
  const todo = service.create({ title: 'Status conflict', area: 'Personal' });
  await assert.rejects(
    tools.totem_update_task({ id: todo.id, complete: true, status: 'doing' }),
    error => error.code === 'ALIAS_CONFLICT',
  );
  assert.equal(service.list({ includeArchived: true }).length, 1);
});

test('dueString-only create, due clearing, and same-value aliases are accepted', async () => {
  const { service, tools } = fixture();
  const created = await tools.totem_create_task({
    content: 'Dated', title: 'Dated', dueString: '2026-09-14', labels: ['x'], tags: ['x'],
  });
  assert.equal(created.todo.due, '2026-09-14');
  await tools.totem_update_task({ id: created.todo.id, dueString: 'no date' });
  assert.equal(service.get(created.todo.id).dueDate, null);
});

test('task MCP definitions have local read metadata and conservative write metadata', () => {
  assert.deepEqual(TODO_MCP_TOOL_DEFINITIONS.map(tool => tool.name), [
    'totem_get_tasks', 'totem_get_projects', 'totem_create_task', 'totem_update_task',
  ]);
  for (const tool of TODO_MCP_TOOL_DEFINITIONS) {
    assert.equal(tool.outputSchema.required.includes('fetchedAt'), true);
    assert.equal(tool.outputSchema.properties.fetchedAt.type, 'string');
    if (tool.name.startsWith('totem_get_')) {
      assert.deepEqual(tool.annotations, {
        readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
      });
    } else {
      assert.equal(tool.annotations.readOnlyHint, false);
      assert.equal(tool.annotations.openWorldHint, true);
    }
  }
  assert.equal(TODO_MCP_TOOL_DEFINITIONS.find(tool => tool.name === 'totem_create_task').annotations.destructiveHint, false);
  assert.deepEqual(TODO_MCP_TOOL_DEFINITIONS.find(tool => tool.name === 'totem_update_task').annotations, {
    readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
  });
});

test('in-process MCP client returns matching text and structured content without HTTP', async () => {
  const { service, commands } = fixture();
  const client = createTodoMcpClient({ service, commands, fetchedAt: () => NOW });
  await client.start();
  const descriptors = await client.listTools();
  assert.deepEqual(descriptors.map(tool => tool.name), ['get_tasks', 'get_projects', 'create_task', 'update_task']);
  const result = await client.callTool('create_task', { title: 'Via gateway' });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal(result.structuredContent.todo.content, 'Via gateway');
  assert.equal(result.structuredContent.fetchedAt, NOW);
});

test('MCP mutations keep the calling actor and emit one service-owned audit row', async () => {
  const { audit, tools } = fixture();
  await tools.totem_create_task({ title: 'Audited once' }, { client: 'ChatGPT' });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'todo.create');
  assert.equal(audit[0].actor, 'ChatGPT');
});

test('update shares an existing local task only with an explicit syncTarget', async () => {
  const { calls, tools } = fixture();
  const created = await tools.totem_create_task({ title: 'Share later' });
  await tools.totem_update_task({ id: created.todo.id, description: 'Still private' });
  assert.equal(calls.sheet.length, 0);
  const shared = await tools.totem_update_task({
    id: created.todo.id, syncTarget: 'sheet', sheet: { assignee: 'The owner' },
  });
  assert.equal(shared.updated, true);
  assert.equal(calls.sheet.length, 1);
  assert.equal(calls.sheet[0].method, 'share');
  assert.deepEqual(calls.sheet[0].options, { assignee: 'The owner' });
});

test('outbound gateway exposes in-process local tasks and no Todoist task tools', async () => {
  const { service, commands } = fixture();
  const taskClient = createTodoMcpClient({ service, commands, fetchedAt: () => NOW });
  const gateway = new Gateway({ servers: {} }, { taskClient });
  await gateway.connectAll();
  assert.deepEqual(gateway.tools.map(tool => tool.name).filter(name => name.startsWith('tasks__')), [
    'tasks__get_tasks', 'tasks__get_projects', 'tasks__create_task', 'tasks__update_task',
  ]);
  assert.equal(gateway.tools.some(tool => /todoist/i.test(tool.name)), false);
  const result = await gateway.callTool('tasks__create_task', { title: 'Gateway local' });
  assert.equal(result.structuredContent.todo.content, 'Gateway local');
  gateway.closeAll();
});

test('gateway recursion guard exposes no built-ins and manifest id tasks is reserved', async () => {
  const { service, commands } = fixture();
  const taskClient = createTodoMcpClient({ service, commands, fetchedAt: () => NOW });
  const guarded = new Gateway({ servers: {} }, { builtins: false, taskClient });
  await guarded.connectAll();
  assert.deepEqual(guarded.tools, []);
  assert.throws(
    () => new Gateway({ servers: { tasks: { command: 'anything' } } }, { taskClient }),
    /reserved/i,
  );
});

test('a task can be finished by deciding against it, and read back by how it ended', async () => {
  const { tools, service } = fixture();
  const created = await tools.totem_create_task({ title: 'Read the whole changelog' });

  const result = await tools.totem_update_task({ id: created.todo.id, notDoing: true });
  assert.equal(result.completed, true);
  assert.equal(result.notDoing, true);
  assert.equal(result.todo.status, 'done');
  assert.equal(result.todo.outcome, 'not_doing');
  assert.equal(service.get(created.todo.id).outcome, 'not_doing');

  const abandoned = await tools.totem_get_tasks({ includeCompleted: true, outcome: 'not_doing' });
  assert.deepEqual(abandoned.completed.map(todo => todo.id), [created.todo.id]);
  const finished = await tools.totem_get_tasks({ includeCompleted: true, outcome: 'completed' });
  assert.deepEqual(finished.completed, []);
});

test('notDoing refuses to disagree with the status it was given', async () => {
  const { tools } = fixture();
  const created = await tools.totem_create_task({ title: 'Book the flights' });

  await assert.rejects(
    () => tools.totem_update_task({ id: created.todo.id, notDoing: true, status: 'doing' }),
    error => /notDoing and status disagree/.test(error.message),
  );
  await assert.rejects(
    () => tools.totem_update_task({ id: created.todo.id, notDoing: true, complete: false }),
    error => /notDoing and complete disagree/.test(error.message),
  );
});
