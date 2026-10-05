import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { closeTodoDatabase, openTodoDatabase } from '../todos/db.mjs';
import { createGoalService } from './service.mjs';

const NOW = '2026-09-15T12:00:00.000Z';

function harness({ strava = null, now = () => NOW } = {}) {
  const db = openTodoDatabase({ file: join(mkdtempSync(join(tmpdir(), 'goals-svc-')), 'todos.db') });
  const records = [];
  let seq = 0;
  const service = createGoalService({
    db,
    now,
    makeId: () => `id-${++seq}`,
    actionLog: { record: (entry) => records.push(entry) },
    strava,
    timeZone: 'America/New_York',
  });
  const addTodo = (id, title) => {
    db.prepare(`
      INSERT INTO todos (id, title, description, area, status, priority, position, created_at, updated_at)
      VALUES (?, ?, '', 'Personal', 'todo', 1, 0, ?, ?)
    `).run(id, title, NOW, NOW);
    return id;
  };
  return { db, service, records, addTodo, close: () => closeTodoDatabase(db) };
}

const weekGoal = (over = {}) => ({ title: 'Ride more', period: 'this_week', ...over });

test('a goal is created in a period resolved from the clock, not from the caller', async () => {
  const h = harness();
  const { goal } = await h.service.createGoal(weekGoal());
  assert.equal(goal.period.type, 'week');
  assert.deepEqual([goal.period.start, goal.period.end], ['2026-09-14', '2026-09-20']);
  assert.equal(goal.period.label, 'Sep 14 – 20, 2026');
  assert.equal(goal.periodState, 'active');
  assert.equal(goal.daysLeft, 6);
  assert.equal(goal.complete, false);
  assert.equal(goal.postponedCount, 0);
  h.close();
});

test('a whole week imports in one call, with sub-goal metrics feeding the parent by label', async () => {
  const h = harness();
  const { goal } = await h.service.createGoal(weekGoal({
    title: 'Train',
    metrics: [{ label: 'miles', unit: 'Miles', targetValue: 100 }],
    subGoals: [
      { title: 'Ride', metrics: [{ label: 'bike miles', targetValue: 70, currentValue: 40, rollsUpTo: 'miles' }] },
      { title: 'Run', metrics: [{ label: 'run miles', targetValue: 30, currentValue: 10, rollsUpTo: 'miles' }] },
    ],
  }));

  assert.equal(goal.subGoals.length, 2);
  assert.equal(goal.metrics[0].unit, 'miles', 'units are lowercased on write');
  assert.equal(goal.metrics[0].value, 50, 'both steps feed the one number');
  assert.equal(goal.metrics[0].ownValue, 0);
  assert.equal(goal.metrics[0].rolledUpValue, 50);
  assert.equal(goal.metrics[0].feederCount, 2);
  h.close();
});

test('a rollup label that names nothing fails the import loudly', async () => {
  const h = harness();
  await assert.rejects(
    h.service.createGoal(weekGoal({
      metrics: [{ label: 'miles run', targetValue: 20 }],
      subGoals: [{ title: 'Ride', metrics: [{ label: 'x', targetValue: 5, rollsUpTo: 'miles' }] }],
    })),
    (e) => e.code === 'ROLLUP_LABEL_NOT_FOUND',
    'a near-miss label must not silently stop counting',
  );
  // Nothing survives the failed row.
  assert.equal((await h.service.listGoals()).length, 0);
  h.close();
});

test('a client key makes a re-import an update, not a second copy of the week', async () => {
  const h = harness();
  const first = await h.service.createGoal(weekGoal({ clientKey: 'notebook-2026-09-13-1', title: 'Ride 100' }));
  assert.equal(first.reimported, false);

  const again = await h.service.createGoal(weekGoal({ clientKey: 'notebook-2026-09-13-1', title: 'Ride 120' }));
  assert.equal(again.reimported, true);
  assert.equal(again.goal.id, first.goal.id);
  assert.equal(again.goal.title, 'Ride 120');
  assert.equal((await h.service.listGoals()).length, 1, 'photographing the same page twice must not double the week');
  h.close();
});

