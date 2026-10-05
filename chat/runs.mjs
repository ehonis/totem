// chat/runs.mjs — a chat turn that outlives the request that started it.
//
// The old /api/chat killed the agent the moment the browser's fetch closed. That
// is fine for "what's on today" and fatal for "go do this on the Mac": the phone
// locks, Safari suspends the tab, the stream drops, and the work is SIGKILLed half
// done. A run here belongs to its thread, not to a connection. Any number of
// viewers can attach, detach and re-attach (`since` replays what they missed), and
// only an explicit stop — or the run's own clock — ends it.
//
// Events are numbered. A finished run lingers briefly so a viewer that reconnects
// a second after the end still receives `end` rather than hanging on a run that no
// longer exists.

const LINGER_MS = 5 * 60_000
const MAX_EVENTS = 20_000

export function createChatRuns({ log = () => {} } = {}) {
  const runs = new Map() // threadId -> run

  function get(threadId) {
    return runs.get(threadId) || null
  }

  function active(threadId) {
    const run = runs.get(threadId)
    return run && run.status === 'running' ? run : null
  }

  function summary(run) {
    return {
      id: run.id, threadId: run.threadId, status: run.status, startedAt: run.startedAt,
      endedAt: run.endedAt || null, mode: run.mode, events: run.seq, viewers: run.subscribers.size,
      assistantMessageId: run.assistantMessageId,
    }
  }

  function list() {
    return [...runs.values()].map(summary)
  }

  /**
   * Start a run. `execute({ emit, signal, run })` does the work and resolves when
   * it is finished; anything it throws becomes an `error` event. Returns the run.
   */
  function start(threadId, { id, mode = 'chat', assistantMessageId, execute }) {
    if (active(threadId)) throw Object.assign(new Error('this chat is already answering'), { status: 409 })
    const run = {
      id, threadId, mode, assistantMessageId, status: 'running', startedAt: Date.now(), endedAt: 0,
      seq: 0, events: [], subscribers: new Set(), controller: new AbortController(), stopRequested: false,
      lingerTimer: null,
    }
    const prior = runs.get(threadId)
    if (prior?.lingerTimer) clearTimeout(prior.lingerTimer)
    runs.set(threadId, run)

    const emit = (event) => {
      const numbered = { ...event, seq: ++run.seq }
      run.events.push(numbered)
      if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS)
      for (const fn of run.subscribers) {
        try { fn(numbered) } catch (e) { log('chat run subscriber failed', e?.message || e) }
      }
    }

    // Started synchronously, so a stop that arrives straight after start still
    // finds the work listening for it. Viewers replay from seq 0 regardless.
    new Promise((resolve) => resolve(execute({ emit, signal: run.controller.signal, run })))
      .catch((e) => {
        log('chat run failed', e?.message || e)
        emit({ type: 'error', text: String(e?.message || e) })
      })
      .finally(() => {
        run.status = run.stopRequested ? 'stopped' : 'finished'
        run.endedAt = Date.now()
        emit({ type: 'end', status: run.status })
        run.subscribers.clear()
        run.lingerTimer = setTimeout(() => { if (runs.get(threadId) === run) runs.delete(threadId) }, LINGER_MS)
        run.lingerTimer.unref?.()
      })
    return run
  }

  /** Attach a viewer. Replays events after `since`, then streams live ones. */
  function subscribe(threadId, since, fn) {
    const run = runs.get(threadId)
    if (!run) return null
    for (const e of run.events) if (e.seq > since) fn(e)
    if (run.status !== 'running') return () => {}
    run.subscribers.add(fn)
    return () => run.subscribers.delete(fn)
  }

  function stop(threadId) {
    const run = active(threadId)
    if (!run) return false
    run.stopRequested = true
    run.controller.abort()
    return true
  }

  return { start, get, active, subscribe, stop, list, summary }
}
