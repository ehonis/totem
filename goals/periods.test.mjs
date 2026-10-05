import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addDays, daysLeft, isDayKey, nextPeriod, periodContaining, periodLabel,
  periodState, previousPeriod, resolvePeriod, todayKey, weekdayOf,
} from './periods.mjs';

const TZ = 'America/New_York';

test('weeks run Monday to Sunday, the week he plans in', () => {
  // 2026-09-15 is a Tuesday.
  assert.equal(weekdayOf('2026-09-15'), 2);
  const week = periodContaining('week', '2026-09-15');
  assert.deepEqual([week.start, week.end], ['2026-09-14', '2026-09-20']);
  assert.equal(weekdayOf(week.start), 1);
  // A Sunday is the LAST day of its week, not the first of the next one — that is the
  // whole change from the Sunday-start weeks this ran on before 2026-09-20.
  assert.equal(periodContaining('week', '2026-09-14').start, '2026-09-14');
  assert.equal(periodContaining('week', '2026-09-20').start, '2026-09-14');
  assert.equal(periodContaining('week', '2026-09-21').start, '2026-09-21');
});

test('the week key is its start day, so it never disagrees with its own range', () => {
  const week = periodContaining('week', '2026-09-15');
  assert.equal(week.key, week.start);
});

test('month, quarter and year ends are exact without a special case', () => {
  assert.equal(periodContaining('month', '2026-02-10').end, '2026-02-28');
  assert.equal(periodContaining('month', '2024-02-10').end, '2024-02-29');
  assert.equal(periodContaining('month', '2026-01-05').end, '2026-01-31');
  assert.equal(periodContaining('month', '2026-04-05').end, '2026-04-30');
  assert.equal(periodContaining('month', '2026-12-05').end, '2026-12-31');

  assert.deepEqual(
    ['2026-01-05', '2026-05-05', '2026-08-05', '2026-11-05'].map((d) => periodContaining('quarter', d).key),
    ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4'],
  );
  assert.equal(periodContaining('quarter', '2026-11-05').end, '2026-12-31');
  assert.deepEqual(
    [periodContaining('year', '2026-06-06').start, periodContaining('year', '2026-06-06').end],
    ['2026-01-01', '2026-12-31'],
  );
});

test('a period advances into the next one without changing type', () => {
  const week = nextPeriod(periodContaining('week', '2026-09-15'));
  assert.deepEqual([week.type, week.start, week.end], ['week', '2026-09-21', '2026-09-27']);

  // December rolls the year, and a 31-day month lands on a 30-day one intact.
  const december = nextPeriod(periodContaining('month', '2026-12-09'));
  assert.deepEqual([december.start, december.end], ['2027-01-01', '2027-01-31']);
  const january = nextPeriod(periodContaining('month', '2026-01-31'));
  assert.deepEqual([january.start, january.end], ['2026-02-01', '2026-02-28']);

  const q4 = nextPeriod(periodContaining('quarter', '2026-11-05'));
  assert.deepEqual([q4.key, q4.start, q4.end], ['2027-Q1', '2027-01-01', '2027-03-31']);
  assert.equal(nextPeriod(periodContaining('year', '2026-06-06')).key, '2027');
});

test('a custom period advances by its own length, having no natural successor', () => {
  const custom = resolvePeriod({ type: 'custom', start: '2026-09-13', end: '2026-09-26' });
  const moved = nextPeriod(custom);
  assert.deepEqual([moved.type, moved.start, moved.end], ['custom', '2026-09-27', '2026-10-10']);
  const back = previousPeriod(custom);
  assert.deepEqual([back.type, back.start, back.end], ['custom', '2026-08-30', '2026-09-12']);
});

test('a period steps back into the one before it, the mirror of advancing', () => {
  const week = previousPeriod(periodContaining('week', '2026-09-15'));
  assert.deepEqual([week.type, week.start, week.end], ['week', '2026-09-07', '2026-09-13']);
  // Back and forward land where they started, across every boundary that matters.
  for (const [type, day] of [['week', '2026-01-03'], ['month', '2026-01-15'], ['month', '2026-03-31'], ['quarter', '2026-02-01'], ['year', '2026-06-06']]) {
    const here = periodContaining(type, day);
    assert.deepEqual(nextPeriod(previousPeriod(here)), here, `${type} round trip from ${day}`);
    assert.deepEqual(previousPeriod(nextPeriod(here)), here, `${type} round trip from ${day}`);
  }
  // January steps back into the previous year; a 31-day month lands on a 28-day one intact.
  const december = previousPeriod(periodContaining('month', '2026-01-09'));
  assert.deepEqual([december.start, december.end], ['2025-12-01', '2025-12-31']);
  const february = previousPeriod(periodContaining('month', '2026-03-31'));
  assert.deepEqual([february.start, february.end], ['2026-02-01', '2026-02-28']);
  const q4 = previousPeriod(periodContaining('quarter', '2026-02-05'));
  assert.deepEqual([q4.key, q4.start, q4.end], ['2025-Q4', '2025-10-01', '2025-12-31']);
  assert.equal(previousPeriod(periodContaining('year', '2026-06-06')).key, '2025');
});

