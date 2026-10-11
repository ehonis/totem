// Claude Code's connector tools: what each Claude account can reach (its own MCP
// servers, claude.ai connectors, plugins), and which of them the owner has
// switched off in Settings → Connections.
//
// The catalog comes from Claude Code itself: `claude -p --output-format
// stream-json --verbose` prints a `system/init` event listing every tool and MCP
// server before it calls the model, so a pull reads that one line and kills the
// process. Nothing is sent to the model.
//
// The owner's choices become permission rules on every Claude run:
//   - an enabled server is allowed as `mcp__<server>`, so a print-mode run (which
//     cannot ask) may call it in every access mode, including tools a server only
//     lists once it has finished connecting;
//   - a disabled server or tool is denied, and deny rules win in every mode,
//     bypassPermissions included.

import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/** Claude Code's tool prefix for a server name: "claude.ai Microsoft 365" → "claude_ai_Microsoft_365". */
export function serverPrefix(name) {
  return String(name || '').replace(/[^A-Za-z0-9_-]/g, '_')
}

/** The servers and their tools from one `system/init` event. */
export function parseInitEvent(event) {
  if (!event || event.type !== 'system' || event.subtype !== 'init') return null
  const tools = Array.isArray(event.tools) ? event.tools.filter((t) => typeof t === 'string' && t.startsWith('mcp__')) : []
  const servers = (Array.isArray(event.mcp_servers) ? event.mcp_servers : [])
    .filter((s) => s && typeof s.name === 'string')
    .map((s) => {
      const prefix = serverPrefix(s.name)
      const head = `mcp__${prefix}__`
      return {
        name: s.name,
        prefix,
        status: typeof s.status === 'string' ? s.status : 'unknown',
        source: typeof s.source === 'string' ? s.source : '',
        tools: tools.filter((t) => t.startsWith(head)).map((t) => t.slice(head.length)).sort(),
      }
    })
  return { servers }
}

/**
 * Spawn Claude Code just long enough to read its init event. `spawnFn` is
 * injectable for tests; it must return a ChildProcess-like object.
 */
export function probeClaudeTools({ cli, env, cwd, spawnFn = spawn, timeoutMs = 90_000 }) {
  return new Promise((resolve, reject) => {
    // The prompt is never answered: the process is killed on the init line.
    const child = spawnFn(cli, ['-p', '--output-format', 'stream-json', '--verbose', '--', 'Reply with OK.'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let done = false
    let stderr = ''
    const finish = (fn, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { child.kill('SIGKILL') } catch {}
      fn(value)
    }
    const timer = setTimeout(() => finish(reject, new Error('Claude Code did not start in time')), timeoutMs)
    child.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-2000) })
    createInterface({ input: child.stdout }).on('line', (line) => {
      let event
      try { event = JSON.parse(line) } catch { return }
      const parsed = parseInitEvent(event)
      if (parsed) finish(resolve, parsed)
    })
    child.on('error', (e) => finish(reject, e))
    child.on('close', (code) => finish(reject, new Error(stderr.trim() || `Claude Code exited (${code}) before listing its tools`)))
  })
}

const str = (v, max = 200) => (typeof v === 'string' && v.length <= max ? v : '')
const names = (list, max = 300) => [...new Set((Array.isArray(list) ? list : []).map((v) => str(v, max)).filter(Boolean))].sort()

/** Defensive read of the stored file. */
export function normalizeToolState(raw) {
  const accounts = {}
  for (const [id, a] of Object.entries(raw?.accounts && typeof raw.accounts === 'object' ? raw.accounts : {})) {
    if (!/^[a-z0-9_-]{1,60}$/i.test(id) || !a || typeof a !== 'object') continue
    accounts[id] = {
      pulledAt: str(a.pulledAt, 40) || null,
      error: str(a.error, 500) || null,
      servers: (Array.isArray(a.servers) ? a.servers : []).filter((s) => str(s?.name)).map((s) => ({
        name: s.name, prefix: serverPrefix(s.name), status: str(s.status, 40) || 'unknown', source: str(s.source, 40), tools: names(s.tools),
      })),
    }
  }
  return {
    accounts,
    disabled: { servers: names(raw?.disabled?.servers), tools: names(raw?.disabled?.tools) },
  }
}

/** One pull result merged in: the account's servers are replaced, choices are kept. */
export function recordPull(state, accountId, { servers = [], error = null } = {}, now = new Date()) {
  const prev = state.accounts[accountId]
  return normalizeToolState({
    ...state,
    accounts: {
      ...state.accounts,
      // A failed pull keeps what the last good one found.
      [accountId]: error
        ? { ...(prev || { servers: [] }), pulledAt: prev?.pulledAt || null, error: String(error) }
        : { pulledAt: now.toISOString(), error: null, servers },
    },
  })
}

