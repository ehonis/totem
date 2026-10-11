import { useCallback, useEffect, useState } from 'react'
import { AuthError } from '../api'
import { AppleError, getAppleStatus, type AppleStatus } from './api'

/**
 * Whether this bridge reads Apple data, asked once after sign-in (the way the
 * terminal's availability is). `null` while asking. A 404 is a bridge with it
 * switched off — or one too old to have the route — and reads as 'off'.
 * `refresh` re-asks, for "Check again" after granting Full Disk Access.
 */
export function useAppleStatus(unlocked: boolean, onAuthError: () => void) {
  const [status, setStatus] = useState<AppleStatus | null>(null)
  const refresh = useCallback(() => {
    return getAppleStatus()
      .then(setStatus)
      .catch((e) => {
        if (e instanceof AuthError) { onAuthError(); return }
        const missing = e instanceof AppleError && e.status === 404
        setStatus({ enabled: false, state: 'off', detail: missing ? undefined : e.message })
      })
  }, [onAuthError])
  useEffect(() => {
    if (unlocked) refresh()
  }, [unlocked, refresh])
  return { status, refresh }
}
