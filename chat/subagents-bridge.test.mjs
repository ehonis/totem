// Run with: node --test chat/subagents-bridge.test.mjs
//
// Sub-agents against a real bridge.mjs (chat/subagents.mjs, docs/chat.md → Agents panel).
// The Claude account runs a fake CLI that speaks Claude Code's stream-json: the reply
// starts a sub-agent in the background, ends its turn ("launched"), and the agent
// reports back later. Like `claude -p`, the fake stops the agent and exits when its
// input closes while the agent is still out, so the reply's answer is never written.
//
// Checks what only the bridge decides: the input stays open until the agent wakes
// the reply, and a client asking for `agents=brief` gets each agent as a row (no
// steps) on the window and the stream, with its log read on its own.
//
// The bridge runs from a shadow checkout (a temp dir of symlinks to this repo with
// its own empty data/), on its own port, with no scheduler, and is stopped at the end.

import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { connect, createServer } from 'node:net'
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const SECRET = 'subagents-bridge-test-secret'

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

// Claude Code 2.1.332's events for a background Agent call, trimmed to what the bridge reads.
const FAKE_CLAUDE = `#!/usr/bin/env node
const out = (e) => process.stdout.write(JSON.stringify({ session_id: 'sess-sub', ...e }) + '\\n')
let closed = false
let started = false
const rl = require('node:readline').createInterface({ input: process.stdin })
rl.on('close', () => { closed = true })
const AGENT = 'toolu_bg1'
let n = 0
const sub = (content) => out({ type: 'assistant', parent_tool_use_id: AGENT, uuid: 'sub-' + (++n), message: { content } })
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.type !== 'user' || started) return
  started = true
  out({ type: 'user', message: msg.message })
  out({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' })
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: AGENT, name: 'Agent', input: { description: 'Find deals', prompt: 'Look for deals on the list.', subagent_type: 'general-purpose', run_in_background: true } }] } })
  out({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: AGENT, content: 'Async agent launched successfully.' }] }, tool_use_result: { isAsync: true, status: 'async_launched' } })
  out({ type: 'system', subtype: 'task_started', tool_use_id: AGENT, description: 'Find deals' })
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Searching now; a table once it reports back.' }] } })
  out({ type: 'result', subtype: 'success', result: 'Searching now; a table once it reports back.' })
  for (let i = 0; i < 5; i++) sub([{ type: 'text', text: 'Checking shop ' + i }])
  sub([{ type: 'tool_use', id: 'toolu_s1', name: 'WebSearch', input: { query: 'deals' } }])
  // A report that never comes: the run's own clock is what ends it.
  if (JSON.stringify(msg).includes('lose the report')) return
  // The CLI dies with the agent still out.
  if (JSON.stringify(msg).includes('crash')) process.exit(1)
  setTimeout(() => {
    if (closed) {
      // What claude -p does when its input is gone: background tasks stopped, then exit.
      out({ type: 'system', subtype: 'task_notification', tool_use_id: AGENT, status: 'stopped', summary: 'Find deals' })
      process.exit(0)
    }
    out({ type: 'system', subtype: 'task_notification', tool_use_id: AGENT, status: 'completed', summary: 'Found three deals.' })
    out({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' })
    out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Here is the table of deals.' }] } })
    out({ type: 'result', subtype: 'success', result: 'Here is the table of deals.' })
    const quit = setInterval(() => { if (closed) { clearInterval(quit); process.exit(0) } }, 20)
  }, 1500)
})
setTimeout(() => process.exit(3), 30000)
`

const B = {}
const bearer = { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }
const call = async (method, path, body) => {
  const r = await fetch(`${B.base}${path}`, { method, headers: bearer, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  assert.ok(r.ok, `${method} ${path} ${r.status} ${text}`)
  return text
}
const events = (text) => text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)))
const chat = async (body) => events(await call('POST', '/api/chat', { provider: 'claude', ...body }))

