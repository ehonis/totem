// The iPhone app's GET cache (#159), run by the bridge's `npm test`: node strips
// the module's types, and nothing in it needs React Native.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHttpCache } from './httpCache.ts'

// A stand-in for the SQLite file: a Map, with the same sync read and async
// writes. `hold()` makes the next setItemAsync wait: `started` settles when it
// begins, `release()` lets it finish.
function memoryStorage() {
  const items = new Map()
  let held = null
  const storage = {
    items,
    hold() {
      let release, begin
      const gate = new Promise((r) => { release = r })
      const started = new Promise((r) => { begin = r })
      held = { gate, begin }
      return { started, release }
    },
    getItemSync: (k) => items.get(k) ?? null,
    setItemAsync: async (k, v) => {
      const mine = held
      if (mine) { held = null; mine.begin(); await mine.gate }
      items.set(k, v)
    },
    removeItemAsync: async (k) => items.delete(k),
    clearAsync: async () => { items.clear() },
  }
  return storage
}
const bodies = (storage) => [...storage.items.keys()].filter((k) => k !== '#index')
const settle = () => new Promise((r) => setTimeout(r, 0))

const JSON_TYPE = { 'content-type': 'application/json' }
// A bridge that tags its answer like http/etag.mjs and answers 304 to a match.
function bridge(initial) {
  const state = { body: initial, etag: 'W/"v1"', tagged: true, down: false, status: 200, seen: [] }
  state.send = async (headers) => {
    state.seen.push(headers['if-none-match'] ?? null)
    if (state.down) throw new TypeError('Network request failed')
    if (state.status !== 200) return new Response('{}', { status: state.status, headers: JSON_TYPE })
    if (state.tagged && headers['if-none-match'] === state.etag) return new Response(null, { status: 304, headers: { etag: state.etag } })
    return new Response(JSON.stringify(state.body), { status: 200, headers: state.tagged ? { ...JSON_TYPE, etag: state.etag } : JSON_TYPE })
  }
  return state
}
// readResponse in api.ts: a body that is not JSON parses to {}.
const parse = async (r) => {
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return body
}
const ACCOUNT = 'http://100.64.0.1:8787#a1b2c3'
const OTHER = 'http://other:8787#ffffff'
const cacheFor = (storage = memoryStorage(), options = {}) => {
  const cache = createHttpCache(storage, options)
  cache.setAccount(ACCOUNT)
  return cache
}

test('a tagged answer is read through to disk, and a new cache peeks it before asking', async () => {
  const storage = memoryStorage()
  const b = bridge({ todos: ['milk'] })
  const cache = cacheFor(storage)
  assert.equal(cache.peek('/api/todos'), undefined)
  assert.deepEqual(await cache.get('/api/todos', b.send, parse), { todos: ['milk'] })
  assert.deepEqual(b.seen, [null])
  await settle()

  // The app relaunched: a fresh cache over the same file draws at once.
  const relaunched = cacheFor(storage)
  assert.deepEqual(relaunched.peek('/api/todos'), { todos: ['milk'] })
})

test('revalidation: If-None-Match goes out, a 304 answers the stored body, a change replaces it', async () => {
  const b = bridge({ todos: ['milk'] })
  const cache = cacheFor()
  await cache.get('/api/todos', b.send, parse)

  assert.deepEqual(await cache.get('/api/todos', b.send, parse), { todos: ['milk'] })
  assert.deepEqual(b.seen, [null, 'W/"v1"'])

  b.body = { todos: ['milk', 'bread'] }
  b.etag = 'W/"v2"'
  assert.deepEqual(await cache.get('/api/todos', b.send, parse), { todos: ['milk', 'bread'] })
  assert.deepEqual(cache.peek('/api/todos'), { todos: ['milk', 'bread'] })
  await cache.get('/api/todos', b.send, parse)
  assert.equal(b.seen.at(-1), 'W/"v2"')
})

