// The icon the owner picked for each connection (web src/connections/icons.ts;
// connections/icons.mjs on the bridge). The app only draws it; the owner picks it
// in the dashboard's Settings → Connections, as with a chat folder's picture.
import { useEffect, useSyncExternalStore } from 'react'
import { api } from '../api'
import { getConnection, subscribeConnection } from '../connection'

export interface ConnectionIconChoice { icon?: string; image?: string; imageUrl?: string }
type Icons = Record<string, ConnectionIconChoice>

let icons: Icons = {}
let loaded: Promise<void> | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

// Another bridge has other connections: forget this one's picks and read the new one's.
let bridge = getConnection().baseUrl
subscribeConnection(() => {
  const next = getConnection().baseUrl
  if (next === bridge) return
  bridge = next
  icons = {}
  emit()
  void loadConnectionIcons()
})

/** Read them again (the pane's refresh). */
export function loadConnectionIcons(): Promise<void> {
  loaded = api<{ icons: Icons }>('/api/connections/icons')
    .then((r) => { icons = r?.icons && typeof r.icons === 'object' ? r.icons : {}; emit() })
    .catch(() => { loaded = null })
  return loaded
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** The owner's pick for one connection, or undefined for its own logo. */
export function useConnectionIcon(id: string): ConnectionIconChoice | undefined {
  useEffect(() => { if (!loaded) void loadConnectionIcons() }, [])
  return useSyncExternalStore(subscribe, () => icons[id])
}
