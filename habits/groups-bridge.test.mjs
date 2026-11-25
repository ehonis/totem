// Run with: node --test habits/groups-bridge.test.mjs
//
// Sub-habits against a real bridge.mjs: a habit may sit under one other habit
// (`parentId`), one level deep; a habit with sub-habits is a group with no entry of
// its own, and logging it marks (or clears, or sets) its hand-logged sub-habits.
// The bridge runs from a shadow checkout with its own data/, on its own port, with
// no scheduler, and is stopped at the end.

import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { connect, createServer } from 'node:net'
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const SECRET = 'habit-groups-test-secret'

const freePort = () => new Promise((resolve) => {
  const server = createServer()
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) })
})
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const canConnect = (port) => new Promise((resolve) => {
  const socket = connect(port, '127.0.0.1')
  socket.once('connect', () => { socket.destroy(); resolve(true) })
  socket.once('error', () => resolve(false))
})

const B = {}
async function call(method, path, body) {
  const res = await fetch(`${B.base}${path}`, {
    method,
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}
const habit = (payload, id) => payload.habits.find((h) => h.id === id)
const onDisk = () => JSON.parse(readFileSync(B.file, 'utf8'))

before(async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'totem-habit-groups-')))
  for (const entry of readdirSync(REPO)) {
    if (entry === 'data' || entry === '.env' || entry === '.git' || entry === 'AGENTS.local.md') continue
    symlinkSync(join(REPO, entry), join(root, entry))
  }
  B.root = root
  mkdirSync(join(root, 'data'), { recursive: true })
  mkdirSync(join(root, 'home'))
  writeFileSync(join(root, 'data', 'auth.json'), '{}')
  B.file = join(root, 'data', 'habits.json')
  // Hand-written the way an agent might: a nested parent, a self-parent, a missing
  // one, and a group under an app-filled habit, which the bridge must all drop.
  writeFileSync(B.file, JSON.stringify({
    habits: [
      { id: 'food', name: 'Food', linkedApp: 'krakatoa' },
      { id: 'eat-greens', name: 'Eat greens', parentId: 'food' },
      { id: 'a', name: 'A', parentId: 'b' },
      { id: 'b', name: 'B', parentId: 'c' },
      { id: 'c', name: 'C' },
      { id: 'self', name: 'Self', parentId: 'self' },
      { id: 'lost', name: 'Lost', parentId: 'nowhere' },
      // Hand-written, not a slug: it has always read as "read-books", where its history is.
      { id: 'read--books', name: 'Read books' },
      // Two hand-written spellings of one slug: the first in the file has always had it.
      { id: 'read--fiction', name: 'Read fiction' },
      { id: 'read-fiction', name: 'Read more fiction' },
      // Hand-written past 40 characters, not a bridge "<slug>-N": read as its slug.
      { id: `${'a'.repeat(40)}-reading`, name: 'Long one' },
      // Hand-written with a number on the end: only an id the bridge saved (idFixed) is kept as written.
      { id: `${'r'.repeat(40)}-1`, name: 'Numbered one' },
    ],
    entries: { '2026-01-05': { 'read-books': { count: 1 }, 'read-fiction': { count: 1 }, [`${'a'.repeat(40)}`]: { count: 1 }, [`${'r'.repeat(40)}`]: { count: 1 } } },
  }))

  const port = await freePort()
  B.base = `http://127.0.0.1:${port}`
  let output = ''
  const child = spawn(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', join(root, 'bridge.mjs')], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: join(root, 'home'), BRIDGE_PORT: String(port), BRIDGE_SECRET: SECRET, BRIDGE_NO_SCHEDULER: '1', AGENT_CWD: root },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => { output += d })
  child.stderr.on('data', (d) => { output += d })
  B.stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve()
    child.once('exit', resolve)
    child.kill('SIGTERM')
    setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3000)
  })
  const deadline = Date.now() + 30_000
  while (!(await canConnect(port))) {
    if (child.exitCode !== null) throw new Error(`bridge exited early:\n${output}`)
    if (Date.now() > deadline) throw new Error(`bridge never listened:\n${output}`)
    await wait(20)
  }
})

after(async () => {
  await B.stop?.()
  if (B.root) rmSync(B.root, { recursive: true, force: true })
})

test('a hand-edited file keeps only valid one-level parents', async () => {
  const { json } = await call('GET', '/api/habits')
  assert.equal(habit(json, 'eat-greens').parentId, null, 'an app-filled habit cannot be a group')
  assert.equal(habit(json, 'a').parentId, null, 'a parent that has a parent is not a group')
  assert.equal(habit(json, 'b').parentId, 'c')
  assert.equal(habit(json, 'self').parentId, null)
  assert.equal(habit(json, 'lost').parentId, null)
})

