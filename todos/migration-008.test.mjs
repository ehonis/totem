// Run with: node --test todos/migration-008.test.mjs
//
// Migration 008 rebuilds the todos table to drop the hardcoded venture-tag CHECK.
// A table rebuild is the one kind of migration that can silently lose data: the
// DROP fires every ON DELETE CASCADE if foreign keys are on, and the rename can
// orphan triggers. So this builds a database exactly as migrations 001-007 leave
// it, fills every table that points at a todo, and checks that nothing moved.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync } from 'node:fs'
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
import { openTodoDatabase, closeTodoDatabase } from './db.mjs'

const AT = '2026-09-11T12:00:00.000Z'
const TABLES_WITH_TODO_FK = ['todo_tags', 'todo_notes', 'todo_relations', 'external_links', 'sync_outbox', 'todo_import_keys', 'goal_links', 'list_todos']
const ALL_TABLES = ['todos', 'tags', ...TABLES_WITH_TODO_FK, 'goals', 'lists', 'todo_preferences']

/** A database at schema version 7, the state every install was in before 008. */
function versionSevenDatabase() {
  const dir = mkdtempSync(join(tmpdir(), 'totem-m008-'))
  const file = join(dir, 'todos.db')
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT')
  for (const m of [m1, m2, m3, m4, m5, m6, m7]) {
    m.migrate(db)
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(m.version, AT)
  }
  withLegacyTagList(db)
  return { db, file, dir }
}

/**
 * Migration 001 now creates the generic constraint, but every database made
 * before 008 has the original one: a CHECK naming a fixed list of tags. Recreate
 * that shape (with invented names) on the still-empty table so 008 has real work.
 */
function withLegacyTagList(db) {
  const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'todos'").get()
  const legacy = sql.replace(
    /length\(trim\(venture_tag\)\) BETWEEN 1 AND 40/,
    "venture_tag IN ('Acme', 'Globex', 'Initech')",
  )
  assert.notEqual(legacy, sql, 'expected the generic venture constraint in 001')
  const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'todos' AND sql IS NOT NULL").all()
  db.exec('PRAGMA foreign_keys = OFF')
  db.exec('DROP TABLE todos')
  db.exec(legacy)
  for (const index of indexes) db.exec(index.sql)
  db.exec('PRAGMA foreign_keys = ON')
}

function seed(db) {
  const todo = db.prepare(`
    INSERT INTO todos (id, title, area, venture_tag, status, priority, created_at, updated_at, completed_at, outcome)
    VALUES (?, ?, ?, ?, ?, 2, ?, ?, ?, ?)
  `)
  todo.run('t-personal', 'Personal task', 'Personal', null, 'todo', AT, AT, null, null)
  todo.run('t-acme', 'Acme task', 'Ventures', 'Acme', 'doing', AT, AT, null, null)
  todo.run('t-globex', 'Globex task', 'Ventures', 'Globex', 'done', AT, AT, AT, 'completed')
  todo.run('t-initech', 'Initech task', 'Ventures', 'Initech', 'done', AT, AT, AT, 'not_doing')
  db.exec(`
    INSERT INTO tags VALUES ('tag-1', 'errand', '${AT}');
    INSERT INTO todo_tags VALUES ('t-personal', 'tag-1', '${AT}'), ('t-initech', 'tag-1', '${AT}');
    INSERT INTO todo_notes VALUES ('n-1', 't-acme', 'a note', '${AT}'), ('n-2', 't-globex', 'another', '${AT}');
    INSERT INTO todo_relations VALUES ('t-acme', 't-initech', '${AT}');
    INSERT INTO external_links (id, todo_id, connector, external_id, created_at, updated_at)
      VALUES ('x-1', 't-acme', 'sheet', 'row-7', '${AT}', '${AT}'), ('x-2', 't-personal', 'github', 'o/r#1', '${AT}', '${AT}');
    INSERT INTO sync_outbox (id, todo_id, connector, operation, payload, idempotency_key, created_at, updated_at)
      VALUES ('o-1', 't-globex', 'sheet', 'update', '{}', 'k-1', '${AT}', '${AT}');
    INSERT INTO todo_import_keys VALUES ('todoist', 'a', 't-personal', NULL, '${AT}');
    INSERT INTO goals (id, title, period_type, period_start, period_end, created_at, updated_at)
      VALUES ('g-1', 'Goal', 'week', '2026-09-07', '2026-09-13', '${AT}', '${AT}');
    INSERT INTO goal_links (id, goal_id, kind, todo_id, label, created_at) VALUES ('gl-1', 'g-1', 'todo', 't-initech', 'Initech task', '${AT}');
    INSERT INTO lists (id, title, created_at, updated_at) VALUES ('l-1', 'List', '${AT}', '${AT}');
    INSERT INTO list_todos VALUES ('l-1', 't-globex', '${AT}');
  `)
}

