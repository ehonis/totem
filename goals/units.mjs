/**
 * What a metric counts.
 *
 * Free text, lowercased on write, with the list below offered as suggestions in the UI
 * and named in the MCP tool descriptions so an agent transcribing a notebook proposes
 * "miles" rather than inventing "mi".
 *
 * Not an enum and not a table: the point of the feature is that a goal can count
 * anything — miles, tickets, chapters, gym sessions — and a user-managed table would be
 * a second CRUD surface for what is, in the end, a word. Tags already cost this repo one
 * of those, for a case that genuinely needed colours.
 *
 * The suggestions are not a validation list; anything typed is accepted. They exist so
 * the common cases converge on one spelling. That matters less than it looks like it
 * should, because rollup here is an explicit edge and never a name match — so two
 * spellings cost a cosmetic inconsistency rather than a silently wrong total.
 */

/** Grouped only so a picker can show headings; the value stored is the bare string. */
export const COMMON_UNITS = {
  Distance: ['miles', 'km', 'steps', 'laps', 'flights'],
  Time: ['minutes', 'hours', 'days', 'sessions', 'workouts'],
  Work: ['tickets', 'issues', 'PRs', 'reviews', 'deploys', 'articles', 'docs', 'calls'],
  Learning: ['pages', 'chapters', 'books', 'courses', 'lessons', 'problems'],
  Health: ['reps', 'sets', 'calories', 'liters', 'glasses', 'pounds'],
  Money: ['dollars', 'sales', 'deals'],
  Generic: ['times', 'items', 'tasks', 'points', 'percent'],
};

/** Flat list, for a datalist or an MCP tool description. */
export const ALL_COMMON_UNITS = Object.values(COMMON_UNITS).flat();

/**
 * How a unit is stored: trimmed, whitespace collapsed, lowercased, or null when absent.
 *
 * Lowercasing is what makes "Miles" and "miles" the same suggestion next time. It does
 * mean a genuine initialism renders lowercase ("prs"), a cosmetic loss the UI can fix at
 * render time if it ever matters.
 */
export function normalizeUnit(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/\s+/g, ' ').toLowerCase();
  return cleaned.length > 0 ? cleaned.slice(0, 24) : null;
}

/**
 * "12 / 40 miles", or "12 / 40" when there is no unit.
 *
 * Whole numbers read as whole — "12 miles", not "12.00 miles" — while a genuine fraction
 * keeps up to two places. Dividing by 100 after rounding already drops trailing zeros, so
 * there is no toFixed here to pad them back out again.
 */
export function formatAmount(value, unit) {
  const text = String(Math.round(value * 100) / 100);
  return unit ? `${text} ${unit}` : text;
}
