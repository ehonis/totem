import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTerminalSessions, buildSessionEnv, readEnvFileKeys } from './sessions.mjs'

/** A stand-in for node-pty that records what it was told and can be driven by hand. */
function makeFakePty() {
  const spawned = []
  function spawnPty(shell, args, opts) {
    const pty = {
      pid: 1000 + spawned.length,
      shell,
      args,
      opts,
      written: [],
      resized: [],
      killed: false,
      dataHandlers: [],
      exitHandlers: [],
      write(data) { this.written.push(data) },
      resize(cols, rows) { this.resized.push([cols, rows]) },
      kill() { this.killed = true },
      onData(fn) { this.dataHandlers.push(fn) },
      onExit(fn) { this.exitHandlers.push(fn) },
      emitData(data) { for (const fn of this.dataHandlers) fn(data) },
      emitExit(exitCode, signal = null) { for (const fn of this.exitHandlers) fn({ exitCode, signal }) },
    }
    spawned.push(pty)
    return pty
  }
  return { spawnPty, spawned, last: () => spawned[spawned.length - 1] }
}

function setup(overrides = {}) {
  const fake = makeFakePty()
  const commands = []
  const manager = createTerminalSessions({
    spawnPty: fake.spawnPty,
    shell: '/bin/bash',
    cwd: '/home/user',
    env: { PATH: '/usr/bin', HOME: '/home/user' },
    onCommand: (session, command) => commands.push({ session, command }),
    ...overrides,
  })
  return { manager, fake, commands }
}

test('open spawns a login shell in the configured cwd', () => {
  const { manager, fake } = setup()
  const session = manager.open({ cols: 100, rows: 30 })

  assert.equal(fake.spawned.length, 1)
  assert.equal(fake.last().shell, '/bin/bash')
  assert.deepEqual(fake.last().args, ['-l'])
  assert.equal(fake.last().opts.cwd, '/home/user')
  assert.equal(fake.last().opts.cols, 100)
  assert.equal(session.pid, 1000)
  assert.equal(session.exited, false)
})

test('rejects absurd dimensions instead of passing them to the pty', () => {
  const { manager, fake } = setup()
  manager.open({ cols: 0, rows: -5 })
  assert.equal(fake.last().opts.cols, 80)
  assert.equal(fake.last().opts.rows, 24)

  manager.open({ cols: 99999, rows: 99999 })
  assert.equal(fake.last().opts.cols, 500)
  assert.equal(fake.last().opts.rows, 200)
})

test('enforces the session cap but frees a slot when one exits', () => {
  const { manager, fake } = setup({ maxSessions: 2 })
  manager.open()
  manager.open()
  assert.throws(() => manager.open(), /session limit reached \(2\)/)

  fake.spawned[0].emitExit(0)
  assert.doesNotThrow(() => manager.open())
})

test('attach replays the buffer and then streams live output', () => {
  const { manager, fake } = setup()
  const { id } = manager.open()
  fake.last().emitData('before attach\r\n')

  const events = []
  const attached = manager.attach(id, (e) => events.push(e))
  assert.equal(attached.replay, 'before attach\r\n')
  assert.equal(attached.truncated, false)

  fake.last().emitData('after attach\r\n')
  assert.deepEqual(events, [{ type: 'data', id, data: 'after attach\r\n' }])

  attached.detach()
  fake.last().emitData('while detached\r\n')
  assert.equal(events.length, 1, 'a detached viewer stops receiving events')

  // The session kept running, so a second viewer sees everything.
  const reattached = manager.attach(id, () => {})
  assert.equal(reattached.replay, 'before attach\r\nafter attach\r\nwhile detached\r\n')
})

test('attach on an unknown id returns null rather than throwing', () => {
  const { manager } = setup()
  assert.equal(manager.attach('nope', () => {}), null)
})

test('trims the scrollback buffer to the byte cap', () => {
  const { manager, fake } = setup({ scrollbackBytes: 32 })
  const { id } = manager.open()
  for (let i = 0; i < 10; i++) fake.last().emitData('0123456789')

  const attached = manager.attach(id, () => {})
  assert.ok(attached.replay.length <= 40, `buffer should be trimmed, got ${attached.replay.length}`)
  assert.equal(attached.truncated, true)
  assert.ok(attached.replay.endsWith('0123456789'), 'the newest output survives')
})

test('one subscriber throwing does not stop the others', () => {
  const { manager, fake } = setup()
  const { id } = manager.open()
  const seen = []
  manager.attach(id, () => { throw new Error('boom') })
  manager.attach(id, (e) => seen.push(e))

  fake.last().emitData('hello')
  assert.equal(seen.length, 1)
})

test('write forwards keystrokes and reports completed commands', () => {
  const { manager, fake, commands } = setup()
  const { id } = manager.open()

  manager.write(id, 'git status')
  assert.equal(commands.length, 0, 'nothing counted before Enter')
  manager.write(id, '\r')

  assert.equal(commands.length, 1)
  assert.equal(commands[0].command.text, 'git status')
  assert.equal(commands[0].session.commandCount, 1)
  assert.equal(fake.last().written.join(''), 'git status\r')
})

test('a command hook that throws does not break the keystroke path', () => {
  const { manager, fake } = setup({ onCommand: () => { throw new Error('hook down') } })
  const { id } = manager.open()
  assert.doesNotThrow(() => manager.write(id, 'ls\r'))
  assert.equal(fake.last().written.join(''), 'ls\r')
})

