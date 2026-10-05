export const version = 5;

function timestampCheck(column) {
  return `CONSTRAINT valid_${column}_utc_timestamp CHECK (
    ${column} IS NULL OR (
      length(${column}) = 24 AND
      ${column} GLOB
        '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
      strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) IS NOT NULL AND
      strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) = ${column}
    )
  )`;
}

/**
 * A goal you have decided not to do.
 *
 * Its own column rather than an outcome on `completed_at`, because a goal's
 * completion is counted: "2 of 5 done" is the number the owner reads on a Sunday, and
 * filing an abandoned goal under completed_at would quietly inflate it. Abandoning
 * is also reversible — you can change your mind about a week — so it is a timestamp
 * that clears, exactly like deleted_at beside it.
 *
 * The postponed count keeps its meaning: a goal moved forward six weeks running is
 * one you have *not* decided about. This column is for the decision itself.
 */
export function migrate(db) {
  db.exec(`
    ALTER TABLE goals ADD COLUMN abandoned_at TEXT
      ${timestampCheck('abandoned_at')};
  `);
}