test('a batch reports the row that failed and keeps the ones that did not', async () => {
  const h = harness();
  const result = await h.service.createGoals([
    weekGoal({ title: 'Good one' }),
    weekGoal({ title: '' }),
    weekGoal({ title: 'Another good one' }),
  ]);
  assert.deepEqual(result.created.map((c) => c.title), ['Good one', 'Another good one']);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].index, 1);
  assert.equal(result.failed[0].code, 'INVALID_GOAL_FIELD');
  h.close();
});

test('goals nest exactly one level deep', async () => {
  const h = harness();
  const { goal } = await h.service.createGoal(weekGoal({ subGoals: [{ title: 'Step' }] }));
  const subId = goal.subGoals[0].id;
  await assert.rejects(
    h.service.addSubGoal(subId, { title: 'Deeper' }),
    (e) => e.code === 'GOAL_IS_A_SUB_GOAL',
  );
  h.close();
});

test('a step can only feed a number on the goal that owns it', async () => {
  const h = harness();
  const a = await h.service.createGoal(weekGoal({ title: 'A', metrics: [{ label: 'miles', targetValue: 50 }], subGoals: [{ title: 'step' }] }));
  const b = await h.service.createGoal(weekGoal({ title: 'B', metrics: [{ label: 'miles', targetValue: 50 }] }));

  const stepId = a.goal.subGoals[0].id;
  const { metricId } = await h.service.addMetric(stepId, { label: 'my miles', targetValue: 10 });

  await assert.rejects(
    h.service.updateMetric(metricId, { rollsUpToMetricId: b.goal.metrics[0].id }),
    (e) => e.code === 'ROLLUP_TARGET_NOT_ON_PARENT',
    'a stranger\'s metric is never a valid target',
  );
  // Its own parent's metric is fine.
  const ok = await h.service.updateMetric(metricId, { rollsUpToMetricId: a.goal.metrics[0].id });
  assert.equal(ok.goal.metrics[0].feederCount, 1);
  h.close();
});

test('a top-level metric has nothing to feed', async () => {
  const h = harness();
  const a = await h.service.createGoal(weekGoal({ title: 'A', metrics: [{ label: 'miles', targetValue: 50 }] }));
  const b = await h.service.createGoal(weekGoal({ title: 'B', metrics: [{ label: 'miles', targetValue: 50 }] }));
  await assert.rejects(
    h.service.updateMetric(a.goal.metrics[0].id, { rollsUpToMetricId: b.goal.metrics[0].id }),
    (e) => e.code === 'ROLLUP_NEEDS_A_PARENT',
  );
  h.close();
});

test('postponing moves one row, carries everything, and counts', async () => {
  const h = harness();
  const { goal } = await h.service.createGoal(weekGoal({
    title: 'Ride 100',
    metrics: [{ label: 'miles', targetValue: 100, currentValue: 40 }],
    subGoals: [{ title: 'Saturday long ride' }, { title: 'Commute twice' }],
  }));

  const moved = await h.service.postponeGoal(goal.id);
  assert.equal(moved.from.key, '2026-09-14');
  assert.equal(moved.to.key, '2026-09-21');
  assert.equal(moved.goal.period.type, 'week', 'a weekly goal never becomes a monthly one');
  assert.equal(moved.goal.postponedCount, 1);
  assert.equal(moved.goal.subGoals.length, 2, 'the steps come with it');
  assert.equal(moved.goal.metrics[0].ownValue, 40, 'logged progress carries forward');

  const again = await h.service.postponeGoal(goal.id);
  assert.equal(again.goal.postponedCount, 2);
  assert.equal(again.goal.period.start, '2026-09-28');
  h.close();
});

test('a step cannot be postponed on its own', async () => {
  const h = harness();
  const { goal } = await h.service.createGoal(weekGoal({ subGoals: [{ title: 'Step' }] }));
  await assert.rejects(
    h.service.postponeGoal(goal.subGoals[0].id),
    (e) => e.code === 'GOAL_IS_A_SUB_GOAL',
  );
  h.close();
});

