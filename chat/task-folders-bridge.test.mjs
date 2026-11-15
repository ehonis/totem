// Run with: node --test chat/task-folders-bridge.test.mjs
//
// The Tasks panel's filing routes against a real bridge.mjs: a task is filed only
// under a project that exists, bad ids are refused, and deleting a folder hands
// its tasks up to its project (deleting a project unfiles them), as its chats move.
// The bridge runs from a shadow checkout on its own port, with no scheduler.

import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { connect, createServer } from 'node:net'
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const SECRET = 'task-folders-bridge-test-secret'
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
  const root = realpathSync(mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'totem-task-folders-bridge-')))
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

test('filing needs a real project and a valid task id; null unfiles', async () => {
  assert.equal((await fetch(`${B.base}/api/chat/task-folders`)).status, 401)
  const project = (await call('POST', '/api/chat/projects', { name: 'Work' })).body.project
  assert.equal((await call('PUT', '/api/chat/task-folders/t1', { projectId: 'no-such-project' })).status, 404)
  assert.equal((await call('PUT', `/api/chat/task-folders/${encodeURIComponent('bad id!')}`, { projectId: project.id })).status, 400)
  const filed = await call('PUT', `/api/chat/task-folders/${encodeURIComponent('sheet:0:4:abcd1234')}`, { projectId: project.id })
  assert.equal(filed.status, 200)
  assert.deepEqual(filed.body.folders, { 'sheet:0:4:abcd1234': project.id })
  assert.deepEqual((await call('PUT', `/api/chat/task-folders/${encodeURIComponent('sheet:0:4:abcd1234')}`, { projectId: null })).body.folders, {})
  assert.equal((await call('POST', '/api/chat/task-folders', {})).status, 405)
})

test('a deleted folder hands its tasks to its project; a deleted project unfiles them', async () => {
  const project = (await call('POST', '/api/chat/projects', { name: 'Client' })).body.project
  const folder = (await call('POST', '/api/chat/projects', { name: 'Network', parentId: project.id })).body.project
  await call('PUT', '/api/chat/task-folders/a', { projectId: folder.id })
  await call('PUT', '/api/chat/task-folders/b', { projectId: project.id })
  assert.equal((await call('DELETE', `/api/chat/projects/${folder.id}`)).status, 200)
  assert.deepEqual((await call('GET', '/api/chat/task-folders')).body.folders, { a: project.id, b: project.id })
  assert.equal((await call('DELETE', `/api/chat/projects/${project.id}`)).status, 200)
  assert.deepEqual((await call('GET', '/api/chat/task-folders')).body.folders, {})
})

test('a chat keeps a taskId written to it', async () => {
  const put = await call('PUT', '/api/threads/thread-task-link', { taskId: 'abc-123', messages: [] })
  assert.equal(put.status, 200)
  assert.equal(put.body.taskId, 'abc-123')
})