const snapshot = (db) => Object.fromEntries(ALL_TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()]))
const counts = (db) => Object.fromEntries(ALL_TABLES.map((t) => [t, db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n]))

test('008 preserves every row, id, tag and foreign key, and backs the file up first', () => {
  const { db, file, dir } = versionSevenDatabase()
  seed(db)
  const before = snapshot(db)
  const beforeCounts = counts(db)
  const beforeIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'todos' AND sql IS NOT NULL ORDER BY name").all()
  const beforeTriggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all()
  db.close()

  const migrated = openTodoDatabase({ file, now: () => '2026-10-02T12:00:00.000Z' })
  try {
    assert.deepEqual(counts(migrated), { ...beforeCounts, todo_preferences: beforeCounts.todo_preferences + 1 })
    const after = snapshot(migrated)
    for (const table of ALL_TABLES.filter((t) => t !== 'todo_preferences')) {
      assert.deepEqual(after[table], before[table], table)
    }
    assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), [])
    assert.equal(migrated.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
    assert.deepEqual(
      migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'todos' AND sql IS NOT NULL ORDER BY name").all(),
      beforeIndexes,
    )
    assert.deepEqual(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all(), beforeTriggers)
    assert.throws(() => migrated.exec("UPDATE todo_notes SET body = 'x' WHERE id = 'n-1'"), /append-only/)

    // The cascades still work after the rebuild: they point at the new table.
    migrated.exec("DELETE FROM todos WHERE id = 't-initech'")
    assert.equal(migrated.prepare("SELECT count(*) AS n FROM goal_links WHERE todo_id = 't-initech'").get().n, 0)

    // Any non-empty tag is now storable; the shape rules still hold.
    migrated.exec(`INSERT INTO todos (id, title, area, venture_tag, created_at, updated_at) VALUES ('t-new', 'x', 'Ventures', 'Acme', '${AT}', '${AT}')`)
    assert.throws(() => migrated.exec(`INSERT INTO todos (id, title, area, venture_tag, created_at, updated_at) VALUES ('t-bad', 'x', 'Personal', 'Acme', '${AT}', '${AT}')`), /CHECK/)
    assert.throws(() => migrated.exec(`INSERT INTO todos (id, title, area, venture_tag, created_at, updated_at) VALUES ('t-bad2', 'x', 'Ventures', '  ', '${AT}', '${AT}')`), /CHECK/)

    // The board keeps the tags it uses.
    const tags = JSON.parse(migrated.prepare("SELECT value_json FROM todo_preferences WHERE key = 'ventureTags'").get().value_json)
    assert.deepEqual(tags, ['Acme', 'Globex', 'Initech'].map((name) => ({ name, color: null })))
  } finally {
    closeTodoDatabase(migrated)
  }
  const backups = readdirSync(dir).filter((f) => f.startsWith('todos.db.pre-migration-8-'))
  assert.equal(backups.length, 1)
  const copy = new DatabaseSync(join(dir, backups[0]))
  assert.equal(copy.prepare('SELECT count(*) AS n FROM todos').get().n, 4)
  assert.equal(copy.prepare('SELECT max(version) AS v FROM schema_migrations').get().v, 7)
  copy.close()
})

test('008 is idempotent: reopening or re-running changes nothing', () => {
  const { db, file, dir } = versionSevenDatabase()
  seed(db)
  db.close()
  closeTodoDatabase(openTodoDatabase({ file }))
  const again = openTodoDatabase({ file })
  try {
    const first = snapshot(again)
    const tableSql = again.prepare("SELECT sql FROM sqlite_master WHERE name = 'todos'").get().sql
    m8.migrate(again)
    assert.deepEqual(snapshot(again), first)
    assert.equal(again.prepare("SELECT sql FROM sqlite_master WHERE name = 'todos'").get().sql, tableSql)
    assert.equal(again.prepare('SELECT count(*) AS n FROM schema_migrations WHERE version = 8').get().n, 1)
  } finally {
    closeTodoDatabase(again)
  }
  assert.equal(readdirSync(dir).filter((f) => f.includes('pre-migration-8')).length, 1, 'no second backup')
})

