// Which answer from the bridge the Recs page may draw (#181). Pure, so `node --test`
// runs it.
//
// The rule: an answer is drawn only if no change has landed since its request
// went out. Every change that lands moves the revision on, so any read still out
// (a pull to refresh, an older page, another change's refetch) is now stale, and
// the change's own refetch, sent after it landed, is the one that counts. Two
// decisions in flight on different cards can land in either order and the page
// still ends on the last one's view.

export interface Revisions {
  /** The revision now: note it when a read goes out. */
  current(): number
  /** A change landed: every read already out is stale. Returns the new revision. */
  landed(): number
}

export function createRevisions(): Revisions {
  let rev = 0
  return { current: () => rev, landed: () => ++rev }
}

/**
 * Save, show the saved copy at once, then refetch and draw that only if nothing
 * else landed meanwhile. A failed change rejects (nothing landed); a failed
 * refetch resolves with `refreshError`, since the change itself was saved.
 */
export async function saveThenRefresh<T, L>(revisions: Revisions, steps: {
  change: () => Promise<T>
  saved: (result: T) => void
  refetch: () => Promise<L>
  fresh: (ledger: L, result: T) => void
}): Promise<{ result: T; refreshError?: unknown }> {
  const result = await steps.change()
  const at = revisions.landed()
  steps.saved(result)
  let ledger: L
  try { ledger = await steps.refetch() } catch (refreshError) { return { result, refreshError } }
  if (at === revisions.current()) steps.fresh(ledger, result)
  return { result }
}