test('a 304 moves savedAt in memory and rewrites the disk copy only every so often', async () => {
  let clock = 1000
  const storage = memoryStorage()
  const b = bridge({ todos: ['milk'] })
  const cache = cacheFor(storage, { now: () => clock, persistEveryMs: 600_000 })
  await cache.get('/api/todos', b.send, parse)
  await settle()
  let writes = 0
  const set = storage.setItemAsync
  storage.setItemAsync = async (k, v) => { if (k !== '#index') writes++; return set(k, v) }

  clock = 31_000
  await cache.get('/api/todos', b.send, parse)
  await settle()
  assert.equal(writes, 0)
  b.down = true
  await cache.get('/api/todos', b.send, parse)
  assert.equal(cache.getStatus().updatedAt, 31_000)

  b.down = false
  clock = 700_000
  await cache.get('/api/todos', b.send, parse)
  await settle()
  assert.equal(writes, 1)
  assert.equal(JSON.parse(storage.items.get(`${ACCOUNT}|/api/todos`)).savedAt, 700_000)
})

test('offline: the stored body answers, the status says so and dates it, and the next answer clears it', async () => {
  let clock = 5000
  const b = bridge({ habits: [1] })
  const cache = cacheFor(undefined, { now: () => clock })
  const seen = []
  cache.subscribe(() => seen.push(cache.getStatus()))
  await cache.get('/api/habits?days=40', b.send, parse)

  clock = 9000
  b.down = true
  assert.deepEqual(await cache.get('/api/habits?days=40', b.send, parse), { habits: [1] })
  assert.deepEqual(cache.getStatus(), { offline: true, updatedAt: 5000 })

  // A proxy in front of a stopped bridge counts as out of reach too.
  b.down = false
  b.status = 502
  assert.deepEqual(await cache.get('/api/habits?days=40', b.send, parse), { habits: [1] })
  assert.equal(cache.getStatus().offline, true)

  b.status = 200
  await cache.get('/api/habits?days=40', b.send, parse)
  assert.deepEqual(cache.getStatus(), { offline: false, updatedAt: null })
  assert.deepEqual(seen, [{ offline: true, updatedAt: 5000 }, { offline: false, updatedAt: null }])
})

test('the offline label stays on while a stored answer is on show, whatever fails beside it', async () => {
  const cached = bridge({ todos: [1] })
  const cache = cacheFor()
  await cache.get('/api/todos', cached.send, parse)

  // Concurrent: the cached GET gets a 502, an uncached one a 502 and another a 500.
  cached.status = 502
  const uncached = bridge({})
  uncached.status = 502
  const failing = bridge({})
  failing.status = 500
  const results = await Promise.allSettled([
    cache.get('/api/todos', cached.send, parse),
    cache.get('/api/lists', uncached.send, parse),
    cache.get('/api/goals', failing.send, parse),
  ])
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'rejected'])
  assert.equal(cache.getStatus().offline, true)

  // An answer that was already out when the 502 came does not clear it either.
  let release
  const slow = bridge({ calendar: [] })
  const pending = cache.get('/api/calendar', (h) => new Promise((r) => { release = () => r(slow.send(h)) }), parse)
  await cache.get('/api/todos', cached.send, parse)
  release()
  await pending
  assert.equal(cache.getStatus().offline, true)

  // One begun after it, a GET or a write, proves the bridge is back.
  const mark = cache.begin()
  cache.reached(mark, new Response('{}', { status: 200, headers: JSON_TYPE }))
  assert.equal(cache.getStatus().offline, false)
})

test('one failure after another, each finished before the next, leaves Offline on', async () => {
  const cached = bridge({ todos: [1] })
  const cache = cacheFor()
  await cache.get('/api/todos', cached.send, parse)
  cached.status = 502
  await cache.get('/api/todos', cached.send, parse)
  assert.equal(cache.getStatus().offline, true)

  for (const [path, status] of [['/api/lists', 502], ['/api/goals', 500], ['/api/calendar', 401]]) {
    const b = bridge({})
    b.status = status
    await assert.rejects(cache.get(path, b.send, parse))
    assert.equal(cache.getStatus().offline, true, `after an uncached ${status}`)
  }
})

