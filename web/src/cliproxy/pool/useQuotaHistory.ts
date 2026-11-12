import { useCallback, useEffect, useRef, useState } from 'react'
import { AuthError } from '../../api'
import { getProxyHistory, INTEGRATIONS_SAVED, type ProxyHistorySample } from '../api'

export function useQuotaHistory(enabled: boolean, onAuthError: () => void) {
  const [samples, setSamples] = useState<ProxyHistorySample[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'unsupported' | 'error'>('loading')
  const [error, setError] = useState('')
  const request = useRef(0)
  const load = useCallback(async () => {
    if (!enabled) return
    const id = ++request.current
    try {
      const result = await getProxyHistory()
      if (id !== request.current) return
      setSamples(result.samples)
      setStatus(result.supported ? 'ready' : 'unsupported')
      setError('')
    } catch (e) {
      if (id !== request.current) return
      if (e instanceof AuthError) {
        onAuthError()
        return
      }
      setStatus('error')
      setError(e instanceof Error ? e.message : 'Could not load quota history.')
    }
  }, [enabled, onAuthError])
  useEffect(() => {
    if (!enabled) return
    void load()
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, 120_000)
    const visible = () => {
      if (document.visibilityState === 'visible') void load()
    }
    const changed = () => {
      request.current++
      setSamples([])
      setStatus('loading')
      setError('')
      void load()
    }
    document.addEventListener('visibilitychange', visible)
    window.addEventListener(INTEGRATIONS_SAVED, changed)
    return () => {
      request.current++
      clearInterval(timer)
      document.removeEventListener('visibilitychange', visible)
      window.removeEventListener(INTEGRATIONS_SAVED, changed)
    }
  }, [enabled, load])
  return { samples, status, error, reload: load }
}
