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

async function fixture(options = {}) {
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
  // Nothing syncs a task out any more, so nothing should ever land here.
  const connectorCalls = [];
  const commands = createTodoCommands({
    service,
    maintenance: { async purgeDeleted() { return { purged: 0, backup: '/tmp/backup.db' }; } },
  });
  const sheetReads = [];
  const sheetFeed = {
    async read(options) {
      sheetReads.push(options);
      return { configured: true, title: 'Example HQ', url: 'https://docs.example/s', fetchedAt: NOW, stale: false, error: null, items: [{ id: 'sheet:0:5:0a1b2c3d', row: 5, title: 'Row five' }] };
    },
  };
  const handler = createTodoHttpHandler({ service, commands, sheetFeed: options.sheetFeed === undefined ? sheetFeed : options.sheetFeed, issueStates: options.issueStates ?? null, now: () => NOW, maxBodyBytes: 128 });
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
  return { service, request, connectorCalls, sheetReads };
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
  assert.equal(completed.body.todos[0].outcome, 'completed');
  assert.deepEqual(await request('DELETE', '/api/todos', { id: created.body.todo.id }), {
    status: 200, body: { ok: true },
  });
  assert.equal(service.get(created.body.todo.id).deletedAt, NOW);
});

test('the completed list says how each task ended, so not doing is not counted as done', async () => {
  const { service, request } = await fixture();
  const skipped = service.create({ title: 'Skip it' });
  service.move(skipped.id, 'done', undefined, { outcome: 'not_doing' });
  const { body } = await request('GET', '/api/todos/completed?days=1');
  assert.deepEqual(body.todos.map(todo => [todo.content, todo.outcome]), [['Skip it', 'not_doing']]);
});

test('legacy close completes a linked task here: nothing owns completion any more', async () => {
  const { service, request } = await fixture();
  const task = service.create({ title: 'Shared', area: 'Ventures', ventureTag: 'Acme' });
  service.setIssueLink(task.id, 'https://github.com/acme/acme/issues/9');
  service.attachExternalLink(task.id, { connector: 'sheet', externalId: 'row-9', externalUrl: 'https://docs.example/row-9' });
  assert.deepEqual(await request('POST', '/api/todos/close', { id: task.id }), { status: 200, body: { ok: true } });
  assert.equal(service.get(task.id).status, 'done');
});

test('HTTP creation is local; a syncTarget naming anything else is refused', async () => {
  const { request, service, connectorCalls } = await fixture();
  await request('POST', '/api/todos', { content: 'Private venture', area: 'Ventures', ventureTag: 'Initech' });
  for (const [syncTarget, code] of [['github', 'GITHUB_SHARING_REMOVED'], ['sheet', 'SHEET_SHARING_REMOVED'], ['bogus', 'INVALID_SYNC_TARGET']]) {
    const response = await request('POST', '/api/todos', { content: 'Shared venture', syncTarget });
    assert.equal(response.status, 400, syncTarget);
    assert.equal(response.body.error.code, code, syncTarget);
  }
  assert.equal(service.list().length, 1);
  assert.deepEqual(connectorCalls, []);
});

test('syncTarget github is a 400 GITHUB_SHARING_REMOVED on every create and share route', async () => {
  const { request, service, connectorCalls } = await fixture();
  for (const path of ['/api/todos', '/api/todos/board']) {
    const response = await request('POST', path, { content: 'Issue', syncTarget: 'github', repo: 'acme/acme' });
    assert.equal(response.status, 400, path);
    assert.equal(response.body.error.code, 'GITHUB_SHARING_REMOVED', path);
  }
  const task = service.create({ title: 'Local', area: 'Personal' });
  const shared = await request('POST', `/api/todos/${task.id}/share`, { target: 'github', repo: 'acme/acme' });
  assert.equal(shared.status, 400);
  assert.equal(shared.body.error.code, 'GITHUB_SHARING_REMOVED');
  assert.equal(service.list().length, 1);
  assert.deepEqual(connectorCalls, []);
});

