// mcp-gateway.mjs — one MCP server to rule them all.
//
// The problem this solves: every agent runtime (cursor-agent, codex, claude,
// opencode) is its own MCP *client* with its own config and its own auth store.
// Wiring N app servers into M runtimes is an N×M setup-and-auth chore.
//
// This gateway collapses that. It is a single MCP server that the runtimes
// connect to. Behind the scenes it is itself an MCP *client* to every enabled
// server in data/mcp-manifest.json (Calendar, Plaud, …), holding their auth in
// one place, plus Totem's in-process local tasks. It aggregates those tools under one roof —
// namespaced as `<serverId>__<toolName>` — and routes each tool call to the
// right downstream server. So a runtime registers ONE connection (this script)
// and instantly sees every app's tools.
//
// Transport to the runtime: MCP stdio (newline-delimited JSON-RPC 2.0 on
// stdin/stdout). Transport to downstreams: stdio (child process) or Streamable
// HTTP. Zero external dependencies — pure Node, matching the bridge's ethos.
//
// Usage:
//   node mcp-gateway.mjs            # serve over stdio (what runtimes spawn)
//   node mcp-gateway.mjs --status   # connect to all downstreams, print JSON
//                                    # health (per-server tool counts), exit
//
// Manifest path comes from $MCP_MANIFEST_FILE, else ./data/mcp-manifest.json.

import { spawn } from 'node:child_process'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { createActionLog } from './logs/store.mjs'
import { createTodoCommands } from './todos/commands.mjs'
import { closeTodoDatabase, openTodoDatabase } from './todos/db.mjs'
import { createTodoMcpClient } from './todos/mcp.mjs'
import { createGoalMcpClient } from './goals/mcp.mjs'
import { createGoalService } from './goals/service.mjs'
import { createListMcpClient } from './lists/mcp.mjs'
import { createListService } from './lists/service.mjs'
import { createTodoService } from './todos/service.mjs'

const HERE = import.meta.dirname
const MANIFEST_FILE = process.env.MCP_MANIFEST_FILE || join(HERE, 'data', 'mcp-manifest.json')
// OAuth tokens the bridge stored for remote servers (one file per server id). The
// gateway reads these to authenticate, and refreshes them in place when they age.
const OAUTH_DIR = process.env.GATEWAY_OAUTH_DIR || join(HERE, 'secrets', 'gateway-oauth')
const PROTOCOL_VERSION = '2025-06-18'
// 1.2.0: the `goals` builtin joined `tasks` and `strava`, adding goals__* to the
// aggregated surface. Bumped so a client that cached the old tool list re-reads it.
// 1.2.1: goal tools explicitly advertise weekly, monthly, quarterly, and yearly periods.
// 1.3.0 adds the in-process lists__* surface.
// 1.4.0 adds search__everything and search__read.
const GATEWAY_INFO = { name: 'totem-gateway', version: '1.4.0' }
export const NS = '__' // namespace separator: <serverId>__<toolName>

// stderr only — stdout is the JSON-RPC channel and must stay clean.
const logErr = (...a) => process.stderr.write(`${new Date().toISOString()} [gateway] ${a.join(' ')}\n`)

// ---------------------------------------------------------------------------
// OAuth token store (shared with the bridge, which runs the interactive flow).
// ---------------------------------------------------------------------------

async function loadToken(id) {
  try { return JSON.parse(await readFile(join(OAUTH_DIR, `${id}.json`), 'utf8')) }
  catch { return null }
}

async function saveToken(id, token) {
  await mkdir(OAUTH_DIR, { recursive: true })
  const path = join(OAUTH_DIR, `${id}.json`)
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify({ ...token, updatedAt: new Date().toISOString() }, null, 2))
  await rename(tmp, path)
}