test('a write answered by a captive or Access page does not clear Offline; the bridge\'s own answer does', async () => {
  const b = bridge({ habits: [1] })
  const cache = cacheFor(undefined, { blocked: (r) => r.headers.get('www-authenticate') === 'Cloudflare-Access' })
  await cache.get('/api/habits', b.send, parse)
  b.down = true
  await cache.get('/api/habits', b.send, parse)
  assert.equal(cache.getStatus().offline, true)

  const answers = [
    new Response('<html>Wi-Fi login</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    new Response('{}', { status: 200, headers: { ...JSON_TYPE, 'www-authenticate': 'Cloudflare-Access' } }),
    new Response('{}', { status: 500, headers: JSON_TYPE }),
  ]
  for (const response of answers) {
    cache.reached(cache.begin(), response)
    assert.equal(cache.getStatus().offline, true, response.headers.get('content-type'))
  }
  cache.reached(cache.begin(), new Response('{"ok":true}', { status: 200, headers: JSON_TYPE }))
  assert.equal(cache.getStatus().offline, false)
})

test('a 304 that lands after a newer answer does not roll the cache back', async () => {
  let clock = 1000
  const storage = memoryStorage()
  const b = bridge({ todos: ['v1'] })
  const cache = cacheFor(storage, { now: () => clock, persistEveryMs: 0 })
  await cache.get('/api/todos', b.send, parse)

  // A revalidation of v1 goes out and is slow; meanwhile v2 arrives.
  let release
  const slow = cache.get('/api/todos', (h) => new Promise((r) => { release = () => r(b.send(h)) }), parse)
  b.body = { todos: ['v2'] }
  b.etag = 'W/"v2"'
  await cache.get('/api/todos', async () => new Response(JSON.stringify(b.body), { status: 200, headers: { ...JSON_TYPE, etag: b.etag } }), parse)
  // The slow one now gets a 304 for v1.
  b.etag = 'W/"v1"'
  clock = 9000
  release()
  assert.deepEqual(await slow, { todos: ['v2'] })
  await settle()
  b.etag = 'W/"v2"'
  assert.deepEqual(cache.peek('/api/todos'), { todos: ['v2'] })
  assert.equal(JSON.parse(storage.items.get(`${ACCOUNT}|/api/todos`)).etag, 'W/"v2"')
  await cache.get('/api/todos', b.send, parse)
  assert.equal(b.seen.at(-1), 'W/"v2"')
})

test('a sign-in or captive page answering 200 keeps the stored copy and shows offline', async () => {
  const storage = memoryStorage()
  const b = bridge({ todos: [1, 2, 3] })
  const cache = cacheFor(storage, { blocked: (r) => r.headers.get('www-authenticate') === 'Cloudflare-Access' })
  await cache.get('/api/todos', b.send, parse)
  await settle()

  const captive = async () => new Response('<html>Sign in to the Wi-Fi</html>', { status: 200, headers: { 'content-type': 'text/html' } })
  assert.deepEqual(await cache.get('/api/todos', captive, parse), { todos: [1, 2, 3] })
  assert.equal(cache.getStatus().offline, true)

  const access = async () => new Response('{}', { status: 401, headers: { ...JSON_TYPE, 'www-authenticate': 'Cloudflare-Access' } })
  assert.deepEqual(await cache.get('/api/todos', access, parse), { todos: [1, 2, 3] })
  await settle()
  assert.deepEqual(cache.peek('/api/todos'), { todos: [1, 2, 3] })
  assert.equal(bodies(storage).length, 1)
})

test('a cached GET that hangs is answered from the cache after the timeout', async () => {
  const b = bridge({ todos: [1] })
  const cache = cacheFor(undefined, { timeoutMs: 20 })
  await cache.get('/api/todos', b.send, parse)
  let aborted = false
  const hang = (_headers, signal) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')) })
  })
  assert.deepEqual(await cache.get('/api/todos', hang, parse), { todos: [1] })
  assert.ok(aborted)
  assert.equal(cache.getStatus().offline, true)
})

test('every caller gets its own copy of the body', async () => {
  const b = bridge({ todos: [3, 1, 2] })
  const cache = cacheFor()
  const first = await cache.get('/api/todos', b.send, parse)
  first.todos.sort()
  const peeked = cache.peek('/api/todos')
  peeked.todos.push(9)
  const revalidated = await cache.get('/api/todos', b.send, parse) // a 304
  assert.deepEqual(revalidated, { todos: [3, 1, 2] })
  revalidated.todos.reverse()
  assert.deepEqual(await cache.get('/api/todos', b.send, parse), { todos: [3, 1, 2] })
  assert.deepEqual(cache.peek('/api/todos'), { todos: [3, 1, 2] })
})

