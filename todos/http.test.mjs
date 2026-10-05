import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { createTodoCommands } from './commands.mjs';
import { closeTodoDatabase, openTodoDatabase } from './db.mjs';
import { createTodoHttpHandler } from './http.mjs';
import { createTodoService } from './service.mjs';
import { seedVentureTags } from './test-support.mjs';

const NOW = '2026-09-11T12:00:00.000Z';
const cleanups = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'totem-todo-http-'));
  const db = openTodoDatabase({ file: join(directory, 'todos.db'), now: () => NOW });
  seedVentureTags(db);
  let sequence = 0;
  const service = createTodoService({
    db,
    now: () => NOW,
    makeId: () => `http-${++sequence}`,
    actionLog: { record() {} },
  });
  const connectorCalls = [];
  const connector = {
    async create(input, context) { connectorCalls.push(['create', input]); return service.create(input, context); },
    async rename(id, title, context) { return service.update(id, { title }, context); },
    async updateLinked(id, patch, context) { return service.update(id, patch, context); },
    async appendNote(id, body, context) { return service.addNote(id, body, context); },
    async bulk(input) { return service.bulk(input); },
    async refreshTask(id) { return service.get(id); },
    async link(input) { return input; },
    async search(input) { connectorCalls.push(['github-search', input]); return { issues: [{ id: '90042', title: 'Door' }] }; },
    async publishFirstNote(id) { connectorCalls.push(['github-publish', id]); return service.get(id); },
    updateSettings(input) { connectorCalls.push(['github-settings', input]); return { trackAssigned: true, watchedRepos: [] }; },
    async share(id, context, options) { connectorCalls.push(['share', id, options]); return service.get(id); },
    unshare(id, context) { connectorCalls.push(['unshare', id]); return service.get(id); },
    getHealth() { return { status: 'ok', conflicts: [] }; },
    getSettings() { return { spreadsheetId: 'sheet-id', tab: 'Action Items' }; },
    async reconcile() { connectorCalls.push(['reconcile']); return { imported: 0 }; },
    async bootstrapSchema(input) { connectorCalls.push(['bootstrap', input]); return { schema: true }; },
  };
  const commands = createTodoCommands({
    service,
    github: connector,
    sheet: connector,
    maintenance: { async purgeDeleted() { return { purged: 0, backup: '/tmp/backup.db' }; } },
  });
  const handler = createTodoHttpHandler({ service, commands, now: () => NOW, maxBodyBytes: 128 });
  const server = createServer(async (req, res) => {
    try {
      if (await handler(req, res, new URL(req.url, 'http://localhost'))) return;
      res.writeHead(418, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ unclaimed: true }));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  cleanups.push(async () => {
    server.close();
    await once(server, 'close');
    closeTodoDatabase(db);
    rmSync(directory, { recursive: true, force: true });
  });
  async function request(method, path, body, headers = {}) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  return { service, request, connectorCalls };
}

test('legacy list/create/update/close/delete/projects/completed shapes stay compatible', async () => {
  const { service, request } = await fixture();
  const created = await request('POST', '/api/todos', {
    content: 'Phone task', description: 'Call', priority: 4, labels: ['home'],
    projectId: 'personal', due: '2026-09-12',
  });
  assert.equal(created.status, 200);
  assert.deepEqual(Object.keys(created.body), ['ok', 'todo']);
  assert.deepEqual(created.body.todo, {
    id: created.body.todo.id,
    content: 'Phone task',
    description: 'Call',
    priority: 4,
    priorityLabel: 'p1',
    due: '2026-09-12',
    dueString: 'Sep 12',
    isRecurring: false,
    labels: ['home'],
    projectId: 'personal',
    project: 'Personal',
    url: null,
  });
  assert.deepEqual((await request('GET', '/api/todos')).body.todos, [created.body.todo]);
  assert.deepEqual((await request('GET', '/api/todos/projects')).body, {
    projects: [
      { id: 'personal', name: 'Personal' }, { id: 'ventures', name: 'Ventures' },
      ...['Acme', 'Globex', 'Initech'].map(name => ({ id: name, name, area: 'Ventures', color: null })),
    ],
  });

  const updated = await request('PATCH', '/api/todos', {
    id: created.body.todo.id, content: 'Renamed', due: '', labels: ['errand'],
  });
  assert.equal(updated.body.todo.content, 'Renamed');
  assert.equal(updated.body.todo.due, null);
  assert.deepEqual(updated.body.todo.labels, ['errand']);

  assert.deepEqual(await request('POST', '/api/todos/close', { id: created.body.todo.id }), {
    status: 200, body: { ok: true },
  });
  const completed = await request('GET', '/api/todos/completed?days=30');
  assert.equal(completed.body.todos[0].completed, true);
  assert.equal(completed.body.todos[0].completedAt, NOW);
  assert.deepEqual(await request('DELETE', '/api/todos', { id: created.body.todo.id }), {
    status: 200, body: { ok: true },
  });
  assert.equal(service.get(created.body.todo.id).deletedAt, NOW);
});

