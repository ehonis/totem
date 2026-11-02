// Run with: node --test todos/migration-010.test.mjs
//
// Migration 010 adds the recommendations ledger (`recs`). This builds a database exactly
// as migrations 001-009 leave it, migrates it, and checks that nothing else moved, that
// re-running changes nothing, that the table enforces its rules, and that export and
// restore carry it, including restoring a format 3 export taken before it existed.
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
import * as m10 from './migrations/010-recs.mjs'
import { closeTodoDatabase, exportTodoDatabase, openTodoDatabase, restoreTodoDatabase } from './db.mjs'

const AT = '2026-10-30T12:00:00.000Z'
const TABLES = ['todos', 'tags', 'todo_tags', 'todo_notes', 'goals', 'goal_links', 'lists', 'list_items', 'list_todos']

/** A database at schema version 9, the state every install was in before 010. */
function versionNineDatabase() {
  const dir = mkdtempSync(join(tmpdir(), 'totem-m010-'))
  const file = join(dir, 'todos.db')
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT')
  for (const m of [m1, m2, m3, m4, m5, m6, m7, m8, m9]) {
    m.migrate(db)
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(m.version, AT)
  }
  return { db, file, dir }
}

function seed(db) {
  const todo = db.prepare(`
    INSERT INTO todos (id, title, area, status, due_date, created_at, updated_at)
    VALUES (?, ?, 'Personal', 'todo', ?, ?, ?)
  `)
  todo.run('t-1', 'Call the bank', '2026-10-31', AT, AT)
  todo.run('t-2', 'Book dentist', null, AT, AT)
  db.exec(`
    INSERT INTO tags VALUES ('tag-1', 'errand', '${AT}');
    INSERT INTO todo_tags VALUES ('t-1', 'tag-1', '${AT}');
    INSERT INTO todo_notes VALUES ('n-1', 't-1', 'a note', '${AT}');
    INSERT INTO goals (id, title, period_type, period_start, period_end, created_at, updated_at)
      VALUES ('g-1', 'Goal', 'week', '2026-10-26', '2026-11-01', '${AT}', '${AT}');
    INSERT INTO goal_links (id, goal_id, kind, todo_id, label, created_at) VALUES ('gl-1', 'g-1', 'todo', 't-1', 'Call', '${AT}');
    INSERT INTO lists (id, title, created_at, updated_at) VALUES ('l-1', 'Groceries', '${AT}', '${AT}');
    INSERT INTO list_items (id, list_id, text, created_at, updated_at) VALUES ('li-1', 'l-1', 'Milk', '${AT}', '${AT}');
    INSERT INTO list_todos VALUES ('l-1', 't-2', '${AT}');
  `)
}

const snapshot = (db) => Object.fromEntries(TABLES.map((t) => [
  t,
  db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all().map((row) => ({ ...row })),
]))
const counts = (db) => Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n]))
const EXPECTED_COUNTS = { todos: 2, tags: 1, todo_tags: 1, todo_notes: 1, goals: 1, goal_links: 1, lists: 1, list_items: 1, list_todos: 1 }

