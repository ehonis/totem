import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { Worker } from 'node:worker_threads';

import { closeTodoDatabase, openTodoDatabase } from './db.mjs';
import { createTodoService } from './service.mjs';
import { seedVentureTags } from './test-support.mjs';

const NOW = '2026-09-11T12:00:00.000Z';
const tempDirectories = [];
const databases = [];

afterEach(() => {
  for (const db of databases.splice(0)) closeTodoDatabase(db);
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'totem-todo-service-'));
  tempDirectories.push(directory);
  const file = join(directory, 'todos.db');
  const db = openTodoDatabase({ file, now: () => NOW });
  seedVentureTags(db);
  databases.push(db);
  const entries = [];
  let id = 0;
  const service = createTodoService({
    db,
    now: () => NOW,
    makeId: () => `generated-${++id}`,
    actionLog: { record: entry => entries.push(entry) },
  });
  return { db, entries, file, service };
}

const WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require('node:worker_threads');

  (async () => {
    const { openTodoDatabase, closeTodoDatabase } = await import(workerData.dbUrl);
    const { createTodoService } = await import(workerData.serviceUrl);
    const db = openTodoDatabase({ file: workerData.file, now: () => workerData.now });
    const service = createTodoService({
      db,
      now: () => workerData.now,
      makeId: () => workerData.generatedId,
      actionLog: { record() {} },
    });
    parentPort.postMessage({ ready: true });
    parentPort.once('message', () => {
      try {
        const result = workerData.operation === 'attach'
          ? service.attachExternalLink(workerData.taskId, {
              connector: 'sheet',
              externalId: 'sheet-concurrent',
            })
          : workerData.operation === 'archive-completed'
            ? service.archiveCompleted({ olderThan: workerData.olderThan })
            : service.complete(workerData.taskId);
        parentPort.postMessage({ ok: true, status: result?.status, result });
      } catch (error) {
        parentPort.postMessage({ ok: false, code: error.code, message: error.message });
      } finally {
        closeTodoDatabase(db);
      }
    });
  })().catch(error => parentPort.postMessage({ fatal: error.message }));
`;

async function startServiceWorker({ file, operation, taskId, olderThan }) {
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      file,
      operation,
      taskId,
      now: NOW,
      generatedId: `worker-${operation}`,
      olderThan,
      dbUrl: new URL('./db.mjs', import.meta.url).href,
      serviceUrl: new URL('./service.mjs', import.meta.url).href,
    },
  });
  const ready = await new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  assert.deepEqual(ready, { ready: true });
  const result = new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  return { result, worker };
}

async function letWorkerReachWriteLock() {
  await new Promise(resolve => setTimeout(resolve, 150));
}

function insertGitHubOwner(db, taskId, id = 'link-concurrent') {
  db.prepare(`
    INSERT INTO external_links (
      id, todo_id, connector, external_id, created_at, updated_at
    ) VALUES (?, ?, 'github', 'github-concurrent', ?, ?)
  `).run(id, taskId, NOW, NOW);
}

function linkedTask(service, connector = 'github') {
  const task = service.create({ title: 'Linked task', area: 'Personal' });
  return service.attachExternalLink(task.id, {
    connector,
    externalId: connector === 'github' ? '12345' : 'sheet-row-1',
    externalUrl: `https://example.test/${connector}/1`,
  });
}

test('requires exactly one venture classification for Ventures', () => {
  const { service } = fixture();

  assert.throws(() => service.create({ title: 'Launch', area: 'Ventures' }), error =>
    error.code === 'VENTURE_TAG_REQUIRED' && error.status === 400);
  assert.throws(
    () => service.create({ title: 'Personal', area: 'Personal', ventureTag: 'Initech' }),
    error => error.code === 'VENTURE_TAG_NOT_ALLOWED' && error.status === 400,
  );
  assert.equal(
    service.create({ title: 'Launch', area: 'Ventures', ventureTag: 'Initech' }).ventureTag,
    'Initech',
  );
});

