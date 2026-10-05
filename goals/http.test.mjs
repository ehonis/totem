import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { closeTodoDatabase, openTodoDatabase } from '../todos/db.mjs';
import { createGoalHttpHandler } from './http.mjs';
import { createGoalService } from './service.mjs';

const NOW = '2026-09-15T12:00:00.000Z';
const cleanups = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture({ strava = null } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'totem-goal-http-'));
  const db = openTodoDatabase({ file: join(directory, 'todos.db'), now: () => NOW });
  let sequence = 0;
  const service = createGoalService({
    db,
    now: () => NOW,
    makeId: () => `goal-${++sequence}`,
    actionLog: { record() {} },
    strava,
    timeZone: 'America/New_York',
  });
  const handler = createGoalHttpHandler({ service });
  const server = createServer(async (req, res) => {
    try {
      if (await handler(req, res, new URL(req.url, 'http://localhost'))) return;
      res.writeHead(418, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ unclaimed: true }));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  cleanups.push(async () => {
    server.close();
    await once(server, 'close');
    closeTodoDatabase(db);
    rmSync(directory, { recursive: true, force: true });
  });
  async function request(method, path, body) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  return { db, service, request };
}

test('the adapter claims only its own paths', async () => {
  const { request } = await fixture();
  assert.equal((await request('GET', '/api/todos')).status, 418);
  assert.equal((await request('GET', '/api/goals')).status, 200);
});

