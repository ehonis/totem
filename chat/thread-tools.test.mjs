import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listThreads, readThread, shelfOf, threadsRule, projectPath, findChatPlace, listChatPlaces } from './thread-tools.mjs'

const NOW = Date.UTC(2026, 9, 6, 12)
const H = 3_600_000
const msg = (role, content, extra = {}) => ({ id: `${role}-${content.length}`, role, content, createdAt: NOW - H, ...extra })
const chat = (id, extra = {}) => ({ id, kind: 'regular', updatedAt: NOW - H, messages: [msg('user', `question ${id}`), msg('assistant', `answer ${id}`)], ...extra })
const projects = [{ id: 'work', name: 'Work' }, { id: 'hiring', name: 'Hiring', parentId: 'work' }]

test('a project includes its folders; a folder or home narrows it', () => {
  const threads = [chat('a', { projectId: 'work' }), chat('b', { projectId: 'hiring' }), chat('c'), chat('d', { projectId: 'gone' })]
  const ids = (args) => listThreads(threads, args, { projects, now: NOW }).threads.map((t) => t.id).sort()
  assert.deepEqual(ids({ project: 'work' }), ['a', 'b'])
  assert.deepEqual(ids({ project: 'hiring' }), ['b'])
  // A chat whose project was deleted is in Home, as in the panel.
  assert.deepEqual(ids({ project: 'home' }), ['c', 'd'])
  assert.equal(projectPath('hiring', projects), 'Work / Hiring')
})

test('leaves out the calling chat and empty chats, and puts running chats first', () => {
  const threads = [chat('self'), chat('old', { updatedAt: NOW - 5 * H }), chat('live', { updatedAt: NOW - 9 * H }), { id: 'empty', kind: 'regular', messages: [], updatedAt: NOW }]
  const out = listThreads(threads, { exclude: 'self' }, { projects, now: NOW, isRunning: (id) => id === 'live' })
  assert.deepEqual(out.threads.map((t) => t.id), ['live', 'old'])
  assert.equal(out.threads[0].running, true)
  assert.equal(listThreads(threads, { status: 'running' }, { now: NOW, isRunning: (id) => id === 'live' }).total, 1)
})

test('a query needs a keyword hit or a title match, and ranks by them', () => {
  const threads = [chat('x', { title: 'Strava export idea' }), chat('y', { title: 'Tax' }), chat('z', { title: 'Other' })]
  const hits = new Map([['y', ['strava [export] in a tax note']], ['z', ['a', 'b', 'c', 'd']]])
  const out = listThreads(threads, { query: 'strava export' }, { hits, now: NOW })
  assert.deepEqual(out.threads.map((t) => t.id), ['z', 'x', 'y'])
  assert.deepEqual(out.threads.find((t) => t.id === 'y').matches, ['strava [export] in a tax note'])
})

test('reports the shelf the panel shows, auto-settle included', () => {
  assert.equal(shelfOf(chat('a', { updatedAt: NOW - 4 * 24 * H }), { now: NOW, autoSettleDays: 3 }), 'settled')
  assert.equal(shelfOf(chat('a', { updatedAt: NOW - 4 * 24 * H, settledOverride: 'active' }), { now: NOW, autoSettleDays: 3 }), 'active')
  assert.equal(shelfOf(chat('a', { snoozedUntil: NOW + H }), { now: NOW }), 'snoozed')
  const waiting = listThreads([chat('w', { needsReply: true }), chat('q')], { status: 'waiting' }, { now: NOW })
  assert.deepEqual(waiting.threads.map((t) => t.id), ['w'])
})

test('reads the end of a chat with tool rows, clipped, and pages back', () => {
  const messages = Array.from({ length: 30 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `m${i} ${'x'.repeat(i === 29 ? 5000 : 3)}`))
  messages[29] = { ...messages[29], status: 'streaming', parts: [{ type: 'tool', id: 't', title: 'Ran npm test', detail: 'web', status: 'running' }] }
  const t = chat('r', { messages })
  const out = readThread(t, { last: 4 }, { projects, now: NOW, running: true })
  assert.deepEqual(out.transcript.map((m) => m.index), [26, 27, 28, 29])
  assert.equal(out.from, 26)
  assert.equal(out.running, true)
  const last = out.transcript.at(-1)
  assert.equal(last.status, 'streaming')
  assert.deepEqual(last.tools, ['… Ran npm test — web'])
  assert.ok(last.content.length <= 3000)
  assert.deepEqual(readThread(t, { from: 0, last: 2 }, { now: NOW }).transcript.map((m) => m.index), [0, 1])
  assert.equal(readThread(t, { last: 1, tools: false }, { now: NOW }).transcript[0].tools, undefined)
})

test('the prompt rule names the chat and says to look rarely', () => {
  const rule = threadsRule({ id: 'abc', projectId: 'hiring' }, projects)
  assert.match(rule, /this chat's id is abc, in the owner's project "Work \/ Hiring" \(project id hiring\)/)
  assert.match(rule, /Never look by habit/)
  assert.doesNotMatch(threadsRule({ id: 'abc' }, projects), /owner's project/)
})

test('finds where a new chat goes: project, folder, a folder by name alone, or a folder to make', () => {
  const ps = [...projects, { id: 'mn', name: 'M+N', parentId: 'work' }, { id: 'home2', name: 'Personal' }]
  assert.deepEqual(findChatPlace(ps, {}), { projectId: null, newFolder: null })
  assert.deepEqual(findChatPlace(ps, { project: 'home' }), { projectId: null, newFolder: null })
  assert.equal(findChatPlace(ps, { project: 'work' }).projectId, 'work')
  assert.equal(findChatPlace(ps, { project: 'WORK' }).projectId, 'work')
  assert.equal(findChatPlace(ps, { project: 'Work', folder: 'm+n' }).projectId, 'mn')
  assert.equal(findChatPlace(ps, { project: 'm+n' }).projectId, 'mn')
  assert.deepEqual(findChatPlace(ps, { project: 'Work', folder: 'Tickets' }), { projectId: null, newFolder: { name: 'Tickets', parentId: 'work' } })
  assert.throws(() => findChatPlace(ps, { project: 'Nope' }), /no project or folder called "Nope".*"Work" \(work\)/)
  assert.throws(() => findChatPlace(ps, { folder: 'x' }), /lives in a project/)
  assert.throws(() => findChatPlace(ps, { project: 'M+N', folder: 'x' }), /cannot hold folders/)
  assert.throws(() => findChatPlace([...ps, { id: 'w2', name: 'work' }], { project: 'Work' }), /2 projects are called/)
})

test('lists projects with their folders and chat counts', () => {
  const out = listChatPlaces(projects, [chat('a', { projectId: 'work' }), chat('b', { projectId: 'hiring' }), chat('c'), chat('d', { projectId: 'gone' }), { id: 'e', projectId: 'work', messages: [] }])
  assert.deepEqual(out, { home: { chats: 2 }, projects: [{ id: 'work', name: 'Work', chats: 1, folders: [{ id: 'hiring', name: 'Hiring', chats: 1 }] }] })
})
