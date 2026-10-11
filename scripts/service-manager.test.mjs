import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serviceTarget, parseLaunchdPid, pidCommand, parsePid, restartCommand, serviceName } from './service-manager.mjs'

test('Linux restarts the systemd unit, assistant-bridge unless configured', () => {
  assert.deepEqual(serviceTarget({ platform: 'linux', env: {} }), { kind: 'systemd', unit: 'assistant-bridge' })
  const t = serviceTarget({ platform: 'linux', env: { TOTEM_SERVICE_NAME: 'totem' } })
  assert.deepEqual(restartCommand(t), ['systemctl', ['--user', 'restart', '--no-block', 'totem']])
  assert.equal(parsePid(t, '1234\n'), 1234)
})

test('macOS takes the label launchd started it under', () => {
  const t = serviceTarget({ platform: 'darwin', env: { XPC_SERVICE_NAME: 'com.example.totem' }, uid: 501 })
  assert.deepEqual(t, { kind: 'launchd', label: 'com.example.totem', domain: 'gui/501' })
  assert.deepEqual(pidCommand(t), ['launchctl', ['print', 'gui/501/com.example.totem']])
  assert.deepEqual(restartCommand(t), ['launchctl', ['kickstart', '-k', 'gui/501/com.example.totem']])
  assert.equal(serviceName(t), 'com.example.totem')
})

test('macOS: a configured name wins; no label means no service', () => {
  assert.equal(serviceTarget({ platform: 'darwin', env: { TOTEM_SERVICE_NAME: 'a.b', XPC_SERVICE_NAME: 'c.d' }, uid: 501 }).label, 'a.b')
  assert.equal(serviceTarget({ platform: 'darwin', env: {}, uid: 501 }), null)
  assert.equal(serviceTarget({ platform: 'darwin', env: { XPC_SERVICE_NAME: '0' }, uid: 501 }), null)
  assert.equal(serviceName(null), 'the service')
})

test('the pid comes out of launchctl print', () => {
  const out = 'gui/501/com.example.totem = {\n\tactive count = 1\n\tstate = running\n\n\tpid = 46414\n\timmediate reason = speculative\n}'
  assert.equal(parseLaunchdPid(out), 46414)
  assert.equal(parseLaunchdPid('state = not running'), 0)
})
