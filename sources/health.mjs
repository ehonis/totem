// sources/health.mjs — what a source's run log says about it.
//
// Pure: a source's health is a fold over its runs in the order they finished. The
// store (store.mjs) keeps the folded state beside the log so reading health costs
// one row per source, and so pruning old runs never forgets when a source last
// worked. Tests fold a list of runs and get exactly what the store would hold.
//
// States:
//   ok            the newest run worked
//   degraded      the newest run failed, but not yet `threshold` in a row over
//                 `minFailingMs`
//   failing       `threshold` or more failures in a row, the streak at least
//                 `minFailingMs` long
//   unconfigured  the source answered that it is not set up (an MCP server waiting
//                 for its sign-in, Strava disconnected in Bushido)
//
// One failure is not an outage: a Google 503 or a laptop asleep during a Bushido
// call fails one run and the next one works. Nor is a burst: three refreshes of the
// Connections page a second apart are one moment, not three. Failing needs both a
// count and a duration.
//
// Flapping (fail, fail, ok, …) stays degraded and is never announced. A failure
// ratio would catch it, but it would also keep a source that has just recovered
// marked failing for several runs, and the notice is for outages; a flapping
// source shows as Erroring in Settings with its newest error.

export const DEFAULT_THRESHOLD = 3
export const DEFAULT_MIN_FAILING_MS = 10 * 60 * 1000
// The owner is told once per outage. One that starts again soon after a notice is
// usually the same problem; this long after the last notice, a still-failing
// source is announced again.
export const DEFAULT_RENOTIFY_MS = 6 * 60 * 60 * 1000

export function emptyHealth(source) {
  return {
    source,
    state: 'unknown',
    lastRunAt: null,
    lastOkAt: null,
    lastErrorAt: null,
    failures: 0,
    failingSince: null,
    error: null,
    rows: null,
    notifiedAt: null,
  }
}

const ms = (iso) => (iso ? Date.parse(iso) : NaN)

/**
 * Should the owner be told about this source now?
 *
 * Failing, not yet told about this outage (a notice older than its start was for
 * an earlier one), and the last notice at least `renotifyMs` ago. Checked on every
 * failing run, not only the one that crossed the threshold: an outage that began
 * inside the cool-down is announced once the cool-down ends, and a notice that
 * could not be queued is tried again on the next failure.
 */
export function needsNotice(health, at, { renotifyMs = DEFAULT_RENOTIFY_MS } = {}) {
  if (health?.state !== 'failing') return false
  const told = ms(health.notifiedAt)
  if (!Number.isFinite(told)) return true
  if (told >= ms(health.failingSince)) return false
  return ms(at) - told >= renotifyMs
}

/**
 * Fold one finished run into a source's health.
 *
 * Returns `{ health, notify }`. `notify` says the caller should tell the owner;
 * the fold never sets `notifiedAt` itself, the store does once the notice is
 * queued (markNotified), so a notice that fails to queue is not counted as sent.
 */
export function foldRun(prev, run, {
  threshold = DEFAULT_THRESHOLD,
  minFailingMs = DEFAULT_MIN_FAILING_MS,
  renotifyMs = DEFAULT_RENOTIFY_MS,
} = {}) {
  const base = prev || emptyHealth(run.source)
  const at = run.finishedAt
  if (run.ok) {
    const health = {
      ...base,
      state: 'ok',
      lastRunAt: at,
      lastOkAt: at,
      failures: 0,
      failingSince: null,
      error: null,
      rows: Number.isFinite(run.rows) ? run.rows : base.rows,
    }
    return { health, notify: false }
  }

  const failures = base.failures + 1
  // When the streak began: the first failed run's start, not the threshold one.
  const failingSince = base.failures > 0 && base.failingSince ? base.failingSince : run.startedAt
  const long = ms(at) - ms(failingSince) >= minFailingMs
  const health = {
    ...base,
    state: failures >= threshold && long ? 'failing' : 'degraded',
    lastRunAt: at,
    lastErrorAt: at,
    failures,
    failingSince,
    error: run.error || 'failed',
  }
  return { health, notify: needsNotice(health, at, { renotifyMs }) }
}

/** The source answered that it is not set up: not a failure, and the streak ends. */
export function markUnconfigured(prev, source, { at, reason = null }) {
  return {
    ...(prev || emptyHealth(source)),
    state: 'unconfigured',
    lastRunAt: at,
    failures: 0,
    failingSince: null,
    error: reason,
  }
}

/**
 * Fold a whole log, oldest first, as if every notice were queued at once. Returns
 * the final health and the health at each notice.
 */
export function deriveHealth(runs, opts = {}) {
  const bySource = new Map()
  const alerts = []
  for (const run of runs) {
    const { health, notify } = foldRun(bySource.get(run.source), run, opts)
    if (notify) {
      health.notifiedAt = run.finishedAt
      alerts.push({ ...health })
    }
    bySource.set(run.source, health)
  }
  return { health: bySource, alerts }
}

/**
 * The notice's identity: one per source per outage. Used as the queue's dedupe
 * key and as the fact the revalidator checks at delivery, so a notice held by
 * quiet hours is dropped if the source recovered first.
 */
export const failingNoticeKey = (health) => `source:${health.source}:failing:${health.failingSince}`

// Display names for source ids. An id is `<kind>` or `<kind>:<instance>`, where the
// instance is an account label, a feed id or an MCP server id.
const KINDS = {
  strava: { label: 'Strava', via: 'read through Bushido' },
  whoop: { label: 'WHOOP', via: 'read through Bushido' },
  calendar: { label: 'Google Calendar' },
  gmail: { label: 'Gmail' },
  drive: { label: 'Google Drive' },
  'task-sheet': { label: 'Task sheet', via: 'read through Google Drive' },
  linkedin: { label: 'LinkedIn', via: "read through Totem's browser" },
  // The two-way sync's id, retired with it; an old health row keeps a name until pruned.
  'sheet-tasks': { label: 'Task sheet sync (retired)' },
  feed: { label: 'Feed' },
  mcp: { label: 'MCP server' },
  'mcp-gateway': { label: 'MCP gateway' },
  // The proxy itself, and one source per login it holds (`cliproxy:<email>`).
  cliproxy: { label: 'CLIProxy' },
}

export function describeSourceId(source) {
  const at = String(source).indexOf(':')
  const kind = at < 0 ? source : source.slice(0, at)
  const instance = at < 0 ? null : source.slice(at + 1)
  const known = KINDS[kind]
  const label = known ? (instance ? `${known.label} · ${instance}` : known.label) : source
  return { kind, instance, label, via: known?.via ?? null }
}
