// The browser panel's socket: who may watch, who may drive, and that a viewer
// leaving stops its stream.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import WebSocket from 'ws'
import { attachBrowserSocket, approvalFromProtocols, encodeFrame, panelOwner, BROWSER_WS_PATH, BROWSER_SUBPROTOCOL } from './socket.mjs'

const SECRET = 'bridge-secret'
const b64 = (s) => Buffer.from(s).toString('base64url')

function fakeManager() {
  const m = { watchers: [], inputs: [], releases: [], owners: [] }
  m.watch = (key, viewer) => {
    if (key !== 'open-chat') return null
    const w = { key, viewer, stopped: false, views: [] }
    m.watchers.push(w)
    return { stop: () => { w.stopped = true }, view: (v) => w.views.push(v) }
  }
  m.input = async (key, ev, owner) => { m.inputs.push([key, ev]); m.owners.push(owner) }
  m.release = async (key, owner) => { m.releases.push([key, owner]) }
  return m
}

async function serve({ approve, heartbeatMs }) {
  const manager = fakeManager()
  const server = createServer((req, res) => { res.writeHead(404); res.end() })
  // A "session" here is a cookie header; the bridge's authorize checks the real one.
  const socket = attachBrowserSocket(server, {
    manager, secret: SECRET, approve, heartbeatMs,
    authorize: (req) => req.headers.cookie === 'session=ok',
    validThreadId: (id) => typeof id === 'string' && /^[\w-]{1,128}$/.test(id),
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = (thread = 'open-chat', owner = '') => `ws://127.0.0.1:${server.address().port}${BROWSER_WS_PATH}?threadId=${thread}&w=800&dpr=2${owner ? `&owner=${owner}` : ''}`
  return { manager, url, close: () => { socket.close(); server.close() } }
}

function connect(url, { protocols = [BROWSER_SUBPROTOCOL], headers = {} } = {}) {
  const ws = new WebSocket(url, protocols, { headers })
  const messages = []
  const binary = []
  ws.on('message', (data, isBinary) => { if (isBinary) binary.push(data); else messages.push(JSON.parse(String(data))) })
  const opened = new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws))
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })))
    ws.on('error', reject)
  })
  const next = async (pred, ms = 2000) => {
    const end = Date.now() + ms
    while (Date.now() < end) { const m = messages.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 5)) }
    throw new Error(`no such message in ${JSON.stringify(messages)}`)
  }
  return { ws, opened, messages, binary, next }
}

const settle = () => new Promise((r) => setTimeout(r, 50))

test('the bearer alone watches the page but its input never reaches it', async () => {
  const approvals = []
  const s = await serve({ approve: async (req, code) => { approvals.push(code); return { message: 'Approving needs the approval code on this device.', code: 'APPROVAL_NEEDS_OWNER' } } })
  try {
    const c = connect(s.url(), { protocols: [BROWSER_SUBPROTOCOL, `totem.bearer.${b64(SECRET)}`] })
    await c.opened
    const ready = await c.next((m) => m.t === 'ready')
    assert.equal(ready.drive, false)
    assert.equal(approvals[0], '', 'no code was offered')
    assert.equal(s.manager.watchers.length, 1)
    assert.deepEqual([s.manager.watchers[0].viewer.width, s.manager.watchers[0].viewer.dpr], [800, 2])
    // Frames come down.
    s.manager.watchers[0].viewer.onFrame({ tabId: 'tab-1', url: 'https://example.com/', title: 'Ex', width: 1280, height: 800, jpeg: Buffer.from([0xff, 0xd8, 1]), at: 5 })
    await settle()
    const frame = c.binary[0]
    const len = frame.readUInt32BE(0)
    assert.deepEqual(JSON.parse(frame.subarray(4, 4 + len)), { tabId: 'tab-1', url: 'https://example.com/', title: 'Ex', width: 1280, height: 800, at: 5 })
    assert.deepEqual([...frame.subarray(4 + len)], [0xff, 0xd8, 1])
    // Input does not.
    c.ws.send(JSON.stringify({ t: 'input', event: { kind: 'mouse', type: 'down', x: 1, y: 1 } }))
    const refused = await c.next((m) => m.t === 'error')
    assert.equal(refused.code, 'APPROVAL_NEEDS_OWNER')
    assert.deepEqual(s.manager.inputs, [])
    c.ws.close()
    await settle()
    assert.equal(s.manager.watchers[0].stopped, true, 'leaving stops the stream')
    assert.deepEqual([s.manager.inputs, s.manager.releases], [[], []], 'a socket that never drove lets go of nothing')
  } finally { s.close() }
})

