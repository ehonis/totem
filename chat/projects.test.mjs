// node --test chat/projects.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createProjectStore, MEMORY_MAX, memoryEntries, moveMemoryEntries, projectModelDefault } from './projects.mjs'
import { newChatChoice, settingsFromSpec, turnModelFields } from './route.mjs'
import { createThreadStore } from './store.mjs'
import { projectBlock } from './turn.mjs'
import { memoryFileStats, memorySummary, outsideDir, MEMORY_HEAD_CHARS } from './memory-ref.mjs'

const tmp = () => mkdtemp(join(tmpdir(), 'totem-projects-'))

test('a project is created with an empty memory file and edited field by field', async () => {
  const dir = await tmp()
  const store = createProjectStore({ dir })
  const p = await store.create({ name: '  Work  ', instructions: 'Be terse.', provider: 'claude', modelSettings: { preset: 'manual', modelId: 'opus', junk: 1 } })
  assert.equal(p.name, 'Work')
  assert.deepEqual(p.modelSettings, { modelId: 'opus' })
  // A choice saved under the retired Auto/Instant/Thinking presets never named a model.
  const legacy = await store.create({ name: 'Old', modelSettings: { preset: 'auto', modelId: 'composer-2.5' } })
  assert.equal(legacy.modelSettings, undefined)
  assert.equal(await readFile(store.memoryPath(p.id), 'utf8'), '')
  const next = await store.patch(p.id, { instructions: 'Be kind.', provider: null, files: [{ id: 'x'.repeat(10) }] })
  assert.equal(next.instructions, 'Be kind.')
  assert.equal(next.provider, undefined)
  assert.equal(next.files.length, 0, 'files only change through addFiles/removeFiles')
  await rm(dir, { recursive: true, force: true })
})