test('completion is only ever a human act', async () => {
  const h = harness();
  const { goal } = await h.service.createGoal(weekGoal({ metrics: [{ label: 'miles', targetValue: 10 }] }));

  const full = await h.service.updateMetric(goal.metrics[0].id, { value: 10 });
  assert.equal(full.goal.progress.percent, 100);
  assert.equal(full.goal.complete, false, 'a full bar does not tick the box');

  const done = await h.service.setGoalCompletion(goal.id, true);
  assert.equal(done.complete, true);
  assert.equal(done.completedAt, NOW);

  const reopened = await h.service.setGoalCompletion(goal.id, false);
  assert.equal(reopened.complete, false);
  assert.equal(reopened.completedAt, null);
  h.close();
});

test('two deltas accumulate in SQL rather than racing through a read', async () => {
  const h = harness();
  const { goal } = await h.service.createGoal(weekGoal({ metrics: [{ label: 'miles', targetValue: 100 }] }));
  const id = goal.metrics[0].id;
  await h.service.updateMetric(id, { delta: 5 });
  await h.service.updateMetric(id, { delta: 5 });
  const after = await h.service.getGoal(goal.id);
  assert.equal(after.metrics[0].value, 10);

  // A correction cannot drive a count below zero.
  await h.service.updateMetric(id, { delta: -50 });
  assert.equal((await h.service.getGoal(goal.id)).metrics[0].value, 0);

  await assert.rejects(h.service.updateMetric(id, { value: 1, delta: 1 }), (e) => e.code === 'AMBIGUOUS_METRIC_WRITE');
  h.close();
});

test('a sourced metric refuses a hand-written number and reads from its connector', async () => {
  const strava = {
    configured: () => true,
    readCache: async () => ({
      version: 1,
      updatedAt: NOW,
      activities: {
        1: { id: 1, name: 'r', start_date_local: '2026-09-14T09:00:00Z', start_date: '2026-09-14T13:00:00Z', distance: 32186, moving_time: 3600, elapsed_time: 3600, total_elevation_gain: 0, type: 'Ride', sport_type: 'Ride' },
      },
    }),
    gear: async () => { throw new Error('no'); },
  };
  const h = harness({ strava });
  const { goal } = await h.service.createGoal(weekGoal({
    metrics: [{ label: 'bike miles', unit: 'miles', targetValue: 40, sourceKind: 'strava_distance', sourceConfig: { sport: 'Ride' } }],
  }));

  assert.equal(goal.metrics[0].available, true);
  assert.equal(goal.metrics[0].value, 20, '32.186km inside the window is 20 miles');
  assert.equal(goal.metrics[0].sourceKind, 'strava_distance');
  assert.match(goal.metrics[0].sourceLabel, /Strava/);

  await assert.rejects(
    h.service.updateMetric(goal.metrics[0].id, { value: 99 }),
    (e) => e.code === 'METRIC_IS_SOURCED',
    'one number, one owner',
  );
  // Renaming it is still allowed — only the value belongs to the connector.
  const renamed = await h.service.updateMetric(goal.metrics[0].id, { label: 'miles on the bike' });
  assert.equal(renamed.goal.metrics[0].label, 'miles on the bike');
  h.close();
});

test('a disconnected connector reads unavailable, not a week of nothing', async () => {
  const h = harness({ strava: { configured: () => false } });
  const { goal } = await h.service.createGoal(weekGoal({
    metrics: [{ label: 'bike miles', targetValue: 40, sourceKind: 'strava_distance' }],
  }));
  assert.equal(goal.metrics[0].available, false);
  assert.equal(goal.metrics[0].value, null);
  assert.match(goal.metrics[0].unavailableReason, /not connected/);
  assert.equal(goal.progress.percent, null, 'the UI must say "cannot read" rather than draw an empty bar');
  h.close();
});

test('a sourced number is never fed by a step, because it already counts everything', async () => {
  const h = harness({ strava: { configured: () => false } });
  const { goal } = await h.service.createGoal(weekGoal({
    metrics: [{ label: 'miles', targetValue: 100, sourceKind: 'strava_distance' }],
    subGoals: [{ title: 'Ride' }],
  }));
  const { metricId } = await h.service.addMetric(goal.subGoals[0].id, { label: 'my miles', targetValue: 10 });
  await assert.rejects(
    h.service.updateMetric(metricId, { rollsUpToMetricId: goal.metrics[0].id }),
    (e) => e.code === 'ROLLUP_TARGET_IS_SOURCED',
  );
  h.close();
});

