// Whether the bridge has a CLIProxy set up (GET /api/cliproxy/status), which is
// when the web puts CLIProxy on its rail. The app shows its way in on the same
// rule: the Overview's tile and the usage sheet's button. Remembered on this
// phone, so they are there at once on the next launch and checked again in view.
import { useEffect, useState } from 'react'
import { getProxyStatus } from '../../lib/cliproxy/api'

const KEY = 'totem.cliproxy.configured'

function stored(): boolean {
  try { return globalThis.localStorage?.getItem(KEY) === '1' } catch { return false }
}

let known = stored()
const listeners = new Set<(v: boolean) => void>()
let asking: Promise<void> | null = null

function ask() {
  asking ??= getProxyStatus()
    .then((r) => {
      known = Boolean(r?.configured)
      try { globalThis.localStorage?.setItem(KEY, known ? '1' : '0') } catch { /* kept in memory only */ }
      for (const fn of listeners) fn(known)
    })
    // Unreachable or refused: keep what was known.
    .catch(() => {})
    .finally(() => { asking = null })
  return asking
}

/** Re-asks whenever `active` turns true (a screen coming into view). */
export function useCliproxyConfigured(active = true): boolean {
  const [configured, setConfigured] = useState(known)
  useEffect(() => {
    listeners.add(setConfigured)
    return () => { listeners.delete(setConfigured) }
  }, [])
  useEffect(() => { if (active) void ask() }, [active])
  return configured
}
