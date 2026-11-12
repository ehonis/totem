// Removals that wait out an Undo window before reaching the bridge. A list item
// has no recycle bin, so "Remove" hides the row at once and only sends the
// delete when the window closes; Undo cancels it and nothing was ever sent.
// Leaving the screen sends whatever is still waiting (flush), so a removal is
// never silently dropped either. Pure: timers only, no React Native.

export interface UndoQueue {
  /** Hide `id` now and run `commit` after `ms`, unless undone first. */
  schedule(id: string, commit: () => void | Promise<void>, ms: number): void
  /** Cancel a waiting removal. True when there was one to cancel. */
  undo(id: string): boolean
  /** Run every waiting removal now. */
  flush(): void
  /** The ids currently waiting. */
  pending(): ReadonlySet<string>
  subscribe(fn: () => void): () => void
}

export function createUndoQueue(timers: {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: any) => void
} = globalThis): UndoQueue {
  const waiting = new Map<string, { handle: unknown; commit: () => void | Promise<void> }>()
  let snapshot: ReadonlySet<string> = new Set()
  const listeners = new Set<() => void>()
  const changed = () => {
    snapshot = new Set(waiting.keys())
    for (const fn of listeners) fn()
  }
  const run = (id: string) => {
    const entry = waiting.get(id)
    if (!entry) return
    waiting.delete(id)
    changed()
    void entry.commit()
  }
  return {
    schedule(id, commit, ms) {
      const prev = waiting.get(id)
      if (prev) timers.clearTimeout(prev.handle)
      waiting.set(id, { commit, handle: timers.setTimeout(() => run(id), ms) })
      changed()
    },
    undo(id) {
      const entry = waiting.get(id)
      if (!entry) return false
      timers.clearTimeout(entry.handle)
      waiting.delete(id)
      changed()
      return true
    },
    flush() {
      for (const [id, entry] of [...waiting]) {
        timers.clearTimeout(entry.handle)
        run(id)
      }
    },
    pending: () => snapshot,
    subscribe(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
  }
}