test('write to an exited session is refused', () => {
  const { manager, fake } = setup()
  const { id } = manager.open()
  fake.last().emitExit(0)
  assert.equal(manager.write(id, 'ls\r'), false)
  assert.equal(fake.last().written.length, 0)
})

test('resize clamps, deduplicates, and survives a pty that refuses', () => {
  const { manager, fake } = setup()
  const { id } = manager.open({ cols: 80, rows: 24 })

  manager.resize(id, 120, 40)
  assert.deepEqual(fake.last().resized, [[120, 40]])

  manager.resize(id, 120, 40)
  assert.equal(fake.last().resized.length, 1, 'no-op resize is not forwarded')

  fake.last().resize = () => { throw new Error('pty gone') }
  assert.doesNotThrow(() => manager.resize(id, 90, 30))
})

test('exit is published and the session is marked exited', () => {
  const { manager, fake } = setup()
  const { id } = manager.open()
  const events = []
  manager.attach(id, (e) => events.push(e))

  fake.last().emitExit(130, 'SIGINT')
  assert.deepEqual(events, [{ type: 'exit', id, exitCode: 130, signal: 'SIGINT' }])
  assert.equal(manager.list()[0].exited, true)
  assert.equal(manager.list()[0].exitCode, 130)
})

test('close kills the pty, notifies viewers, and is idempotent', () => {
  const { manager, fake } = setup()
  const { id } = manager.open()
  const events = []
  manager.attach(id, (e) => events.push(e))

  assert.equal(manager.close(id), true)
  assert.equal(fake.last().killed, true)
  assert.deepEqual(events, [{ type: 'closed', id }])
  assert.equal(manager.list().length, 0)
  assert.equal(manager.close(id), false)
})

test('clear drops the replay buffer', () => {
  const { manager, fake } = setup()
  const { id } = manager.open()
  fake.last().emitData('noise')
  manager.clear(id)
  assert.equal(manager.attach(id, () => {}).replay, '')
})

test('reap removes exited sessions only after the retention window', () => {
  let clock = 1_000_000
  const { manager, fake } = setup({ now: () => clock })
  const { id } = manager.open()
  fake.last().emitExit(0)

  assert.equal(manager.reap(), 0)
  assert.equal(manager.list().length, 1, 'exit output stays readable for a while')

  clock += 6 * 60 * 1000
  assert.equal(manager.reap(), 1)
  assert.equal(manager.list().length, 0)

  // A live session is never reaped, however old.
  manager.open()
  clock += 24 * 60 * 60 * 1000
  assert.equal(manager.reap(), 0)
  assert.equal(manager.list().length, 1)
})

test('shutdown kills every session', () => {
  const { manager, fake } = setup()
  manager.open()
  manager.open()
  manager.shutdown()
  assert.equal(manager.list().length, 0)
  assert.ok(fake.spawned.every((p) => p.killed))
})

test('buildSessionEnv strips hidden keys and sets terminal basics', () => {
  const env = buildSessionEnv(
    { PATH: '/usr/bin', BRIDGE_SECRET: 'hunter2', WHOOP_CLIENT_SECRET: 'x', TERM: 'dumb' },
    new Set(['BRIDGE_SECRET', 'WHOOP_CLIENT_SECRET']),
    { cols: 100, rows: 40 },
  )
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.BRIDGE_SECRET, undefined)
  assert.equal(env.WHOOP_CLIENT_SECRET, undefined)
  assert.equal(env.TERM, 'xterm-256color', 'overrides whatever the bridge inherited')
  assert.equal(env.TOTEM_TERMINAL, '1')
  assert.equal(env.COLUMNS, '100')
})

test('the spawned shell does not inherit the bridge secret', () => {
  const fake = makeFakePty()
  const manager = createTerminalSessions({
    spawnPty: fake.spawnPty,
    env: { PATH: '/usr/bin', BRIDGE_SECRET: 'hunter2' },
    hiddenEnvKeys: new Set(['BRIDGE_SECRET']),
  })
  manager.open()
  assert.equal(fake.last().opts.env.BRIDGE_SECRET, undefined)
  assert.equal(fake.last().opts.env.PATH, '/usr/bin')
})

test('readEnvFileKeys reads names off a .env without keeping values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'totem-env-'))
  const envPath = join(dir, '.env')
  writeFileSync(envPath, [
    '# a comment',
    'BRIDGE_SECRET=hunter2',
    'export WHOOP_CLIENT_SECRET=abc',
    '  SPACED_KEY = value',
    'PATH=/should/not/be/hidden',
    'not a key line',
    '',
  ].join('\n'))

  const keys = readEnvFileKeys(envPath)
  assert.ok(keys.has('BRIDGE_SECRET'))
  assert.ok(keys.has('WHOOP_CLIENT_SECRET'))
  assert.ok(keys.has('SPACED_KEY'))
  assert.ok(!keys.has('PATH'), 'essentials are never hidden')
})

test('readEnvFileKeys falls back to hiding the bridge secret when there is no .env', () => {
  const keys = readEnvFileKeys('/nonexistent/.env')
  assert.deepEqual([...keys], ['BRIDGE_SECRET'])
})
