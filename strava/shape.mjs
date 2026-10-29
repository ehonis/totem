// strava/shape.mjs — pure normalizers for Strava API payloads.
//
// Strava speaks metric SI on the wire: metres, seconds, metres per second,
// degrees Celsius. The owner's training log (Bushido) and his own head speak miles,
// minutes, mph and feet. Rather than pick one, every shaped record carries BOTH
// — `distanceMi` beside `distanceKm` beside the raw `distanceMeter` — so a
// reader never has to know which unit a field was stored in, and a model
// answering "how far did I ride in August" does not do the conversion itself.
//
// Nothing in here touches the network or the filesystem, which is what makes
// it testable as arithmetic (strava/shape.test.mjs). Bushido's client fetches and
// shapes what the API answers; what is left here is what Totem computes itself
// over the activity cache: goal metrics (goals/sources.mjs) and weight input.

const METERS_PER_MILE = 1609.344
const METERS_PER_FOOT = 0.3048

export const num = (v, dp = null) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  if (dp === null) return n
  const f = 10 ** dp
  return Math.round(n * f) / f
}

export const metersToMi = (m, dp = 2) => (num(m) === null ? null : num(num(m) / METERS_PER_MILE, dp))
export const metersToKm = (m, dp = 2) => (num(m) === null ? null : num(num(m) / 1000, dp))
export const metersToFt = (m, dp = 0) => (num(m) === null ? null : num(num(m) / METERS_PER_FOOT, dp))
export const mpsToMph = (v, dp = 1) => (num(v) === null ? null : num((num(v) * 3600) / METERS_PER_MILE, dp))
export const mpsToKph = (v, dp = 1) => (num(v) === null ? null : num(num(v) * 3.6, dp))
export const secToMin = (s, dp = 0) => (num(s) === null ? null : num(num(s) / 60, dp))
export const lbToKg = (lb, dp = 2) => (num(lb) === null ? null : num(num(lb) / 2.20462, dp))
export const cToF = (c, dp = 0) => (num(c) === null ? null : num((num(c) * 9) / 5 + 32, dp))

/** "8:04" per mile from metres and moving seconds. Null when either is missing or zero. */
export function paceMinPer(distanceMeter, movingSec, unitMeters) {
  const d = num(distanceMeter)
  const s = num(movingSec)
  if (!d || !s || d <= 0 || s <= 0) return null
  const minutes = s / 60 / (d / unitMeters)
  return num(minutes, 2)
}

