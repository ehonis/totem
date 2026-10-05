import test from 'node:test'
import assert from 'node:assert/strict'
import { __testables } from './ws.mjs'

const { protocolsAuthorized, originAllowed, BEARER_PREFIX } = __testables

const SECRET = 'correct-horse-battery-staple'
const offer = (secret) => `totem.terminal.v1, ${BEARER_PREFIX}${Buffer.from(secret).toString('base64url')}`

test('accepts a handshake carrying the right secret', () => {
  assert.equal(protocolsAuthorized(offer(SECRET), SECRET), true)
})

test('rejects a wrong, absent, or truncated secret', () => {
  assert.equal(protocolsAuthorized(offer('wrong'), SECRET), false)
  assert.equal(protocolsAuthorized('totem.terminal.v1', SECRET), false)
  assert.equal(protocolsAuthorized('', SECRET), false)
  assert.equal(protocolsAuthorized(undefined, SECRET), false)
  assert.equal(protocolsAuthorized(offer(SECRET.slice(0, -1)), SECRET), false)
})

test('rejects everything when the bridge has no secret configured', () => {
  assert.equal(protocolsAuthorized(offer(''), ''), false)
  assert.equal(protocolsAuthorized(offer('anything'), undefined), false)
})

test('survives a malformed base64 subprotocol without throwing', () => {
  assert.doesNotThrow(() => protocolsAuthorized(`${BEARER_PREFIX}!!!not base64!!!`, SECRET))
  assert.equal(protocolsAuthorized(`${BEARER_PREFIX}!!!not base64!!!`, SECRET), false)
})

test('finds the bearer regardless of its position in the offer list', () => {
  const token = `${BEARER_PREFIX}${Buffer.from(SECRET).toString('base64url')}`
  assert.equal(protocolsAuthorized(`${token}, totem.terminal.v1`, SECRET), true)
  assert.equal(protocolsAuthorized(`a, b, ${token}`, SECRET), true)
})

test('a secret with awkward characters still round-trips', () => {
  const gnarly = 'a b/c+d=e?f&g#hé'
  assert.equal(protocolsAuthorized(offer(gnarly), gnarly), true)
})

test('origin check allows same-host, localhost, and header-less clients', () => {
  assert.equal(originAllowed(undefined, 'totem.example.com'), true)
  assert.equal(originAllowed('https://totem.example.com', 'totem.example.com'), true)
  assert.equal(originAllowed('http://localhost:5173', 'localhost:8787'), true)
  assert.equal(originAllowed('http://127.0.0.1:5173', 'localhost:8787'), true)
})

test('origin check rejects another site and unparseable origins', () => {
  assert.equal(originAllowed('https://evil.example', 'totem.example.com'), false)
  assert.equal(originAllowed('null', 'totem.example.com'), false)
  assert.equal(originAllowed('not a url', 'totem.example.com'), false)
})

test('a cookie-authorized socket is refused and closed once its session ends', async () => {
  const http = await import('node:http')
  const { WebSocket } = await import('ws')
  const { attachTerminalWebSocket } = await import('./ws.mjs')
  let signedIn = true
  const sessions = { list: () => [], attach: () => null, open: () => ({ id: 's1' }), resize() {}, write: () => false, close() {} }
  const server = http.createServer()
  const terminal = attachTerminalWebSocket(server, {
    sessions, path: '/api/terminal/ws', secret: 'bearer-secret',
    authorize: () => signedIn, maxSessions: 2,
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `ws://127.0.0.1:${server.address().port}/api/terminal/ws`
  try {
    const ws = new WebSocket(url, ['totem.terminal.v1'])
    const messages = []
    ws.on('message', (m) => messages.push(JSON.parse(String(m))))
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    ws.send(JSON.stringify({ t: 'list' }))
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(messages.some((m) => m.t === 'sessions'), 'works while signed in')

    signedIn = false // sign-out bumps the session version
    const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)))
    ws.send(JSON.stringify({ t: 'list' }))
    assert.equal(await closed, 4401)
    assert.ok(messages.some((m) => m.t === 'error' && /session has ended/.test(m.message)))
    assert.equal(messages.filter((m) => m.t === 'sessions').length, 1, 'the second list was not answered')

    // A bearer socket does not depend on a browser session.
    const bearer = new WebSocket(url, ['totem.terminal.v1', `totem.bearer.${Buffer.from('bearer-secret').toString('base64url')}`])
    const got = []
    bearer.on('message', (m) => got.push(JSON.parse(String(m))))
    await new Promise((resolve, reject) => { bearer.once('open', resolve); bearer.once('error', reject) })
    bearer.send(JSON.stringify({ t: 'list' }))
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(got.some((m) => m.t === 'sessions'))
    bearer.close()
  } finally {
    terminal.close()
    await new Promise((r) => server.close(r))
  }
})
