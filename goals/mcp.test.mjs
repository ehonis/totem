import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { closeTodoDatabase, openTodoDatabase } from '../todos/db.mjs';
import { createGoalMcpClient, createGoalMcpTools, GOAL_MCP_TOOL_DEFINITIONS } from './mcp.mjs';
import { createGoalService } from './service.mjs';

const NOW = '2026-09-15T12:00:00.000Z';

function harness() {
  const db = openTodoDatabase({ file: join(mkdtempSync(join(tmpdir(), 'goals-mcp-')), 'todos.db') });
  let seq = 0;
  const service = createGoalService({
    db, now: () => NOW, makeId: () => `g-${++seq}`,
    actionLog: { record() {} }, timeZone: 'America/New_York',
  });
  return { db, service, tools: createGoalMcpTools({ service, fetchedAt: () => NOW }), close: () => closeTodoDatabase(db) };
}

test('every tool has a definition, a title, a description and annotations', () => {
  const tools = createGoalMcpTools({ service: {} });
  for (const definition of GOAL_MCP_TOOL_DEFINITIONS) {
    assert.equal(typeof tools[definition.name], 'function', `${definition.name} has no implementation`);
    assert.ok(definition.title, `${definition.name} has no title`);
    assert.ok(definition.description.length > 40, `${definition.name} needs a real description`);
    assert.ok(definition.annotations, `${definition.name} has no annotations`);
    assert.equal(definition.inputSchema.type, 'object');
    assert.ok(definition.outputSchema.required.includes('fetchedAt'));
  }
  assert.equal(Object.keys(tools).length, GOAL_MCP_TOOL_DEFINITIONS.length);
});

test('goal writes declare a closed world, and reads an open one', () => {
  // The inverse of the task tools, and deliberately so: a goal write never leaves this
  // box, while a goal read can resolve a Strava-sourced metric.
  const byName = Object.fromEntries(GOAL_MCP_TOOL_DEFINITIONS.map((d) => [d.name, d.annotations]));
  assert.equal(byName.totem_create_goals.openWorldHint, false);
  assert.equal(byName.totem_log_goal_metric.openWorldHint, false);
  assert.equal(byName.totem_get_goals.openWorldHint, true);
  assert.equal(byName.totem_get_goals.readOnlyHint, true);
  assert.equal(byName.totem_delete_goal.destructiveHint, true);
});