test('rejects local completion when an external source owns completion', () => {
  const { service } = fixture();
  const task = linkedTask(service, 'sheet');

  assert.throws(() => service.complete(task.id), error =>
    error.code === 'SOURCE_OWNS_COMPLETION' &&
    error.status === 409 &&
    error.details.source === 'sheet' &&
    error.details.url === 'https://example.test/sheet/1');
  assert.throws(() => service.move(task.id, 'done'), error =>
    error.code === 'SOURCE_OWNS_COMPLETION' && error.status === 409);
  assert.equal(service.get(task.id).status, 'todo');
});

test('allows only one completion-owning external link per task', () => {
  const { service } = fixture();
  const task = linkedTask(service, 'github');

  assert.throws(() => service.attachExternalLink(task.id, {
    connector: 'sheet',
    externalId: 'sheet-row-2',
    externalUrl: 'https://example.test/sheet/2',
  }), error =>
    error.code === 'EXTERNAL_COMPLETION_OWNER_EXISTS' &&
    error.status === 409 &&
    error.details.source === 'github');
  assert.equal(service.get(task.id).externalLinks.length, 1);
});

test('external non-completion seeds once, completion forces done, and reopen resets to todo', () => {
  const { service } = fixture();
  const task = linkedTask(service, 'github');

  service.applyExternalObservation({ taskId: task.id, completed: false, initialStatus: 'doing' });
  service.move(task.id, 'todo');
  service.applyExternalObservation({ taskId: task.id, completed: false, initialStatus: 'doing' });
  assert.equal(service.get(task.id).status, 'todo');

  service.applyExternalObservation({ taskId: task.id, completed: true });
  assert.equal(service.get(task.id).status, 'done');
  service.applyExternalObservation({ taskId: task.id, completed: true });
  assert.equal(service.get(task.id).status, 'done');

  service.applyExternalObservation({ taskId: task.id, completed: false });
  assert.equal(service.get(task.id).status, 'todo');
  service.move(task.id, 'doing');
  service.applyExternalObservation({ taskId: task.id, completed: false, initialStatus: 'todo' });
  assert.equal(service.get(task.id).status, 'doing');
});

test('external observation applies an authoritative title without resetting open local focus', () => {
  const { service } = fixture();
  const task = linkedTask(service, 'github');
  service.move(task.id, 'doing');

  const observed = service.applyExternalObservation({
    taskId: task.id,
    completed: false,
    title: 'Renamed on GitHub',
    sourceSnapshot: { state: 'open', title: 'Renamed on GitHub' },
  });

  assert.equal(observed.title, 'Renamed on GitHub');
  assert.equal(observed.status, 'doing');
  assert.deepEqual(observed.externalLinks[0].sourceSnapshot, {
    state: 'open',
    title: 'Renamed on GitHub',
  });
});

test('terminally exhausted connector work is visible in task sync state', () => {
  const { db, service } = fixture();
  const task = service.create({ title: 'Needs sync', area: 'Personal' });
  db.prepare(`
    INSERT INTO sync_outbox (
      id, todo_id, connector, operation, payload, idempotency_key, status,
      attempts, last_error, created_at, updated_at
    ) VALUES (?, ?, 'github', 'rename', '{}', ?, 'exhausted', 5, ?, ?, ?)
  `).run('outbox-exhausted', task.id, `rename-${task.id}`, 'rate limited', NOW, NOW);

  assert.deepEqual(service.get(task.id).syncState, {
    status: 'error',
    pending: 0,
    conflicts: 0,
    exhausted: 1,
    missing: false,
    lastSuccessAt: null,
    lastError: 'rate limited',
  });
});

test('non-owner external observations update metadata without changing local status', () => {
  const { service } = fixture();
  const task = service.create({ title: 'Calendar-linked', area: 'Personal', status: 'doing' });
  service.attachExternalLink(task.id, { connector: 'calendar', externalId: 'event-1' });

  const observed = service.applyExternalObservation({
    taskId: task.id,
    completed: true,
    sourceStatus: 'cancelled',
    sourceSnapshot: { state: 'cancelled' },
  });

  assert.equal(observed.status, 'doing');
  assert.equal(observed.externalLinks[0].sourceStatus, 'cancelled');
  assert.deepEqual(observed.externalLinks[0].sourceSnapshot, { state: 'cancelled' });
});

