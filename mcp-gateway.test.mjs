// A downstream that hangs or pages forever must not stop the gateway serving (#149).
// Every server here is a local fixture: a child process (fixtures/mcp-gateway) or
// an http.createServer on 127.0.0.1. Nothing reaches the network or the real
// manifest, and every test checks the processes it started are gone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

// The gateway reads its OAuth token directory once, at import.
const OAUTH_DIR = mkdtempSync(join(tmpdir(), 'totem-gateway-oauth-'))
process.env.GATEWAY_OAUTH_DIR = OAUTH_DIR
process.on('exit', () => rmSync(OAUTH_DIR, { recursive: true, force: true }))
const { Gateway } = await import('./mcp-gateway.mjs')

const HERE = import.meta.dirname
const GATEWAY = join(HERE, 'mcp-gateway.mjs')
const FIXTURE = join(HERE, 'fixtures', 'mcp-gateway', 'stdio-server.mjs')
const FAST = { handshakeMs: 300, pageMs: 300, serverMs: 800 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A port nothing listens on, so a built-in bridge slice (when a .env supplies a
// secret) is refused at once instead of reaching a running bridge.
const closedPort = await new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})
process.env.BRIDGE_PORT = String(closedPort)
delete process.env.TOTEM_BROWSER_TOKEN

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const readPids = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number) : [])

// A temp dir and the pid file fixtures append to. Whatever a test started is
// killed afterwards, even if it failed half way: after hooks run in the order
// they were registered, so the reaping goes first, while the pid file still exists.
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'totem-gateway-test-'))
  const pidFile = join(dir, 'pids')
  t.after(() => { for (const pid of readPids(pidFile)) { try { process.kill(pid, 'SIGKILL') } catch {} } })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, pidFile }
}

async function waitFor(check, ms = 3000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await sleep(25)
  }
  return check()
}

function stdioServer(mode, pidFile, env = {}) {
  return { transport: 'stdio', command: process.execPath, args: [FIXTURE, mode], env: { FIXTURE_PID_FILE: pidFile, ...env } }
}

// Stand-ins for the in-process built-ins, so no test opens the task database.
function fakeBuiltin(name) {
  return {
    async start() {},
    async listTools() { return [{ name, description: name, inputSchema: { type: 'object' } }] },
    async callTool() { return { content: [{ type: 'text', text: name }] } },
    close() {},
  }
}
const builtins = () => ({ taskClient: fakeBuiltin('get_tasks'), goalClient: fakeBuiltin('get_goals'), listClient: fakeBuiltin('get_lists') })

test('a hung stdio server times out at initialize, is killed with its children, and built-ins still list', { timeout: 10_000 }, async (t) => {
  const { pidFile } = tempDir(t)
  const gateway = new Gateway({ servers: { stuck: stdioServer('launcher', pidFile) } }, { ...builtins(), timeouts: FAST })
  t.after(() => gateway.closeAll())

  const started = Date.now()
  await gateway.connectAll()
  assert.ok(Date.now() - started < FAST.serverMs + 1000, 'connectAll settles within the budget')

  const names = gateway.tools.map((tool) => tool.name)
  assert.ok(names.includes('tasks__get_tasks') && names.includes('goals__get_goals') && names.includes('lists__get_lists'))
  assert.ok(!names.some((n) => n.startsWith('stuck__')))

  const health = gateway.health.get('stuck')
  assert.equal(health.ok, false)
  assert.equal(health.timedOut, true)
  assert.equal(health.phase, 'initialize')
  assert.match(health.error, /no answer to initialize after 300ms/)
  assert.equal(gateway.statusReport().servers.find((s) => s.id === 'stuck').timedOut, true)

  await waitFor(() => readPids(pidFile).length === 2)
  const pids = readPids(pidFile)
  assert.equal(pids.length, 2, 'the launcher and the server it started')
  assert.ok(await waitFor(() => pids.every((pid) => !alive(pid))), 'launcher and server are both gone, though the server ignores SIGTERM')
})

test('a server that repeats its tools/list cursor stops on the repeat', { timeout: 10_000 }, async (t) => {
  const { pidFile } = tempDir(t)
  const gateway = new Gateway({ servers: { loop: stdioServer('repeat-cursor', pidFile) } }, { builtins: false, timeouts: FAST })
  await gateway.connectAll()
  const health = gateway.health.get('loop')
  assert.equal(health.ok, true)
  assert.deepEqual(health.tools, ['echo'])
  assert.match(health.warning, /repeated a cursor/)
  assert.deepEqual(gateway.tools.map((tool) => tool.name), ['loop__echo'])
  gateway.closeAll()
  assert.ok(await waitFor(() => readPids(pidFile).every((pid) => !alive(pid))))
})

