import assert from 'node:assert/strict';
import { test } from 'node:test';

import { goalProgress, percent, subGoalProgress } from './progress.mjs';

const metric = (over = {}) => ({
  id: 'm', label: 'miles run', unit: 'miles', targetValue: 20,
  currentValue: 0, rollsUpToMetricId: null, sourceKind: 'manual', ...over,
});

test('a rolled-up contribution is counted exactly once', () => {
  const parent = metric({ id: 'parent', targetValue: 40, currentValue: 10 });
  const child = metric({ id: 'child', targetValue: 30, currentValue: 20, rollsUpToMetricId: 'parent' });

  const progress = goalProgress({
    completedAt: null,
    metrics: [parent],
    subGoals: [{ id: 'sub', completedAt: null, metrics: [child] }],
  });

  const shown = progress.metrics[0];
  assert.equal(shown.ownValue, 10);
  assert.equal(shown.rolledUpValue, 20);
  assert.equal(shown.value, 30, 'parent shows its own 10 plus the child 20, never 40 or 60');
  assert.equal(shown.feederCount, 1);

  // The child still owns its number in its own right.
  assert.equal(subGoalProgress({ id: 'sub', completedAt: null, metrics: [child] }).metrics[0].value, 20);
});

test('several feeders sum, and a standalone metric is untouched by them', () => {
  const total = metric({ id: 'total', label: 'miles', targetValue: 100, currentValue: 5 });
  const standalone = metric({ id: 'alone', label: 'books', targetValue: 2, currentValue: 1 });
  const progress = goalProgress({
    completedAt: null,
    metrics: [total, standalone],
    subGoals: [
      { id: 'a', completedAt: null, metrics: [metric({ id: 'r', currentValue: 20, rollsUpToMetricId: 'total' })] },
      { id: 'b', completedAt: null, metrics: [metric({ id: 'b1', currentValue: 30, rollsUpToMetricId: 'total' })] },
    ],
  });
  assert.equal(progress.metrics[0].value, 55);
  assert.equal(progress.metrics[0].feederCount, 2);
  assert.equal(progress.metrics[1].value, 1, 'a standalone metric never absorbs a feeder');
});

test('a fraction clamps at one, so overshooting cannot skew the goal', () => {
  const progress = goalProgress({
    completedAt: null,
    metrics: [metric({ targetValue: 10, currentValue: 25 })],
    subGoals: [],
  });
  assert.equal(progress.metrics[0].value, 25, 'the real number is still reported');
  assert.equal(progress.metrics[0].fraction, 1);
  assert.equal(progress.fraction, 1);
});

test('the goal fraction is the mean of its metrics and its sub-goal completion', () => {
  const progress = goalProgress({
    completedAt: null,
    metrics: [metric({ id: 'a', targetValue: 10, currentValue: 5 })],
    subGoals: [
      { id: 's1', completedAt: '2026-09-15T12:00:00.000Z', metrics: [] },
      { id: 's2', completedAt: null, metrics: [] },
      { id: 's3', completedAt: null, metrics: [] },
      { id: 's4', completedAt: null, metrics: [] },
    ],
  });
  // One metric at 0.5, and 1 of 4 sub-goals done = 0.25. Mean of the two is 0.375.
  assert.equal(progress.subGoalsDone, 1);
  assert.equal(progress.subGoalsTotal, 4);
  assert.equal(progress.fraction, 0.375);
  assert.equal(percent(progress.fraction), 38);
});

test('a goal with no metrics and no sub-goals is completion-tracked', () => {
  assert.equal(goalProgress({ completedAt: null, metrics: [], subGoals: [] }).fraction, 0);
  const done = goalProgress({ completedAt: '2026-09-15T12:00:00.000Z', metrics: [], subGoals: [] });
  assert.equal(done.fraction, 1);
  assert.equal(done.complete, true);
});

