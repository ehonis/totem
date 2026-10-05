export const version = 6;

// Lists are intentionally smaller than tasks: a named container, ordered checkable
// lines, and optional bookmarks to real todos. The join table keeps the relationship
// symmetric and queryable without pretending that every grocery item is a task.
export function migrate(db) {
  db.exec(`
    CREATE TABLE lists (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      position REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CONSTRAINT nonempty_list_title CHECK (length(trim(title)) > 0)
    ) STRICT;

    CREATE INDEX lists_position_idx ON lists (position, id);

    CREATE TABLE list_items (
      id TEXT PRIMARY KEY,
      list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      checked INTEGER NOT NULL DEFAULT 0,
      position REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CONSTRAINT nonempty_list_item CHECK (length(trim(text)) > 0),
      CONSTRAINT valid_list_item_checked CHECK (checked IN (0, 1))
    ) STRICT;

    CREATE INDEX list_items_list_idx ON list_items (list_id, position, id);

    CREATE TABLE list_todos (
      list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (list_id, todo_id)
    ) STRICT, WITHOUT ROWID;

    CREATE INDEX list_todos_todo_idx ON list_todos (todo_id, list_id);
  `);
}