test('reopen uses persisted completion boolean instead of source status wording', () => {
  const { service } = fixture();
  const task = linkedTask(service, 'github');

  service.applyExternalObservation({
    taskId: task.id,
    completed: true,
    sourceStatus: 'merged',
    sourceSnapshot: { state: 'custom' },
  });
  assert.equal(service.get(task.id).status, 'done');
  service.applyExternalObservation({ taskId: task.id, completed: false, sourceStatus: 'available' });
  assert.equal(service.get(task.id).status, 'todo');

  service.move(task.id, 'doing');
  service.applyExternalObservation({ taskId: task.id, completed: false, sourceStatus: 'closed' });
  service.applyExternalObservation({ taskId: task.id, completed: false, sourceStatus: 'closed' });
  assert.equal(service.get(task.id).status, 'doing');
});

test('concurrent completion owners cannot both attach through separate connections', async () => {
  const { db, file, service } = fixture();
  const task = service.create({ title: 'Concurrent link', area: 'Personal' });
  const { result, worker } = await startServiceWorker({ file, operation: 'attach', taskId: task.id });

  db.exec('BEGIN IMMEDIATE');
  worker.postMessage({ go: true });
  await letWorkerReachWriteLock();
  insertGitHubOwner(db, task.id);
  db.exec('COMMIT');

  assert.deepEqual(await result, {
    ok: false,
    code: 'EXTERNAL_COMPLETION_OWNER_EXISTS',
    message: 'This task already gets completion state from github.',
  });
  await worker.terminate();
  assert.deepEqual(
    service.get(task.id).externalLinks.map(link => link.connector),
    ['github'],
  );
});

test('a completion owner cannot attach between local authorization and write', async () => {
  const { db, file, service } = fixture();
  const task = service.create({ title: 'Concurrent completion', area: 'Personal' });
  const { result, worker } = await startServiceWorker({ file, operation: 'complete', taskId: task.id });

  db.exec('BEGIN IMMEDIATE');
  worker.postMessage({ go: true });
  await letWorkerReachWriteLock();
  insertGitHubOwner(db, task.id);
  db.exec('COMMIT');

  const completed = await result;
  assert.equal(completed.ok, false);
  assert.equal(completed.code, 'SOURCE_OWNS_COMPLETION');
  await worker.terminate();
  assert.equal(service.get(task.id).status, 'todo');
});

test('archiveCompleted rechecks eligibility after acquiring the write transaction', async () => {
  const { db, file, service } = fixture();
  const task = service.importRecord({
    title: 'Concurrent reopen',
    area: 'Personal',
    status: 'done',
    completedAt: '2026-08-01T12:00:00.000Z',
  }, { source: 'fixture', externalId: 'archive-race' });
  const { result, worker } = await startServiceWorker({
    file,
    operation: 'archive-completed',
    olderThan: '2026-09-01T00:00:00.000Z',
  });

  db.exec('BEGIN IMMEDIATE');
  worker.postMessage({ go: true });
  await letWorkerReachWriteLock();
  db.prepare(`
    UPDATE todos SET status = 'todo', completed_at = NULL, updated_at = ? WHERE id = ?
  `).run(NOW, task.id);
  db.exec('COMMIT');

  assert.deepEqual(await result, { ok: true, status: undefined, result: 0 });
  await worker.terminate();
  assert.equal(service.get(task.id).archivedAt, null);
});

test('does not treat an initial open observation as a completed-to-open transition', () => {
  const { service } = fixture();
  const local = service.create({ title: 'Already done', area: 'Personal', status: 'done' });
  service.attachExternalLink(local.id, { connector: 'github', externalId: '77' });

  service.applyExternalObservation({ taskId: local.id, completed: false, initialStatus: 'doing' });

  assert.equal(service.get(local.id).status, 'doing');
});