test('a server that pages for ever stops at the page cap', { timeout: 10_000 }, async (t) => {
  const { pidFile } = tempDir(t)
  const gateway = new Gateway({ servers: { endless: stdioServer('endless', pidFile) } }, { builtins: false, timeouts: { ...FAST, maxPages: 5 } })
  await gateway.connectAll()
  const health = gateway.health.get('endless')
  assert.equal(health.ok, true)
  assert.equal(health.toolCount, 5)
  assert.match(health.warning, /after 5 pages/)
  gateway.closeAll()
  assert.ok(await waitFor(() => readPids(pidFile).every((pid) => !alive(pid))))
})

test('an HTTP server that never answers, or stalls mid-body, is aborted with the same health', { timeout: 10_000 }, async (t) => {
  const closedRequests = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const msg = JSON.parse(body)
      res.on('close', () => closedRequests.push(`${req.url} ${msg.method}`))
      if (req.url === '/silent') return // never answers at all
      // /stalls: a normal handshake, then tools/list sends its SSE headers and stops.
      if (msg.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'stalls', version: '1' } } }))
      }
      if (msg.id == null) { res.writeHead(202); return res.end() }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.flushHeaders()
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}`

  const gateway = new Gateway({
    servers: {
      silent: { transport: 'http', url: `${base}/silent` },
      stalls: { transport: 'http', url: `${base}/stalls` },
    },
  }, { builtins: false, timeouts: FAST })
  const started = Date.now()
  await gateway.connectAll()
  assert.ok(Date.now() - started < FAST.serverMs + 1000)

  const silent = gateway.health.get('silent')
  assert.equal(silent.timedOut, true)
  assert.equal(silent.phase, 'initialize')
  assert.match(silent.error, /no answer to initialize/)

  const stalls = gateway.health.get('stalls')
  assert.equal(stalls.timedOut, true)
  assert.equal(stalls.phase, 'tools/list')
  assert.match(stalls.error, /no answer to tools\/list/)

  // Both stuck requests were dropped by the gateway, not left open.
  assert.ok(await waitFor(() => closedRequests.includes('/silent initialize') && closedRequests.includes('/stalls tools/list')))
})

test('a tools/call slower than every connect timeout still succeeds', { timeout: 10_000 }, async (t) => {
  const { pidFile } = tempDir(t)
  const gateway = new Gateway({ servers: { slow: stdioServer('slow-call', pidFile, { FIXTURE_CALL_MS: '1200' }) } }, { builtins: false, timeouts: FAST })
  await gateway.connectAll()
  assert.equal(gateway.health.get('slow').ok, true)
  const result = await gateway.callTool('slow__slow_echo', {})
  assert.equal(result.content[0].text, 'done: slow_echo')
  gateway.closeAll()
  assert.ok(await waitFor(() => readPids(pidFile).every((pid) => !alive(pid))))
})

// The gateway as the CLIs run it: its own process, a temp manifest and temp data.
function gatewayEnv(dir, servers, timeouts) {
  const manifest = join(dir, 'manifest.json')
  writeFileSync(manifest, JSON.stringify({ servers }))
  return {
    ...process.env,
    MCP_MANIFEST_FILE: manifest,
    GATEWAY_OAUTH_DIR: join(dir, 'oauth'),
    TODO_DATABASE_FILE: join(dir, 'todos.db'),
    ACTION_LOG_FILE: join(dir, 'action-log.jsonl'),
    BRIDGE_PORT: String(closedPort),
    MCP_GATEWAY_HANDSHAKE_MS: String(timeouts.handshakeMs),
    MCP_GATEWAY_PAGE_MS: String(timeouts.pageMs),
    MCP_GATEWAY_SERVER_MS: String(timeouts.serverMs),
  }
}

function spawnGateway(t, args, env) {
  const child = spawn(process.execPath, [GATEWAY, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (c) => { stderr += c })
  t.after(() => { try { child.kill('SIGKILL') } catch {} })
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  return { child, exited, stderr: () => stderr }
}

test('--status against a hung manifest exits within the budget and names the hung server', { timeout: 15_000 }, async (t) => {
  const { dir, pidFile } = tempDir(t)
  const { child, exited, stderr } = spawnGateway(t, ['--status'], gatewayEnv(dir, { stuck: stdioServer('launcher', pidFile) }, FAST))
  let stdout = ''
  child.stdout.on('data', (c) => { stdout += c })
  const started = Date.now()
  const { code } = await exited
  assert.equal(code, 0, stderr())
  assert.ok(Date.now() - started < FAST.serverMs + 5000)

  const report = JSON.parse(stdout)
  const stuck = report.servers.find((s) => s.id === 'stuck')
  assert.equal(stuck.ok, false)
  assert.equal(stuck.timedOut, true)
  assert.equal(stuck.phase, 'initialize')
  assert.equal(report.servers.find((s) => s.id === 'tasks').ok, true)
  assert.ok(await waitFor(() => readPids(pidFile).length > 0 && readPids(pidFile).every((pid) => !alive(pid))))
})

test('serving: initialize is answered at once, tools/list waits for the budget and lists built-ins', { timeout: 15_000 }, async (t) => {
  const { dir, pidFile } = tempDir(t)
  const timeouts = { handshakeMs: 1500, pageMs: 1500, serverMs: 2000 }
  const { child, exited } = spawnGateway(t, [], gatewayEnv(dir, { stuck: stdioServer('launcher', pidFile) }, timeouts))
  const replies = new Map()
  createInterface({ input: child.stdout }).on('line', (line) => { const m = JSON.parse(line); replies.set(m.id, { ...m, at: Date.now() }) })
  const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)

  const started = Date.now()
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })
  assert.ok(await waitFor(() => replies.has(1), 5000))
  assert.ok(replies.get(1).at - started < timeouts.handshakeMs, 'initialize did not wait for the hung server')

  send({ method: 'notifications/initialized' })
  send({ id: 2, method: 'tools/list' })
  assert.ok(await waitFor(() => replies.has(2), 8000))
  const names = replies.get(2).result.tools.map((tool) => tool.name)
  assert.ok(names.includes('tasks__get_tasks'))
  assert.ok(!names.some((n) => n.startsWith('stuck__')))
  assert.ok(await waitFor(() => readPids(pidFile).every((pid) => !alive(pid))))

  child.stdin.end()
  assert.equal((await exited).code, 0)
})

test('SIGTERM while a server is still connecting takes its whole tree down', { timeout: 15_000 }, async (t) => {
  const { dir, pidFile } = tempDir(t)
  const timeouts = { handshakeMs: 60_000, pageMs: 60_000, serverMs: 60_000 }
  const { child, exited } = spawnGateway(t, [], gatewayEnv(dir, { stuck: stdioServer('launcher', pidFile) }, timeouts))
  assert.ok(await waitFor(() => readPids(pidFile).length === 2, 8000), 'launcher and server started')
  const pids = readPids(pidFile)
  child.kill('SIGTERM')
  const { code } = await exited
  assert.equal(code, 0, 'the handler ran rather than SIGTERM killing the gateway outright')
  assert.ok(await waitFor(() => pids.every((pid) => !alive(pid))), 'no downstream outlived the gateway')
})

// An OAuth-gated HTTP server whose token endpoint rotates refresh tokens: the old
// one is spent the moment the request is read, and the answer comes back slowly.
async function rotatingAuthServer(t, delayMs) {
  const state = { valid: 'rt-1', issued: 0 }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      if (req.url !== '/token') { res.writeHead(401); return res.end() }
      if (new URLSearchParams(body).get('refresh_token') !== state.valid) { res.writeHead(400); return res.end('{"error":"invalid_grant"}') }
      state.issued += 1
      state.valid = `rt-${state.issued + 1}`
      const answer = { access_token: `at-${state.issued}`, refresh_token: state.valid, expires_in: 3600 }
      setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer)) }, delayMs)
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}`
  const writeToken = (oauthDir, id) => {
    mkdirSync(oauthDir, { recursive: true })
    writeFileSync(join(oauthDir, `${id}.json`), JSON.stringify({ accessToken: 'at-0', refreshToken: 'rt-1', tokenEndpoint: `${base}/token`, clientId: 'c', expiresAt: Date.now() + 3600_000 }))
  }
  return { state, url: `${base}/mcp`, writeToken }
}

