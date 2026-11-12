// Tasks the bridge has not taken yet (#179). One shared list, kept in storage until
// each task is added or the owner discards it, through a closed sheet or a restarted
// app. Every write re-reads storage and changes one entry by its id, so two composers
// (or one that has closed and one that is open) never write over each other.
// Free of React Native, so it runs under node's test runner.

export interface UnsentEntry<P> { id: string; payload: P; error: string }

export interface SyncStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function createUnsentStore<P>(storage: () => SyncStorage | null, key: string) {
  const listeners = new Set<() => void>()
  let cache: UnsentEntry<P>[] | null = null
  // Entries with a request out, for as long as the app runs (not stored: after a restart
  // nothing is out). Shared, so a sheet opened mid-retry cannot send the same task again.
  let sending: readonly string[] = []
  const notify = () => { for (const listener of listeners) listener() }

  function read(): UnsentEntry<P>[] {
    try {
      const list = JSON.parse(storage()?.getItem(key) || '[]')
      return Array.isArray(list) ? list.filter((entry) => entry && typeof entry.id === 'string') : []
    } catch { return [] }
  }

  function write(next: UnsentEntry<P>[]) {
    try {
      if (next.length) storage()?.setItem(key, JSON.stringify(next))
      else storage()?.removeItem(key)
    } catch { /* not kept on disk: it still shows until the app quits */ }
    cache = next
    notify()
  }

  return {
    /** The list as storage holds it now. Stable between writes, for useSyncExternalStore. */
    list(): UnsentEntry<P>[] {
      if (!cache) cache = read()
      return cache
    },
    /** Keep a task that failed, or update the error of one already kept. */
    put(entry: UnsentEntry<P>) {
      const current = read()
      write(current.some((item) => item.id === entry.id)
        ? current.map((item) => (item.id === entry.id ? entry : item))
        : [...current, entry])
    },
    /** Ids with a request out. Stable between changes, for useSyncExternalStore. */
    sending(): readonly string[] { return sending },
    /** Start sending an entry. False when it is already out, so the caller must not send it. */
    claim(id: string): boolean {
      if (sending.includes(id)) return false
      sending = [...sending, id]
      notify()
      return true
    },
    release(id: string) {
      if (!sending.includes(id)) return
      sending = sending.filter((item) => item !== id)
      notify()
    },
    /** The task was added, or the owner let it go. */
    remove(id: string) {
      const current = read()
      if (current.some((item) => item.id === id)) write(current.filter((item) => item.id !== id))
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/**
 * The create body for a kept task. A task kept by an older version may still carry
 * what the bridge no longer takes: a share target (`syncTarget: 'github'` is a 400
 * now), a repository, or "start now" (a task is open or done). Those are dropped, so
 * the task is added in Totem, as every task is, rather than refused.
 */
export function createBody<P extends { start?: unknown; repo?: unknown; syncTarget?: unknown }>(payload: P): Omit<P, 'start' | 'repo' | 'syncTarget'> {
  const { start: _start, repo: _repo, syncTarget: _syncTarget, ...fields } = payload
  return fields
}
