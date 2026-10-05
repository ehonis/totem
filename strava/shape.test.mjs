import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  summarizeActivity, detailActivity, shapeGear, shapeStats, mileage, weekOf, sportFamily,
  matchesSport, localDate, localStamp, endInstant, paceLabel, shapeStreams, shapeActivityZones,
  daysAgoLocal,
} from './shape.mjs'

// A real-shaped SummaryActivity: a 20.1 mile gravel ride, 1h22 moving, 1h35 elapsed.
const RIDE = {
  id: 1234567890, name: 'Towpath out and back', distance: 32350.4, moving_time: 4920, elapsed_time: 5700,
  total_elevation_gain: 214.5, type: 'Ride', sport_type: 'GravelRide', workout_type: 10,
  start_date: '2026-09-06T14:47:00Z', start_date_local: '2026-09-06T10:47:00Z', timezone: '(GMT-05:00) America/New_York',
  utc_offset: -14400, start_latlng: [40.71, -74.0], end_latlng: [40.71, -74.0], average_speed: 6.575, max_speed: 13.2,
  average_cadence: 78.4, average_temp: 21, average_watts: 156.3, weighted_average_watts: 171, kilojoules: 769.2,
  device_watts: true, has_heartrate: true, average_heartrate: 141.6, max_heartrate: 172, max_watts: 612,
  pr_count: 2, achievement_count: 3, kudos_count: 4, comment_count: 0, athlete_count: 1, total_photo_count: 0,
  suffer_score: 61, gear_id: 'b1234', trainer: false, commute: false, manual: false, private: false,
  map: { id: 'a1234567890', summary_polyline: 'abc' }, device_name: 'Garmin Edge 540', external_id: 'x.fit', upload_id: 99,
}

test('a ride is shaped with both unit systems and minutes beside seconds', () => {
  const a = summarizeActivity(RIDE)
  assert.equal(a.id, RIDE.id)
  assert.equal(a.family, 'ride')
  assert.equal(a.sport, 'GravelRide')
  assert.equal(a.distanceMi, 20.1)
  assert.equal(a.distanceKm, 32.35)
  assert.equal(a.movingMin, 82)
  assert.equal(a.elapsedMin, 95)
  assert.equal(a.elevationFt, 704)
  assert.equal(a.avgMph, 14.7)
  assert.equal(a.avgKph, 23.7)
  assert.equal(a.maxMph, 29.5)
  assert.equal(a.avgHr, 142)
  assert.equal(a.maxHr, 172)
  assert.equal(a.avgWatts, 156)
  assert.equal(a.weightedAvgWatts, 171)
  assert.equal(a.kilojoules, 769)
  assert.equal(a.avgTempF, 70)
  assert.equal(a.gearId, 'b1234')
  assert.equal(a.url, 'https://www.strava.com/activities/1234567890')
  // No pace on a ride: pace is a foot-sport number.
  assert.equal(a.paceMinPerMi, null)
  assert.equal(a.paceLabel, null)
  // Summaries never carry calories — only the detail endpoint reports them.
  assert.equal(a.calories, null)
})

test('the local date comes from the wall-clock stamp, not the UTC instant', () => {
  // 23:30 local on the 5th is 03:30 UTC on the 6th. The ride happened on the 5th.
  const late = summarizeActivity({ ...RIDE, start_date: '2026-09-06T03:30:00Z', start_date_local: '2026-09-05T23:30:00Z' })
  assert.equal(late.date, '2026-09-05')
  assert.equal(late.startLocal, '2026-09-05T23:30')
  assert.equal(late.start, '2026-09-06T03:30:00Z')
  assert.equal(localDate('2026-09-05T23:30:00Z'), '2026-09-05')
  assert.equal(localStamp(null), null)
})

test('the end instant is start plus elapsed, in UTC', () => {
  assert.equal(endInstant('2026-09-06T14:47:00Z', 5700), '2026-09-06T16:22:00.000Z')
  assert.equal(endInstant('garbage', 10), null)
  assert.equal(summarizeActivity(RIDE).end, '2026-09-06T16:22:00.000Z')
})

test('a run gets a pace and a label; the label rounds to a whole second', () => {
  const run = summarizeActivity({ ...RIDE, sport_type: 'Run', type: 'Run', distance: 8046.72, moving_time: 2580 })
  assert.equal(run.family, 'run')
  assert.equal(run.paceMinPerMi, 8.6)
  assert.equal(run.paceLabel, '8:36 /mi')
  assert.equal(paceLabel(7.999), '8:00')
  assert.equal(paceLabel(null), null)
})

