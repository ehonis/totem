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
  const commands = createTodoCommands({
    service,
    maintenance: { async purgeDeleted() { return { purged: 0 }; } },
  });
  const tools = createTodoMcpTools({ service, commands, fetchedAt: () => NOW });
  cleanups.push(() => {
    closeTodoDatabase(db);
    rmSync(directory, { recursive: true, force: true });
  });
  return { service, commands, tools, audit };
}

test('MCP create stays local; only local (or no) syncTarget is taken', async () => {
  const { tools, service } = fixture();
  await tools.totem_create_task({ content: 'Initech pricing', area: 'Ventures', ventureTag: 'Initech' });
  await tools.totem_create_task({ content: 'Initech local', syncTarget: 'local' });
  assert.deepEqual(service.list().map(todo => todo.title).sort(), ['Initech local', 'Initech pricing']);
  assert.ok(service.list().every(todo => todo.externalLinks.length === 0));
});

test('MCP refuses every syncTarget but local, on create and update, before anything changes', async () => {
  const { tools, service } = fixture();
  const created = await tools.totem_create_task({ title: 'Share later' });
  const before = service.get(created.todo.id);
  for (const [syncTarget, code] of [
    ['github', 'GITHUB_SHARING_REMOVED'], ['GitHub', 'GITHUB_SHARING_REMOVED'],
    ['sheet', 'SHEET_SHARING_REMOVED'], ['bogus', 'INVALID_SYNC_TARGET'],
  ]) {
    const refused = error => error.code === code && error.status === 400;
    await assert.rejects(tools.totem_create_task({ content: 'Initech launch', area: 'Ventures', ventureTag: 'Initech', syncTarget }), refused, syncTarget);
    // Fields, a completion and a refused share in one call: the refusal comes first,
    // so nothing is renamed or completed behind the error.
    for (const input of [
      { syncTarget },
      { title: 'Renamed', syncTarget },
      { title: 'Renamed', complete: true, syncTarget },
      { description: 'changed', status: 'done', priority: 4, syncTarget },
      { notDoing: true, syncTarget },
    ]) {
      await assert.rejects(tools.totem_update_task({ id: created.todo.id, ...input }), refused, JSON.stringify(input));
    }
  }
  assert.deepEqual(service.get(created.todo.id), before);
  assert.deepEqual(service.list().map(todo => todo.title), ['Share later']);
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

test('canonical read filters and create status are honored; doing reads and writes as todo', async () => {
  const { service, tools } = fixture();
  await tools.totem_create_task({ title: 'Personal todo', status: 'todo' });
  const created = await tools.totem_create_task({ title: 'Initech doing', status: 'doing', area: 'Ventures', ventureTag: 'Initech' });
  assert.equal(created.todo.status, 'todo');
  service.create({ title: 'Acme doing', status: 'doing', area: 'Ventures', ventureTag: 'Acme' });
  for (const status of ['doing', 'todo']) {
    const result = await tools.totem_get_tasks({ status, area: 'Ventures', ventureTag: 'Initech', source: 'local' });
    assert.deepEqual(result.todos.map(todo => todo.content), ['Initech doing'], status);
  }
  await assert.rejects(tools.totem_get_tasks({ status: 'started' }), error => error.code === 'INVALID_STATUS');
  const all = await tools.totem_get_tasks({ includeCompleted: true });
  assert.ok([...all.todos, ...all.completed].every(todo => todo.status !== 'doing'));
});

test('update with status doing reopens a done task as todo and leaves an open one alone', async () => {
  const { audit, service, tools } = fixture();
  const open = service.create({ title: 'Open', area: 'Personal' });
  const before = audit.length;
  const unchanged = await tools.totem_update_task({ id: open.id, status: 'doing' });
  assert.equal(unchanged.todo.status, 'todo');
  assert.equal(unchanged.updated, false);
  assert.equal(audit.length, before, 'no move is written');
  const done = service.create({ title: 'Done', area: 'Personal' });
  service.complete(done.id);
  assert.equal((await tools.totem_update_task({ id: done.id, status: 'doing' })).todo.status, 'todo');
});

test('the MCP schema offers no share target and no connector options', async () => {
  const schema = TODO_MCP_TOOL_DEFINITIONS.find(tool => tool.name === 'totem_create_task').inputSchema.properties;
  assert.deepEqual(schema.syncTarget.enum, ['local']);
  assert.equal(Object.hasOwn(schema, 'github'), false);
  assert.equal(Object.hasOwn(schema, 'sheet'), false);
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