test('a goal is created, read back, and listed by period', async () => {
  const { request } = await fixture();
  const created = await request('POST', '/api/goals', {
    title: 'Ride 100 miles',
    period: 'this_week',
    metrics: [{ label: 'miles', unit: 'miles', targetValue: 100, currentValue: 30 }],
    subGoals: [{ title: 'Saturday long ride' }],
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.goal.title, 'Ride 100 miles');
  assert.equal(created.body.goal.period.key, '2026-09-14');

  const id = created.body.goal.id;
  assert.equal((await request('GET', `/api/goals/${id}`)).body.goal.metrics[0].value, 30);
  const listed = await request('GET', '/api/goals?period=this_week');
  assert.equal(listed.body.goals.length, 1);
  assert.equal(listed.body.period.key, '2026-09-14', 'the window comes back beside the goals');

  // An explicit window: the day before this week's start is last week, which is empty
  // but still named — that is what the dashboard's ‹ arrow relies on.
  const earlier = await request('GET', '/api/goals?type=week&start=2026-09-13');
  assert.deepEqual([earlier.body.goals.length, earlier.body.period.start, earlier.body.period.end], [0, '2026-09-07', '2026-09-13']);
  const lastWeek = await request('GET', '/api/goals?period=last_week');
  assert.equal(lastWeek.body.period.start, '2026-09-07');
  assert.equal((await request('GET', '/api/goals?period=next_week')).body.goals.length, 0);
});

test('logging, completing and postponing each have one route', async () => {
  const { request } = await fixture();
  const id = (await request('POST', '/api/goals', {
    title: 'Read', period: 'this_week', metrics: [{ label: 'pages', targetValue: 100 }],
  })).body.goal.id;
  const metricId = (await request('GET', `/api/goals/${id}`)).body.goal.metrics[0].id;

  assert.equal((await request('PATCH', '/api/goals/metrics', { id: metricId, delta: 40 })).body.goal.metrics[0].value, 40);
  assert.equal((await request('POST', `/api/goals/${id}/complete`, {})).body.goal.complete, true);
  assert.equal((await request('POST', `/api/goals/${id}/complete`, { complete: false })).body.goal.complete, false);

  const moved = await request('POST', `/api/goals/${id}/postpone`, {});
  assert.equal(moved.body.to.key, '2026-09-21');
  assert.equal(moved.body.goal.postponedCount, 1);
});

test('a domain conflict keeps its code and status rather than becoming a 500', async () => {
  const { request } = await fixture({ strava: { configured: () => false } });
  const id = (await request('POST', '/api/goals', {
    title: 'Ride', period: 'this_week',
    metrics: [{ label: 'miles', targetValue: 100, sourceKind: 'strava_distance' }],
  })).body.goal.id;
  const metricId = (await request('GET', `/api/goals/${id}`)).body.goal.metrics[0].id;

  const refused = await request('PATCH', '/api/goals/metrics', { id: metricId, value: 50 });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'METRIC_IS_SOURCED');
  assert.match(refused.body.error.message, /cannot be logged by hand/);

  const missing = await request('GET', '/api/goals/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'GOAL_NOT_FOUND');
});

test('an invented period is the caller\'s mistake, not a crash', async () => {
  const { request } = await fixture();
  const response = await request('POST', '/api/goals', { title: 'x', period: 'previous_week' });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_PERIOD');
  const badDay = await request('GET', '/api/goals?type=week&start=2026-02-31');
  assert.equal(badDay.status, 400);
});

test('a batch import reports per-row failures over HTTP', async () => {
  const { request } = await fixture();
  const response = await request('POST', '/api/goals', {
    goals: [
      { title: 'One', period: 'this_week' },
      { title: '', period: 'this_week' },
    ],
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.created.length, 1);
  assert.equal(response.body.failed.length, 1);
  assert.equal(response.body.failed[0].index, 1);
});

test('the options route tells the client what it may choose', async () => {
  const { request } = await fixture();
  const { body } = await request('GET', '/api/goals/options');
  assert.ok(body.periods.includes('next_week'));
  assert.ok(body.allUnits.includes('miles'));
  assert.ok(body.sources.includes('strava_distance'));
  assert.ok(body.measures.includes('distanceMi'));
  assert.ok(body.sports.includes('ride'));
  assert.ok(body.sports.includes('run'));
  // The families are published so a client can say which workout types a sport covers,
  // and can show a metric stored against an exact sport_type under the right one.
  assert.ok(body.sportFamilies.run.includes('TrailRun'));
  assert.ok(body.sportFamilies.ride.includes('GravelRide'));
});

test('review and search answer without writing anything', async () => {
  const { request } = await fixture();
  await request('POST', '/api/goals', { title: 'Ride 100 miles', period: 'this_week' });
  const review = await request('GET', '/api/goals/review?period=this_week');
  assert.equal(review.body.total, 1);
  assert.equal(review.body.open, 1);
  assert.equal(review.body.period.key, '2026-09-14');

  assert.equal((await request('GET', '/api/goals/search?q=ride')).body.goals.length, 1);
  assert.equal((await request('GET', '/api/goals/search?q=')).status, 400);
});

test('steps, metrics and links are added and removed through their own routes', async () => {
  const { db, request } = await fixture();
  db.prepare(`
    INSERT INTO todos (id, title, description, area, status, priority, position, created_at, updated_at)
    VALUES ('t1', 'Book the ride', '', 'Personal', 'todo', 1, 0, ?, ?)
  `).run(NOW, NOW);

  const id = (await request('POST', '/api/goals', { title: 'Ride', period: 'this_week' })).body.goal.id;
  assert.equal((await request('POST', `/api/goals/${id}/steps`, { title: 'Step' })).body.goal.subGoals.length, 1);

  const withMetric = await request('POST', `/api/goals/${id}/metrics`, { label: 'miles', targetValue: 50 });
  assert.equal(withMetric.body.goal.metrics.length, 1);

  const linked = await request('POST', `/api/goals/${id}/links`, { kind: 'todo', todoId: 't1' });
  assert.equal(linked.body.goal.links[0].todo.title, 'Book the ride');

  await request('DELETE', '/api/goals/metrics', { id: withMetric.body.metricId });
  await request('DELETE', '/api/goals/links', { id: linked.body.linkId });
  const after = (await request('GET', `/api/goals/${id}`)).body.goal;
  assert.equal(after.metrics.length, 0);
  assert.equal(after.links.length, 0);

  assert.equal((await request('DELETE', `/api/goals/${id}`)).body.deleted, true);
  assert.equal((await request('GET', '/api/goals')).body.goals.length, 0);
});

test('a step takes numbers through the same metric route the goal does', async () => {
  // `POST /api/goals/:id/metrics` does not care which kind of row the id names — a step
  // IS a goal row — and every answer is still the whole top-level goal.
  const { request } = await fixture();
  const goalId = (await request('POST', '/api/goals', {
    title: 'Complete cardio goals', period: 'this_week',
  })).body.goal.id;
  const stepId = (await request('POST', `/api/goals/${goalId}/steps`, { title: '2 bike rides' })).body.goal.subGoals[0].id;

  const rides = await request('POST', `/api/goals/${stepId}/metrics`, { label: 'rides', unit: 'rides', targetValue: 2 });
  const miles = await request('POST', `/api/goals/${stepId}/metrics`, { label: 'miles', unit: 'miles', targetValue: 20 });
  assert.equal(miles.body.goal.id, goalId, 'answered with the goal, not the step');
  assert.equal(miles.body.goal.subGoals[0].metrics.length, 2);

  await request('PATCH', '/api/goals/metrics', { id: rides.body.metricId, delta: 1 });
  const after = (await request('GET', `/api/goals/${goalId}`)).body.goal;
  assert.equal(after.subGoals[0].progress.percent, 25, 'one of two rides and no miles yet');
  assert.equal(after.progress.percent, 25, 'and the goal reads it rather than waiting for the tick');
});
