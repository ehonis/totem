export const version = 8;

// The table rebuild below drops `todos`. With foreign keys on, that DROP would run
// every ON DELETE CASCADE in the database (notes, links, goal links, list rows), so
// the runner turns them off around this migration, then checks them before commit.
export const foreignKeysOff = true;
// An existing database gets a timestamped copy written next to it first.
export const backupBefore = true;

export const VENTURE_TAGS_KEY = 'ventureTags';
function dateCheck(column) {
  return `CONSTRAINT valid_${column}_date CHECK (
    ${column} IS NULL OR (
      length(${column}) = 10 AND
      ${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND
      date(${column}) IS NOT NULL AND
      date(${column}) = ${column}
    )
  )`;
}

function timestampCheck(column, { nullable = true } = {}) {
  const nullCase = nullable ? `${column} IS NULL OR ` : '';
  return `CONSTRAINT valid_${column}_utc_timestamp CHECK (
    ${nullCase}(
      length(${column}) = 24 AND
      ${column} GLOB
        '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
      strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) IS NOT NULL AND
      strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) = ${column}
    )
  )`;
}

const COLUMNS = [
  'id', 'title', 'description', 'area', 'venture_tag', 'status', 'priority', 'due_date',
  'recurrence', 'snoozed_until', 'position', 'created_at', 'updated_at', 'completed_at',
  'archived_at', 'deleted_at', 'outcome',
];

/**
 * Venture tags stop being a fixed list.
 *
 * Databases created before this migration have a CHECK constraint naming a fixed
 * set of tags (migration 001 has since been edited to the generic form, so a fresh
 * database never gets it and this rebuild is skipped). They are now
 * configured per install (todo_preferences key `ventureTags`, edited in the task
 * settings) and validated by the service, so the constraint only keeps the shape:
 * a Personal task has no tag, a Ventures task has one non-empty tag.
 *
 * SQLite cannot drop a CHECK, so this is the documented 12-step table rebuild:
 * new table, copy, drop, rename, recreate indexes and triggers, foreign_key_check.
 * Column order and every other constraint are exactly 001 + 004's.
 */
export function migrate(db) {
  const current = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'todos'").get();
  // Idempotent: a database already rebuilt (or created without the old list) is left alone.
  if (current && /venture_tag IN \(/.test(current.sql)) {
    const indexes = db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'todos' AND sql IS NOT NULL
    `).all().map(row => row.sql);
    // Triggers that mention todos anywhere, including ones on other tables (the
    // append-only notes trigger reads todos), so the rename cannot trip on them.
    const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all()
      .filter(row => /\btodos\b/.test(row.sql));
    for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`);

    db.exec(`
      CREATE TABLE todos_rebuilt (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        area TEXT NOT NULL,
        venture_tag TEXT,
        status TEXT NOT NULL DEFAULT 'todo',
        priority INTEGER NOT NULL DEFAULT 1,
        due_date TEXT,
        recurrence TEXT,
        snoozed_until TEXT,
        position REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        archived_at TEXT,
        deleted_at TEXT,
        outcome TEXT
          CONSTRAINT valid_outcome CHECK (
            outcome IS NULL OR (status = 'done' AND outcome IN ('completed', 'not_doing'))
          ),
        CONSTRAINT valid_area CHECK (area IN ('Personal', 'Ventures')),
        CONSTRAINT valid_status CHECK (status IN ('todo', 'doing', 'done')),
        CONSTRAINT valid_priority CHECK (priority BETWEEN 1 AND 4),
        CONSTRAINT valid_venture_classification CHECK (
          (area = 'Personal' AND venture_tag IS NULL) OR
          (area = 'Ventures' AND venture_tag IS NOT NULL AND
            length(trim(venture_tag)) BETWEEN 1 AND 40)
        ),
        ${dateCheck('due_date')},
        ${timestampCheck('snoozed_until')},
        ${timestampCheck('created_at', { nullable: false })},
        ${timestampCheck('updated_at', { nullable: false })},
        ${timestampCheck('completed_at')},
        ${timestampCheck('archived_at')},
        ${timestampCheck('deleted_at')}
      ) STRICT;

      INSERT INTO todos_rebuilt (${COLUMNS.join(', ')}) SELECT ${COLUMNS.join(', ')} FROM todos;
      DROP TABLE todos;
      ALTER TABLE todos_rebuilt RENAME TO todos;
    `);
    for (const sql of indexes) db.exec(sql);
    for (const trigger of triggers) db.exec(trigger.sql);
  }

  reconcileVentureTags(db);
}

/**
 * Make sure every venture tag the tasks carry is in the configured list, adding
 * any that are missing (first-used first, no colour). Used by this migration on an
 * existing board and after a restore, since an export taken before tags were
 * configurable has rows with tags but no list. A database with no venture tasks
 * writes nothing: no row at all means "no tags". Returns the names it added.
 */
export function reconcileVentureTags(db) {
  const found = db.prepare(`
    SELECT venture_tag AS name, min(created_at) AS first FROM todos
    WHERE venture_tag IS NOT NULL GROUP BY venture_tag ORDER BY first, name
  `).all().map(row => row.name);
  if (!found.length) return [];
  const row = db.prepare('SELECT value_json FROM todo_preferences WHERE key = ?').get(VENTURE_TAGS_KEY);
  let list = [];
  try { list = row ? JSON.parse(row.value_json) : []; } catch { list = []; }
  if (!Array.isArray(list)) list = [];
  const have = new Set(list.map(tag => String(tag?.name ?? '').toLowerCase()));
  const added = found.filter(name => !have.has(name.toLowerCase()));
  if (!added.length) return [];
  db.prepare(`
    INSERT INTO todo_preferences (key, value_json, updated_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(VENTURE_TAGS_KEY, JSON.stringify([...list, ...added.map(name => ({ name, color: null }))]));
  return added;
}
