import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createGoalMetricSources, normalizeSourceConfig, STRAVA_MEASURES } from './sources.mjs';

const WEEK = { start: '2026-09-13', end: '2026-09-19' };

// The shape `strava.readCache()` returns: a cache whose activities are raw-ish rows that
// summarizeActivity() maps. Distances are metres, and `start_date_local` is wall clock.
const activity = (id, dayKey, km, over = {}) => ({
  id,
  name: `ride ${id}`,
  start_date_local: `${dayKey}T09:00:00Z`,
  start_date: `${dayKey}T13:00:00Z`,
  distance: km * 1000,
  moving_time: 3600,
  elapsed_time: 3600,
  total_elevation_gain: 100,
  type: 'Ride',
  sport_type: 'Ride',
  gear_id: 'b1',
  ...over,
});

const cacheOf = (list) => ({
  version: 1,
  updatedAt: '2026-09-15T12:00:00.000Z',
  activities: Object.fromEntries(list.map((a) => [String(a.id), a])),
});

const fakeStrava = (over = {}) => ({
  configured: () => true,
  readCache: async () => cacheOf([]),
  gear: async () => { throw new Error('no gear'); },
  ...over,
});

test('a manual metric stores an empty config, never a second way of saying manual', () => {
  assert.deepEqual(normalizeSourceConfig('manual', { sport: 'Ride' }), {});
});

test('a source config is validated at write time, not discovered at read time', () => {
  assert.deepEqual(
    normalizeSourceConfig('strava_distance', { sport: 'Ride', measure: 'distanceMi' }),
    { sport: 'Ride', gearId: null, measure: 'distanceMi' },
  );
  assert.equal(normalizeSourceConfig('strava_distance', {}).measure, 'distanceMi', 'miles by default');
  assert.throws(() => normalizeSourceConfig('strava_distance', { measure: 'furlongs' }), /unknown measure/);
  assert.throws(() => normalizeSourceConfig('garmin_steps', {}), /unknown metric source/);
  // An odometer with no bike would sit unavailable forever with nothing saying why.
  assert.throws(() => normalizeSourceConfig('strava_gear_odometer', {}), /needs a gearId/);
  assert.throws(() => normalizeSourceConfig('strava_gear_odometer', { gearId: 'b1', measure: 'count' }), /only measures distance/);
  assert.ok(STRAVA_MEASURES.includes('movingHours'));
});

test('a manual metric is never handed to a connector', async () => {
  let touched = false;
  const sources = createGoalMetricSources({ strava: fakeStrava({ readCache: async () => { touched = true; return cacheOf([]); } }) });
  const out = await sources.resolve([{ id: 'm1', sourceKind: 'manual', sourceConfig: {}, period: WEEK }]);
  assert.equal(out.size, 0);
  assert.equal(touched, false);
});

test('an unconfigured Strava reports unavailable rather than zero', async () => {
  for (const strava of [null, fakeStrava({ configured: () => false })]) {
    const sources = createGoalMetricSources({ strava });
    const out = await sources.resolve([{ id: 'm1', sourceKind: 'strava_distance', sourceConfig: {}, period: WEEK }]);
    assert.equal(out.get('m1').available, false);
    assert.equal(out.get('m1').value, null, 'a disconnected connector must not read as a week of nothing');
    assert.match(out.get('m1').reason, /not connected/);
  }
});

test('distance sums only the activities inside the goal period', async () => {
  const strava = fakeStrava({
    readCache: async () => cacheOf([
      activity(1, '2026-09-12', 10),  // the day before the window
      activity(2, '2026-09-13', 10),  // first day, counts
      activity(3, '2026-09-16', 20),  // counts
      activity(4, '2026-09-19', 10),  // last day, counts
      activity(5, '2026-09-20', 50),  // the day after
    ]),
  });
  const sources = createGoalMetricSources({ strava });
  const out = await sources.resolve([{ id: 'm1', sourceKind: 'strava_distance', sourceConfig: { measure: 'distanceKm' }, period: WEEK }]);
  const hit = out.get('m1');
  assert.equal(hit.available, true);
  assert.equal(hit.value, 40, 'both boundary days are inside the window; neighbours are not');
  assert.ok(hit.readAt);
});

test('sport and gear filters narrow the same cache read', async () => {
  const strava = fakeStrava({
    readCache: async () => cacheOf([
      activity(1, '2026-09-14', 10, { type: 'Ride', sport_type: 'Ride', gear_id: 'b1' }),
      activity(2, '2026-09-15', 5, { type: 'Run', sport_type: 'Run', gear_id: 'g1' }),
      activity(3, '2026-09-16', 20, { type: 'Ride', sport_type: 'Ride', gear_id: 'b2' }),
    ]),
  });
  const sources = createGoalMetricSources({ strava });
  const out = await sources.resolve([
    { id: 'rides', sourceKind: 'strava_distance', sourceConfig: { sport: 'Ride', measure: 'distanceKm' }, period: WEEK },
    { id: 'runs', sourceKind: 'strava_distance', sourceConfig: { sport: 'Run', measure: 'distanceKm' }, period: WEEK },
    { id: 'grizl', sourceKind: 'strava_distance', sourceConfig: { gearId: 'b2', measure: 'distanceKm' }, period: WEEK },
    { id: 'howmany', sourceKind: 'strava_distance', sourceConfig: { measure: 'count' }, period: WEEK },
  ]);
  assert.equal(out.get('rides').value, 30);
  assert.equal(out.get('runs').value, 5);
  assert.equal(out.get('grizl').value, 20);
  assert.equal(out.get('howmany').value, 3, 'a goal can count rides as well as miles');
});