test('GET /api/todos/sheet answers the read-only feed, passes refresh=1 through, and is not read as a task id', async () => {
  const { request, sheetReads } = await fixture();
  const out = await request('GET', '/api/todos/sheet');
  assert.equal(out.status, 200);
  assert.equal(out.body.items[0].title, 'Row five');
  await request('GET', '/api/todos/sheet?refresh=1');
  await request('GET', '/api/todos/sheet?refresh=true');
  assert.deepEqual(sheetReads, [{ refresh: false }, { refresh: true }, { refresh: false }]);
  // Only GET: nothing writes to the sheet.
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.notEqual((await request(method, '/api/todos/sheet', {})).status, 200, method);
  }
  assert.equal(sheetReads.length, 3);

  const bare = await fixture({ sheetFeed: null });
  assert.deepEqual((await bare.request('GET', '/api/todos/sheet')).body, {
    configured: false, items: [], reason: 'The task sheet is not available on this server.',
  });
});

test('HTTP refuses syncTarget sheet with 400 SHEET_SHARING_REMOVED, and the sheet admin routes are gone', async () => {
  const { request, service, connectorCalls } = await fixture();
  const removed = { status: 400, code: 'SHEET_SHARING_REMOVED' };
  const shape = response => ({ status: response.status, code: response.body?.error?.code });
  assert.deepEqual(shape(await request('POST', '/api/todos', {
    content: 'Shared venture', area: 'Ventures', ventureTag: 'Initech', syncTarget: 'sheet',
  })), removed);
  const task = service.create({ title: 'Share me', area: 'Ventures', ventureTag: 'Initech' });
  assert.deepEqual(shape(await request('POST', `/api/todos/${task.id}/share`, { target: 'sheet' })), removed);
  assert.equal(service.list().length, 1);
  assert.deepEqual(connectorCalls, []);
  for (const [method, path] of [
    ['GET', '/api/todos/connectors/sheet'],
    ['POST', '/api/todos/connectors/sheet/refresh'],
    ['POST', '/api/todos/connectors/sheet/bootstrap'],
  ]) {
    const response = await request(method, path, method === 'POST' ? {} : undefined);
    assert.notEqual(response.status, 200, path);
  }
  assert.deepEqual(connectorCalls, []);
});

test('the GitHub connector routes are gone', async () => {
  const { request, service } = await fixture();
  const task = service.create({ title: 'Publish', area: 'Personal' });
  for (const [method, path] of [
    ['GET', '/api/todos/connectors/github'],
    ['GET', '/api/todos/connectors/github/search?q=acme%2342'],
    ['POST', '/api/todos/connectors/github/link'],
    ['PATCH', '/api/todos/connectors/github/settings'],
    ['POST', '/api/todos/connectors/github/refresh'],
    ['POST', `/api/todos/${task.id}/publish-description`],
  ]) {
    assert.equal((await request(method, path, method === 'GET' ? undefined : {})).status, 418, `${method} ${path} is not claimed`);
  }
});

test('PUT issue-link sets, replaces and clears a plain link, and refuses anything but an issue URL', async () => {
  const { request, service } = await fixture();
  const task = service.create({ title: 'Linked', area: 'Personal' });
  const path = `/api/todos/${task.id}/issue-link`;

  const set = await request('PUT', path, { url: 'https://github.com/acme/acme/issues/42#top' });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.todo.issueLink, {
    connector: 'github', repo: 'acme/acme', number: 42, url: 'https://github.com/acme/acme/issues/42',
  });
  assert.equal(set.body.todo.externalLinks.length, 1);

  const replaced = await request('PUT', path, { url: 'https://github.com/acme/other/issues/7' });
  assert.equal(replaced.body.todo.issueLink.repo, 'acme/other');
  assert.equal(replaced.body.todo.externalLinks.length, 1, 'one link per task');

  for (const url of [
    'https://github.com/acme/acme/pull/42',
    'https://github.com/acme/acme',
    'http://github.com/acme/acme/issues/42',
    'https://gitlab.com/acme/acme/issues/42',
    'https://github.com/acme/acme/issues/0',
    'https://github.com/../acme/issues/4',
    'not a url',
    42,
  ]) {
    const refused = await request('PUT', path, { url });
    assert.equal(refused.status, 400, String(url));
    assert.equal(refused.body.error.code, 'INVALID_ISSUE_LINK', String(url));
  }
  assert.match((await request('PUT', path, { url: 'https://github.com/acme/acme/pull/42' })).body.error.message, /pull request/);
  assert.equal((await request('PUT', path, {})).status, 400, 'url is required, null to clear');
  assert.equal(service.get(task.id).issueLink.repo, 'acme/other', 'a refused link leaves the old one');

  const cleared = await request('PUT', path, { url: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.todo.issueLink, null);
  assert.deepEqual(cleared.body.todo.externalLinks, []);
  assert.equal((await request('PUT', '/api/todos/missing/issue-link', { url: null })).status, 404);
});

