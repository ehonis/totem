/**
 * Terminal session manager.
 *
 * Owns the PTY processes behind the dashboard's terminal panel. Sessions are
 * server-side and outlive the browser: closing a tab, navigating between views, or
 * reloading the page detaches a viewer, it does not kill the shell. A reattaching
 * client replays the scrollback buffer and picks up mid-build.
 *
 * That is the whole reason this is a manager and not "spawn a pty per socket" —
 * the point of the panel is that `npm run build` keeps running while you go read
 * the Overview tab.
 *
 * Shape borrowed from t3code's `apps/server/src/terminal/Manager.ts` (PTY adapter +
 * session map + replayable buffer), minus the Effect runtime and the split-pane
 * bookkeeping this app does not have.
 *
 * `spawnPty` is injected so `terminal/sessions.test.mjs` can drive the whole
 * lifecycle against a fake process without a real shell.
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { createCommandDetector } from './commands.mjs'

// Keep enough output to redraw a screen and a good chunk of history on reattach.
// Held per session in memory, so this multiplied by TERMINAL_MAX_SESSIONS is the
// worst-case footprint (~4MB at the defaults).
const DEFAULT_SCROLLBACK_BYTES = 512 * 1024
const DEFAULT_MAX_SESSIONS = 8

// An exited session sticks around this long so a client that was not attached when
// the shell died still gets to read the last output and the exit code.
const EXITED_RETENTION_MS = 5 * 60 * 1000

// Never strip these even if they appear in .env — the shell is unusable without
// them, and none of them is a secret.
const ENV_ESSENTIALS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'TZ',
  'DISPLAY', 'XDG_RUNTIME_DIR', 'SSH_AUTH_SOCK', 'XAUTHORITY',
])

/**
 * Names the bridge loaded from `.env`.
 *
 * The bridge runs with `node --env-file=.env`, so its own process environment
 * carries BRIDGE_SECRET, WHOOP_CLIENT_SECRET and friends. A shell you open on this
 * box normally would have none of them, and inheriting them would put secrets one
 * `env` away in a browser-rendered terminal. Reading the key names back off the
 * file is exact and stays correct as keys are added — no deny-list to maintain.
 *
 * Values are never parsed, only key names.
 */
export function readEnvFileKeys(envPath) {
  try {
    const raw = readFileSync(envPath, 'utf8')
    const keys = new Set()
    for (const line of raw.split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
      if (m && !ENV_ESSENTIALS.has(m[1])) keys.add(m[1])
    }
    return keys
  } catch {
    // No .env (or unreadable): fall back to hiding the one name that is always a
    // credential rather than passing everything through.
    return new Set(['BRIDGE_SECRET'])
  }
}

/** Build the environment a terminal session runs with. */
export function buildSessionEnv(baseEnv, hiddenKeys, { cols, rows }) {
  const env = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (hiddenKeys.has(key)) continue
    if (value === undefined) continue
    env[key] = value
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  // Marks the session for anything that wants to branch on it (prompt tweaks,
  // scripts that should not assume an interactive tty on a real display).
  env.TOTEM_TERMINAL = '1'
  env.COLUMNS = String(cols)
  env.LINES = String(rows)
  return env
}

function clampDimension(value, fallback, max) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(n, max)
}

/**
 * @param {object}   options
 * @param {Function} options.spawnPty         (shell, args, opts) => IPty, injected for tests.
 * @param {string}   [options.shell]          Login shell to run.
 * @param {string}   [options.cwd]            Working directory for new sessions.
 * @param {object}   [options.env]            Base environment (defaults to process.env).
 * @param {Set}      [options.hiddenEnvKeys]  Names to strip from that environment.
 * @param {number}   [options.maxSessions]
 * @param {number}   [options.scrollbackBytes]
 * @param {Function} [options.onCommand]      (session, command) => void, per detected command.
 * @param {Function} [options.log]
 * @param {Function} [options.now]            Clock, injected for tests.
 */
