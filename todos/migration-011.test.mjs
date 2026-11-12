// Run with: node --test todos/migration-011.test.mjs
//
// Migration 011 retires the Doing status and the GitHub task connector: every `doing`
// row becomes `todo` above the open tasks in its old order, every task the connector
// imported is archived, and the connector's unsent writes are dropped. This builds a
// database exactly as migrations 001-010 leave it, migrates it through
// openTodoDatabase, and checks row counts, ids, foreign keys, the backup, and that
// running it again changes nothing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import * as m1 from './migrations/001-initial.mjs'
import * as m2 from './migrations/002-outbox-exhausted.mjs'
import * as m3 from './migrations/003-goals.mjs'
import * as m4 from './migrations/004-outcome.mjs'
import * as m5 from './migrations/005-goal-abandoned.mjs'
import * as m6 from './migrations/006-lists.mjs'
import * as m7 from './migrations/007-goal-week-monday.mjs'
import * as m8 from './migrations/008-free-venture-tags.mjs'
import * as m9 from './migrations/009-rolled-from.mjs'
import * as m10 from './migrations/010-recs.mjs'
import * as m11 from './migrations/011-no-doing.mjs'
import { closeTodoDatabase, exportTodoDatabase, openTodoDatabase, restoreTodoDatabase } from './db.mjs'
import { createTodoService } from './service.mjs'

const AT = '2026-10-30T12:00:00.000Z'
const OPENED = '2026-11-09T12:00:00.000Z'
const TABLES = [
  'todos', 'tags', 'todo_tags', 'todo_notes', 'todo_relations', 'external_links', 'sync_outbox',
  'connector_state', 'todo_import_keys', 'goals', 'goal_links', 'lists', 'list_todos', 'recs',
]

/** A database at schema version 10, the state every install was in before 011. */
function versionTenDatabase() {
  const dir = mkdtempSync(join(tmpdir(), 'totem-m011-'))
  const file = join(dir, 'todos.db')
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT')
  for (const m of [m1, m2, m3, m4, m5, m6, m7, m8, m9, m10]) {
    m.migrate(db)
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(m.version, AT)
  }
  return { db, file, dir }
}

