// Where the owner left each chat, so opening it again lands there (T3 Code's
// timelineScrollAnchoring). A chat read to its end opens at its end, as before;
// one scrolled up opens on the message that was at the top, at the same offset
// into it. Kept per device in localStorage (`totem.chat.scroll.v1`), the 100
// chats most recently scrolled. Pure: storage is handed in, so node can test it.

export const SCROLL_KEY = 'totem.chat.scroll.v1'
export const SCROLL_MAX = 100
/** Pages of older messages a restore may read to find its message before giving up. */
export const RESTORE_PAGES = 5

export interface ScrollEntry {
  /** It was at (or within reach of) the end: open at the end and follow it. */
  atEnd: boolean
  /** The message at the top of the screen. */
  anchorId?: string
  /** How far into that message the screen's top edge was, in points. */
  offset?: number
  at: number
}

export interface KeyValue { getItem(key: string): string | null; setItem(key: string, value: string): void }

/** The newest `max` entries, by when they were saved. */
export function capEntries(map: Record<string, ScrollEntry>, max = SCROLL_MAX): Record<string, ScrollEntry> {
  const ids = Object.keys(map)
  if (ids.length <= max) return map
  const keep = ids.sort((a, b) => (map[b].at || 0) - (map[a].at || 0)).slice(0, max)
  return Object.fromEntries(keep.map((id) => [id, map[id]]))
}

/**
 * The message at the top of the screen and how far into it the top edge is.
 * `start` is the first visible index, `scroll` the offset, `position(i)` an item's top.
 */
export function anchorAt(ids: readonly string[], start: number, scroll: number, position: (index: number) => number): { anchorId: string; offset: number } | null {
  if (!ids.length) return null
  const i = Math.max(0, Math.min(ids.length - 1, start))
  const top = position(i)
  if (!Number.isFinite(top)) return null
  return { anchorId: ids[i], offset: Math.max(0, Math.round(scroll - top)) }
}

export type RestorePlan =
  | { mode: 'end' }
  | { mode: 'anchor'; index: number; offset: number }
  /** The message is older than what is loaded: read another page, then plan again. */
  | { mode: 'load' }
  | { mode: 'top' }

/** How to open a chat given what was saved for it and the messages loaded now. */
export function restorePlan(entry: ScrollEntry | undefined, ids: readonly string[], { hasMore = false, pagesRead = 0 } = {}): RestorePlan {
  if (!entry || entry.atEnd || !entry.anchorId) return { mode: 'end' }
  const index = ids.indexOf(entry.anchorId)
  if (index >= 0) return { mode: 'anchor', index, offset: entry.offset || 0 }
  if (hasMore && pagesRead < RESTORE_PAGES) return { mode: 'load' }
  return { mode: 'top' }
}

export function createScrollMemory(storage: KeyValue, now: () => number = Date.now) {
  let map: Record<string, ScrollEntry> | null = null
  const all = () => {
    if (!map) {
      try { map = JSON.parse(storage.getItem(SCROLL_KEY) || '{}') || {} } catch { map = {} }
      if (typeof map !== 'object' || Array.isArray(map)) map = {}
    }
    return map!
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    timer = null
    try { storage.setItem(SCROLL_KEY, JSON.stringify(all())) } catch { /* full or unavailable: memory only */ }
  }
  return {
    get: (id: string): ScrollEntry | undefined => all()[id],
    save(id: string, entry: Omit<ScrollEntry, 'at'>) {
      map = capEntries({ ...all(), [id]: { ...entry, at: now() } })
      // Scrolling saves many times a second; the disk needs it once it stops.
      if (!timer) timer = setTimeout(flush, 600)
    },
    flush() { if (timer) { clearTimeout(timer); flush() } },
  }
}
