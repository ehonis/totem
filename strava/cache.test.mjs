import { test } from 'node:test'
import assert from 'node:assert/strict'
import { syncCache, emptyCache, cachedActivities, cacheAgeMinutes, PAGE_SIZE } from './cache.mjs'

const DAY = 86_400_000
const NOW = Date.parse('2026-09-07T12:00:00Z')

// A fake Strava with N activities one day apart, newest first, that honours
// `after`/`before` (epoch seconds) and `page`/`perPage` the way the real one does.
function fakeStrava(total, { startAt = NOW - DAY } = {}) {
  const all = Array.from({ length: total }, (_, i) => ({ id: 1000 + i, name: `ride ${i}`, start_date: new Date(startAt - i * DAY).toISOString(), distance: 16093 }))
  const calls = []
  const fetchPage = async ({ after, before, page = 1, perPage = PAGE_SIZE }) => {
    calls.push({ after, before, page, perPage })
    let list = all
    if (after !== undefined) list = list.filter((a) => Date.parse(a.start_date) / 1000 > after)
    if (before !== undefined) list = list.filter((a) => Date.parse(a.start_date) / 1000 < before)
    return list.slice((page - 1) * perPage, page * perPage)
  }
  return { all, calls, fetchPage, push: (a) => all.unshift(a) }
}

function memoryStore(initial = null) {
  let doc = initial
  return { read: async () => doc, write: async (next) => { doc = JSON.parse(JSON.stringify(next)) }, get: () => doc }
}

test('an empty cache does a full backfill and marks itself complete when Strava runs out', async () => {
  const strava = fakeStrava(450)
  const store = memoryStore()
  const r = await syncCache({ ...store, fetchPage: strava.fetchPage, athleteId: 7, now: () => NOW })
  assert.equal(r.mode, 'full')
  assert.equal(r.added, 450)
  assert.equal(r.count, 450)
  assert.equal(r.complete, true)
  assert.equal(r.pages, 3) // 200 + 200 + 50
  assert.equal(store.get().athleteId, 7)
  assert.equal(store.get().newestStart, strava.all[0].start_date)
  assert.equal(store.get().oldestStart, strava.all[449].start_date)
})

test('a page cap leaves the cache incomplete and the next full sync resumes from the oldest', async () => {
  const strava = fakeStrava(450)
  const store = memoryStore()
  const first = await syncCache({ ...store, fetchPage: strava.fetchPage, pages: 1, now: () => NOW })
  assert.equal(first.complete, false)
  assert.equal(first.count, 200)
  const second = await syncCache({ ...store, fetchPage: strava.fetchPage, full: true, pages: 1, now: () => NOW })
  assert.equal(second.mode, 'full')
  assert.equal(second.count, 400)
  assert.equal(second.complete, false)
  // The resume asked for activities BEFORE the oldest one already held.
  const resumeCall = strava.calls[1]
  assert.ok(resumeCall.before <= Date.parse(store.get().activities['1199'].start_date) / 1000 + 1)
  const third = await syncCache({ ...store, fetchPage: strava.fetchPage, full: true, pages: 5, now: () => NOW })
  assert.equal(third.count, 450)
  assert.equal(third.complete, true)
})

test('an incremental sync only asks for what is new, with a few days of overlap', async () => {
  const strava = fakeStrava(30)
  const store = memoryStore()
  await syncCache({ ...store, fetchPage: strava.fetchPage, now: () => NOW })
  strava.calls.length = 0
  // Two new rides land, and an old one is edited (renamed).
  strava.push({ id: 5001, name: 'new one', start_date: new Date(NOW).toISOString(), distance: 1 })
  strava.push({ id: 5002, name: 'newer', start_date: new Date(NOW + 3600_000).toISOString(), distance: 2 })
  strava.all.find((a) => a.id === 1001).name = 'renamed'
  const r = await syncCache({ ...store, fetchPage: strava.fetchPage, now: () => NOW + DAY })
  assert.equal(r.mode, 'incremental')
  assert.equal(r.added, 2)
  assert.ok(r.updated >= 2, 'the overlap window re-reads recent activities')
  assert.equal(r.pages, 1)
  const newest = Date.parse(strava.all[2].start_date) / 1000 // the newest BEFORE this sync
  assert.equal(strava.calls[0].after, newest - 3 * 86_400)
  assert.equal(store.get().activities['1001'].name, 'renamed')
  assert.equal(store.get().activities['5002'].name, 'newer')
  assert.equal(r.count, 32)
})

test('a different athlete connecting throws away the old history', async () => {
  const strava = fakeStrava(5)
  const store = memoryStore()
  await syncCache({ ...store, fetchPage: strava.fetchPage, athleteId: 1, now: () => NOW })
  const other = fakeStrava(2)
  other.all.forEach((a) => { a.id += 9000 })
  const r = await syncCache({ ...store, fetchPage: other.fetchPage, athleteId: 2, now: () => NOW })
  assert.equal(r.count, 2)
  assert.equal(store.get().athleteId, 2)
})

test('garbage on disk is treated as an empty cache', async () => {
  const strava = fakeStrava(3)
  const store = memoryStore({ version: 99, activities: 'nope' })
  const r = await syncCache({ ...store, fetchPage: strava.fetchPage, now: () => NOW })
  assert.equal(r.mode, 'full')
  assert.equal(r.count, 3)
})

test('cachedActivities is newest first, and age is in minutes', () => {
  const cache = { ...emptyCache(), updatedAt: new Date(NOW - 30 * 60_000).toISOString(), activities: {
    a: { id: 'a', start_date: '2026-09-01T00:00:00Z' },
    b: { id: 'b', start_date: '2026-09-03T00:00:00Z' },
  } }
  assert.deepEqual(cachedActivities(cache).map((a) => a.id), ['b', 'a'])
  assert.equal(cacheAgeMinutes(cache, NOW), 30)
  assert.equal(cacheAgeMinutes(emptyCache(), NOW), null)
})
