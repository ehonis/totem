/**
 * WebSocket transport for the dashboard terminal.
 *
 * Hangs off the bridge's existing HTTP server via the `upgrade` event, so the
 * terminal lives on the same origin and the same port as everything else and needs
 * no extra ingress through the Cloudflare tunnel.
 *
 * Protocol (JSON text frames, one message per frame):
 *
 *   browser → bridge   { t: 'open',   cols, rows, title? }
 *                      { t: 'attach', id, cols, rows }
 *                      { t: 'input',  id, data }
 *                      { t: 'resize', id, cols, rows }
 *                      { t: 'clear',  id }
 *                      { t: 'close',  id }
 *                      { t: 'list' }
 *
 *   bridge → browser   { t: 'ready',    sessions, maxSessions }
 *                      { t: 'sessions', sessions }
 *                      { t: 'opened',   session }
 *                      { t: 'attached', session, replay, truncated }
 *                      { t: 'data',     id, data }
 *                      { t: 'exit',     id, exitCode, signal }
 *                      { t: 'closed',   id }
 *                      { t: 'error',    message, id? }
 *
 * AUTHENTICATION. The browser WebSocket API cannot set an Authorization header, and
 * putting a bearer in the query string writes it into every access log between here
 * and the browser. So the secret rides in the subprotocol list instead — the same
 * trick the Kubernetes API server uses — as `totem.bearer.<base64url(secret)>`.
 * The handshake is rejected before any PTY exists if it does not match.
 *
 * Note this is *not* vulnerable to cross-site WebSocket hijacking: a malicious page
 * can open a socket here, but the connection is authenticated by a secret it has no
 * way to read, and there is no cookie or other ambient authority to ride on. The
 * origin check below is belt-and-braces, not the load-bearing control.
 */

import { WebSocketServer } from 'ws'
import { timingSafeEqual } from 'node:crypto'

const SUBPROTOCOL = 'totem.terminal.v1'
const BEARER_PREFIX = 'totem.bearer.'

// Output is batched over this window before being framed. A build spewing lines
// would otherwise cost one WebSocket frame per PTY read; coalescing turns thousands
// of tiny frames into a handful without any visible lag.
const FLUSH_INTERVAL_MS = 8

// Stop feeding a client that cannot keep up. The server-side scrollback still has
// everything, so the fix is a reload, not a wedged socket or an OOM.
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024

// Cloudflare drops idle tunnels around 100s; ping well inside that.
const HEARTBEAT_MS = 30_000

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a))
  const bufB = Buffer.from(String(b))
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

/** Pull the bearer out of the offered subprotocols and check it. */
function protocolsAuthorized(protocolHeader, secret) {
  if (!secret) return false
  const offered = String(protocolHeader || '').split(',').map((p) => p.trim()).filter(Boolean)
  for (const protocol of offered) {
    if (!protocol.startsWith(BEARER_PREFIX)) continue
    let decoded
    try {
      decoded = Buffer.from(protocol.slice(BEARER_PREFIX.length), 'base64url').toString('utf8')
    } catch { continue }
    if (safeEqual(decoded, secret)) return true
  }
  return false
}

/**
 * Reject an obviously cross-site handshake. Lenient by design: a missing Origin
 * (curl, a native client) is fine, and localhost is allowed so `npm run dev` works
 * through the Vite proxy.
 */
function originAllowed(origin, host) {
  if (!origin) return true
  let originHost
  try { originHost = new URL(origin).hostname } catch { return false }
  if (originHost === 'localhost' || originHost === '127.0.0.1') return true
  const requestHost = String(host || '').split(':')[0]
  return originHost === requestHost
}

/**
 * Attach the terminal WebSocket endpoint to an existing HTTP server.
 *
 * @param {import('node:http').Server} server
 * @param {object}   options
 * @param {object}   options.sessions   Manager from `terminal/sessions.mjs`.
 * @param {string}   options.path       Endpoint path (e.g. '/api/terminal/ws').
 * @param {string}   options.secret     BRIDGE_SECRET.
 * @param {Function} [options.authorize] async (req) => boolean — another way in
 *   when the subprotocol carries no secret (a verified Cloudflare Access identity).
 * @param {number}   options.maxSessions
 * @param {Function} [options.log]
 * @returns {{ close: Function }}
 */
