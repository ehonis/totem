export const version = 10;

const DAY = "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'";

/**
 * The recommendations ledger (recs/): what an agent advised, on what evidence, what
 * the owner decided, and how it turned out.
 *
 * It lives in the task database, not a file of its own, because it is the same kind
 * of record as a task or a goal (one owner's decisions, written a handful of times,
 * read back by agents) and it should be backed up, exported and restored with them.
 * The export format moved to 4 for it; a format 3 export still restores, since it
 * was taken before this table existed (see `since` on TABLES in db.mjs).
 *
 * `decision` is the owner's alone; recs/service.mjs refuses it from anything but the
 * dashboard. `review_on` is the day a deferred rec comes back as pending, which the
 * bridge's job tick does; `resurfaced_at` records that it did. `outcome_by` says who
 * reported the outcome (an agent cannot overwrite the owner's), and `changed_note` is
 * what an agent said had changed when it recorded something like a recent decline.
 */
export function migrate(db) {
  // Idempotent: IF NOT EXISTS throughout, so running it twice changes nothing.
  db.exec(`
    CREATE TABLE IF NOT EXISTS recs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      evidence TEXT NOT NULL DEFAULT '',
      cost_usd REAL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      act_by TEXT,
      review_on TEXT,
      decision TEXT NOT NULL DEFAULT 'pending',
      decided_at TEXT,
      decision_note TEXT,
      outcome TEXT,
      outcome_note TEXT,
      outcome_at TEXT,
      outcome_by TEXT,
      changed_note TEXT,
      resurfaced_at TEXT,
      CONSTRAINT nonempty_rec_title CHECK (length(trim(title)) > 0),
      CONSTRAINT nonempty_rec_source CHECK (length(trim(source)) > 0),
      CONSTRAINT valid_rec_cost CHECK (cost_usd IS NULL OR cost_usd >= 0),
      CONSTRAINT valid_rec_act_by CHECK (act_by IS NULL OR act_by GLOB ${DAY}),
      CONSTRAINT valid_rec_review_on CHECK (review_on IS NULL OR review_on GLOB ${DAY}),
      CONSTRAINT valid_rec_decision CHECK (decision IN ('pending', 'accepted', 'declined', 'deferred')),
      CONSTRAINT decided_rec_has_date CHECK (decision = 'pending' OR decided_at IS NOT NULL),
      CONSTRAINT deferred_rec_has_review CHECK (decision <> 'deferred' OR review_on IS NOT NULL),
      CONSTRAINT valid_rec_outcome CHECK (outcome IS NULL OR outcome IN ('worked', 'partly', 'failed')),
      CONSTRAINT outcome_rec_has_date CHECK (outcome IS NULL OR outcome_at IS NOT NULL),
      CONSTRAINT valid_rec_outcome_by CHECK (outcome_by IS NULL OR outcome_by IN ('owner', 'agent')),
      CONSTRAINT outcome_rec_has_reporter CHECK ((outcome IS NULL) = (outcome_by IS NULL))
    ) STRICT;

    CREATE INDEX IF NOT EXISTS recs_decision_idx ON recs (decision, decided_at);
    CREATE INDEX IF NOT EXISTS recs_deferred_review_idx ON recs (review_on) WHERE decision = 'deferred';
  `);
}