test('the generic external-links route refuses GitHub, so the issue link has one validated way in', async () => {
  const { request, service } = await fixture();
  const task = service.create({ title: 'Linked', area: 'Personal' });
  for (const connector of ['github', 'GitHub', ' github ']) {
    const refused = await request('POST', `/api/todos/${task.id}/external-links`, { connector, externalId: 'x', externalUrl: 'https://evil.example/' });
    assert.equal(refused.status, 400, connector);
    assert.equal(refused.body.error.code, 'USE_ISSUE_LINK_ROUTE', connector);
  }
  assert.deepEqual(service.get(task.id).externalLinks, []);
  assert.equal(service.get(task.id).issueLink, null);
});

test('PATCH naming syncTarget github is refused as such, and changes nothing', async () => {
  const { request, service } = await fixture();
  const task = service.create({ title: 'Keep', area: 'Personal' });
  const item = await request('PATCH', `/api/todos/${task.id}`, { title: 'Changed', syncTarget: 'github' });
  assert.equal(item.status, 400);
  assert.equal(item.body.error.code, 'GITHUB_SHARING_REMOVED');
  const legacy = await request('PATCH', '/api/todos', { id: task.id, content: 'Changed', syncTarget: 'github' });
  assert.equal(legacy.body.error.code, 'GITHUB_SHARING_REMOVED');
  assert.equal(service.get(task.id).title, 'Keep');
  assert.equal(service.get(task.id).updatedAt, task.updatedAt);
});

test('GET board reads status=doing as open and refuses a status that never existed', async () => {
  const { request, service } = await fixture();
  const open = service.create({ title: 'Open', area: 'Personal' });
  service.complete(service.create({ title: 'Done', area: 'Personal' }).id);
  assert.deepEqual((await request('GET', '/api/todos/board?status=doing')).body.todos.map(todo => todo.id), [open.id]);
  const bogus = await request('GET', '/api/todos/board?status=started');
  assert.equal(bogus.status, 400);
  assert.equal(bogus.body.error.code, 'INVALID_STATUS');
});

test('a linked task completes and reopens locally, with no sync state', async () => {
  const { request, service } = await fixture();
  const task = service.create({ title: 'Linked', area: 'Personal' });
  service.setIssueLink(task.id, 'https://github.com/acme/acme/issues/42');
  const done = await request('POST', `/api/todos/${task.id}/move`, { status: 'done' });
  assert.equal(done.status, 200);
  assert.equal(done.body.todo.status, 'done');
  assert.equal(done.body.todo.syncState.status, 'idle');
  assert.equal((await request('POST', `/api/todos/${task.id}/move`, { status: 'todo' })).body.todo.status, 'todo');
});

test('GET issue-states answers from the injected reader and is never a todo id', async () => {
  const answer = { fetchedAt: NOW, states: { 'acme/acme#42': { state: 'open', title: 'Door', url: 'https://github.com/acme/acme/issues/42' } } };
  const { request } = await fixture({ issueStates: { get: async () => answer } });
  assert.deepEqual(await request('GET', '/api/todos/issue-states'), { status: 200, body: answer });
  const { request: without } = await fixture();
  assert.equal((await without('GET', '/api/todos/issue-states')).status, 503);
});