test('returns canonical DTOs and supports core list filters', () => {
  const { service } = fixture();
  const task = service.create({
    title: '  Ship release  ',
    description: 'Details',
    area: 'Ventures',
    ventureTag: 'Globex',
    priority: 4,
    dueDate: '2026-09-20',
    recurrence: '   ',
    snoozedUntil: '2026-09-12T08:30:45Z',
    position: 2.5,
  });
  service.attachExternalLink(task.id, { connector: 'github', externalId: '88' });

  const actual = service.get(task.id);
  assert.deepEqual(actual, {
    id: 'generated-1',
    title: 'Ship release',
    description: 'Details',
    area: 'Ventures',
    ventureTag: 'Globex',
    status: 'todo',
    priority: 4,
    dueDate: '2026-09-20',
    recurrence: null,
    snoozedUntil: '2026-09-12T08:30:45.000Z',
    position: 2.5,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    outcome: null,
    archivedAt: null,
    deletedAt: null,
    tags: [],
    notes: [],
    relations: [],
    lists: [],
    externalLinks: [{
      id: 'generated-2',
      connector: 'github',
      externalId: '88',
      externalUrl: null,
      sourceStatus: null,
      sourceSnapshot: null,
      lastSyncSnapshot: null,
      initialStatusSeeded: false,
      lastObservedAt: null,
      lastSyncedAt: null,
      missingAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    }],
    syncState: {
      status: 'idle',
      pending: 0,
      conflicts: 0,
      exhausted: 0,
      missing: false,
      lastSuccessAt: null,
      lastError: null,
    },
  });
  assert.deepEqual(service.list({ area: 'Ventures', ventureTag: 'Globex', source: 'github' }), [actual]);
  assert.deepEqual(service.list({ search: 'github#88' }), [actual]);
  assert.deepEqual(service.list({ search: 'details' }), [actual]);
});

test('rejects unknown update keys and normalizes optional strings', () => {
  const { service } = fixture();
  const task = service.create({
    title: 'Task',
    area: 'Personal',
    dueDate: '2026-09-12',
    recurrence: 'weekly',
    snoozedUntil: '2026-09-12T09:00:00Z',
  });

  assert.throws(
    () => service.update(task.id, { surprise: true }),
    error => error.code === 'UNKNOWN_PATCH_FIELD' && error.details.fields[0] === 'surprise',
  );
  const updated = service.update(task.id, {
    dueDate: null,
    description: '',
    recurrence: ' ',
    snoozedUntil: null,
  });
  assert.equal(updated.dueDate, null);
  assert.equal(updated.description, '');
  assert.equal(updated.recurrence, null);
  assert.equal(updated.snoozedUntil, null);
});

test('imports connector records idempotently while preserving normalized timestamps', () => {
  const { service, entries } = fixture();
  const input = {
    title: 'Imported history',
    area: 'Personal',
    status: 'done',
    createdAt: '2024-01-01T10:15:30Z',
    updatedAt: '2024-02-02T11:16:31.12Z',
    completedAt: '2024-02-02T11:16:31Z',
    archivedAt: '2024-03-03T12:17:32+00:00',
  };
  const meta = { source: 'fixture', externalId: 'record-1', sourceSnapshot: { id: 'record-1' } };

  const first = service.importRecord(input, meta, {
    actor: 'system', reason: 'connector sync', correlationId: 'sync-1',
  });
  const second = service.importRecord({ ...input, title: 'Changed retry' }, meta);

  assert.equal(second.id, first.id);
  assert.equal(second.title, 'Imported history');
  assert.equal(first.createdAt, '2024-01-01T10:15:30.000Z');
  assert.equal(first.updatedAt, '2024-02-02T11:16:31.120Z');
  assert.equal(first.completedAt, '2024-02-02T11:16:31.000Z');
  assert.equal(first.archivedAt, '2024-03-03T12:17:32.000Z');
  assert.equal(entries.filter(entry => entry.action === 'todo.import').length, 1);
});

test('archive, recycle-bin, restore, and purge preserve their lifecycle boundaries', () => {
  const { service } = fixture();
  const keep = service.create({ title: 'Keep', area: 'Personal' });
  const remove = service.create({ title: 'Remove', area: 'Personal' });

  service.archive(keep.id);
  assert.deepEqual(service.list().map(todo => todo.id), [remove.id]);
  assert.deepEqual(service.list({ includeArchived: true }).map(todo => todo.id).sort(), [keep.id, remove.id].sort());
  service.unarchive(keep.id);

  service.softDelete(remove.id);
  assert.deepEqual(service.list({ includeArchived: true }).map(todo => todo.id), [keep.id]);
  assert.deepEqual(service.list({ includeDeleted: true }).map(todo => todo.id), [remove.id]);
  service.restore(remove.id);
  service.softDelete(remove.id);
  assert.equal(service.purgeDeletedAfterBackup({ olderThan: '2026-09-11T12:00:01Z' }), 1);
  assert.equal(service.get(remove.id), null);
});

