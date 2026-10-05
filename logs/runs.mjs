// logs/runs.mjs — what is happening RIGHT NOW.
//
// The action log answers "what happened"; it is written after the fact, with the
// outcome already known. That is the wrong shape for a command that has been
// running for four minutes, or an agent that is three tool calls into a job. For
// those you want the opposite: partial state, updated as it arrives.
//
// So this is a deliberately in-memory registry of live runs. Nothing here is
// durable, and that is the point:
//
//   - while a run is live, this is the only place its partial output exists;
//   - when it finishes, the durable record goes to data/outputs/ and the action
//     log, and the entry lingers here for `keepFinishedMs` so "what did that
//     command just print" is instant rather than a file read;
//   - on restart, live runs are gone — because so are their child processes.
//
// Chunks carry a monotonic `seq` so a client can poll incrementally: ask for
// everything after the last seq you saw and you get a tail, not the whole buffer
// again. That is why this is polling rather than SSE — a tail that survives a
// dropped connection, a page refresh and a Cloudflare timeout without any
// reconnect logic.

/** Where a chunk came from. Kept closed so the UI can style each one. */
export const CHUNK_STREAMS = ['stdout', 'stderr', 'activity', 'tool', 'text', 'system']

const DEFAULT_KEEP_FINISHED_MS = 30 * 60 * 1000
const DEFAULT_MAX_CHUNK_BYTES = 256 * 1024
const DEFAULT_MAX_RUNS = 60

export function createRunRegistry({
  log = () => {},
  now = Date.now,
  keepFinishedMs = DEFAULT_KEEP_FINISHED_MS,
  maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES,
  maxRuns = DEFAULT_MAX_RUNS,
} = {}) {
  /** @type {Map<string, object>} */
  const runs = new Map()
  let seq = 0

  /** Drop finished runs past their grace period, and cap total entries. */
  function sweep() {
    const t = now()
    for (const [id, run] of runs) {
      if (run.status !== 'running' && run.finishedAt && t - run.finishedAt > keepFinishedMs) runs.delete(id)
    }
    // Oldest-first eviction, but never evict something still running: a live run
    // with no registry entry is a process nobody can see or stop.
    while (runs.size > maxRuns) {
      const victim = [...runs.values()]
        .filter((r) => r.status !== 'running')
        .sort((a, b) => (a.finishedAt || a.startedAt) - (b.finishedAt || b.startedAt))[0]
      if (!victim) break
      runs.delete(victim.id)
    }
  }

  /**
   * Register a run that is starting.
   *
   * `abort` is how the UI stops it. Optional — an agent run that cannot be
   * cancelled simply has no stop button rather than a button that lies.
   */
  function start({ id, kind, label, actor = 'unknown', provider = null, model = null, correlationId = null, cwd = null, abort = null }) {
    if (!id) throw new Error('a run needs an id')
    sweep()
    // Re-running the same id (a re-accepted proposal) replaces the old entry
    // rather than appending to a transcript from an hour ago.
    const run = {
      id: String(id),
      kind,                 // 'command' | 'agent'
      label: String(label || ''),
      actor,
      provider,
      model,
      cwd,
      correlationId: correlationId || String(id),
      status: 'running',
      startedAt: now(),
      finishedAt: null,
      exitCode: null,
      error: null,
      chunks: [],
      chunkBytes: 0,
      truncated: false,
      abort,
    }
    runs.set(run.id, run)
    log(`run ${run.id}: started (${kind}${provider ? ` ${provider}` : ''})`)
    return summary(run)
  }

  /**
   * Add output. Called on every line of stdout, every agent activity update and
   * every token delta, so it must stay cheap and must never throw into the
   * caller — a logging failure cannot be allowed to kill the run it describes.
   */
  function append(id, { stream = 'stdout', text = '' } = {}) {
    const run = runs.get(String(id))
    if (!run) return null
    const body = String(text ?? '')
    if (!body) return null
    const chunk = {
      seq: ++seq,
      ts: now(),
      stream: CHUNK_STREAMS.includes(stream) ? stream : 'stdout',
      text: body,
    }
    run.chunks.push(chunk)
    run.chunkBytes += Buffer.byteLength(body)
    // Drop from the front, keeping the tail: for a live process the recent output
    // is the interesting part, and the durable copy is written on finish anyway.
    while (run.chunkBytes > maxChunkBytes && run.chunks.length > 1) {
      run.chunkBytes -= Buffer.byteLength(run.chunks.shift().text)
      run.truncated = true
    }
    return chunk.seq
  }

  function finish(id, { status = 'ok', exitCode = null, error = null } = {}) {
    const run = runs.get(String(id))
    if (!run) return null
    run.status = status
    run.exitCode = exitCode
    run.error = error ? String(error) : null
    run.finishedAt = now()
    run.abort = null   // release the child reference
    log(`run ${run.id}: ${status}${exitCode != null ? ` (exit ${exitCode})` : ''} after ${run.finishedAt - run.startedAt}ms`)
    return summary(run)
  }

  /** Everything except the transcript: safe to poll in a list. */
  function summary(run) {
    return {
      id: run.id,
      kind: run.kind,
      label: run.label,
      actor: run.actor,
      provider: run.provider,
      model: run.model,
      cwd: run.cwd,
      correlationId: run.correlationId,
      status: run.status,
      startedAt: new Date(run.startedAt).toISOString(),
      finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
      ms: (run.finishedAt || now()) - run.startedAt,
      exitCode: run.exitCode,
      error: run.error,
      truncated: run.truncated,
      chunkCount: run.chunks.length,
      lastSeq: run.chunks.length ? run.chunks[run.chunks.length - 1].seq : 0,
      canStop: Boolean(run.abort),
    }
  }

  /**
   * One run plus the chunks after `since`. `since: 0` is the whole buffer;
   * passing back the previous `lastSeq` gives you only what is new.
   */
  function get(id, { since = 0 } = {}) {
    const run = runs.get(String(id))
    if (!run) return null
    const from = Number(since) || 0
    return { ...summary(run), since: from, chunks: run.chunks.filter((c) => c.seq > from) }
  }

  /** Running first, then most recently finished. */
  function list() {
    sweep()
    return [...runs.values()]
      .map(summary)
      .sort((a, b) => {
        if (a.status === 'running' && b.status !== 'running') return -1
        if (b.status === 'running' && a.status !== 'running') return 1
        return String(b.finishedAt || b.startedAt).localeCompare(String(a.finishedAt || a.startedAt))
      })
  }

  /**
   * Ask a run to stop. Returns false when there is nothing to stop, so the
   * caller can report that honestly instead of pretending it worked.
   *
   * The run is NOT marked finished here — the child's own close handler does
   * that, which keeps one code path for "how a run ends".
   */
  function stop(id) {
    const run = runs.get(String(id))
    if (!run || run.status !== 'running' || !run.abort) return false
    try {
      run.abort()
      append(id, { stream: 'system', text: '\n[stopped by the owner]\n' })
      log(`run ${run.id}: stop requested`)
      return true
    } catch (e) {
      log(`run ${run.id}: stop failed — ${e?.message || e}`)
      return false
    }
  }

  /** Is anything live? Lets the UI poll fast only when it needs to. */
  const anyRunning = () => [...runs.values()].some((r) => r.status === 'running')

  return { start, append, finish, get, list, stop, anyRunning }
}
