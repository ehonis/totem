import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { Worker } from 'node:worker_threads';

import {
  backupTodoDatabase,
  closeTodoDatabase,
  exportTodoDatabase,
  openTodoDatabase,
  restoreTodoDatabase,
  withTodoTransaction,
} from './db.mjs';

const TABLES = [
  'connector_state',
  'external_links',
  'goal_links',
  'goal_metrics',
  'goals',
  'list_items',
  'list_todos',
  'lists',
  'schema_migrations',
  'sync_outbox',
  'tags',
  'todo_import_keys',
  'todo_notes',
  'todo_preferences',
  'todo_relations',
  'todo_tags',
  'todos',
];

const TABLE_ORDERS = {
  connector_state: 'connector',
  external_links: 'id',
  goal_links: 'id',
  list_items: 'list_id, position, id',
  list_todos: 'list_id, todo_id',
  lists: 'position, id',
  // Both goal tables self-reference, so the export order has to put a row after the row
  // it points at — see the note on TABLES in db.mjs.
  goal_metrics: 'rolls_up_to_metric_id IS NOT NULL, position, id',
  goals: 'parent_id IS NOT NULL, position, id',
  schema_migrations: 'version',
  sync_outbox: 'id',
  tags: 'id',
  todo_import_keys: 'source, external_id',
  todo_notes: 'id',
  todo_preferences: 'key',
  todo_relations: 'left_todo_id, right_todo_id',
  todo_tags: 'todo_id, tag_id',
  todos: 'id',
};

const FIXTURE_AT = '2026-09-11T12:00:00.000Z';
const FIXTURE_LATER = '2026-09-11T13:00:00.000Z';

const tempDirectories = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempFile(name = 'todos.db') {
  const directory = mkdtempSync(join(tmpdir(), 'totem-todos-db-'));
  tempDirectories.push(directory);
  return join(directory, name);
}

