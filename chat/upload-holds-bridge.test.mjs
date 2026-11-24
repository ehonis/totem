// Run with: node --test chat/upload-holds-bridge.test.mjs
//
// The hold a browser's saved drafts put on their uploads, against a real
// bridge.mjs: only the owner holds, unknown uploads come back as missing, a hold
// does not keep a deleted chat's files, and the draft deleting its own file lets
// go of it first. The bridge runs from a shadow checkout on its own port,
// with no scheduler.

import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { connect, createServer } from 'node:net'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, realpathSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const SECRET = 'upload-holds-bridge-test-secret'
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

const B = {}
const call = async (method, path, body) => {
  const r = await fetch(`${B.base}${path}`, { method, headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

before(async () => {
  const root = realpathSync(mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'totem-upload-holds-bridge-')))
  for (const entry of readdirSync(REPO)) {
    if (entry === 'data' || entry === '.env' || entry === '.git' || entry === 'AGENTS.local.md') continue
    symlinkSync(join(REPO, entry), join(root, entry))
  }
  B.root = root
  mkdirSync(join(root, 'data'), { recursive: true })
  mkdirSync(join(root, 'home'))
  writeFileSync(join(root, 'data', 'auth.json'), '{}')
  const port = await freePort()
  B.base = `http://127.0.0.1:${port}`
  let output = ''
  const child = spawn(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', join(root, 'bridge.mjs')], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: join(root, 'home'), BRIDGE_PORT: String(port), BRIDGE_SECRET: SECRET, BRIDGE_NO_SCHEDULER: '1', AGENT_CWD: root },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => { output += d })
  child.stderr.on('data', (d) => { output += d })
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

const upload = async (name) => {
  const r = await fetch(`${B.base}/api/chat/uploads?name=${name}`, { method: 'POST', headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'text/plain' }, body: `fictional ${name}` })
  return (await r.json()).id
}
const holds = () => { try { return JSON.parse(readFileSync(join(B.root, 'data', 'upload-holds.json'), 'utf8')) } catch { return {} } }
const stored = (id) => existsSync(join(B.root, 'data', 'chat-uploads', id))

test('holding needs the owner and a list of upload ids, and says which are gone', async () => {
  assert.equal((await fetch(`${B.base}/api/chat/uploads/hold`, { method: 'POST', body: '{"ids":[]}', headers: { 'content-type': 'application/json' } })).status, 401)
  assert.equal((await call('POST', '/api/chat/uploads/hold', { ids: 'abc' })).status, 400)
  const id = await upload('a.txt')
  const r = await call('POST', '/api/chat/uploads/hold', { ids: [id, 'missing00001', '../../etc/passwd'] })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { held: [id], missing: ['missing00001'] })
  assert.deepEqual(Object.keys(holds()), [id])
})

test('deleting a chat takes its files even if a draft held them while unsent, and lets go of the holds', async () => {
  const id = await upload('b.txt')
  await call('POST', '/api/chat/uploads/hold', { ids: [id] })
  const thread = { id: 'heldchat01', kind: 'regular', messages: [{ id: 'm1', role: 'user', content: 'x', createdAt: 1, attachments: [{ id, name: 'b.txt', mime: 'text/plain', size: 1, kind: 'text' }] }], createdAt: 1, updatedAt: 1 }
  assert.equal((await call('PUT', '/api/threads/heldchat01', thread)).status, 200)
  assert.equal((await call('DELETE', '/api/threads/heldchat01')).status, 200)
  assert.equal(stored(id), false)
  assert.equal(holds()[id], undefined)
})

test('a draft deleting its own file lets go of it, and the file goes', async () => {
  const id = await upload('c.txt')
  await call('POST', '/api/chat/uploads/hold', { ids: [id] })
  assert.ok(holds()[id])
  const r = await call('DELETE', `/api/chat/uploads/${id}`)
  assert.deepEqual(r.body, { ok: true })
  assert.equal(holds()[id], undefined)
  assert.equal(stored(id), false)
})