// Exchange the refresh token for a fresh access token and persist it, so the next
// gateway spawn (and every provider behind it) inherits the renewed credential.
async function refreshToken(id, token) {
  if (!token?.refreshToken || !token?.tokenEndpoint) throw new Error('no refresh token')
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refreshToken, client_id: token.clientId })
  if (token.scope) body.set('scope', token.scope)
  if (token.resource) body.set('resource', token.resource)
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
  if (token.clientSecret) headers.authorization = `Basic ${Buffer.from(`${token.clientId}:${token.clientSecret}`).toString('base64')}`
  const r = await fetch(token.tokenEndpoint, { method: 'POST', headers, body: body.toString() })
  if (!r.ok) throw new Error(`token refresh failed (HTTP ${r.status})`)
  const j = await r.json()
  if (!j.access_token) throw new Error('refresh returned no access_token')
  const next = {
    ...token,
    accessToken: j.access_token,
    refreshToken: j.refresh_token || token.refreshToken,
    expiresAt: j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : 0,
  }
  await saveToken(id, next)
  return next
}

async function ensureFreshToken(id, token, force = false) {
  if (!token) return token
  const expiringSoon = token.expiresAt && token.expiresAt < Date.now() + 60_000
  if ((force || expiringSoon) && token.refreshToken) {
    try { return await refreshToken(id, token) } catch (e) { logErr(`token refresh for "${id}" failed:`, e.message || e); return token }
  }
  return token
}

// ---------------------------------------------------------------------------
// Downstream clients. Each speaks MCP as a *client* to one app server and
// exposes a uniform { start, listTools, callTool, close } surface to the hub.
// ---------------------------------------------------------------------------

// JSON-RPC over a child process's stdio (the common, headless-friendly case:
// npx @cocal/google-calendar-mcp and similar local connectors).
class StdioClient {
  constructor(id, spec) {
    this.id = id
    this.spec = spec
    this.child = null
    this.nextId = 1
    this.pending = new Map()
    this.closed = false
  }

  async start() {
    this.child = spawn(this.spec.command, this.spec.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.spec.env || {}) },
    })
    this.child.on('error', (e) => this.fail(e))
    this.child.on('exit', (code) => this.fail(new Error(`exited (code ${code})`)))
    // Surface downstream stderr into our stderr for debugging, prefixed.
    createInterface({ input: this.child.stderr }).on('line', (l) => {
      if (l.trim()) logErr(`<${this.id}>`, l)
    })
    const rl = createInterface({ input: this.child.stdout })
    rl.on('line', (line) => {
      const t = line.trim()
      if (t) this.onMessage(t)
    })
    await this.handshake()
  }

  fail(err) {
    if (this.closed) return
    this.closed = true
    const e = err instanceof Error ? err : new Error(String(err))
    for (const { reject } of this.pending.values()) reject(e)
    this.pending.clear()
  }

  write(obj) {
    if (!this.child || this.closed) throw new Error(`${this.id} not running`)
    this.child.stdin.write(`${JSON.stringify(obj)}\n`)
  }

  request(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try { this.write({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) }
      catch (e) { this.pending.delete(id); reject(e) }
    })
  }

  notify(method, params) {
    this.write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })
  }

  onMessage(text) {
    let msg
    try { msg = JSON.parse(text) } catch { return }
    // Response to one of our requests.
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message || 'downstream error'))
      else p.resolve(msg.result)
      return
    }
    // Server-initiated request: we can't satisfy roots/sampling, but we must not
    // leave it hanging. Answer ping; politely decline the rest.
    if (msg.id != null && msg.method) {
      if (msg.method === 'ping') this.write({ jsonrpc: '2.0', id: msg.id, result: {} })
      else this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported by gateway' } })
    }
  }

  async handshake() {
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: GATEWAY_INFO,
    })
    this.notify('notifications/initialized')
  }

  async listTools() {
    const tools = []
    let cursor
    do {
      const res = await this.request('tools/list', cursor ? { cursor } : undefined)
      for (const t of res?.tools || []) tools.push(t)
      cursor = res?.nextCursor
    } while (cursor)
    return tools
  }

  callTool(name, args) {
    return this.request('tools/call', { name, arguments: args || {} })
  }

  close() {
    this.closed = true
    try { this.child?.kill() } catch {}
  }
}

