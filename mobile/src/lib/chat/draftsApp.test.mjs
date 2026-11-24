// The app's storage for the saved drafts (draftsApp.ts): one record per bridge,
// saving as the app leaves the screen, the one-time move of the app's old
// text-only drafts, a record that would not read kept aside, holds sent again when
// the app is back in front, and a queued message's edit keeping its file references.
// What the web shares (draftsShared.ts) is tested on the web, draftsShared.test.ts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAppDrafts, draftsKeyFor, renewWhenActive } from './draftsApp.ts'
import { createUploadHolds, keepEdit } from './draftsShared.ts'
import { startQueueEdit } from './queueEdit.ts'
import { LEGACY_DRAFTS_KEY } from './drafts.ts'

const BRIDGE = 'http://100.64.0.1:8787'
const KEY = draftsKeyFor(BRIDGE)

function memoryStorage(seed = {}) {
  const items = new Map(Object.entries(seed))
  return {
    items,
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => { items.set(k, v) },
    removeItem: (k) => { items.delete(k) },
  }
}

function fakeAppState() {
  const fns = new Set()
  return {
    addEventListener: (_type, fn) => { fns.add(fn); return { remove: () => fns.delete(fn) } },
    go: (state) => fns.forEach((fn) => fn(state)),
  }
}

function app({ storage = memoryStorage(), appState = fakeAppState(), onSaveError, bridge = BRIDGE } = {}) {
  let clock = 1000
  let n = 0
  const connection = { base: bridge, subs: new Set() }
  const store = createAppDrafts({
    storage, appState, now: () => ++clock, mint: () => `id${++n}`, onSaveError, delayMs: 300,
    bridge: () => connection.base,
    onBridgeChange: (fn) => { connection.subs.add(fn) },
  })
  const connect = (base) => { connection.base = base; connection.subs.forEach((fn) => fn()) }
  return { store, storage, appState, connect }
}

const file = (id, name = `${id}.png`) => ({ id, name, mime: 'image/png', size: 10, kind: 'image' })
const home = { place: { kind: 'home' } }
const saved = (storage, key = KEY) => JSON.parse(storage.getItem(key))

test('a draft is saved a beat after it changes', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { store, storage } = app()
  store.write('chat-1', { text: 'half a thought' }, home)
  assert.equal(storage.getItem(KEY), null)
  t.mock.timers.tick(300)
  assert.equal(saved(storage).drafts['chat-1'].text, 'half a thought')
})

test('leaving the foreground saves what is still waiting, at once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { store, storage, appState } = app()
  store.write('chat-1', { text: 'typed then switched away' }, home)
  appState.go('active')
  assert.equal(storage.getItem(KEY), null, 'coming back is no reason to save')
  appState.go('inactive')
  assert.equal(saved(storage).drafts['chat-1'].text, 'typed then switched away')
  store.write('chat-1', { text: 'and more' }, home)
  appState.go('background')
  assert.equal(saved(storage).drafts['chat-1'].text, 'and more')
})

test('drafts in two chats and two new chats, with files, survive the app being killed', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { store, storage, appState } = app()
  store.write('chat-a', { text: 'reply to A', attachments: [file('up1')] }, home)
  store.write('chat-b', { text: 'reply to B' }, { place: { kind: 'project', id: 'p1' } })
  const first = store.keyAt({ kind: 'home' })
  store.write(first, { text: 'first new chat' }, home)
  const second = store.fresh({ kind: 'home' })
  assert.notEqual(second, first)
  store.write(second, { attachments: [file('up2')] }, home)
  appState.go('background')
  const again = app({ storage }).store.get()
  assert.deepEqual(Object.keys(again.drafts).sort(), ['chat-a', 'chat-b', first, second].sort())
  assert.deepEqual(again.drafts['chat-a'].attachments.map((a) => a.id), ['up1'])
  assert.equal(again.drafts[second].attachments[0].id, 'up2')
  assert.equal(again.current.home, second, 'the composer reopens on the draft it showed')
})

test('each bridge keeps its own drafts; none, and nothing saved, before one is connected', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { store, storage, appState, connect } = app({ bridge: '' })
  store.write('chat-x', { text: 'before connecting' }, home)
  appState.go('background')
  assert.deepEqual([...storage.items.keys()], [])
  connect(BRIDGE)
  assert.equal(store.get().drafts['chat-x'], undefined)
  store.write('chat-1', { text: 'on the home bridge' }, home)
  let heard = 0
  store.subscribe(() => { heard++ })
  connect('http://100.64.0.2:8787')
  assert.equal(heard, 1, 'the drawer redraws for the other bridge')
  assert.equal(saved(storage).drafts['chat-1'].text, 'on the home bridge', 'the first bridge’s drafts are saved as it leaves')
  assert.deepEqual(store.get().drafts, {})
  store.write('chat-2', { text: 'on the other bridge' }, home)
  connect(BRIDGE)
  assert.deepEqual(Object.keys(store.get().drafts), ['chat-1'])
  assert.deepEqual(Object.keys(saved(storage, draftsKeyFor('http://100.64.0.2:8787')).drafts), ['chat-2'])
})