test('board routes expose canonical records and static routes beat dynamic IDs', async () => {
  const { service, request } = await fixture();
  const task = service.create({ title: 'Board', area: 'Personal' });
  assert.equal((await request('GET', '/api/todos/board')).body.todos[0].title, 'Board');
  assert.equal((await request('PATCH', `/api/todos/${task.id}`, { title: 'Board renamed' })).body.todo.title, 'Board renamed');
  assert.equal((await request('GET', `/api/todos/${task.id}`)).body.todo.title, 'Board renamed');
  assert.deepEqual((await request('GET', '/api/todos/preferences')).body.preferences, {
    autoArchiveDays: null, autoArchiveAt: '18:00', recyclePurgeDays: null,
  });
});

test('a client that still says doing is answered with todo on move, bulk and reorder', async () => {
  const { service, request } = await fixture();
  const one = service.create({ title: 'One', area: 'Personal' });
  const two = service.create({ title: 'Two', area: 'Personal' });
  const moved = await request('POST', `/api/todos/${one.id}/move`, { status: 'doing' });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.todo.status, 'todo');
  service.complete(two.id);
  const bulk = await request('POST', '/api/todos/bulk', { ids: [two.id], operation: 'move', value: 'doing' });
  assert.deepEqual(bulk.body.todos.map(todo => todo.status), ['todo']);
  const reordered = await request('POST', '/api/todos/reorder', { status: 'doing', orderedIds: [two.id, one.id] });
  assert.equal(reordered.status, 200);
  assert.deepEqual(reordered.body.todos.map(todo => [todo.id, todo.status, todo.position]), [[two.id, 'todo', 0], [one.id, 'todo', 1]]);
  const board = await request('GET', '/api/todos/board');
  assert.ok(board.body.todos.every(todo => todo.status !== 'doing'));
  assert.equal((await request('POST', '/api/todos/board', { title: 'Three', status: 'doing' })).body.todo.status, 'todo');
});

test('GET board adds counts of archived, snoozed and deleted tasks, whatever the query', async () => {
  const { service, request } = await fixture();
  const ids = ['a', 'b', 'c', 'd', 'e'].map(title => service.create({ title, area: 'Personal' }).id);
  service.archive(ids[0]);
  service.archive(ids[1]);
  service.snooze(ids[2], '2026-09-20T12:00:00.000Z');
  service.snooze(ids[3], '2026-09-01T12:00:00.000Z');
  service.softDelete(ids[4]);
  const expected = { archived: 2, snoozed: 1, deleted: 1 };
  assert.deepEqual((await request('GET', '/api/todos/board')).body.counts, expected);
  assert.deepEqual((await request('GET', '/api/todos/board?archived=true')).body.counts, expected);
  assert.equal((await request('GET', '/api/todos/board?snoozed=false')).body.todos.length, 1);
});

test('POST board creates and returns the canonical record; legacy POST keeps its shape', async () => {
  const { request } = await fixture();
  const created = await request('POST', '/api/todos/board', { title: 'Canonical', area: 'Ventures', ventureTag: 'acme', dueDate: '2026-09-12' });
  assert.equal(created.status, 200);
  assert.deepEqual(Object.keys(created.body), ['todo']);
  const board = await request('GET', '/api/todos/board');
  assert.deepEqual(created.body.todo, board.body.todos.find(todo => todo.id === created.body.todo.id));
  assert.equal(created.body.todo.ventureTag, 'Acme');
  assert.equal(created.body.todo.issueLink, null);
  const legacy = await request('POST', '/api/todos', { content: 'Legacy' });
  assert.deepEqual(Object.keys(legacy.body), ['ok', 'todo']);
  assert.equal(legacy.body.todo.content, 'Legacy');
  assert.equal((await request('POST', '/api/todos/board', { area: 'Personal' })).status, 400);
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