test('sport families cover the cycling variants and fall back to other', () => {
  assert.equal(sportFamily('Ride'), 'ride')
  assert.equal(sportFamily('VirtualRide'), 'ride')
  assert.equal(sportFamily('MountainBikeRide'), 'ride')
  assert.equal(sportFamily('TrailRun'), 'run')
  assert.equal(sportFamily('RockClimbing'), 'climbing')
  assert.equal(sportFamily('WeightTraining'), 'lift')
  assert.equal(sportFamily('Workout'), 'other')
  assert.equal(sportFamily('SomethingNew'), 'other')
  assert.equal(sportFamily(null), 'other')
})

test('a sport filter accepts a family, an exact type, a comma list, and bike as a synonym', () => {
  const a = summarizeActivity(RIDE)
  assert.equal(matchesSport(a, 'ride'), true)
  assert.equal(matchesSport(a, 'bike'), true)
  assert.equal(matchesSport(a, 'GravelRide'), true)
  assert.equal(matchesSport(a, 'gravelride'), true)
  assert.equal(matchesSport(a, 'run'), false)
  assert.equal(matchesSport(a, 'run,ride'), true)
  assert.equal(matchesSport(a, ''), true)
  assert.equal(matchesSport(a, null), true)
})

test('detail layers laps, splits, calories and gear on the summary', () => {
  const d = detailActivity({
    ...RIDE, calories: 812, description: 'windy', gear: { id: 'b1234', name: 'Canyon Grizl', distance: 2_413_000, primary: true },
    laps: [{ lap_index: 1, distance: 16000, moving_time: 2400, elapsed_time: 2700, average_speed: 6.67, average_heartrate: 139, total_elevation_gain: 100 }],
    splits_standard: [{ split: 1, distance: 1609.3, moving_time: 240, elapsed_time: 250, elevation_difference: 3, average_speed: 6.7 }],
    segment_efforts: [{ id: 5, name: 'Big hill', elapsed_time: 300, moving_time: 300, distance: 1200, start_date_local: '2026-09-06T11:00:00Z', pr_rank: 1, achievements: [{ type: 'pr', rank: 1 }], segment: { id: 7, distance: 1200, average_grade: 5.5, starred: true } }],
  })
  assert.equal(d.calories, 812)
  assert.equal(d.description, 'windy')
  assert.equal(d.gear.name, 'Canyon Grizl')
  assert.equal(d.gear.distanceMi, 1499.4)
  assert.equal(d.gear.kind, 'bike')
  assert.equal(d.laps.length, 1)
  assert.equal(d.laps[0].distanceMi, 9.94)
  assert.equal(d.laps[0].movingMin, 40)
  assert.equal(d.laps[0].elevationFt, 328)
  assert.equal(d.splitsStandard[0].index, 1)
  assert.equal(d.segmentEfforts[0].segmentId, 7)
  assert.equal(d.segmentEfforts[0].prRank, 1)
  assert.equal(d.segmentEfforts[0].segment.starred, true)
  assert.equal(d.segmentEffortCount, 1)
  // Efforts can be left out — a long ride carries a hundred of them.
  const lean = detailActivity({ ...RIDE, segment_efforts: [{ id: 5 }] }, { segmentEfforts: false })
  assert.equal(lean.segmentEfforts, undefined)
  assert.equal(lean.segmentEffortCount, 1)
})

test('gear carries the odometer in miles, and shoes are told apart from bikes', () => {
  assert.equal(shapeGear({ id: 'b1', distance: 1609344, weight: 9.5 }).distanceMi, 1000)
  assert.equal(shapeGear({ id: 'b1', distance: 1609344, weight: 9.5 }).weightLb, 20.9)
  assert.equal(shapeGear({ id: 'g1', distance: 100 }).kind, 'shoes')
  assert.equal(shapeGear(null), null)
})

test('stats give recent / ytd / all per sport in miles', () => {
  const s = shapeStats({
    biggest_ride_distance: 80467.2, biggest_climb_elevation_gain: 304.8,
    recent_ride_totals: { count: 4, distance: 96560.6, moving_time: 14400, elapsed_time: 15000, elevation_gain: 600, achievement_count: 2 },
    ytd_ride_totals: { count: 40, distance: 965606, moving_time: 144000, elapsed_time: 150000, elevation_gain: 6000 },
    all_ride_totals: { count: 400, distance: 9656064, moving_time: 1440000, elapsed_time: 1500000, elevation_gain: 60000 },
    recent_run_totals: { count: 0, distance: 0, moving_time: 0, elapsed_time: 0, elevation_gain: 0 },
    ytd_run_totals: null, all_run_totals: null, recent_swim_totals: null, ytd_swim_totals: null, all_swim_totals: null,
  })
  assert.equal(s.biggestRideDistanceMi, 50)
  assert.equal(s.biggestClimbElevationFt, 1000)
  assert.equal(s.ride.recent.distanceMi, 60)
  assert.equal(s.ride.recent.movingHours, 4)
  assert.equal(s.ride.ytd.distanceMi, 600)
  assert.equal(s.ride.all.distanceMi, 6000)
  assert.equal(s.run.recent.count, 0)
  assert.equal(s.run.ytd, null)
})