test('an empty cache says so instead of reading as zero progress', async () => {
  const sources = createGoalMetricSources({ strava: fakeStrava() });
  const out = await sources.resolve([{ id: 'm1', sourceKind: 'strava_distance', sourceConfig: {}, period: WEEK }]);
  assert.equal(out.get('m1').available, false);
  assert.match(out.get('m1').reason, /no Strava activities cached/);
});

test('resolving a page of goals costs one cache read, not one per metric', async () => {
  let reads = 0;
  const strava = fakeStrava({
    readCache: async () => { reads += 1; return cacheOf([activity(1, '2026-09-14', 10)]); },
  });
  const sources = createGoalMetricSources({ strava });
  await sources.resolve(Array.from({ length: 8 }, (_, i) => (
    { id: `m${i}`, sourceKind: 'strava_distance', sourceConfig: {}, period: WEEK }
  )));
  assert.equal(reads, 1);
});

test('the gear odometer is lifetime, memoised, and never a period sum', async () => {
  let calls = 0;
  let clock = 0;
  const strava = fakeStrava({
    gear: async (id) => { calls += 1; return { id, name: 'Grizl', distanceMi: 1840.6, distanceKm: 2962.1 }; },
  });
  const sources = createGoalMetricSources({ strava, gearTtlMs: 1000, now: () => clock });

  const first = await sources.resolve([{ id: 'm1', sourceKind: 'strava_gear_odometer', sourceConfig: { gearId: 'b1', measure: 'distanceMi' }, period: WEEK }]);
  assert.equal(first.get('m1').value, 1840.6);
  assert.equal(calls, 1);

  clock = 500;
  await sources.resolve([{ id: 'm1', sourceKind: 'strava_gear_odometer', sourceConfig: { gearId: 'b1' }, period: WEEK }]);
  assert.equal(calls, 1, 'inside the TTL a page of goals costs no extra calls');

  clock = 2000;
  await sources.resolve([{ id: 'm1', sourceKind: 'strava_gear_odometer', sourceConfig: { gearId: 'b1' }, period: WEEK }]);
  assert.equal(calls, 2, 'past the TTL it reads again');
});

test('a failing odometer read reports the reason and does not throw', async () => {
  const strava = fakeStrava({ gear: async () => { throw new Error('rate limited'); } });
  const sources = createGoalMetricSources({ strava });
  const out = await sources.resolve([{ id: 'm1', sourceKind: 'strava_gear_odometer', sourceConfig: { gearId: 'b1' }, period: WEEK }]);
  assert.equal(out.get('m1').available, false);
  assert.match(out.get('m1').reason, /rate limited/);
});

test('reading a goal never triggers a sync', async () => {
  // A dashboard poll must not be able to spend an API quota.
  const strava = fakeStrava({
    readCache: async () => cacheOf([activity(1, '2026-09-14', 10)]),
    sync: async () => { throw new Error('sync must not be called from a read path'); },
  });
  const sources = createGoalMetricSources({ strava });
  const out = await sources.resolve([{ id: 'm1', sourceKind: 'strava_distance', sourceConfig: { measure: 'distanceKm' }, period: WEEK }]);
  assert.equal(out.get('m1').value, 10);
});

/*
 * The symptom that started this: a trail run that "didn't count" toward a running goal.
 *
 * It does — `matchesSport` resolves a sport_type to its family, so a filter of "Run"
 * (or "run") counts TrailRun and VirtualRun as well. The real cause was the activity
 * cache not yet holding that morning's run. Pinned here so a future change to the sport
 * filter cannot quietly make the original guess true.
 */
test('a sport filter counts every workout type in that sport, not just the plain one', async () => {
  const strava = fakeStrava({
    readCache: async () => cacheOf([
      activity(1, '2026-09-14', 5, { type: 'Run', sport_type: 'Run' }),
      activity(2, '2026-09-15', 8, { type: 'Run', sport_type: 'TrailRun' }),
      activity(3, '2026-09-16', 3, { type: 'Run', sport_type: 'VirtualRun' }),
      activity(4, '2026-09-16', 40, { type: 'Ride', sport_type: 'GravelRide' }),
    ]),
  });
  const sources = createGoalMetricSources({ strava });
  const out = await sources.resolve([
    { id: 'exact', sourceKind: 'strava_distance', sourceConfig: { sport: 'Run', measure: 'distanceKm' }, period: WEEK },
    { id: 'family', sourceKind: 'strava_distance', sourceConfig: { sport: 'run', measure: 'distanceKm' }, period: WEEK },
    { id: 'rides', sourceKind: 'strava_distance', sourceConfig: { sport: 'ride', measure: 'distanceKm' }, period: WEEK },
  ]);

  // 5 + 8 + 3, and the gravel ride stays out of it.
  assert.equal(out.get('exact').value, 16);
  assert.equal(out.get('family').value, 16, 'the exact sport_type and its family mean the same thing');
  assert.equal(out.get('rides').value, 40);
});
