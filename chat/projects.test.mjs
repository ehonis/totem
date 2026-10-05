// node --test chat/projects.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectStore, MEMORY_MAX } from './projects.mjs'
import { createThreadStore } from './store.mjs'
import { projectBlock } from './turn.mjs'

const tmp = () => mkdtemp(join(tmpdir(), 'totem-projects-'))

test('a project is created with an empty memory file and edited field by field', async () => {
  const dir = await tmp()
  const store = createProjectStore({ dir })
  const p = await store.create({ name: '  Work  ', instructions: 'Be terse.', provider: 'claude', modelSettings: { preset: 'manual', modelId: 'opus', junk: 1 } })
  assert.equal(p.name, 'Work')
  assert.deepEqual(p.modelSettings, { preset: 'manual', modelId: 'opus' })
  assert.equal(await readFile(store.memoryPath(p.id), 'utf8'), '')
  const next = await store.patch(p.id, { instructions: 'Be kind.', provider: null, files: [{ id: 'x'.repeat(10) }] })
  assert.equal(next.instructions, 'Be kind.')
  assert.equal(next.provider, undefined)
  assert.equal(next.files.length, 0, 'files only change through addFiles/removeFiles')
  await rm(dir, { recursive: true, force: true })
})

test('files are deduplicated by upload id and removed by id', async () => {
  const dir = await tmp()
  const store = createProjectStore({ dir })
  const p = await store.create({ name: 'Trip' })
  const a = { id: 'aaaaaaaaaa', name: 'itinerary.pdf', mime: 'application/pdf', size: 2048, kind: 'file', source: 'chat', threadId: 't1' }
  const b = { id: 'bbbbbbbbbb', name: 'notes.md', mime: 'text/markdown', size: 10, kind: 'file', source: 'agent' }
  assert.equal((await store.addFiles(p.id, [a, b])).length, 2)
  assert.equal((await store.addFiles(p.id, [a, { id: 'bad id!' }])).length, 0)
  assert.deepEqual([...(await store.fileIds())].sort(), ['aaaaaaaaaa', 'bbbbbbbbbb'])
  const removed = await store.removeFiles(p.id, ['aaaaaaaaaa'])
  assert.equal(removed[0].threadId, 't1')
  assert.deepEqual((await store.get(p.id)).files.map((f) => f.id), ['bbbbbbbbbb'])
  await rm(dir, { recursive: true, force: true })
})

test('concurrent additions to one project all land', async () => {
  const dir = await tmp()
  const store = createProjectStore({ dir })
  const p = await store.create({ name: 'Busy' })
  await Promise.all(Array.from({ length: 10 }, (_, i) => store.addFiles(p.id, [{ id: `file${String(i).padStart(6, '0')}`, name: `${i}.txt` }])))
  assert.equal((await store.get(p.id)).files.length, 10)
  await rm(dir, { recursive: true, force: true })
})

test('memory is capped and a missing project refuses writes', async () => {
  const dir = await tmp()
  const store = createProjectStore({ dir })
  const p = await store.create({ name: 'Mem' })
  await store.writeMemory(p.id, 'x'.repeat(MEMORY_MAX + 10))
  assert.equal((await store.readMemory(p.id)).length, MEMORY_MAX)
  await assert.rejects(store.writeMemory('nope', 'hi'), /not found/)
  await store.remove(p.id)
  assert.equal(await store.get(p.id), null)
  await rm(dir, { recursive: true, force: true })
})

test('a thread carries its project, and a project chat is never temporary', async () => {
  const dir = await tmp()
  const store = createThreadStore({ dir })
  const t = await store.put('t1', { kind: 'temporary', projectId: 'proj1', messages: [] })
  assert.equal(t.projectId, 'proj1')
  assert.equal(t.kind, 'regular')
  assert.equal(t.expiresAt, undefined)
  const moved = await store.put('t1', { projectId: null })
  assert.equal(moved.projectId, undefined)
  await rm(dir, { recursive: true, force: true })
})

test('projectBlock lists instructions, memory with its path, and files with paths', () => {
  const block = projectBlock(
    { name: 'Work', instructions: 'Use British spelling.' },
    {
      memory: '- 2026-10-01: picked Postgres',
      memoryPath: '/data/chat-projects/p/memory.md',
      files: [
        { name: 'spec.pdf', mime: 'application/pdf', size: 4096, path: '/u/1/spec.pdf' },
        { name: 'plan.md', mime: 'text/markdown', size: 100, source: 'agent', path: '/u/2/plan.md' },
        { name: 'gone.png', kind: 'image', size: 1 },
      ],
    },
  )
  assert.match(block, /project "Work"/)
  assert.match(block, /Use British spelling\./)
  assert.match(block, /picked Postgres/)
  assert.match(block, /\/data\/chat-projects\/p\/memory\.md/)
  assert.match(block, /spec\.pdf \(application\/pdf, 4 KB\): \/u\/1\/spec\.pdf/)
  assert.match(block, /plan\.md .*made by you in an earlier chat/)
  assert.doesNotMatch(block, /gone\.png/, 'a file whose upload is gone is not offered')
  assert.equal(projectBlock(null), '')
  assert.match(projectBlock({ name: 'Empty' }, { memoryPath: '/m.md' }), /\(empty so far\)/)
})
