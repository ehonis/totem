// strava/cache.mjs — the local mirror of the athlete's activity list.
//
// Why a cache at all, when the whole point of the connector is live reads:
// Strava's read budget is 100 requests per 15 minutes and 1,000 a day, and a
// question like "how many miles this year, by bike" is every page of the
// activity list — several requests, every time it is asked. Mileage over any
// window is the one thing worth answering from disk. Everything else (one
// activity's detail, streams, gear, stats) stays live.
//
// What is stored is the RAW SummaryActivity, not the shaped record: shaping is
// cheap, and keeping the wire format means a fix to `shape.mjs` applies to
// history without a resync. Stored keyed by id so a re-fetch of an edited ride
// replaces it in place.
//
// Two sync modes:
//   incremental — `after` the newest cached start (minus a few days, because an
//                 activity uploaded late still starts on the day it happened),
//                 forward until a short page. The scheduled job runs this.
//   full        — walks backward with `before` from the oldest cached start
//                 until Strava runs out, bounded by `pages`. Resumable: a run
//                 that hits the page cap leaves `complete: false` and the next
//                 full sync carries on from `oldestStart`.
//
// Pure with respect to I/O: the caller injects `read`/`write` (the file) and
// `fetchPage` (the API), so the whole thing is testable without either.

export const CACHE_VERSION = 1
export const PAGE_SIZE = 200
export const OVERLAP_DAYS = 3

export function emptyCache() {
  return { version: CACHE_VERSION, athleteId: null, updatedAt: null, oldestStart: null, newestStart: null, complete: false, activities: {} }
}

export function normalizeCache(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== CACHE_VERSION || !raw.activities || typeof raw.activities !== 'object') return emptyCache()
  return { ...emptyCache(), ...raw, activities: { ...raw.activities } }
}

const startOf = (a) => Date.parse(a?.start_date || '')

function recomputeBounds(cache) {
  let oldest = Infinity
  let newest = -Infinity
  for (const a of Object.values(cache.activities)) {
    const t = startOf(a)
    if (!Number.isFinite(t)) continue
    if (t < oldest) oldest = t
    if (t > newest) newest = t
  }
  cache.oldestStart = Number.isFinite(oldest) ? new Date(oldest).toISOString() : null
  cache.newestStart = Number.isFinite(newest) ? new Date(newest).toISOString() : null
  return cache
}

/**
 * Bring the cache up to date.
 *
 * `fetchPage({ after, before, page, perPage })` must return an array of raw
 * SummaryActivity objects (Strava's `GET /athlete/activities`). `after` and
 * `before` are epoch SECONDS, Strava's convention.
 *
 * Returns `{ cache, added, updated, pages, mode, complete, exhausted }`.
 */
export async function syncCache({ read, write, fetchPage, full = false, pages = 10, athleteId = null, now = () => Date.now() } = {}) {
  const cache = normalizeCache(await read())
  if (athleteId && cache.athleteId && String(cache.athleteId) !== String(athleteId)) {
    // A different athlete connected. Their history is not this one's.
    Object.assign(cache, emptyCache())
  }
  if (athleteId) cache.athleteId = athleteId
  const maxPages = Math.min(Math.max(Math.round(Number(pages)) || 10, 1), 100)
  const empty = Object.keys(cache.activities).length === 0
  const mode = full || empty ? 'full' : 'incremental'

  let added = 0
  let updated = 0
  let fetched = 0
  let exhausted = false
  const upsert = (list) => {
    for (const a of list) {
      if (!a?.id) continue
      const key = String(a.id)
      if (cache.activities[key]) updated++
      else added++
      cache.activities[key] = a
    }
  }

  if (mode === 'incremental') {
    const newest = Date.parse(cache.newestStart || '')
    const after = Number.isFinite(newest) ? Math.floor(newest / 1000) - OVERLAP_DAYS * 86_400 : undefined
    for (let page = 1; page <= maxPages; page++) {
      const list = await fetchPage({ after, page, perPage: PAGE_SIZE })
      fetched++
      upsert(Array.isArray(list) ? list : [])
      if (!Array.isArray(list) || list.length < PAGE_SIZE) { exhausted = true; break }
    }
  } else {
    // Backward from where we stopped last time, or from now on a fresh cache.
    // Using `before` rather than page numbers makes the walk resumable: page 7
    // of "everything" moves as new rides land, but "before this instant" does not.
    let before = cache.complete === false && cache.oldestStart
      ? Math.floor(Date.parse(cache.oldestStart) / 1000)
      : Math.floor(now() / 1000) + 86_400
    // A full sync on a non-empty, complete cache re-reads the recent end first so
    // it is also a refresh, then declares itself done — there is nothing older.
    if (!empty && cache.complete !== false) {
      const list = await fetchPage({ page: 1, perPage: PAGE_SIZE })
      fetched++
      upsert(Array.isArray(list) ? list : [])
      exhausted = true
    } else {
      for (let page = 1; page <= maxPages; page++) {
        const list = await fetchPage({ before, page: 1, perPage: PAGE_SIZE })
        fetched++
        const arr = Array.isArray(list) ? list : []
        upsert(arr)
        if (arr.length < PAGE_SIZE) { exhausted = true; break }
        const oldest = Math.min(...arr.map(startOf).filter(Number.isFinite))
        if (!Number.isFinite(oldest)) { exhausted = true; break }
        // Strava's `before` is exclusive of nothing in particular — step back one
        // second past the oldest start so the boundary activity is not re-fetched
        // forever. It was already stored by the upsert above.
        before = Math.floor(oldest / 1000)
      }
    }
    if (exhausted) cache.complete = true
    else cache.complete = false
  }

  recomputeBounds(cache)
  cache.updatedAt = new Date(now()).toISOString()
  await write(cache)
  return { cache, mode, added, updated, pages: fetched, complete: cache.complete, exhausted, count: Object.keys(cache.activities).length }
}

/** The cached activities as a list, newest first. */
export function cachedActivities(cache) {
  return Object.values(normalizeCache(cache).activities).sort((a, b) => startOf(b) - startOf(a))
}

/** Age of the cache in minutes, or null if never synced. */
export function cacheAgeMinutes(cache, now = Date.now()) {
  const t = Date.parse(cache?.updatedAt || '')
  return Number.isFinite(t) ? Math.round((now - t) / 60_000) : null
}
