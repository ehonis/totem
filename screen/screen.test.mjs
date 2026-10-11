import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { mkdtemp, readdir, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { attachScreenRelay } from './relay.mjs'
import { createScreen } from './index.mjs'

const SECRET = 's3cret'
const bearer = (s) => `totem.bearer.${Buffer.from(s).toString('base64url')}`
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))

/** A bridge-shaped HTTP server with the relay on it, in front of a fake VNC server. */
async function rig({ authorize = null, vncPort = null } = {}) {
  const received = []
  const vnc = net.createServer((sock) => {
    sock.write('RFB 003.889\n')
    sock.on('data', (d) => { received.push(d); sock.write(Buffer.concat([Buffer.from('echo:'), d])) })
  })
  const port = vncPort ?? await listen(vnc)
  const server = http.createServer()
  const relay = attachScreenRelay(server, { path: '/api/screen/ws', host: '127.0.0.1', port, secret: SECRET, authorize })
  const httpPort = await listen(server)
  const close = () => { relay.close(); server.close(); vnc.close() }
  return { httpPort, received, close }
}

const open = (port, protocols, headers = {}) => new WebSocket(`ws://127.0.0.1:${port}/api/screen/ws`, protocols, { headers })

test('relays bytes both ways for a bearer handshake', async () => {
  const r = await rig()
  try {
    const ws = open(r.httpPort, ['binary', bearer(SECRET)])
    const frames = []
    await new Promise((resolve, reject) => {
      ws.on('message', (d) => {
        frames.push(Buffer.from(d).toString())
        if (frames.length === 1) ws.send(Buffer.from('RFB 003.889\n'))
        else resolve()
      })
      ws.on('error', reject)
    })
    assert.equal(ws.protocol, 'binary')
    assert.equal(frames[0], 'RFB 003.889\n')
    assert.equal(frames[1], 'echo:RFB 003.889\n')
    assert.equal(Buffer.concat(r.received).toString(), 'RFB 003.889\n')
    ws.close()
  } finally { r.close() }
})

test('refuses a handshake with no secret and no session', async () => {
  const r = await rig()
  try {
    const ws = open(r.httpPort, ['binary'])
    const status = await new Promise((resolve) => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode)))
    assert.equal(status, 401)
    assert.equal(r.received.length, 0)
  } finally { r.close() }
})

test('refuses a wrong secret', async () => {
  const r = await rig()
  try {
    const ws = open(r.httpPort, ['binary', bearer('nope')])
    const status = await new Promise((resolve) => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode)))
    assert.equal(status, 401)
  } finally { r.close() }
})

test('a cookie session gets in through authorize', async () => {
  const r = await rig({ authorize: (req) => req.headers.cookie === 'ok=1' })
  try {
    const ws = open(r.httpPort, ['binary'], { cookie: 'ok=1' })
    const first = await new Promise((resolve, reject) => { ws.once('message', (d) => resolve(Buffer.from(d).toString())); ws.on('error', reject) })
    assert.equal(first, 'RFB 003.889\n')
    ws.close()
  } finally { r.close() }
})

test('closes with 4502 when nothing is listening for VNC', async () => {
  // A port that was free a moment ago, so the relay's connect is refused.
  const holder = net.createServer()
  const unused = await listen(holder)
  await new Promise((res) => holder.close(res))
  const r = await rig({ vncPort: unused })
  try {
    const ws = open(r.httpPort, ['binary', bearer(SECRET)])
    const [code, reason] = await new Promise((resolve) => ws.on('close', (c, why) => resolve([c, String(why)])))
    assert.equal(code, 4502)
    assert.equal(reason, 'Screen Sharing is not on')
  } finally { r.close() }
})

// ---- capture and status ----------------------------------------------------

function fakeExec({ failCapture = null } = {}) {
  const calls = []
  const exec = async (file, args) => {
    calls.push([file, ...args])
    if (file.endsWith('screencapture')) {
      if (failCapture) { const e = new Error('Command failed'); e.stderr = failCapture; throw e }
      await writeFile(args[args.length - 1], 'png')
      return { stdout: '', stderr: '' }
    }
    if (args.includes('-g')) return { stdout: '  pixelWidth: 1600\n  pixelHeight: 1000\n', stderr: '' }
    return { stdout: '', stderr: '' }
  }
  return { exec, calls }
}

test('off: status says how to turn it on, capture refuses with 404', async () => {
  const s = createScreen({ enabled: false })
  assert.equal((await s.status()).state, 'off')
  await assert.rejects(s.capture(), (e) => e.status === 404)
})

test('capture writes a PNG, scales it and reports its size', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-test-'))
  const { exec, calls } = fakeExec()
  const s = createScreen({ enabled: true, platform: 'darwin', shotsDir: dir, exec })
  const shot = await s.capture({ display: 2, maxSize: 1200 })
  assert.equal(shot.width, 1600)
  assert.equal(shot.height, 1000)
  assert.equal(shot.display, 2)
  assert.ok(shot.imagePath.startsWith(dir))
  const cap = calls.find((c) => c[0].endsWith('screencapture'))
  assert.deepEqual(cap.slice(1, 6), ['-x', '-t', 'png', '-D', '2'])
  assert.ok(calls.some((c) => c[0].endsWith('sips') && c[1] === '-Z' && c[2] === '1200'))
})

test('a missing Screen Recording grant becomes a 403 naming the fix', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-test-'))
  const { exec } = fakeExec({ failCapture: 'could not create image from display\n' })
  const s = createScreen({ enabled: true, platform: 'darwin', shotsDir: dir, exec, probe: async () => true })
  await assert.rejects(s.capture(), (e) => e.status === 403 && e.code === 'no-access' && /Screen Recording/.test(e.message))
  const st = await s.status()
  assert.equal(st.state, 'partial')
  assert.equal(st.viewer.state, 'ready')
  assert.equal(st.screenshots.state, 'no-access')
})

test('status without a VNC server or a Mac', async () => {
  const s = createScreen({ enabled: true, platform: 'linux', probe: async () => false })
  const st = await s.status()
  assert.equal(st.state, 'unavailable')
  assert.equal(st.viewer.state, 'no-vnc')
  assert.equal(st.screenshots.state, 'unsupported')
  await assert.rejects(s.capture(), (e) => e.status === 501)
})

test('old screenshots are pruned on the next capture', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screen-test-'))
  const old = join(dir, 'screen-old.png')
  await writeFile(old, 'x')
  const twoDaysAgo = (Date.now() - 2 * 86400_000) / 1000
  await utimes(old, twoDaysAgo, twoDaysAgo)
  const { exec } = fakeExec()
  const s = createScreen({ enabled: true, platform: 'darwin', shotsDir: dir, exec })
  await s.capture()
  const names = await readdir(dir)
  assert.ok(!names.includes('screen-old.png'))
  assert.equal(names.length, 1)
})