test('a fresh database gets no tags and no backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'totem-m008-fresh-'))
  const db = openTodoDatabase({ file: join(dir, 'todos.db') })
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM todo_preferences WHERE key = 'ventureTags'").get().n, 0)
    assert.doesNotMatch(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'todos'").get().sql, /Acme/)
  } finally {
    closeTodoDatabase(db)
  }
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes('pre-migration')), [])
})

test('only tags actually present are seeded', () => {
  const { db, file } = versionSevenDatabase()
  seed(db)
  db.exec("DELETE FROM todos WHERE venture_tag IN ('Globex', 'Initech')")
  db.close()
  const migrated = openTodoDatabase({ file })
  try {
    const tags = JSON.parse(migrated.prepare("SELECT value_json FROM todo_preferences WHERE key = 'ventureTags'").get().value_json)
    assert.deepEqual(tags.map((t) => t.name), ['Acme'])
  } finally {
    closeTodoDatabase(migrated)
  }
})

test('a board with tasks but no venture tasks gets no tag list', () => {
  const { db, file } = versionSevenDatabase()
  seed(db)
  db.exec("DELETE FROM todos WHERE area = 'Ventures'")
  db.close()
  const migrated = openTodoDatabase({ file })
  try {
    assert.equal(migrated.prepare("SELECT count(*) AS n FROM todo_preferences WHERE key = 'ventureTags'").get().n, 0)
  } finally {
    closeTodoDatabase(migrated)
  }
})

test('a fresh database never had the fixed list, so 008 does no rebuild', () => {
  const dir = mkdtempSync(join(tmpdir(), 'totem-m008-new-'))
  const db = openTodoDatabase({ file: join(dir, 'todos.db') })
  try {
    assert.doesNotMatch(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'todos'").get().sql, /venture_tag IN \(/)
  } finally {
    closeTodoDatabase(db)
  }
})

test('restoring an export from before configurable tags brings the tag list back', async () => {
  const { exportTodoDatabase, restoreTodoDatabase } = await import('./db.mjs')
  const { readFileSync, writeFileSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'totem-m008-restore-'))
  const db = openTodoDatabase({ file: join(dir, 'source.db') })
  db.exec(`
    INSERT INTO todos (id, title, area, venture_tag, created_at, updated_at) VALUES
      ('t1', 'a', 'Ventures', 'Acme', '${AT}', '${AT}'),
      ('t2', 'b', 'Ventures', 'Globex', '2026-09-12T12:00:00.000Z', '2026-09-12T12:00:00.000Z'),
      ('t3', 'c', 'Personal', NULL, '${AT}', '${AT}')
  `)
  exportTodoDatabase({ db, destination: join(dir, 'export.json') })
  closeTodoDatabase(db)

  // Make it look like an old export: no tag list in the preferences.
  const old = JSON.parse(readFileSync(join(dir, 'export.json'), 'utf8'))
  old.todo_preferences = old.todo_preferences.filter((row) => row.key !== 'ventureTags')
  writeFileSync(join(dir, 'old.json'), JSON.stringify(old))
  restoreTodoDatabase({ source: join(dir, 'old.json'), destination: join(dir, 'restored.db') })
  const restored = openTodoDatabase({ file: join(dir, 'restored.db') })
  try {
    const tags = JSON.parse(restored.prepare("SELECT value_json FROM todo_preferences WHERE key = 'ventureTags'").get().value_json)
    assert.deepEqual(tags.map((t) => t.name), ['Acme', 'Globex'])
  } finally {
    closeTodoDatabase(restored)
  }

  // A list that lacks one tag the rows use gets it appended; existing colours stay.
  const partial = JSON.parse(readFileSync(join(dir, 'export.json'), 'utf8'))
  partial.todo_preferences = partial.todo_preferences.filter((row) => row.key !== 'ventureTags')
  partial.todo_preferences.push({ key: 'ventureTags', value_json: JSON.stringify([{ name: 'Globex', color: '#112233' }]), updated_at: AT })
  writeFileSync(join(dir, 'partial.json'), JSON.stringify(partial))
  restoreTodoDatabase({ source: join(dir, 'partial.json'), destination: join(dir, 'restored2.db') })
  const second = openTodoDatabase({ file: join(dir, 'restored2.db') })
  try {
    const tags = JSON.parse(second.prepare("SELECT value_json FROM todo_preferences WHERE key = 'ventureTags'").get().value_json)
    assert.deepEqual(tags, [{ name: 'Globex', color: '#112233' }, { name: 'Acme', color: null }])
  } finally {
    closeTodoDatabase(second)
  }
})