test('a signed-in or approved socket drives; the approval code rides the subprotocol', async () => {
  const s = await serve({ approve: async (req, code) => (code === 'the-code' || req.headers.cookie === 'session=ok' ? true : { message: 'no', code: 'APPROVAL_CODE_WRONG' }) })
  try {
    const owner = connect(s.url(), { headers: { cookie: 'session=ok' } })
    await owner.opened
    assert.equal((await owner.next((m) => m.t === 'ready')).drive, true)
    owner.ws.send(JSON.stringify({ t: 'input', event: { kind: 'text', text: 'hunter22' } }))
    owner.ws.send(JSON.stringify({ t: 'view', width: 1000, dpr: 1 }))
    await settle()
    assert.deepEqual(s.manager.inputs, [['open-chat', { kind: 'text', text: 'hunter22' }]])
    assert.deepEqual(s.manager.watchers[0].views, [{ width: 1000, dpr: 1 }])
    const app = connect(s.url(), { protocols: [BROWSER_SUBPROTOCOL, `totem.bearer.${b64(SECRET)}`, `totem.approval.${b64('the-code')}`] })
    await app.opened
    assert.equal((await app.next((m) => m.t === 'ready')).drive, true)
    owner.ws.close(); app.ws.close()
  } finally { s.close() }
})

test('no sign-in, a bad thread or a chat with no browser get nothing', async () => {
  const s = await serve({ approve: async () => true })
  try {
    await assert.rejects(connect(s.url()).opened, (e) => e.status === 401)
    await assert.rejects(connect(s.url(), { protocols: [BROWSER_SUBPROTOCOL, `totem.bearer.${b64('wrong')}`] }).opened, (e) => e.status === 401)
    await assert.rejects(connect(s.url('../x'), { headers: { cookie: 'session=ok' } }).opened, (e) => e.status === 400)
    const none = connect(s.url('no-browser'), { headers: { cookie: 'session=ok' } })
    await none.opened
    await none.next((m) => m.t === 'closed')
    assert.equal(s.manager.watchers.length, 0)
  } finally { s.close() }
})

test('the frame and code helpers', () => {
  assert.equal(approvalFromProtocols(`${BROWSER_SUBPROTOCOL}, totem.approval.${b64('abc-123')}`), 'abc-123')
  assert.equal(approvalFromProtocols(BROWSER_SUBPROTOCOL), '')
  const buf = encodeFrame({ tabId: 't', url: 'u', title: '', width: 2, height: 3, at: 4, jpeg: Buffer.from('j') })
  assert.equal(buf.subarray(4 + buf.readUInt32BE(0)).toString(), 'j')
})

const cookie = { headers: { cookie: 'session=ok' } }
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)) } }

test('a frame over the size limit, invalid UTF-8 or junk never takes the server down', async () => {
  const s = await serve({ approve: async () => true })
  try {
    for (const bad of [(ws) => ws.send('x'.repeat(100_000)), (ws) => ws.send(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), { binary: false })]) {
      const c = connect(s.url(), cookie)
      await c.opened
      await c.next((m) => m.t === 'ready')
      const closed = new Promise((r) => c.ws.on('close', r))
      c.ws.on('error', () => {})
      bad(c.ws)
      await closed
    }
    // Junk that is valid text is ignored, the socket stays.
    const ok = connect(s.url(), cookie)
    await ok.opened
    await ok.next((m) => m.t === 'ready')
    for (const junk of ['not json', '{"t":"nope"}', 'null', '{"t":"input","event":7}', '{"t":"view","width":"wide"}']) ok.ws.send(junk)
    ok.ws.send(JSON.stringify({ t: 'input', event: { kind: 'text', text: 'still here' } }))
    await until(() => s.manager.inputs.some(([, ev]) => ev?.text === 'still here'))
    assert.equal(ok.ws.readyState, WebSocket.OPEN)
    ok.ws.close()
  } finally { s.close() }
})