const insertRec = (db, values = {}) => {
  const row = {
    id: 'r-1', title: 'Buy a standing desk', source: 'chat:abc', created_at: AT, updated_at: AT,
    decision: 'pending', decided_at: null, review_on: null, outcome: null, outcome_at: null, cost_usd: null, ...values,
  }
  db.prepare(`
    INSERT INTO recs (id, title, source, created_at, updated_at, decision, decided_at, review_on, outcome, outcome_at, cost_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.title, row.source, row.created_at, row.updated_at, row.decision, row.decided_at, row.review_on, row.outcome, row.outcome_at, row.cost_usd)
}

test('010 adds an empty recs table to a version 9 database and keeps every row', () => {
  const { db, file } = versionNineDatabase()
  seed(db)
  const before = snapshot(db)
  assert.deepEqual(counts(db), EXPECTED_COUNTS)
  db.close()

  const migrated = openTodoDatabase({ file, now: () => AT })
  try {
    assert.deepEqual(counts(migrated), EXPECTED_COUNTS)
    assert.deepEqual(snapshot(migrated), before)
    assert.equal(migrated.prepare('SELECT count(*) AS n FROM recs').get().n, 0)
    assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), [])
    assert.equal(migrated.prepare('SELECT count(*) AS n FROM schema_migrations WHERE version = 10').get().n, 1)
  } finally {
    closeTodoDatabase(migrated)
  }
})

test('010 is idempotent: re-running it or reopening changes nothing', () => {
  const { db, file } = versionNineDatabase()
  seed(db)
  m10.migrate(db)
  insertRec(db)
  m10.migrate(db)
  db.close()

  const opened = openTodoDatabase({ file, now: () => AT })
  const schema = (d) => d.prepare("SELECT name, sql FROM sqlite_master WHERE tbl_name = 'recs' ORDER BY name").all()
  try {
    const first = { ...snapshot(opened), recs: opened.prepare('SELECT * FROM recs').all() }
    const shape = schema(opened)
    m10.migrate(opened)
    assert.deepEqual({ ...snapshot(opened), recs: opened.prepare('SELECT * FROM recs').all() }, first)
    assert.deepEqual(schema(opened), shape)
  } finally {
    closeTodoDatabase(opened)
  }
  const again = openTodoDatabase({ file, now: () => AT })
  try {
    assert.equal(again.prepare('SELECT count(*) AS n FROM schema_migrations WHERE version = 10').get().n, 1)
    assert.deepEqual(counts(again), EXPECTED_COUNTS)
    assert.equal(again.prepare('SELECT count(*) AS n FROM recs').get().n, 1)
  } finally {
    closeTodoDatabase(again)
  }
})

test('the recs table refuses a rec that breaks its rules', () => {
  const { db } = versionNineDatabase()
  m10.migrate(db)
  assert.throws(() => insertRec(db, { id: 'a', decision: 'maybe' }), /CHECK/)
  assert.throws(() => insertRec(db, { id: 'b', decision: 'accepted' }), /CHECK/, 'a decision needs a date')
  assert.throws(() => insertRec(db, { id: 'c', decision: 'deferred', decided_at: AT }), /CHECK/, 'a deferral needs a review day')
  assert.throws(() => insertRec(db, { id: 'd', review_on: 'next week' }), /CHECK/)
  assert.throws(() => insertRec(db, { id: 'e', cost_usd: -5 }), /CHECK/)
  assert.throws(() => insertRec(db, { id: 'f', outcome: 'great', outcome_at: AT }), /CHECK/)
  assert.throws(() => insertRec(db, { id: 'g', title: '  ' }), /CHECK/)
  insertRec(db, { id: 'ok', decision: 'deferred', decided_at: AT, review_on: '2026-11-15', cost_usd: 450 })
  assert.equal(db.prepare('SELECT count(*) AS n FROM recs').get().n, 1)
  db.close()
})

test('export carries recs as format 4, and a format 3 export still restores', () => {
  const { db, file, dir } = versionNineDatabase()
  seed(db)
  db.close()
  const opened = openTodoDatabase({ file, now: () => AT })
  insertRec(opened, { decision: 'declined', decided_at: AT })
  const exportFile = join(dir, 'export.json')
  exportTodoDatabase({ db: opened, destination: exportFile })
  closeTodoDatabase(opened)

  const exported = JSON.parse(readFileSync(exportFile, 'utf8'))
  assert.equal(exported.formatVersion, 4)
  assert.equal(exported.recs.length, 1)

  const restoredFile = join(dir, 'restored.db')
  restoreTodoDatabase({ source: exportFile, destination: restoredFile })
  const restored = openTodoDatabase({ file: restoredFile })
  try {
    assert.deepEqual(restored.prepare('SELECT id, decision FROM recs').all().map((r) => ({ ...r })), [{ id: 'r-1', decision: 'declined' }])
    assert.deepEqual(counts(restored), EXPECTED_COUNTS)
  } finally {
    closeTodoDatabase(restored)
  }

  // A snapshot taken before 010: format 3, no recs key. It restores everything it has.
  const { recs, ...older } = exported
  const olderFile = join(dir, 'export-v3.json')
  writeFileSync(olderFile, JSON.stringify({ ...older, formatVersion: 3 }))
  const fromOlder = join(dir, 'from-v3.db')
  restoreTodoDatabase({ source: olderFile, destination: fromOlder })
  const reopened = openTodoDatabase({ file: fromOlder })
  try {
    assert.deepEqual(counts(reopened), EXPECTED_COUNTS)
    assert.equal(reopened.prepare('SELECT count(*) AS n FROM recs').get().n, 0)
  } finally {
    closeTodoDatabase(reopened)
  }

  // A format 4 export must carry recs: missing there means lost, not absent.
  const brokenFile = join(dir, 'export-broken.json')
  writeFileSync(brokenFile, JSON.stringify(older))
  assert.throws(() => restoreTodoDatabase({ source: brokenFile, destination: join(dir, 'broken.db') }), /table recs must be an array/)
})