test('records each committed mutation with audit context and no rejected mutation', () => {
  const { db, entries, service } = fixture();
  const context = { actor: 'ethan', reason: 'captured from dashboard', correlationId: 'request-7' };
  const task = service.create({ title: 'Logged', area: 'Personal' }, context);

  assert.deepEqual(entries[0], {
    action: 'todo.create',
    actor: 'ethan',
    target: task.id,
    status: 'ok',
    summary: 'Created todo "Logged"',
    why: 'captured from dashboard',
    detail: { result: 'created' },
    correlationId: 'request-7',
  });
  assert.equal(db.prepare('SELECT title FROM todos WHERE id = ?').get(task.id).title, 'Logged');

  assert.throws(() => service.update(task.id, { invalid: true }, context));
  assert.equal(entries.length, 1);

  service.archive(task.id);
  assert.equal(entries[1].actor, 'unknown');
  assert.equal(entries[1].why, 'Archived todo "Logged"');
  assert.equal(typeof entries[1].correlationId, 'string');
  assert.notEqual(entries[1].correlationId, '');
});

test('requires an action-log sink', () => {
  const directory = mkdtempSync(join(tmpdir(), 'totem-todo-service-'));
  tempDirectories.push(directory);
  const db = openTodoDatabase({ file: join(directory, 'todos.db'), now: () => NOW });
  seedVentureTags(db);
  databases.push(db);

  assert.throws(
    () => createTodoService({ db }),
    /requires an actionLog with record\(\)/,
  );
  assert.throws(
    () => createTodoService({ db, actionLog: {} }),
    /requires an actionLog with record\(\)/,
  );
});

test('completing a local recurring task creates its next occurrence atomically', () => {
  const { service } = fixture();
  const task = service.create({
    title: 'Weekly review',
    description: 'Use the checklist',
    area: 'Personal',
    priority: 3,
    dueDate: '2026-09-11',
    recurrence: 'weekly',
    position: 8,
  });

  const completed = service.complete(task.id);

  assert.equal(completed.status, 'done');
  assert.equal(completed.completedAt, NOW);
  assert.deepEqual(
    service.list({ status: 'todo' }).map(({ title, description, priority, dueDate, recurrence, position }) => ({
      title, description, priority, dueDate, recurrence, position,
    })),
    [{
      title: 'Weekly review',
      description: 'Use the checklist',
      priority: 3,
      dueDate: '2026-09-18',
      recurrence: 'weekly',
      position: 8,
    }],
  );
});

test('a failed recurrence insert rolls back completion', () => {
  const { db, service } = fixture();
  const task = service.create({ title: 'Weekly review', area: 'Personal', dueDate: '2026-09-11', recurrence: 'weekly' });
  db.exec(`
    CREATE TRIGGER reject_generated_recurrence BEFORE INSERT ON todos
    WHEN NEW.id <> '${task.id}' BEGIN SELECT RAISE(ABORT, 'reject recurrence'); END
  `);

  assert.throws(() => service.complete(task.id), /reject recurrence/);
  assert.equal(service.get(task.id).status, 'todo');
});

test('external completion never generates a local recurrence', () => {
  const { service } = fixture();
  const task = service.create({ title: 'Source schedule', area: 'Personal', dueDate: '2026-09-11', recurrence: 'daily' });
  service.attachExternalLink(task.id, { connector: 'github', externalId: '99' });

  service.applyExternalObservation({ taskId: task.id, connector: 'github', completed: true });

  assert.equal(service.get(task.id).status, 'done');
  assert.equal(service.list({ status: 'todo' }).length, 0);
});

test('a locally completed task with any external link does not recur locally', () => {
  const { service } = fixture();
  const task = service.create({ title: 'Calendar schedule', area: 'Personal', dueDate: '2026-09-11', recurrence: 'daily' });
  service.attachExternalLink(task.id, { connector: 'calendar', externalId: 'event-99' });

  service.complete(task.id);

  assert.equal(service.get(task.id).status, 'done');
  assert.equal(service.list({ status: 'todo' }).length, 0);
});

