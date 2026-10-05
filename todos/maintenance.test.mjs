import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { backupTodoDatabase, closeTodoDatabase, openTodoDatabase } from './db.mjs';
import { createTodoMaintenance, lastDailyBoundary } from './maintenance.mjs';
import { createTodoService } from './service.mjs';
import { seedVentureTags } from './test-support.mjs';

const NOW = '2026-09-30T12:00:00.000Z';
const directories = [];
const databases = [];

afterEach(() => {
  for (const db of databases.splice(0)) closeTodoDatabase(db);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture({ backupDatabase } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'totem-todo-maintenance-'));
  directories.push(directory);
  const databaseFile = join(directory, 'todos.db');
  const backupDirectory = join(directory, 'backups');
  const db = openTodoDatabase({ file: databaseFile, now: () => NOW });
  seedVentureTags(db);
  databases.push(db);
  let id = 0;
  const service = createTodoService({
    db,
    now: () => NOW,
    makeId: () => `generated-${++id}`,
    actionLog: { record() {} },
  });
  const maintenance = createTodoMaintenance({
    db,
    service,
    backupDirectory,
    now: () => NOW,
    backupDatabase,
  });
  return { backupDirectory, databaseFile, db, maintenance, service };
}

test('manual purge creates a restorable database backup before deleting eligible rows', async () => {
  const { backupDirectory, maintenance, service } = fixture();
  const deleted = service.importRecord({
    title: 'Old deleted task',
    area: 'Personal',
    deletedAt: '2026-09-01T12:00:00.000Z',
  }, { source: 'fixture', externalId: 'deleted-1' });

  const result = await maintenance.purgeDeleted({ olderThan: '2026-09-10T00:00:00.000Z' });

  assert.equal(result.purged, 1);
  assert.equal(service.get(deleted.id), null);
  const backups = readdirSync(backupDirectory);
  assert.equal(backups.length, 1);
  const backup = openTodoDatabase({ file: join(backupDirectory, backups[0]), now: () => NOW });
  databases.push(backup);
  assert.equal(backup.prepare('SELECT title FROM todos WHERE id = ?').get(deleted.id).title, 'Old deleted task');
});

test('manual purge rejects null, undefined, and empty cutoffs before backup', async t => {
  for (const [name, olderThan] of [['null', null], ['undefined', undefined], ['empty', '']]) {
    await t.test(name, async () => {
      const { backupDirectory, maintenance } = fixture();

      await assert.rejects(maintenance.purgeDeleted({ olderThan }), /olderThan must be a valid timestamp/);
      assert.throws(() => readdirSync(backupDirectory), /ENOENT/);
    });
  }
});

test('manual purge cannot delete an old row created during the asynchronous backup gap', async () => {
  let secondService;
  let insertedDuringBackup;
  const { databaseFile, maintenance, service } = fixture({
    backupDatabase: async options => {
      await backupTodoDatabase(options);
      insertedDuringBackup = secondService.importRecord({
        title: 'Arrived during backup',
        area: 'Personal',
        deletedAt: '2026-08-01T12:00:00.000Z',
      }, { source: 'fixture', externalId: 'during-backup' });
    },
  });
  const secondDb = openTodoDatabase({ file: databaseFile, now: () => NOW });
  databases.push(secondDb);
  secondService = createTodoService({
    db: secondDb,
    now: () => NOW,
    makeId: () => 'during-backup-id',
    actionLog: { record() {} },
  });
  const beforeBackup = service.importRecord({
    title: 'Present before backup',
    area: 'Personal',
    deletedAt: '2026-08-01T12:00:00.000Z',
  }, { source: 'fixture', externalId: 'before-backup' });

  const result = await maintenance.purgeDeleted({ olderThan: '2026-09-01T00:00:00.000Z' });

  assert.equal(result.purged, 1);
  assert.equal(service.get(beforeBackup.id), null);
  assert.equal(service.get(insertedDuringBackup.id).deletedAt, '2026-08-01T12:00:00.000Z');
});

