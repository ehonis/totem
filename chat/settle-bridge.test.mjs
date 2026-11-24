// Run with: node --test chat/settle-bridge.test.mjs
//
// Writing in a settled or snoozed chat brings it back, however the words arrive
// (chat/store.mjs wakeOnOwnerMessage), checked against a real bridge.mjs. The
// Claude account is a fake CLI whose reply holds until the test lets it finish.
//
// The bridge runs from a shadow checkout (a temp dir of symlinks to this repo with
// its own data/: a sign-in file, the fake account, and chat titles off, so no real
// `claude` is started to name a chat), on its own port, with no scheduler, and is
// stopped at the end.

import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { connect, createServer } from 'node:net'
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const SECRET = 'settle-bridge-test-secret'

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

// Claude Code's stream-json, trimmed to what the bridge reads; the reply waits
// for a file named after the prompt, so a test can steer and queue while it runs.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const prompt = args[args.indexOf('--') + 1] || ''
const out = (e) => process.stdout.write(JSON.stringify({ session_id: 'sess-1', ...e }) + '\\n')
out({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' })
const release = path.join(process.env.FAKE_RELEASE_DIR, prompt.replace(/[^a-z0-9-]/gi, '_'))
const finish = () => {
  out({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 1 } } })
  out({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 10, output_tokens: 1 } })
  process.exit(0)
}
if (!prompt.startsWith('hold')) finish()
else setInterval(() => { if (fs.existsSync(release)) finish() }, 50)
process.stdin.resume()
`

const B = {}
const bearer = { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }
const call = async (method, path, body) => {
  const r = await fetch(`${B.base}${path}`, { method, headers: bearer, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  assert.ok(r.ok, `${method} ${path} ${r.status} ${text}`)
  return text ? JSON.parse(text.startsWith('data: ') ? 'null' : text) : null
}
const thread = async (id) => {
  const r = await call('GET', `/api/threads/${id}?turns=50`)
  return r.thread || r
}
const until = async (fn, ms = 15_000) => {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timed out waiting\n${B.output()}`)
    await wait(50)
  }
}

const drain = async (reader) => { while (!(await reader.read()).done); }

/** Resolves once the bridge has started the reply; it holds until `release`. */
async function startHeldReply(id, prompt) {
  const r = await fetch(`${B.base}/api/chat`, { method: 'POST', headers: bearer, body: JSON.stringify({ provider: 'claude', threadId: id, text: prompt }) })
  assert.ok(r.ok, `POST /api/chat ${r.status}`)
  const reader = r.body.getReader()
  let seen = ''
  while (!seen.includes('"type":"start"')) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`the reply ended before it started\n${seen}`)
    seen += new TextDecoder().decode(value)
  }
  return {
    release: async () => {
      writeFileSync(join(B.releases, prompt.replace(/[^a-z0-9-]/gi, '_')), '')
      await drain(reader)
    },
  }
}

const SHELVED = ['settledOverride', 'settledAt', 'snoozedUntil', 'snoozedAt']
const shelved = (t) => Object.fromEntries(SHELVED.filter((k) => k in t).map((k) => [k, t[k]]))