test('a hand-written id that is not a slug still reads as its slug, history and all', async () => {
  const { json } = await call('GET', '/api/habits?days=1100')
  assert.ok(habit(json, 'read-books'))
  assert.equal(habit(json, 'read--books'), undefined)
  // Ids as the bridge has always read them, so each habit keeps its own entries.
  assert.equal(json.habits.find((h) => h.name === 'Read fiction').id, 'read-fiction')
  assert.equal(json.habits.find((h) => h.name === 'Read more fiction').id, 'read-fiction-2')
  assert.equal(json.habits.find((h) => h.name === 'Long one').id, 'a'.repeat(40))
  assert.equal(json.habits.find((h) => h.name === 'Numbered one').id, 'r'.repeat(40))
})

test('creating and moving sub-habits checks the parent', async () => {
  let r = await call('POST', '/api/habits', { name: 'Nightly routine' })
  assert.equal(r.status, 200)
  r = await call('POST', '/api/habits', { name: 'Sleep hygiene', parentId: 'nightly-routine' })
  assert.equal(r.status, 200)
  r = await call('POST', '/api/habits', { name: 'Water', target: 4 })
  r = await call('POST', '/api/habits', { name: 'Stretch', parentId: 'nightly-routine' })
  // A new sub-habit lands right after its group's last one, not at the end.
  const order = r.json.habits.map((h) => h.id)
  assert.deepEqual(order.slice(order.indexOf('nightly-routine'), order.indexOf('nightly-routine') + 4), ['nightly-routine', 'sleep-hygiene', 'stretch', 'water'])

  r = await call('PATCH', '/api/habits', { id: 'water', parentId: 'nightly-routine' })
  assert.equal(r.status, 200)
  assert.equal(habit(r.json, 'water').parentId, 'nightly-routine')

  assert.match((await call('PATCH', '/api/habits', { id: 'nightly-routine', parentId: 'c' })).json.error, /has sub-habits/)
  assert.match((await call('POST', '/api/habits', { name: 'Deep', parentId: 'sleep-hygiene' })).json.error, /one level deep/)
  assert.match((await call('POST', '/api/habits', { name: 'Fruit', parentId: 'food' })).json.error, /filled in by an app/)
  assert.match((await call('PATCH', '/api/habits', { id: 'stretch', parentId: 'stretch' })).json.error, /under itself/)
  assert.match((await call('PATCH', '/api/habits', { id: 'nightly-routine', linkedApp: 'bushido' })).json.error, /has sub-habits/)
})

test('logging a group marks, clears and sets its sub-habits; it never gets an entry of its own', async () => {
  const day = (await call('GET', '/api/habits')).json.today
  await call('POST', '/api/habits/log', { id: 'stretch', date: day, skipped: true })
  let r = await call('POST', '/api/habits/log', { id: 'nightly-routine', date: day, complete: true })
  assert.equal(r.status, 200)
  const e = r.json.entries[day]
  assert.equal(e['sleep-hygiene'].count, 1)
  assert.equal(e.stretch.count, 1)
  assert.equal(e.stretch.skipped, undefined, 'done clears the check-in no')
  assert.equal(e.water.count, 4, 'a daily sub-habit is filled to its target')
  assert.equal(e['nightly-routine'], undefined)
  assert.equal(onDisk().entries[day]['nightly-routine'], undefined)

  r = await call('POST', '/api/habits/log', { id: 'nightly-routine', date: day, counts: { water: 2, stretch: 0 } })
  assert.equal(r.json.entries[day].water.count, 2)
  assert.equal(r.json.entries[day].stretch, undefined)
  assert.equal(r.json.entries[day]['sleep-hygiene'].count, 1)

  r = await call('POST', '/api/habits/log', { id: 'nightly-routine', date: day, complete: false })
  assert.equal(r.json.entries[day], undefined)

  assert.match((await call('POST', '/api/habits/log', { id: 'nightly-routine', date: day, delta: 1 })).json.error, /is a group/)
  assert.match((await call('POST', '/api/habits/log', { id: 'nightly-routine', date: day, counts: { c: 1 } })).json.error, /not a hand-logged sub-habit/)
})