test('closing a socket lets go of what it holds, as its own owner; one that never drove lets go of nothing', async () => {
  const s = await serve({ approve: async (req) => (req.headers.cookie === 'session=ok' ? true : { message: 'no', code: 'APPROVAL_NEEDS_OWNER' }) })
  try {
    const owner = connect(s.url(), cookie)
    await owner.opened
    await owner.next((m) => m.t === 'ready')
    owner.ws.send(JSON.stringify({ t: 'input', event: { kind: 'mouse', type: 'down', x: 40, y: 50, button: 'left', buttons: 1 } }))
    owner.ws.send(JSON.stringify({ t: 'input', event: { kind: 'key', type: 'down', key: 'Shift', modifiers: ['Shift'] } }))
    owner.ws.send(JSON.stringify({ t: 'input', event: { kind: 'key', type: 'down', key: 'a', modifiers: ['Shift'] } }))
    owner.ws.send(JSON.stringify({ t: 'input', event: { kind: 'key', type: 'up', key: 'a', modifiers: ['Shift'] } }))
    await until(() => s.manager.inputs.length === 4)
    // A watch-only viewer (the bearer) leaving mid-drag sends nothing to the page.
    const viewer = connect(s.url(), { protocols: [BROWSER_SUBPROTOCOL, `totem.bearer.${b64(SECRET)}`] })
    await viewer.opened
    await viewer.next((m) => m.t === 'ready')
    viewer.ws.close()
    assert.deepEqual(s.manager.releases, [])
    // Every input of one socket carries one owner id. A second driving socket
    // lets go only under its own (its panel's POSTs may have pressed something).
    const [ownerId] = new Set(s.manager.owners)
    assert.equal(new Set(s.manager.owners).size, 1)
    assert.match(ownerId, /^[0-9a-f-]{36}$/)
    const tab = connect(s.url(), cookie)
    await tab.opened
    await tab.next((m) => m.t === 'ready')
    tab.ws.close()
    await until(() => s.manager.releases.length === 1)
    assert.notEqual(s.manager.releases[0][1], ownerId)
    owner.ws.close()
    await until(() => s.manager.releases.length === 2)
    assert.deepEqual(s.manager.releases[1], ['open-chat', ownerId])
  } finally { s.close() }
})

test('a viewer that stops reading does not slow another, and gets the newest frame once it drains', async () => {
  const s = await serve({ approve: async () => true })
  try {
    const slow = connect(s.url(), cookie)
    const fast = connect(s.url(), cookie)
    await Promise.all([slow.opened, fast.opened])
    await Promise.all([slow.next((m) => m.t === 'ready'), fast.next((m) => m.t === 'ready')])
    slow.ws._socket.pause()
    const big = Buffer.alloc(500_000, 7)
    const frame = (n) => ({ tabId: 't', url: 'u', title: '', width: 1, height: 1, at: n, jpeg: big })
    const atOf = (buf) => JSON.parse(buf.subarray(4, 4 + buf.readUInt32BE(0))).at
    for (let n = 1; n <= 40; n++) {
      for (const w of s.manager.watchers) w.viewer.onFrame(frame(n))
      // A pace a reading client keeps up with; the paused one falls behind.
      await new Promise((r) => setTimeout(r, 15))
    }
    await until(() => fast.binary.length === 40).catch((e) => { throw new Error(`fast got ${fast.binary.length}, slow got ${slow.binary.length}`) })
    assert.deepEqual(fast.binary.map(atOf), Array.from({ length: 40 }, (_, i) => i + 1))
    slow.ws._socket.resume()
    await until(() => slow.binary.length && atOf(slow.binary.at(-1)) === 40).catch(() => { throw new Error(`slow got ${slow.binary.map(atOf)}`) })
    assert.ok(slow.binary.length < 40, `the slow viewer skipped frames (${slow.binary.length})`)
    slow.ws.close(); fast.ws.close()
  } finally { s.close() }
})

