/**
 * Browser end of the terminal WebSocket.
 *
 * One connection for the whole app, multiplexing every open terminal by session id.
 * It is a module singleton rather than React state on purpose: the panel unmounts
 * whenever it is closed, and the socket must not go with it — the shells on the
 * other end keep running and we want to still be attached when the panel reopens.
 *
 * Reconnects with backoff. On reconnect the panel re-attaches each session, and the
 * bridge replays that session's scrollback, so a dropped tunnel costs a redraw
 * rather than the session.
 *
 * Protocol and auth model: docs/terminal.md, terminal/ws.mjs.
 */

import { getSecret } from '../api'

export interface TerminalSessionInfo {
  id: string
  title: string
  cwd: string
  shell: string
  cols: number
  rows: number
  pid: number | null
  createdAt: number
  commandCount: number
  lastCommand: string | null
  exited: boolean
  exitCode: number | null
}

export type ServerMessage =
  | { t: 'ready'; sessions: TerminalSessionInfo[]; maxSessions: number }
  | { t: 'sessions'; sessions: TerminalSessionInfo[] }
  | { t: 'opened'; session: TerminalSessionInfo }
  | { t: 'attached'; session: TerminalSessionInfo; replay: string; truncated: boolean }
  | { t: 'data'; id: string; data: string }
  | { t: 'exit'; id: string; exitCode: number | null; signal: string | null }
  | { t: 'closed'; id: string }
  | { t: 'error'; message: string; id?: string }

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed'

type MessageListener = (message: ServerMessage) => void
type StateListener = (state: ConnectionState, detail: string) => void

const WS_PATH = '/api/terminal/ws'
const SUBPROTOCOL = 'totem.terminal.v1'
const BEARER_PREFIX = 'totem.bearer.'

const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 15_000

/**
 * The browser cannot set an Authorization header on a WebSocket, and a bearer in
 * the query string ends up in access logs. Ride the subprotocol list instead —
 * base64url so any secret is a legal HTTP token. Mirrors `protocolsAuthorized`
 * in terminal/ws.mjs.
 */
function bearerProtocol(secret: string): string {
  const bytes = new TextEncoder().encode(secret)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const base64url = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return BEARER_PREFIX + base64url
}

function socketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}${WS_PATH}`
}

class TerminalClient {
  private socket: WebSocket | null = null
  private messageListeners = new Set<MessageListener>()
  private stateListeners = new Set<StateListener>()
  private reconnectTimer: number | null = null
  private reconnectAttempts = 0
  // Messages produced while the socket was down. Attach/open requests are the ones
  // that matter — dropping keystrokes typed at a dead socket is correct anyway.
  private queue: unknown[] = []
  private state: ConnectionState = 'idle'
  private detail = ''
  private wantOpen = false

  connect(): void {
    this.wantOpen = true
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return

    // Empty when signed in with a session cookie instead; the upgrade request
    // carries the cookie and the server accepts either.
    const secret = getSecret()

    this.setState('connecting', '')
    let socket: WebSocket
    try {
      socket = new WebSocket(socketUrl(), secret ? [SUBPROTOCOL, bearerProtocol(secret)] : [SUBPROTOCOL])
    } catch (e) {
      this.setState('closed', e instanceof Error ? e.message : String(e))
      this.scheduleReconnect()
      return
    }
    this.socket = socket

    socket.onopen = () => {
      this.reconnectAttempts = 0
      this.setState('open', '')
      const queued = this.queue
      this.queue = []
      for (const message of queued) socket.send(JSON.stringify(message))
    }

    socket.onmessage = (event) => {
      let message: ServerMessage
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      for (const listener of this.messageListeners) listener(message)
    }

    socket.onclose = (event) => {
      this.socket = null
      // 1008/4401-style rejections mean the secret is wrong; retrying forever would
      // just hammer the bridge. Anything else is worth another go.
      const unauthorized = event.code === 1006 && this.reconnectAttempts > 6
      this.setState('closed', unauthorized ? 'could not authenticate' : event.reason || '')
      if (this.wantOpen) this.scheduleReconnect()
    }

    socket.onerror = () => {
      // `onclose` always follows, and carries the useful detail.
    }
  }

  disconnect(): void {
    this.wantOpen = false
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.socket?.close()
    this.socket = null
    this.setState('idle', '')
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || !this.wantOpen) return
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS)
    this.reconnectAttempts++
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private setState(state: ConnectionState, detail: string): void {
    this.state = state
    this.detail = detail
    for (const listener of this.stateListeners) listener(state, detail)
  }

  getState(): { state: ConnectionState; detail: string } {
    return { state: this.state, detail: this.detail }
  }

  send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
    else this.queue.push(message)
  }

  /** Keystrokes are dropped rather than queued — replaying them later is worse. */
  sendInput(id: string, data: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ t: 'input', id, data }))
    }
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }
}

export const terminalClient = new TerminalClient()
