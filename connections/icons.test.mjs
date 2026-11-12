// node --test connections/icons.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanChoice, createConnectionIconStore, validConnectionId } from './icons.mjs'

const fresh = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conn-icons-'))
  const file = join(dir, 'connection-icons.json')
  return { file, store: createConnectionIconStore({ file }) }
}

test('cleanChoice keeps a listed icon or an upload id, nothing else', () => {
  assert.deepEqual(cleanChoice({ icon: 'database' }), { icon: 'database' })
  assert.deepEqual(cleanChoice({ image: 'abcdef0123456789' }), { image: 'abcdef0123456789' })
  assert.deepEqual(cleanChoice({ icon: 'database', image: 'abcdef0123456789' }), { image: 'abcdef0123456789' })
  assert.equal(cleanChoice({ icon: 'not-a-tabler-icon' }), null)
  assert.equal(cleanChoice({ image: '../../etc/passwd' }), null)
  assert.equal(cleanChoice(null), null)
  assert.equal(validConnectionId('google-drive'), true)
  assert.equal(validConnectionId('../x'), false)
})

test('set stores, replaces and clears, returning what it replaced', async () => {
  const { store, file } = await fresh()
  assert.deepEqual(await store.all(), {})
  assert.equal(await store.set('linear', { icon: 'chart-line' }), null)
  assert.deepEqual(await store.set('linear', { image: 'abcdef0123456789' }), { icon: 'chart-line' })
  assert.deepEqual(await store.all(), { linear: { image: 'abcdef0123456789' } })
  assert.deepEqual([...await store.imageIds()], ['abcdef0123456789'])
  assert.deepEqual(await store.set('linear', null), { image: 'abcdef0123456789' })
  assert.deepEqual(await store.all(), {})
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {})
})

test('set refuses a bad id or an unknown icon without writing', async () => {
  const { store } = await fresh()
  await assert.rejects(store.set('../x', { icon: 'database' }), { status: 400 })
  await assert.rejects(store.set('linear', { icon: 'nope' }), { status: 400 })
  assert.deepEqual(await store.all(), {})
})

test('concurrent sets all land', async () => {
  const { store } = await fresh()
  await Promise.all(['a', 'b', 'c', 'd'].map((id) => store.set(id, { icon: 'database' })))
  assert.deepEqual(Object.keys(await store.all()).sort(), ['a', 'b', 'c', 'd'])
})

test('a hand-edited file loses only its bad rows', async () => {
  const { store, file } = await fresh()
  await writeFile(file, JSON.stringify({ ok: { icon: 'server' }, '../bad': { icon: 'server' }, junk: { icon: 'nope' }, arr: [] }))
  assert.deepEqual(await store.all(), { ok: { icon: 'server' } })
  await writeFile(file, 'not json')
  assert.deepEqual(await store.all(), {})
})