test('a goal links to a real task and reads it live', async () => {
  const h = harness();
  h.addTodo('t1', 'Book the century ride');
  const { goal } = await h.service.createGoal(weekGoal({ links: [{ kind: 'todo', todoId: 't1' }, { kind: 'url', url: 'https://example.com/plan' }] }));

  assert.equal(goal.links.length, 2);
  const todoLink = goal.links.find((l) => l.kind === 'todo');
  assert.equal(todoLink.todo.title, 'Book the century ride');
  assert.equal(todoLink.todo.status, 'todo');

  // The title is read live, not frozen at link time.
  h.db.prepare("UPDATE todos SET title = 'Book the century', status = 'done' WHERE id = 't1'").run();
  const fresh = await h.service.getGoal(goal.id);
  assert.equal(fresh.links.find((l) => l.kind === 'todo').todo.title, 'Book the century');
  assert.equal(fresh.links.find((l) => l.kind === 'todo').todo.status, 'done');
  h.close();
});

test('deleting a task takes its bookmark with it', async () => {
  const h = harness();
  h.addTodo('t1', 'Something');
  const { goal } = await h.service.createGoal(weekGoal({ links: [{ kind: 'todo', todoId: 't1' }] }));
  assert.equal(goal.links.length, 1);

  h.db.prepare("DELETE FROM todos WHERE id = 't1'").run();
  assert.equal((await h.service.getGoal(goal.id)).links.length, 0, 'a link pointing at nothing is worse than no link');
  h.close();
});

test('linking the same task twice is a no-op, and a missing task is refused', async () => {
  const h = harness();
  h.addTodo('t1', 'Something');
  const { goal } = await h.service.createGoal(weekGoal());
  await h.service.addLink(goal.id, { kind: 'todo', todoId: 't1' });
  const second = await h.service.addLink(goal.id, { kind: 'todo', todoId: 't1' });
  assert.equal(second.goal.links.length, 1);
  await assert.rejects(h.service.addLink(goal.id, { kind: 'todo', todoId: 'nope' }), (e) => e.code === 'LINKED_TODO_NOT_FOUND');
  h.close();
});

test('every committed mutation leaves one action-log record', async () => {
  const h = harness();
  const { goal } = await h.service.createGoal(weekGoal());
  await h.service.setGoalCompletion(goal.id, true);
  await h.service.postponeGoal(goal.id);
  assert.deepEqual(h.records.map((r) => r.action), ['goal.create', 'goal.complete', 'goal.postpone']);
  assert.ok(h.records.every((r) => r.status === 'ok' && r.summary));
  assert.match(h.records[2].summary, /Sep 14 – 20, 2026 to Sep 21 – 27, 2026/);
  h.close();
});

test('a deleted goal disappears with its steps and stays recoverable in the row', async () => {
  const h = harness();
  const { goal } = await h.service.createGoal(weekGoal({ subGoals: [{ title: 'Step' }] }));
  await h.service.deleteGoal(goal.id);
  assert.equal((await h.service.listGoals()).length, 0);
  await assert.rejects(h.service.getGoal(goal.id), (e) => e.code === 'GOAL_NOT_FOUND');
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM goals WHERE deleted_at IS NOT NULL').get().n, 2);
  h.close();
});

test('the review counts what is expiring and what has been quietly abandoned', async () => {
  const h = harness();
  const a = await h.service.createGoal(weekGoal({ title: 'Nearly out of time' }));
  const b = await h.service.createGoal(weekGoal({ title: 'Done already' }));
  const c = await h.service.createGoal(weekGoal({ title: 'Moved four times' }));
  await h.service.setGoalCompletion(b.goal.id, true);

  // Postpone c forward four weeks, then back to this week so it shows in the window.
  for (let i = 0; i < 4; i++) await h.service.postponeGoal(c.goal.id);
  h.db.prepare("UPDATE goals SET period_start = '2026-09-14', period_end = '2026-09-20' WHERE id = ?").run(c.goal.id);

  const review = await h.service.review({ period: 'this_week' });
  assert.equal(review.total, 3);
  assert.equal(review.completed, 1);
  assert.equal(review.open, 2);
  assert.equal(review.daysLeft, 6);
  assert.deepEqual(review.repeatedlyPostponed.map((g) => g.title), ['Moved four times']);
  assert.ok(review.expiring.every((g) => !g.complete));
  assert.equal(a.goal.title, 'Nearly out of time');
  h.close();
});