// JSON-RPC over MCP Streamable HTTP (remote servers like mcp.plaud.ai). Handles
// both the application/json and text/event-stream response shapes, and carries
// the Mcp-Session-Id handed back at initialize. OAuth-gated servers answer the
// initialize POST with 401 — we surface that as a clear needs-auth error rather
// than hanging; automated OAuth is a planned follow-up.
class HttpClient {
  constructor(id, spec) {
    this.id = id
    this.spec = spec
    this.nextId = 1
    this.sessionId = null
    this.token = null
    this.closed = false
  }

  headers() {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.spec.headers || {}),
      ...(this.token?.accessToken ? { authorization: `Bearer ${this.token.accessToken}` } : {}),
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
    }
  }

  async rpc(method, params, opts = {}) {
    return await this._rpc(method, params, opts, true)
  }

  // A single 401 → refresh → retry: a stored token may have lapsed since the last
  // gateway run. If refresh fails (or there's nothing to refresh with), surface
  // needsAuth so the dashboard prompts a fresh sign-in.
  async _rpc(method, params, { notification = false } = {}, allowRefresh = true) {
    const body = { jsonrpc: '2.0', method, ...(params ? { params } : {}) }
    if (!notification) body.id = this.nextId++
    const res = await fetch(this.spec.url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) })
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid
    if (res.status === 401 || res.status === 403) {
      if (allowRefresh) {
        try {
          // Try a token refresh first; if there's nothing to refresh with (e.g.
          // GitHub OAuth Apps issue no refresh token), reload from disk — the
          // bridge may have written a freshly re-authenticated token (e.g. with
          // wider scopes) since this gateway process started.
          if (this.token?.refreshToken) this.token = await refreshToken(this.id, this.token)
          else {
            const reloaded = await loadToken(this.id)
            if (reloaded?.accessToken && reloaded.accessToken !== this.token?.accessToken) this.token = reloaded
            else throw new Error('no fresher token')
          }
          return await this._rpc(method, params, { notification }, false)
        } catch {}
      }
      const e = new Error('needs authentication')
      e.needsAuth = true
      throw e
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (notification || res.status === 202) return null
    return await this.readRpcResult(res, body.id)
  }

  // A Streamable-HTTP response is either a single JSON-RPC object or an SSE
  // stream of them. Either way we want the result whose id matches our request.
  async readRpcResult(res, wantId) {
    const ctype = res.headers.get('content-type') || ''
    const text = await res.text()
    let payload = null
    if (ctype.includes('text/event-stream')) {
      for (const block of text.split(/\n\n/)) {
        const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
        if (!data) continue
        try {
          const obj = JSON.parse(data)
          if (obj.id === wantId) { payload = obj; break }
          if (payload == null) payload = obj
        } catch {}
      }
    } else {
      try { payload = JSON.parse(text) } catch { throw new Error('bad JSON from server') }
    }
    if (!payload) throw new Error('empty response')
    if (payload.error) throw new Error(payload.error.message || 'downstream error')
    return payload.result
  }

  async start() {
    this.token = await ensureFreshToken(this.id, await loadToken(this.id))
    await this.rpc('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: GATEWAY_INFO })
    await this.rpc('notifications/initialized', undefined, { notification: true })
  }

  async listTools() {
    const tools = []
    let cursor
    do {
      const res = await this.rpc('tools/list', cursor ? { cursor } : undefined)
      for (const t of res?.tools || []) tools.push(t)
      cursor = res?.nextCursor
    } while (cursor)
    return tools
  }

  callTool(name, args) {
    return this.rpc('tools/call', { name, arguments: args || {} })
  }

  close() { this.closed = true }
}

