/**
 * Live AI-quota subscription for the dashboard.
 *
 * One fetch-stream to `GET /api/ai-usage/stream` is shared by every mounted
 * limits surface (Settings ▸ Usage, the Home Providers tile, the G U drawer).
 * Opening it is what tells the bridge poller someone is watching, so vendors
 * get polled every 15s while a subscriber exists and drop back to the idle
 * cadence when the last one unmounts.
 *
 * EventSource cannot send Authorization, so this is the same fetch+SSE pattern
 * as web chat: Bearer header, read the body, reconnect with backoff.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AuthError, getAiUsage, getSecret } from './api'

export type AiUsageSnapshot = {
  ok?: boolean
  error?: string
  accounts?: any[]
  updatedAt?: number | null
  pollIntervalSeconds?: number
  watchPollSeconds?: number
  watchers?: number
  providers?: Record<string, string>
  polling?: boolean
  type?: string
}

type LiveState = { data: AiUsageSnapshot | null; err: string | null }

type Listener = (state: LiveState) => void

const listeners = new Set<Listener>()
let current: LiveState = { data: null, err: null }
let abort: AbortController | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let attempts = 0
let running = false

function emit() {
  for (const listener of listeners) listener(current)
}

function setState(next: LiveState) {
  current = next
  emit()
}

/** Parse one SSE chunk that may contain a `data:` JSON line. Heartbeats (`: ping`) are ignored. */
function applyChunk(chunk: string) {
  const line = chunk.split('\n').find((entry) => entry.startsWith('data:'))
  if (!line) return
  let evt: AiUsageSnapshot
  try {
    evt = JSON.parse(line.slice(5).trim())
  } catch {
    return
  }
  if (evt?.type === 'snapshot' || Array.isArray(evt?.accounts)) {
    setState({ data: evt, err: null })
  }
}

async function connect() {
  abort = new AbortController()
  try {
    const response = await fetch('/api/ai-usage/stream', {
      headers: { Authorization: `Bearer ${getSecret()}`, accept: 'text/event-stream' },
      signal: abort.signal,
    })
    if (response.status === 401) {
      setState({ data: current.data, err: 'unauthorized' })
      return
    }
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
    attempts = 0
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const chunks = buf.split('\n\n')
      buf = chunks.pop() || ''
      for (const chunk of chunks) applyChunk(chunk)
    }
    scheduleReconnect()
  } catch (err: any) {
    if (err?.name === 'AbortError') return
    scheduleReconnect()
  }
}

function scheduleReconnect() {
  if (!running) return
  attempts += 1
  const ms = Math.min(15_000, 500 * 2 ** Math.min(attempts - 1, 5))
  reconnectTimer = setTimeout(() => { void connect() }, ms)
}

function start() {
  if (running) return
  running = true
  attempts = 0
  void (async () => {
    // Snapshot first so a panel has numbers before the stream's first event.
    try {
      setState({ data: await getAiUsage(), err: null })
    } catch (err: any) {
      if (err instanceof AuthError) {
        setState({ data: null, err: 'unauthorized' })
        return
      }
      setState({ data: current.data, err: err?.message || String(err) })
    }
    void connect()
  })()
}

function stop() {
  running = false
  abort?.abort()
  abort = null
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function subscribe(listener: Listener) {
  listeners.add(listener)
  listener(current)
  start()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) stop()
  }
}

/**
 * Subscribe to live quota while this component is mounted.
 *
 * `reloadKey` is a bump from the settings panel after a save — the poller
 * already emits a new snapshot over the stream, but we also re-GET in case
 * the stream dropped mid-edit.
 */
export function useAiUsageLive({
  onAuthError,
  enabled = true,
  reloadKey = 0,
}: {
  onAuthError?: () => void
  enabled?: boolean
  reloadKey?: number
} = {}) {
  const [data, setData] = useState<AiUsageSnapshot | null>(current.data)
  const [err, setErr] = useState<string | null>(current.err)
  const [busy, setBusy] = useState(false)
  const onAuthErrorRef = useRef(onAuthError)
  onAuthErrorRef.current = onAuthError

  useEffect(() => {
    if (!enabled) return undefined
    return subscribe(({ data: next, err: nextErr }) => {
      if (nextErr === 'unauthorized') {
        onAuthErrorRef.current?.()
        return
      }
      setData(next)
      setErr(nextErr)
    })
  }, [enabled])

  useEffect(() => {
    if (!enabled || !reloadKey) return
    void getAiUsage().then((snap) => setState({ data: snap, err: null })).catch(() => {})
  }, [enabled, reloadKey])

  const forceRefresh = useCallback(async () => {
    setBusy(true)
    try {
      const snap = await getAiUsage(true)
      setState({ data: snap, err: null })
    } catch (e: any) {
      if (e instanceof AuthError) {
        onAuthError?.()
        return
      }
      setErr(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }, [onAuthError])

  return { data, err, busy, forceRefresh }
}
