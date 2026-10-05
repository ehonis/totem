export const version = 2;

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
    DROP INDEX sync_outbox_ready_idx;
    ALTER TABLE sync_outbox RENAME TO sync_outbox_before_exhausted;

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
        status IN ('pending', 'leased', 'retry', 'conflict', 'exhausted', 'completed')
      ),
      CONSTRAINT valid_outbox_attempts CHECK (attempts >= 0),
      CONSTRAINT complete_outbox_has_time CHECK (
        status <> 'completed' OR completed_at IS NOT NULL
      ),
      CONSTRAINT exhausted_outbox_is_unleased CHECK (
        status <> 'exhausted' OR (lease_owner IS NULL AND lease_expires_at IS NULL)
      ),
      ${timestampCheck('next_attempt_at')},
      ${timestampCheck('lease_expires_at')},
      ${timestampCheck('created_at', { nullable: false })},
      ${timestampCheck('updated_at', { nullable: false })},
      ${timestampCheck('completed_at')}
    ) STRICT;

    INSERT INTO sync_outbox SELECT * FROM sync_outbox_before_exhausted;
    DROP TABLE sync_outbox_before_exhausted;

    CREATE INDEX sync_outbox_ready_idx
      ON sync_outbox (connector, status, next_attempt_at, lease_expires_at, id);
  `);
}