// ---------------------------------------------------------------------------
// Built-in downstreams: local in-process capabilities plus selected slices of
// the BRIDGE's own MCP server (/mcp), re-served under short namespaces.
//
// The bridge holds connectors that are not MCP servers of their own — Strava is
// the first — and exposes them as totem_strava_* tools on /mcp for ChatGPT and
// Claude. The local agent CLIs talk to this gateway, not to /mcp, so without
// this they would have no tool for "how far did I ride". Local tasks do not dial
// the bridge: they open the same SQLite database directly, so they need no
// BRIDGE_SECRET and cannot recurse. Rather than teach every runtime a second
// connection for Strava, the gateway dials the bridge over loopback with
// the bridge secret and shows only the matching tools, renamed
// (totem_strava_get_mileage → strava__get_mileage). The rest of /mcp — the
// calendar/note writes and the approval gate — is deliberately NOT re-served
// here: the CLIs have Calendar via the manifest and local tasks in process, and an
// agent queueing prompts for another agent is a loop nobody asked for.
//
// Credentials come from the environment (the bridge exports them to the CLIs it
// spawns) or from the repo's .env (for a Claude Code session started from a
// terminal). Without a secret, local tasks still work and the Strava slice is omitted.
// ---------------------------------------------------------------------------
const BUILTIN_SERVERS = {
  tasks: { description: 'Totem local tasks, in process' },
  goals: { description: "Totem weekly goals and their metrics, in process" },
  lists: { description: 'Totem checklists and their related tasks, in process' },
  strava: { filter: /^totem_strava_/, strip: 'totem_strava_', description: 'Strava, via the Totem bridge' },
  // search__everything / search__read: the bridge's keyword index over notes,
  // journal, chats, tasks, goals, lists and project/totem memory. No model involved.
  search: { filter: /^totem_search_(everything|read)$/, strip: 'totem_search_', description: 'Totem search across memory, chats, journal, tasks, goals and lists, via the Totem bridge' },
  // The chat's browser (bridge /agent-mcp). Only inside a chat run: the bridge
  // hands each run a token in TOTEM_BROWSER_TOKEN, which binds the tools to that
  // chat's browser. Claude and Codex get /agent-mcp directly; this is how Cursor
  // and OpenCode, which take no per-run MCP flag, reach the same browser.
  browser: { filter: /^preview_/, strip: '', description: "The chat's browser, via the Totem bridge" },
}

function unavailableConnector(name) {
  const fail = async () => { throw new Error(`${name} task sync is not configured`) }
  return {
    create: fail,
    rename: fail,
    updateLinked: fail,
    appendNote: fail,
    bulk: fail,
    refreshTask: fail,
    share: fail,
  }
}

function defaultTaskClient() {
  const databaseFile = process.env.TODO_DATABASE_FILE || join(HERE, 'data', 'todos.db')
  const db = openTodoDatabase({ file: databaseFile })
  const actionLog = createActionLog({
    file: process.env.ACTION_LOG_FILE || join(HERE, 'data', 'action-log.jsonl'),
    log: (...parts) => logErr(...parts),
  })
  const service = createTodoService({ db, actionLog })
  const commands = createTodoCommands({
    service,
    github: unavailableConnector('GitHub'),
    sheet: unavailableConnector('Google Sheet'),
    maintenance: { async purgeDeleted() { throw new Error('Task maintenance is unavailable through MCP') } },
  })
  const client = createTodoMcpClient({ service, commands })
  const close = client.close.bind(client)
  client.close = () => {
    close()
    closeTodoDatabase(db)
  }
  return client
}

