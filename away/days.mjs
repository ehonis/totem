/**
 * Away spans as plain day keys: which days the owner is away, and which spans matter now.
 *
 * Pure, like goals/periods.mjs, whose helpers this builds on. A span is two inclusive
 * `YYYY-MM-DD` keys in the owner's own time zone; once "today" has been resolved to a day
 * key (`todayKey`, the one place a clock and a zone meet), everything below is calendar
 * arithmetic that no time zone or DST change can move.
 */

import { addDays, isDayKey, todayKey } from '../goals/periods.mjs';

export const AWAY_KINDS = ['trip', 'off', 'other'];
export const AWAY_KIND_LABELS = { trip: 'Trip', off: 'Day off', other: 'Away' };

/** The first span covering `dayKey`, or null. */
export function awayOn(spans, dayKey) {
  if (!isDayKey(dayKey)) return null;
  return (spans || []).find((s) => s.start <= dayKey && dayKey <= s.end) || null;
}

/** Whether the local day containing the instant `at` is an away day. */
export function awayAt(spans, at, tz) {
  return awayOn(spans, todayKey(at instanceof Date ? at : new Date(at), tz));
}

// A day key as a whole number of days. Read as a UTC calendar date, so the difference of
// two is exact: no zone, no DST.
const dayNumber = (key) => Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10)) / 86_400_000;

/** Days from the span's start through `through` (default: its end), both included. */
export function spanDays(span, through = span.end) {
  return dayNumber(through) - dayNumber(span.start) + 1;
}

/**
 * Spans that touch today or start within `horizonDays`, soonest first. Past spans are
 * history: a prompt has no use for last month's trip, and every line costs tokens.
 */
export function relevantSpans(spans, today, { horizonDays = 60 } = {}) {
  const until = addDays(today, horizonDays);
  return (spans || [])
    .filter((s) => s.end >= today && s.start <= until)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : 1));
}

/** A label cut to `max` characters, for text that goes into every prompt. */
export function clipLabel(label, max = 30) {
  const s = String(label);
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** "Lisbon (trip), 2026-11-06 to 2026-11-12": the wording the prompt and the inbox use. */
export function describeSpan(span, { maxLabel = 120 } = {}) {
  const range = span.start === span.end ? span.start : `${span.start} to ${span.end}`;
  const kind = AWAY_KIND_LABELS[span.kind] ? AWAY_KIND_LABELS[span.kind].toLowerCase() : span.kind;
  return `${clipLabel(span.label, maxLabel)} (${kind}), ${range}`;
}
