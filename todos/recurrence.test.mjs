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