test('completion is never inferred from a full bar', () => {
  const progress = goalProgress({
    completedAt: null,
    metrics: [metric({ targetValue: 10, currentValue: 10 })],
    subGoals: [],
  });
  assert.equal(progress.fraction, 1);
  assert.equal(progress.complete, false, 'a goal at 100% is still not done until a person says so');
});

test('an unreadable metric is dropped from the mean, never counted as zero', () => {
  const progress = goalProgress({
    completedAt: null,
    metrics: [
      metric({ id: 'manual', targetValue: 10, currentValue: 8 }),
      metric({ id: 'strava', targetValue: 50, sourceKind: 'strava_distance', available: false, unavailableReason: 'not connected' }),
    ],
    subGoals: [],
  });
  const unreadable = progress.metrics[1];
  assert.equal(unreadable.available, false);
  assert.equal(unreadable.value, null);
  assert.equal(unreadable.fraction, null);
  assert.equal(unreadable.unavailableReason, 'not connected');
  // 0.8 alone, not (0.8 + 0) / 2 = 0.4, which would read as a bad week rather than a
  // missing connector.
  assert.equal(progress.fraction, 0.8);
});

test('a goal whose only metric is unreadable reports nothing rather than zero', () => {
  const progress = goalProgress({
    completedAt: null,
    metrics: [metric({ sourceKind: 'strava_distance', available: false })],
    subGoals: [],
  });
  assert.equal(progress.fraction, null);
  assert.equal(percent(progress.fraction), null);
});

test('an unreadable feeder does not drag its parent down', () => {
  const progress = goalProgress({
    completedAt: null,
    metrics: [metric({ id: 'parent', targetValue: 40, currentValue: 10 })],
    subGoals: [{
      id: 'sub',
      completedAt: null,
      metrics: [metric({ id: 'child', rollsUpToMetricId: 'parent', sourceKind: 'strava_distance', available: false })],
    }],
  });
  const shown = progress.metrics[0];
  assert.equal(shown.value, 10);
  assert.equal(shown.available, true);
  assert.equal(shown.unreadableFeederCount, 1, 'the UI can say the total is short a source');
});

test('a step decided against leaves the count rather than holding the goal back', () => {
  // The case this exists for: the goal happened, and one step on it was an add-on he
  // knew he would not get to. Counting it as undone would make the goal permanently
  // unfinishable over a decision he already made out loud.
  const progress = goalProgress({
    completedAt: null,
    metrics: [],
    subGoals: [
      { id: 's1', completedAt: '2026-09-17T12:00:00.000Z', metrics: [] },
      { id: 's2', completedAt: '2026-09-17T12:00:00.000Z', metrics: [] },
      { id: 's3', completedAt: null, abandonedAt: '2026-09-17T13:00:00.000Z', metrics: [] },
    ],
  });
  assert.equal(progress.subGoalsTotal, 2, 'the abandoned step is out of the denominator');
  assert.equal(progress.subGoalsDone, 2);
  assert.equal(progress.subGoalsAbandoned, 1, 'and is reported, so the card can say so');
  assert.equal(progress.fraction, 1);
});

test('an abandoned step is not counted as done either', () => {
  const progress = goalProgress({
    completedAt: null,
    metrics: [],
    subGoals: [
      { id: 's1', completedAt: null, metrics: [] },
      { id: 's2', completedAt: null, abandonedAt: '2026-09-17T13:00:00.000Z', metrics: [] },
    ],
  });
  assert.equal(progress.subGoalsDone, 0);
  assert.equal(progress.subGoalsTotal, 1);
  assert.equal(progress.fraction, 0, 'dropping it out is not the same as claiming it');
});

test('what an abandoned step already logged still rolls up', () => {
  // Those miles happened. Deciding the step is over does not un-ride them.
  const progress = goalProgress({
    completedAt: null,
    metrics: [metric({ id: 'parent', targetValue: 40, currentValue: 10 })],
    subGoals: [{
      id: 'sub',
      completedAt: null,
      abandonedAt: '2026-09-17T13:00:00.000Z',
      metrics: [metric({ id: 'child', currentValue: 20, rollsUpToMetricId: 'parent' })],
    }],
  });
  assert.equal(progress.metrics[0].value, 30);
});

