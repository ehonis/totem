// One page's change to the task list, told to the others on screen: the Tasks
// page (useTaskBoard), the chats panel's Tasks face and its task card (work/state),
// and a chat whose agent may have made or filed a task. Each listener reads again
// unless it made the change itself; nothing travels between browsers here (a
// window coming back into focus reads again for that).

export type TaskOrigin = 'board' | 'work' | 'chat'
export interface TaskChange { origin: TaskOrigin; /** A sheet row's filing changed, so the sheet feed is stale too. */ sheet?: boolean }

const listeners = new Set<(change: TaskChange) => void>()

export function announceTasks(origin: TaskOrigin, { sheet = false }: { sheet?: boolean } = {}) {
  for (const fn of [...listeners]) {
    try { fn({ origin, sheet }) } catch { /* one listener's trouble is its own */ }
  }
}

/** Call `fn` for changes made elsewhere, at most once per `waitMs` burst. Returns the unsubscribe. */
export function onTasksChanged(self: TaskOrigin, fn: (change: TaskChange) => void, waitMs = 250): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: TaskChange | null = null
  const listener = (change: TaskChange) => {
    if (change.origin === self) return
    pending = { origin: change.origin, sheet: Boolean(pending?.sheet || change.sheet) }
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      const next = pending
      pending = null
      if (next) fn(next)
    }, waitMs)
  }
  listeners.add(listener)
  return () => { listeners.delete(listener); if (timer) clearTimeout(timer) }
}

/** Wrap a call so a success is announced as `origin`'s change. */
export function announcing<A extends unknown[], R>(origin: TaskOrigin, fn: (...args: A) => Promise<R>, opts: { sheet?: boolean } = {}) {
  return async (...args: A): Promise<R> => {
    const result = await fn(...args)
    announceTasks(origin, opts)
    return result
  }
}