test('offline with nothing stored, and errors from the bridge, still throw', async () => {
  const b = bridge({})
  const cache = cacheFor()
  b.down = true
  await assert.rejects(cache.get('/api/lists', b.send, parse), /Network request failed/)
  b.down = false
  await cache.get('/api/lists', b.send, parse)
  b.status = 401
  await assert.rejects(cache.get('/api/lists', b.send, parse), /HTTP 401/)
})

test('an untagged answer is never kept, and a route that stops tagging is dropped', async () => {
  const storage = memoryStorage()
  const b = bridge({ usage: 1 })
  const cache = cacheFor(storage)
  await cache.get('/api/todos', b.send, parse)
  await settle()
  assert.equal(bodies(storage).length, 1)

  b.tagged = false
  await cache.get('/api/todos', b.send, parse)
  await cache.get('/api/usage', b.send, parse)
  await settle()
  assert.equal(cache.peek('/api/todos'), undefined)
  assert.equal(cache.peek('/api/usage'), undefined)
  assert.equal(bodies(storage).length, 0)
})

test('the oldest-used entries are evicted past the cap, from memory and disk', async () => {
  const storage = memoryStorage()
  const b = bridge({ x: 1 })
  const cache = cacheFor(storage, { maxEntries: 3 })
  for (const p of ['/a', '/b', '/c']) await cache.get(p, b.send, parse)
  cache.peek('/a') // used again: /b is now the oldest
  await cache.get('/d', b.send, parse)
  await settle()
  assert.equal(cache.peek('/b'), undefined)
  assert.deepEqual(bodies(storage).sort(), [`${ACCOUNT}|/a`, `${ACCOUNT}|/c`, `${ACCOUNT}|/d`])

  // The order survives a relaunch: /c is the oldest-used now, not /a.
  const relaunched = cacheFor(storage, { maxEntries: 3 })
  await relaunched.get('/e', b.send, parse)
  await settle()
  assert.equal(relaunched.peek('/c'), undefined)
  assert.deepEqual(bodies(storage).sort(), [`${ACCOUNT}|/a`, `${ACCOUNT}|/d`, `${ACCOUNT}|/e`])
})

test('sign-out clears memory and disk; signed out, nothing is read or kept', async () => {
  const storage = memoryStorage()
  const b = bridge({ todos: ['milk'] })
  const cache = cacheFor(storage)
  await cache.get('/api/todos', b.send, parse)

  await cache.clear()
  cache.setAccount('')
  assert.equal(storage.items.size, 0)
  assert.equal(cache.peek('/api/todos'), undefined)
  await cache.get('/api/todos', b.send, parse)
  await settle()
  assert.equal(storage.items.size, 0)
  assert.equal(b.seen.at(-1), null)
})

test('a disk write still under way at sign-out does not outlive the clear', async () => {
  const storage = memoryStorage()
  const b = bridge({ todos: ['milk'] })
  const cache = cacheFor(storage)
  const slow = storage.hold()
  await cache.get('/api/todos', b.send, parse)
  await slow.started // the body's write is under way
  const cleared = cache.clear()
  cache.setAccount('')
  slow.release() // and lands after the sign-out
  await cleared
  await settle()
  assert.equal(storage.items.size, 0)
})

test('an answer for the old account never reaches the screen after a switch', async () => {
  const storage = memoryStorage()
  const b = bridge({ todos: ['A'] })
  const cache = cacheFor(storage)
  await cache.get('/api/todos', b.send, parse)

  const late = (respond) => {
    let release
    const send = (h) => new Promise((resolve, reject) => { release = () => respond(h).then(resolve, reject) })
    return { send, release: () => release() }
  }
  // A fresh answer, a 304 and an offline fallback, each landing after the switch.
  for (const respond of [
    async () => new Response(JSON.stringify({ todos: ['A2'] }), { status: 200, headers: { ...JSON_TYPE, etag: 'W/"a2"' } }),
    b.send,
    async () => { throw new TypeError('Network request failed') },
  ]) {
    cache.setAccount(ACCOUNT)
    const slow = late(respond)
    const pending = cache.get('/api/todos', slow.send, parse)
    await cache.clear()
    cache.setAccount(OTHER)
    slow.release()
    await assert.rejects(pending, (e) => e.name === 'AbortError')
    await settle()
    assert.equal(cache.peek('/api/todos'), undefined)
    assert.ok(!bodies(storage).some((k) => k.startsWith(ACCOUNT)))
  }
})
