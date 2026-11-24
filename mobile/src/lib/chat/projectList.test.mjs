// The drawer's projects and folders over the app's real GET cache (#297): drawn
// from the stored list on a cold start, then refreshed without ever rolling back.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHttpCache } from '../httpCache.ts'
import { PROJECTS_GET, PROJECTS_PATH, projectList } from './projectList.ts'

function memoryStorage() {
  const items = new Map()
  return {
    getItemSync: (k) => items.get(k) ?? null,
    setItemAsync: async (k, v) => { items.set(k, v) },
    removeItemAsync: async (k) => items.delete(k),
    clearAsync: async () => { items.clear() },
  }
}
const settle = () => new Promise((r) => setTimeout(r, 0))

// The bridge's /api/chat/projects, tagged as http/etag.mjs tags it.
function bridge(projects) {
  const b = { projects, version: 1, down: false, delayMs: 0, page: false }
  b.send = async (headers) => {
    // The list as it was when asked, however long the answer takes.
    const listed = b.projects, version = b.version
    if (b.delayMs) await new Promise((r) => setTimeout(r, b.delayMs))
    if (b.down) throw new TypeError('Network request failed')
    // A captive Wi-Fi or sign-in page, answered 200.
    if (b.page) return new Response('<html>Sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } })
    const etag = `W/"v${version}"`
    if (headers['if-none-match'] === etag) return new Response(null, { status: 304, headers: { etag } })
    return new Response(JSON.stringify({ projects: listed }), { status: 200, headers: { 'content-type': 'application/json', etag } })
  }
  return b
}
const parse = async (r) => {
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return body
}

// The app as chat/api.ts and the store wire it, over one cache and one store.
function app(storage, b, { timeoutMs = 8_000 } = {}) {
  const cache = createHttpCache(storage, { timeoutMs })
  cache.setAccount('http://100.64.0.1:8787#a1b2c3')
  const errors = []
  let state = { projects: [], projectId: null }
  const sync = projectList({
    peek: () => cache.peek(PROJECTS_PATH),
    list: () => cache.get(PROJECTS_PATH, b.send, parse, PROJECTS_GET),
    get: () => state,
    set: (patch) => { state = { ...state, ...patch } },
    fail: (e) => errors.push(e),
  })
  return { sync, errors, state: () => state, edit: (fn) => { state = { ...state, ...fn(state) } } }
}

const WORK = { id: 'work', name: 'Work', icon: 'briefcase' }
const LAUNCH = { id: 'launch', name: 'Launch', parentId: 'work' }
const HOME = { id: 'home', name: 'House' }

test('a cold start draws the folders the bridge gave last time, before any answer', async () => {
  const storage = memoryStorage()
  const b = bridge([WORK, LAUNCH])
  await app(storage, b).sync.load()
  await settle()

  // Relaunched with the bridge out of reach.
  b.down = true
  const next = app(storage, b)
  next.sync.seed()
  assert.deepEqual(next.state().projects, [WORK, LAUNCH])
})

test('nothing stored yet seeds nothing', () => {
  const next = app(memoryStorage(), bridge([WORK]))
  next.sync.seed()
  assert.deepEqual(next.state().projects, [])
})

test('the refresh replaces the stored list, and a page whose project went closes', async () => {
  const storage = memoryStorage()
  const b = bridge([WORK, LAUNCH])
  await app(storage, b).sync.load()
  await settle()

  const next = app(storage, b)
  next.sync.seed()
  next.edit((s) => ({ ...s, projectId: 'launch' }))
  b.projects = [{ ...WORK, name: 'Day job' }, HOME]
  b.version = 2
  await next.sync.load()
  assert.deepEqual(next.state(), { projects: [{ ...WORK, name: 'Day job' }, HOME], projectId: null })

  // Unchanged since: the bridge answers 304 and the list stays.
  await next.sync.load()
  assert.deepEqual(next.state().projects, [{ ...WORK, name: 'Day job' }, HOME])
  assert.deepEqual(next.errors, [])
})

test('a failed refresh keeps the folders, and the page that is open', async () => {
  const storage = memoryStorage()
  const b = bridge([WORK, LAUNCH])
  await app(storage, b).sync.load()
  await settle()

  b.down = true
  const next = app(storage, b)
  next.sync.seed()
  next.edit((s) => ({ ...s, projectId: 'launch' }))
  await next.sync.load()
  assert.deepEqual(next.state(), { projects: [WORK, LAUNCH], projectId: 'launch' })
  assert.match(next.errors[0].message, /Network request failed/)
})

test('a down or slow bridge never answers with the stored list, which a project made here since is missing from', async () => {
  const storage = memoryStorage()
  const b = bridge([WORK])
  await app(storage, b).sync.load()
  await settle()

  // A short cache deadline, so a stored-copy answer would come back before the bridge's.
  const next = app(storage, b, { timeoutMs: 10 })
  next.sync.seed()
  next.edit((s) => ({ ...s, projects: [...s.projects, HOME] }))

  b.down = true
  await next.sync.load()
  assert.deepEqual(next.state().projects, [WORK, HOME])

  // Slower than the cache's deadline: the bridge's own answer is waited for.
  b.down = false
  b.delayMs = 40
  b.projects = [WORK, HOME]
  b.version = 2
  await next.sync.load()
  assert.deepEqual(next.state().projects, [WORK, HOME])
  assert.equal(next.errors.length, 1)
})

test('a page that is not the list, answered 200, keeps the folders', async () => {
  const b = bridge([WORK, LAUNCH])
  const a = app(memoryStorage(), b)
  await a.sync.load()
  b.page = true
  await a.sync.load()
  assert.deepEqual(a.state().projects, [WORK, LAUNCH])
  assert.match(a.errors[0].message, /did not answer with the projects list/)
})

test('a poll still out when the phone makes a project is dropped, and the next one is taken', async () => {
  const b = bridge([WORK])
  const a = app(memoryStorage(), b)
  await a.sync.load()

  b.delayMs = 30
  const poll = a.sync.load()
  // createProject: the bridge has it, the store takes its answer and opens its page.
  b.projects = [WORK, HOME]
  b.version = 2
  a.sync.changed()
  a.edit((s) => ({ projects: [...s.projects, HOME], projectId: HOME.id }))
  await poll
  assert.deepEqual(a.state(), { projects: [WORK, HOME], projectId: HOME.id })

  // A list asked for after the change is the word, a rename on another device included.
  b.projects = [WORK, { ...HOME, name: 'Home' }]
  b.version = 3
  await a.sync.load()
  assert.deepEqual(a.state(), { projects: [WORK, { ...HOME, name: 'Home' }], projectId: HOME.id })
  assert.deepEqual(a.errors, [])
})
