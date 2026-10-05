export const version = 4;

/**
 * A completed task now records *how* it ended.
 *
 * "Done" and "not doing" both take a task off the board, but they are not the same
 * claim: one says the work happened, the other says it never will. Collapsing them
 * loses the second answer entirely, and a tag would only be a convention. So the
 * outcome is a column, constrained to the two words that mean anything, and only on
 * a row that is actually finished — an unfinished task has no outcome yet.
 *
 * NULL on an existing done row reads as 'completed': everything archived before this
 * migration was, by the only mechanism that existed, actually done.
 */
export function migrate(db) {
  db.exec(`
    ALTER TABLE todos ADD COLUMN outcome TEXT
      CONSTRAINT valid_outcome CHECK (
        outcome IS NULL OR (status = 'done' AND outcome IN ('completed', 'not_doing'))
      );

    CREATE INDEX todos_outcome_idx ON todos (outcome, completed_at);
  `);
}
