// Where the owner left each chat, so opening it again lands there (T3 Code's
// remembered timeline position). A chat left at its bottom is `atEnd` and opens
// at the bottom; one left mid-way names the message at the top of the view and
// how far into it the view started, which holds however the log grows around it.
// Kept in localStorage for the 100 chats looked at last.

export const SCROLL_KEY = 'totem.chat.scroll.v1'
export const SCROLL_CAP = 100

export interface ScrollEntry {
  atEnd: boolean
  /** The first message whose bottom is below the top of the view. */
  anchorId?: string
  /** Pixels from that message's top to the top of the view. */
  offset?: number
  at: number
}

export interface RowBox { id: string; top: number; bottom: number }

/** The message at the top of the view: the first row whose bottom is below `viewTop`. */
export function pickAnchor(rows: RowBox[], viewTop: number): { anchorId: string; offset: number } | null {
  for (const r of rows) {
    if (r.bottom > viewTop) return { anchorId: r.id, offset: Math.round(viewTop - r.top) }
  }
  return null
}

/** The `cap` entries looked at last. */
export function capEntries(entries: Record<string, ScrollEntry>, cap = SCROLL_CAP): Record<string, ScrollEntry> {
  const list = Object.entries(entries)
  if (list.length <= cap) return entries
  return Object.fromEntries(list.sort((a, b) => b[1].at - a[1].at).slice(0, cap))
}

let memory: Record<string, ScrollEntry> | null = null
let writeTimer: ReturnType<typeof setTimeout> | null = null

function all(): Record<string, ScrollEntry> {
  if (memory) return memory
  try {
    const v = JSON.parse(localStorage.getItem(SCROLL_KEY) || '{}')
    memory = v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch { memory = {} }
  return memory!
}

export function readScroll(threadId: string): ScrollEntry | null {
  const e = all()[threadId]
  return e && typeof e.atEnd === 'boolean' ? e : null
}

export function saveScroll(threadId: string, entry: Omit<ScrollEntry, 'at'>) {
  memory = capEntries({ ...all(), [threadId]: { ...entry, at: Date.now() } })
  // Scrolling saves many times a second; the disk copy only needs the last one.
  if (writeTimer) return
  writeTimer = setTimeout(() => {
    writeTimer = null
    try { localStorage.setItem(SCROLL_KEY, JSON.stringify(memory)) } catch {}
  }, 500)
}

/** Read the rows of a log against its scroller: each `[data-land="msg:<id>"]` row's box in content pixels. */
export function rowBoxes(scroller: HTMLElement): RowBox[] {
  const base = scroller.getBoundingClientRect().top - scroller.scrollTop
  const out: RowBox[] = []
  scroller.querySelectorAll<HTMLElement>('[data-land^="msg:"]').forEach((el) => {
    const r = el.getBoundingClientRect()
    out.push({ id: el.dataset.land!.slice(4), top: r.top - base, bottom: r.bottom - base })
  })
  return out
}

/** A row's top in content pixels, or null when it is not drawn. */
export function rowTop(scroller: HTMLElement, id: string): number | null {
  const el = scroller.querySelector<HTMLElement>(`[data-land="${CSS.escape(`msg:${id}`)}"]`)
  if (!el) return null
  return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
}

/** For tests. */
export function resetScrollMemory() { memory = null; if (writeTimer) { clearTimeout(writeTimer); writeTimer = null } }
