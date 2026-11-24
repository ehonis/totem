// Run with: node --test chat/uploads.test.mjs
//
// The orphan sweep and the holds a saved draft puts on its uploads: an upload a
// draft holds outlives the 24-hour sweep until 30 days after its last renewal.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, utimesSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUploadHolds, createUploadStore, UPLOAD_HOLD_MS } from './uploads.mjs'

const HOUR = 60 * 60_000
const T0 = Date.parse('2026-11-01T12:00:00Z')

function setup() {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'totem-uploads-'))
  const dir = join(root, 'uploads')
  const clock = { now: T0 }
  const store = createUploadStore({ dir, secret: 's' })
  const holds = createUploadHolds({ file: join(root, 'upload-holds.json'), now: () => clock.now })
  const upload = async (name) => {
    const { id } = await store.save({ buffer: Buffer.from(name), name: `${name}.txt`, mime: 'text/plain' })
    utimesSync(join(dir, id), T0 / 1000, T0 / 1000)
    return id
  }
  const sweep = async () => store.sweepOrphans({ referenced: await holds.ids(), now: clock.now })
  const kept = (id) => existsSync(join(dir, id))
  return { root, clock, holds, upload, sweep, kept, file: join(root, 'upload-holds.json') }
}

test('an upload a draft holds survives the sweep 25 hours later; one nobody holds does not', async (t) => {
  const s = setup()
  t.after(() => rmSync(s.root, { recursive: true, force: true }))
  const held = await s.upload('held')
  const loose = await s.upload('loose')
  await s.holds.hold([held])
  s.clock.now = T0 + 25 * HOUR
  assert.equal(await s.sweep(), 1)
  assert.equal(s.kept(held), true)
  assert.equal(s.kept(loose), false)
})

test('a hold lapses 30 days after its last renewal, and renewing pushes that back', async (t) => {
  const s = setup()
  t.after(() => rmSync(s.root, { recursive: true, force: true }))
  const renewed = await s.upload('renewed')
  const lapsed = await s.upload('lapsed')
  await s.holds.hold([renewed, lapsed])
  s.clock.now = T0 + 20 * 24 * HOUR
  await s.holds.hold([renewed])
  s.clock.now = T0 + UPLOAD_HOLD_MS + HOUR
  await s.sweep()
  assert.equal(s.kept(renewed), true)
  assert.equal(s.kept(lapsed), false)
  assert.deepEqual([...await s.holds.ids()], [renewed])
})

test('holding names only some ids: the others stay held, and a release lets one go', async (t) => {
  const s = setup()
  t.after(() => rmSync(s.root, { recursive: true, force: true }))
  const a = await s.upload('a')
  const b = await s.upload('b')
  await s.holds.hold([a])
  await s.holds.hold([b])
  await s.holds.release([a])
  assert.deepEqual([...await s.holds.ids()], [b])
})

test('the holds file is written whole and ignores what is not an upload id', async (t) => {
  const s = setup()
  t.after(() => rmSync(s.root, { recursive: true, force: true }))
  writeFileSync(s.file, '{not json')
  assert.deepEqual([...await s.holds.ids()], [])
  await Promise.all([s.holds.hold(['abcdef12', '../../etc']), s.holds.hold(['bcdefa23'])])
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(s.file, 'utf8'))).sort(), ['abcdef12', 'bcdefa23'])
})