const savedRefreshToken = (oauthDir, id) => JSON.parse(readFileSync(join(oauthDir, `${id}.json`), 'utf8')).refreshToken

test('a handshake timeout during a token refresh still saves the rotated refresh token', { timeout: 10_000 }, async (t) => {
  const auth = await rotatingAuthServer(t, 600)
  auth.writeToken(OAUTH_DIR, 'rotating')
  const gateway = new Gateway({ servers: { rotating: { transport: 'http', url: auth.url } } }, { builtins: false, timeouts: { handshakeMs: 300, pageMs: 300, serverMs: 2000 } })
  await gateway.connectAll()

  const health = gateway.health.get('rotating')
  assert.equal(health.timedOut, true)
  assert.equal(health.phase, 'initialize')
  assert.equal(auth.state.issued, 1, 'the refresh reached the token server, so rt-1 is spent')
  assert.ok(await waitFor(() => savedRefreshToken(OAUTH_DIR, 'rotating') === auth.state.valid),
    `token file holds ${savedRefreshToken(OAUTH_DIR, 'rotating')}, the server only accepts ${auth.state.valid}`)
})

test('--status waits for a token refresh in flight before it exits', { timeout: 15_000 }, async (t) => {
  const { dir } = tempDir(t)
  const auth = await rotatingAuthServer(t, 600)
  auth.writeToken(join(dir, 'oauth'), 'rotating')
  const { child, exited, stderr } = spawnGateway(t, ['--status'], gatewayEnv(dir, { rotating: { transport: 'http', url: auth.url } }, FAST))
  let stdout = ''
  child.stdout.on('data', (c) => { stdout += c })
  const { code } = await exited
  assert.equal(code, 0, stderr())
  assert.equal(JSON.parse(stdout).servers.find((s) => s.id === 'rotating').timedOut, true)
  assert.equal(auth.state.issued, 1)
  assert.equal(savedRefreshToken(join(dir, 'oauth'), 'rotating'), auth.state.valid)
})