test('rejects unsupported recurrence rules and recurrence without a due date', () => {
  const { service } = fixture();

  assert.throws(
    () => service.create({ title: 'Unscheduled', area: 'Personal', recurrence: 'weekly' }),
    error => error.code === 'RECURRENCE_REQUIRES_DUE_DATE',
  );
  assert.throws(
    () => service.create({ title: 'Invalid rule', area: 'Personal', dueDate: '2026-09-11', recurrence: 'sometimes' }),
    error => error.code === 'INVALID_RECURRENCE',
  );
});

test('notes are append-only and searchable while relations are symmetric', () => {
  const { db, service } = fixture();
  const a = service.create({ title: 'First', area: 'Personal' });
  const b = service.create({ title: 'Second', area: 'Personal' });

  const note = service.addNote(a.id, '  Call Jordan at 4  ');
  service.linkRelated(a.id, b.id);

  assert.equal(note.body, 'Call Jordan at 4');
  assert.equal(service.list({ search: 'jordan' })[0].id, a.id);
  assert.equal(service.get(a.id).relations[0].id, b.id);
  assert.equal(service.get(b.id).relations[0].id, a.id);
  assert.throws(() => db.prepare('UPDATE todo_notes SET body = ? WHERE id = ?').run('Changed', note.id), /append-only/);
  assert.throws(() => service.linkRelated(a.id, a.id), error => error.code === 'TODO_RELATION_SELF');

  service.unlinkRelated(b.id, a.id);
  assert.deepEqual(service.get(a.id).relations, []);
  assert.deepEqual(service.get(b.id).relations, []);
});

test('search includes tags, canonical GitHub references, and Sheet identifiers', () => {
  const { service } = fixture();
  const tagged = service.importRecord({
    title: 'Tagged task',
    area: 'Personal',
    tags: ['Errands'],
  }, { source: 'fixture', externalId: 'tagged' });
  const github = service.create({ title: 'Issue', area: 'Personal' });
  service.attachExternalLink(github.id, {
    connector: 'github',
    externalId: '90042',
    externalUrl: 'https://github.com/acme/acme/issues/42',
  });
  const sheet = service.create({ title: 'Shared', area: 'Personal' });
  service.attachExternalLink(sheet.id, { connector: 'sheet', externalId: 'sheet-row-314' });

  assert.deepEqual(service.list({ text: 'errands' }).map(todo => todo.id), [tagged.id]);
  assert.deepEqual(service.list({ search: 'acme/acme#42' }).map(todo => todo.id), [github.id]);
  assert.deepEqual(service.list({ search: 'sheet-row-314' }).map(todo => todo.id), [sheet.id]);
});

test('snooze and lifecycle filters select explicit states', () => {
  const { service } = fixture();
  const active = service.create({ title: 'Active', area: 'Personal', dueDate: '2026-09-15' });
  const snoozed = service.create({ title: 'Snoozed', area: 'Personal', dueDate: '2026-09-16' });
  const archived = service.create({ title: 'Archived', area: 'Personal' });
  const deleted = service.create({ title: 'Deleted', area: 'Personal' });
  service.snooze(snoozed.id, '2026-09-12T09:00:00Z');
  service.archive(archived.id);
  service.softDelete(deleted.id);

  assert.equal(service.get(snoozed.id).snoozedUntil, '2026-09-12T09:00:00.000Z');
  assert.deepEqual(service.list({ snoozed: true }).map(todo => todo.id), [snoozed.id]);
  assert.deepEqual(service.list({ snoozed: false, due: '2026-09-15' }).map(todo => todo.id), [active.id]);
  assert.deepEqual(service.list({ archived: true }).map(todo => todo.id), [archived.id]);
  assert.deepEqual(service.list({ deleted: true }).map(todo => todo.id), [deleted.id]);
});