test('a goal whose every step was abandoned falls back to completion tracking', () => {
  // Otherwise the steps component is 0/0, and the goal reads NaN% for the rest of the week.
  const open = goalProgress({
    completedAt: null,
    metrics: [],
    subGoals: [{ id: 's1', completedAt: null, abandonedAt: '2026-09-17T13:00:00.000Z', metrics: [] }],
  });
  assert.equal(open.subGoalsTotal, 0);
  assert.equal(open.fraction, 0);
  const closed = goalProgress({
    completedAt: '2026-09-17T14:00:00.000Z',
    metrics: [],
    subGoals: [{ id: 's1', completedAt: null, abandonedAt: '2026-09-17T13:00:00.000Z', metrics: [] }],
  });
  assert.equal(closed.fraction, 1);
});

test('a step with numbers on it counts how far through them it is', () => {
  // The case it exists for: "complete cardio goals" with "2 bike rides" under it. One
  // ride logged is half a step. Reading the goal as 0% until the step is ticked is what
  // made putting a number on a step pointless.
  const progress = goalProgress({
    completedAt: null,
    metrics: [],
    subGoals: [
      { id: 'rides', completedAt: null, metrics: [metric({ id: 'r', label: 'rides', targetValue: 2, currentValue: 1 })] },
      { id: 'swim', completedAt: null, metrics: [] },
    ],
  });
  // Half a step and an untouched one, over two steps.
  assert.equal(progress.fraction, 0.25);
  assert.equal(progress.subGoalsDone, 0, 'and none of it claims the step is finished');
});

test('a step tracking several numbers averages them', () => {
  const progress = goalProgress({
    completedAt: null,
    metrics: [],
    subGoals: [{
      id: 'rides',
      completedAt: null,
      metrics: [
        metric({ id: 'count', label: 'rides', targetValue: 2, currentValue: 1 }),
        metric({ id: 'miles', label: 'miles', targetValue: 20, currentValue: 5 }),
      ],
    }],
  });
  // 0.5 and 0.25.
  assert.equal(progress.fraction, 0.375);
});

test('ticking a step beats whatever its numbers say', () => {
  const progress = goalProgress({
    completedAt: null,
    metrics: [],
    subGoals: [{
      id: 'rides',
      completedAt: '2026-09-21T12:00:00.000Z',
      metrics: [metric({ id: 'r', targetValue: 2, currentValue: 0 })],
    }],
  });
  assert.equal(progress.fraction, 1, 'a person saying it is done outranks a bar that disagrees');
});

test('a step whose numbers feed the parent is not counted twice', () => {
  // The miles are already inside the parent metric's own bar. Letting them move the
  // steps component as well would move the goal twice for one ride.
  const progress = goalProgress({
    completedAt: null,
    metrics: [metric({ id: 'parent', label: 'miles', targetValue: 40, currentValue: 0 })],
    subGoals: [{
      id: 'sub',
      completedAt: null,
      metrics: [metric({ id: 'child', targetValue: 40, currentValue: 20, rollsUpToMetricId: 'parent' })],
    }],
  });
  // The parent reads 20/40; the step still reads as untaken.
  assert.equal(progress.metrics[0].value, 20);
  assert.equal(progress.fraction, 0.25, 'one half-full metric and one untaken step');
});

test('an unreadable number on a step leaves it on its tick, not on zero evidence', () => {
  const progress = goalProgress({
    completedAt: null,
    metrics: [],
    subGoals: [{
      id: 'sub',
      completedAt: null,
      metrics: [metric({ id: 'strava', sourceKind: 'strava_distance', available: false, unavailableReason: 'not connected' })],
    }],
  });
  assert.equal(progress.fraction, 0);
});
