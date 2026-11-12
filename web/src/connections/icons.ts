// The icon the owner picked for each connection (connections/icons.mjs on the
// bridge): a chat icon, an uploaded picture or a website's icon, worn in place of
// the brand logo wherever the Connections pane draws that connection.
import { useEffect, useSyncExternalStore } from 'react'
import { api } from '../api'

export interface ConnectionIconChoice { icon?: string; image?: string; imageUrl?: string }
type Icons = Record<string, ConnectionIconChoice>

/** Icons a connection can wear: the chat icon names that read as a service. */
export const CONNECTION_ICON_CHOICES = [
  'plug', 'api', 'database', 'server', 'cloud', 'code', 'terminal-2', 'bug', 'git-branch', 'robot',
  'brain', 'sparkles', 'mail', 'messages', 'calendar', 'notes', 'file-text', 'files', 'folder', 'table',
  'chart-bar', 'chart-line', 'report-analytics', 'checklist', 'briefcase', 'building', 'users', 'headset', 'credit-card', 'wallet',
  'shopping-cart', 'world', 'link', 'lock', 'key', 'shield', 'photo', 'music', 'heartbeat',
]

let icons: Icons = {}
let loaded: Promise<void> | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function apply(next: { icons?: Icons }) {
  icons = next?.icons && typeof next.icons === 'object' ? next.icons : {}
  emit()
}

const base = (id: string) => `/api/connections/icons/${encodeURIComponent(id)}`
const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })

/** Read them again (the pane's refresh). */
export function loadConnectionIcons(): Promise<void> {
  loaded = api<{ icons: Icons }>('/api/connections/icons').then(apply).catch(() => { loaded = null })
  return loaded
}

export async function setConnectionIcon(id: string, choice: { icon: string } | { image: string }) {
  apply(await api(base(id), json('PUT', choice)))
}
export async function resetConnectionIcon(id: string) {
  apply(await api(base(id), json('DELETE')))
}
export async function setConnectionFavicon(id: string, site: string) {
  apply(await api(`${base(id)}/favicon`, json('POST', { site })))
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** The owner's pick for one connection, or undefined for its brand logo. */
export function useConnectionIcon(id: string): ConnectionIconChoice | undefined {
  useEffect(() => { if (!loaded) void loadConnectionIcons() }, [])
  return useSyncExternalStore(subscribe, () => icons[id])
}