function defaultGoalClient() {
  const databaseFile = process.env.TODO_DATABASE_FILE || join(HERE, 'data', 'todos.db')
  const db = openTodoDatabase({ file: databaseFile })
  const actionLog = createActionLog({
    file: process.env.ACTION_LOG_FILE || join(HERE, 'data', 'action-log.jsonl'),
    log: (...parts) => logErr(...parts),
  })
  // No Strava client here on purpose. This process holds no Strava grant, so a sourced
  // metric resolves to "unavailable" with a reason rather than to zero — which is the
  // honest answer, and the same one the bridge gives before the connector is wired up.
  const service = createGoalService({ db, actionLog, strava: null })
  const client = createGoalMcpClient({ service })
  const close = client.close.bind(client)
  client.close = () => {
    close()
    closeTodoDatabase(db)
  }
  return client
}

function defaultListClient() {
  const databaseFile = process.env.TODO_DATABASE_FILE || join(HERE, 'data', 'todos.db')
  const db = openTodoDatabase({ file: databaseFile })
  const actionLog = createActionLog({
    file: process.env.ACTION_LOG_FILE || join(HERE, 'data', 'action-log.jsonl'),
    log: (...parts) => logErr(...parts),
  })
  const service = createListService({ db, actionLog })
  const client = createListMcpClient({ service })
  const close = client.close.bind(client)
  client.close = () => { close(); closeTodoDatabase(db) }
  return client
}