test('expired and boundary snoozes return to the unsnoozed query', () => {
  const { service } = fixture();
  const active = service.create({ title: 'Never snoozed', area: 'Personal', position: 1 });
  const expired = service.create({
    title: 'Expired', area: 'Personal', snoozedUntil: '2026-09-11T11:59:59.999Z', position: 2,
  });
  const boundary = service.create({
    title: 'Boundary', area: 'Personal', snoozedUntil: NOW, position: 3,
  });
  const future = service.create({
    title: 'Future', area: 'Personal', snoozedUntil: '2026-09-11T12:00:00.001Z', position: 4,
  });

  assert.deepEqual(service.list({ snoozed: true }).map(todo => todo.id), [future.id]);
  assert.deepEqual(service.list({ snoozed: false }).map(todo => todo.id), [active.id, expired.id, boundary.id]);
});

test('reorder changes only the selected status and alternate sorts preserve manual positions', () => {
  const { service } = fixture();
  const a = service.create({ title: 'A', area: 'Personal', priority: 1, dueDate: null, position: 10 });
  const b = service.create({ title: 'B', area: 'Personal', priority: 4, dueDate: '2026-09-20', position: 20 });
  const doing = service.create({ title: 'Doing', area: 'Personal', status: 'doing', position: 7 });

  service.reorder({ status: 'todo', orderedIds: [b.id, a.id] });

  assert.deepEqual(service.list({ status: 'todo' }).map(todo => todo.id), [b.id, a.id]);
  const positions = Object.fromEntries(service.list({ status: 'todo', sort: 'priority' }).map(todo => [todo.id, todo.position]));
  assert.deepEqual(positions, { [b.id]: 0, [a.id]: 1 });
  assert.equal(service.get(doing.id).position, 7);
  assert.deepEqual(service.list({ status: 'todo', sort: 'due' }).map(todo => todo.id), [b.id, a.id]);
});

test('bulk authorizes every selected task before mutating any task', () => {
  const { service } = fixture();
  const local = service.create({ title: 'Local', area: 'Personal' });
  const sourceOwned = service.create({ title: 'Sheet', area: 'Personal' });
  service.attachExternalLink(sourceOwned.id, { connector: 'sheet', externalId: 'sheet-1' });

  assert.throws(
    () => service.bulk({ ids: [local.id, sourceOwned.id], operation: 'move', value: 'done' }),
    error => error.code === 'SOURCE_OWNS_COMPLETION',
  );
  assert.equal(service.get(local.id).status, 'todo');
  assert.equal(service.get(sourceOwned.id).status, 'todo');

  service.bulk({ ids: [local.id, sourceOwned.id], operation: 'priority', value: 4 });
  assert.equal(service.get(local.id).priority, 4);
  assert.equal(service.get(sourceOwned.id).priority, 4);
});

test('bulk tags use partial-add and all-remove semantics', () => {
  const { service } = fixture();
  const a = service.create({ title: 'A', area: 'Personal' });
  const b = service.create({ title: 'B', area: 'Personal' });

  service.bulk({ ids: [a.id], operation: 'addTag', value: 'Home' });
  service.bulk({ ids: [a.id, b.id], operation: 'addTag', value: 'Home' });
  assert.deepEqual(service.get(a.id).tags.map(tag => tag.name), ['Home']);
  assert.deepEqual(service.get(b.id).tags.map(tag => tag.name), ['Home']);

  service.bulk({ ids: [a.id, b.id], operation: 'removeTag', value: 'home' });
  assert.deepEqual(service.get(a.id).tags, []);
  assert.deepEqual(service.get(b.id).tags, []);
});

test('archiveCompleted archives only eligible completed tasks and preferences persist', () => {
  const { db, service } = fixture();
  const oldDone = service.importRecord({
    title: 'Old done', area: 'Personal', status: 'done', completedAt: '2026-08-01T12:00:00.000Z',
  }, { source: 'fixture', externalId: 'old-done' });
  const recentDone = service.importRecord({
    title: 'Recent done', area: 'Personal', status: 'done', completedAt: '2026-09-10T12:00:00.000Z',
  }, { source: 'fixture', externalId: 'recent-done' });

  assert.equal(service.archiveCompleted({ olderThan: '2026-09-01T00:00:00Z' }), 1);
  assert.equal(service.get(oldDone.id).archivedAt, NOW);
  assert.equal(service.get(recentDone.id).archivedAt, null);

  assert.deepEqual(service.getPreferences(), { autoArchiveDays: null, autoArchiveAt: '18:00', recyclePurgeDays: null });
  service.updatePreferences({ autoArchiveDays: 30, autoArchiveAt: '18:00', recyclePurgeDays: 14 });
  const reopened = createTodoService({ db, now: () => NOW, actionLog: { record() {} } });
  assert.deepEqual(reopened.getPreferences(), { autoArchiveDays: 30, autoArchiveAt: '18:00', recyclePurgeDays: 14 });
  assert.throws(
    () => service.updatePreferences({ reminders: true }),
    error => error.code === 'UNKNOWN_PREFERENCE',
  );
});

