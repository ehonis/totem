const RULES = new Set(['daily', 'weekdays', 'weekly', 'monthly', 'yearly']);

function parseDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError('dueDate must be a YYYY-MM-DD date');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError('dueDate must be a real calendar date');
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

export function nextOccurrence({ dueDate, recurrence } = {}) {
  const parsed = parseDateOnly(dueDate);
  if (typeof recurrence !== 'string' || (!RULES.has(recurrence) && !recurrence.startsWith('interval:'))) {
    throw new TypeError('recurrence must be daily, weekdays, weekly, monthly, yearly, or interval:<days>');
  }
  if (recurrence === 'daily') return addDays(parsed, 1);
  if (recurrence === 'weekly') return addDays(parsed, 7);
  if (recurrence === 'monthly') return addCalendarMonths(parsed, 1);
  if (recurrence === 'yearly') return addCalendarMonths(parsed, 12);
  if (recurrence.startsWith('interval:')) return addDays(parsed, intervalDays(recurrence));

  let candidate = addDays(parsed, 1);
  while ([0, 6].includes(parseDateOnly(candidate).getUTCDay())) candidate = addDays(parseDateOnly(candidate), 1);
  return candidate;
}