test('weeks start on Sunday and are labelled by that Sunday', () => {
  assert.equal(weekOf('2026-09-07'), '2026-09-07') // a Monday
  assert.equal(weekOf('2026-09-12'), '2026-09-07') // Saturday → same week
  assert.equal(weekOf('2026-09-13'), '2026-09-07') // Sunday → still the same week
  assert.equal(weekOf('2026-09-14'), '2026-09-14') // next Monday
  assert.equal(weekOf('nope'), null)
})

test('mileage rolls activities into buckets with a distance-weighted average speed', () => {
  const acts = [
    summarizeActivity({ ...RIDE, id: 1, start_date_local: '2026-09-07T10:00:00Z', distance: 16093.44, moving_time: 3600 }), // Monday: 10 mi in 1h
    summarizeActivity({ ...RIDE, id: 2, start_date_local: '2026-09-13T10:00:00Z', distance: 48280.32, moving_time: 7200 }), // Sunday, same week: 30 mi in 2h
    summarizeActivity({ ...RIDE, id: 3, sport_type: 'Run', type: 'Run', start_date_local: '2026-09-09T10:00:00Z', distance: 8046.72, moving_time: 2400 }), // 5 mi run
    summarizeActivity({ ...RIDE, id: 4, gear_id: 'b999', start_date_local: '2026-08-30T10:00:00Z', distance: 16093.44, moving_time: 3600 }), // an earlier week, other bike
  ]
  const weeks = mileage(acts, { group: 'week', sport: 'ride' })
  assert.equal(weeks.matched, 3)
  assert.equal(weeks.buckets.length, 2)
  assert.equal(weeks.buckets[0].key, '2026-09-07') // newest first, labelled by its Monday
  assert.equal(weeks.buckets[0].count, 2)
  assert.equal(weeks.buckets[0].distanceMi, 40)
  assert.equal(weeks.buckets[0].movingMin, 180)
  // 40 miles over 3 hours is 13.3 mph — not the mean of 10 and 15.
  assert.equal(weeks.buckets[0].avgMph, 13.3)
  assert.equal(weeks.total.distanceMi, 50)

  const byGear = mileage(acts, { group: 'gear' })
  assert.equal(byGear.buckets[0].key, 'b1234') // categorical buckets by distance
  assert.equal(byGear.buckets[0].distanceMi, 45)
  assert.equal(byGear.buckets[1].key, 'b999')

  const oneBike = mileage(acts, { group: 'all', gearId: 'b999' })
  assert.equal(oneBike.total.count, 1)
  assert.equal(oneBike.buckets[0].key, 'all')

  const windowed = mileage(acts, { group: 'month', from: '2026-09-01' })
  assert.equal(windowed.matched, 3)
  assert.equal(windowed.buckets[0].key, '2026-09')

  assert.throws(() => mileage(acts, { group: 'fortnight' }), /unknown group/)
})

test('streams and activity zones normalise both response shapes', () => {
  const keyed = shapeStreams({ heartrate: { data: [120, 130], series_type: 'time', original_size: 2, resolution: 'high' }, time: { data: [0, 1] } })
  assert.equal(keyed.heartrate.type, 'heartrate')
  assert.deepEqual(keyed.heartrate.data, [120, 130])
  assert.equal(keyed.time.data.length, 2)
  const arr = shapeStreams([{ type: 'watts', data: [200], series_type: 'distance' }])
  assert.equal(arr.watts.seriesType, 'distance')

  const zones = shapeActivityZones([{ type: 'heartrate', sensor_based: true, distribution_buckets: [{ min: 0, max: 120, time: 600 }, { min: 120, max: 150, time: 1800 }] }])
  assert.equal(zones[0].buckets[1].minutes, 30)
  assert.equal(zones[0].buckets.length, 2)
})

test('daysAgoLocal is a local calendar date', () => {
  const now = new Date('2026-09-07T02:00:00Z') // 22:00 on the 6th in New York
  assert.equal(daysAgoLocal(0, { now, timeZone: 'America/New_York' }), '2026-09-06')
  assert.equal(daysAgoLocal(7, { now, timeZone: 'America/New_York' }), '2026-08-30')
  assert.equal(daysAgoLocal(0, { now, timeZone: 'UTC' }), '2026-09-07')
})
