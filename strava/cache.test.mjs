import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cachedActivities } from './cache.mjs'

test('cachedActivities is newest first', () => {
  const cache = { version: 1, activities: {
    a: { id: 'a', start_date: '2026-09-01T00:00:00Z' },
    b: { id: 'b', start_date: '2026-09-03T00:00:00Z' },
  } }
  assert.deepEqual(cachedActivities(cache).map((a) => a.id), ['b', 'a'])
})

test('a cache of another version, or garbage, is no activities', () => {
  assert.deepEqual(cachedActivities({ version: 99, activities: { a: { id: 'a' } } }), [])
  assert.deepEqual(cachedActivities({ version: 1, activities: 'nope' }), [])
  assert.deepEqual(cachedActivities(null), [])
})