test('a project can wear an uploaded picture, which the orphan sweep keeps', async () => {
  const dir = await tmp()
  const store = createProjectStore({ dir })
  const p = await store.create({ name: 'Acme', image: 'cccccccccc' })
  assert.equal(p.image, 'cccccccccc')
  assert.deepEqual([...(await store.fileIds())], ['cccccccccc'])
  assert.equal((await store.patch(p.id, { image: '../etc' })).image, undefined, 'a bad id is dropped')
  await store.patch(p.id, { image: 'dddddddddd', icon: 'code' })
  assert.equal((await store.patch(p.id, { image: null })).image, undefined)
  assert.equal((await store.get(p.id)).icon, 'code')
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

test('projectBlock names the memory file with a summary instead of pasting it, and lists files with paths', () => {
  const block = projectBlock(
    { name: 'Work', instructions: 'Use British spelling.' },
    {
      memory: { path: '/data/chat-projects/p/memory.md', bytes: 4300, entries: 12, updated: '2026-11-03' },
      files: [
        { name: 'spec.pdf', mime: 'application/pdf', size: 4096, path: '/u/1/spec.pdf' },
        { name: 'plan.md', mime: 'text/markdown', size: 100, source: 'agent', path: '/u/2/plan.md' },
        { name: 'gone.png', kind: 'image', size: 1 },
      ],
    },
  )
  assert.match(block, /project "Work"/)
  assert.match(block, /Use British spelling\./, 'owner-written instructions stay inline')
  assert.match(block, /Project memory: \/data\/chat-projects\/p\/memory\.md \(4\.2 KB, 12 entries, last updated 2026-11-03\)\. It is not pasted here: read it/)
  assert.match(block, /If you read it earlier in this chat and this summary has changed since, read it again/, 'a resumed chat knows its copy may be stale')
  assert.match(block, /Keep that file current with your file tools \(read it first\)/)
  assert.match(block, /spec\.pdf \(application\/pdf, 4 KB\): \/u\/1\/spec\.pdf/)
  assert.match(block, /plan\.md .*made by you in an earlier chat/)
  assert.doesNotMatch(block, /gone\.png/, 'a file whose upload is gone is not offered')
  assert.equal(projectBlock(null), '')
  const empty = projectBlock({ name: 'Empty' }, { memory: { path: '/m.md', bytes: 0, entries: 0, updated: null } })
  assert.match(empty, /Project memory: \/m\.md \(empty so far\)\./)
  assert.doesNotMatch(empty, /read it with your file tools before/, 'nothing to read in an empty memory')
})

test('projectBlock never carries memory text, however large the file', async () => {
  const dir = await tmp()
  const path = join(dir, 'memory.md')
  const secretish = 'the-memory-body-marker'
  await writeFile(path, `## Decisions\n${Array.from({ length: 400 }, (_, i) => `- 2026-10-${String((i % 28) + 1).padStart(2, '0')}: ${secretish} ${i}`).join('\n')}\n`)
  const stats = await memoryFileStats(path, { tz: 'UTC' })
  assert.equal(stats.entries, 400)
  assert.ok(stats.bytes > 10_000)
  const block = projectBlock({ name: 'Big' }, { memory: stats })
  assert.doesNotMatch(block, new RegExp(secretish))
  assert.ok(block.length < 1500, `the block stays small (${block.length})`)
  assert.match(stats.updated, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'minutes, so a same-day change shows')
  assert.deepEqual(stats.headings, ['Decisions'])
  assert.match(block, /; sections: Decisions\)/)
  assert.deepEqual(await memoryFileStats(join(dir, 'missing.md')), { path: join(dir, 'missing.md'), bytes: 0, entries: 0, updated: null, headings: [] })
  assert.equal(memorySummary({ bytes: 300, entries: 1, updated: '2026-11-01 09:30' }), '300 bytes, 1 entry, last updated 2026-11-01 09:30')
  assert.equal(memorySummary({ bytes: 1, entries: 1, headings: 'abcdefghij'.split('') }), '1 bytes, 1 entry; sections: a, b, c, d, e, f, g, h and 2 more')
  assert.equal(memorySummary(null), 'empty so far')
  assert.equal((await memoryFileStats('')).path, '', 'no path is not the bridge folder')
  await rm(dir, { recursive: true, force: true })
})

test('a backend that cannot open the file gets its start instead, and paths are made absolute', async () => {
  const dir = await tmp()
  const path = join(dir, 'memory.md')
  await writeFile(path, `- ${'x'.repeat(5000)}\n`)
  const stats = await memoryFileStats(path, { headChars: MEMORY_HEAD_CHARS })
  assert.equal(stats.pasted.length, MEMORY_HEAD_CHARS)
  assert.equal(stats.cut, true)
  const block = projectBlock({ name: 'P' }, { memory: stats })
  assert.match(block, /cannot open or edit files outside its working folder, so its first 4000 characters are pasted here\. [^\n]*\n- x{10}/)
  assert.doesNotMatch(block, /Keep that file current/, 'no upkeep asked of a run that cannot edit the file')
  assert.doesNotMatch(block, /It is not pasted here/)
  const small = await memoryFileStats(path.replace('memory.md', 'small.md'), { headChars: MEMORY_HEAD_CHARS })
  assert.equal(small.pasted, undefined, 'an empty memory has nothing to paste')
  assert.equal(outsideDir(path, dir), false)
  assert.equal(outsideDir(path, join(dir, 'sub')), true)
  assert.equal(outsideDir('/a/..b/m.md', '/a'), false)
  const rel = relative(process.cwd(), path)
  assert.equal((await memoryFileStats(rel)).path, path, 'a relative path is resolved against the bridge, not left for the agent')
  await rm(dir, { recursive: true, force: true })
})

test('a folder records its parent; a project cannot be its own parent', async () => {
  const dir = await tmp()
  const store = createProjectStore({ dir })
  const work = await store.create({ name: 'Work' })
  const folder = await store.create({ name: 'Hiring', parentId: work.id })
  assert.equal(folder.parentId, work.id)
  assert.equal((await store.patch(folder.id, { parentId: 'elsewhere' })).parentId, work.id, 'the parent is fixed at creation')
  assert.equal((await store.update(work.id, (p) => { p.parentId = work.id })).parentId, undefined)
  await rm(dir, { recursive: true, force: true })
})

test('memory entries are bullets with their indented lines, or paragraphs, under a heading', () => {
  const text = 'Loose note\n\n## Decisions\n- use X\n  because Y\n* use Z\n1. numbered\n\n### Sub\nA paragraph\nthat wraps\n'
  assert.deepEqual(memoryEntries(text).map((e) => [e.heading, e.text]), [
    ['', 'Loose note'],
    ['## Decisions', '- use X\n  because Y'],
    ['## Decisions', '* use Z'],
    ['## Decisions', '1. numbered'],
    ['### Sub', 'A paragraph\nthat wraps'],
  ])
})

test('moving memory entries up keeps their heading, merges into an existing one, and drops emptied headings', () => {
  const folder = '## Decisions\n- use X\n  because Y\n- keep W\n\n## Facts\n- sky is blue\n'
  const parent = 'Top note\n\n## Decisions\n- older call\n\n## People\n- Sam'
  const r = moveMemoryEntries(folder, parent, ['- use X\n  because Y', '- sky is blue', '- not there'])
  assert.equal(r.moved, 2)
  assert.equal(r.from, '## Decisions\n- keep W')
  assert.equal(r.to, 'Top note\n\n## Decisions\n- older call\n- use X\n  because Y\n\n## People\n- Sam\n\n## Facts\n- sky is blue')
  assert.deepEqual(moveMemoryEntries('a', 'b', ['nope']), { from: 'a', to: 'b', moved: 0 })
  assert.equal(moveMemoryEntries('- one', '', ['- one']).to, '- one')
})

test('a folder chat gets the parent memory by path, read-only, and keeps only the folder memory', () => {
  const block = projectBlock(
    { name: 'Hiring', instructions: 'Use the scorecard.' },
    {
      memory: { path: '/p/hiring/memory.md', bytes: 20, entries: 1, updated: '2026-11-02' }, files: [],
      parent: { project: { name: 'Work', instructions: 'Be terse.' }, memory: { path: '/p/work/memory.md', bytes: 2048, entries: 5, updated: '2026-10-30' }, files: [{ name: 'plan.pdf', mime: 'application/pdf', size: 1024, path: '/u/plan.pdf' }] },
    },
  )
  assert.match(block, /folder inside the owner's project "Work"/)
  assert.match(block, /parent project "Work" \(follow them in this chat\):\nBe terse\./)
  assert.match(block, /Parent project memory: \/p\/work\/memory\.md \(2\.0 KB, 5 entries, last updated 2026-10-30\)\. It is not pasted here/)
  assert.match(block, /plan\.pdf .*: \/u\/plan\.pdf/)
  assert.match(block, /Folder instructions from the owner[^\n]*\nUse the scorecard\./)
  assert.match(block, /Folder memory: \/p\/hiring\/memory\.md \(20 bytes, 1 entry, last updated 2026-11-02\)/)
  assert.match(block, /Folder memory: \/p\/hiring\/memory\.md [^\n]*\nKeep that file current/, 'the file to keep is the folder memory')
  assert.match(block, /Parent project memory: [^\n]*\nRead-only: never edit that file/)
  const noParentMemory = projectBlock({ name: 'Hiring' }, { memory: { path: '/p/hiring/memory.md' }, parent: { project: { name: 'Work' }, memory: { path: '/p/work/memory.md', entries: 0 } } })
  assert.doesNotMatch(noParentMemory, /work\/memory\.md/, 'an empty parent memory is not mentioned')
})

test('a thread keeps project-context-off and needs-reply flags, and clears them', async () => {
  const dir = await tmp()
  const threads = createThreadStore({ dir })
  await threads.put('t1', { messages: [], projectId: 'p1', projectContextOff: true })
  await threads.update('t1', (t) => { t.needsReply = true })
  let t = await threads.get('t1')
  assert.equal(t.projectContextOff, true)
  assert.equal(t.needsReply, true)
  await threads.put('t1', { projectContextOff: false, needsReply: false })
  t = await threads.get('t1')
  assert.equal(t.projectContextOff, undefined)
  assert.equal(t.needsReply, undefined)
  await rm(dir, { recursive: true, force: true })
})

test('marked unread sticks with needs-reply and goes when it is cleared', async () => {
  const dir = await tmp()
  const threads = createThreadStore({ dir })
  await threads.put('t1', { messages: [] })
  await threads.put('t1', { keepUnread: true })
  assert.equal((await threads.get('t1')).keepUnread, undefined, 'nothing to keep unread')
  await threads.put('t1', { needsReply: true, keepUnread: true })
  let t = await threads.get('t1')
  assert.equal(t.needsReply, true)
  assert.equal(t.keepUnread, true)
  await threads.put('t1', { needsReply: false })
  t = await threads.get('t1')
  assert.equal(t.needsReply, undefined)
  assert.equal(t.keepUnread, undefined)
  await rm(dir, { recursive: true, force: true })
})

test('a thread keeps its settled and snoozed fields, and nulls clear them', async () => {
  const dir = await tmp()
  const threads = createThreadStore({ dir })
  await threads.put('t1', { messages: [], pinned: true })
  await threads.put('t1', { settledOverride: 'settled', settledAt: 1000, pinned: false, snoozedUntil: null, snoozedAt: null })
  let t = await threads.get('t1')
  assert.equal(t.settledOverride, 'settled')
  assert.equal(t.settledAt, 1000)
  assert.equal(t.pinned, undefined)
  await threads.put('t1', { settledOverride: 'active', settledAt: null, unsettledAt: 2000, snoozedUntil: 9_999_999_999_999 })
  t = await threads.get('t1')
  assert.equal(t.settledOverride, 'active')
  assert.equal(t.settledAt, undefined)
  assert.equal(t.unsettledAt, 2000)
  assert.ok(t.snoozedAt > 0, 'a snooze records when it was set')
  await threads.put('t1', { snoozedUntil: null, snoozedAt: null, settledOverride: 'bogus' })
  t = await threads.get('t1')
  assert.equal(t.settledOverride, undefined)
  assert.equal(t.snoozedUntil, undefined)
  assert.equal(t.snoozedAt, undefined)
  // A settledAt without a settle is dropped.
  await threads.put('t1', { settledAt: 5 })
  assert.equal((await threads.get('t1')).settledAt, undefined)
  await rm(dir, { recursive: true, force: true })
})

test('a chat starts on its folder\'s model, else its project\'s, else none (Settings → Providers)', async () => {
  const dir = await tmp()
  try {
    const store = createProjectStore({ dir })
    const opus = { modelId: 'claude-opus-5-5', effort: 'high' }
    const work = await store.create({ name: 'Work', provider: 'claude', modelSettings: opus })
    // A folder made with no model of its own (threads__create makes them so) follows the project.
    const inherits = await store.create({ name: 'Client A', parentId: work.id })
    const own = await store.create({ name: 'Own', parentId: work.id, provider: 'codex', modelSettings: { modelId: 'gpt-6.1-sol' } })
    const bare = await store.create({ name: 'Bare' })
    const bareFolder = await store.create({ name: 'Inside bare', parentId: bare.id })
    const projects = await store.list()

    assert.deepEqual(projectModelDefault(projects, inherits.id), { provider: 'claude', modelSettings: opus })
    assert.deepEqual(projectModelDefault(projects, own.id), { provider: 'codex', modelSettings: { modelId: 'gpt-6.1-sol' } })
    assert.deepEqual(projectModelDefault(projects, work.id), { provider: 'claude', modelSettings: opus })
    assert.equal(projectModelDefault(projects, bare.id), null)
    assert.equal(projectModelDefault(projects, bareFolder.id), null)
    assert.equal(projectModelDefault(projects, null), null)
    assert.equal(projectModelDefault(projects, 'gone'), null)
    // An account that is no longer enabled is passed over for the parent's.
    assert.deepEqual(projectModelDefault(projects, own.id, { usable: (p) => p !== 'codex' }), { provider: 'claude', modelSettings: opus })
    assert.equal(projectModelDefault(projects, own.id, { usable: () => false }), null)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a stored chat choice becomes the turn\'s model fields, Cursor parameters included', () => {
  assert.deepEqual(turnModelFields({ provider: 'claude', modelSettings: { modelId: 'claude-opus-5-5', effort: 'high' } }, 'claude'),
    { provider: 'claude', model: 'claude-opus-5-5', effort: 'high', modelSettings: { modelId: 'claude-opus-5-5', effort: 'high' } })
  assert.deepEqual(turnModelFields({ provider: 'codex', modelSettings: { modelId: 'gpt-6.1-sol', effort: 'default' } }, 'codex'),
    { provider: 'codex', model: 'gpt-6.1-sol', modelSettings: { modelId: 'gpt-6.1-sol', effort: 'default' } })
  assert.deepEqual(turnModelFields({ provider: 'cursor', modelSettings: { modelId: 'composer-2.5', speed: 'fast', effort: 'default', context: 'default' } }, 'cursor').model, 'composer-2.5[fast=true]')
  // Unset speed is fast, as the dashboard reads it (DEFAULT_MODEL_SETTINGS).
  assert.equal(turnModelFields({ provider: 'cursor', modelSettings: { modelId: 'composer-2.5' } }, 'cursor').model, 'composer-2.5[fast=true]')
  assert.equal(turnModelFields({ provider: 'cursor', modelSettings: { modelId: 'gpt-5.3-codex', speed: 'default' } }, 'cursor').model, 'gpt-5.3-codex')
  // The default account with no model of its own: the bridge picks that account's default.
  assert.deepEqual(turnModelFields({ provider: 'codex', modelSettings: null }, 'codex'), { provider: 'codex' })
  assert.deepEqual(turnModelFields({}), {})
})

test('a chat the bridge makes is stored with its place\'s model, named even when the default names none', async () => {
  const config = { defaultProvider: 'codex', defaultModel: null, enabledProviders: ['codex', 'claude', 'cursor'] }
  const driverOf = (p) => p
  const asked = []
  const resolveModel = async (provider, effort) => {
    asked.push([provider, effort])
    return provider === 'cursor' ? { cursorModel: 'composer-2.5[fast=true]' } : { model: provider === 'codex' ? 'gpt-6.1-sol' : 'claude-opus-5-5' }
  }
  const projects = [
    { id: 'work', name: 'Work', provider: 'claude', modelSettings: { modelId: 'claude-opus-5-5', effort: 'high' } },
    { id: 'clienta', name: 'Client A', parentId: 'work' },
    { id: 'bare', name: 'Bare' },
    { id: 'noid', name: 'No model', provider: 'claude', modelSettings: { modelId: '', effort: 'high' } },
    { id: 'cur', name: 'Cursor', provider: 'cursor' },
    { id: 'curq', name: 'Cursor, quality', provider: 'cursor', modelSettings: { speed: 'quality', effort: 'high' } },
  ]
  const choose = (projectId) => newChatChoice({ projects, projectId, config, driverOf, resolveModel })

  // A folder with no model of its own: its project's, as stored, with nothing to resolve.
  assert.deepEqual(await choose('clienta'), { provider: 'claude', modelSettings: { modelId: 'claude-opus-5-5', effort: 'high' } })
  assert.deepEqual(asked, [])
  // Settings → Providers with no model set: the model a run would use is named, so changing the default later does not move the chat.
  assert.deepEqual(await choose('bare'), { provider: 'codex', modelSettings: { modelId: 'gpt-6.1-sol' } })
  assert.deepEqual(await choose(null), { provider: 'codex', modelSettings: { modelId: 'gpt-6.1-sol' } })
  // An account picked with no model keeps its effort and gets the account's model.
  assert.deepEqual(await choose('noid'), { provider: 'claude', modelSettings: { modelId: 'claude-opus-5-5', effort: 'high' } })
  assert.deepEqual(asked.at(-1), ['claude', 'high'])
  // Cursor's resolved spec comes back as settings.
  assert.deepEqual(await choose('cur'), { provider: 'cursor', modelSettings: settingsFromSpec('composer-2.5[fast=true]') })
  // A Cursor default with its own speed and effort keeps them; only the model is filled in.
  assert.deepEqual(await choose('curq'), { provider: 'cursor', modelSettings: { modelId: 'composer-2.5', speed: 'quality', effort: 'high', context: 'default' } })
  assert.deepEqual(settingsFromSpec('composer-2.5[fast=true]'), { modelId: 'composer-2.5', speed: 'fast', effort: 'default', context: 'default' })
  // Nothing to name (an account whose CLI picks for itself): the account alone.
  assert.deepEqual(await newChatChoice({ projects, projectId: null, config, driverOf, resolveModel: async () => ({ model: '' }) }), { provider: 'codex', modelSettings: null })
})
