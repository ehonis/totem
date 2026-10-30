// Run with: node --test todos/migration-009.test.mjs
//
// Migration 009 adds `rolled_from` (the task a repeating task's next occurrence was
// rolled from) and a partial unique index on it. This builds a database exactly as
// migrations 001-008 leave it, migrates it, and checks that nothing else moved, that
// re-running changes nothing, and that export and restore carry the column.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
import { closeTodoDatabase, exportTodoDatabase, openTodoDatabase, restoreTodoDatabase } from './db.mjs'
import { createTodoService } from './service.mjs'

const AT = '2026-09-11T12:00:00.000Z'
const TABLES = ['todos', 'tags', 'todo_tags', 'todo_notes', 'goals', 'goal_links', 'lists', 'list_todos']

/** A database at schema version 8, the state every install was in before 009. */
function versionEightDatabase() {
  const dir = mkdtempSync(join(tmpdir(), 'totem-m009-'))
  const file = join(dir, 'todos.db')
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT')
  for (const m of [m1, m2, m3, m4, m5, m6, m7, m8]) {
    m.migrate(db)
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(m.version, AT)
  }
  return { db, file, dir }
}

function seed(db) {
  const todo = db.prepare(`
    INSERT INTO todos (id, title, area, status, due_date, recurrence, created_at, updated_at, completed_at, outcome)
    VALUES (?, ?, 'Personal', ?, ?, ?, ?, ?, ?, ?)
  `)
  // A series that already rolled twice for one completion, as the old code did.
  todo.run('t-done', 'Weekly review', 'done', '2026-09-04', 'weekly', AT, AT, AT, 'completed')
  todo.run('t-next-1', 'Weekly review', 'todo', '2026-09-11', 'weekly', AT, AT, null, null)
  todo.run('t-next-2', 'Weekly review', 'todo', '2026-09-11', 'weekly', AT, AT, null, null)
  todo.run('t-plain', 'One-off', 'todo', null, null, AT, AT, null, null)
  db.exec(`
    INSERT INTO tags VALUES ('tag-1', 'errand', '${AT}');
    INSERT INTO todo_tags VALUES ('t-done', 'tag-1', '${AT}'), ('t-next-1', 'tag-1', '${AT}');
    INSERT INTO todo_notes VALUES ('n-1', 't-done', 'a note', '${AT}');
    INSERT INTO goals (id, title, period_type, period_start, period_end, created_at, updated_at)
      VALUES ('g-1', 'Goal', 'week', '2026-09-07', '2026-09-13', '${AT}', '${AT}');
    INSERT INTO goal_links (id, goal_id, kind, todo_id, label, created_at) VALUES ('gl-1', 'g-1', 'todo', 't-next-1', 'Weekly review', '${AT}');
    INSERT INTO lists (id, title, created_at, updated_at) VALUES ('l-1', 'List', '${AT}', '${AT}');
    INSERT INTO list_todos VALUES ('l-1', 't-plain', '${AT}');
  `)
}

const snapshot = (db) => Object.fromEntries(TABLES.map((t) => [
  t,
  db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all().map((row) => ({ ...row })),
]))
const counts = (db) => Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n]))

test('009 adds rolled_from to a version 8 database and keeps every row', () => {
  const { db, file } = versionEightDatabase()
  seed(db)
  const before = snapshot(db)
  const beforeCounts = counts(db)
  db.close()

  const migrated = openTodoDatabase({ file, now: () => AT })
  try {
    assert.deepEqual(counts(migrated), beforeCounts)
    const after = snapshot(migrated)
    for (const table of TABLES.filter((t) => t !== 'todos')) assert.deepEqual(after[table], before[table], table)
    assert.deepEqual(after.todos, before.todos.map((row) => ({ ...row, rolled_from: null })))
    assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), [])
    assert.equal(migrated.prepare('SELECT max(version) AS v FROM schema_migrations').get().v, 9)

    // Existing duplicates are left as they are; the index only constrains new links.
    migrated.exec("UPDATE todos SET rolled_from = 't-done' WHERE id = 't-next-1'")
    assert.throws(() => migrated.exec("UPDATE todos SET rolled_from = 't-done' WHERE id = 't-next-2'"), /UNIQUE/)
  } finally {
    closeTodoDatabase(migrated)
  }
})