test('an expired goal just sits there — nothing rolls it over', async () => {
  const h = harness();
  // 2026-09-06 is a Sunday: the last day of the week that started Monday the 31st.
  const { goal } = await h.service.createGoal({ title: 'Last week', period: { type: 'week', start: '2026-09-06' } });
  const listed = (await h.service.listGoals())[0];
  assert.equal(listed.periodState, 'expired');
  assert.equal(listed.daysLeft, 0);
  assert.equal(listed.postponedCount, 0, 'nothing incremented the counter behind your back');
  assert.deepEqual([listed.period.start, listed.period.end], ['2026-08-31', '2026-09-06']);
  assert.equal(goal.id, listed.id);
  h.close();
});

test('search resolves a name to the goal that owns it', async () => {
  const h = harness();
  await h.service.createGoal(weekGoal({ title: 'Ride 100 miles', subGoals: [{ title: 'Saturday century' }] }));
  await h.service.createGoal(weekGoal({ title: 'Read two books' }));

  assert.deepEqual((await h.service.findGoals('ride')).map((g) => g.title), ['Ride 100 miles']);
  // Matching a step answers with its parent, never half a picture.
  assert.deepEqual((await h.service.findGoals('century')).map((g) => g.title), ['Ride 100 miles']);
  assert.equal((await h.service.findGoals('nothing here')).length, 0);
  h.close();
});

test('a metric can be handed to a connector and taken back again', async () => {
  const h = harness({ strava: { configured: () => false } });
  const { goal } = await h.service.createGoal(weekGoal({ metrics: [{ label: 'miles', targetValue: 100, currentValue: 30 }] }));
  const metricId = goal.metrics[0].id;

  // Manual -> sourced. The connector owns the number now, so the 30 logged by hand goes,
  // and the caller is told rather than left to notice.
  const sourced = await h.service.updateMetric(metricId, {
    sourceKind: 'strava_distance', sourceConfig: { sport: 'Ride' },
  });
  assert.equal(sourced.sourceKind, 'strava_distance');
  assert.equal(sourced.discardedValue, 30);
  assert.equal(sourced.goal.metrics[0].available, false, 'Strava is not connected in this fixture');

  // The error told us this was the fix, so it has to actually work.
  await assert.rejects(h.service.updateMetric(metricId, { value: 5 }), (e) => e.code === 'METRIC_IS_SOURCED');
  const back = await h.service.updateMetric(metricId, { sourceKind: 'manual' });
  assert.equal(back.sourceKind, 'manual');
  assert.equal(back.discardedValue, 0);

  const logged = await h.service.updateMetric(metricId, { value: 5 });
  assert.equal(logged.goal.metrics[0].value, 5);
  h.close();
});

test('a number with steps feeding it cannot be handed to a connector', async () => {
  const h = harness({ strava: { configured: () => false } });
  const { goal } = await h.service.createGoal(weekGoal({
    metrics: [{ label: 'miles', targetValue: 100 }],
    subGoals: [{ title: 'Ride', metrics: [{ label: 'bike miles', targetValue: 60, rollsUpTo: 'miles' }] }],
  }));
  await assert.rejects(
    h.service.updateMetric(goal.metrics[0].id, { sourceKind: 'strava_distance' }),
    (e) => e.code === 'SOURCED_METRIC_CANNOT_BE_FED',
    'the connector already counts those miles',
  );
  h.close();
});

