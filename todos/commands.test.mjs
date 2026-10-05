import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { createTodoCommands } from './commands.mjs';
import { closeTodoDatabase, openTodoDatabase } from './db.mjs';
import { createTodoService } from './service.mjs';
import { seedVentureTags } from './test-support.mjs';

const NOW = '2026-09-11T12:00:00.000Z';
const cleanups = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'totem-todo-commands-'));
  const db = openTodoDatabase({ file: join(directory, 'todos.db'), now: () => NOW });
  seedVentureTags(db);
  let sequence = 0;
  const service = createTodoService({
    db,
    now: () => NOW,
    makeId: () => `id-${++sequence}`,
    actionLog: { record() {} },
  });
  cleanups.push(() => {
    closeTodoDatabase(db);
    rmSync(directory, { recursive: true, force: true });
  });
  const calls = [];
  const github = {
    async create(input, context) {
      calls.push(['github.create', input, context]);
      return service.create(input, context);
    },
    async rename(id, title, context) {
      calls.push(['github.rename', id, title, context]);
      return service.update(id, { title }, context);
    },
    async refreshTask(id) { calls.push(['github.refresh', id]); return service.get(id); },
    async link(input, context) { calls.push(['github.link', input, context]); return input; },
  };
  const sheet = {
    async create(input, context) {
      calls.push(['sheet.create', input, context]);
      return service.create(input, context);
    },
    async updateLinked(id, patch, context) {
      calls.push(['sheet.update', id, patch, context]);
      return service.update(id, patch, context);
    },
    async appendNote(id, body, context) {
      calls.push(['sheet.note', id, body, context]);
      return service.addNote(id, body, context);
    },
    async bulk(input) { calls.push(['sheet.bulk', input]); return service.bulk(input); },
    async refreshTask(id) { calls.push(['sheet.refresh', id]); return service.get(id); },
    async share(id, context) { calls.push(['sheet.share', id, context]); return service.get(id); },
  };
  const maintenance = {
    async purgeDeleted(input) { calls.push(['maintenance.purge', input]); return { purged: 2, backup: '/tmp/backup.db' }; },
  };
  return { service, calls, commands: createTodoCommands({ service, github, sheet, maintenance }) };
}

test('creates locally unless an explicit connector target is selected', async () => {
  const { commands, calls, service } = fixture();
  const local = await commands.create({ title: 'Private', area: 'Personal' });
  assert.equal(local.title, 'Private');
  assert.deepEqual(calls, []);

  await commands.create({ title: 'Shared', area: 'Ventures', ventureTag: 'Initech', syncTarget: 'sheet' });
  assert.equal(calls[0][0], 'sheet.create');
  assert.equal(service.list().length, 2);
});

test('prevalidates a compound GitHub patch and commits a successful rename exactly once', async () => {
  const { commands, calls, service } = fixture();
  const task = service.create({ title: 'Old', area: 'Personal' });
  service.attachExternalLink(task.id, { connector: 'github', externalId: '42' });

  await assert.rejects(
    commands.update(task.id, { title: 'Must not escape', nope: true }),
    error => error.code === 'UNKNOWN_PATCH_FIELD',
  );
  assert.equal(calls.length, 0);
  assert.equal(service.get(task.id).title, 'Old');

  const updated = await commands.update(task.id, { title: 'New' });
  assert.equal(updated.title, 'New');
  assert.deepEqual(calls.map(call => call.slice(0, 3)), [['github.rename', task.id, 'New']]);
});

test('routes Sheet shared fields, notes, and bulk changes through the connector', async () => {
  const { commands, calls, service } = fixture();
  const task = service.create({ title: 'Sheet task', area: 'Ventures', ventureTag: 'Acme' });
  service.attachExternalLink(task.id, { connector: 'sheet', externalId: 'row-5' });

  await commands.update(task.id, { priority: 4 });
  await commands.addNote(task.id, 'Meeting note');
  await commands.bulk({ ids: [task.id], operation: 'priority', value: 3 });
  assert.deepEqual(calls.map(call => call[0]), ['sheet.update', 'sheet.note', 'sheet.bulk']);

  await commands.update(task.id, { snoozedUntil: '2026-09-12T12:00:00.000Z' });
  assert.equal(calls.length, 3);
});

test('source-owned completion stays atomic and purge only uses maintenance', async () => {
  const { commands, calls, service } = fixture();
  const local = service.create({ title: 'Local', area: 'Personal' });
  const linked = service.create({ title: 'Linked', area: 'Personal' });
  service.attachExternalLink(linked.id, { connector: 'sheet', externalId: 'row-6' });

  await assert.rejects(
    commands.bulk({ ids: [local.id, linked.id], operation: 'complete' }),
    error => error.code === 'SOURCE_OWNS_COMPLETION',
  );
  assert.equal(service.get(local.id).status, 'todo');

  assert.deepEqual(await commands.purge({ olderThan: '2026-09-01T00:00:00.000Z' }), {
    purged: 2,
    backup: '/tmp/backup.db',
  });
  assert.equal(calls.at(-1)[0], 'maintenance.purge');
});
