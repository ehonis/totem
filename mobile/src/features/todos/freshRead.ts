// A load that every caller can trust to have read after its own write. The board's
// loadBoard used to hand a caller the load already in flight, which may have read
// the bridge before that caller's move landed: a second tick a second after the first
// came back open, and a repeating task's next occurrence was missing from its toast.
// Here a call made while a load runs waits for one more load after it; calls in the
// same window share that one.
export function freshRead(load: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null
  let queued: Promise<void> | null = null
  const start = (): Promise<void> => {
    const read: Promise<void> = load().finally(() => { if (running === read) running = null })
    running = read
    return read
  }
  return () => {
    if (!running) return start()
    if (!queued) {
      // A read someone started in the gap after the first finished began after this call too: join it rather than run two.
      queued = running.catch(() => {}).then(() => { queued = null; return running ?? start() })
    }
    return queued
  }
}
