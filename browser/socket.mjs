// The chat's browser, live: one WebSocket per open panel at /api/chat/browser/ws.
//
// Frames go down as they paint (the manager's screencast, browser/manager.mjs
// `watch`); the owner's mouse, wheel and keys come up (browser/input.mjs). A
// socket rather than the chat run's SSE stream because the browser outlives
// the run (the owner signs in after the reply ended, or between replies), a
// viewer's arrival and departure is exactly what starts and stops the stream,
// and a drag is dozens of events a second, which one POST each would queue
// behind each other. Same origin and port as the terminal's socket, so it needs
// nothing new through a tunnel.
//
//   browser → bridge   text   { t: 'view', width, dpr }       the size the panel shows it at
//                             { t: 'input', event }            browser/input.mjs's shapes
//                             { t: 'release' }                 let go of all this socket holds
//   bridge → browser   text   { t: 'ready', drive, reason? }   whether input is taken
//                             { t: 'error', message, code? }
//                             { t: 'closed', at }              the chat's browser closed (bridge time)
//                      binary [u32 header length][header JSON][JPEG]
//                             header: { tabId, url, title, width, height, at }
//                             width × height: the page's CSS viewport the JPEG shows
//
// SIGN-IN. Watching takes what reading the frame over GET /api/chat/browser
// takes: a signed-in session (cookie, same-origin upgrade) or the bearer in the
// subprotocol list (`totem.bearer.<base64url>`, as the terminal does). Driving
// takes what POST /api/chat/browser/input takes, an approval route at low risk:
// a signed-in session or the approval code (`totem.approval.<base64url>`, since
// a browser cannot set a header on a WebSocket). The bearer alone watches and
// never drives. A cookie session is re-checked on every message and heartbeat,
// so signing out or changing the password ends the socket.

import { WebSocketServer } from 'ws'
import { protocolsAuthorized } from '../terminal/ws.mjs'
import { randomUUID } from 'node:crypto'

export const BROWSER_WS_PATH = '/api/chat/browser/ws'
export const BROWSER_SUBPROTOCOL = 'totem.browser.v1'
const APPROVAL_PREFIX = 'totem.approval.'
// A viewer this far behind gets no new frame until it catches up.
const MAX_BUFFERED_BYTES = 1_500_000
const DRAIN_POLL_MS = 25
const HEARTBEAT_MS = 30_000

/**
 * The panel's own id for what it holds down, shared by its socket and its POSTs
 * (`owner`), or null when it is not one. It only groups one panel's presses:
 * driving still takes a session or the approval code on both routes.
 */
export function panelOwner(id) {
  return typeof id === 'string' && /^[A-Za-z0-9-]{16,64}$/.test(id) ? id : null
}
const ERROR_GAP_MS = 2000

/** The approval code offered in the subprotocol list, or ''. */
export function approvalFromProtocols(header) {
  for (const p of String(header || '').split(',').map((s) => s.trim())) {
    if (!p.startsWith(APPROVAL_PREFIX)) continue
    try { return Buffer.from(p.slice(APPROVAL_PREFIX.length), 'base64url').toString('utf8').slice(0, 200) } catch {}
  }
  return ''
}

/** One frame as the binary message the panel decodes (web/src/chat/browserStream.ts). */
export function encodeFrame(frame) {
  const header = Buffer.from(JSON.stringify({ tabId: frame.tabId, url: frame.url, title: frame.title || '', width: frame.width, height: frame.height, at: frame.at }))
  const length = Buffer.alloc(4)
  length.writeUInt32BE(header.length)
  return Buffer.concat([length, header, frame.jpeg])
}

/**
 * @param {import('node:http').Server} server
 * @param {object} options
 * @param {object} options.manager      browser/manager.mjs
 * @param {string} options.secret       BRIDGE_SECRET, for a viewer's bearer subprotocol
 * @param {(req) => boolean} options.authorize  a signed-in, same-origin upgrade (watching)
 * @param {(req, code: string) => Promise<true | { message, code }>} options.approve  driving
 * @param {(id: string) => boolean} options.validThreadId
 */
