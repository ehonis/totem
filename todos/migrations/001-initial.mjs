export const version = 1;

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

export function migrate(db) {
  db.exec(`
    CREATE TABLE todos (
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
      CONSTRAINT valid_area CHECK (area IN ('Personal', 'Ventures')),
      CONSTRAINT valid_status CHECK (status IN ('todo', 'doing', 'done')),
      CONSTRAINT valid_priority CHECK (priority BETWEEN 1 AND 4),
      CONSTRAINT valid_venture_classification CHECK (
        (area = 'Personal' AND venture_tag IS NULL) OR
        -- Originally a fixed list of tag names; generic since migration 008, which
        -- rebuilds databases created with the old list.
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

    CREATE INDEX todos_status_position_idx ON todos (status, position, id);
    CREATE INDEX todos_archive_idx ON todos (archived_at, id);
    CREATE INDEX todos_delete_idx ON todos (deleted_at, id);

    CREATE TABLE tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      created_at TEXT NOT NULL,
      ${timestampCheck('created_at', { nullable: false })}
    ) STRICT;

    CREATE TABLE todo_tags (
      todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (todo_id, tag_id),
      ${timestampCheck('created_at', { nullable: false })}
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE todo_notes (
      id TEXT PRIMARY KEY,
      todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CONSTRAINT nonempty_note_body CHECK (length(trim(body)) > 0),
      ${timestampCheck('created_at', { nullable: false })}
    ) STRICT;

    CREATE INDEX todo_notes_todo_created_idx ON todo_notes (todo_id, created_at, id);

    CREATE TRIGGER todo_notes_no_update
    BEFORE UPDATE ON todo_notes
    BEGIN
      SELECT RAISE(ABORT, 'todo notes are append-only');
    END;

    CREATE TRIGGER todo_notes_no_direct_delete
    BEFORE DELETE ON todo_notes
    WHEN EXISTS (SELECT 1 FROM todos WHERE id = OLD.todo_id)
    BEGIN
      SELECT RAISE(ABORT, 'todo notes are append-only');
    END;

    CREATE TABLE todo_relations (
      left_todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
      right_todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (left_todo_id, right_todo_id),
      CONSTRAINT canonical_relation_pair CHECK (left_todo_id < right_todo_id),
      ${timestampCheck('created_at', { nullable: false })}
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE external_links (
      id TEXT PRIMARY KEY,
      todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
      connector TEXT NOT NULL,
      external_id TEXT NOT NULL,
      external_url TEXT,
      source_status TEXT,
      source_snapshot TEXT,
      last_sync_snapshot TEXT,
      initial_status_seeded INTEGER NOT NULL DEFAULT 0,
      last_observed_at TEXT,
      last_synced_at TEXT,
      missing_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CONSTRAINT unique_external_identity UNIQUE (connector, external_id),
      CONSTRAINT valid_initial_status_seeded CHECK (initial_status_seeded IN (0, 1)),
      ${timestampCheck('last_observed_at')},
      ${timestampCheck('last_synced_at')},
      ${timestampCheck('missing_at')},
      ${timestampCheck('created_at', { nullable: false })},
      ${timestampCheck('updated_at', { nullable: false })}
    ) STRICT;

    CREATE INDEX external_links_todo_idx ON external_links (todo_id, connector, id);

    CREATE TABLE sync_outbox (
      id TEXT PRIMARY KEY,
      todo_id TEXT REFERENCES todos(id) ON DELETE CASCADE,
      connector TEXT NOT NULL,
      operation TEXT NOT NULL,
      payload TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      last_error TEXT,
      conflict_payload TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      CONSTRAINT unique_outbox_operation UNIQUE (connector, idempotency_key),
      CONSTRAINT valid_outbox_status CHECK (
        status IN ('pending', 'leased', 'retry', 'conflict', 'completed')
      ),
      CONSTRAINT valid_outbox_attempts CHECK (attempts >= 0),
      CONSTRAINT complete_outbox_has_time CHECK (
        status <> 'completed' OR completed_at IS NOT NULL
      ),
      ${timestampCheck('next_attempt_at')},
      ${timestampCheck('lease_expires_at')},
      ${timestampCheck('created_at', { nullable: false })},
      ${timestampCheck('updated_at', { nullable: false })},
      ${timestampCheck('completed_at')}
    ) STRICT;

    CREATE INDEX sync_outbox_ready_idx
      ON sync_outbox (connector, status, next_attempt_at, lease_expires_at, id);

    CREATE TABLE connector_state (
      connector TEXT PRIMARY KEY,
      cursor TEXT,
      watermark TEXT,
      settings_json TEXT NOT NULL DEFAULT '{}',
      lease_owner TEXT,
      lease_expires_at TEXT,
      last_success_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ${timestampCheck('watermark')},
      ${timestampCheck('lease_expires_at')},
      ${timestampCheck('last_success_at')},
      ${timestampCheck('created_at', { nullable: false })},
      ${timestampCheck('updated_at', { nullable: false })}
    ) STRICT;

    CREATE TABLE todo_preferences (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ${timestampCheck('updated_at', { nullable: false })}
    ) STRICT;

    CREATE TABLE todo_import_keys (
      source TEXT NOT NULL,
      external_id TEXT NOT NULL,
      todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
      source_snapshot TEXT,
      imported_at TEXT NOT NULL,
      PRIMARY KEY (source, external_id),
      ${timestampCheck('imported_at', { nullable: false })}
    ) STRICT, WITHOUT ROWID;

    CREATE INDEX todo_import_keys_todo_idx ON todo_import_keys (todo_id, source);
  `);
}