/**
 * Apply a toggle. `server` alone switches a whole server; with `tool`, one tool.
 * `all` switches everything known. Tool names are full `mcp__<prefix>__<tool>`.
 */
export function applyToggle(state, { server, tool, all, enabled }) {
  const servers = new Set(state.disabled.servers)
  const tools = new Set(state.disabled.tools)
  const on = enabled !== false
  if (all) {
    if (on) { servers.clear(); tools.clear() }
    else for (const s of knownServers(state)) servers.add(s.prefix)
  } else if (server && tool) {
    const full = `mcp__${serverPrefix(server)}__${tool}`
    if (on) {
      tools.delete(full)
      // Turning one tool on inside a switched-off server: the rest stay off.
      if (servers.delete(serverPrefix(server))) {
        const s = knownServers(state).find((x) => x.prefix === serverPrefix(server))
        for (const t of s?.tools || []) if (t !== tool) tools.add(`mcp__${s.prefix}__${t}`)
      }
    } else tools.add(full)
  } else if (server) {
    const prefix = serverPrefix(server)
    if (on) servers.delete(prefix)
    else servers.add(prefix)
    // A whole-server switch resets its per-tool choices.
    for (const t of [...tools]) if (t.startsWith(`mcp__${prefix}__`)) tools.delete(t)
  }
  return normalizeToolState({ ...state, disabled: { servers: [...servers], tools: [...tools] } })
}

/** Every server any account has listed, merged by prefix, with which accounts have it. */
export function knownServers(state) {
  const byPrefix = new Map()
  for (const [id, a] of Object.entries(state.accounts)) {
    for (const s of a.servers) {
      const cur = byPrefix.get(s.prefix) || { name: s.name, prefix: s.prefix, source: s.source, status: s.status, tools: new Set(), accounts: [] }
      for (const t of s.tools) cur.tools.add(t)
      cur.accounts.push(id)
      if (s.status === 'connected') cur.status = 'connected'
      byPrefix.set(s.prefix, cur)
    }
  }
  return [...byPrefix.values()]
    .map((s) => ({ ...s, tools: [...s.tools].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** What the dashboard shows: servers with each tool's on/off state. */
export function toolView(state) {
  const offServers = new Set(state.disabled.servers)
  const offTools = new Set(state.disabled.tools)
  const servers = knownServers(state).map((s) => {
    const serverOn = !offServers.has(s.prefix)
    const tools = s.tools.map((t) => ({ name: t, enabled: serverOn && !offTools.has(`mcp__${s.prefix}__${t}`) }))
    return { ...s, enabled: serverOn, tools, enabledCount: tools.filter((t) => t.enabled).length }
  })
  const accounts = Object.fromEntries(Object.entries(state.accounts).map(([id, a]) => [id, { pulledAt: a.pulledAt, error: a.error, servers: a.servers.length }]))
  return { servers, accounts }
}

/**
 * Permission rules for one Claude run. `allow` is empty until the owner has
 * pulled at least once, so a fresh install behaves exactly as before.
 */
export function claudeToolRules(state) {
  const offServers = new Set(state.disabled.servers)
  const allow = knownServers(state).filter((s) => !offServers.has(s.prefix)).map((s) => `mcp__${s.prefix}`)
  const deny = [...state.disabled.servers.map((p) => `mcp__${p}`), ...state.disabled.tools]
  return { allow, deny }
}

export async function readToolState(file) {
  try { return normalizeToolState(JSON.parse(await readFile(file, 'utf8'))) }
  catch { return normalizeToolState({}) }
}

// ---------------------------------------------------------------------------
// Access modes for a chat, the same four T3 Code offers. A print-mode run
// cannot stop to ask, so "ask" in these descriptions means "refuse".
// ---------------------------------------------------------------------------

export const ACCESS_MODES = ['supervised', 'edits', 'auto', 'full']
export const DEFAULT_ACCESS = 'full'

export function normalizeAccess(value) {
  return ACCESS_MODES.includes(value) ? value : DEFAULT_ACCESS
}

/** Claude Code's --permission-mode for an access mode; null keeps Claude's default. */
export function claudePermissionMode(access) {
  return { supervised: null, edits: 'acceptEdits', auto: 'auto', full: 'bypassPermissions' }[access] ?? null
}

/** Codex's sandbox for an access mode; null keeps AGENT_SANDBOX. */
export function codexSandbox(access) {
  return { supervised: 'read-only', edits: null, auto: null, full: 'danger-full-access' }[access] ?? null
}