test('an invalid source is refused at write time, leaving the metric as it was', async () => {
  const h = harness();
  const { goal } = await h.service.createGoal(weekGoal({ metrics: [{ label: 'miles', targetValue: 100, currentValue: 12 }] }));
  const metricId = goal.metrics[0].id;
  await assert.rejects(
    h.service.updateMetric(metricId, { sourceKind: 'strava_gear_odometer', sourceConfig: {} }),
    (e) => e.code === 'INVALID_METRIC_SOURCE',
  );
  await assert.rejects(h.service.updateMetric(metricId, { sourceKind: 'garmin' }), (e) => e.code === 'UNKNOWN_METRIC_SOURCE');
  const after = await h.service.getGoal(goal.id);
  assert.equal(after.metrics[0].sourceKind, 'manual');
  assert.equal(after.metrics[0].value, 12, 'a refused change costs nothing');
  h.close();
});

test('a goal can be stopped without being counted as done, and started again', async () => {
  const h = harness();
  const { goal } = await h.service.createGoal(weekGoal({ title: 'Read a paper a day' }));

  const stopped = await h.service.updateGoal(goal.id, { abandoned: true });
  assert.equal(stopped.abandoned, true);
  assert.ok(stopped.abandonedAt);
  // The number he reads on a Sunday is how many he finished.
  assert.equal(stopped.complete, false);
  assert.equal(stopped.completedAt, null);
  assert.match(h.records.at(-1).summary, /Stopped doing/);

  const resumed = await h.service.updateGoal(goal.id, { abandoned: false });
  assert.equal(resumed.abandoned, false);
  assert.equal(resumed.abandonedAt, null);
  h.close();
});

test('a step can be stopped on its own while the goal it belongs to still lands', async () => {
  // The shape this was built for: "follow up with Riley" happened, and the extra step
  // hanging off it — the thing he would have done if the week had gone differently — is
  // one he knows he is not getting to. The goal is not held under 100% over it.
  const h = harness();
  const { goal } = await h.service.createGoal(weekGoal({
    title: 'Follow up with Riley',
    subGoals: [{ title: 'Call him' }, { title: 'Send the deck as well' }],
  }));
  const [call, deck] = goal.subGoals;

  await h.service.setGoalCompletion(call.id, true);
  const stopped = await h.service.updateGoal(deck.id, { abandoned: true });

  // Answering with the parent is what every other step write already does, so the card
  // gets the whole goal back and the count redraws without a reload.
  assert.equal(stopped.id, goal.id);
  const step = stopped.subGoals.find((s) => s.id === deck.id);
  assert.equal(step.abandoned, true);
  assert.ok(step.abandonedAt);
  assert.equal(step.complete, false, 'not doing it is not the same as having done it');
  assert.equal(stopped.progress.subGoalsDone, 1);
  assert.equal(stopped.progress.subGoalsTotal, 1, 'the step he stopped is out of the count');
  assert.equal(stopped.progress.subGoalsAbandoned, 1);
  assert.equal(stopped.progress.percent, 100);
  assert.equal(stopped.complete, false, 'and completion is still his to assert');
  // The log says step, not goal: "Stopped doing Send the deck as well" reads as a goal
  // he dropped otherwise, and the goal is the one he finished.
  assert.match(h.records.at(-1).summary, /Stopped doing step "Send the deck as well"/);

  const resumed = await h.service.updateGoal(deck.id, { abandoned: false });
  assert.equal(resumed.subGoals.find((s) => s.id === deck.id).abandoned, false);
  assert.equal(resumed.progress.subGoalsTotal, 2);
  assert.equal(resumed.progress.subGoalsAbandoned, 0);
  h.close();
});

test('editing a goal changes its title and notes without touching anything else', async () => {
  const h = harness();
  const { goal } = await h.service.createGoal(weekGoal({ title: 'Lift twice', notes: 'at the gym' }));

  const edited = await h.service.updateGoal(goal.id, { title: 'Lift three times', notes: 'wherever' });
  assert.equal(edited.title, 'Lift three times');
  assert.equal(edited.notes, 'wherever');
  assert.equal(edited.period.type, goal.period.type);
  assert.equal(edited.postponedCount, goal.postponedCount);
  assert.equal(edited.abandoned, false);
  h.close();
});