test('shortcuts resolve from the clock so a caller never computes a date', () => {
  const now = new Date('2026-09-15T18:00:00Z');
  assert.equal(resolvePeriod('this_week', { now, tz: TZ }).start, '2026-09-14');
  assert.equal(resolvePeriod('next_week', { now, tz: TZ }).start, '2026-09-21');
  assert.equal(resolvePeriod('last_week', { now, tz: TZ }).start, '2026-09-07');
  assert.equal(resolvePeriod('this_month', { now, tz: TZ }).key, '2026-09');
  assert.equal(resolvePeriod('last_month', { now, tz: TZ }).key, '2026-08');
  assert.equal(resolvePeriod('next_quarter', { now, tz: TZ }).key, '2026-Q4');
  assert.equal(resolvePeriod('last_quarter', { now, tz: TZ }).key, '2026-Q2');
  assert.equal(resolvePeriod('next_year', { now, tz: TZ }).key, '2027');
  assert.equal(resolvePeriod('last_year', { now, tz: TZ }).key, '2025');
  assert.throws(() => resolvePeriod('previous_week'), /unknown period shortcut/);
});

test('an explicit type and day resolve to the window containing that day', () => {
  // How the dashboard's ‹ › arrows ask for an older week: the day before the window it
  // is showing, never a shortcut, so it can walk back as far as the rows go.
  const week = resolvePeriod({ type: 'week', start: '2026-09-13' });
  assert.deepEqual([week.start, week.end], ['2026-09-07', '2026-09-13']);
  assert.equal(resolvePeriod({ type: 'month', start: '2026-08-31' }).key, '2026-08');
});

test('the local day is the local day, not the UTC one', () => {
  // 00:30 UTC on the 16th is still 20:30 on the 15th in Eastern. A goal due "this week"
  // must not roll over four hours early, which is the whole reason this is local.
  const lateEvening = new Date('2026-09-16T00:30:00Z');
  assert.equal(todayKey(lateEvening, TZ), '2026-09-15');
  assert.equal(todayKey(lateEvening, 'UTC'), '2026-09-16');

  // Monday 00:30 UTC is still Sunday evening in Eastern, so the week has not turned.
  const sundayNight = new Date('2026-09-21T00:30:00Z');
  assert.equal(resolvePeriod('this_week', { now: sundayNight, tz: TZ }).start, '2026-09-14');
  assert.equal(resolvePeriod('this_week', { now: sundayNight, tz: 'UTC' }).start, '2026-09-21');
});

test('period arithmetic survives a DST boundary', () => {
  // US DST ends 2026-11-01. A week spanning it is still seven calendar days, because
  // nothing here does clock arithmetic once the day key has been resolved.
  const week = periodContaining('week', '2026-11-01');
  assert.deepEqual([week.start, week.end], ['2026-10-26', '2026-11-01']);
  assert.equal(daysLeft(week, '2026-10-26'), 7);
  assert.equal(addDays('2026-11-01', 1), '2026-11-02');
});

test('labels read the way a person would say them', () => {
  assert.equal(periodLabel('week', '2026-09-14', '2026-09-20'), 'Sep 14 – 20, 2026');
  assert.equal(periodLabel('week', '2026-09-28', '2026-10-04'), 'Sep 28 – Oct 4, 2026');
  assert.equal(periodLabel('week', '2026-12-28', '2027-01-03'), 'Dec 28, 2026 – Jan 3, 2027');
  assert.equal(periodLabel('month', '2026-09-01', '2026-09-30'), 'September 2026');
  assert.equal(periodLabel('quarter', '2026-07-01', '2026-09-30'), 'Q3 2026');
  assert.equal(periodLabel('year', '2026-01-01', '2026-12-31'), '2026');
});

test('state and days-left describe the window without acting on it', () => {
  const week = periodContaining('week', '2026-09-15');
  assert.equal(periodState(week, '2026-09-10'), 'upcoming');
  assert.equal(periodState(week, '2026-09-15'), 'active');
  assert.equal(periodState(week, '2026-09-20'), 'active');
  assert.equal(periodState(week, '2026-09-21'), 'expired');
  assert.equal(daysLeft(week, '2026-09-20'), 1);
  assert.equal(daysLeft(week, '2026-09-15'), 6);
  assert.equal(daysLeft(week, '2026-09-21'), 0);
});

test('a day key must be a real day', () => {
  assert.ok(isDayKey('2024-02-29'));
  assert.ok(!isDayKey('2026-02-31'));
  assert.ok(!isDayKey('2026-13-01'));
  assert.ok(!isDayKey('2026-9-1'));
  assert.ok(!isDayKey('not a date'));
  assert.throws(() => resolvePeriod({ type: 'custom', start: '2026-02-31', end: '2026-03-02' }), /needs a start and an end/);
  assert.throws(() => resolvePeriod({ type: 'custom', start: '2026-03-02', end: '2026-03-01' }), /cannot end before it starts/);
  assert.throws(() => resolvePeriod({ type: 'fortnight' }), /unknown period type/);
});