test('legacy close returns a structured source-owner conflict', async () => {
  const { service, request } = await fixture();
  const task = service.create({ title: 'Shared', area: 'Ventures', ventureTag: 'Acme' });
  service.attachExternalLink(task.id, {
    connector: 'sheet', externalId: 'row-9', externalUrl: 'https://docs.example/row-9',
  });
  const response = await request('POST', '/api/todos/close', { id: task.id });
  assert.equal(response.status, 409);
  assert.deepEqual(response.body.error, {
    code: 'SOURCE_OWNS_COMPLETION',
    message: 'Complete this task in the Action Items sheet.',
    details: { source: 'sheet', url: 'https://docs.example/row-9' },
  });
});

test('HTTP creation shares only when syncTarget is explicit', async () => {
  const { request, connectorCalls } = await fixture();
  await request('POST', '/api/todos', { content: 'Private venture', area: 'Ventures', ventureTag: 'Initech' });
  assert.deepEqual(connectorCalls, []);
  await request('POST', '/api/todos', {
    content: 'Shared venture', area: 'Ventures', ventureTag: 'Initech', syncTarget: 'sheet',
  });
  await request('POST', '/api/todos', {
    content: 'Published issue', syncTarget: 'github', repo: 'acme/acme',
  });
  assert.equal(connectorCalls.length, 2);
  assert.equal(connectorCalls[0][0], 'create');
  assert.equal(connectorCalls[1][1].repo, 'acme/acme');
});

test('HTTP exposes Sheet health, refresh, bootstrap, and passes explicit share options', async () => {
  const { request, service, connectorCalls } = await fixture();
  const task = service.create({ title: 'Share me', area: 'Ventures', ventureTag: 'Initech' });

  assert.deepEqual(await request('GET', '/api/todos/connectors/sheet'), {
    status: 200,
    body: { health: { status: 'ok', conflicts: [] }, settings: { spreadsheetId: 'sheet-id', tab: 'Action Items' } },
  });
  assert.equal((await request('POST', '/api/todos/connectors/sheet/refresh', {})).status, 200);
  assert.equal((await request('POST', '/api/todos/connectors/sheet/bootstrap', { confirmSheetId: 'sheet-id' })).status, 200);
  assert.equal((await request('POST', `/api/todos/${task.id}/share`, { target: 'sheet', ventureTag: 'Initech' })).status, 200);
  assert.deepEqual(connectorCalls.slice(-3), [
    ['reconcile'],
    ['bootstrap', { confirmSheetId: 'sheet-id' }],
    ['share', task.id, { target: 'sheet', ventureTag: 'Initech' }],
  ]);
});

test('HTTP exposes GitHub health, search, link, settings, refresh, and note publishing', async () => {
  const { request, service, connectorCalls } = await fixture();
  const task = service.create({ title: 'Publish', area: 'Personal' });
  assert.equal((await request('GET', '/api/todos/connectors/github')).status, 200);
  assert.equal((await request('GET', '/api/todos/connectors/github/search?q=acme%2342&repo=acme%2Facme')).body.issues[0].id, '90042');
  assert.equal((await request('POST', '/api/todos/connectors/github/link', { issueId: '90042' })).status, 200);
  assert.equal((await request('PATCH', '/api/todos/connectors/github/settings', { trackAssigned: true })).status, 200);
  assert.equal((await request('POST', '/api/todos/connectors/github/refresh', {})).status, 200);
  assert.equal((await request('POST', `/api/todos/${task.id}/publish-description`, {})).status, 200);
  assert.deepEqual(connectorCalls.filter(call => String(call[0]).startsWith('github')), [
    ['github-search', { query: 'acme#42', selectedRepo: 'acme/acme' }],
    ['github-settings', { trackAssigned: true }],
    ['github-publish', task.id],
  ]);
});

test('board routes expose canonical records and static routes beat dynamic IDs', async () => {
  const { service, request } = await fixture();
  const task = service.create({ title: 'Board', area: 'Personal' });
  assert.equal((await request('GET', '/api/todos/board')).body.todos[0].title, 'Board');
  assert.equal((await request('PATCH', `/api/todos/${task.id}`, { title: 'Board renamed' })).body.todo.title, 'Board renamed');
  assert.equal((await request('GET', `/api/todos/${task.id}`)).body.todo.title, 'Board renamed');
  assert.equal((await request('POST', `/api/todos/${task.id}/move`, { status: 'doing' })).body.todo.status, 'doing');
  assert.deepEqual((await request('GET', '/api/todos/preferences')).body.preferences, {
    autoArchiveDays: null, autoArchiveAt: '18:00', recyclePurgeDays: null,
  });
});

test('rejects malformed and oversized JSON without invoking a mutation', async () => {
  const { service, request } = await fixture();
  assert.equal((await request('POST', '/api/todos', '{bad')).status, 400);
  assert.equal((await request('POST', '/api/todos', JSON.stringify({ content: 'é'.repeat(100) }))).status, 413);
  assert.equal(service.list().length, 0);
});

test('does not claim prompt, malformed IDs, or similarly prefixed routes', async () => {
  const { request } = await fixture();
  assert.equal((await request('POST', '/api/todos/prompt', { text: 'later' })).status, 418);
  assert.equal((await request('GET', '/api/todosaurus')).status, 418);
  assert.equal((await request('POST', '/api/todos/%E0%A4%A/move', { status: 'doing' })).status, 400);
});