test('a step tracks as many numbers as it needs, each in its own right', async () => {
  // The case: "complete cardio goals", with "2 bike rides (10+ miles)" under it. The
  // countable thing is the step, not the goal, and one step is two numbers — how many
  // rides and how far.
  const h = harness();
  const { goal } = await h.service.createGoal(weekGoal({ title: 'Complete cardio goals' }));
  const { subGoalId } = await h.service.addSubGoal(goal.id, { title: '2 bike rides (10+ miles)' });

  const rides = await h.service.addMetric(subGoalId, { label: 'rides', unit: 'rides', targetValue: 2 });
  const miles = await h.service.addMetric(subGoalId, { label: 'miles', unit: 'miles', targetValue: 20 });
  await h.service.updateMetric(rides.metricId, { delta: 1 });
  const { goal: after } = await h.service.updateMetric(miles.metricId, { delta: 12.4 });

  const step = after.subGoals[0];
  assert.deepEqual(step.metrics.map((m) => [m.label, m.value, m.percent]), [['rides', 1, 50], ['miles', 12.4, 62]]);
  assert.equal(step.progress.percent, 56, 'the step averages its own numbers');
  // And the goal moves with it rather than reading zero until the step is ticked.
  assert.equal(after.progress.percent, 56);
  assert.equal(after.progress.subGoalsDone, 0, 'without claiming the step is finished');
  h.close();
});

test('a step added later takes rollup by label, the way one nested in an import does', async () => {
  // It used to accept `rollsUpTo` here and drop it on the floor — the worst shape of
  // all, because the caller is told it worked and the total quietly reads low.
  const h = harness();
  const { goal } = await h.service.createGoal(weekGoal({
    title: 'Train', metrics: [{ label: 'miles', unit: 'miles', targetValue: 100 }],
  }));
  const { goal: after } = await h.service.addSubGoal(goal.id, {
    title: 'Ride', metrics: [{ label: 'bike miles', targetValue: 70, currentValue: 40, rollsUpTo: 'miles' }],
  });

  assert.equal(after.metrics[0].feederCount, 1);
  assert.equal(after.metrics[0].value, 40);
  h.close();
});

test('a rollup label that names nothing is refused wherever it is sent', async () => {
  const h = harness();
  const { goal } = await h.service.createGoal(weekGoal({
    title: 'Train', metrics: [{ label: 'miles', targetValue: 100 }], subGoals: [{ title: 'Ride' }],
  }));
  const stepId = goal.subGoals[0].id;

  await assert.rejects(
    h.service.addMetric(stepId, { label: 'bike miles', targetValue: 70, rollsUpTo: 'kilometres' }),
    (e) => e.code === 'ROLLUP_LABEL_NOT_FOUND',
  );
  await assert.rejects(
    h.service.addSubGoal(goal.id, { title: 'Run', metrics: [{ label: 'run miles', targetValue: 30, rollsUpTo: 'kilometres' }] }),
    (e) => e.code === 'ROLLUP_LABEL_NOT_FOUND',
  );
  // And a goal's own number has nothing above it to name.
  await assert.rejects(
    h.service.addMetric(goal.id, { label: 'more miles', targetValue: 10, rollsUpTo: 'miles' }),
    (e) => e.code === 'ROLLUP_NEEDS_A_PARENT',
  );
  h.close();
});

test('a step number that feeds the goal is counted once, in the number it feeds', async () => {
  const h = harness();
  const { goal } = await h.service.createGoal(weekGoal({
    title: 'Train', metrics: [{ label: 'miles', targetValue: 40 }], subGoals: [{ title: 'Ride' }],
  }));
  const { metricId } = await h.service.addMetric(goal.subGoals[0].id, {
    label: 'bike miles', targetValue: 40, rollsUpToMetricId: goal.metrics[0].id,
  });
  const { goal: after } = await h.service.updateMetric(metricId, { delta: 20 });

  assert.equal(after.metrics[0].value, 20, 'the parent shows it');
  assert.equal(after.subGoals[0].progress.percent, 50, 'the step still owns it');
  // Half of one metric and a step that has not been taken: 25%, not 50% counted twice.
  assert.equal(after.progress.percent, 25);
  h.close();
});
