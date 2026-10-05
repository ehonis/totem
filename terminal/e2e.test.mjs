/**
 * Integration test for the web terminal: a real bridge process, a real WebSocket,
 * a real PTY, and the real activity log.
 *
 * Opt-in — `npm test` skips it unless TERMINAL_E2E=1, because it boots a server,
 * compiles nothing but does need node-pty to have built, and spawns actual shells.
 * Run it with:
 *
 *     TERMINAL_E2E=1 node --test terminal/e2e.test.mjs
 *
 * It earns its keep: the "counted but never labeled" guarantee for secrets is the
 * kind of property the unit tests can only check against my assumptions about what
 * a prompt looks like. This one drove a real shell and caught the flag being
 * cleared by a prompt's own echo, which every unit test had happily agreed was fine.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const SECRET = 'terminal-e2e-secret'
const enabled = process.env.TERMINAL_E2E === '1'

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer()
    server.listen(0, () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const bearer = () => `totem.bearer.${Buffer.from(SECRET).toString('base64url')}`

/** Boot a bridge with the terminal on, in its own temp dir, and wait for readiness. */
async function startBridge() {
  const dir = mkdtempSync(join(tmpdir(), 'totem-term-e2e-'))
  const port = await freePort()
  const activityLog = join(dir, 'activity.jsonl')
  const envPath = join(dir, 'env')
  writeFileSync(envPath, [
    `BRIDGE_SECRET=${SECRET}`,
    `BRIDGE_PORT=${port}`,
    'TERMINAL_ENABLED=true',
    'TERMINAL_MAX_SESSIONS=3',
    'MORNING_BRIEFING_ENABLED=false',
    'JOURNAL_INGEST_ENABLED=false',
    'PLAUD_MEETINGS_INGEST_ENABLED=false',
    'WEATHER_ENABLED=false',
    'NEWS_ENABLED=false',
    `PRODUCTIVITY_ACTIVITY_LOG=${activityLog}`,
    `JOBS_FILE=${join(dir, 'jobs.json')}`,
    `THREADS_DIR=${join(dir, 'threads')}`,
    '',
  ].join('\n'))

  const child = spawn(process.execPath, ['--env-file', envPath, 'bridge.mjs'], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (d) => { output += d })
  child.stderr.on('data', (d) => { output += d })

  const deadline = Date.now() + 20_000
  while (Date.now() < deadline && !/terminal panel enabled/.test(output)) {
    if (child.exitCode !== null) throw new Error(`bridge exited early:\n${output}`)
    await wait(200)
  }
  if (!/terminal panel enabled/.test(output)) throw new Error(`bridge never came up:\n${output}`)

  return {
    port,
    activityLog,
    output: () => output,
    stop: () => new Promise((resolve) => {
      child.once('exit', resolve)
      child.kill('SIGTERM')
      setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3000)
    }),
  }
}

