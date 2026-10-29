// node --test chat/chat.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createThreadStore } from './store.mjs'
import { createUploadStore } from './uploads.mjs'
import { createChatRuns } from './runs.mjs'
import { planHistory, renderTranscript, attachmentBlock, applyEvent, finalizeMessage, fallbackTitle, failureText } from './turn.mjs'
import { parseToolName, describeMcpCall, humanizeTool, resultText, chatToolFromClaude } from './tools.mjs'
import { normalizeMessage } from './store.mjs'
import { parseTitleReply, cleanIcon, THREAD_ICONS } from './thread-icons.mjs'

const tmp = () => mkdtemp(join(tmpdir(), 'totem-chat-'))

test('a client PUT of an existing thread merges metadata and keeps server messages', async () => {
  const dir = await tmp()
  const store = createThreadStore({ dir })
  await store.update('t1', (t) => {
    t.messages.push({ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello', parts: [{ type: 'tool', id: 'a', title: 'Looked up tasks', status: 'done' }], provider: 'claude' })
  }, { create: { kind: 'regular' } })
  // A stale browser copy with fewer messages and a rename.
  const out = await store.put('t1', { messages: [{ role: 'user', content: 'hi' }], title: 'Renamed', provider: 'codex' })
  assert.equal(out.messages.length, 2)
  assert.equal(out.title, 'Renamed')
  assert.equal(out.provider, 'codex')
  assert.equal(out.messages[1].parts[0].title, 'Looked up tasks')
  assert.equal(out.messages[1].provider, 'claude')
  await rm(dir, { recursive: true, force: true })
})

test('totem members make a kept group chat, and a totem chat takes none', async () => {
  const dir = await tmp()
  const store = createThreadStore({ dir })
  const g = await store.put('g1', { kind: 'temporary', members: ['strava', 'strava', 'bad id'], messages: [] })
  assert.deepEqual(g.members, ['strava'])
  assert.equal(g.kind, 'regular')
  const cleared = await store.put('g1', { members: [] })
  assert.equal(cleared.members, undefined)
  const own = await store.put('totem-x', { totemId: 'x', members: ['y'], messages: [] })
  assert.equal(own.members, undefined)
  await rm(dir, { recursive: true, force: true })
})

test('a new thread from the client is taken whole, sessions excluded', async () => {
  const dir = await tmp()
  const store = createThreadStore({ dir })
  const out = await store.put('t2', { kind: 'temporary', messages: [{ role: 'user', content: 'x' }], sessions: { claude: { id: 'abc', through: 1 } } })
  assert.equal(out.kind, 'temporary')
  assert.ok(out.expiresAt > 0)
  assert.equal(out.messages.length, 1)
  assert.equal(out.sessions, undefined)
  await rm(dir, { recursive: true, force: true })
})

test('concurrent updates to one thread do not lose writes', async () => {
  const dir = await tmp()
  const store = createThreadStore({ dir })
  await store.update('t3', () => {}, { create: {} })
  await Promise.all(Array.from({ length: 10 }, (_, i) => store.update('t3', (t) => { t.messages.push({ role: 'user', content: String(i) }) })))
  assert.equal((await store.get('t3')).messages.length, 10)
  await rm(dir, { recursive: true, force: true })
})

test('planHistory resumes and replays only what the session missed', () => {
  const thread = {
    messages: [
      { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' }, { role: 'assistant', content: 'd' },
      { role: 'user', content: 'e' },
    ],
    sessions: { claude: { id: 's1', through: 2 } },
  }
  const resumed = planHistory(thread, 'claude', 4)
  assert.equal(resumed.resumeId, 's1')
  assert.deepEqual(resumed.replay.map((m) => m.content), ['c', 'd'])
  const fresh = planHistory(thread, 'codex', 4)
  assert.equal(fresh.resumeId, null)
  assert.equal(fresh.replay.length, 4)
})

test('renderTranscript keeps the newest turns under budget', () => {
  const msgs = Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message number ${i}` }))
  const out = renderTranscript(msgs, { budget: 200 })
  assert.match(out, /message number 49/)
  assert.doesNotMatch(out, /message number 0\b/)
})

test('a handoff transcript keeps the first message, lists steps and says what was left out', () => {
  const msgs = [
    { role: 'user', content: 'Plan the Chicago trip' },
    ...Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', content: `filler ${i} `.repeat(5) })),
    { role: 'user', content: 'Check the hotel' },
    {
      role: 'assistant', content: 'Booked it.', provider: 'codex',
      parts: [
        { type: 'tool', title: 'Ran a command', detail: 'curl hotel.example', status: 'done' },
        { type: 'tool', title: 'Edited file', detail: 'trip.md', status: 'error' },
      ],
    },
  ]
  let told = 0
  const out = renderTranscript(msgs, { budget: 600, tools: true, keepFirst: true, omitted: (n) => { told = n; return `(${n} left out)` } })
  assert.match(out, /^Conversation so far:\nOwner: Plan the Chicago trip\n\n\(…\)\n\n/)
  assert.match(out, /Booked it\.\n\[steps taken\]\n {2}- Ran a command — curl hotel\.example\n {2}- Edited file — trip\.md \(failed\)/)
  assert.ok(told > 0)
  assert.match(out, new RegExp(`\\(${told} left out\\)\\n\\n$`))
  assert.doesNotMatch(out, /filler 0 /)
  // Without the handoff options a reply's steps stay out, as before.
  assert.doesNotMatch(renderTranscript(msgs.slice(-2)), /steps taken/)
})

test('a reply that only ran tools still reaches a handoff', () => {
  const out = renderTranscript([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', parts: [{ type: 'tool', title: 'Ran a command', detail: 'ls', status: 'done' }] },
  ], { tools: true })
  assert.match(out, /Totem: \n\[steps taken\]\n {2}- Ran a command — ls/)
})

test('attachmentBlock lists paths and inlines pasted text', () => {
  const out = attachmentBlock([
    { name: 'a.png', kind: 'image', mime: 'image/png', size: 2048, path: '/x/a.png' },
    { name: 'Pasted text.txt', kind: 'text', mime: 'text/plain', size: 10, path: '/x/p.txt', text: 'hello world' },
  ])
  assert.match(out, /a\.png \(image, 2 KB\): \/x\/a\.png/)
  assert.match(out, /hello world/)
})

test('applyEvent builds ordered text and tool parts, and settles tools', () => {
  const msg = { role: 'assistant', content: '' }
  applyEvent(msg, { type: 'delta', text: 'Let me ' })
  applyEvent(msg, { type: 'delta', text: 'check.' })
  applyEvent(msg, { type: 'tool', tool: { id: 'x', phase: 'start', title: 'Looked up tasks' } })
  applyEvent(msg, { type: 'tool', tool: { id: 'x', phase: 'start', title: 'dup' } })
  applyEvent(msg, { type: 'tool', tool: { id: 'x', phase: 'end', status: 'done', output: '3 tasks' } })
  applyEvent(msg, { type: 'delta', text: 'You have 3.' })
  assert.equal(msg.parts.length, 3)
  assert.equal(msg.parts[1].status, 'done')
  assert.equal(msg.parts[1].output, '3 tasks')
  assert.equal(msg.content, 'Let me check.You have 3.')
  applyEvent(msg, { type: 'tool', tool: { id: 'y', phase: 'start', title: 'Ran a command' } })
  finalizeMessage(msg, { status: 'stopped', startedAt: Date.now() - 50 })
  assert.equal(msg.parts[3].status, 'done')
  assert.equal(msg.status, 'stopped')
})

test('finalizeMessage records a final reply that never streamed', () => {
  const msg = { role: 'assistant', content: '', parts: [] }
  finalizeMessage(msg, { status: 'done', finalText: 'All set.' })
  assert.equal(msg.content, 'All set.')
})

test('fallbackTitle cuts at a word', () => {
  assert.equal(fallbackTitle('what is on my calendar'), 'what is on my calendar')
  assert.ok(fallbackTitle('please look through every single one of my tasks and tell me which are overdue').endsWith('…'))
})

test('tool names from every CLI resolve to the gateway app', () => {
  assert.deepEqual(parseToolName('mcp__totem-gateway__tasks__get_tasks'), { server: 'totem-gateway', app: 'tasks', tool: 'get_tasks' })
  assert.equal(parseToolName('totem-gateway-google-calendar__list-events', 'totem-gateway').app, 'google-calendar')
  assert.equal(parseToolName('tasks__create_task', 'totem-gateway').tool, 'create_task')
  assert.equal(describeMcpCall({ name: 'google-calendar__get-freebusy', server: 'totem-gateway' }).title, 'Looked up availability')
  assert.equal(humanizeTool('create_task'), 'Added task')
  assert.equal(resultText({ success: { content: [{ text: { text: 'ok' } }] } }), 'ok')
})

test('uploads are signed per file and typed by content', async () => {
  const dir = await tmp()
  const up = createUploadStore({ dir, secret: 's3cret' })
  const img = await up.save({ buffer: Buffer.from('fake'), name: '', mime: 'image/png' })
  assert.equal(img.kind, 'image')
  assert.match(img.url, /\?sig=/)
  assert.ok(up.verify(img.id, new URL(img.url, 'http://x').searchParams.get('sig')))
  assert.ok(!up.verify(img.id, 'nope'))
  const meta = await up.meta(img.id)
  assert.ok(meta.path.endsWith('.png'))
  const txt = await up.save({ buffer: Buffer.from('a\nb'), name: 'Pasted text.txt', mime: 'text/plain', kind: 'text' })
  assert.equal(txt.kind, 'text')
  assert.equal(txt.preview, 'a b')
  await rm(dir, { recursive: true, force: true })
})

test('a run survives its viewer leaving and replays to a late one', async () => {
  const runs = createChatRuns()
  let release
  const gate = new Promise((r) => { release = r })
  runs.start('t', { id: 'r1', execute: async ({ emit }) => { emit({ type: 'delta', text: 'a' }); await gate; emit({ type: 'delta', text: 'b' }) } })
  const seen = []
  const off = runs.subscribe('t', 0, (e) => seen.push(e.type))
  off()
  assert.throws(() => runs.start('t', { id: 'r2', execute: async () => {} }), /already/)
  release()
  await new Promise((r) => setTimeout(r, 10))
  const late = []
  runs.subscribe('t', 1, (e) => late.push(e.type))
  assert.deepEqual(seen, ['delta'])
  assert.deepEqual(late, ['delta', 'end'])
})

test('stop aborts the run and reports stopped', async () => {
  const runs = createChatRuns()
  runs.start('t', { id: 'r', execute: ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', resolve)) })
  assert.ok(runs.stop('t'))
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(runs.get('t').status, 'stopped')
})

import { manualModelFor } from './route.mjs'

import { toRealtimeParameters } from './voice.mjs'

test('realtime tool schemas are flattened to a plain top-level object', () => {
  const p = toRealtimeParameters({ type: 'object', oneOf: [{ properties: { a: { type: 'string' } }, required: ['a', 'x'] }, { properties: { b: { type: 'number' } }, required: ['x'] }], properties: { x: { type: 'string' } } })
  assert.equal(p.oneOf, undefined)
  assert.deepEqual(Object.keys(p.properties).sort(), ['a', 'b', 'x'])
  assert.deepEqual(p.required, ['x'])
})

test('the title model picks a title and an icon from the list', () => {
  assert.deepEqual(parseTitleReply('Title: Plan Ohio Canal Ride\nIcon: bike'), { title: 'Plan Ohio Canal Ride', icon: 'bike' })
  assert.deepEqual(parseTitleReply('**Title:** "Split Dinner Bill"\n**Icon:** `receipt`'), { title: 'Split Dinner Bill', icon: 'receipt' })
  // A bare title, or an icon that isn't one of ours, still gives a usable title.
  assert.deepEqual(parseTitleReply('Fix Login Bug'), { title: 'Fix Login Bug', icon: '' })
  assert.deepEqual(parseTitleReply('Title: Fix Login Bug\nIcon: unicorn'), { title: 'Fix Login Bug', icon: '' })
  assert.equal(cleanIcon('IconToolsKitchen2'), '')
  assert.equal(cleanIcon('tools kitchen 2'), 'tools-kitchen-2')
  assert.equal(new Set(THREAD_ICONS).size, THREAD_ICONS.length)
})

test('a thread keeps its icon as metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vchat-icon-'))
  try {
    const store = createThreadStore({ dir })
    await store.put('t1', { title: 'Ride', messages: [] })
    await store.update('t1', (t) => { t.icon = 'bike' })
    assert.equal((await store.get('t1')).icon, 'bike')
    await store.put('t1', { icon: '../etc' })
    assert.equal((await store.get('t1')).icon, undefined)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a finished chat is summed up by its answer, not the narration before it', async () => {
  const { finalAnswer } = await import('./turn.mjs')
  const msg = { content: '', parts: [
    { type: 'text', text: "I'll look for Bushido's MCP and update the days." },
    { type: 'tool', id: 't1', title: 'Ran a command' },
    { type: 'text', text: 'Done: Tuesday is a travel day and Wednesday a rest day.' },
  ] }
  assert.equal(finalAnswer(msg), 'Done: Tuesday is a travel day and Wednesday a rest day.')
  assert.equal(finalAnswer({ content: 'Just an answer.', parts: [{ type: 'text', text: 'Just an answer.' }] }), 'Just an answer.')
})

test('a hand-picked model only runs on the account it was picked on', () => {
  // Same account: kept.
  assert.deepEqual(manualModelFor({ requested: 'codex', provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' }), { model: 'gpt-6.1-sol', effort: 'high' })
  // A temporary chat held to the default account: a Codex model means nothing on Cursor.
  assert.deepEqual(manualModelFor({ requested: 'codex', provider: 'cursor', model: 'gpt-6.1-sol', effort: 'high' }), { model: null, effort: null })
  // A request that names no account keeps its model, as before.
  assert.deepEqual(manualModelFor({ requested: '', provider: 'cursor', model: 'composer-2.5', effort: null }), { model: 'composer-2.5', effort: null })
})

test('failureText says a usage limit plainly and unwraps JSON error bodies', () => {
  assert.equal(
    failureText('exceeded retry limit, last status: 429 Too Many Requests', 'Codex'),
    'Codex hit its usage limit, so the reply stopped here. (exceeded retry limit, last status: 429 Too Many Requests)',
  )
  assert.equal(failureText('{"error":{"code":"model_not_found","message":"unknown provider for model x"}}', 'Codex'), 'unknown provider for model x')
  assert.equal(failureText('', 'Codex'), '')
  assert.equal(failureText('something broke'), 'something broke')
})

test('a claude.ai connector carries its own name and logo from tool_use_meta', () => {
  assert.deepEqual(parseToolName('mcp__claude_ai_Microsoft_365__outlook_email_search'), { server: 'Microsoft_365', app: 'microsoft_365', tool: 'outlook_email_search' })
  const block = { id: 'tu1', name: 'mcp__claude_ai_Microsoft_365__outlook_email_search', input: { query: 'invoice' } }
  const meta = { id: 'tu1', display_name: 'Search email', server_display_name: 'Microsoft 365', icon_url: 'https://claude.ai/connectors/m365.png' }
  const card = chatToolFromClaude(block, meta)
  assert.equal(card.title, 'Search email')
  assert.equal(card.app, 'Microsoft 365')
  assert.equal(card.logo, 'https://claude.ai/connectors/m365.png')
  assert.equal(card.server, 'microsoft_365')
  // Without meta the card still reads, from the tool's own name.
  assert.equal(chatToolFromClaude(block).title, humanizeTool('outlook_email_search'))
  // Totem's own gateway keeps its names; a non-https logo is dropped.
  const gw = chatToolFromClaude({ id: 'tu2', name: 'mcp__totem-gateway__tasks__get_tasks', input: {} }, { id: 'tu2', display_name: 'get_tasks', server_display_name: 'totem-gateway', icon_url: 'https://x/y.png' })
  assert.equal(gw.title, 'Looked up tasks')
  assert.equal(gw.app, undefined)
  assert.equal(chatToolFromClaude(block, { ...meta, icon_url: 'javascript:alert(1)' }).logo, undefined)
})

test('a tool part keeps its connector name and only an https logo', () => {
  const msg = { role: 'assistant', content: '', parts: [] }
  applyEvent(msg, { type: 'tool', tool: { id: 'x', phase: 'start', title: 'Search email', server: 'microsoft_365', app: 'Microsoft 365', logo: 'https://claude.ai/m365.png' } })
  assert.equal(msg.parts[0].app, 'Microsoft 365')
  const saved = normalizeMessage({ id: 'm1', role: 'assistant', content: '', parts: [msg.parts[0], { ...msg.parts[0], id: 'y', logo: 'http://evil/x.png' }] })
  assert.equal(saved.parts[0].logo, 'https://claude.ai/m365.png')
  assert.equal(saved.parts[1].logo, undefined)
})
