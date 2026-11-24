// The app's storage for the saved drafts (drafts.ts; what the web does the same
// way is draftsShared.ts, both the web's files byte for byte). One record per
// bridge in the phone's storage, saved as the app leaves the foreground; the
// app's old text-only map folded in once. The app is one JS context, so unlike the
// web's tabs nothing else writes the record and no save merges. No React Native
// here: node's test runner loads it, and features/chat/appDrafts.ts hands it the app's own.
import { createDraftStore, emptyDrafts, loadDrafts, readSaved, DRAFTS_STORAGE_KEY, LEGACY_DRAFTS_KEY, type DraftStore } from './drafts.ts'

export interface KeyValueStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

/** React Native's AppState, as far as the drafts need it. */
export interface AppStateLike {
  addEventListener: (type: 'change', fn: (state: string) => void) => { remove: () => void }
}

/** Where a bridge's drafts are kept: drafts name that bridge's chats and uploads. */
export const draftsKeyFor = (bridge: string) => `${DRAFTS_STORAGE_KEY}@${bridge}`

/**
 * The drafts of the bridge the app is connected to (`bridge()`, followed through
 * `onBridgeChange`); none, and nothing saved, while it has none. The first
 * bridge's record takes in the app's old text-only map (`totem.chat.drafts`) once
 * and removes it. A save still waiting goes the moment the app leaves the
 * foreground, since iOS may end it after. A record that would not read is copied
 * beside it (`….bak`) before it is first written over; one that could not be read
 * at all is read again first.
 */
export function createAppDrafts({ storage, appState, bridge, onBridgeChange, now, mint, onSaveError, delayMs }: {
  storage: KeyValueStorage
  appState: AppStateLike
  bridge: () => string
  onBridgeChange: (fn: () => void) => void
  now: () => number
  mint: () => string
  onSaveError?: (e: unknown) => void
  delayMs?: number
}): DraftStore {
  function open(base: string): DraftStore {
    const io = { now, mint, onSaveError, delayMs }
    if (!base) return createDraftStore(emptyDrafts(), { ...io, save: () => {} })
    const key = draftsKeyFor(base)
    let raw: string | null = null
    let unread = false
    let legacy: string | null = null
    try { raw = storage.getItem(key) } catch { unread = true }
    try { legacy = storage.getItem(LEGACY_DRAFTS_KEY) } catch {}
    let backup = raw !== null && !readSaved(raw) ? raw : null
    let legacyLeft = legacy !== null
    const store = createDraftStore(loadDrafts(raw, legacy, now()), {
      ...io,
      save(json) {
        if (unread) {
          const again = storage.getItem(key)
          if (again !== null) backup = again
          unread = false
        }
        if (backup !== null) { storage.setItem(`${key}.bak`, backup); backup = null }
        storage.setItem(key, json)
        if (legacyLeft) { storage.removeItem(LEGACY_DRAFTS_KEY); legacyLeft = false }
      },
    })
    if (legacyLeft) store.flush()
    return store
  }

  let base = bridge()
  let inner = open(base)
  const subs = new Set<() => void>()
  const notify = () => subs.forEach((fn) => fn())
  let stopInner = inner.subscribe(notify)
  onBridgeChange(() => {
    const next = bridge()
    if (next === base) return
    inner.flush()
    stopInner()
    base = next
    inner = open(base)
    stopInner = inner.subscribe(notify)
    notify()
  })
  appState.addEventListener('change', (state) => { if (state !== 'active') inner.flush() })

  const store = {} as Record<string, unknown>
  for (const name of Object.keys(inner)) store[name] = (...args: unknown[]) => (inner as unknown as Record<string, (...a: unknown[]) => unknown>)[name](...args)
  store.subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn) } }
  return store as unknown as DraftStore
}

/** A set of held uploads that never reached the bridge goes again when the app is back in front. */
export function renewWhenActive(appState: AppStateLike, holds: { renew: () => void }) {
  return appState.addEventListener('change', (state) => { if (state === 'active') holds.renew() })
}
