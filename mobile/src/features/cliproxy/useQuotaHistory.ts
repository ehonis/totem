// The proxy's recorded quota history for the graphs (web cliproxy/pool/useQuotaHistory.ts).
// Three weeks of readings is a big download even gzipped, so the phone reads it
// when the page comes into view and every five minutes while it stays there and
// the app is in front, not every two as the web tab does.
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { AuthError, isAccountChanged } from '../../lib/api'
import { getProxyHistory, type ProxyHistorySample } from '../../lib/cliproxy/api'

const EVERY_MS = 5 * 60_000

export type HistoryStatus = 'loading' | 'ready' | 'unsupported' | 'error'

export function useQuotaHistory(active: boolean) {
  const [samples, setSamples] = useState<ProxyHistorySample[]>([])
  const [status, setStatus] = useState<HistoryStatus>('loading')
  const [error, setError] = useState('')
  const request = useRef(0)
  const loadedAt = useRef(0)
  const load = useCallback(async () => {
    const id = ++request.current
    try {
      const result = await getProxyHistory()
      if (id !== request.current) return
      loadedAt.current = Date.now()
      setSamples(result.samples)
      setStatus(result.supported ? 'ready' : 'unsupported')
      setError('')
    } catch (e) {
      if (id !== request.current || isAccountChanged(e)) return
      // A sign-out is the chat store's to handle; the graphs just stop.
      if (e instanceof AuthError) return
      setStatus('error')
      setError(e instanceof Error ? e.message : 'Could not load quota history.')
    }
  }, [])
  useEffect(() => {
    if (!active) return
    if (Date.now() - loadedAt.current > 60_000) void load()
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') void load()
    }, EVERY_MS)
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && Date.now() - loadedAt.current > EVERY_MS) void load()
    })
    return () => {
      clearInterval(timer)
      sub.remove()
    }
  }, [active, load])
  useEffect(() => () => { request.current++ }, [])
  return { samples, status, error, reload: load }
}
