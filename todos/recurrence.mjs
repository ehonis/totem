const RULES = new Set(['daily', 'weekdays', 'weekly', 'monthly', 'yearly']);

const DAY_MS = 86_400_000;

function parseDateOnly(value, field = 'dueDate') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${field} must be a YYYY-MM-DD date`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${field} must be a real calendar date`);
  }
  return parsed;
}

function formatDate(date) {
  return formatDateParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function formatDateParts(year, month, day) {
  if (!Number.isInteger(year) || year < 0 || year > 9999) {
    throw new RangeError('recurrence exceeds the supported date range 0000-01-01 through 9999-12-31');
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysInMonth(year, month) {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return formatDate(result);
}

function addCalendarMonths(date, months) {
  const day = date.getUTCDate();
  const monthIndex = date.getUTCFullYear() * 12 + date.getUTCMonth() + months;
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex % 12 + 1;
  return formatDateParts(year, month, Math.min(day, daysInMonth(year, month)));
}

function intervalDays(recurrence) {
  const match = /^interval:(\d+)$/.exec(recurrence);
  if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1) {
    throw new TypeError('recurrence interval must be a positive integer number of days');
  }
  return Number(match[1]);
}

function isWeekend(date) {
  return [0, 6].includes(date.getUTCDay());
}

/**
 * The next due date of a repeating task.
 *
 * Without `after`, one step from `dueDate`. With `after` (today's local date), the
 * first occurrence strictly after it, so a task finished late does not come back
 * already overdue; one finished early still steps exactly once. Day-based rules
 * jump by arithmetic, and month-based ones count months from `dueDate` itself, so
 * a series anchored on the 31st does not drift to the 28th on the way through.
 */
export function nextOccurrence({ dueDate, recurrence, after } = {}) {
  const parsed = parseDateOnly(dueDate);
  if (typeof recurrence !== 'string' || (!RULES.has(recurrence) && !recurrence.startsWith('interval:'))) {
    throw new TypeError('recurrence must be daily, weekdays, weekly, monthly, yearly, or interval:<days>');
  }
  const floor = after == null ? parsed : parseDateOnly(after, 'after');
  const behind = Math.max(0, Math.round((floor - parsed) / DAY_MS));

  const stepDays = recurrence === 'daily' ? 1
    : recurrence === 'weekly' ? 7
      : recurrence.startsWith('interval:') ? intervalDays(recurrence)
        : null;
  if (stepDays) return addDays(parsed, (Math.floor(behind / stepDays) + 1) * stepDays);

  if (recurrence === 'monthly' || recurrence === 'yearly') {
    const months = recurrence === 'monthly' ? 1 : 12;
    const monthsBehind = (floor.getUTCFullYear() - parsed.getUTCFullYear()) * 12
      + floor.getUTCMonth() - parsed.getUTCMonth();
    // Starts at most one step short of the answer, so this runs at most twice.
    let steps = Math.max(1, Math.floor(monthsBehind / months));
    let candidate = addCalendarMonths(parsed, steps * months);
    while (candidate <= (after ?? dueDate)) candidate = addCalendarMonths(parsed, ++steps * months);
    return candidate;
  }

  // weekdays: the first Monday-to-Friday after the later of the due date and today.
  let candidate = parseDateOnly(addDays(parsed, behind + 1));
  while (isWeekend(candidate)) candidate = parseDateOnly(addDays(candidate, 1));
  return formatDate(candidate);
}