test('losing focus asks the bridge to let go of what this socket holds', async () => {
  const s = await serve({ approve: async () => true })
  try {
    const c = connect(s.url(), cookie)
    await c.opened
    await c.next((m) => m.t === 'ready')
    c.ws.send(JSON.stringify({ t: 'input', event: { kind: 'key', type: 'down', key: 'a', modifiers: ['Shift'] } }))
    c.ws.send(JSON.stringify({ t: 'release' }))
    await until(() => s.manager.releases.length === 1)
    assert.equal(s.manager.releases[0][1], s.manager.owners[0])
    c.ws.close()
  } finally { s.close() }
})

const PANEL = 'panel0123456789abcdef'

test('a panel’s socket owns its presses under the panel’s id, which its POSTs share', async () => {
  const s = await serve({ approve: async (req) => (req.headers.cookie === 'session=ok' ? true : { message: 'no', code: 'APPROVAL_NEEDS_OWNER' }) })
  try {
    const c = connect(s.url('open-chat', PANEL), cookie)
    await c.opened
    await c.next((m) => m.t === 'ready')
    c.ws.send(JSON.stringify({ t: 'input', event: { kind: 'mouse', type: 'up', x: 1, y: 1, button: 'left' } }))
    await until(() => s.manager.owners.length === 1)
    assert.equal(s.manager.owners[0], PANEL, 'the up is the panel’s, so it lets go of a press its POST made')
    // A watch-only socket naming the same panel lets go of nothing.
    const viewer = connect(s.url('open-chat', PANEL), { protocols: [BROWSER_SUBPROTOCOL, `totem.bearer.${b64(SECRET)}`] })
    await viewer.opened
    await viewer.next((m) => m.t === 'ready')
    viewer.ws.send(JSON.stringify({ t: 'release' }))
    viewer.ws.close()
    await settle()
    assert.deepEqual(s.manager.releases, [])
    // The driving socket closing lets go of the panel’s presses, whichever route made them.
    c.ws.close()
    await until(() => s.manager.releases.length === 1)
    assert.deepEqual(s.manager.releases[0], ['open-chat', PANEL])
    // No id, or one of the wrong shape: the socket's own.
    for (const bad of ['', 'short', 'x'.repeat(65), 'has%20space-0123456789']) {
      const d = connect(s.url('open-chat', bad), cookie)
      await d.opened
      await d.next((m) => m.t === 'ready')
      d.ws.send(JSON.stringify({ t: 'input', event: { kind: 'text', text: 'x' } }))
      await until(() => s.manager.owners.length >= 2)
      assert.match(s.manager.owners.pop(), /^[0-9a-f-]{36}$/, bad)
      d.ws.close()
    }
  } finally { s.close() }
  assert.equal(panelOwner(PANEL), PANEL)
  for (const bad of [null, 7, 'http', 'a b'.repeat(8), 'x'.repeat(65)]) assert.equal(panelOwner(bad), null)
})

test('driving taken away mid-socket lets go of what it holds at once', async () => {
  let calls = 0
  const s = await serve({ heartbeatMs: 40, approve: async () => (++calls === 1 ? true : { message: 'The approval code changed.', code: 'APPROVAL_CODE_WRONG' }) })
  try {
    const c = connect(s.url('open-chat', PANEL), cookie)
    await c.opened
    await c.next((m) => m.t === 'ready' && m.drive)
    c.ws.send(JSON.stringify({ t: 'input', event: { kind: 'key', type: 'down', key: 'Shift', modifiers: ['Shift'] } }))
    const revoked = await c.next((m) => m.t === 'ready' && !m.drive)
    assert.equal(revoked.code, 'APPROVAL_CODE_WRONG')
    await until(() => s.manager.releases.length === 1)
    assert.deepEqual(s.manager.releases[0], ['open-chat', PANEL])
    c.ws.send(JSON.stringify({ t: 'input', event: { kind: 'text', text: 'late' } }))
    assert.equal((await c.next((m) => m.t === 'error')).code, 'APPROVAL_CODE_WRONG')
    c.ws.close()
  } finally { s.close() }
})
