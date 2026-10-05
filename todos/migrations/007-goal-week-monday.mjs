export const version = 7;

/**
 * The week now starts on Monday.
 *
 * Until 2026-09-20 `goals/periods.mjs` cut weeks Sunday to Saturday, so every weekly
 * goal on disk is stored as one — `2026-09-13..2026-09-19` for the week the owner's own
 * notebook headed "Mon 14 Sep". Reads match a goal to its window by EXACT start and
 * end (`listGoals` does `period_start = ? AND period_end = ?`), so under the new
 * calendar those rows would belong to no week at all and vanish from every view.
 *
 * Each Sunday-start week slides forward one day onto the Monday-start week it overlaps
 * six days of. That is the week he was actually working to, and it is the mapping the
 * client keys already assert. Only top-level rows carry dates (steps hold none, by
 * constraint), and only rows whose start is a Sunday move — a row already on a Monday
 * is left alone, so running this twice changes nothing.
 *
 * Deleted rows move too. They are still that week's history, and a restore that put
 * one back on a Sunday would strand it exactly the way this exists to prevent.
 */
export function migrate(db) {
  db.exec(`
    UPDATE goals
      SET period_start = date(period_start, '+1 day'),
          period_end = date(period_end, '+1 day')
      WHERE period_type = 'week'
        AND parent_id IS NULL
        AND strftime('%w', period_start) = '0';
  `);
}
