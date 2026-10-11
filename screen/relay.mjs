// The Screen view's wire: a WebSocket on the bridge's own server, relayed byte
// for byte to the VNC server on this machine (macOS Screen Sharing on :5900).
// The browser speaks RFB itself (noVNC); this end never parses it, so the Mac's
// own login (Apple's ARD auth, or the VNC password) is the second lock behind
// Totem's sign-in.
//
// Auth is the terminal's handshake (terminal/ws.mjs): the bridge secret in the
// subprotocol list, or a signed-in browser's cookie from this host. A cookie
// socket re-checks its session on a heartbeat and closes when it has ended.

import net from 'node:net'
import { WebSocketServer } from 'ws'
import { protocolsAuthorized } from '../terminal/ws.mjs'

// noVNC offers 'binary'; the server has to pick a protocol the client offered.
const SUBPROTOCOL = 'binary'
// Cloudflare drops idle tunnels around 100s; ping well inside that.
const HEARTBEAT_MS = 30_000
// A viewer that cannot keep up pauses the Mac's side rather than buffering a
// stream of full-screen updates in memory.
const HIGH_WATER = 8 * 1024 * 1024
const LOW_WATER = 1024 * 1024
const MAX_VIEWERS = 4

/**
 * @param {import('node:http').Server} server
 * @param {object} options
 * @param {string} options.path        e.g. '/api/screen/ws'
 * @param {string} options.host        VNC host, normally 127.0.0.1
 * @param {number} options.port        VNC port, normally 5900
 * @param {string} options.secret      BRIDGE_SECRET
 * @param {Function} [options.authorize] (req) => boolean, for a cookie session
 * @param {Function} [options.connect]   net.connect, swappable in tests
 * @param {Function} [options.log]
 */
export function attachScreenRelay(server, { path, host, port, secret, authorize = null, connect = net.connect, log = () => {} }) {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: () => SUBPROTOCOL, perMessageDeflate: false })

  server.on('upgrade', (req, socket, head) => {
    if ((req.url || '').split('?')[0] !== path) return
    const viaBearer = protocolsAuthorized(req.headers['sec-websocket-protocol'], secret)
    if (!viaBearer && !(authorize && authorize(req))) {
      log('screen: rejected unauthorized upgrade')
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return socket.destroy()
    }
    if (wss.clients.size >= MAX_VIEWERS) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n')
      return socket.destroy()
    }
    req.screenRecheck = !viaBearer
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (ws, req) => {
    ws.isAlive = true
    ws.sessionStillValid = () => !req.screenRecheck || Boolean(authorize && authorize(req))
    ws.on('pong', () => { ws.isAlive = true })
    log('screen: viewer connected')

    const vnc = connect({ host, port })
    vnc.setNoDelay?.(true)
    let ended = false
    const end = (code, reason) => {
      if (ended) return
      ended = true
      vnc.destroy()
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason)
    }

    vnc.on('data', (chunk) => {
      if (ws.readyState !== ws.OPEN) return
      ws.send(chunk, { binary: true }, () => {
        if (vnc.isPaused() && ws.bufferedAmount < LOW_WATER) vnc.resume()
      })
      if (ws.bufferedAmount > HIGH_WATER) vnc.pause()
    })
    vnc.on('error', (e) => {
      log(`screen: VNC connection failed: ${e?.message || e}`)
      // 4502: the Mac's side is unreachable, as opposed to Totem refusing.
      end(4502, e?.code === 'ECONNREFUSED' ? 'Screen Sharing is not on' : 'VNC connection failed')
    })
    vnc.on('close', () => end(1000, 'VNC closed'))

    ws.on('message', (data) => {
      if (!ws.sessionStillValid()) return end(4401, 'session ended')
      vnc.write(data)
    })
    ws.on('close', () => {
      log('screen: viewer disconnected')
      end(1000, 'viewer closed')
    })
    ws.on('error', (e) => log(`screen: socket error: ${e?.message || e}`))
  })

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue }
      if (ws.sessionStillValid && !ws.sessionStillValid()) { ws.close(4401, 'session ended'); continue }
      ws.isAlive = false
      ws.ping()
    }
  }, HEARTBEAT_MS)
  heartbeat.unref?.()

  return {
    viewers: () => wss.clients.size,
    close() {
      clearInterval(heartbeat)
      for (const ws of wss.clients) ws.terminate()
      wss.close()
    },
  }
}