function insertTodo(db, {
  id = 'todo-1',
  title = 'A task',
  area = 'Personal',
  ventureTag = null,
  status = 'todo',
  priority = 1,
} = {}) {
  db.prepare(`
    INSERT INTO todos (
      id, title, area, venture_tag, status, priority, position, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    title,
    area,
    ventureTag,
    status,
    priority,
    0,
    '2026-09-11T12:00:00.000Z',
    '2026-09-11T12:00:00.000Z',
  );
}

function seedCompleteSnapshot(db) {
  insertTodo(db, { id: 'todo-c', title: 'Third' });
  insertTodo(db, { id: 'todo-a', title: 'First' });
  insertTodo(db, { id: 'todo-b', title: 'Second' });
  db.prepare('INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)')
    .run('tag-z', 'Zebra', FIXTURE_AT);
  db.prepare('INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)')
    .run('tag-a', 'Alpha', FIXTURE_AT);
  db.prepare('INSERT INTO todo_tags (todo_id, tag_id, created_at) VALUES (?, ?, ?)')
    .run('todo-b', 'tag-z', FIXTURE_AT);
  db.prepare('INSERT INTO todo_tags (todo_id, tag_id, created_at) VALUES (?, ?, ?)')
    .run('todo-a', 'tag-a', FIXTURE_AT);
  db.prepare('INSERT INTO todo_notes (id, todo_id, body, created_at) VALUES (?, ?, ?, ?)')
    .run('note-z', 'todo-b', 'Later note', FIXTURE_LATER);
  db.prepare('INSERT INTO todo_notes (id, todo_id, body, created_at) VALUES (?, ?, ?, ?)')
    .run('note-a', 'todo-a', 'First note', FIXTURE_AT);
  db.prepare(`
    INSERT INTO todo_relations (left_todo_id, right_todo_id, created_at)
    VALUES (?, ?, ?)
  `).run('todo-b', 'todo-c', FIXTURE_LATER);
  db.prepare(`
    INSERT INTO todo_relations (left_todo_id, right_todo_id, created_at)
    VALUES (?, ?, ?)
  `).run('todo-a', 'todo-c', FIXTURE_AT);
  db.prepare(`
    INSERT INTO external_links (
      id, todo_id, connector, external_id, external_url, source_status,
      source_snapshot, last_sync_snapshot, last_observed_at, last_synced_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'link-z', 'todo-b', 'sheet', 'sheet-z', 'https://example.test/sheet-z',
    'In Progress', '{"status":"In Progress"}', '{"title":"Second"}',
    FIXTURE_LATER, FIXTURE_LATER, FIXTURE_AT, FIXTURE_LATER,
  );
  db.prepare(`
    INSERT INTO external_links (
      id, todo_id, connector, external_id, external_url, source_status,
      source_snapshot, last_sync_snapshot, last_observed_at, last_synced_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'link-a', 'todo-a', 'github', '101', 'https://example.test/issues/101',
    'open', '{"state":"open"}', '{"title":"First"}',
    FIXTURE_AT, FIXTURE_AT, FIXTURE_AT, FIXTURE_AT,
  );
  db.prepare(`
    INSERT INTO sync_outbox (
      id, todo_id, connector, operation, payload, idempotency_key, status,
      attempts, next_attempt_at, lease_owner, lease_expires_at, last_error,
      conflict_payload, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'outbox-z', 'todo-b', 'sheet', 'update', '{"title":"Second"}', 'sheet-update-z',
    'retry', 2, FIXTURE_LATER, null, null, 'timeout', null,
    FIXTURE_AT, FIXTURE_LATER, null,
  );
  db.prepare(`
    INSERT INTO sync_outbox (
      id, todo_id, connector, operation, payload, idempotency_key,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'outbox-a', 'todo-a', 'github', 'rename', '{"title":"First"}',
    'github-rename-a', FIXTURE_AT, FIXTURE_AT,
  );
  db.prepare(`
    INSERT INTO connector_state (
      connector, cursor, watermark, settings_json, last_success_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('sheet', 'cursor-z', FIXTURE_LATER, '{"enabled":true}', FIXTURE_LATER, FIXTURE_AT, FIXTURE_LATER);
  db.prepare(`
    INSERT INTO connector_state (
      connector, cursor, watermark, settings_json, last_success_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('github', 'cursor-a', FIXTURE_AT, '{"enabled":true}', FIXTURE_AT, FIXTURE_AT, FIXTURE_AT);
  db.prepare('INSERT INTO todo_preferences (key, value_json, updated_at) VALUES (?, ?, ?)')
    .run('sort-z', '"manual"', FIXTURE_LATER);
  db.prepare('INSERT INTO todo_preferences (key, value_json, updated_at) VALUES (?, ?, ?)')
    .run('archive-a', '30', FIXTURE_AT);
  db.prepare(`
    INSERT INTO todo_import_keys (
      source, external_id, todo_id, source_snapshot, imported_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run('todoist', 'z', 'todo-b', '{"content":"Second"}', FIXTURE_LATER);
  db.prepare(`
    INSERT INTO todo_import_keys (
      source, external_id, todo_id, source_snapshot, imported_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run('todoist', 'a', 'todo-a', '{"content":"First"}', FIXTURE_AT);
}

function expectedCompleteSnapshot() {
  const todo = (id, title) => ({
    id,
    title,
    description: '',
    area: 'Personal',
    venture_tag: null,
    status: 'todo',
    priority: 1,
    due_date: null,
    recurrence: null,
    snoozed_until: null,
    position: 0,
    created_at: FIXTURE_AT,
    updated_at: FIXTURE_AT,
    completed_at: null,
    archived_at: null,
    deleted_at: null,
    outcome: null,
  });
  return {
    formatVersion: 3,
    connector_state: [
      {
        connector: 'github', cursor: 'cursor-a', watermark: FIXTURE_AT,
        settings_json: '{"enabled":true}', lease_owner: null, lease_expires_at: null,
        last_success_at: FIXTURE_AT, last_error: null,
        created_at: FIXTURE_AT, updated_at: FIXTURE_AT,
      },
      {
        connector: 'sheet', cursor: 'cursor-z', watermark: FIXTURE_LATER,
        settings_json: '{"enabled":true}', lease_owner: null, lease_expires_at: null,
        last_success_at: FIXTURE_LATER, last_error: null,
        created_at: FIXTURE_AT, updated_at: FIXTURE_LATER,
      },
    ],
    external_links: [
      {
        id: 'link-a', todo_id: 'todo-a', connector: 'github', external_id: '101',
        external_url: 'https://example.test/issues/101', source_status: 'open',
        source_snapshot: '{"state":"open"}', last_sync_snapshot: '{"title":"First"}',
        initial_status_seeded: 0, last_observed_at: FIXTURE_AT,
        last_synced_at: FIXTURE_AT, missing_at: null,
        created_at: FIXTURE_AT, updated_at: FIXTURE_AT,
      },
      {
        id: 'link-z', todo_id: 'todo-b', connector: 'sheet', external_id: 'sheet-z',
        external_url: 'https://example.test/sheet-z', source_status: 'In Progress',
        source_snapshot: '{"status":"In Progress"}', last_sync_snapshot: '{"title":"Second"}',
        initial_status_seeded: 0, last_observed_at: FIXTURE_LATER,
        last_synced_at: FIXTURE_LATER, missing_at: null,
        created_at: FIXTURE_AT, updated_at: FIXTURE_LATER,
      },
    ],
    goal_links: [],
    goal_metrics: [],
    goals: [],
    list_items: [],
    list_todos: [],
    lists: [],
    schema_migrations: [
      { version: 1, applied_at: FIXTURE_AT },
      { version: 2, applied_at: FIXTURE_AT },
      { version: 3, applied_at: FIXTURE_AT },
      { version: 4, applied_at: FIXTURE_AT },
      { version: 5, applied_at: FIXTURE_AT },
      { version: 6, applied_at: FIXTURE_AT },
      { version: 7, applied_at: FIXTURE_AT },
      { version: 8, applied_at: FIXTURE_AT },
    ],
    sync_outbox: [
      {
        id: 'outbox-a', todo_id: 'todo-a', connector: 'github', operation: 'rename',
        payload: '{"title":"First"}', idempotency_key: 'github-rename-a', status: 'pending',
        attempts: 0, next_attempt_at: null, lease_owner: null, lease_expires_at: null,
        last_error: null, conflict_payload: null, created_at: FIXTURE_AT,
        updated_at: FIXTURE_AT, completed_at: null,
      },
      {
        id: 'outbox-z', todo_id: 'todo-b', connector: 'sheet', operation: 'update',
        payload: '{"title":"Second"}', idempotency_key: 'sheet-update-z', status: 'retry',
        attempts: 2, next_attempt_at: FIXTURE_LATER, lease_owner: null, lease_expires_at: null,
        last_error: 'timeout', conflict_payload: null, created_at: FIXTURE_AT,
        updated_at: FIXTURE_LATER, completed_at: null,
      },
    ],
    tags: [
      { id: 'tag-a', name: 'Alpha', created_at: FIXTURE_AT },
      { id: 'tag-z', name: 'Zebra', created_at: FIXTURE_AT },
    ],
    todo_import_keys: [
      {
        source: 'todoist', external_id: 'a', todo_id: 'todo-a',
        source_snapshot: '{"content":"First"}', imported_at: FIXTURE_AT,
      },
      {
        source: 'todoist', external_id: 'z', todo_id: 'todo-b',
        source_snapshot: '{"content":"Second"}', imported_at: FIXTURE_LATER,
      },
    ],
    todo_notes: [
      { id: 'note-a', todo_id: 'todo-a', body: 'First note', created_at: FIXTURE_AT },
      { id: 'note-z', todo_id: 'todo-b', body: 'Later note', created_at: FIXTURE_LATER },
    ],
    todo_preferences: [
      { key: 'archive-a', value_json: '30', updated_at: FIXTURE_AT },
      { key: 'sort-z', value_json: '"manual"', updated_at: FIXTURE_LATER },
    ],
    todo_relations: [
      { left_todo_id: 'todo-a', right_todo_id: 'todo-c', created_at: FIXTURE_AT },
      { left_todo_id: 'todo-b', right_todo_id: 'todo-c', created_at: FIXTURE_LATER },
    ],
    todo_tags: [
      { todo_id: 'todo-a', tag_id: 'tag-a', created_at: FIXTURE_AT },
      { todo_id: 'todo-b', tag_id: 'tag-z', created_at: FIXTURE_AT },
    ],
    todos: [todo('todo-a', 'First'), todo('todo-b', 'Second'), todo('todo-c', 'Third')],
  };
}

function plainRows(db, table) {
  return db.prepare(`SELECT * FROM ${table} ORDER BY ${TABLE_ORDERS[table]}`)
    .all().map(row => ({ ...row }));
}

async function concurrentlyOpenDatabase(file, workerCount = 16) {
  const gateBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const gate = new Int32Array(gateBuffer);
  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { closeTodoDatabase, openTodoDatabase } = await import(workerData.moduleUrl);
      parentPort.postMessage({ type: 'ready' });
      Atomics.wait(new Int32Array(workerData.gateBuffer), 0, 0);
      try {
        const db = openTodoDatabase({ file: workerData.file });
        closeTodoDatabase(db);
        parentPort.postMessage({ type: 'done', ok: true });
      } catch (error) {
        parentPort.postMessage({ type: 'done', ok: false, error: error.stack });
      } finally {
        parentPort.close();
      }
    })();
  `;
  const workers = Array.from({ length: workerCount }, () => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: {
        file,
        gateBuffer,
        moduleUrl: new URL('./db.mjs', import.meta.url).href,
      },
    });
    let markReady;
    let markDone;
    let fail;
    const ready = new Promise(resolve => { markReady = resolve; });
    const done = new Promise((resolve, reject) => {
      markDone = resolve;
      fail = reject;
    });
    worker.on('message', message => {
      if (message.type === 'ready') markReady();
      if (message.type === 'done') markDone(message);
    });
    worker.on('error', fail);
    return { ready, done };
  });

  await Promise.all(workers.map(worker => worker.ready));
  Atomics.store(gate, 0, 1);
  Atomics.notify(gate, 0, workerCount);
  return Promise.all(workers.map(worker => worker.done));
}

test('migrates an empty database once and enables WAL and foreign keys', () => {
  const dbFile = tempFile();
  const db = openTodoDatabase({
    file: dbFile,
    now: () => '2026-09-11T12:00:00.000Z',
  });

  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.deepEqual(
    db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
      .map(({ version }) => version),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.deepEqual(
    db.prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map(({ name }) => name),
    TABLES,
  );
  closeTodoDatabase(db);

  const reopened = openTodoDatabase({ file: dbFile });
  assert.equal(reopened.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, 8);
  closeTodoDatabase(reopened);
});

test('concurrent openers serialize migration checks and apply each version once', async () => {
  const dbFile = tempFile();

  const results = await concurrentlyOpenDatabase(dbFile);

  assert.deepEqual(results, Array.from({ length: 16 }, () => ({ type: 'done', ok: true })));
  const db = openTodoDatabase({ file: dbFile });
  assert.deepEqual(
    db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
      .map(({ version }) => version),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  closeTodoDatabase(db);
});

test('terminally exhausted outbox work is valid and remains unleased', () => {
  const db = openTodoDatabase({ file: tempFile(), now: () => FIXTURE_AT });
  insertTodo(db);

  db.prepare(`
    INSERT INTO sync_outbox (
      id, todo_id, connector, operation, payload, idempotency_key, status,
      attempts, lease_owner, lease_expires_at, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'exhausted', ?, NULL, NULL, ?, ?, ?)
  `).run(
    'outbox-exhausted', 'todo-1', 'github', 'rename', '{}', 'rename-exhausted',
    5, 'rate limited', FIXTURE_AT, FIXTURE_AT,
  );

  assert.deepEqual(
    { ...db.prepare(`
      SELECT status, attempts, lease_owner, lease_expires_at, last_error
      FROM sync_outbox WHERE id = 'outbox-exhausted'
    `).get() },
    {
      status: 'exhausted',
      attempts: 5,
      lease_owner: null,
      lease_expires_at: null,
      last_error: 'rate limited',
    },
  );
  closeTodoDatabase(db);
});

test('enforces canonical todo classification and unique external identities', () => {
  const db = openTodoDatabase({ file: tempFile() });

  assert.throws(() => insertTodo(db, { area: 'Work' }), /area/i);
  assert.throws(() => insertTodo(db, { status: 'blocked' }), /status/i);
  assert.throws(() => insertTodo(db, { priority: 5 }), /priority/i);
  assert.throws(
    () => insertTodo(db, { area: 'Ventures', ventureTag: null }),
    /venture/i,
  );
  assert.throws(
    () => insertTodo(db, { area: 'Personal', ventureTag: 'Initech' }),
    /venture/i,
  );
  insertTodo(db, { id: 'todo-1' });
  insertTodo(db, { id: 'todo-2' });
  const insertLink = db.prepare(`
    INSERT INTO external_links (
      id, todo_id, connector, external_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertLink.run(
    'link-1',
    'todo-1',
    'github',
    '42',
    '2026-09-11T12:00:00.000Z',
    '2026-09-11T12:00:00.000Z',
  );

  assert.throws(() => insertLink.run(
    'link-2',
    'todo-2',
    'github',
    '42',
    '2026-09-11T12:00:00.000Z',
    '2026-09-11T12:00:00.000Z',
  ), /unique/i);
  closeTodoDatabase(db);
});

test('rejects malformed dates and non-UTC timestamps across the schema', () => {
  const db = openTodoDatabase({ file: tempFile() });
  const at = '2026-09-11T12:00:00.000Z';
  insertTodo(db, { id: 'todo-a' });
  insertTodo(db, { id: 'todo-b' });
  db.prepare('INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)')
    .run('tag-a', 'Alpha', at);
  db.prepare('INSERT INTO todo_tags (todo_id, tag_id, created_at) VALUES (?, ?, ?)')
    .run('todo-a', 'tag-a', at);
  db.prepare('INSERT INTO todo_notes (id, todo_id, body, created_at) VALUES (?, ?, ?, ?)')
    .run('note-a', 'todo-a', 'A note', at);
  db.prepare(`
    INSERT INTO todo_relations (left_todo_id, right_todo_id, created_at)
    VALUES (?, ?, ?)
  `).run('todo-a', 'todo-b', at);
  db.prepare(`
    INSERT INTO external_links (
      id, todo_id, connector, external_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run('link-a', 'todo-a', 'github', '101', at, at);
  db.prepare(`
    INSERT INTO sync_outbox (
      id, todo_id, connector, operation, payload, idempotency_key, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('outbox-a', 'todo-a', 'github', 'rename', '{}', 'rename-a', at, at);
  db.prepare(`
    INSERT INTO connector_state (connector, created_at, updated_at)
    VALUES (?, ?, ?)
  `).run('github', at, at);
  db.prepare(`
    INSERT INTO todo_preferences (key, value_json, updated_at) VALUES (?, ?, ?)
  `).run('auto-archive', '30', at);
  db.prepare(`
    INSERT INTO todo_import_keys (source, external_id, todo_id, imported_at)
    VALUES (?, ?, ?, ?)
  `).run('todoist', 'legacy-a', 'todo-a', at);

  for (const invalid of ['2026-9-1', '2026-02-30', 'not-a-date']) {
    assert.throws(
      () => db.prepare('UPDATE todos SET due_date = ? WHERE id = ?').run(invalid, 'todo-a'),
      /date/i,
    );
  }

  const timestampColumns = [
    ['schema_migrations', 'applied_at', 'version = 1'],
    ['todos', 'snoozed_until', "id = 'todo-a'"],
    ['todos', 'created_at', "id = 'todo-a'"],
    ['todos', 'updated_at', "id = 'todo-a'"],
    ['todos', 'completed_at', "id = 'todo-a'"],
    ['todos', 'archived_at', "id = 'todo-a'"],
    ['todos', 'deleted_at', "id = 'todo-a'"],
    ['tags', 'created_at', "id = 'tag-a'"],
    ['todo_tags', 'created_at', "todo_id = 'todo-a' AND tag_id = 'tag-a'"],
    ['todo_relations', 'created_at', "left_todo_id = 'todo-a'"],
    ['external_links', 'last_observed_at', "id = 'link-a'"],
    ['external_links', 'last_synced_at', "id = 'link-a'"],
    ['external_links', 'missing_at', "id = 'link-a'"],
    ['external_links', 'created_at', "id = 'link-a'"],
    ['external_links', 'updated_at', "id = 'link-a'"],
    ['sync_outbox', 'next_attempt_at', "id = 'outbox-a'"],
    ['sync_outbox', 'lease_expires_at', "id = 'outbox-a'"],
    ['sync_outbox', 'created_at', "id = 'outbox-a'"],
    ['sync_outbox', 'updated_at', "id = 'outbox-a'"],
    ['sync_outbox', 'completed_at', "id = 'outbox-a'"],
    ['connector_state', 'watermark', "connector = 'github'"],
    ['connector_state', 'lease_expires_at', "connector = 'github'"],
    ['connector_state', 'last_success_at', "connector = 'github'"],
    ['connector_state', 'created_at', "connector = 'github'"],
    ['connector_state', 'updated_at', "connector = 'github'"],
    ['todo_preferences', 'updated_at', "key = 'auto-archive'"],
    ['todo_import_keys', 'imported_at', "source = 'todoist' AND external_id = 'legacy-a'"],
  ];
  for (const [table, column, predicate] of timestampColumns) {
    const statement = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${predicate}`);
    for (const invalid of [
      '2026-09-11T08:00:00.000-04:00',
      '2026-09-11T12:00:00.000',
      'not-a-timestamp',
    ]) {
      assert.throws(() => statement.run(invalid), /timestamp/i, `${table}.${column}`);
    }
  }
  for (const [index, invalid] of [
    '2026-09-11T08:00:00.000-04:00',
    '2026-09-11T12:00:00.000',
    'not-a-timestamp',
  ].entries()) {
    assert.throws(() => db.prepare(`
      INSERT INTO todo_notes (id, todo_id, body, created_at) VALUES (?, ?, ?, ?)
    `).run(`bad-note-${index}`, 'todo-a', 'Bad time', invalid), /timestamp/i);
  }
  closeTodoDatabase(db);
});

test('rejects out-of-range date and time fields while accepting leap and boundary values', () => {
  const db = openTodoDatabase({
    file: tempFile(),
    now: () => FIXTURE_AT,
  });
  insertTodo(db, { id: 'todo-a' });
  db.prepare(`
    INSERT INTO external_links (
      id, todo_id, connector, external_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run('link-a', 'todo-a', 'github', '101', FIXTURE_AT, FIXTURE_AT);

  for (const invalid of ['2026-00-01', '2026-13-01', '2026-04-31']) {
    assert.throws(
      () => db.prepare('UPDATE todos SET due_date = ? WHERE id = ?').run(invalid, 'todo-a'),
      /date/i,
      invalid,
    );
  }
  for (const valid of ['2024-02-29', '2026-01-01', '2026-12-31']) {
    db.prepare('UPDATE todos SET due_date = ? WHERE id = ?').run(valid, 'todo-a');
    assert.equal(db.prepare("SELECT due_date FROM todos WHERE id = 'todo-a'").get().due_date, valid);
  }

  const representativeTimestampUpdates = [
    ['schema_migrations', 'applied_at', 'version = 1'],
    ['todos', 'updated_at', "id = 'todo-a'"],
    ['external_links', 'last_observed_at', "id = 'link-a'"],
  ];
  const invalidTimestamps = [
    '2026-13-01T12:00:00.000Z',
    '2026-04-31T12:00:00.000Z',
    '2026-09-11T25:00:00.000Z',
    '2026-09-11T12:60:00.000Z',
    '2026-09-11T12:00:60.000Z',
  ];
  for (const [table, column, predicate] of representativeTimestampUpdates) {
    const statement = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${predicate}`);
    for (const invalid of invalidTimestamps) {
      assert.throws(() => statement.run(invalid), /timestamp/i, `${table}.${column}: ${invalid}`);
    }
  }
  for (const [index, invalid] of invalidTimestamps.entries()) {
    assert.throws(() => db.prepare(`
      INSERT INTO todo_notes (id, todo_id, body, created_at) VALUES (?, ?, ?, ?)
    `).run(`range-note-${index}`, 'todo-a', 'Invalid range', invalid), /timestamp/i, invalid);
  }

  for (const valid of [
    '2024-02-29T23:59:59.999Z',
    '2026-01-01T00:00:00.000Z',
    '2026-12-31T23:59:59.999Z',
  ]) {
    db.prepare("UPDATE todos SET updated_at = ? WHERE id = 'todo-a'").run(valid);
    db.prepare("UPDATE external_links SET last_observed_at = ? WHERE id = 'link-a'").run(valid);
  }
  assert.equal(
    db.prepare("SELECT updated_at FROM todos WHERE id = 'todo-a'").get().updated_at,
    '2026-12-31T23:59:59.999Z',
  );
  assert.equal(
    db.prepare("SELECT last_observed_at FROM external_links WHERE id = 'link-a'").get()
      .last_observed_at,
    '2026-12-31T23:59:59.999Z',
  );
  db.prepare('UPDATE schema_migrations SET applied_at = ? WHERE version = 1')
    .run('2024-02-29T23:59:59.999Z');
  db.prepare(`
    INSERT INTO todo_notes (id, todo_id, body, created_at) VALUES (?, ?, ?, ?)
  `).run('leap-note', 'todo-a', 'Valid leap instant', '2024-02-29T23:59:59.999Z');
  assert.equal(
    db.prepare("SELECT created_at FROM todo_notes WHERE id = 'leap-note'").get().created_at,
    '2024-02-29T23:59:59.999Z',
  );
  assert.equal(
    db.prepare('SELECT applied_at FROM schema_migrations WHERE version = 1').get().applied_at,
    '2024-02-29T23:59:59.999Z',
  );
  closeTodoDatabase(db);
});

test('keeps notes append-only and stores each undirected relation once', () => {
  const db = openTodoDatabase({ file: tempFile() });
  insertTodo(db, { id: 'todo-a' });
  insertTodo(db, { id: 'todo-b' });
  db.prepare(`
    INSERT INTO todo_notes (id, todo_id, body, created_at)
    VALUES (?, ?, ?, ?)
  `).run('note-1', 'todo-a', 'Original', '2026-09-11T12:00:00.000Z');

  assert.throws(
    () => db.prepare("UPDATE todo_notes SET body = 'Changed' WHERE id = 'note-1'").run(),
    /append-only/i,
  );
  assert.throws(
    () => db.prepare("DELETE FROM todo_notes WHERE id = 'note-1'").run(),
    /append-only/i,
  );

  const insertRelation = db.prepare(`
    INSERT INTO todo_relations (left_todo_id, right_todo_id, created_at)
    VALUES (?, ?, ?)
  `);
  insertRelation.run('todo-a', 'todo-b', '2026-09-11T12:00:00.000Z');
  assert.throws(
    () => insertRelation.run('todo-a', 'todo-b', '2026-09-11T12:00:00.000Z'),
    /unique/i,
  );
  assert.throws(
    () => insertRelation.run('todo-b', 'todo-a', '2026-09-11T12:00:00.000Z'),
    /relation/i,
  );
  closeTodoDatabase(db);
});

test('commits a successful transaction and returns its value', () => {
  const db = openTodoDatabase({ file: tempFile() });

  const result = withTodoTransaction(db, () => {
    insertTodo(db, { id: 'committed' });
    return 'saved';
  });

  assert.equal(result, 'saved');
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM todos WHERE id = 'committed'").get().n,
    1,
  );
  closeTodoDatabase(db);
});

test('rolls back every write when a transaction fails', () => {
  const db = openTodoDatabase({ file: tempFile() });

  assert.throws(() => withTodoTransaction(db, () => {
    insertTodo(db, { id: 'rolled-back' });
    throw new Error('stop');
  }), /stop/);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM todos WHERE id = 'rolled-back'").get().n,
    0,
  );
  closeTodoDatabase(db);
});

test('backs up, exports, and restores a consistent committed snapshot', async () => {
  const db = openTodoDatabase({ file: tempFile() });
  const backupFile = tempFile('nested/backup.db');
  const exportFile = tempFile('nested/todos.json');
  const restoredFile = tempFile('nested/restored.db');
  insertTodo(db, { id: 'todo-z', title: 'Second' });
  insertTodo(db, { id: 'todo-a', title: 'Keep me' });

  await backupTodoDatabase({ db, destination: backupFile });
  exportTodoDatabase({ db, destination: exportFile });

  const backup = openTodoDatabase({ file: backupFile });
  assert.deepEqual(
    backup.prepare('SELECT id, title FROM todos ORDER BY id').all()
      .map(({ id, title }) => [id, title]),
    [
      ['todo-a', 'Keep me'],
      ['todo-z', 'Second'],
    ],
  );
  closeTodoDatabase(backup);

  const exported = JSON.parse(readFileSync(exportFile, 'utf8'));
  assert.deepEqual(Object.keys(exported), ['formatVersion', ...TABLES]);
  assert.equal(exported.formatVersion, 3);
  assert.deepEqual(exported.todos.map(({ id }) => id), ['todo-a', 'todo-z']);

  restoreTodoDatabase({ source: exportFile, destination: restoredFile });
  const restored = openTodoDatabase({ file: restoredFile });
  assert.deepEqual(
    restored.prepare('SELECT id, title FROM todos ORDER BY id').all()
      .map(({ id, title }) => [id, title]),
    [
      ['todo-a', 'Keep me'],
      ['todo-z', 'Second'],
    ],
  );
  closeTodoDatabase(restored);
  closeTodoDatabase(db);
});

test('exports every table in deterministic primary-key order', () => {
  const db = openTodoDatabase({
    file: tempFile(),
    now: () => FIXTURE_AT,
  });
  const exportFile = tempFile('todos.json');
  const restoredFile = tempFile('restored.db');
  seedCompleteSnapshot(db);

  exportTodoDatabase({ db, destination: exportFile });
  const exported = JSON.parse(readFileSync(exportFile, 'utf8'));

  const expected = expectedCompleteSnapshot();
  assert.deepEqual(exported, expected);

  restoreTodoDatabase({ source: exportFile, destination: restoredFile });
  const restored = openTodoDatabase({ file: restoredFile });
  for (const table of TABLES) {
    assert.deepEqual(plainRows(restored, table), expected[table], table);
  }
  closeTodoDatabase(restored);
  closeTodoDatabase(db);
});

test('malformed export rows roll back the entire destination restore', () => {
  const sourceDb = openTodoDatabase({
    file: tempFile(),
    now: () => FIXTURE_AT,
  });
  seedCompleteSnapshot(sourceDb);
  const source = tempFile('malformed.json');
  exportTodoDatabase({ db: sourceDb, destination: source });
  closeTodoDatabase(sourceDb);
  const malformed = JSON.parse(readFileSync(source, 'utf8'));
  malformed.todo_notes[0].todo_id = 'missing-parent';
  writeFileSync(source, JSON.stringify(malformed), 'utf8');

  const destination = tempFile('destination.db');
  const destinationDb = openTodoDatabase({ file: destination });
  insertTodo(destinationDb, { id: 'existing', title: 'Still here' });
  closeTodoDatabase(destinationDb);

  assert.throws(
    () => restoreTodoDatabase({ source, destination }),
    /foreign key/i,
  );
  const unchanged = openTodoDatabase({ file: destination });
  assert.deepEqual(
    unchanged.prepare('SELECT id, title FROM todos ORDER BY id').all()
      .map(({ id, title }) => [id, title]),
    [['existing', 'Still here']],
  );
  closeTodoDatabase(unchanged);
});

test('rejects an unsupported export before changing the destination', () => {
  const destination = tempFile();
  const db = openTodoDatabase({ file: destination });
  insertTodo(db, { id: 'existing', title: 'Still here' });
  closeTodoDatabase(db);
  const source = tempFile('bad-export.json');
  writeFileSync(source, JSON.stringify({ formatVersion: 1 }), 'utf8');

  assert.throws(
    () => restoreTodoDatabase({ source, destination }),
    /formatVersion 3/i,
  );

  const unchanged = openTodoDatabase({ file: destination });
  assert.equal(
    unchanged.prepare("SELECT title FROM todos WHERE id = 'existing'").get().title,
    'Still here',
  );
  closeTodoDatabase(unchanged);
});

test('restore atomically replaces a destination containing append-only notes', () => {
  const sourceDb = openTodoDatabase({ file: tempFile() });
  insertTodo(sourceDb, { id: 'replacement', title: 'Replacement' });
  const source = tempFile('source.json');
  exportTodoDatabase({ db: sourceDb, destination: source });
  closeTodoDatabase(sourceDb);

  const destination = tempFile('destination.db');
  const destinationDb = openTodoDatabase({ file: destination });
  insertTodo(destinationDb, { id: 'old', title: 'Old' });
  destinationDb.prepare(`
    INSERT INTO todo_notes (id, todo_id, body, created_at)
    VALUES (?, ?, ?, ?)
  `).run('old-note', 'old', 'Keep history append-only', '2026-09-11T12:00:00.000Z');
  closeTodoDatabase(destinationDb);

  restoreTodoDatabase({ source, destination });

  const restored = openTodoDatabase({ file: destination });
  assert.deepEqual(
    restored.prepare('SELECT id FROM todos ORDER BY id').all().map(({ id }) => id),
    ['replacement'],
  );
  assert.equal(restored.prepare('SELECT count(*) AS n FROM todo_notes').get().n, 0);
  closeTodoDatabase(restored);
});

test('closes an open todo database', () => {
  const db = openTodoDatabase({ file: tempFile() });

  closeTodoDatabase(db);

  assert.throws(() => db.prepare('SELECT 1'), /not open/i);
});
