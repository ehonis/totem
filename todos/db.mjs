import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

import * as initialMigration from './migrations/001-initial.mjs';
import * as exhaustedOutboxMigration from './migrations/002-outbox-exhausted.mjs';
import * as goalsMigration from './migrations/003-goals.mjs';
import * as outcomeMigration from './migrations/004-outcome.mjs';
import * as goalAbandonedMigration from './migrations/005-goal-abandoned.mjs';
import * as listsMigration from './migrations/006-lists.mjs';
import * as goalWeekMondayMigration from './migrations/007-goal-week-monday.mjs';
import * as freeVentureTagsMigration from './migrations/008-free-venture-tags.mjs';

const FORMAT_VERSION = 3;
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const WAL_RETRY_INTERVAL_MS = 10;
const WAL_RETRY_TIMEOUT_MS = 5000;
const walRetrySignal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

const TABLES = [
  { name: 'connector_state', orderBy: 'connector' },
  { name: 'external_links', orderBy: 'id' },
  { name: 'goal_links', orderBy: 'id' },
  // Both goal tables self-reference, so their export order is also their restore
  // order: a row can never be written before the row it points at. Top-level goals
  // sort ahead of sub-goals, and standalone metrics ahead of the ones that roll up
  // into them. `X IS NOT NULL` sorts 0 (false) first, which is exactly that split —
  // and it is provably sufficient here because rollup is capped at one level, so a
  // metric that feeds another never has a feeder of its own.
  { name: 'goal_metrics', orderBy: 'rolls_up_to_metric_id IS NOT NULL, position, id' },
  { name: 'goals', orderBy: 'parent_id IS NOT NULL, position, id' },
  { name: 'list_items', orderBy: 'list_id, position, id' },
  { name: 'list_todos', orderBy: 'list_id, todo_id' },
  { name: 'lists', orderBy: 'position, id' },
  { name: 'schema_migrations', orderBy: 'version' },
  { name: 'sync_outbox', orderBy: 'id' },
  { name: 'tags', orderBy: 'id' },
  { name: 'todo_import_keys', orderBy: 'source, external_id' },
  { name: 'todo_notes', orderBy: 'id' },
  { name: 'todo_preferences', orderBy: 'key' },
  { name: 'todo_relations', orderBy: 'left_todo_id, right_todo_id' },
  { name: 'todo_tags', orderBy: 'todo_id, tag_id' },
  { name: 'todos', orderBy: 'id' },
];

const RESTORE_ORDER = [
  'schema_migrations',
  'todos',
  'lists',
  'list_items',
  'list_todos',
  // After todos, because a goal link carries a real foreign key to one.
  'goals',
  'goal_metrics',
  'goal_links',
  'lists',
  'list_items',
  'list_todos',
  'tags',
  'todo_tags',
  'todo_notes',
  'todo_relations',
  'external_links',
  'sync_outbox',
  'connector_state',
  'todo_preferences',
  'todo_import_keys',
];

// Deleting todos first lets their cascades remove append-only notes while the
// note trigger still prevents callers from deleting notes directly.
const DELETE_ORDER = [
  // Goals first: deleting them cascades their metrics and links, which also clears
  // the links pointing at todos before the todos themselves go.
  'goals',
  'goal_metrics',
  'goal_links',
  'todos',
  'tags',
  'todo_tags',
  'todo_notes',
  'todo_relations',
  'external_links',
  'sync_outbox',
  'connector_state',
  'todo_preferences',
  'todo_import_keys',
  'schema_migrations',
];

const MIGRATIONS = [
  initialMigration, exhaustedOutboxMigration, goalsMigration, outcomeMigration,
  goalAbandonedMigration, listsMigration, goalWeekMondayMigration, freeVentureTagsMigration,
];

function enableWal(db) {
  const deadline = Date.now() + WAL_RETRY_TIMEOUT_MS;
  while (true) {
    try {
      const mode = db.prepare('PRAGMA journal_mode = WAL').get().journal_mode;
      if (mode === 'wal') return;
      throw new Error(`Unable to enable WAL mode; SQLite returned ${mode}`);
    } catch (error) {
      const locked =
        error?.errcode === SQLITE_BUSY ||
        error?.errcode === SQLITE_LOCKED ||
        /\b(?:busy|locked)\b/i.test(error?.message ?? '');
      if (!locked || Date.now() >= deadline) throw error;
      Atomics.wait(walRetrySignal, 0, 0, WAL_RETRY_INTERVAL_MS);
    }
  }
}

function validateMigrations(migrations) {
  let previousVersion = 0;
  for (const migration of migrations) {
    if (
      !Number.isSafeInteger(migration.version) ||
      migration.version <= previousVersion ||
      typeof migration.migrate !== 'function'
    ) {
      throw new Error('Todo migrations must have ordered, unique positive integer versions');
    }
    previousVersion = migration.version;
  }
}

