export const version = 12;

// It rewrites rows on an existing install, so the runner copies the file first.
export const backupBefore = true;

/**
 * The two-way task sheet sync is retired (docs/task-sheet.md). The sheet is now a
 * read-only feed (todos/connectors/task-sheet-feed.mjs), so what the sync left in
 * the task database is cleared:
 *
 * - Its outbox rows go, finished or not. Nothing will ever send the open ones, and
 *   left in place they kept a task "Sync pending" or "conflict" for ever.
 * - Its connector state goes (cursor, watermark, last error).
 * - Tasks it linked to sheet rows are archived (restorable from the archive,
 *   nothing deleted). The same rows now arrive through the feed; left open, each
 *   would show twice. The link itself stays, as history.
 *
 * Archiving stamps `archived_at` and `updated_at`, as archiving a task by hand does.
 *
 * Idempotent: a second run finds no sheet outbox or state row and no unarchived
 * sheet-linked task, and changes nothing.
 */
export function migrate(db) {
  db.exec(`
    UPDATE todos
    SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE deleted_at IS NULL
      AND archived_at IS NULL
      AND EXISTS (
        SELECT 1 FROM external_links el
        WHERE el.todo_id = todos.id AND el.connector = 'sheet'
      );

    DELETE FROM sync_outbox WHERE connector = 'sheet';
    DELETE FROM connector_state WHERE connector = 'sheet';
  `);
}
