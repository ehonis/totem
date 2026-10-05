// Shared by the todo tests. Venture tags are configured per install now (migration
// 008); the tests' fixtures use these three, so their databases get them written
// straight into todo_preferences, without an audit record a test might count.
export const TEST_VENTURE_TAGS = ['Acme', 'Globex', 'Initech'];

export function seedVentureTags(db, names = TEST_VENTURE_TAGS) {
  db.prepare(`
    INSERT OR IGNORE INTO todo_preferences (key, value_json, updated_at)
    VALUES ('ventureTags', ?, '2026-01-01T00:00:00.000Z')
  `).run(JSON.stringify(names.map(name => ({ name, color: null }))));
  return db;
}
