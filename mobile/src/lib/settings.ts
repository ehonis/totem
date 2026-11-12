// App-level UI preferences, persisted in localStorage and shared across views via
// a tiny external store (so a toggle flipped in Settings updates live everywhere).
// These are purely client-side - backend feature flags live in the bridge env.
import { useSyncExternalStore } from 'react'

const KEY = 'app_settings'

export const DEFAULTS = {
  // backgrounds.ts: the page, drawer and raised colours. The web starts on True
  // black; the app starts on Original, the colours it has always had, so an
  // update does not repaint a phone nobody asked to change. theme.ts applies it
  // at launch.
  background: 'original',
  chatGlow: true, // the chat's moving colour glow; off saves the GPU on this device
  reduceMotion: false, // disable animations/transitions app-wide
  compact: false, // tighter spacing/density
  autoRefresh: true, // background polling on data views (e.g. Usage)
  landingTab: 'overview', // which tab to open on a fresh load
  // Overview tile order, set by dragging cards around on desktop. Empty = the
  // built-in order; OverviewView reconciles it against the tiles that exist.
  overviewOrder: [] as string[],
  // Leader-key shortcuts. Stored as a partial - shortcuts.ts merges it over its
  // own defaults, so a blob written by an older build keeps working and new
  // actions pick up their default binding automatically.
  shortcuts: {} as StoredShortcuts,
}

/** Persisted half of the shortcut config; see shortcuts.ts for the full shape. */
export interface StoredShortcuts {
  enabled?: boolean
  leader?: string
  graceMs?: number
  showHud?: boolean
  /** actionId -> key sequence typed after the leader. */
  bindings?: Record<string, string>
}

export type Settings = typeof DEFAULTS

function load(): Settings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) || 'null') || {}) }
  } catch {
    return { ...DEFAULTS }
  }
}

let cache: Settings = load()
const subs = new Set<() => void>()

export function getSettings(): Settings {
  return cache
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  cache = { ...cache, [key]: value }
  localStorage.setItem(KEY, JSON.stringify(cache))
  subs.forEach((fn) => fn())
}

function subscribe(fn: () => void) {
  subs.add(fn)
  return () => subs.delete(fn)
}

// React hook - re-renders the caller whenever any setting changes.
export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getSettings, getSettings)
}
