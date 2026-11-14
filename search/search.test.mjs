import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createSearchIndex, ftsQuery, matchPart, plainMarks, MARK_START, MARK_END } from './index.mjs'
import { markdownSections, noteSource, chatSource, journalSource, listSource, goalSource, projectSource, totemSource } from './sources.mjs'

const fixed = (docs, kind = 'note') => ({ kind, load: async () => docs })

test('ftsQuery quotes every word as a prefix and drops FTS syntax', () => {
  assert.equal(ftsQuery('watch'), '"watch"*')
  assert.equal(ftsQuery('Seiko -NEAR "x":y'), '"seiko"* "near"* "x"* "y"*')
  assert.equal(ftsQuery('a b', { any: true }), '"a"* OR "b"*')
  assert.equal(ftsQuery('  ...  '), '')
})

test('stemming finds "watches" for "watch", and titles outrank bodies', async () => {
  const index = createSearchIndex({ sources: [fixed([
    { id: 'a', title: 'Groceries', body: 'eggs, and I want to watch a film' },
    { id: 'b', title: 'Watches', body: 'Seiko SKX, Casio F-91W' },
    { id: 'c', title: 'Bikes', body: 'nothing relevant' },
  ])] })
  const res = await index.search('watch')
  assert.deepEqual(res.results.map((r) => r.id), ['note:b', 'note:a'])
  assert.equal(res.counts.note, 2)
  assert.ok(res.results[1].snippet.includes(`${MARK_START}watch${MARK_END}`))
  assert.equal(plainMarks(res.results[1].snippet).includes('[watch]'), true)
})

test('all words first, any word as a labelled fallback', async () => {
  const index = createSearchIndex({ sources: [fixed([
    { id: 'a', title: 'Watch list', body: 'Seiko' },
    { id: 'b', title: 'Bike', body: 'gravel' },
  ])] })
  assert.equal((await index.search('seiko watch')).loose, false)
  const res = await index.search('watch gravel')
  assert.equal(res.loose, true)
  assert.equal(res.results.length, 2)
})

test('kind filter, get by id, and a failing source does not break the rest', async () => {
  const logs = []
  const index = createSearchIndex({
    log: (m) => logs.push(m),
    sources: [
      fixed([{ id: '1', title: 'Watch note', body: 'x', target: { tab: 'brain', path: 'a.md' } }]),
      fixed([{ id: '2', title: 'Buy a watch', body: 'y' }], 'task'),
      { kind: 'journal', load: async () => { throw new Error('boom') } },
    ],
  })
  const res = await index.search('watch', { kinds: ['task'] })
  assert.deepEqual(res.results.map((r) => r.id), ['task:2'])
  // Counts cover every kind, so the filter chips can show what they would find.
  assert.deepEqual(res.counts, { note: 1, task: 1 })
  const doc = await index.get('note:1')
  assert.equal(doc.body, 'x')
  assert.deepEqual(doc.target, { tab: 'brain', path: 'a.md' })
  assert.equal(await index.get('note:nope'), null)
  assert.match(logs.join('\n'), /journal source failed: boom/)
  assert.deepEqual((await index.status()).errors, [{ kind: 'journal', error: 'boom' }])
})

test('rebuilds only once stale, and concurrent searches share one build', async () => {
  let t = 0
  let loads = 0
  let body = 'first'
  const index = createSearchIndex({ now: () => t, staleMs: 1000, sources: [{ kind: 'note', load: async () => { loads += 1; return [{ id: 'x', title: 'n', body }] } }] })
  await Promise.all([index.search('first'), index.search('first')])
  assert.equal(loads, 1)
  body = 'second'
  t = 500
  assert.equal((await index.search('second')).total, 0)
  t = 1500
  assert.equal((await index.search('second')).total, 1)
  assert.equal(loads, 2)
})

