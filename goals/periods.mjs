/**
 * The window a goal is trying to be true by: this week, this month, this quarter, this
 * year, or a range you picked.
 *
 * Pure — no SQLite, no React. The web view renders these, the HTTP routes validate
 * against them, and an MCP tool turns a shortcut like "next_week" into real dates using
 * exactly this code, so a model reading a photo of a notebook never has to derive a date.
 *
 * ## Monday-start, local days
 *
 * Weeks run Monday to Sunday in `MORNING_BRIEFING_TZ`. They used to run Sunday to
 * Saturday; Monday-start weeks match how weekly plans are usually written, the optional
 * Bushido app's quotas are Monday-to-Sunday, and the Sunday-evening review reads
 * far better as "how did the week go" than as "the week just started". Every other week
 * on this box moved with it — `notify/signals.mjs` (habit weekly targets), the habit grid
 * in `web/src/components/HabitsView.tsx`, and `strava/shape.mjs` (mileage buckets) — and
 * `todos/migrations/007-goal-week-monday.mjs` slid the stored week goals along by a day.
 * Two different week starts in one app is a bug that only shows up on the first of a
 * month, which is why they all changed together.
 *
 * Periods are local days, not UTC days. The whole box runs on one local clock, and a
 * goal is a personal deadline — if it is Sunday evening where you are, the week is over.
 *
 * ## Why a period is two date strings and not two instants
 *
 * A day key is `YYYY-MM-DD`, the same shape and the same CHECK constraint as
 * `todos.due_date`. Once "today" has been resolved to a local day key exactly once, every
 * other calculation here is plain calendar arithmetic that no timezone can perturb — which
 * is why nothing below this line touches a timezone, and why DST cannot move a week
 * boundary.
 *
 * ## Why the week key is a date and not "2026-W37"
 *
 * The key is the start day: sortable, unambiguous, and it means the same thing in every
 * period type. A Monday-start week would now agree with its ISO week number, but a key
 * that is also the range's first day needs no second definition to stay honest, and the
 * rows already store it that way.
 *
 * ## Looking back
 *
 * `last_week` / `last_month` / `last_quarter` / `last_year` resolve the period before the
 * current one, and `previousPeriod()` steps any window back — the pair to `nextPeriod()`.
 * They exist because a week that has just ended is the one worth investigating, and a
 * view that could only show the current window lost every finished week on Monday morning.
 */

import { localParts } from '../jobs/schedule.mjs';

export const DEFAULT_TIME_ZONE = process.env.MORNING_BRIEFING_TZ || 'America/New_York';

/** The period types a goal can have. A plain string on the row, as `todos.status` is. */
export const GOAL_PERIOD_KEYS = ['week', 'month', 'quarter', 'year', 'custom'];

export function isGoalPeriodKey(value) {
  return typeof value === 'string' && GOAL_PERIOD_KEYS.includes(value);
}

/**
 * The named windows a caller may ask for instead of computing dates.
 *
 * This is the one affordance that makes unattended import safe. Asking a model to turn
 * "this week" into a pair of dates means asking it to know today's date, the week-start
 * convention and the timezone, and to get all three right every time. It resolves here
 * instead, from the box's own clock. Same reason the todo snooze presets exist.
 */
export const GOAL_PERIOD_SHORTCUTS = [
  'last_week', 'this_week', 'next_week',
  'last_month', 'this_month', 'next_month',
  'last_quarter', 'this_quarter', 'next_quarter',
  'last_year', 'this_year', 'next_year',
];

