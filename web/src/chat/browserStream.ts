import { useEffect, useRef, useState } from 'react'
import { getSecret } from '../api'
import { getApprovalCode } from '../approvalCode'
import { decodeFrame, socketProtocols, type FrameHeader, type RawInput } from './browserInput'

// The chat's browser, live (browser/socket.mjs on the bridge): one socket while
// the panel is open and the page is visible, frames drawn to a canvas as they
// arrive, the owner's input sent back on the same socket. A frame that arrives
// while the last is still decoding replaces the one waiting, so a slow device
// shows the newest picture rather than falling behind. Hidden tab, closed panel
// or another chat: the socket closes, and the bridge stops the screencast.

const WS_PATH = '/api/chat/browser/ws'
const SUBPROTOCOL = 'totem.browser.v1'
const RETRY_MS = [500, 1000, 2000, 5000, 10_000]

export type StreamStatus = 'off' | 'connecting' | 'open' | 'closed'

export interface BrowserStream {
  canvas: React.RefObject<HTMLCanvasElement>
  status: StreamStatus
  /** Frames have been drawn on the canvas since the socket opened. */
  drawn: boolean
  /** The socket takes input (a signed-in session or the approval code). */
  drive: boolean
  /** Why it does not, from the bridge. */
  reason: string
  /** The page the last frame showed. */
  header: FrameHeader | null
  /** Send one input event; false when the socket cannot take it. */
  send: (event: RawInput) => boolean
  /** Let go of everything this socket holds down; false when there is no socket to ask. */
  release: () => boolean
}

/**
 * `revive` is the store's frame time for the chat (the bridge's clock). The
 * bridge's `closed` message carries its time too, so a frame newer than that is
 * a browser opened again, whichever arrived first, and the socket reconnects.
 */
export function useBrowserStream(threadId: string | null, enabled: boolean, revive: number | null = null, owner = ''): BrowserStream {
  const canvas = useRef<HTMLCanvasElement>(null)
  const socket = useRef<WebSocket | null>(null)
  const [status, setStatus] = useState<StreamStatus>('off')
  const [drawn, setDrawn] = useState(false)
  const [access, setAccess] = useState({ drive: false, reason: '' })
  const [header, setHeader] = useState<FrameHeader | null>(null)
  const driveRef = useRef(false)
  // Bumped to reconnect after the browser closed and came back.
  const [epoch, setEpoch] = useState(0)
  const closedAt = useRef<number | null>(null)
  useEffect(() => {
    if (status === 'closed' && closedAt.current !== null && typeof revive === 'number' && revive > closedAt.current) {
      closedAt.current = null
      setEpoch((n) => n + 1)
    }
  }, [status, revive])

  useEffect(() => {
    if (!enabled || !threadId || typeof WebSocket === 'undefined') { setStatus('off'); return }
    let stopped = false
    let attempt = 0
    let retry = 0
    let waiting: ArrayBuffer | null = null
    let decoding = false
    let shown: FrameHeader | null = null

    const draw = async () => {
      if (decoding || !waiting) return
      decoding = true
      const buf = waiting
      waiting = null
      try {
        const frame = decodeFrame(buf)
        const el = canvas.current
        if (frame && el) {
          const bitmap = await createImageBitmap(new Blob([frame.jpeg as BlobPart], { type: 'image/jpeg' }))
          // Decoded after a switch to another chat (or the panel closed): not this one's to show.
          if (stopped) { bitmap.close?.(); return }
          if (el.width !== bitmap.width || el.height !== bitmap.height) { el.width = bitmap.width; el.height = bitmap.height }
          el.getContext('2d')?.drawImage(bitmap, 0, 0)
          bitmap.close?.()
          const h = frame.header
          if (!shown || shown.url !== h.url || shown.title !== h.title || shown.width !== h.width || shown.height !== h.height || shown.tabId !== h.tabId) setHeader(h)
          shown = h
          setDrawn(true)
        }
      } catch {} finally { decoding = false }
      if (waiting) void draw()
    }

    const connect = () => {
      if (stopped || document.hidden || socket.current) return
      setStatus('connecting')
      const width = Math.round(canvas.current?.parentElement?.clientWidth || 800)
      const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${WS_PATH}?threadId=${encodeURIComponent(threadId)}&w=${width}&dpr=${Math.min(3, window.devicePixelRatio || 1)}${owner ? `&owner=${owner}` : ''}`
      let ws: WebSocket
      try { ws = new WebSocket(url, socketProtocols(SUBPROTOCOL, getSecret(), getApprovalCode())) } catch { setStatus('closed'); return }
      ws.binaryType = 'arraybuffer'
      socket.current = ws
      let ended = false
      ws.onopen = () => { attempt = 0; setStatus('open') }
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') { waiting = e.data as ArrayBuffer; void draw(); return }
        let m: any
        try { m = JSON.parse(e.data) } catch { return }
        if (m.t === 'ready') { driveRef.current = !!m.drive; setAccess({ drive: !!m.drive, reason: m.drive ? '' : String(m.reason || '') }) }
        if (m.t === 'closed') { ended = true; closedAt.current = Number(m.at) || Date.now() }
      }
      ws.onclose = () => {
        if (socket.current === ws) socket.current = null
        driveRef.current = false
        setDrawn(false)
        // The chat's browser closed: nothing to come back to.
        if (ended || stopped) { setStatus(ended ? 'closed' : 'off'); return }
        setStatus('connecting')
        retry = window.setTimeout(connect, RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)])
      }
    }

    const onVisible = () => {
      if (document.hidden) { socket.current?.close(1000, 'hidden'); return }
      connect()
    }
    connect()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      window.clearTimeout(retry)
      document.removeEventListener('visibilitychange', onVisible)
      socket.current?.close(1000, 'panel closed')
      socket.current = null
      setStatus('off')
      setDrawn(false)
      setHeader(null)
    }
  }, [threadId, enabled, epoch])

  // The size the panel shows the page at, so the bridge sends frames that size.
  useEffect(() => {
    const el = canvas.current?.parentElement
    if (!el || typeof ResizeObserver === 'undefined') return
    let timer = 0
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const ws = socket.current
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'view', width: Math.round(el.clientWidth), dpr: Math.min(3, window.devicePixelRatio || 1) }))
      }, 250)
    })
    ro.observe(el)
    return () => { ro.disconnect(); window.clearTimeout(timer) }
  }, [threadId, enabled, status])

  const send = (event: RawInput) => {
    const ws = socket.current
    if (!ws || ws.readyState !== WebSocket.OPEN || !driveRef.current) return false
    ws.send(JSON.stringify({ t: 'input', event }))
    return true
  }

  const release = () => {
    const ws = socket.current
    if (!ws || ws.readyState !== WebSocket.OPEN || !driveRef.current) return false
    ws.send(JSON.stringify({ t: 'release' }))
    return true
  }

  return { canvas, status, drawn, drive: access.drive, reason: access.reason, header, send, release }
}