function parseEnvFile(file) {
  const out = {}
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(?:#.*)?$/)
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch { /* no .env here */ }
  return out
}

let bridgeCredsCache
function bridgeCredentials() {
  if (bridgeCredsCache !== undefined) return bridgeCredsCache
  const file = parseEnvFile(join(HERE, '.env'))
  const secret = process.env.BRIDGE_SECRET || file.BRIDGE_SECRET || ''
  const port = process.env.BRIDGE_PORT || file.BRIDGE_PORT || '8787'
  bridgeCredsCache = secret ? { secret, port, url: `http://127.0.0.1:${port}/mcp` } : null
  return bridgeCredsCache
}

// An HttpClient that sees only part of the bridge's tool list, under short names.
class TotemSliceClient extends HttpClient {
  constructor(id, spec, { filter, strip }) {
    super(id, spec)
    this.filter = filter
    this.strip = strip
  }

  async listTools() {
    const all = await super.listTools()
    return all
      .filter((t) => this.filter.test(t.name))
      .map((t) => ({ ...t, name: t.name.slice(this.strip.length) }))
  }

  callTool(name, args) {
    return super.callTool(`${this.strip}${name}`, args)
  }
}

function makeClient(id, spec) {
  if (spec.client) return spec.client
  if (spec.builtin) return new TotemSliceClient(id, spec, BUILTIN_SERVERS[id])
  if (spec.transport === 'http' || spec.url) return new HttpClient(id, spec)
  return new StdioClient(id, spec)
}

// ---------------------------------------------------------------------------
// The hub. Connects every enabled downstream, builds the aggregated tool table,
// and serves a single MCP server over stdio.
// ---------------------------------------------------------------------------

export class Gateway {
  // `builtins: false` is what the bridge passes when it runs this class
  // in-process for its own /mcp pass-through — a builtin there would be the
  // bridge dialling itself.
  constructor(manifest, { builtins = true, taskClient, goalClient, listClient } = {}) {
    if (manifest?.servers && Object.hasOwn(manifest.servers, 'tasks')) {
      throw new Error('MCP manifest server id "tasks" is reserved for Totem local tasks')
    }
    if (manifest?.servers && Object.hasOwn(manifest.servers, 'goals')) {
      throw new Error('MCP manifest server id "goals" is reserved for Totem goals')
    }
    if (manifest?.servers && Object.hasOwn(manifest.servers, 'lists')) {
      throw new Error('MCP manifest server id "lists" is reserved for Totem lists')
    }
    this.manifest = manifest
    this.builtins = builtins
    this.taskClient = taskClient
    this.goalClient = goalClient
    this.listClient = listClient
    this.clients = new Map()        // id -> client
    this.health = new Map()         // id -> { ok, transport, toolCount, error, tools }
    this.toolIndex = new Map()      // namespacedName -> { clientId, name }
    this.tools = []                 // aggregated tool descriptors (runtime-facing)
  }

  enabledServers() {
    return Object.entries(this.manifest.servers || {}).filter(([, s]) => s && s.enabled !== false)
  }

  // The bridge slices, when credentials are at hand. A manifest entry with the
  // same id wins — someone who wired their own "strava" server meant it.
  builtinServers() {
    if (!this.builtins) return []
    const creds = bridgeCredentials()
    const manifestIds = new Set(this.enabledServers().map(([id]) => id))
    return Object.entries(BUILTIN_SERVERS)
      .filter(([id]) => !manifestIds.has(id))
      .flatMap(([id, def]) => {
        if (id === 'tasks') {
          this.taskClient ||= defaultTaskClient()
          return [[id, {
            builtin: true,
            transport: 'in-process',
            client: this.taskClient,
            description: def.description,
          }]]
        }
        if (id === 'goals') {
          this.goalClient ||= defaultGoalClient()
          return [[id, {
            builtin: true,
            transport: 'in-process',
            client: this.goalClient,
            description: def.description,
          }]]
        }
        if (id === 'lists') {
          this.listClient ||= defaultListClient()
          return [[id, {
            builtin: true,
            transport: 'in-process',
            client: this.listClient,
            description: def.description,
          }]]
        }
        if (id === 'browser') {
          // A literal ${env:…} means the client didn't interpolate: no run, no browser.
          const token = process.env.TOTEM_BROWSER_TOKEN
          if (!token || token.includes('${')) return []
          const given = process.env.TOTEM_BROWSER_URL || ''
          const url = /^http:\/\/127\.0\.0\.1:\d+\/agent-mcp$/.test(given) ? given : `http://127.0.0.1:${creds?.port || process.env.BRIDGE_PORT || '8787'}/agent-mcp`
          return [[id, { builtin: true, transport: 'http', url, headers: { authorization: `Bearer ${token}` }, description: def.description }]]
        }
        if (!creds) return []
        return [[id, { builtin: true, transport: 'http', url: creds.url, headers: { authorization: `Bearer ${creds.secret}` }, description: def.description }]]
      })
  }

  allServers() {
    return [...this.enabledServers(), ...this.builtinServers()]
  }

  // Connect to every downstream in parallel and pull its tool list. One bad
  // server never sinks the others — it just lands in `health` with an error
  // and contributes no tools.
  async connectAll() {
    await Promise.all(this.allServers().map(async ([id, spec]) => {
      const transport = spec.transport === 'in-process' ? 'in-process' : spec.transport === 'http' || spec.url ? 'http' : 'stdio'
      const client = makeClient(id, spec)
      try {
        await client.start()
        const tools = await client.listTools()
        this.clients.set(id, client)
        for (const tool of tools) {
          const ns = `${id}${NS}${tool.name}`
          this.toolIndex.set(ns, { clientId: id, name: tool.name })
          this.tools.push({
            ...tool,
            name: ns,
            description: `[${id}] ${tool.description || ''}`.trim(),
          })
        }
        this.health.set(id, { ok: true, transport, toolCount: tools.length, tools: tools.map((t) => t.name), ...(spec.builtin ? { builtin: true } : {}) })
      } catch (e) {
        client.close?.()
        this.health.set(id, { ok: false, transport, toolCount: 0, needsAuth: Boolean(e.needsAuth), error: e.message || String(e), ...(spec.builtin ? { builtin: true } : {}) })
        logErr(`downstream "${id}" failed:`, e.message || e)
      }
    }))
  }

  statusReport() {
    return {
      gateway: GATEWAY_INFO,
      manifest: MANIFEST_FILE,
      generatedAt: new Date().toISOString(),
      totalTools: this.tools.length,
      servers: this.allServers().map(([id]) => ({ id, ...(this.health.get(id) || { ok: false, error: 'not attempted' }) })),
    }
  }

  async callTool(namespaced, args) {
    const target = this.toolIndex.get(namespaced)
    if (!target) throw new Error(`unknown tool: ${namespaced}`)
    const client = this.clients.get(target.clientId)
    if (!client) throw new Error(`downstream "${target.clientId}" is not connected`)
    return await client.callTool(target.name, args)
  }

  closeAll() {
    for (const c of this.clients.values()) c.close?.()
  }

  // --- runtime-facing MCP server (stdio) ---

  serve() {
    const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)
    const reply = (id, result) => out({ jsonrpc: '2.0', id, result })
    const fail = (id, code, message) => out({ jsonrpc: '2.0', id, error: { code, message } })

    const rl = createInterface({ input: process.stdin })
    rl.on('line', async (line) => {
      const t = line.trim()
      if (!t) return
      let msg
      try { msg = JSON.parse(t) } catch { return }
      const { id, method, params } = msg
      // Notifications (no id) need no response.
      if (id == null) return

      try {
        if (method === 'initialize') {
          reply(id, {
            protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: GATEWAY_INFO,
            instructions:
              'Aggregated app tools from the Totem gateway. Tools are namespaced as ' +
              '"<app>__<tool>" (e.g. tasks__create_task, google-calendar__list-events). ' +
              'Use tasks__* for Totem\'s local Personal and Ventures tasks; tasks stay local ' +
              'unless syncTarget explicitly names github or sheet. strava__* tools are ' +
              'Totem\'s own Strava connector (rides, runs, mileage, gear odometers); every ' +
              'quantity carries both unit systems and dates are the athlete\'s local date. ' +
              'goals__* are his weekly, monthly, quarterly, and yearly goals: create a whole period in one goals__create_goals ' +
              'call with a clientKey so a re-import updates rather than duplicating, resolve a name ' +
              'with goals__find_goals before acting, and never postpone or complete one without ' +
              'asking him first — completion is his to assert, and the postponed count is the only ' +
              'record of what he has quietly stopped doing.',
          })
        } else if (method === 'ping') {
          reply(id, {})
        } else if (method === 'tools/list') {
          reply(id, { tools: this.tools })
        } else if (method === 'tools/call') {
          try {
            const result = await this.callTool(params?.name, params?.arguments)
            reply(id, result)
          } catch (e) {
            // Surface tool failures as an MCP tool error, not a protocol error,
            // so the model sees the message and can react.
            reply(id, { isError: true, content: [{ type: 'text', text: `Gateway: ${e.message || e}` }] })
          }
        } else {
          fail(id, -32601, `method not found: ${method}`)
        }
      } catch (e) {
        fail(id, -32603, e.message || String(e))
      }
    })
    logErr(`serving ${this.tools.length} tools from ${this.clients.size}/${this.allServers().length} servers`)
  }
}

// ---------------------------------------------------------------------------

export async function loadManifest() {
  try { return JSON.parse(await readFile(MANIFEST_FILE, 'utf8')) }
  catch { return { servers: {} } }
}

async function main() {
  const statusMode = process.argv.includes('--status')
  const manifest = await loadManifest()
  const gateway = new Gateway(manifest)
  await gateway.connectAll()

  if (statusMode) {
    process.stdout.write(`${JSON.stringify(gateway.statusReport(), null, 2)}\n`)
    gateway.closeAll()
    process.exit(0)
  }

  gateway.serve()
  const shutdown = () => { gateway.closeAll(); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.stdin.on('close', shutdown)
}

// Only serve when run as a script. bridge.mjs imports Gateway to expose the same
// downstreams over its own /mcp endpoint, and an import must not seize stdio.
const isEntry = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isEntry) main().catch((e) => { logErr('fatal:', e.message || e); process.exit(1) })
