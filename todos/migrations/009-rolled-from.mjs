export const version = 9;

/**
 * A repeating task remembers the occurrence it was rolled from.
 *
 * Completing a repeating task inserts its next occurrence. Without a record of that,
 * completing, reopening and completing again rolled a second copy of the same next
 * date. `rolled_from` names the task a row was rolled from, and the unique index lets
 * each task roll at most once, for good: reopening keeps the rolled row, and a rolled
 * row in the recycle bin still counts. Purging the source clears the link.
 *
 * The foreign key is deferred so a restore can write rows in any order inside its
 * transaction (an export orders todos by id, not by series).
 */
export function migrate(db) {
  // Idempotent: a database that already has the column is left alone.
  const columns = db.prepare('PRAGMA table_info(todos)').all().map(({ name }) => name);
  if (!columns.includes('rolled_from')) {
    db.exec(`
      ALTER TABLE todos ADD COLUMN rolled_from TEXT
        REFERENCES todos(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED
    `);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS todos_rolled_from_unique
      ON todos(rolled_from) WHERE rolled_from IS NOT NULL
  `);
}