test('009 is idempotent: re-running it or reopening changes nothing', () => {
  const { db, file } = versionEightDatabase()
  seed(db)
  m9.migrate(db)
  m9.migrate(db)
  db.close()

  const opened = openTodoDatabase({ file, now: () => AT })
  try {
    const first = snapshot(opened)
    const schema = opened.prepare("SELECT name, sql FROM sqlite_master WHERE tbl_name = 'todos' ORDER BY name").all()
    m9.migrate(opened)
    assert.deepEqual(snapshot(opened), first)
    assert.deepEqual(opened.prepare("SELECT name, sql FROM sqlite_master WHERE tbl_name = 'todos' ORDER BY name").all(), schema)
    assert.equal(opened.prepare("SELECT count(*) AS n FROM pragma_table_info('todos') WHERE name = 'rolled_from'").get().n, 1)
  } finally {
    closeTodoDatabase(opened)
  }
  const again = openTodoDatabase({ file, now: () => AT })
  try {
    assert.equal(again.prepare('SELECT count(*) AS n FROM schema_migrations WHERE version = 9').get().n, 1)
    assert.deepEqual(counts(again), { todos: 4, tags: 1, todo_tags: 2, todo_notes: 1, goals: 1, goal_links: 1, lists: 1, list_todos: 1 })
  } finally {
    closeTodoDatabase(again)
  }
})

test('export and restore carry rolled_from, in any row order, and the series still rolls once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'totem-m009-restore-'))
  const db = openTodoDatabase({ file: join(dir, 'source.db'), now: () => AT })
  // Ids chosen so the export, ordered by id, lists each row before the one it was rolled from.
  const ids = ['z-first', 'm-second', 'a-third']
  let n = 0
  const service = createTodoService({ db, now: () => AT, makeId: () => ids[n++], actionLog: { record() {} } })
  const first = service.create({ title: 'Weekly review', area: 'Personal', dueDate: '2026-09-04', recurrence: 'weekly' })
  service.complete(first.id)
  service.complete('m-second')
  exportTodoDatabase({ db, destination: join(dir, 'export.json') })
  const exported = JSON.parse(readFileSync(join(dir, 'export.json'), 'utf8'))
  assert.deepEqual(exported.todos.map((row) => [row.id, row.rolled_from]), [
    ['a-third', 'm-second'], ['m-second', 'z-first'], ['z-first', null],
  ])
  closeTodoDatabase(db)

  restoreTodoDatabase({ source: join(dir, 'export.json'), destination: join(dir, 'restored.db') })
  const restored = openTodoDatabase({ file: join(dir, 'restored.db'), now: () => AT })
  try {
    assert.deepEqual(
      restored.prepare('SELECT id, rolled_from FROM todos ORDER BY id').all().map((row) => ({ ...row })),
      [{ id: 'a-third', rolled_from: 'm-second' }, { id: 'm-second', rolled_from: 'z-first' }, { id: 'z-first', rolled_from: null }],
    )
    assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(), [])
    const again = createTodoService({ db: restored, now: () => AT, makeId: () => 'extra', actionLog: { record() {} } })
    again.move('m-second', 'todo')
    again.complete('m-second')
    assert.equal(restored.prepare('SELECT count(*) AS n FROM todos').get().n, 3)
  } finally {
    closeTodoDatabase(restored)
  }

  // An export written before 009 has no rolled_from at all, and restores with it empty.
  const old = JSON.parse(readFileSync(join(dir, 'export.json'), 'utf8'))
  old.todos = old.todos.map(({ rolled_from, ...row }) => row)
  old.schema_migrations = old.schema_migrations.filter((row) => row.version < 9)
  writeFileSync(join(dir, 'old.json'), JSON.stringify(old))
  restoreTodoDatabase({ source: join(dir, 'old.json'), destination: join(dir, 'restored-old.db') })
  const fromOld = openTodoDatabase({ file: join(dir, 'restored-old.db'), now: () => AT })
  try {
    assert.equal(fromOld.prepare('SELECT count(*) AS n FROM todos WHERE rolled_from IS NULL').get().n, 3)
  } finally {
    closeTodoDatabase(fromOld)
  }
})
