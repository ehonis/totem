// strava/cache.mjs — reading the athlete's activity mirror.
//
// The mirror is Bushido's: it holds the grant and keeps the raw SummaryActivity
// list (keyed by id) current, because Strava's read budget makes "how many miles
// this year" too expensive to answer live. Totem gets a copy through
// `strava.readCache()` (strava/remote.mjs) and does goal arithmetic over it
// (goals/sources.mjs). Raw rows rather than shaped ones, so a fix to `shape.mjs`
// applies to history without a resync.

const CACHE_VERSION = 1

function normalizeCache(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== CACHE_VERSION || !raw.activities || typeof raw.activities !== 'object') return { activities: {} }
  return { ...raw, activities: { ...raw.activities } }
}

const startOf = (a) => Date.parse(a?.start_date || '')

/** The cached activities as a list, newest first. Anything unreadable is an empty list. */
export function cachedActivities(cache) {
  return Object.values(normalizeCache(cache).activities).sort((a, b) => startOf(b) - startOf(a))
}