export function attachTerminalWebSocket(server, { sessions, path, secret, authorize = null, maxSessions, log = () => {} }) {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: () => SUBPROTOCOL })

  server.on('upgrade', async (req, socket, head) => {
    // Other upgrade listeners may own other paths; leave their sockets alone.
    if ((req.url || '').split('?')[0] !== path) return

    // The bearer subprotocol, or (for a signed-in browser) the session cookie the
    // upgrade request carries. The origin check below is what stops another site
    // riding that cookie.
    const viaBearer = protocolsAuthorized(req.headers['sec-websocket-protocol'], secret)
    if (!viaBearer && !(authorize && authorize(req))) {
      log('terminal ws: rejected unauthorized upgrade')
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return socket.destroy()
    }
    // A cookie (or proxy) session can end while the socket stays open: sign-out and
    // a password change both move the session version. Such a socket re-checks
    // `authorize` on every message and on every heartbeat, and closes when it fails.
    req.terminalRecheck = !viaBearer
    if (!originAllowed(req.headers.origin, req.headers.host)) {
      log(`terminal ws: rejected cross-origin upgrade from ${req.headers.origin}`)
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return socket.destroy()
    }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (ws, req) => {
    ws.isAlive = true
    ws.sessionStillValid = () => !req?.terminalRecheck || Boolean(authorize && authorize(req))
    ws.on('pong', () => { ws.isAlive = true })

    /** @type {Map<string, Function>} sessionId → detach */
    const attachments = new Map()
    /** @type {Map<string, string[]>} sessionId → pending output chunks */
    const pending = new Map()
    let flushTimer = null

    function send(message) {
      if (ws.readyState !== ws.OPEN) return
      ws.send(JSON.stringify(message))
    }

    function fail(message, id) {
      send(id ? { t: 'error', message, id } : { t: 'error', message })
    }

    function flush() {
      flushTimer = null
      if (ws.readyState !== ws.OPEN) return
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        // The client is not draining. Drop what we have rather than grow forever;
        // reattaching replays from the server-side scrollback.
        pending.clear()
        log('terminal ws: dropping output, client is not keeping up')
        return
      }
      for (const [id, chunks] of pending) {
        if (chunks.length) send({ t: 'data', id, data: chunks.join('') })
      }
      pending.clear()
    }

    function queue(id, data) {
      const chunks = pending.get(id)
      if (chunks) chunks.push(data)
      else pending.set(id, [data])
      if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS)
    }

    /** Route one session's events to this socket, batching the noisy one. */
    function onSessionEvent(event) {
      if (event.type === 'data') return queue(event.id, event.data)
      // Ordering matters: an exit must not overtake the output that explains it.
      flush()
      if (event.type === 'exit') send({ t: 'exit', id: event.id, exitCode: event.exitCode, signal: event.signal })
      else if (event.type === 'closed') {
        send({ t: 'closed', id: event.id })
        attachments.delete(event.id)
      }
    }

    function attach(id, cols, rows) {
      // Idempotent by design. `open` attaches the opener immediately (saving a round
      // trip), and the client's pane — which only mounts once the session shows up in
      // its state — then attaches too. Treating the second one as an error surfaced a
      // spurious "already attached" banner on every new terminal. A repeat attach is
      // a resync request: drop the old subscription and re-send the current state.
      const existing = attachments.get(id)
      if (existing) {
        existing()
        attachments.delete(id)
      }
      const attached = sessions.attach(id, onSessionEvent)
      if (!attached) return fail('no such terminal session', id)
      attachments.set(id, attached.detach)
      if (cols && rows) sessions.resize(id, cols, rows)
      send({
        t: 'attached',
        session: attached.session,
        replay: attached.replay,
        truncated: attached.truncated,
      })
    }

    ws.on('message', (raw) => {
      if (!ws.sessionStillValid()) return endRevoked(ws, send)
      let msg
      try { msg = JSON.parse(String(raw)) } catch { return fail('malformed message') }
      if (!msg || typeof msg.t !== 'string') return fail('malformed message')

      try {
        switch (msg.t) {
          case 'list':
            return send({ t: 'sessions', sessions: sessions.list() })

          case 'open': {
            const session = sessions.open({ title: msg.title, cols: msg.cols, rows: msg.rows })
            send({ t: 'opened', session })
            return attach(session.id, msg.cols, msg.rows)
          }

          case 'attach':
            if (!msg.id) return fail('missing id')
            return attach(msg.id, msg.cols, msg.rows)

          case 'input':
            if (!msg.id || typeof msg.data !== 'string') return fail('missing id or data')
            // Only a viewer may type — otherwise any socket could write into a
            // session it never opened just by guessing an id.
            if (!attachments.has(msg.id)) return fail('not attached', msg.id)
            if (!sessions.write(msg.id, msg.data)) return fail('terminal is not running', msg.id)
            return

          case 'resize':
            if (!msg.id) return fail('missing id')
            if (!attachments.has(msg.id)) return
            sessions.resize(msg.id, msg.cols, msg.rows)
            return

          case 'clear':
            if (!msg.id) return fail('missing id')
            if (!attachments.has(msg.id)) return fail('not attached', msg.id)
            sessions.clear(msg.id)
            return

          case 'close': {
            if (!msg.id) return fail('missing id')
            if (!attachments.has(msg.id)) return fail('not attached', msg.id)
            const detach = attachments.get(msg.id)
            // Detach first: `close` publishes a 'closed' event and we already know.
            detach()
            attachments.delete(msg.id)
            sessions.close(msg.id)
            send({ t: 'closed', id: msg.id })
            return
          }

          default:
            return fail(`unknown message type: ${msg.t}`)
        }
      } catch (e) {
        log(`terminal ws error (${msg.t}): ${e?.message || e}`)
        fail(e?.message || String(e), msg.id)
      }
    })

    ws.on('close', () => {
      if (flushTimer) clearTimeout(flushTimer)
      // Detach every viewer but leave the shells running — surviving a page reload
      // is the entire point of server-side sessions.
      for (const detach of attachments.values()) detach()
      attachments.clear()
    })

    ws.on('error', (e) => log(`terminal ws socket error: ${e?.message || e}`))

    send({ t: 'ready', sessions: sessions.list(), maxSessions })
  })

  // Drop sockets that stopped answering (laptop lid closed, tunnel died) so their
  // attachments do not linger against live sessions.
  function endRevoked(ws, send) {
    log('terminal ws: session ended; closing socket')
    send({ t: 'error', message: 'your session has ended — sign in again' })
    ws.close(4401, 'session ended')
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue }
      // An idle socket whose session was signed out must not linger until it types.
      if (ws.sessionStillValid && !ws.sessionStillValid()) { ws.close(4401, 'session ended'); continue }
      ws.isAlive = false
      ws.ping()
    }
  }, HEARTBEAT_MS)
  heartbeat.unref?.()

  return {
    close() {
      clearInterval(heartbeat)
      for (const ws of wss.clients) ws.terminate()
      wss.close()
    },
  }
}

// Exported for tests — the handshake rules are the security boundary and deserve
// coverage that does not require standing up a server.
export const __testables = { protocolsAuthorized, originAllowed, SUBPROTOCOL, BEARER_PREFIX }
