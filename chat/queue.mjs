// chat/queue.mjs — messages the owner sends while a chat is still answering
// that wait their turn instead of steering it (T3 Code's follow-up queue).
//
// The queue lives on the thread (`thread.queue`, normalised in chat/store.mjs),
// so it outlives the browser like the run does: when a run ends the bridge
// starts the first queued message itself. A run that was stopped or failed holds
// the queue (`thread.queueHeld`) rather than ploughing on; Resume, or any new
// message, lets it go again. Each queued message keeps the model it was queued
// with, the way T3 queues a whole turn and not just its text.

export const QUEUE_LIMIT = 50

/** Move `id` to just before `beforeId` (null: the end). Unknown ids leave it as it was. */
export function moveQueued(queue, id, beforeId = null) {
  const from = queue.findIndex((q) => q.id === id)
  if (from < 0 || id === beforeId) return queue
  const rest = queue.filter((q) => q.id !== id)
  const at = beforeId == null ? rest.length : rest.findIndex((q) => q.id === beforeId)
  if (at < 0) return queue
  rest.splice(at, 0, queue[from])
  return rest
}

/**
 * What happens to the queue once a run has ended: `start` the first message,
 * `hold` it (the run was stopped or failed, so the owner decides), or nothing.
 */
export function queueAfterRun(thread, outcome) {
  if (!thread?.queue?.length) return 'none'
  if (outcome === 'stopped' || outcome === 'error') return 'hold'
  return thread.queueHeld ? 'none' : 'start'
}
