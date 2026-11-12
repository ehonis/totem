export const version = 11;

// It rewrites rows on an existing install, so the runner copies the file first.
export const backupBefore = true;

/**
 * No Doing status, and no GitHub task connector.
 *
 * A task is open or done. Every `doing` row becomes `todo`, placed above the open
 * tasks in the order it already had, so what was in progress stays at the top and
 * no `todo` row moves. Positions are REAL, so the rows go below the smallest open
 * position rather than renumbering the column.
 *
 * The GitHub connector imported issues as tasks. Those are archived (restorable
 * from the archive, nothing deleted), and its unfinished queued writes are dropped,
 * since nothing will ever send them. Completed outbox rows stay as history.
 *
 * `updated_at` is left alone on the status change: the owner did not edit those
 * tasks. Archiving stamps both columns, as archiving a task by hand does.
 *
 * Idempotent: a second run finds no `doing` row, no unarchived GitHub task and no
 * open GitHub outbox row, and changes nothing.
 */
export function migrate(db) {
  // A queued `create` was an issue the owner approved that was never filed. It is
  // dropped with the rest (nothing will ever send it), but named in the action log,
  // and the pre-migration backup still holds the row and its body.
  const unfiled = db.prepare(`
    SELECT o.id, o.todo_id, o.payload, o.status, t.title
    FROM sync_outbox o LEFT JOIN todos t ON t.id = o.todo_id
    WHERE o.connector = 'github' AND o.operation = 'create' AND o.status <> 'completed'
    ORDER BY o.created_at, o.id
  `).all();

  const doing = db.prepare(`
    SELECT id FROM todos WHERE status = 'doing' ORDER BY position, id
  `).all();
  if (doing.length) {
    const { base } = db.prepare(`
      SELECT COALESCE(MIN(position), 0) AS base FROM todos WHERE status = 'todo'
    `).get();
    const update = db.prepare(`UPDATE todos SET status = 'todo', position = ? WHERE id = ?`);
    doing.forEach(({ id }, index) => update.run(base - doing.length + index, id));
  }

  db.exec(`
    UPDATE todos
    SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE deleted_at IS NULL
      AND archived_at IS NULL
      AND EXISTS (
        SELECT 1 FROM external_links el
        WHERE el.todo_id = todos.id AND el.connector = 'github'
      );

    DELETE FROM sync_outbox WHERE connector = 'github' AND status <> 'completed';
  `);

  return {
    actions: unfiled.map((row) => {
      let repo = null;
      try { repo = JSON.parse(row.payload)?.repo ?? null; } catch { /* kept as null */ }
      const title = row.title ?? '(task no longer exists)';
      return {
        action: 'todo.github-outbox.drop',
        actor: 'system',
        target: row.todo_id ?? row.id,
        status: 'ok',
        summary: `Dropped the unfiled GitHub issue "${title}"${repo ? ` for ${repo}` : ''}: the GitHub task connector was removed. The todos.db.pre-migration-11 backup holds it.`,
        why: 'Migration 011 removed the GitHub task connector; its queued writes can never be sent.',
        detail: { outboxId: row.id, operation: 'create', status: row.status, repo, title },
      };
    }),
  };
}