function migrateTodoDatabase(db, now, file) {
  validateMigrations(MIGRATIONS);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL,
      CONSTRAINT valid_applied_at_utc_timestamp CHECK (
        length(applied_at) = 24 AND
        applied_at GLOB
          '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
        strftime('%Y-%m-%dT%H:%M:%fZ', applied_at) IS NOT NULL AND
        strftime('%Y-%m-%dT%H:%M:%fZ', applied_at) = applied_at
      )
    ) STRICT
  `);
  const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
  const record = db.prepare(`
    INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)
  `);

  const existingInstall = Boolean(db.prepare('SELECT 1 FROM schema_migrations LIMIT 1').get());
  for (const migration of MIGRATIONS) {
    if (applied.get(migration.version)) continue;
    // A migration that rewrites data on an install that already has some gets a
    // copy of the database file written next to it first. VACUUM INTO is a
    // consistent snapshot, and it is synchronous like everything else here.
    if (migration.backupBefore && existingInstall && file && file !== ':memory:') {
      // pid + random suffix: two processes opening the same database at boot (the
      // bridge and the MCP gateway) must not collide on one target file.
      const stamp = `${now().replace(/[:.]/g, '-')}-${process.pid}-${randomBytes(3).toString('hex')}`;
      db.exec(`VACUUM INTO '${`${file}.pre-migration-${migration.version}-${stamp}`.replace(/'/g, "''")}'`);
    }
    // PRAGMA foreign_keys is a no-op inside a transaction, so a table rebuild that
    // must not fire ON DELETE CASCADE turns them off here and checks them itself.
    if (migration.foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF');
    try {
      withTodoTransaction(db, () => {
        if (applied.get(migration.version)) return;
        migration.migrate(db);
        if (migration.foreignKeysOff) {
          const broken = db.prepare('PRAGMA foreign_key_check').all();
          if (broken.length) {
            throw new Error(`Todo migration ${migration.version} left ${broken.length} broken foreign key reference(s)`);
          }
        }
        record.run(migration.version, now());
      });
    } finally {
      if (migration.foreignKeysOff) db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

export function openTodoDatabase({ file, now = () => new Date().toISOString() }) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON');
    enableWal(db);
    migrateTodoDatabase(db, now, file);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function withTodoTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function backupTodoDatabase({ db, destination }) {
  mkdirSync(dirname(destination), { recursive: true });
  await backup(db, destination);
  return destination;
}

export function exportTodoDatabase({ db, destination }) {
  const exported = withTodoTransaction(db, () => Object.fromEntries([
    ['formatVersion', FORMAT_VERSION],
    ...TABLES.map(({ name, orderBy }) => [
      name,
      db.prepare(`SELECT * FROM ${name} ORDER BY ${orderBy}`).all(),
    ]),
  ]));
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(exported, null, 2)}\n`, 'utf8');
  return destination;
}

function readAndValidateExport(source) {
  const exported = JSON.parse(readFileSync(source, 'utf8'));
  if (!exported || exported.formatVersion !== FORMAT_VERSION) {
    throw new Error(`Todo export must use formatVersion ${FORMAT_VERSION}`);
  }
  for (const { name } of TABLES) {
    if (!Array.isArray(exported[name])) {
      throw new Error(`Todo export table ${name} must be an array`);
    }
  }
  return exported;
}

function insertRows(db, table, rows) {
  const allowedColumns = new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => name),
  );
  for (const row of rows) {
    if (!row || Array.isArray(row) || typeof row !== 'object') {
      throw new Error(`Todo export table ${table} contains an invalid row`);
    }
    const columns = Object.keys(row);
    if (columns.length === 0 || columns.some(column => !allowedColumns.has(column))) {
      throw new Error(`Todo export table ${table} contains invalid columns`);
    }
    const placeholders = columns.map(() => '?').join(', ');
    db.prepare(`
      INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})
    `).run(...columns.map(column => row[column]));
  }
}

export function restoreTodoDatabase({ source, destination }) {
  const exported = readAndValidateExport(source);
  const db = openTodoDatabase({ file: destination });
  try {
    withTodoTransaction(db, () => {
      for (const table of DELETE_ORDER) {
        db.exec(`DELETE FROM ${table}`);
      }
      for (const table of RESTORE_ORDER) {
        insertRows(db, table, exported[table]);
      }
      // An export from before venture tags were configurable carries tagged tasks
      // but no tag list; without this the board would offer none of them.
      freeVentureTagsMigration.reconcileVentureTags(db);
    });
  } finally {
    closeTodoDatabase(db);
  }
  return destination;
}

export function closeTodoDatabase(db) {
  db.close();
}
