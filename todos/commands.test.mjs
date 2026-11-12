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
  const maintenance = {
    async purgeDeleted(input) { calls.push(['maintenance.purge', input]); return { purged: 2, backup: '/tmp/backup.db' }; },
  };
  return { service, calls, commands: createTodoCommands({ service, maintenance }) };
}

test('creates locally, and refuses every syncTarget but local before anything is written', async () => {
  const { commands, calls, service } = fixture();
  const local = await commands.create({ title: 'Private', area: 'Personal' });
  assert.equal(local.title, 'Private');
  assert.equal((await commands.create({ title: 'Also local', area: 'Personal', syncTarget: 'local' })).title, 'Also local');
  for (const [syncTarget, code] of [
    ['github', 'GITHUB_SHARING_REMOVED'], ['GitHub', 'GITHUB_SHARING_REMOVED'],
    ['sheet', 'SHEET_SHARING_REMOVED'], [' Sheet ', 'SHEET_SHARING_REMOVED'],
    ['bogus', 'INVALID_SYNC_TARGET'], [42, 'INVALID_SYNC_TARGET'],
  ]) {
    await assert.rejects(
      commands.create({ title: 'Shared', area: 'Ventures', ventureTag: 'Initech', syncTarget, repo: 'acme/acme' }),
      error => error.code === code && error.status === 400,
      String(syncTarget),
    );
  }
  assert.equal(service.list().length, 2, 'no refused create left a task');
  assert.deepEqual(calls, []);
});

test('share is refused for every target, with the reason a retired one had, and nothing changes', async () => {
  const { commands, calls, service } = fixture();
  const task = service.create({ title: 'Local', area: 'Personal' });
  for (const [target, code] of [['github', 'GITHUB_SHARING_REMOVED'], ['sheet', 'SHEET_SHARING_REMOVED'], ['local', 'INVALID_SYNC_TARGET'], ['bogus', 'INVALID_SYNC_TARGET']]) {
    await assert.rejects(commands.share(task.id, target, {}, { repo: 'acme/acme' }), error => error.code === code, target);
  }
  assert.deepEqual(service.get(task.id).externalLinks, []);
  assert.equal(service.get(task.id).updatedAt, task.updatedAt);
  assert.deepEqual(calls, []);
});

test('an update naming a syncTarget is refused as such, before the patch is validated or written', async () => {
  const { commands, service } = fixture();
  const task = service.create({ title: 'Keep', area: 'Personal' });
  for (const [syncTarget, code] of [['GitHub', 'GITHUB_SHARING_REMOVED'], ['sheet', 'SHEET_SHARING_REMOVED'], ['bogus', 'INVALID_SYNC_TARGET']]) {
    await assert.rejects(commands.update(task.id, { title: 'Changed', syncTarget }), error => error.code === code, syncTarget);
  }
  assert.equal(service.get(task.id).title, 'Keep');
  assert.equal(service.get(task.id).updatedAt, task.updatedAt);
  assert.equal((await commands.update(task.id, { title: 'Changed', syncTarget: 'local' })).title, 'Changed');
});

test('a task with a GitHub issue link is edited, refreshed and completed locally', async () => {
  const { commands, calls, service } = fixture();
  const task = service.create({ title: 'Old', area: 'Personal' });
  service.setIssueLink(task.id, 'https://github.com/acme/acme/issues/42');

  assert.equal((await commands.update(task.id, { title: 'New' })).title, 'New');
  assert.equal((await commands.refresh(task.id)).id, task.id);
  assert.equal((await commands.close(task.id)).status, 'done');
  assert.equal((await commands.move(task.id, 'todo')).status, 'todo');
  assert.deepEqual(calls, [], 'no connector is involved');
});

test('a task left linked by the retired sheet sync is a local task: edits, notes, bulk, completion and unlinking stay here', async () => {
  const { commands, calls, service } = fixture();
  const task = service.create({ title: 'Sheet task', area: 'Ventures', ventureTag: 'Acme' });
  service.attachExternalLink(task.id, { connector: 'sheet', externalId: 'row-5' });

  assert.equal((await commands.update(task.id, { priority: 4 })).priority, 4);
  await commands.addNote(task.id, 'Meeting note');
  await commands.bulk({ ids: [task.id], operation: 'priority', value: 3 });
  assert.equal((await commands.refresh(task.id)).id, task.id);
  assert.equal((await commands.close(task.id)).status, 'done');
  assert.equal((await commands.detachExternalLink(task.id, 'sheet')).externalLinks.length, 0);
  assert.deepEqual(calls, []);
  const after = service.get(task.id);
  assert.equal(after.priority, 3);
  assert.equal(after.notes.length, 1);
});

test('nothing owns completion, so a bulk complete with linked tasks completes them all; purge only uses maintenance', async () => {
  const { commands, calls, service } = fixture();
  const local = service.create({ title: 'Local', area: 'Personal' });
  const linked = service.create({ title: 'Linked', area: 'Personal' });
  service.setIssueLink(linked.id, 'https://github.com/acme/acme/issues/6');
  service.attachExternalLink(linked.id, { connector: 'sheet', externalId: 'row-6' });

  const done = await commands.bulk({ ids: [local.id, linked.id], operation: 'complete' });
  assert.deepEqual(done.map(todo => todo.status), ['done', 'done']);

  assert.deepEqual(await commands.purge({ olderThan: '2026-09-01T00:00:00.000Z' }), {
    purged: 2,
    backup: '/tmp/backup.db',
  });
  assert.equal(calls.at(-1)[0], 'maintenance.purge');
});