test('a group takes no count or note of its own, and its undo puts back a check-in "No"', async () => {
  const day = (await call('GET', '/api/habits')).json.today
  await call('POST', '/api/habits', { name: 'Morning' })
  await call('POST', '/api/habits', { name: 'Journal', parentId: 'morning' })
  await call('POST', '/api/habits', { name: 'Walk the dog', parentId: 'morning' })
  assert.match((await call('POST', '/api/habits/log', { id: 'morning', date: day, note: 'x' })).json.error, /takes no note/)
  assert.match((await call('POST', '/api/habits/log', { id: 'morning', date: day, complete: true, value: 80 })).json.error, /takes no value/)
  await call('POST', '/api/habits/log', { id: 'journal', date: day, skipped: true })
  await call('POST', '/api/habits/log', { id: 'morning', date: day, complete: true })
  const r = await call('POST', '/api/habits/log', { id: 'morning', date: day, counts: { journal: 0, 'walk-the-dog': 0 }, skips: ['journal'] })
  assert.deepEqual(r.json.entries[day].journal, { count: 0, skipped: true })
  assert.equal(r.json.entries[day]['walk-the-dog'], undefined)
})

test("a group's check leaves a met weekly quota alone and never writes an app-filled sub-habit", async () => {
  const day = (await call('GET', '/api/habits')).json.today
  await call('POST', '/api/habits', { name: 'Training' })
  await call('POST', '/api/habits', { name: 'Lift', cadence: 'weekly', target: 1, parentId: 'training' })
  await call('POST', '/api/habits', { name: 'Walk', parentId: 'training' })
  await call('POST', '/api/habits', { name: 'Protein', parentId: 'training', linkedApp: 'krakatoa' })
  await call('POST', '/api/habits/log', { id: 'lift', date: day, count: 1 })
  let r = await call('POST', '/api/habits/log', { id: 'training', date: day, complete: true })
  assert.equal(r.json.entries[day].lift.count, 1, 'already met: not bumped to 2')
  assert.equal(r.json.entries[day].walk.count, 1)
  assert.equal(r.json.entries[day].protein, undefined, 'its app fills it')
  assert.match((await call('POST', '/api/habits/log', { id: 'training', date: day, counts: { protein: 1 } })).json.error, /not a hand-logged sub-habit/)
})

test('a parent id longer than a slug still names its own habit', async () => {
  // Its slug is exactly 40 characters, so a second one is "<slug>-2", which slugs back to the first.
  const long = 'Wind down before bed with lights out byx'
  let r = await call('POST', '/api/habits', { name: `${long} one` })
  r = await call('POST', '/api/habits', { name: `${long} two` })
  const second = r.json.habits.find((h) => h.name === `${long} two`).id
  assert.ok(second.length > 40, 'the second id carries a suffix past the slug length')
  r = await call('POST', '/api/habits', { name: 'Lock the doors', parentId: second })
  assert.equal(r.status, 200)
  r = await call('GET', '/api/habits')
  const parent = habit(r.json, habit(r.json, 'lock-the-doors').parentId)
  assert.equal(parent?.name, `${long} two`)
})

test('ids stay put across a reorder, so each habit keeps its own history', async () => {
  const day = (await call('GET', '/api/habits')).json.today
  const long = 'Stretch hamstrings and calves after runs'
  await call('POST', '/api/habits', { name: `${long} a` })
  let r = await call('POST', '/api/habits', { name: `${long} b` })
  const first = r.json.habits.find((h) => h.name === `${long} a`).id
  const second = r.json.habits.find((h) => h.name === `${long} b`).id
  await call('POST', '/api/habits/log', { id: first, date: day, count: 1 })
  const active = r.json.habits.filter((h) => !h.archived).map((h) => h.id)
  r = await call('POST', '/api/habits/reorder', { ids: [second, ...active.filter((id) => id !== second)] })
  assert.equal(r.status, 200)
  const byName = (n) => r.json.habits.find((h) => h.name === n).id
  assert.equal(r.json.entries[day][byName(`${long} a`)]?.count, 1)
  assert.equal(r.json.entries[day][byName(`${long} b`)], undefined)
})

test('an archived group lets its sub-habits out; deleting it frees them for good', async () => {
  let r = await call('PATCH', '/api/habits', { id: 'nightly-routine', archived: true })
  assert.equal(habit(r.json, 'stretch').parentId, null)
  assert.equal(onDisk().habits.find((h) => h.id === 'stretch').parentId, 'nightly-routine', 'restoring the group brings them back')
  r = await call('PATCH', '/api/habits', { id: 'nightly-routine', archived: false })
  assert.equal(habit(r.json, 'stretch').parentId, 'nightly-routine')
  r = await call('DELETE', '/api/habits', { id: 'nightly-routine' })
  assert.equal(habit(r.json, 'stretch').parentId, null)
  assert.equal(onDisk().habits.find((h) => h.id === 'stretch').parentId, null)
})
