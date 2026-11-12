// Run with: node --test chat/files-bridge.test.mjs
//
// The auth of the chat-file routes against a real bridge.mjs. A reply's file link
// once opened `{"error":"unauthorized"}` in the canvas: the dashboard was unlocked
// with BRIDGE_SECRET (no session cookie), and the canvas read the file without the
// bearer. Every opener now reads from a signed link (chat/files.mjs link()), and
// that link must open exactly its file without credentials and nothing else.
//
// The bridge runs from a shadow checkout (a temp dir of symlinks to this repo with
// its own empty data/), on its own port, with no scheduler, and is stopped at the end.

import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { connect, createServer } from 'node:net'
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const SECRET = 'files-bridge-test-secret'

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
const bearer = { authorization: `Bearer ${SECRET}` }
const get = (path, { headers = {}, method = 'GET' } = {}) => fetch(`${B.base}${path}`, { method, headers, redirect: 'manual' })
const raw = (p) => `/api/chat/files/raw?path=${encodeURIComponent(p)}`

before(async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'totem-files-bridge-')))
  for (const entry of readdirSync(REPO)) {
    if (entry === 'data' || entry === '.env' || entry === '.git' || entry === 'AGENTS.local.md') continue
    symlinkSync(join(REPO, entry), join(root, entry))
  }
  B.root = root
  B.thread = join(root, 'data', 'chat-outputs', 'thread-files-1')
  mkdirSync(B.thread, { recursive: true })
  mkdirSync(join(root, 'home'))
  B.page = join(B.thread, 'stays.html')
  B.other = join(B.thread, 'other.txt')
  writeFileSync(B.page, '<!doctype html><h1>Stays</h1>')
  writeFileSync(B.other, 'other')
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

test('the raw route still needs a sign-in or the bearer', async () => {
  assert.equal((await get(raw(B.page))).status, 401)
  const r = await get(raw(B.page), { headers: bearer })
  assert.equal(r.status, 200)
  assert.equal(await r.text(), '<!doctype html><h1>Stays</h1>')
})

test('a link is minted only for a caller already in, and only for a file Totem shares', async () => {
  assert.equal((await get(`/api/chat/files/link?path=${encodeURIComponent(B.page)}`)).status, 401)
  const r = await get(`/api/chat/files/link?path=${encodeURIComponent(B.page)}`, { headers: bearer })
  assert.equal(r.status, 200)
  const link = await r.json()
  assert.equal(link.path, B.page)
  assert.equal(link.mime, 'text/html')
  assert.match(link.url, /^\/api\/chat\/files\/raw\?path=.+&exp=\d+&sig=[\w-]{43}$/)
  assert.equal((await get(`/api/chat/files/link?path=${encodeURIComponent(join(B.root, 'data', 'auth.json'))}`, { headers: bearer })).status, 403)
  assert.equal((await get(`/api/chat/files/link?path=${encodeURIComponent('/etc/passwd')}`, { headers: bearer })).status, 403)
})

test('a signed link opens its file with no credentials at all, HEAD included', async () => {
  const { url } = await (await get(`/api/chat/files/link?path=${encodeURIComponent(B.page)}`, { headers: bearer })).json()
  const r = await get(url)
  assert.equal(r.status, 200)
  assert.equal(await r.text(), '<!doctype html><h1>Stays</h1>')
  // HTML from Totem's origin is never shown as a page: the canvas sandboxes it.
  assert.match(r.headers.get('content-disposition'), /^attachment/)
  const head = await get(url, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-length'), String('<!doctype html><h1>Stays</h1>'.length))
  assert.match((await get(`${url}&download=1`)).headers.get('content-disposition'), /^attachment/)
})

test('a signature opens nothing but its own path, in its own spelling', async () => {
  const { url } = await (await get(`/api/chat/files/link?path=${encodeURIComponent(B.page)}`, { headers: bearer })).json()
  const q = new URL(url, B.base).searchParams
  const swapped = `/api/chat/files/raw?path=${encodeURIComponent(B.other)}&exp=${q.get('exp')}&sig=${q.get('sig')}`
  assert.equal((await get(swapped)).status, 401)
  const tampered = url.replace(/sig=([\w-])/, (_, c) => `sig=${c === 'A' ? 'B' : 'A'}`)
  assert.equal((await get(tampered)).status, 401)
  const later = url.replace(/exp=(\d+)/, (_, n) => `exp=${Number(n) + 1}`)
  assert.equal((await get(later)).status, 401)
  // Another spelling of the route goes through the sign-in gate, signature or not.
  assert.equal((await get(url.replace('/api/chat/files/raw?', '/api/chat/files/raw/?'))).status, 401)
  assert.equal((await get(url.replace('/api/', '/api//'))).status, 401)
  // The signature is not a sign-in: it opens no other route.
  assert.equal((await get(`/api/chat/files?thread=thread-files-1&sig=${q.get('sig')}`)).status, 401)
})

test('the listing carries no links: a row signs its file when it is clicked', async () => {
  const { entries } = await (await get('/api/chat/files?thread=thread-files-1', { headers: bearer })).json()
  assert.ok(entries.some((e) => e.path === B.page))
  assert.ok(entries.every((e) => e.url === undefined))
})
