/**
 * Runs `task` one call at a time. A call while one is out waits for it, then runs
 * once more; every call in between shares that one follow-up. So each caller's
 * run starts after its call, and on a slow link the calls queue behind one run
 * instead of piling up beside it. A run that fails resolves like one that
 * succeeds (the next still runs), so `task` handles its own errors.
 */
export function oneAtATime(task: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null
  let next: Promise<void> | null = null
  const run = (): Promise<void> => {
    if (!running) {
      running = task().catch(() => {}).finally(() => { running = null })
      return running
    }
    next ??= running.then(() => { next = null; return run() })
    return next
  }
  return run
}
