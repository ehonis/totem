export const version = 3;

function dateCheck(column) {
  return `CONSTRAINT valid_${column}_date CHECK (
    ${column} IS NULL OR (
      length(${column}) = 10 AND
      ${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND
      date(${column}) IS NOT NULL AND
      date(${column}) = ${column}
    )
  )`;
}

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

// Goals: something you want to have become true by the end of a period.
//
// Three tables in the *todos* database rather than a file of their own, and that is
// the whole reason `goal_links.todo_id` can be a real foreign key: a goal pointing at
// a task is enforced by SQLite instead of by whoever remembers to clean up. They are a
// sibling of `todos`, deliberately not a flavour of it — a todo is a thing you do and
// then it is gone, while the useful questions about a goal ("how far through am I",
// "how many weeks have I pushed this") do not exist for a task.
export function migrate(db) {
  db.exec(`
    CREATE TABLE goals (
      id TEXT PRIMARY KEY,
      -- Idempotency key for imports, supplied by the caller. The authoring path is an
      -- agent reading a photo of a paper notebook, which has no natural "did I already
      -- do this"; without a key, importing the same page twice silently doubles the
      -- week and nothing surfaces it until the list looks wrong.
      client_key TEXT UNIQUE,
      title TEXT,
      notes TEXT NOT NULL DEFAULT '',
      parent_id TEXT REFERENCES goals(id) ON DELETE CASCADE,
      period_type TEXT,
      period_start TEXT,
      period_end TEXT,
      completed_at TEXT,
      -- How many times this has been pushed to a later period. Never reset. The most
      -- useful number in the table: a goal quietly moved forward six weeks running is
      -- a goal you have decided not to do, and this is the only thing that says so.
      postponed_count INTEGER NOT NULL DEFAULT 0,
      position REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      CONSTRAINT valid_period_type CHECK (
        period_type IS NULL OR
        period_type IN ('week', 'month', 'quarter', 'year', 'custom')
      ),
      -- A top-level goal owns a whole window; a sub-goal owns none of it and resolves
      -- the parent's at read time. Nothing in between is a legal row, which is what
      -- makes a child's dates structurally incapable of drifting from its parent's.
      CONSTRAINT period_belongs_to_top_level CHECK (
        (parent_id IS NULL AND
          period_type IS NOT NULL AND period_start IS NOT NULL AND period_end IS NOT NULL) OR
        (parent_id IS NOT NULL AND
          period_type IS NULL AND period_start IS NULL AND period_end IS NULL)
      ),
      CONSTRAINT period_is_ordered CHECK (period_start IS NULL OR period_start <= period_end),
      -- Nullable only on a sub-goal: "I want three of these, I don't know what they are
      -- yet" is a real state worth storing rather than making somebody invent names.
      CONSTRAINT top_level_goal_is_named CHECK (parent_id IS NOT NULL OR title IS NOT NULL),
      CONSTRAINT nonempty_title CHECK (title IS NULL OR length(trim(title)) > 0),
      CONSTRAINT valid_postponed_count CHECK (postponed_count >= 0),
      -- A sub-goal is never postponed on its own; the parent moves and carries it.
      CONSTRAINT only_top_level_is_postponed CHECK (parent_id IS NULL OR postponed_count = 0),
      ${dateCheck('period_start')},
      ${dateCheck('period_end')},
      ${timestampCheck('completed_at')},
      ${timestampCheck('created_at', { nullable: false })},
      ${timestampCheck('updated_at', { nullable: false })},
      ${timestampCheck('deleted_at')}
    ) STRICT;

    CREATE INDEX goals_period_idx ON goals (period_start, position, id);
    CREATE INDEX goals_parent_idx ON goals (parent_id, position, id);
    CREATE INDEX goals_delete_idx ON goals (deleted_at, id);

    -- One level of nesting, enforced here as well as in the service. Arbitrary depth
    -- would mean recursive rollup in every query, in the progress maths and in every
    -- MCP tool, for a case nobody has asked for.
    CREATE TRIGGER goals_one_level_on_insert
    BEFORE INSERT ON goals
    WHEN NEW.parent_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM goals WHERE id = NEW.parent_id AND parent_id IS NOT NULL)
    BEGIN
      SELECT RAISE(ABORT, 'goals nest one level deep');
    END;

    CREATE TRIGGER goals_one_level_on_update
    BEFORE UPDATE OF parent_id ON goals
    WHEN NEW.parent_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM goals WHERE id = NEW.parent_id AND parent_id IS NOT NULL)
    BEGIN
      SELECT RAISE(ABORT, 'goals nest one level deep');
    END;

    -- A goal that already has children cannot itself become somebody's child, which is
    -- the same one-level rule approached from the other end.
    CREATE TRIGGER goals_parent_cannot_be_adopted
    BEFORE UPDATE OF parent_id ON goals
    WHEN NEW.parent_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM goals WHERE parent_id = NEW.id)
    BEGIN
      SELECT RAISE(ABORT, 'goals nest one level deep');
    END;

    -- One number a goal is tracking, of however many it tracks. Its own table rather
    -- than columns on goals because a goal tracks several at once: a fitness goal
    -- counts miles run and miles biked. With the numbers in their own rows, "is this
    -- goal metric-tracked" is answered by whether it has any — which is why goals
    -- carries no tracking_type column, and why the two can never contradict.
    CREATE TABLE goal_metrics (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      unit TEXT,
      target_value REAL NOT NULL,
      -- This metric's OWN contribution only. What gets displayed is this plus the sum
      -- of the metrics rolling up into it. Keeping the stored number own-only is what
      -- lets a parent be logged against directly while its children also feed it,
      -- without anything being counted twice.
      current_value REAL NOT NULL DEFAULT 0,
      -- Rollup is an explicit edge, never a name match. Matching child to parent by
      -- label fails the moment an agent transcribing handwriting writes "miles" one
      -- week and "miles run" the next: the second silently stops counting, the total
      -- just reads low, and nothing anywhere says so.
      rolls_up_to_metric_id TEXT REFERENCES goal_metrics(id) ON DELETE SET NULL,
      -- Where the number comes from. 'manual' is typed in or logged by an agent;
      -- anything else is read from a connector at display time. Same split habits
      -- already run (HABIT_METRIC_SOURCES in bridge.mjs).
      source_kind TEXT NOT NULL DEFAULT 'manual',
      source_config TEXT NOT NULL DEFAULT '{}',
      position REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CONSTRAINT nonempty_metric_label CHECK (length(trim(label)) > 0),
      CONSTRAINT valid_target_value CHECK (target_value > 0),
      CONSTRAINT valid_current_value CHECK (current_value >= 0),
      CONSTRAINT valid_source_kind CHECK (
        source_kind IN ('manual', 'strava_distance', 'strava_gear_odometer')
      ),
      -- A sourced metric's number belongs to the connector, so the stored column stays
      -- at zero. One number, one owner — the same rule that keeps a GitHub-owned task
      -- from being completed locally.
      CONSTRAINT sourced_metric_stores_no_value CHECK (
        source_kind = 'manual' OR current_value = 0
      ),
      CONSTRAINT metric_does_not_feed_itself CHECK (
        rolls_up_to_metric_id IS NULL OR rolls_up_to_metric_id <> id
      ),
      ${timestampCheck('created_at', { nullable: false })},
      ${timestampCheck('updated_at', { nullable: false })}
    ) STRICT;

    CREATE INDEX goal_metrics_goal_idx ON goal_metrics (goal_id, position, id);
    CREATE INDEX goal_metrics_rollup_idx ON goal_metrics (rolls_up_to_metric_id, id);

    -- A bookmark on a goal: one of your own tasks, or a plain URL.
    --
    -- Deliberately not modelled on the external_links table beside it. Those exist to
    -- keep a mirror honest — they carry a synced status, a snapshot, a watermark and an
    -- outbox, with jobs behind them holding both sides together. These have none of
    -- that and never will: a goal referencing a task is you saying "this is related",
    -- not a claim that the two stay in step.
    CREATE TABLE goal_links (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      -- A real foreign key, which is the point of putting goals in this database. The
      -- cascade is deliberate: a deleted task should take its bookmark with it, because
      -- a link pointing at nothing is worse than no link at all.
      todo_id TEXT REFERENCES todos(id) ON DELETE CASCADE,
      url TEXT,
      -- What to show. A snapshot by definition, since nothing refreshes it.
      label TEXT NOT NULL,
      position REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      CONSTRAINT valid_link_kind CHECK (kind IN ('todo', 'url')),
      CONSTRAINT link_target_matches_kind CHECK (
        (kind = 'todo' AND todo_id IS NOT NULL AND url IS NULL) OR
        (kind = 'url' AND url IS NOT NULL AND todo_id IS NULL)
      ),
      CONSTRAINT nonempty_link_label CHECK (length(trim(label)) > 0),
      -- NULLs compare distinct in SQLite, so this pins one bookmark per task per goal
      -- while leaving URL bookmarks unconstrained.
      CONSTRAINT unique_goal_todo_link UNIQUE (goal_id, todo_id),
      ${timestampCheck('created_at', { nullable: false })}
    ) STRICT;

    CREATE INDEX goal_links_goal_idx ON goal_links (goal_id, position, id);
    CREATE INDEX goal_links_todo_idx ON goal_links (todo_id, id);
  `);
}