test('the MCP contract advertises and creates monthly and yearly goals', async () => {
  const create = GOAL_MCP_TOOL_DEFINITIONS.find((definition) => definition.name === 'totem_create_goals');
  const periods = create.inputSchema.properties.period.enum;
  assert.ok(periods.includes('this_month'));
  assert.ok(periods.includes('next_month'));
  assert.ok(periods.includes('this_year'));
  assert.ok(periods.includes('next_year'));
  assert.match(create.description, /monthly/);
  assert.match(create.description, /yearly/);

  const h = harness();
  const result = await h.tools.totem_create_goals({
    goals: [
      { title: 'Ship the monthly plan', period: 'this_month' },
      { title: 'Reach the yearly target', period: 'this_year' },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.goals.map((goal) => goal.period.type), ['month', 'year']);
  assert.deepEqual(result.goals.map((goal) => goal.period.key), ['2026-09', '2026']);
  h.close();
});

test('a model imports a week in one call without deriving a single date', async () => {
  const h = harness();
  const result = await h.tools.totem_create_goals({
    goals: [
      {
        title: 'Ride 100 miles',
        period: 'this_week',
        clientKey: 'notebook-2026-09-13-1',
        metrics: [{ label: 'miles', unit: 'Miles', targetValue: 100 }],
        subGoals: [{ title: 'Saturday long ride', metrics: [{ label: 'long ride miles', targetValue: 60, rollsUpTo: 'miles' }] }],
      },
      { title: 'Read two books', period: 'this_week', clientKey: 'notebook-2026-09-13-2' },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.created.length, 2);
  assert.equal(result.failed.length, 0);
  assert.equal(result.goals[0].period.start, '2026-09-14', 'the server resolved the week');
  assert.equal(result.goals[0].metrics[0].unit, 'miles');
  assert.equal(result.goals[0].subGoals[0].metrics[0].rollsUpToMetricId, result.goals[0].metrics[0].id);
  h.close();
});

test('re-importing the same page updates instead of doubling the week', async () => {
  const h = harness();
  const payload = { goals: [{ title: 'Ride 100 miles', period: 'this_week', clientKey: 'notebook-1' }] };
  await h.tools.totem_create_goals(payload);
  const second = await h.tools.totem_create_goals(payload);
  assert.equal(second.created[0].reimported, true);
  assert.equal((await h.tools.totem_get_goals({})).count, 1);
  h.close();
});

test('one bad row is reported without costing the others', async () => {
  const h = harness();
  const result = await h.tools.totem_create_goals({
    goals: [{ title: 'Fine', period: 'this_week' }, { title: 'Broken', period: 'this_week', metrics: [{ label: 'x', targetValue: -5 }] }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.created.length, 1);
  assert.equal(result.failed[0].title, 'Broken');
  assert.match(result.failed[0].message, /greater than zero/);
  h.close();
});

test('find resolves a name to an id so a follow-up needs no id', async () => {
  const h = harness();
  await h.tools.totem_create_goals({ title: 'Ride 100 miles', period: 'this_week', metrics: [{ label: 'miles', targetValue: 100 }] });

  const found = await h.tools.totem_find_goals({ query: 'ride' });
  assert.equal(found.count, 1);

  const metricId = found.goals[0].metrics[0].id;
  await h.tools.totem_log_goal_metric({ metricId, delta: 12 });
  const logged = await h.tools.totem_log_goal_metric({ metricId, delta: 8 });
  assert.equal(logged.goal.metrics[0].value, 20);
  h.close();
});

test('logging needs a number, and completion is explicit', async () => {
  const h = harness();
  const { goals } = await h.tools.totem_create_goals({ title: 'Read', period: 'this_week', metrics: [{ label: 'pages', targetValue: 10 }] });
  const goal = goals[0];

  await assert.rejects(h.tools.totem_log_goal_metric({ metricId: goal.metrics[0].id }), /value \(absolute\) or delta/);

  const full = await h.tools.totem_log_goal_metric({ metricId: goal.metrics[0].id, value: 10 });
  assert.equal(full.goal.progress.percent, 100);
  assert.equal(full.goal.complete, false);

  const done = await h.tools.totem_complete_goal({ id: goal.id });
  assert.equal(done.goal.complete, true);
  assert.equal((await h.tools.totem_complete_goal({ id: goal.id, complete: false })).goal.complete, false);
  h.close();
});

test('postponing reports where it went, and the count it moved', async () => {
  const h = harness();
  const { goals } = await h.tools.totem_create_goals({ title: 'Ride', period: 'this_week' });
  const moved = await h.tools.totem_postpone_goal({ id: goals[0].id });
  assert.equal(moved.from.label, 'Sep 14 – 20, 2026');
  assert.equal(moved.to.label, 'Sep 21 – 27, 2026');
  assert.equal(moved.goal.postponedCount, 1);
  h.close();
});

test('the review names what is expiring and what has been abandoned', async () => {
  const h = harness();
  await h.tools.totem_create_goals({ goals: [{ title: 'Open one', period: 'this_week' }, { title: 'Done one', period: 'this_week' }] });
  const all = await h.tools.totem_get_goals({});
  await h.tools.totem_complete_goal({ id: all.goals.find((g) => g.title === 'Done one').id });

  const review = await h.tools.totem_goal_review({ period: 'this_week' });
  assert.equal(review.total, 2);
  assert.equal(review.completed, 1);
  assert.equal(review.open, 1);
  assert.equal(review.daysLeft, 6);
  h.close();
});

test('the gateway client exposes the same tools without the totem_ prefix', async () => {
  const h = harness();
  const client = createGoalMcpClient({ service: h.service, fetchedAt: () => NOW });
  const listed = await client.listTools();
  assert.equal(listed.length, GOAL_MCP_TOOL_DEFINITIONS.length);
  assert.ok(listed.every((t) => !t.name.startsWith('totem_')));
  assert.ok(listed.some((t) => t.name === 'create_goals'));

  const result = await client.callTool('create_goals', { title: 'Via the gateway', period: 'this_week' });
  assert.equal(result.structuredContent.ok, true);
  assert.equal(JSON.parse(result.content[0].text).created.length, 1);
  await assert.rejects(client.callTool('nope', {}), /unknown goal tool/);
  h.close();
});

test('an agent can write the note on a goal and mark one as not doing', async () => {
  const h = harness();
  const { goals } = await h.tools.totem_create_goals({ period: 'this_week', goals: [{ title: 'Ride 100' }] });
  const id = goals[0].id;

  const noted = await h.tools.totem_update_goal({ id, notes: 'Knee held up; keep the Sunday long ride.' });
  assert.equal(noted.goal.notes, 'Knee held up; keep the Sunday long ride.');

  const stopped = await h.tools.totem_update_goal({ id, abandoned: true });
  assert.equal(stopped.goal.abandoned, true);
  // Not the same claim as finishing it.
  assert.equal(stopped.goal.complete, false);

  const resumed = await h.tools.totem_update_goal({ id, abandoned: false });
  assert.equal(resumed.goal.abandoned, false);
  h.close();
});

test('the goal tools no longer offer a quarter to file things in', () => {
  const update = GOAL_MCP_TOOL_DEFINITIONS.find((tool) => tool.name === 'totem_update_goal');
  assert.ok(Object.hasOwn(update.inputSchema.properties, 'abandoned'));

  const create = GOAL_MCP_TOOL_DEFINITIONS.find((tool) => tool.name === 'totem_create_goals');
  assert.doesNotMatch(create.description, /quarterly/i);
  const period = create.inputSchema.properties.period ?? create.inputSchema.properties.goals;
  assert.ok(period, 'create_goals still describes a period');
  assert.match(
    JSON.stringify(GOAL_MCP_TOOL_DEFINITIONS),
    /Do not file quarterly goals/,
    'the period description warns agents off the cadence the dashboard dropped',
  );
});

test('a step takes numbers over MCP, several at once, and reads them back', async () => {
  // "This week I have 2 bike rides under a complete cardio goal — let me attach a
  // number." The step is where the countable thing lives, and one step is two numbers.
  const h = harness();
  const created = await h.tools.totem_create_goals({
    title: 'Complete cardio goals',
    period: 'this_week',
    subGoals: [{ title: '2 bike rides (10+ miles)' }],
  });
  const goalId = created.created[0].id;
  const stepId = (await h.tools.totem_get_goal({ id: goalId })).goal.subGoals[0].id;

  const rides = await h.tools.totem_add_goal_metric({ goalId: stepId, label: 'rides', unit: 'rides', targetValue: 2 });
  const miles = await h.tools.totem_add_goal_metric({ goalId: stepId, label: 'miles', unit: 'miles', targetValue: 20 });
  assert.equal(rides.ok, true);
  // The answer is always the top-level goal, so a client never has to stitch a step
  // back onto the goal it belongs to.
  assert.equal(miles.goal.id, goalId);

  await h.tools.totem_log_goal_metric({ metricId: rides.metricId, delta: 1 });
  const logged = await h.tools.totem_log_goal_metric({ metricId: miles.metricId, delta: 12.4 });

  const step = logged.goal.subGoals[0];
  assert.deepEqual(step.metrics.map((m) => [m.label, m.value]), [['rides', 1], ['miles', 12.4]]);
  assert.equal(step.progress.percent, 56);
  assert.equal(logged.goal.progress.percent, 56, 'the goal moves as the step is logged against');
  h.close();
});

test('a step added over MCP can carry its numbers with it, rollup included', async () => {
  const h = harness();
  const created = await h.tools.totem_create_goals({
    title: 'Train', period: 'this_week', metrics: [{ label: 'miles', unit: 'miles', targetValue: 100 }],
  });
  const goalId = created.created[0].id;

  const added = await h.tools.totem_add_goal_step({
    goalId,
    title: 'Ride',
    metrics: [{ label: 'bike miles', unit: 'miles', targetValue: 70, currentValue: 40, rollsUpTo: 'miles' }],
  });

  assert.equal(added.goal.metrics[0].feederCount, 1);
  assert.equal(added.goal.metrics[0].value, 40, 'and the number it feeds shows it');
  // A label naming nothing is refused rather than accepted and dropped.
  await assert.rejects(
    h.tools.totem_add_goal_step({ goalId, title: 'Swim', metrics: [{ label: 'laps', targetValue: 40, rollsUpTo: 'lengths' }] }),
    (error) => error.code === 'ROLLUP_LABEL_NOT_FOUND',
  );
  h.close();
});

test('the tools say a step can hold numbers, because an agent only knows what they say', () => {
  const byName = Object.fromEntries(GOAL_MCP_TOOL_DEFINITIONS.map((d) => [d.name, d]));
  assert.match(byName.totem_add_goal_metric.description, /step/);
  assert.match(byName.totem_add_goal_metric.description, /several numbers/);
  assert.ok(byName.totem_add_goal_step.inputSchema.properties.metrics, 'a step is created with its numbers');
  assert.ok(byName.totem_add_goal_metric.inputSchema.properties.rollsUpTo, 'by label as well as by id');
  assert.match(byName.totem_get_goals.description, /subGoals\[\]\.metrics/);
});