/** Open an authenticated socket that records every message it receives. */
async function openSocket(port, { authorized = true } = {}) {
  const secretProtocol = authorized
    ? bearer()
    : `totem.bearer.${Buffer.from('wrong-secret').toString('base64url')}`
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/ws`, ['totem.terminal.v1', secretProtocol])
  const messages = []
  ws.on('message', (raw) => { try { messages.push(JSON.parse(String(raw))) } catch { /* ignore */ } })

  const opened = await new Promise((resolve) => {
    ws.once('open', () => resolve(true))
    ws.once('error', () => resolve(false))
  })
  return {
    ws,
    opened,
    messages,
    send: (message) => ws.send(JSON.stringify(message)),
    find: (t) => messages.find((m) => m.t === t),
    all: (t) => messages.filter((m) => m.t === t),
    text: () => messages.filter((m) => m.t === 'data').map((m) => m.data).join(''),
    close: () => ws.close(),
  }
}

test('web terminal end to end', { skip: enabled ? false : 'set TERMINAL_E2E=1 to run' }, async (t) => {
  const bridge = await startBridge()
  t.after(() => bridge.stop())

  await t.test('rejects a handshake with the wrong secret', async () => {
    const socket = await openSocket(bridge.port, { authorized: false })
    assert.equal(socket.opened, false)
  })

  const socket = await openSocket(bridge.port)
  assert.equal(socket.opened, true, 'authorized handshake should be accepted')
  await wait(300)

  let sessionId = null

  await t.test('opens a real PTY and streams its output back', async () => {
    socket.send({ t: 'open', cols: 90, rows: 30 })
    await wait(2500)
    const opened = socket.find('opened')
    assert.ok(opened, 'expected an opened message')
    sessionId = opened.session.id
    assert.ok(opened.session.pid, 'session should report a pid')

    socket.send({ t: 'input', id: sessionId, data: 'echo E2E_$((6*7))\r' })
    await wait(1200)
    assert.match(socket.text(), /E2E_42/)

    socket.send({ t: 'input', id: sessionId, data: 'tty\r' })
    await wait(1200)
    assert.match(socket.text(), /\/dev\/pts\/\d+/, 'should be a real tty, not a pipe')
  })

  await t.test('a second socket reattaches and gets the scrollback replayed', async () => {
    const other = await openSocket(bridge.port)
    other.send({ t: 'attach', id: sessionId, cols: 90, rows: 30 })
    await wait(1200)
    const attached = other.find('attached')
    assert.ok(attached, 'expected an attached message')
    assert.match(attached.replay, /E2E_42/, 'replay should include earlier output')
    other.close()
  })

  await t.test('attaching twice on one socket resyncs instead of erroring', async () => {
    // Regression: `open` attaches the opener, and the client's pane attaches again
    // once it mounts. Treating that as an error put an "already attached" banner on
    // every new terminal.
    const before = socket.all('error').length
    socket.send({ t: 'attach', id: sessionId, cols: 90, rows: 30 })
    await wait(900)
    assert.equal(socket.all('error').length, before, 'a repeat attach must not error')
    assert.ok(socket.all('attached').length >= 2, 'it should re-send the session state')
  })

  await t.test('refuses input for a session the socket never attached to', async () => {
    const stranger = await openSocket(bridge.port)
    await wait(300)
    stranger.send({ t: 'input', id: sessionId, data: 'echo HIJACKED\r' })
    await wait(900)
    assert.ok(stranger.all('error').some((e) => /not attached/.test(e.message)))
    assert.doesNotMatch(socket.text(), /HIJACKED/)
    stranger.close()
  })

  await t.test('enforces the session cap and tells the client why', async () => {
    for (let i = 0; i < 5; i++) socket.send({ t: 'open', cols: 80, rows: 24 })
    await wait(3000)
    assert.equal(socket.all('opened').length, 3, 'cap is 3 including the first session')
    assert.ok(socket.all('error').some((e) => /limit reached/.test(e.message)))
  })

  await t.test('counts commands, and never writes a secret into the activity log', async () => {
    // `read -p` echoes what you type, which is the case that broke the first
    // implementation of the password guard.
    socket.send({ t: 'input', id: sessionId, data: 'read -p "Enter API token: " TOK\r' })
    await wait(1000)
    socket.send({ t: 'input', id: sessionId, data: 'hunter2-never-log-me\r' })
    await wait(1000)
    // An inline credential on an otherwise ordinary command must be scrubbed.
    socket.send({ t: 'input', id: sessionId, data: 'MY_API_TOKEN=abcdef123456 true\r' })
    await wait(1200)

    assert.ok(existsSync(bridge.activityLog), 'activity log should exist')
    const events = readFileSync(bridge.activityLog, 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const commands = events.filter((e) => e.kind === 'terminal.command')

    assert.ok(commands.length >= 4, `expected several commands, got ${commands.length}`)
    assert.ok(commands.some((c) => c.label === 'echo E2E_$((6*7))'), 'ordinary commands are labeled')

    const labels = commands.map((c) => c.label).join('\n')
    assert.doesNotMatch(labels, /hunter2-never-log-me/, 'the secret must never be labeled')
    assert.doesNotMatch(labels, /abcdef123456/, 'inline credentials must be redacted')
    assert.ok(
      commands.some((c) => c.label === ''),
      'the secret submission is still counted, just unlabeled',
    )
  })

  socket.close()
})