export function attachBrowserSocket(server, { manager, secret, authorize, approve, validThreadId, path = BROWSER_WS_PATH, heartbeatMs = HEARTBEAT_MS, log = () => {} }) {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: () => BROWSER_SUBPROTOCOL, maxPayload: 64 * 1024 })

  server.on('upgrade', (req, socket, head) => {
    if ((req.url || '').split('?')[0] !== path) return
    const q = new URL(req.url, 'http://x').searchParams
    const threadId = q.get('threadId')
    const refuse = (status, text) => { socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`); socket.destroy() }
    if (!validThreadId(threadId)) return refuse(400, 'Bad Request')
    const viaBearer = protocolsAuthorized(req.headers['sec-websocket-protocol'], secret)
    if (!viaBearer && !authorize(req)) {
      log('browser ws: rejected unauthorized upgrade')
      return refuse(401, 'Unauthorized')
    }
    req.browserRecheck = !viaBearer
    req.threadId = threadId
    // The panel's owner id (its POSTs carry the same), else this socket's own.
    req.owner = panelOwner(q.get('owner')) || randomUUID()
    req.view = { width: Math.min(4000, Math.max(0, Number(q.get('w')) || 0)), dpr: Math.min(4, Math.max(1, Number(q.get('dpr')) || 1)) }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', async (ws, req) => {
    // A frame over maxPayload, invalid UTF-8 or a bad opcode is an 'error' on
    // the socket; unheard, it would take the whole bridge down.
    ws.on('error', (e) => { log(`browser ws: ${e?.message || e}`); ws.terminate() })
    const threadId = req.threadId
    const owner = req.owner
    const code = approvalFromProtocols(req.headers['sec-websocket-protocol'])
    const stillSignedIn = () => !req.browserRecheck || authorize(req)
    const sendJson = (m) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)) }
    let access = { drive: false }
    let lastError = 0
    const error = (message, extra = {}) => {
      if (Date.now() - lastError < ERROR_GAP_MS) return
      lastError = Date.now()
      sendJson({ t: 'error', message, ...extra })
    }
    const checkDrive = async () => {
      const verdict = await approve(req, code).catch((e) => ({ message: String(e?.message || e), code: e?.code }))
      return verdict === true ? { drive: true } : { drive: false, reason: verdict?.message || 'Driving the page needs a signed-in session or the approval code.', code: verdict?.code || 'APPROVAL_NEEDS_OWNER' }
    }
    ws.isAlive = true
    ws.on('pong', () => { ws.isAlive = true })
    ws.recheck = async () => {
      if (!stillSignedIn()) return ws.close(4401, 'session ended')
      // Only a socket that may drive is asked again: the code can be replaced, a
      // session can end. A refused one stays refused, so no wrong code is retried.
      if (!access.drive) return
      const next = await checkDrive()
      if (!next.drive) {
        access = next
        sendJson({ t: 'ready', ...next })
        // Whatever it holds at that moment goes up now, not when it closes.
        manager.release(threadId, owner).catch(() => {})
      }
    }

    // Whether this socket may drive is settled first, so a client learns it even
    // for a chat whose browser has closed.
    access = await checkDrive()
    if (ws.readyState !== ws.OPEN) return
    sendJson({ t: 'ready', ...access })

    // A viewer that is behind is never waited for: its newest frame waits here
    // and goes once its buffer drains, and the screencast keeps its pace for
    // everyone else.
    let behind = null
    let drain = null
    const sendFrame = (frame) => { if (ws.readyState === ws.OPEN) ws.send(encodeFrame(frame), { binary: true }) }
    const watcher = manager.watch(threadId, {
      width: req.view.width,
      dpr: req.view.dpr,
      onFrame: (frame) => {
        if (ws.readyState !== ws.OPEN) return
        if (ws.bufferedAmount < MAX_BUFFERED_BYTES && !behind) return sendFrame(frame)
        behind = frame
        drain ||= setInterval(() => {
          if (ws.readyState !== ws.OPEN) { clearInterval(drain); drain = null; return }
          if (ws.bufferedAmount >= MAX_BUFFERED_BYTES) return
          clearInterval(drain); drain = null
          const newest = behind
          behind = null
          sendFrame(newest)
        }, DRAIN_POLL_MS)
      },
      onEnd: () => { sendJson({ t: 'closed', at: Date.now() }); ws.close(1000, 'browser closed') },
    })
    if (!watcher) {
      sendJson({ t: 'closed', at: Date.now() })
      return ws.close(1000, 'no browser')
    }

    // The panel is one owner of what it holds down (browser/manager.mjs), on
    // this socket and its POSTs alike, so closing a socket that could drive, or
    // its keys losing focus, lets go of exactly that.
    const mayDrive = access.drive
    ws.on('close', () => {
      clearInterval(drain)
      watcher.stop()
      if (mayDrive) manager.release(threadId, owner).catch(() => {})
    })

    ws.on('message', (data, isBinary) => {
      if (!stillSignedIn()) return ws.close(4401, 'session ended')
      if (isBinary) return
      let msg
      try { msg = JSON.parse(String(data)) } catch { return }
      if (msg?.t === 'view') return watcher.view({ width: Number(msg.width) || 0, dpr: Number(msg.dpr) || 1 })
      if (msg?.t === 'release') return access.drive && manager.release(threadId, owner).catch(() => {})
      if (msg?.t !== 'input') return
      if (!access.drive) return error(access.reason, { code: access.code })
      manager.input(threadId, msg.event, owner).catch((e) => error(String(e?.message || e).slice(0, 300)))
    })
  })

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue }
      void ws.recheck?.()
      ws.isAlive = false
      ws.ping()
    }
  }, heartbeatMs)
  heartbeat.unref?.()

  return {
    close() {
      clearInterval(heartbeat)
      for (const ws of wss.clients) ws.terminate()
      wss.close()
    },
  }
}
