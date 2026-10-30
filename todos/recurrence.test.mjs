import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nextOccurrence } from './recurrence.mjs';

test('advances fixed-day recurrence rules without timezone drift', () => {
  assert.equal(nextOccurrence({ dueDate: '2026-09-11', recurrence: 'daily' }), '2026-09-12');
  assert.equal(nextOccurrence({ dueDate: '2026-09-11', recurrence: 'weekly' }), '2026-09-18');
  assert.equal(nextOccurrence({ dueDate: '2026-09-11', recurrence: 'interval:10' }), '2026-09-21');
});

test('weekdays skips Saturday and Sunday', () => {
  assert.equal(nextOccurrence({ dueDate: '2026-09-11', recurrence: 'weekdays' }), '2026-09-14');
  assert.equal(nextOccurrence({ dueDate: '2026-09-14', recurrence: 'weekdays' }), '2026-09-15');
});

test('calendar recurrence clamps month ends and leap days', () => {
  assert.equal(nextOccurrence({ dueDate: '2026-01-31', recurrence: 'monthly' }), '2026-02-28');
  assert.equal(nextOccurrence({ dueDate: '2024-02-29', recurrence: 'yearly' }), '2025-02-28');
});

test('calendar recurrence preserves four-digit years below 0100', () => {
  assert.equal(nextOccurrence({ dueDate: '0099-01-31', recurrence: 'monthly' }), '0099-02-28');
  assert.equal(nextOccurrence({ dueDate: '0099-12-31', recurrence: 'yearly' }), '0100-12-31');
});

test('recurrence rejects rollover beyond the canonical four-digit date range', () => {
  assert.throws(
    () => nextOccurrence({ dueDate: '9999-12-31', recurrence: 'daily' }),
    /supported date range/i,
  );
  assert.throws(
    () => nextOccurrence({ dueDate: '9999-01-31', recurrence: 'yearly' }),
    /supported date range/i,
  );
});

test('rejects invalid dates, rules, and non-positive intervals', () => {
  assert.throws(() => nextOccurrence({ dueDate: '2026-02-30', recurrence: 'daily' }), /dueDate/i);
  assert.throws(() => nextOccurrence({ dueDate: '2026-09-11', recurrence: 'fortnightly' }), /recurrence/i);
  assert.throws(() => nextOccurrence({ dueDate: '2026-09-11', recurrence: 'interval:0' }), /interval/i);
});

test('a late completion catches up to the first occurrence after today', () => {
  assert.equal(nextOccurrence({ dueDate: '2026-10-01', recurrence: 'daily', after: '2026-10-20' }), '2026-10-21');
  assert.equal(nextOccurrence({ dueDate: '2026-10-01', recurrence: 'weekly', after: '2026-10-20' }), '2026-10-22');
  assert.equal(nextOccurrence({ dueDate: '2026-10-01', recurrence: 'weekly', after: '2026-10-22' }), '2026-10-29');
  assert.equal(nextOccurrence({ dueDate: '2024-03-15', recurrence: 'yearly', after: '2026-10-20' }), '2027-03-15');
  assert.equal(nextOccurrence({ dueDate: '2024-11-15', recurrence: 'yearly', after: '2026-02-01' }), '2026-11-15');
});

test('a task due today or completed early still steps exactly once from its due date', () => {
  assert.equal(nextOccurrence({ dueDate: '2026-10-20', recurrence: 'daily', after: '2026-10-20' }), '2026-10-21');
  assert.equal(nextOccurrence({ dueDate: '2026-10-25', recurrence: 'daily', after: '2026-10-20' }), '2026-10-26');
  assert.equal(nextOccurrence({ dueDate: '2026-10-25', recurrence: 'weekly', after: '2026-10-20' }), '2026-11-01');
  assert.equal(nextOccurrence({ dueDate: '2026-10-31', recurrence: 'monthly', after: '2026-10-20' }), '2026-11-30');
  assert.equal(nextOccurrence({ dueDate: '2026-10-23', recurrence: 'weekdays', after: '2026-10-20' }), '2026-10-26');
});

test('monthly catch-up counts months from the anchor, so the 31st does not drift', () => {
  assert.equal(nextOccurrence({ dueDate: '2026-01-31', recurrence: 'monthly', after: '2026-05-15' }), '2026-05-31');
  assert.equal(nextOccurrence({ dueDate: '2026-01-31', recurrence: 'monthly', after: '2026-05-31' }), '2026-06-30');
  assert.equal(nextOccurrence({ dueDate: '2026-01-31', recurrence: 'monthly', after: '2026-02-28' }), '2026-03-31');
  assert.equal(nextOccurrence({ dueDate: '2026-01-31', recurrence: 'monthly', after: '2027-01-30' }), '2027-01-31');
});

test('weekdays catch-up skips a weekend today and lands on Monday', () => {
  // 2026-10-23 is a Friday; due the Tuesday before.
  assert.equal(nextOccurrence({ dueDate: '2026-10-20', recurrence: 'weekdays', after: '2026-10-23' }), '2026-10-26');
  assert.equal(nextOccurrence({ dueDate: '2026-10-20', recurrence: 'weekdays', after: '2026-10-24' }), '2026-10-26');
  assert.equal(nextOccurrence({ dueDate: '2026-10-20', recurrence: 'weekdays', after: '2026-10-22' }), '2026-10-23');
});

test('interval catch-up keeps the series on its own phase', () => {
  assert.equal(nextOccurrence({ dueDate: '2026-08-01', recurrence: 'interval:10', after: '2026-09-11' }), '2026-09-20');
  assert.equal(nextOccurrence({ dueDate: '2026-08-01', recurrence: 'interval:10', after: '2026-09-10' }), '2026-09-20');
  assert.equal(nextOccurrence({ dueDate: '2026-08-01', recurrence: 'interval:10', after: '2026-09-09' }), '2026-09-10');
});

test('catch-up over years is arithmetic, not a step per occurrence', () => {
  assert.equal(nextOccurrence({ dueDate: '0001-01-01', recurrence: 'daily', after: '9999-12-30' }), '9999-12-31');
  assert.equal(nextOccurrence({ dueDate: '0001-01-31', recurrence: 'monthly', after: '9999-11-30' }), '9999-12-31');
  assert.throws(() => nextOccurrence({ dueDate: '2026-09-11', recurrence: 'daily', after: '2026-13-01' }), /after/i);
});