test('scheduled maintenance applies persisted archive and recycle windows', async () => {
  const { backupDirectory, maintenance, service } = fixture();
  const completed = service.importRecord({
    title: 'Old completed task',
    area: 'Personal',
    status: 'done',
    completedAt: '2026-08-01T12:00:00.000Z',
  }, { source: 'fixture', externalId: 'done-1' });
  const deleted = service.importRecord({
    title: 'Old deleted task',
    area: 'Personal',
    deletedAt: '2026-09-01T12:00:00.000Z',
  }, { source: 'fixture', externalId: 'deleted-1' });
  service.updatePreferences({ autoArchiveDays: 30, recyclePurgeDays: 14 });

  const result = await maintenance.run();

  assert.deepEqual(result, { archived: 1, purged: 1, backup: join(backupDirectory, 'todos-2026-09-30T12-00-00-000Z.db') });
  assert.equal(service.get(completed.id).archivedAt, NOW);
  assert.equal(service.get(deleted.id), null);
  assert.equal(readdirSync(backupDirectory).length, 1);
});

test('scheduled maintenance without a purge preference archives without creating a backup', async () => {
  const { backupDirectory, maintenance, service } = fixture();
  service.importRecord({
    title: 'Old completed task',
    area: 'Personal',
    status: 'done',
    completedAt: '2026-08-01T12:00:00.000Z',
  }, { source: 'fixture', externalId: 'done-1' });
  service.updatePreferences({ autoArchiveDays: 30 });

  const result = await maintenance.run();

  assert.deepEqual(result, { archived: 1, purged: 0, backup: null });
  assert.throws(() => readdirSync(backupDirectory), /ENOENT/);
});

test('the daily boundary is the last time the hour passed, so a catch-up run archives the same day', () => {
  // Evening of the 30th, with the sweep set for 18:00.
  assert.equal(
    lastDailyBoundary(new Date(2026, 8, 30, 19, 30), '18:00'),
    new Date(2026, 8, 30, 18, 0, 0, 0).toISOString(),
  );
  // Next morning, before the hour: still yesterday's boundary, so a run that was
  // missed at 18:00 archives yesterday's work and leaves today's alone.
  assert.equal(
    lastDailyBoundary(new Date(2026, 8, 31, 9, 0), '18:00'),
    new Date(2026, 8, 30, 18, 0, 0, 0).toISOString(),
  );
  assert.throws(() => lastDailyBoundary(new Date(), '6pm'), /HH:MM/);
})

test('the daily sweep archives what was finished before the hour and leaves the rest on the board', async () => {
  const evening = new Date(2026, 8, 30, 19, 30)
  const { db, service } = fixture()
  const maintenance = createTodoMaintenance({
    db, service, backupDirectory: join(mkdtempSync(join(tmpdir(), 'totem-sweep-')), 'backups'),
    now: () => evening.toISOString(),
  })
  service.updatePreferences({ autoArchiveAt: '18:00' })

  const yesterday = service.importRecord({
    title: 'Finished yesterday', area: 'Personal', status: 'done',
    completedAt: new Date(2026, 8, 29, 15, 0).toISOString(),
  }, { source: 'fixture', externalId: 'yesterday' })
  const beforeSix = service.importRecord({
    title: 'Finished this afternoon', area: 'Personal', status: 'done',
    completedAt: new Date(2026, 8, 30, 14, 0).toISOString(),
  }, { source: 'fixture', externalId: 'afternoon' })
  const afterSix = service.importRecord({
    title: 'Finished after the sweep', area: 'Personal', status: 'done',
    completedAt: new Date(2026, 8, 30, 18, 40).toISOString(),
  }, { source: 'fixture', externalId: 'evening' })

  const result = await maintenance.run()

  assert.equal(result.archived, 2)
  assert.ok(service.get(yesterday.id).archivedAt)
  assert.ok(service.get(beforeSix.id).archivedAt)
  assert.equal(service.get(afterSix.id).archivedAt, null, 'work finished after the hour belongs to today')
})

test('with no archive preference set nothing is ever swept away', async () => {
  const { maintenance, service } = fixture()
  service.updatePreferences({ autoArchiveAt: null })
  const done = service.importRecord({
    title: 'Finished long ago', area: 'Personal', status: 'done',
    completedAt: '2026-01-01T12:00:00.000Z',
  }, { source: 'fixture', externalId: 'ancient' })

  assert.equal((await maintenance.run()).archived, 0)
  assert.equal(service.get(done.id).archivedAt, null)
})