before(async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'totem-subagents-bridge-')))
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
  writeFileSync(join(root, 'data', 'provider-config.json'), JSON.stringify({
    defaultProvider: 'claude', enabledProviders: ['claude'],
    instances: { claude: { driver: 'claude', config: { binaryPath: fake } } },
  }))

  const port = await freePort()
  B.base = `http://127.0.0.1:${port}`
  let output = ''
  const child = spawn(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', join(root, 'bridge.mjs')], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: join(root, 'home'), BRIDGE_PORT: String(port), BRIDGE_SECRET: SECRET, BRIDGE_NO_SCHEDULER: '1', AGENT_CWD: root, CHAT_TIMEOUT_MS: '8000', CHAT_TASK_TIMEOUT_MS: '8000' },
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

test('a background sub-agent wakes the reply: the input stays open until it reports back', async () => {
  const id = 'sub-wake'
  const stream = await chat({ threadId: id, text: 'find me deals', agents: 'brief' })
  const t = JSON.parse(await call('GET', `/api/threads/${id}?turns=10`))
  const reply = t.messages[1]
  assert.equal(reply.status, 'done', B.output())
  assert.match(reply.content, /Here is the table of deals\./, 'the turn the agent woke is part of the reply')
  const part = reply.parts.find((p) => p.type === 'tool' && p.agent)
  assert.equal(part.agent.status, 'done', 'the agent finished rather than being stopped with the CLI')
  assert.equal(part.agent.summary, 'Found three deals.')
  assert.ok(part.agent.steps.length >= 6, 'the stored reply keeps the whole log')

  // The brief stream: rows, never steps.
  const agentEvents = stream.filter((e) => e.type === 'agent')
  assert.ok(agentEvents.length >= 6)
  assert.ok(agentEvents.every((e) => !('step' in e) && !('brief' in e)), 'no step reaches a brief viewer')
  const last = agentEvents.filter((e) => e.agent?.stepCount).pop()
  assert.ok(last.agent.stepCount >= 6)
  assert.ok(last.agent.now, 'what it is doing now, in a line')
  const done = stream.find((e) => e.type === 'done')
  const doneAgent = done.message.parts.find((p) => p.agent).agent
  assert.equal(doneAgent.brief, true)
  assert.ok(!doneAgent.steps)
})

test('agents=brief windows carry rows; the log is read on its own', async () => {
  const id = 'sub-wake'
  const brief = JSON.parse(await call('GET', `/api/threads/${id}?turns=10&agents=brief`))
  const agent = brief.messages[1].parts.find((p) => p.agent).agent
  assert.equal(agent.brief, true)
  assert.equal(agent.steps, undefined)
  assert.ok(agent.stepCount >= 6)
  assert.equal(agent.title, 'Find deals')
  assert.equal(agent.summary, 'Found three deals.')

  const full = JSON.parse(await call('GET', `/api/threads/${id}?turns=10`))
  assert.ok(full.messages[1].parts.find((p) => p.agent).agent.steps.length >= 6, 'a client that does not ask gets the whole log as before')

  const log = JSON.parse(await call('GET', `/api/threads/${id}/agents/toolu_bg1`))
  assert.equal(log.messageId, full.messages[1].id)
  assert.equal(log.live, false)
  assert.equal(log.agent.steps.length, agent.stepCount)
  assert.equal(log.agent.prompt, 'Look for deals on the list.')

  const missing = await fetch(`${B.base}/api/threads/${id}/agents/toolu_nope`, { headers: bearer })
  assert.equal(missing.status, 404)
})

test('a brief re-attach replays an agent\'s latest step, not every step', async () => {
  const id = 'sub-wake'
  const replay = async (q) => events(await call('GET', `/api/chat/runs/${id}/stream?since=0${q}`)).filter((e) => e.type === 'agent')
  const full = await replay('')
  const brief = await replay('&agents=brief')
  assert.ok(full.filter((e) => e.step).length >= 6, 'the full replay has every step')
  assert.ok(brief.length < full.length, `brief ${brief.length} < full ${full.length}`)
  assert.ok(brief.every((e) => !('step' in e)))
  assert.ok(brief.at(-1).agent.stepCount >= 6, 'the facts are the reply as it stands')
  // A replayed start is the reply as it was at the start, not the parts it has since grown.
  const start = events(await call('GET', `/api/chat/runs/${id}/stream?since=0&agents=brief`)).find((e) => e.type === 'start')
  assert.deepEqual(start.assistantMessage.parts, [])
})

test('a run that times out with its sub-agent still out is an error, the agent stopped', async () => {
  const id = 'sub-lost'
  const stream = await chat({ threadId: id, text: 'find deals, and lose the report', agents: 'brief' })
  const done = stream.find((e) => e.type === 'done')
  assert.equal(done.message.status, 'error', B.output())
  assert.match(done.message.error, /ran out of time after .* while a sub-agent was still working/)
  const t = JSON.parse(await call('GET', `/api/threads/${id}?turns=10`))
  const agent = t.messages[1].parts.find((p) => p.agent).agent
  assert.equal(agent.status, 'stopped', 'cut off, not "completed"')
})

test('a CLI that dies with its sub-agent still out leaves an error, not a finished reply', async () => {
  const id = 'sub-crash'
  const stream = await chat({ threadId: id, text: 'find deals, then crash', agents: 'brief' })
  const done = stream.find((e) => e.type === 'done')
  assert.equal(done.message.status, 'error', B.output())
  assert.match(done.message.error, /exited while a sub-agent was still working/)
  const t = JSON.parse(await call('GET', `/api/threads/${id}?turns=10`))
  assert.equal(t.messages[1].parts.find((p) => p.agent).agent.status, 'stopped')
})
