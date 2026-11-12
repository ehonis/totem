// Run with: node --test todos/migration-012.test.mjs
//
// Migration 012 clears what the retired two-way sheet sync left behind: its outbox
// rows and connector state go, and tasks it linked to sheet rows are archived. This
// builds a database exactly as migrations 001-010 leave it (011 is the GitHub
// connector's, in its own change; the runner allows the gap), seeds what an install
// that ran the sync would hold, migrates it, and checks every table's rows, that
// foreign keys hold, that a second run changes nothing, and that the runner backs
// the file up first.
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
import * as m9 from './migrations/009-rolled-from.mjs'
import * as m10 from './migrations/010-recs.mjs'
import * as m12 from './migrations/012-retire-sheet-sync.mjs'
import { closeTodoDatabase, openTodoDatabase } from './db.mjs'
import { createTodoService } from './service.mjs'

const AT = '2026-10-30T12:00:00.000Z'
const EARLIER = '2026-10-01T09:00:00.000Z'

/** A database at schema version 10, the state every install is in before 012. */
function versionTenDatabase() {
  const dir = mkdtempSync(join(tmpdir(), 'totem-m012-'))
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

/** What an install that ran the sheet sync (and the GitHub one) holds. */
function seed(db) {
  const todo = db.prepare(`
    INSERT INTO todos (id, title, area, status, completed_at, archived_at, deleted_at, created_at, updated_at)
    VALUES (?, ?, 'Personal', ?, ?, ?, ?, ?, ?)
  `)
  todo.run('t-local', 'Call the bank', 'todo', null, null, null, AT, AT)
  todo.run('t-sheet', 'Book the venue', 'todo', null, null, null, AT, AT)
  todo.run('t-sheet-done', 'Send the deck', 'done', AT, null, null, AT, AT)
  todo.run('t-sheet-archived', 'Old row', 'done', AT, EARLIER, null, AT, AT)
  todo.run('t-sheet-deleted', 'Binned row', 'todo', null, null, EARLIER, AT, AT)
  todo.run('t-github', 'Fix the door', 'todo', null, null, null, AT, AT)
  const link = db.prepare(`
    INSERT INTO external_links (id, todo_id, connector, external_id, external_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  link.run('x-sheet', 't-sheet', 'sheet', 'row-5', 'https://docs.example/s#5', AT, AT)
  link.run('x-sheet-done', 't-sheet-done', 'sheet', 'row-6', null, AT, AT)
  link.run('x-sheet-archived', 't-sheet-archived', 'sheet', 'row-7', null, AT, AT)
  link.run('x-sheet-deleted', 't-sheet-deleted', 'sheet', 'row-8', null, AT, AT)
  link.run('x-github', 't-github', 'github', 'acme/acme#7', null, AT, AT)
  const outbox = db.prepare(`
    INSERT INTO sync_outbox (id, todo_id, connector, operation, payload, idempotency_key, status, completed_at, last_error, created_at, updated_at)
    VALUES (?, ?, ?, 'update', '{}', ?, ?, ?, ?, ?, ?)
  `)
  outbox.run('o-sheet-pending', 't-sheet', 'sheet', 'k1', 'pending', null, null, AT, AT)
  outbox.run('o-sheet-conflict', 't-sheet', 'sheet', 'k2', 'conflict', null, 'both sides changed', AT, AT)
  outbox.run('o-sheet-done', 't-sheet-done', 'sheet', 'k3', 'completed', AT, null, AT, AT)
  outbox.run('o-sheet-null', null, 'sheet', 'k4', 'retry', null, 'boom', AT, AT)
  outbox.run('o-github', 't-github', 'github', 'k5', 'pending', null, null, AT, AT)
  const state = db.prepare(`
    INSERT INTO connector_state (connector, cursor, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
  `)
  state.run('sheet', 'cursor-z', 'Sheet sync needs TASK_SHEET_ID', AT, AT)
  state.run('github', 'cursor-g', null, AT, AT)
  db.exec(`
    INSERT INTO todo_notes VALUES ('n-1', 't-sheet', 'a note', '${AT}');
    INSERT INTO tags VALUES ('tag-1', 'errand', '${AT}');
    INSERT INTO todo_tags VALUES ('t-sheet', 'tag-1', '${AT}');
  `)
}

const rows = (db, sql) => db.prepare(sql).all().map((row) => ({ ...row }))
const ids = (db, table) => rows(db, `SELECT ${table === 'connector_state' ? 'connector' : 'id'} AS id FROM ${table} ORDER BY 1`).map((r) => r.id)
const todoState = (db) => Object.fromEntries(rows(db, 'SELECT id, status, archived_at, deleted_at, updated_at FROM todos ORDER BY id').map((r) => [r.id, r]))
const everything = (db) => Object.fromEntries(
  ['todos', 'external_links', 'sync_outbox', 'connector_state', 'todo_notes', 'tags', 'todo_tags']
    .map((t) => [t, rows(db, `SELECT * FROM ${t} ORDER BY 1, 2`)]),
)

test('012 drops the sheet outbox and state, archives sheet-linked tasks, and leaves everything else', () => {
  const { db } = versionTenDatabase()
  seed(db)
  const before = todoState(db)
  m12.migrate(db)

  assert.deepEqual(ids(db, 'todos'), ['t-github', 't-local', 't-sheet', 't-sheet-archived', 't-sheet-deleted', 't-sheet-done'], 'no task deleted')
  const after = todoState(db)
  for (const id of ['t-sheet', 't-sheet-done']) {
    assert.match(after[id].archived_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, id)
    assert.equal(after[id].updated_at, after[id].archived_at, id)
    assert.equal(after[id].status, before[id].status, `${id} keeps its status`)
  }
  for (const id of ['t-local', 't-github', 't-sheet-archived', 't-sheet-deleted']) {
    assert.deepEqual(after[id], before[id], `${id} untouched`)
  }
  assert.deepEqual(ids(db, 'external_links'), ['x-github', 'x-sheet', 'x-sheet-archived', 'x-sheet-deleted', 'x-sheet-done'], 'links stay, as history')
  assert.deepEqual(ids(db, 'sync_outbox'), ['o-github'])
  assert.deepEqual(ids(db, 'connector_state'), ['github'])
  assert.equal(db.prepare('SELECT count(*) AS n FROM todo_notes').get().n, 1)
  assert.equal(db.prepare('SELECT count(*) AS n FROM todo_tags').get().n, 1)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
})

test('012 is idempotent: a second run changes nothing', () => {
  const { db } = versionTenDatabase()
  seed(db)
  m12.migrate(db)
  const first = everything(db)
  m12.migrate(db)
  assert.deepEqual(everything(db), first)
})

test('the runner applies 012 once, after a backup, and the archived tasks restore', () => {
  const { db, file, dir } = versionTenDatabase()
  seed(db)
  db.close()

  const opened = openTodoDatabase({ file, now: () => AT })
  try {
    assert.deepEqual(rows(opened, 'SELECT version FROM schema_migrations ORDER BY version').map((r) => r.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    // The runner runs 011 too, which drops the GitHub connector's unsent row (012 leaves it).
    assert.deepEqual(ids(opened, 'sync_outbox'), [])
    assert.deepEqual(opened.prepare('PRAGMA foreign_key_check').all(), [])
    assert.ok(readdirSync(dir).some((name) => name.startsWith('todos.db.pre-migration-12-')), 'backed up first')
    // Archived, not lost: the owner can bring one back, and it completes locally.
    const service = createTodoService({ db: opened, now: () => AT, actionLog: { record() {} } })
    assert.ok(service.list().every((todo) => !todo.id.startsWith('t-sheet')), 'off the board')
    const back = service.unarchive('t-sheet')
    assert.equal(back.archivedAt, null)
    assert.equal(back.syncState.status, 'idle')
    assert.equal(service.complete('t-sheet').status, 'done')
  } finally {
    closeTodoDatabase(opened)
  }
  const again = openTodoDatabase({ file, now: () => AT })
  try {
    assert.equal(again.prepare('SELECT count(*) AS n FROM schema_migrations WHERE version = 12').get().n, 1)
  } finally {
    closeTodoDatabase(again)
  }
})