test('a save that fails keeps the drafts in memory and says so once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const storage = memoryStorage()
  storage.setItem = () => { throw new Error('disk full') }
  const errors = []
  const { store, appState } = app({ storage, onSaveError: (e) => errors.push(e.message) })
  store.write('chat-1', { text: 'still here' }, home)
  appState.go('background')
  store.write('chat-1', { text: 'still here, more' }, home)
  appState.go('background')
  assert.deepEqual(errors, ['disk full'])
  assert.equal(store.get().drafts['chat-1'].text, 'still here, more')
})

test('a record that would not read is kept aside before it is first written over', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const storage = memoryStorage({ [KEY]: '{"v":2,"drafts":{"chat-1":' })
  const { store, appState } = app({ storage })
  store.write('chat-2', { text: 'new' }, home)
  appState.go('background')
  assert.equal(storage.getItem(`${KEY}.bak`), '{"v":2,"drafts":{"chat-1":')
  assert.equal(saved(storage).drafts['chat-2'].text, 'new')
})

test('a record that could not be read at all is read again, and kept aside, before the first save', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const storage = memoryStorage({ [KEY]: '{"v":2,"drafts":{},"current":{}}' })
  const getItem = storage.getItem
  let locked = true
  storage.getItem = (k) => { if (locked && k === KEY) throw new Error('locked'); return getItem(k) }
  const { store, appState } = app({ storage })
  locked = false
  store.write('chat-2', { text: 'new' }, home)
  appState.go('background')
  assert.equal(storage.getItem(`${KEY}.bak`), '{"v":2,"drafts":{},"current":{}}')
})

test('the app’s old text-only drafts move over once, and the old key goes', () => {
  const storage = memoryStorage({
    [LEGACY_DRAFTS_KEY]: JSON.stringify({ 'chat-1': 'old reply', 'new:regular': 'old new chat', 'new:project:p1': 'for the project', 'new:temporary': '  ' }),
  })
  const { store } = app({ storage })
  const s = store.get()
  assert.equal(storage.getItem(LEGACY_DRAFTS_KEY), null)
  assert.equal(s.drafts['chat-1'].text, 'old reply')
  assert.deepEqual(s.drafts['new:regular'].place, { kind: 'home' })
  assert.deepEqual(s.drafts['new:project:p1'].place, { kind: 'project', id: 'p1' })
  assert.equal(s.drafts['new:temporary'], undefined, 'blank words are no draft')
  assert.equal(store.keyAt({ kind: 'home' }), 'new:regular', 'Home’s composer still shows its old draft')
  assert.deepEqual(saved(storage), JSON.parse(JSON.stringify({ v: 2, drafts: s.drafts, current: s.current })), 'written straight away')
  assert.deepEqual(app({ storage }).store.get().drafts, s.drafts, 'the next start reads the new record alone')
})

test('the old drafts wait for a bridge, and never overwrite a draft already in its record', () => {
  const storage = memoryStorage({ [LEGACY_DRAFTS_KEY]: JSON.stringify({ 'chat-1': 'stale words', 'chat-2': 'only here' }) })
  storage.setItem(KEY, JSON.stringify({ v: 2, drafts: { 'chat-1': { text: 'newer', attachments: [], createdAt: 1, updatedAt: 2, place: { kind: 'home' } } }, current: {} }))
  const { store, connect } = app({ storage, bridge: '' })
  assert.notEqual(storage.getItem(LEGACY_DRAFTS_KEY), null)
  connect(BRIDGE)
  assert.equal(store.get().drafts['chat-1'].text, 'newer')
  assert.equal(store.get().drafts['chat-2'].text, 'only here')
  assert.equal(storage.getItem(LEGACY_DRAFTS_KEY), null)
})

test('held uploads that failed to reach the bridge go again when the app is back in front', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { store, appState } = app()
  store.write('chat-1', { attachments: [file('a')] }, home)
  let down = true
  const calls = []
  const holds = createUploadHolds(store, { hold: async (ids) => { calls.push(ids); if (down) throw new Error('restarting'); return { held: ids, missing: [] } } })
  holds.start()
  renewWhenActive(appState, holds)
  t.mock.timers.tick(0)
  await Promise.resolve()
  assert.equal(calls.length, 1)
  down = false
  appState.go('background')
  appState.go('active')
  t.mock.timers.tick(0)
  await Promise.resolve()
  assert.equal(calls.length, 2)
  appState.go('active')
  t.mock.timers.tick(0)
  assert.equal(calls.length, 2, 'a set that reached the bridge is not sent again')
})

test('a queued message’s edit keeps its file references, saved or kept as the draft', () => {
  const ref = '[notes.pdf](totem-ref://upload/abcdefgh12)'
  const edit = startQueueEdit({ id: 'q1', text: `read ${ref} first`, attachments: [file('f')] }, 'c1')
  assert.equal(edit.text, 'read [notes.pdf] first', 'the plain box shows the file by name')
  assert.equal(edit.restore('read [notes.pdf] first, then reply'), `read ${ref} first, then reply`)
  const { store } = app()
  keepEdit(store, 'c1', edit.restore(edit.text), edit.files, home)
  assert.equal(store.get().drafts.c1.text, `read ${ref} first`)
})