export const paceLabel = (minutes) => {
  if (num(minutes) === null) return null
  const whole = Math.floor(minutes)
  const secs = Math.round((minutes - whole) * 60)
  return secs === 60 ? `${whole + 1}:00` : `${whole}:${String(secs).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Sport families. Strava has ~50 sport_type values; grouping them is what lets
// "how many miles have I ridden" mean the gravel ride and the trainer session
// too. Kept as data so a new sport type is one line, not a code change.
// ---------------------------------------------------------------------------
export const SPORT_FAMILIES = {
  ride: ['Ride', 'VirtualRide', 'GravelRide', 'MountainBikeRide', 'EBikeRide', 'EMountainBikeRide', 'Handcycle', 'Velomobile'],
  run: ['Run', 'TrailRun', 'VirtualRun'],
  walk: ['Walk'],
  hike: ['Hike'],
  swim: ['Swim'],
  lift: ['WeightTraining', 'Crossfit', 'HighIntensityIntervalTraining'],
  climbing: ['RockClimbing'],
  mobility: ['Yoga', 'Pilates', 'Elliptical', 'StairStepper'],
  ski: ['AlpineSki', 'BackcountrySki', 'NordicSki', 'Snowboard', 'Snowshoe', 'IceSkate', 'RollerSki', 'InlineSkate', 'Skateboard'],
  water: ['Rowing', 'VirtualRow', 'Canoeing', 'Kayaking', 'StandUpPaddling', 'Surfing', 'Kitesurf', 'Windsurf', 'Sail'],
  sport: ['Soccer', 'Golf', 'Tennis', 'Pickleball', 'Racquetball', 'Squash', 'Badminton', 'TableTennis', 'Wheelchair'],
  other: ['Workout'],
}

const FAMILY_BY_SPORT = new Map()
for (const [family, sports] of Object.entries(SPORT_FAMILIES)) {
  for (const s of sports) FAMILY_BY_SPORT.set(s.toLowerCase(), family)
}

/** Which family a sport_type (or legacy type) belongs to. Unknown → 'other'. */
export function sportFamily(sport) {
  if (!sport) return 'other'
  return FAMILY_BY_SPORT.get(String(sport).toLowerCase()) || 'other'
}

/** Foot sports report pace; wheeled and water sports report speed. */
export const FOOT_FAMILIES = new Set(['run', 'walk', 'hike'])

/**
 * Does an activity match a sport filter? The filter may be a family ('ride'),
 * an exact sport_type ('GravelRide'), or a comma list of either. Case-insensitive.
 */
export function matchesSport(activity, filter) {
  if (!filter) return true
  const wanted = String(filter).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (!wanted.length) return true
  const sport = String(activity?.sport || activity?.sport_type || activity?.type || '').toLowerCase()
  const family = sportFamily(activity?.sport || activity?.sport_type || activity?.type)
  return wanted.some((w) => w === sport || w === family || (w === 'bike' && family === 'ride') || (w === 'cycling' && family === 'ride'))
}

// ---------------------------------------------------------------------------
// Dates. Strava's `start_date_local` is the athlete's wall clock with a "Z"
// stuck on the end — "2026-09-06T14:47:00Z" means 14:47 where he was, not UTC.
// Reading it as an instant would file an evening ride under tomorrow for
// anyone east of Greenwich, so the local stamp is taken as text and the real
// instant comes from `start_date` + `utc_offset`.
// ---------------------------------------------------------------------------
export const localStamp = (startDateLocal) => {
  if (!startDateLocal || typeof startDateLocal !== 'string') return null
  return startDateLocal.replace(/Z$/, '').slice(0, 16)
}
export const localDate = (startDateLocal) => (localStamp(startDateLocal) || '').slice(0, 10) || null

/** ISO instant of an activity's END, from its UTC start and elapsed seconds. */
export function endInstant(startDate, elapsedSec) {
  const t = Date.parse(startDate)
  const e = num(elapsedSec)
  if (!Number.isFinite(t) || e === null) return null
  return new Date(t + e * 1000).toISOString()
}

export const activityUrl = (id) => (id ? `https://www.strava.com/activities/${id}` : null)

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

/**
 * One activity as everything downstream wants to see it: the SummaryActivity
 * fields, every quantity in metric AND imperial, minutes as well as seconds,
 * and a stable family label. Works on a DetailedActivity too — the summary
 * fields are a subset.
 */
export function summarizeActivity(a) {
  if (!a || typeof a !== 'object') return null
  const sport = a.sport_type || a.type || null
  const family = sportFamily(sport)
  const distance = num(a.distance)
  const moving = num(a.moving_time)
  const elapsed = num(a.elapsed_time)
  const foot = FOOT_FAMILIES.has(family)
  const paceMi = foot ? paceMinPer(distance, moving, METERS_PER_MILE) : null
  const paceKm = foot ? paceMinPer(distance, moving, 1000) : null
  return {
    id: a.id,
    name: a.name || null,
    sport,
    family,
    // Strava's legacy `type` (Ride/Run/…) survives for clients that still use it.
    type: a.type || null,
    workoutType: num(a.workout_type),
    date: localDate(a.start_date_local),
    start: a.start_date || null,
    end: endInstant(a.start_date, a.elapsed_time),
    startLocal: localStamp(a.start_date_local),
    timezone: a.timezone || null,
    utcOffsetSec: num(a.utc_offset),

    distanceMeter: distance,
    distanceMi: metersToMi(distance),
    distanceKm: metersToKm(distance),
    movingSec: moving,
    movingMin: secToMin(moving),
    elapsedSec: elapsed,
    elapsedMin: secToMin(elapsed),
    elevationM: num(a.total_elevation_gain, 1),
    elevationFt: metersToFt(a.total_elevation_gain),
    elevHighM: num(a.elev_high, 1),
    elevLowM: num(a.elev_low, 1),

    avgSpeedMps: num(a.average_speed, 3),
    avgMph: mpsToMph(a.average_speed),
    avgKph: mpsToKph(a.average_speed),
    maxSpeedMps: num(a.max_speed, 3),
    maxMph: mpsToMph(a.max_speed),
    maxKph: mpsToKph(a.max_speed),
    paceMinPerMi: paceMi,
    paceMinPerKm: paceKm,
    paceLabel: paceMi === null ? null : `${paceLabel(paceMi)} /mi`,

    hasHeartrate: Boolean(a.has_heartrate),
    avgHr: num(a.average_heartrate, 0),
    maxHr: num(a.max_heartrate, 0),
    avgCadence: num(a.average_cadence, 1),
    avgTempC: num(a.average_temp),
    avgTempF: cToF(a.average_temp),

    avgWatts: num(a.average_watts, 0),
    weightedAvgWatts: num(a.weighted_average_watts, 0),
    maxWatts: num(a.max_watts, 0),
    deviceWatts: a.device_watts === true,
    kilojoules: num(a.kilojoules, 0),
    // Only the detail endpoint reports calories. Left null rather than derived
    // from kilojoules — the two are close for cycling and wrong for everything else.
    calories: num(a.calories, 0),

    sufferScore: num(a.suffer_score),
    prCount: num(a.pr_count),
    achievementCount: num(a.achievement_count),
    kudosCount: num(a.kudos_count),
    commentCount: num(a.comment_count),
    athleteCount: num(a.athlete_count),
    photoCount: num(a.total_photo_count ?? a.photo_count),

    gearId: a.gear_id || null,
    trainer: Boolean(a.trainer),
    commute: Boolean(a.commute),
    manual: Boolean(a.manual),
    private: Boolean(a.private),
    flagged: Boolean(a.flagged),
    deviceName: a.device_name || null,
    externalId: a.external_id || null,
    uploadId: a.upload_id ?? null,
    startLatLng: Array.isArray(a.start_latlng) && a.start_latlng.length === 2 ? a.start_latlng : null,
    endLatLng: Array.isArray(a.end_latlng) && a.end_latlng.length === 2 ? a.end_latlng : null,
    location: [a.location_city, a.location_state, a.location_country].filter(Boolean).join(', ') || null,
    mapId: a.map?.id || null,
    summaryPolyline: a.map?.summary_polyline || null,
    url: activityUrl(a.id),
  }
}

// ---------------------------------------------------------------------------
// Aggregation — mileage over the activity cache.
// ---------------------------------------------------------------------------

/** Monday-start week, labelled by its Monday — the same week goals and habits use. */
export function weekOf(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

export const GROUPS = ['day', 'week', 'month', 'year', 'sport', 'family', 'gear', 'all']

function bucketKey(a, group) {
  switch (group) {
    case 'day': return a.date
    case 'week': return weekOf(a.date)
    case 'month': return (a.date || '').slice(0, 7) || null
    case 'year': return (a.date || '').slice(0, 4) || null
    case 'sport': return a.sport || 'unknown'
    case 'family': return a.family || 'other'
    case 'gear': return a.gearId || 'no-gear'
    default: return 'all'
  }
}

/**
 * Roll shaped activities up into buckets. Every bucket carries count, distance
 * (mi + km), moving time, elevation, and the average speed of the whole bucket
 * (distance over time, not a mean of per-ride averages — a 5-mile spin and a
 * 50-mile ride do not weigh the same).
 */
export function mileage(activities, { group = 'week', sport = null, gearId = null, from = null, to = null } = {}) {
  if (!GROUPS.includes(group)) throw new Error(`unknown group "${group}" — use one of ${GROUPS.join(', ')}`)
  const buckets = new Map()
  let matched = 0
  for (const a of activities || []) {
    if (!a?.date) continue
    if (from && a.date < from) continue
    if (to && a.date > to) continue
    if (sport && !matchesSport(a, sport)) continue
    if (gearId && a.gearId !== gearId) continue
    matched++
    const key = bucketKey(a, group)
    const b = buckets.get(key) || { key, count: 0, distanceMeter: 0, movingSec: 0, elapsedSec: 0, elevationM: 0, kilojoules: 0, sports: {}, first: a.date, last: a.date }
    b.count++
    b.distanceMeter += a.distanceMeter || 0
    b.movingSec += a.movingSec || 0
    b.elapsedSec += a.elapsedSec || 0
    b.elevationM += a.elevationM || 0
    b.kilojoules += a.kilojoules || 0
    b.sports[a.sport || 'unknown'] = (b.sports[a.sport || 'unknown'] || 0) + 1
    if (a.date < b.first) b.first = a.date
    if (a.date > b.last) b.last = a.date
    buckets.set(key, b)
  }
  const rows = [...buckets.values()].map((b) => ({
    key: b.key,
    count: b.count,
    distanceMi: metersToMi(b.distanceMeter, 1),
    distanceKm: metersToKm(b.distanceMeter, 1),
    distanceMeter: Math.round(b.distanceMeter),
    movingMin: secToMin(b.movingSec),
    movingHours: num(b.movingSec / 3600, 1),
    elapsedMin: secToMin(b.elapsedSec),
    elevationFt: metersToFt(b.elevationM),
    elevationM: Math.round(b.elevationM),
    kilojoules: Math.round(b.kilojoules),
    avgMph: b.movingSec > 0 ? mpsToMph(b.distanceMeter / b.movingSec) : null,
    sports: b.sports,
    first: b.first,
    last: b.last,
  }))
  // Time buckets newest first; categorical buckets by distance.
  const timeGroup = ['day', 'week', 'month', 'year'].includes(group)
  rows.sort((x, y) => (timeGroup ? String(y.key).localeCompare(String(x.key)) : (y.distanceMeter - x.distanceMeter)))
  const total = rows.reduce((acc, r) => ({
    count: acc.count + r.count,
    distanceMeter: acc.distanceMeter + r.distanceMeter,
    movingMin: acc.movingMin + (r.movingMin || 0),
    elevationFt: acc.elevationFt + (r.elevationFt || 0),
  }), { count: 0, distanceMeter: 0, movingMin: 0, elevationFt: 0 })
  return {
    group,
    filter: { sport: sport || null, gearId: gearId || null, from: from || null, to: to || null },
    matched,
    total: { ...total, distanceMi: metersToMi(total.distanceMeter, 1), distanceKm: metersToKm(total.distanceMeter, 1) },
    buckets: rows,
  }
}