export function isGoalPeriodShortcut(value) {
  return typeof value === 'string' && GOAL_PERIOD_SHORTCUTS.includes(value);
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_SHORT = MONTH_NAMES.map((name) => name.slice(0, 3));

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (value, width = 2) => String(value).padStart(width, '0');

/** Today where you are, as a day key. The only function here that knows about clocks. */
export function todayKey(now = new Date(), tz = DEFAULT_TIME_ZONE) {
  const p = localParts(now instanceof Date ? now.getTime() : now, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function isDayKey(value) {
  if (typeof value !== 'string') return false;
  const m = DAY_KEY.exec(value);
  if (!m) return false;
  // Round-trip through the calendar so 2026-02-31 fails rather than silently rolling.
  return keyOf(calendarDate(+m[1], +m[2], +m[3])) === value;
}

// A UTC Date used purely as a calendar. Nothing here is ever rendered as an instant or
// compared against a clock, so the zero-offset is an implementation detail, not a claim
// about when the day starts.
const calendarDate = (year, month, day) => new Date(Date.UTC(year, month - 1, day));

const dateOf = (key) => {
  const m = DAY_KEY.exec(String(key));
  if (!m) throw new Error(`not a day key: ${key}`);
  return calendarDate(+m[1], +m[2], +m[3]);
};

const keyOf = (date) =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

/** `n` days after a day key; negative goes back. */
export function addDays(key, n) {
  const d = dateOf(key);
  d.setUTCDate(d.getUTCDate() + n);
  return keyOf(d);
}

/** 0 = Sunday … 6 = Saturday, matching `localParts().weekday` and `Date#getDay`. */
export function weekdayOf(key) {
  return dateOf(key).getUTCDay();
}

// Every period's end is the day before the *next* period's start, never a fixed number
// of days added on. That is what keeps February, leap years and 31-day months correct
// without a single special case.
function endBefore(startKey) {
  return addDays(startKey, -1);
}

function weekOf(key) {
  // Monday is day 1, so a Sunday (0) sits six days into its week, not at the start of it.
  const start = addDays(key, -((weekdayOf(key) + 6) % 7));
  return { start, end: addDays(start, 6) };
}

function monthOf(key) {
  const d = dateOf(key);
  const start = keyOf(calendarDate(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  const next = keyOf(calendarDate(d.getUTCFullYear(), d.getUTCMonth() + 2, 1));
  return { start, end: endBefore(next) };
}

function quarterOf(key) {
  const d = dateOf(key);
  const firstMonth = Math.floor(d.getUTCMonth() / 3) * 3 + 1;
  const start = keyOf(calendarDate(d.getUTCFullYear(), firstMonth, 1));
  const next = keyOf(calendarDate(d.getUTCFullYear(), firstMonth + 3, 1));
  return { start, end: endBefore(next) };
}

function yearOf(key) {
  const year = dateOf(key).getUTCFullYear();
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

const RANGE_OF = { week: weekOf, month: monthOf, quarter: quarterOf, year: yearOf };

/** How far to step to reach the same period type, one along. Used by postpone. */
function advance(type, startKey) {
  if (type === 'week') return addDays(startKey, 7);
  const d = dateOf(startKey);
  if (type === 'month') return keyOf(calendarDate(d.getUTCFullYear(), d.getUTCMonth() + 2, 1));
  if (type === 'quarter') return keyOf(calendarDate(d.getUTCFullYear(), d.getUTCMonth() + 4, 1));
  if (type === 'year') return `${d.getUTCFullYear() + 1}-01-01`;
  throw new Error(`cannot advance a ${type} period`);
}

/** The start of the period of `type` before the one starting at `startKey`. */
function retreat(type, startKey) {
  if (type === 'week') return addDays(startKey, -7);
  const d = dateOf(startKey);
  if (type === 'month') return keyOf(calendarDate(d.getUTCFullYear(), d.getUTCMonth(), 1));
  if (type === 'quarter') return keyOf(calendarDate(d.getUTCFullYear(), d.getUTCMonth() - 2, 1));
  if (type === 'year') return `${d.getUTCFullYear() - 1}-01-01`;
  throw new Error(`cannot step back a ${type} period`);
}

export function periodKey(type, start, end) {
  if (type === 'week') return start;
  if (type === 'month') return start.slice(0, 7);
  if (type === 'quarter') return `${start.slice(0, 4)}-Q${Math.floor(dateOf(start).getUTCMonth() / 3) + 1}`;
  if (type === 'year') return start.slice(0, 4);
  return `${start}..${end}`;
}

function dayLabel(key, { year = false } = {}) {
  const d = dateOf(key);
  const base = `${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return year ? `${base}, ${d.getUTCFullYear()}` : base;
}

export function periodLabel(type, start, end) {
  const from = dateOf(start);
  const to = dateOf(end);
  if (type === 'month') return `${MONTH_NAMES[from.getUTCMonth()]} ${from.getUTCFullYear()}`;
  if (type === 'quarter') return `Q${Math.floor(from.getUTCMonth() / 3) + 1} ${from.getUTCFullYear()}`;
  if (type === 'year') return String(from.getUTCFullYear());
  // A range that stays inside one month reads "Sep 13 – 19"; one that crosses a
  // boundary has to name both months, and one that crosses a year has to name both.
  if (from.getUTCFullYear() !== to.getUTCFullYear()) {
    return `${dayLabel(start, { year: true })} – ${dayLabel(end, { year: true })}`;
  }
  const tail = from.getUTCMonth() === to.getUTCMonth()
    ? `${to.getUTCDate()}`
    : dayLabel(end);
  return `${dayLabel(start)} – ${tail}, ${to.getUTCFullYear()}`;
}

function describe(type, start, end) {
  return { type, start, end, key: periodKey(type, start, end), label: periodLabel(type, start, end) };
}

/** The period of `type` containing `dayKey`. */
export function periodContaining(type, dayKey) {
  const range = RANGE_OF[type];
  if (!range) throw new Error(`no natural period for type ${type}`);
  const { start, end } = range(dayKey);
  return describe(type, start, end);
}

/** The next period of the same type — what postponing moves a goal to. */
export function nextPeriod(period) {
  if (period.type === 'custom') {
    // A custom range has no natural successor, so it moves by its own length. A
    // one-off "the next two weeks" postponed becomes the two weeks after that.
    const span = Math.round((dateOf(period.end) - dateOf(period.start)) / 86_400_000) + 1;
    const start = addDays(period.start, span);
    return describe('custom', start, addDays(period.end, span));
  }
  const start = advance(period.type, period.start);
  return describe(period.type, start, endBefore(advance(period.type, start)));
}

/** The period before this one — what "last week" means, and what the ‹ arrow shows. */
export function previousPeriod(period) {
  if (period.type === 'custom') {
    const span = Math.round((dateOf(period.end) - dateOf(period.start)) / 86_400_000) + 1;
    return describe('custom', addDays(period.start, -span), addDays(period.end, -span));
  }
  const start = retreat(period.type, period.start);
  return describe(period.type, start, endBefore(period.start));
}

/**
 * Turn whatever a caller asked for into a real window.
 *
 * Accepts a shortcut name, or `{ type, start, end }` where `custom` needs both dates and
 * every other type needs only a date it should contain.
 */
export function resolvePeriod(input, { now = new Date(), tz = DEFAULT_TIME_ZONE } = {}) {
  const today = todayKey(now, tz);

  if (isGoalPeriodShortcut(input)) {
    const [when, unit] = input.split('_');
    const current = periodContaining(unit, today);
    if (when === 'next') return nextPeriod(current);
    if (when === 'last') return previousPeriod(current);
    return current;
  }

  if (typeof input === 'string') throw new Error(`unknown period shortcut: ${input}`);
  if (!input || typeof input !== 'object') throw new Error('a period needs a type');

  const { type, start, end } = input;
  if (!isGoalPeriodKey(type)) throw new Error(`unknown period type: ${type}`);

  if (type === 'custom') {
    if (!isDayKey(start) || !isDayKey(end)) throw new Error('a custom period needs a start and an end');
    if (start > end) throw new Error('a custom period cannot end before it starts');
    return describe('custom', start, end);
  }

  const anchor = start === undefined || start === null ? today : start;
  if (!isDayKey(anchor)) throw new Error(`not a day key: ${anchor}`);
  return periodContaining(type, anchor);
}

/** Where a window sits relative to today. Nothing acts on this — the UI reads it. */
export function periodState(period, today) {
  if (today < period.start) return 'upcoming';
  if (today > period.end) return 'expired';
  return 'active';
}

/** Days remaining including today; 0 once the window has closed. */
export function daysLeft(period, today) {
  if (today > period.end) return 0;
  const from = today < period.start ? period.start : today;
  return Math.round((dateOf(period.end) - dateOf(from)) / 86_400_000) + 1;
}