export function createTerminalSessions(options) {
  const {
    spawnPty,
    shell = process.env.SHELL || '/bin/bash',
    cwd = homedir(),
    env: baseEnv = process.env,
    hiddenEnvKeys = new Set(),
    maxSessions = DEFAULT_MAX_SESSIONS,
    scrollbackBytes = DEFAULT_SCROLLBACK_BYTES,
    onCommand = () => {},
    log = () => {},
    now = Date.now,
  } = options

  /** @type {Map<string, object>} */
  const sessions = new Map()

  function publish(session, event) {
    for (const subscriber of session.subscribers) {
      try { subscriber(event) } catch (e) { log(`terminal subscriber failed: ${e?.message || e}`) }
    }
  }

  /** Append output to the replay buffer, dropping whole chunks from the front. */
  function appendToBuffer(session, chunk) {
    session.buffer.push(chunk)
    session.bufferBytes += Buffer.byteLength(chunk)
    while (session.bufferBytes > scrollbackBytes && session.buffer.length > 1) {
      session.bufferBytes -= Buffer.byteLength(session.buffer.shift())
      session.truncated = true
    }
  }

  function describe(session) {
    return {
      id: session.id,
      title: session.title,
      cwd: session.cwd,
      shell: session.shell,
      cols: session.cols,
      rows: session.rows,
      pid: session.pid,
      createdAt: session.createdAt,
      commandCount: session.commandCount,
      lastCommand: session.lastCommand,
      exited: session.exited,
      exitCode: session.exitCode,
    }
  }

  /**
   * Start a new session.
   *
   * @throws when the session cap is reached, so the caller can report it rather
   *         than the box quietly accumulating shells.
   */
  function open({ title = '', cols = 80, rows = 24, cwd: requestedCwd } = {}) {
    const live = [...sessions.values()].filter((s) => !s.exited)
    if (live.length >= maxSessions) {
      throw new Error(`terminal session limit reached (${maxSessions})`)
    }

    const id = randomUUID()
    const safeCols = clampDimension(cols, 80, 500)
    const safeRows = clampDimension(rows, 24, 200)
    const sessionCwd = requestedCwd || cwd

    const session = {
      id,
      title: title || 'Terminal',
      shell,
      cwd: sessionCwd,
      cols: safeCols,
      rows: safeRows,
      createdAt: now(),
      buffer: [],
      bufferBytes: 0,
      truncated: false,
      subscribers: new Set(),
      detector: createCommandDetector(),
      commandCount: 0,
      lastCommand: null,
      exited: false,
      exitCode: null,
      exitedAt: null,
      pid: null,
      pty: null,
    }

    // `-l` so the shell sources the user's real profile: their PATH, aliases, and
    // prompt. Without it the terminal is subtly not the shell they know.
    session.pty = spawnPty(shell, ['-l'], {
      name: 'xterm-256color',
      cols: safeCols,
      rows: safeRows,
      cwd: sessionCwd,
      env: buildSessionEnv(baseEnv, hiddenEnvKeys, { cols: safeCols, rows: safeRows }),
    })
    session.pid = session.pty.pid ?? null

    session.pty.onData((data) => {
      session.detector.pushOutput(data)
      appendToBuffer(session, data)
      publish(session, { type: 'data', id, data })
    })

    session.pty.onExit(({ exitCode, signal }) => {
      session.exited = true
      session.exitCode = exitCode ?? null
      session.exitedAt = now()
      log(`terminal ${id} exited (code=${exitCode}, signal=${signal ?? 'none'})`)
      publish(session, { type: 'exit', id, exitCode: session.exitCode, signal: signal ?? null })
    })

    sessions.set(id, session)
    log(`terminal ${id} opened (pid=${session.pid}, cwd=${sessionCwd})`)
    return describe(session)
  }

  /**
   * Attach a viewer.
   *
   * @returns {{ session: object, replay: string, truncated: boolean, detach: Function }}
   */
  function attach(id, onEvent) {
    const session = sessions.get(id)
    if (!session) return null
    session.subscribers.add(onEvent)
    return {
      session: describe(session),
      replay: session.buffer.join(''),
      truncated: session.truncated,
      detach: () => { session.subscribers.delete(onEvent) },
    }
  }

  /** Forward keystrokes, counting any command they complete. */
  function write(id, data) {
    const session = sessions.get(id)
    if (!session || session.exited) return false

    for (const command of session.detector.pushInput(data)) {
      session.commandCount++
      if (command.labeled && command.text) session.lastCommand = command.text
      try {
        onCommand(describe(session), command)
      } catch (e) {
        log(`terminal command hook failed: ${e?.message || e}`)
      }
    }

    session.pty.write(data)
    return true
  }

  function resize(id, cols, rows) {
    const session = sessions.get(id)
    if (!session || session.exited) return false
    const safeCols = clampDimension(cols, session.cols, 500)
    const safeRows = clampDimension(rows, session.rows, 200)
    if (safeCols === session.cols && safeRows === session.rows) return true
    session.cols = safeCols
    session.rows = safeRows
    try { session.pty.resize(safeCols, safeRows) } catch (e) { log(`terminal resize failed: ${e?.message || e}`) }
    return true
  }

  /** Drop the scrollback so a reattach does not replay what the user just cleared. */
  function clear(id) {
    const session = sessions.get(id)
    if (!session) return false
    session.buffer = []
    session.bufferBytes = 0
    session.truncated = false
    return true
  }

  /** Kill the shell and forget the session. Idempotent. */
  function close(id) {
    const session = sessions.get(id)
    if (!session) return false
    if (!session.exited) {
      try { session.pty.kill() } catch (e) { log(`terminal kill failed: ${e?.message || e}`) }
    }
    sessions.delete(id)
    publish(session, { type: 'closed', id })
    session.subscribers.clear()
    log(`terminal ${id} closed`)
    return true
  }

  function list() {
    return [...sessions.values()].map(describe)
  }

  /** Drop exited sessions nobody came back for. Called on a timer by the caller. */
  function reap() {
    const cutoff = now() - EXITED_RETENTION_MS
    let removed = 0
    for (const session of [...sessions.values()]) {
      if (session.exited && session.exitedAt !== null && session.exitedAt < cutoff) {
        sessions.delete(session.id)
        session.subscribers.clear()
        removed++
      }
    }
    return removed
  }

  /** Kill everything — used on bridge shutdown so no orphan shells survive. */
  function shutdown() {
    for (const id of [...sessions.keys()]) close(id)
  }

  return { open, attach, write, resize, clear, close, list, reap, shutdown }
}
