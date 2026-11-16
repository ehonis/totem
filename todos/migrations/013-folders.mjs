export const version = 13;

/**
 * A task is filed under one of the owner's chat projects or folders (`folder_id`,
 * a chat project id from chat/projects.mjs), which replaces Personal/Ventures and
 * venture tags as the way tasks are organised. NULL is unfiled, which the clients
 * show as "Personal".
 *
 * Only the column: the project list lives with the chats, not in this database,
 * so carrying over existing filings (data/task-folders.json) and venture tags is
 * done once by the bridge, which has both (adoptTaskFolders in bridge.mjs). The
 * `area` and `venture_tag` columns stay for older clients and exports.
 */
export function migrate(db) {
  // Idempotent: a database that already has the column is left alone.
  const columns = db.prepare('PRAGMA table_info(todos)').all().map(({ name }) => name);
  if (!columns.includes('folder_id')) db.exec('ALTER TABLE todos ADD COLUMN folder_id TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS todos_folder_id ON todos(folder_id) WHERE folder_id IS NOT NULL');
}
