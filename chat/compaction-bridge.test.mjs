// Run with: node --test chat/compaction-bridge.test.mjs
//
// Compaction against a real bridge.mjs (chat/context.mjs, docs/chat.md → Context
// window and compaction). The Claude account runs a fake CLI that prints Claude
// Code's stream-json: a reply reports its usage, `/compact` reports a compaction.
// Checks what only the bridge decides: the reading saved on the reply, a
// `/compact` turn resuming the session and keeping it hidden housekeeping, and
// Compact and send putting the message, files and all, right behind it.
//
// The bridge runs from a shadow checkout (a temp dir of symlinks to this repo with
// its own empty data/), on its own port, with no scheduler, and is stopped at the end.

import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { connect, createServer } from 'node:net'
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const SECRET = 'compaction-bridge-test-secret'

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

// Claude Code 2.1.325's events, trimmed to what the bridge reads.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const prompt = args[args.indexOf('--') + 1] || ''
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, prompt }) + '\\n')
const out = (e) => process.stdout.write(JSON.stringify({ session_id: 'sess-1', ...e }) + '\\n')
out({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' })
if (prompt.startsWith('/compact')) {
  out({ type: 'system', subtype: 'status', status: 'compacting' })
  out({ type: 'system', subtype: 'status', status: 'compacting' })
  out({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 251010, post_tokens: 30000 } })
  out({ type: 'system', subtype: 'status', status: null, compact_result: 'success' })
  out({ type: 'result', subtype: 'success', result: '', local_command: 'compact', usage: { input_tokens: 4, output_tokens: 900 } })
} else {
  out({ type: 'stream_event', event: { type: 'message_start' } })
  const usage = { input_tokens: 1000, cache_creation_input_tokens: 250000, cache_read_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 250000, ephemeral_5m_input_tokens: 0 }, output_tokens: 10 }
  out({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], usage } })
  out({ type: 'result', subtype: 'success', result: 'ok', usage, modelUsage: { 'claude-opus-5-5': { contextWindow: 1000000 } } })
}
`

const B = {}
const bearer = { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }
const call = async (method, path, body) => {
  const r = await fetch(`${B.base}${path}`, { method, headers: bearer, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  assert.ok(r.ok, `${method} ${path} ${r.status} ${text}`)
  return text
}
const chat = async (body) => {
  const text = await call('POST', '/api/chat', { provider: 'claude', ...body })
  return text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)))
}
const thread = async (id) => {
  const r = JSON.parse(await call('GET', `/api/threads/${id}?turns=50`))
  return r.thread || r
}
const until = async (fn, ms = 15_000) => {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await wait(100)
  }
}
const invocations = () => readFileSync(B.log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

before(async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'totem-compaction-bridge-')))
  for (const entry of readdirSync(REPO)) {
    if (entry === 'data' || entry === '.env' || entry === '.git' || entry === 'AGENTS.local.md') continue
    symlinkSync(join(REPO, entry), join(root, entry))
  }
  B.root = root
  mkdirSync(join(root, 'data'), { recursive: true })
  mkdirSync(join(root, 'home'))
  writeFileSync(join(root, 'data', 'auth.json'), '{}')
  const fake = join(root, 'home', 'fake-claude.cjs')
  writeFileSync(fake, FAKE_CLAUDE)
  chmodSync(fake, 0o755)
  B.log = join(root, 'home', 'fake-claude.log')
  writeFileSync(B.log, '')
  writeFileSync(join(root, 'data', 'provider-config.json'), JSON.stringify({
    defaultProvider: 'claude', enabledProviders: ['claude'],
    instances: { claude: { driver: 'claude', config: { binaryPath: fake } } },
  }))

  const port = await freePort()
  B.base = `http://127.0.0.1:${port}`
  let output = ''
  const child = spawn(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', join(root, 'bridge.mjs')], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: join(root, 'home'), BRIDGE_PORT: String(port), BRIDGE_SECRET: SECRET, BRIDGE_NO_SCHEDULER: '1', AGENT_CWD: root, FAKE_CLAUDE_LOG: B.log },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => { output += d })
  child.stderr.on('data', (d) => { output += d })
  B.output = () => output
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

test('a reply keeps how full the context is, and /compact compacts its session as a hidden turn', async () => {
  const id = 'ctx-manual'
  const first = await chat({ threadId: id, text: 'hello' })
  const reading = first.filter((e) => e.type === 'context').pop()?.context
  assert.equal(reading.used, 251010)
  assert.equal(reading.max, 1_000_000)
  assert.equal(reading.cacheTtlMs, 3_600_000)

  await call('PUT', `/api/threads/${id}`, { needsReply: false })
  const events = await chat({ threadId: id, text: '/compact' })
  const compactions = events.filter((e) => e.type === 'compaction')
  assert.deepEqual([...new Set(compactions.map((e) => e.compaction.id))].length, 1, 'one divider, however often Claude says it is compacting')

  const t = await thread(id)
  const [, , ask, reply] = t.messages
  assert.equal(ask.command, 'compact')
  const part = reply.parts.find((p) => p.type === 'compaction')
  assert.equal(part.status, 'done')
  assert.equal(part.trigger, 'manual')
  assert.equal(part.before, 251010)
  assert.equal(part.after, 30000)
  assert.equal(reply.context.used, 30000)
  assert.equal(reply.status, 'done')
  assert.deepEqual(t.sessions.claude, { id: 'sess-1', through: 4 })

  const compactRun = invocations().find((i) => i.prompt === '/compact')
  assert.ok(compactRun, 'the CLI was handed /compact as the whole prompt')
  assert.equal(compactRun.args[compactRun.args.indexOf('--resume') + 1], 'sess-1')
})

test('Compact and send compacts first, then sends the message with its files', async () => {
  const id = 'ctx-onreturn'
  await chat({ threadId: id, text: 'hello' })
  const up = JSON.parse(await (await fetch(`${B.base}/api/chat/uploads?name=notes.txt&mime=text/plain`, { method: 'POST', headers: { authorization: `Bearer ${SECRET}` }, body: 'the notes' })).text())
  const events = await chat({ threadId: id, text: 'carry on', attachments: [up.id], compactFirst: true })
  const queued = events.find((e) => e.type === 'queue')?.queue?.[0]
  assert.equal(queued.text, 'carry on')
  assert.equal(queued.attachments?.[0]?.id, up.id, 'the files wait with the words')

  const t = await until(async () => { const x = await thread(id); return x.messages.length === 6 && x.messages[5].status === 'done' ? x : null })
  const [, , ask, compacted, sent, answer] = t.messages
  assert.equal(ask.command, 'compact')
  assert.equal(compacted.parts.find((p) => p.type === 'compaction').trigger, 'onReturn')
  assert.equal(sent.content, 'carry on')
  assert.equal(sent.attachments?.[0]?.id, up.id)
  assert.equal(answer.content, 'ok')
  assert.ok(!t.queue?.length)
})

test('/compact on a chat with no session says so instead of running anything', async () => {
  const before = invocations().length
  await chat({ threadId: 'ctx-empty', text: '/compact' })
  const t = await thread('ctx-empty')
  const part = t.messages[1].parts.find((p) => p.type === 'compaction')
  assert.equal(part.status, 'failed')
  assert.equal(part.reason, 'Not enough messages to compact.')
  assert.equal(invocations().length, before)
})