test('a task can end as not doing: it finishes, says so, and does not recur', () => {
  const { service, entries } = fixture();
  const task = service.create({ title: 'Read the whole changelog', area: 'Personal' });

  const abandoned = service.abandon(task.id);
  assert.equal(abandoned.status, 'done');
  assert.equal(abandoned.outcome, 'not_doing');
  assert.equal(abandoned.completedAt, NOW);
  assert.match(entries.at(-1).summary, /not doing/i);

  // It sits with the finished work, and can be told apart from it.
  assert.deepEqual(service.list({ status: 'done' }).map(item => item.id), [task.id]);
  assert.deepEqual(service.list({ outcome: 'not_doing' }).map(item => item.id), [task.id]);
  assert.deepEqual(service.list({ outcome: 'completed' }), []);
});

test('completing normally records the completed outcome, and reopening clears it', () => {
  const { service } = fixture();
  const task = service.create({ title: 'Send the invoice', area: 'Personal' });

  assert.equal(service.complete(task.id).outcome, 'completed');
  const reopened = service.move(task.id, 'todo');
  assert.equal(reopened.outcome, null);
  assert.equal(reopened.completedAt, null);

  // Abandoning and then changing your mind leaves no trace of the abandonment.
  service.abandon(task.id);
  assert.equal(service.move(task.id, 'doing').outcome, null);
});

test('abandoning a repeating task ends the series instead of rolling it forward', () => {
  const { service } = fixture();
  const repeating = service.create({
    title: 'Weekly review', area: 'Personal', dueDate: '2026-09-11', recurrence: 'weekly',
  });

  service.abandon(repeating.id);
  assert.deepEqual(service.list({ status: 'todo' }), []);

  const kept = service.create({
    title: 'Weekly tidy', area: 'Personal', dueDate: '2026-09-11', recurrence: 'weekly',
  });
  service.complete(kept.id);
  assert.deepEqual(service.list({ status: 'todo' }).map(item => item.dueDate), ['2026-09-18']);
});

test('an outcome belongs to a finished task only', () => {
  const { service } = fixture();
  const task = service.create({ title: 'Book the flights', area: 'Personal' });

  assert.throws(
    () => service.move(task.id, 'doing', undefined, { outcome: 'not_doing' }),
    error => error.code === 'INVALID_OUTCOME',
  );
  assert.throws(
    () => service.move(task.id, 'done', undefined, { outcome: 'maybe' }),
    error => error.code === 'INVALID_OUTCOME',
  );
});

test('bulk notDoing ends a selection without claiming the work happened', () => {
  const { service } = fixture();
  const first = service.create({ title: 'Rewrite the deck', area: 'Personal' });
  const second = service.create({ title: 'Chase the quote', area: 'Personal' });

  const results = service.bulk({ ids: [first.id, second.id], operation: 'notDoing' });
  assert.deepEqual(results.map(item => [item.status, item.outcome]), [['done', 'not_doing'], ['done', 'not_doing']]);
});

test('the archive time preference only accepts a 24-hour clock', () => {
  const { service } = fixture();
  service.updatePreferences({ autoArchiveAt: '18:00' });
  assert.equal(service.getPreferences().autoArchiveAt, '18:00');
  service.updatePreferences({ autoArchiveAt: null });
  assert.equal(service.getPreferences().autoArchiveAt, null);
  for (const bad of ['6pm', '24:00', '18:60', '8:00']) {
    assert.throws(
      () => service.updatePreferences({ autoArchiveAt: bad }),
      error => error.code === 'INVALID_PREFERENCE',
      `expected ${bad} to be rejected`,
    );
  }
});