function seed(db) {
  const todo = db.prepare(`
    INSERT INTO todos (id, title, area, status, position, created_at, updated_at, completed_at, outcome, archived_at, deleted_at)
    VALUES (?, ?, 'Personal', ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  // Open work: two doing (positions out of id order on purpose) and three todo.
  todo.run('d-late', 'Doing second', 'doing', 5, AT, AT, null, null, null, null)
  todo.run('d-early', 'Doing first', 'doing', 1, AT, AT, null, null, null, null)
  todo.run('t-a', 'Todo a', 'todo', 2, AT, AT, null, null, null, null)
  todo.run('t-b', 'Todo b', 'todo', 3, AT, AT, null, null, null, null)
  todo.run('t-c', 'Todo c', 'todo', 9, AT, AT, null, null, null, null)
  todo.run('done-1', 'Finished', 'done', 0, AT, AT, AT, 'completed', null, null)
  // What the GitHub connector imported: open, done, doing, already archived, deleted.
  todo.run('gh-open', 'Issue open', 'todo', 4, AT, AT, null, null, null, null)
  todo.run('gh-done', 'Issue done', 'done', 0, AT, AT, AT, 'completed', null, null)
  todo.run('gh-doing', 'Issue doing', 'doing', 2, AT, AT, null, null, null, null)
  todo.run('gh-archived', 'Issue archived', 'done', 0, AT, AT, AT, 'completed', '2026-10-01T00:00:00.000Z', null)
  todo.run('gh-deleted', 'Issue deleted', 'todo', 0, AT, AT, null, null, null, '2026-10-02T00:00:00.000Z')
  // Linked to a connector no migration clears ('example'): opening runs 012 too, which
  // archives tasks the retired sheet sync linked.
  todo.run('sheet-1', 'Sheet row', 'todo', 6, AT, AT, null, null, null, null)
  db.exec(`
    INSERT INTO tags VALUES ('tag-1', 'errand', '${AT}');
    INSERT INTO todo_tags VALUES ('gh-open', 'tag-1', '${AT}'), ('d-early', 'tag-1', '${AT}');
    INSERT INTO todo_notes VALUES ('n-1', 'gh-open', 'a note', '${AT}'), ('n-2', 'd-late', 'another', '${AT}');
    INSERT INTO todo_relations VALUES ('gh-open', 't-a', '${AT}');
    INSERT INTO external_links (id, todo_id, connector, external_id, external_url, created_at, updated_at) VALUES
      ('x-1', 'gh-open', 'github', '9001', 'https://github.com/acme/acme/issues/1', '${AT}', '${AT}'),
      ('x-2', 'gh-done', 'github', '9002', 'https://github.com/acme/acme/issues/2', '${AT}', '${AT}'),
      ('x-3', 'gh-doing', 'github', '9003', 'https://github.com/acme/acme/issues/3', '${AT}', '${AT}'),
      ('x-4', 'gh-archived', 'github', '9004', 'https://github.com/acme/acme/issues/4', '${AT}', '${AT}'),
      ('x-5', 'gh-deleted', 'github', '9005', 'https://github.com/acme/acme/issues/5', '${AT}', '${AT}'),
      ('x-6', 'sheet-1', 'example', 'row-6', NULL, '${AT}', '${AT}');
    INSERT INTO sync_outbox (id, todo_id, connector, operation, payload, idempotency_key, status, created_at, updated_at, completed_at) VALUES
      ('o-pending', 'gh-open', 'github', 'rename', '{}', 'k-1', 'pending', '${AT}', '${AT}', NULL),
      ('o-retry', 'gh-open', 'github', 'rename', '{}', 'k-2', 'retry', '${AT}', '${AT}', NULL),
      ('o-conflict', 'gh-done', 'github', 'rename', '{}', 'k-3', 'conflict', '${AT}', '${AT}', NULL),
      ('o-create', NULL, 'github', 'create', '{}', 'k-4', 'pending', '${AT}', '${AT}', NULL),
      ('o-create-2', 'gh-open', 'github', 'create', '{"repo":"acme/acme","body":"Body"}', 'k-8', 'retry', '${AT}', '${AT}', NULL),
      ('o-done', 'gh-open', 'github', 'rename', '{}', 'k-5', 'completed', '${AT}', '${AT}', '${AT}'),
      ('o-sheet', 'sheet-1', 'example', 'update', '{}', 'k-6', 'pending', '${AT}', '${AT}', NULL);
    INSERT INTO sync_outbox (id, todo_id, connector, operation, payload, idempotency_key, status, attempts, last_error, created_at, updated_at) VALUES
      ('o-exhausted', 'gh-open', 'github', 'rename', '{}', 'k-7', 'exhausted', 5, 'gone', '${AT}', '${AT}');
    INSERT INTO connector_state (connector, settings_json, created_at, updated_at) VALUES ('github', '{"watchedRepos":["acme/acme"]}', '${AT}', '${AT}');
    INSERT INTO todo_import_keys VALUES ('github', '9001', 'gh-open', NULL, '${AT}');
    INSERT INTO goals (id, title, period_type, period_start, period_end, created_at, updated_at)
      VALUES ('g-1', 'Goal', 'week', '2026-10-26', '2026-11-01', '${AT}', '${AT}');
    INSERT INTO goal_links (id, goal_id, kind, todo_id, label, created_at) VALUES ('gl-1', 'g-1', 'todo', 'gh-open', 'Issue', '${AT}');
    INSERT INTO lists (id, title, created_at, updated_at) VALUES ('l-1', 'List', '${AT}', '${AT}');
    INSERT INTO list_todos VALUES ('l-1', 'd-late', '${AT}');
  `)
}

const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all().map((row) => ({ ...row }))
const snapshot = (db) => Object.fromEntries(TABLES.map((t) => [t, rows(db, t)]))
const byId = (list) => Object.fromEntries(list.map((row) => [row.id, row]))

test('011 turns doing into todo above the open tasks, archives GitHub imports and drops their unsent writes', () => {
  const { db, file, dir } = versionTenDatabase()
  seed(db)
  const before = snapshot(db)
  db.close()

  const logged = []
  const migrated = openTodoDatabase({ file, now: () => OPENED, actionLog: { record: (entry) => logged.push(entry) } })
  try {
    const after = snapshot(migrated)
    // Each unfiled issue the owner had approved is named in the action log, once.
    assert.deepEqual(logged.map((entry) => [entry.action, entry.actor, entry.target, entry.detail.repo, entry.detail.title]), [
      ['todo.github-outbox.drop', 'system', 'o-create', null, '(task no longer exists)'],
      ['todo.github-outbox.drop', 'system', 'gh-open', 'acme/acme', 'Issue open'],
    ])
    assert.match(logged[1].summary, /"Issue open" for acme\/acme.*pre-migration-11 backup/)
    // Nothing but the outbox loses a row, and every id survives.
    for (const table of TABLES.filter((t) => t !== 'sync_outbox')) {
      assert.equal(after[table].length, before[table].length, table)
    }
    assert.deepEqual(after.todos.map((row) => row.id), before.todos.map((row) => row.id))
    for (const table of ['tags', 'todo_tags', 'todo_notes', 'todo_relations', 'external_links', 'connector_state', 'todo_import_keys', 'goals', 'goal_links', 'lists', 'list_todos', 'recs']) {
      assert.deepEqual(after[table], before[table], table)
    }
    assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), [])

    // No doing anywhere; the former doing rows lead the open column in their old order,
    // and no todo row moved.
    assert.equal(migrated.prepare(`SELECT count(*) AS n FROM todos WHERE status = 'doing'`).get().n, 0)
    const todos = byId(after.todos)
    const old = byId(before.todos)
    const open = migrated.prepare(`
      SELECT id FROM todos WHERE status = 'todo' AND deleted_at IS NULL AND archived_at IS NULL ORDER BY position, id
    `).all().map((row) => row.id)
    assert.deepEqual(open, ['d-early', 'd-late', 't-a', 't-b', 'sheet-1', 't-c'])
    for (const id of ['t-a', 't-b', 't-c', 'sheet-1', 'gh-open', 'gh-deleted']) assert.equal(todos[id].position, old[id].position, id)
    assert.ok(todos['d-early'].position < todos['d-late'].position)
    assert.ok(todos['d-late'].position < 2)
    for (const id of ['d-early', 'd-late']) {
      assert.equal(todos[id].updated_at, AT, `${id}: a status rename is not an edit`)
      assert.equal(todos[id].completed_at, null)
    }

    // Every non-deleted, unarchived task with a GitHub link is archived, done or not.
    for (const id of ['gh-open', 'gh-done', 'gh-doing']) {
      assert.match(todos[id].archived_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, id)
      assert.equal(todos[id].updated_at, todos[id].archived_at, id)
    }
    assert.equal(todos['gh-doing'].status, 'todo')
    assert.equal(todos['gh-done'].status, 'done')
    assert.equal(todos['gh-archived'].archived_at, '2026-10-01T00:00:00.000Z', 'already archived stays as it was')
    assert.equal(todos['gh-deleted'].archived_at, null, 'the recycle bin is left alone')
    assert.equal(todos['gh-deleted'].deleted_at, '2026-10-02T00:00:00.000Z')
    for (const id of ['t-a', 'd-early', 'sheet-1', 'done-1']) assert.equal(todos[id].archived_at, null, id)

    // The connector's unsent writes go; completed history and other connectors stay.
    assert.deepEqual(after.sync_outbox.map((row) => row.id), ['o-done', 'o-sheet'])

    // The file was copied before it changed.
    const backups = readdirSync(dir).filter((f) => f.startsWith('todos.db.pre-migration-11-'))
    assert.equal(backups.length, 1)
    const copy = new DatabaseSync(join(dir, backups[0]), { readOnly: true })
    try {
      assert.deepEqual(snapshot(copy), before)
    } finally {
      copy.close()
    }
  } finally {
    closeTodoDatabase(migrated)
  }
})

test('011 is idempotent: re-running it or reopening changes nothing and backs up once', () => {
  const { db, file, dir } = versionTenDatabase()
  seed(db)
  m11.migrate(db)
  const once = snapshot(db)
  m11.migrate(db)
  assert.deepEqual(snapshot(db), once)
  db.close()

  const logged = []
  const record = (entry) => logged.push(entry)
  closeTodoDatabase(openTodoDatabase({ file, now: () => OPENED, actionLog: { record } }))
  const again = openTodoDatabase({ file, now: () => OPENED, actionLog: { record } })
  try {
    const first = snapshot(again)
    m11.migrate(again)
    assert.deepEqual(snapshot(again), first)
    assert.equal(again.prepare('SELECT count(*) AS n FROM schema_migrations WHERE version = 11').get().n, 1)
  } finally {
    closeTodoDatabase(again)
  }
  assert.deepEqual(logged, [], 'already migrated (by the direct runs above): nothing more is logged')
  assert.equal(readdirSync(dir).filter((f) => f.includes('pre-migration-11')).length, 1, 'no second backup')
})

test('011 leaves a board with no open tasks consistent, and a fresh install unbacked-up', () => {
  const { db, file, dir } = versionTenDatabase()
  db.exec(`INSERT INTO todos (id, title, area, status, position, created_at, updated_at) VALUES
    ('only-b', 'B', 'Personal', 'doing', 3, '${AT}', '${AT}'), ('only-a', 'A', 'Personal', 'doing', 3, '${AT}', '${AT}')`)
  db.close()
  const opened = openTodoDatabase({ file, now: () => OPENED })
  try {
    assert.deepEqual(
      opened.prepare('SELECT id, status, position FROM todos ORDER BY position, id').all().map((row) => ({ ...row })),
      [{ id: 'only-a', status: 'todo', position: -2 }, { id: 'only-b', status: 'todo', position: -1 }],
    )
  } finally {
    closeTodoDatabase(opened)
  }

  const fresh = mkdtempSync(join(tmpdir(), 'totem-m011-fresh-'))
  closeTodoDatabase(openTodoDatabase({ file: join(fresh, 'todos.db'), now: () => OPENED }))
  assert.deepEqual(readdirSync(fresh).filter((f) => f.includes('pre-migration')), [])
  assert.ok(readdirSync(dir).some((f) => f.includes('pre-migration-11')))
})

test('an export taken before 011 restores without a doing row once the file is opened', () => {
  const dir = mkdtempSync(join(tmpdir(), 'totem-m011-restore-'))
  const source = openTodoDatabase({ file: join(dir, 'source.db'), now: () => OPENED })
  let n = 0
  const service = createTodoService({ db: source, now: () => OPENED, makeId: () => `id-${++n}`, actionLog: { record() {} } })
  const task = service.create({ title: 'Was in progress', area: 'Personal' })
  exportTodoDatabase({ db: source, destination: join(dir, 'export.json') })
  closeTodoDatabase(source)

  // As an export from before this migration looks: a doing row, schema at 10.
  const old = JSON.parse(readFileSync(join(dir, 'export.json'), 'utf8'))
  old.todos = old.todos.map((row) => (row.id === task.id ? { ...row, status: 'doing' } : row))
  old.schema_migrations = old.schema_migrations.filter((row) => row.version < 11)
  writeFileSync(join(dir, 'old.json'), JSON.stringify(old))
  restoreTodoDatabase({ source: join(dir, 'old.json'), destination: join(dir, 'restored.db') })

  const restored = openTodoDatabase({ file: join(dir, 'restored.db'), now: () => OPENED })
  try {
    assert.equal(restored.prepare(`SELECT count(*) AS n FROM todos WHERE status = 'doing'`).get().n, 0)
    assert.equal(restored.prepare('SELECT count(*) AS n FROM schema_migrations WHERE version = 11').get().n, 1)
  } finally {
    closeTodoDatabase(restored)
  }
})