before(async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'totem-settle-bridge-')))
  for (const entry of readdirSync(REPO)) {
    if (entry === 'data' || entry === '.env' || entry === '.git' || entry === 'AGENTS.local.md') continue
    symlinkSync(join(REPO, entry), join(root, entry))
  }
  B.root = root
  mkdirSync(join(root, 'data'), { recursive: true })
  mkdirSync(join(root, 'home'))
  B.releases = join(root, 'home', 'releases')
  mkdirSync(B.releases)
  writeFileSync(join(root, 'data', 'auth.json'), '{}')
  writeFileSync(join(root, 'data', 'chat-settings.json'), JSON.stringify({ titles: { off: true } }))
  const fake = join(root, 'home', 'fake-claude.cjs')
  writeFileSync(fake, FAKE_CLAUDE)
  chmodSync(fake, 0o755)
  writeFileSync(join(root, 'data', 'provider-config.json'), JSON.stringify({
    defaultProvider: 'claude', enabledProviders: ['claude'],
    instances: { claude: { driver: 'claude', config: { binaryPath: fake } } },
  }))

  const port = await freePort()
  B.base = `http://127.0.0.1:${port}`
  let output = ''
  const child = spawn(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', join(root, 'bridge.mjs')], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: join(root, 'home'), BRIDGE_PORT: String(port), BRIDGE_SECRET: SECRET, BRIDGE_NO_SCHEDULER: '1', AGENT_CWD: root, FAKE_RELEASE_DIR: B.releases },
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

test('a follow-up queued behind the reply brings a settled chat back', async () => {
  const id = 'settle-queue'
  const reply = await startHeldReply(id, 'hold-queue')
  const at = Date.now()
  await call('PUT', `/api/threads/${id}`, { settledOverride: 'settled', settledAt: at })
  assert.equal((await thread(id)).settledOverride, 'settled')

  await call('POST', '/api/chat/queue', { threadId: id, action: 'add', text: 'and then this' })
  const t = await thread(id)
  assert.deepEqual(shelved(t), {}, 'off the shelf as soon as it is queued')
  assert.ok(t.unsettledAt >= at, 'and at the top of the list')
  assert.equal(t.queue?.[0]?.text, 'and then this')
  await reply.release()
})

test('a steer into the running reply wakes a snoozed chat and drops its timer', async () => {
  const id = 'settle-steer'
  const reply = await startHeldReply(id, 'hold-steer')
  const at = Date.now()
  await call('PUT', `/api/threads/${id}`, { snoozedUntil: at + 86_400_000, snoozedAt: at })
  assert.equal((await thread(id)).snoozedUntil, at + 86_400_000)

  await call('POST', '/api/chat/steer', { threadId: id, text: 'actually, do this' })
  const t = await thread(id)
  assert.deepEqual(shelved(t), {}, 'awake before the steer is answered, with no timer left to run out')
  assert.ok(t.unsettledAt >= at)
  await reply.release()
})

test('a queued follow-up sent as a steer wakes a snoozed chat', async () => {
  const id = 'settle-queue-steer'
  const reply = await startHeldReply(id, 'hold-queue-steer')
  const { queue } = await call('POST', '/api/chat/queue', { threadId: id, action: 'add', text: 'this instead' })
  const at = Date.now()
  await call('PUT', `/api/threads/${id}`, { snoozedUntil: at + 86_400_000, snoozedAt: at })

  await call('POST', '/api/chat/queue', { threadId: id, action: 'steer', id: queue[0].id })
  const t = await thread(id)
  assert.deepEqual(shelved(t), {})
  assert.ok(!t.queue?.length, 'it went into the reply')
  await reply.release()
})

test('a new message in a settled and snoozed chat brings it back to the top', async () => {
  const id = 'settle-send'
  const first = await startHeldReply(id, 'hold-send')
  await first.release()
  const at = Date.now()
  await call('PUT', `/api/threads/${id}`, { snoozedUntil: at + 86_400_000, snoozedAt: at, settledOverride: 'settled', settledAt: at })
  const second = await startHeldReply(id, 'hold-send-2')
  const t = await thread(id)
  assert.deepEqual(shelved(t), {})
  assert.ok(t.unsettledAt >= at)
  await second.release()
})

test('a voice turn wakes a snoozed chat; a turn with nothing he said does not', async () => {
  const id = 'settle-voice'
  const at = Date.now()
  await call('POST', '/api/voice/turns', { threadId: id, turns: [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'hi' }] })
  await call('PUT', `/api/threads/${id}`, { snoozedUntil: at + 86_400_000, snoozedAt: at })

  await call('POST', '/api/voice/turns', { threadId: id, turns: [{ role: 'user', text: '  ' }, { role: 'assistant', text: 'still here' }] })
  assert.equal((await thread(id)).snoozedUntil, at + 86_400_000, 'the agent talking alone wakes nothing')

  await call('POST', '/api/voice/turns', { threadId: id, turns: [{ role: 'user', text: 'one more thing' }, { role: 'assistant', text: 'sure' }] })
  const t = await thread(id)
  assert.deepEqual(shelved(t), {})
  assert.ok(t.unsettledAt >= at)
})