test('markdownSections splits at headings, ignores # inside code fences, keeps line numbers', () => {
  const md = 'intro line\n\n# Watches\n- Seiko\n```\n# not a heading\n```\n## Wishlist\n- Omega\n'
  const s = markdownSections(md)
  assert.deepEqual(s.map((x) => [x.heading, x.line]), [['', 1], ['Watches', 3], ['Wishlist', 8]])
  assert.match(s[1].body, /# not a heading/)
})

test('note, journal and chat sources produce openable docs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'search-notes-'))
  try {
    await mkdir(join(root, 'personal'))
    await writeFile(join(root, 'personal', 'watches.md'), '# Watches\n\nSeiko SKX\n\n## Wishlist\n\nOmega Speedmaster\n')
    await writeFile(join(root, 'inbox.md'), 'staging, not searched')
    const notes = await noteSource({ root, include: (rel) => rel !== 'inbox.md' }).load()
    assert.deepEqual(notes.map((d) => [d.id, d.title]), [
      ['personal/watches.md#1', 'watches'],
      ['personal/watches.md#5', 'watches › Wishlist'],
    ])
    assert.deepEqual(notes[1].target, { tab: 'brain', path: 'personal/watches.md', line: 5 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  const journal = await journalSource({ store: { list: async () => [{ id: 'j1', title: 'Recap', date: '2026-09-22', transcript: { text: 'talked about watches' } }] } }).load()
  assert.equal(journal[0].body, 'talked about watches')

  const chats = await chatSource({ threads: { list: async () => [{ id: 't1', title: 'Watch talk', updatedAt: 1, messages: [
    { id: 'm1', role: 'user', content: 'Which watch should I get?', createdAt: Date.UTC(2026, 8, 1) },
    { id: 'm2', role: 'assistant', content: '' },
  ] }] } }).load()
  assert.equal(chats.length, 1)
  assert.deepEqual(chats[0].target, { tab: 'chat', thread: 't1', message: 'm1' })
  assert.equal(chats[0].date, '2026-09-01')
})

// Opening a hit lands on the thing that matched (#261): each target names it.

test('matchPart names the first item with every word, else any word, else none', () => {
  const parts = [{ id: 'i1', text: 'Eggs' }, { id: 'i2', text: 'Seiko watch strap' }, { id: 'i3', text: 'Watch battery' }]
  assert.equal(matchPart(parts, 'watch batt'), 'i3')
  assert.equal(matchPart(parts, 'WATCH'), 'i2')
  assert.equal(matchPart(parts, 'strap gravel'), 'i2')
  assert.equal(matchPart(parts, 'gravel'), null)
  assert.equal(matchPart([{ id: 'c', text: 'Café crème' }], 'cafe'), 'c')
  assert.equal(matchPart(null, 'x'), null)
})

test('a list hit names the matched item in its target, and the items stay in the index', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE lists (id TEXT, title TEXT, updated_at TEXT);
    CREATE TABLE list_items (id TEXT, list_id TEXT, text TEXT, checked INTEGER, position INTEGER);
    INSERT INTO lists VALUES ('L1', 'Packing', '2026-11-01T00:00:00Z');
    INSERT INTO list_items VALUES ('a', 'L1', 'Passport', 0, 0), ('b', 'L1', 'Watch charger', 1, 1)`)
  const index = createSearchIndex({ sources: [listSource({ db })] })
  const [hit] = (await index.search('charger')).results
  assert.deepEqual(hit.target, { tab: 'productivity', app: 'lists', id: 'L1', item: 'b' })
  assert.equal('parts' in hit, false)
  // A title-only match names no item.
  const [byTitle] = (await index.search('packing')).results
  assert.deepEqual(byTitle.target, { tab: 'productivity', app: 'lists', id: 'L1' })
  assert.equal((await index.get('list:L1')).body, '- [ ] Passport\n- [x] Watch charger')
})

test('a goal target carries its period, and a step its parent goal and that goal\'s period', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE goals (id TEXT, parent_id TEXT, title TEXT, notes TEXT, period_type TEXT, period_start TEXT, period_end TEXT, completed_at TEXT, abandoned_at TEXT, deleted_at TEXT);
    INSERT INTO goals VALUES ('g1', NULL, 'Ride 100 km', NULL, 'month', '2026-11-01', '2026-11-30', NULL, NULL, NULL),
      ('g2', 'g1', 'Fix the bike', NULL, NULL, NULL, NULL, NULL, NULL, NULL)`)
  const [goal, step] = await goalSource({ db }).load()
  assert.deepEqual(goal.target, { tab: 'productivity', app: 'goals', id: 'g1', period: 'month', start: '2026-11-01', end: '2026-11-30' })
  assert.deepEqual(step.target, { tab: 'productivity', app: 'goals', id: 'g2', parent: 'g1', period: 'month', start: '2026-11-01', end: '2026-11-30' })
})

test('project and totem targets say which section matched', async () => {
  const projects = { list: async () => [{ id: 'p1', name: 'Bike', instructions: 'Be brief', updatedAt: 1 }], readMemory: async () => '- likes gravel' }
  const docs = await projectSource({ projects }).load()
  assert.deepEqual(docs.map((d) => d.target), [
    { tab: 'chat', project: 'p1', section: 'instructions' },
    { tab: 'chat', project: 'p1', section: 'memory' },
  ])
  const dir = await mkdtemp(join(tmpdir(), 'search-totem-'))
  try {
    await writeFile(join(dir, 'memory.md'), 'last run fine')
    const totems = await totemSource({ jobs: { list: async () => [{ id: 'j1', name: 'Digest', prompt: 'Sum up' }] }, memoryPath: () => join(dir, 'memory.md') }).load()
    assert.deepEqual(totems.map((d) => d.target.section), ['instructions', 'memory'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})
