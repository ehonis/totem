import { useCallback, useEffect, useState } from 'react'
import { AuthError } from '../api'
import { getScreenStatus, type ScreenStatus } from './api'

/**
 * Whether this bridge shows its screen, asked once after sign-in (the way
 * Messages asks about Apple data). `null` while asking; any failure reads as off.
 */
export function useScreenStatus(unlocked: boolean, onAuthError: () => void) {
  const [status, setStatus] = useState<ScreenStatus | null>(null)
  const refresh = useCallback(() => {
    return getScreenStatus()
      .then(setStatus)
      .catch((e) => {
        if (e instanceof AuthError) { onAuthError(); return }
        setStatus({ enabled: false, state: 'off', detail: e.message })
      })
  }, [onAuthError])
  useEffect(() => {
    if (unlocked) refresh()
  }, [unlocked, refresh])
  return { status, refresh }
}
