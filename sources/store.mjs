// sources/store.mjs — the sync-run log every connector writes to.
//
// One row per operation a connector performs on the thing it reads (`source_runs`):
// which source, when it started and finished, whether it worked, the scrubbed error
// and how many rows it brought back. Beside it, one row per source holding the
// health folded from those runs (`source_health`, see health.mjs), so the
// Connections page reads N rows rather than a month of log, and pruning the log
// never forgets when a source last worked.
//
// Connectors call `track(source, fn)` around the operation (through track.mjs).
// Writing here must never break the connector, or the bridge: every failure in
// this module is logged and swallowed, `track` returns or throws exactly what `fn`
// did, and a run log that cannot be opened (openSourceRuns) leaves Totem running
// with source health off.
//
// Idea from github.com/mattabate/life-distributable (hub/internal/syncruns), MIT.
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  DEFAULT_MIN_FAILING_MS, DEFAULT_RENOTIFY_MS, DEFAULT_THRESHOLD,
  foldRun, markUnconfigured as foldUnconfigured,
} from './health.mjs'
import { scrubError } from './scrub.mjs'
import { isSourceFault } from './track.mjs'

const DAY = 24 * 60 * 60 * 1000
const PRUNE_EVERY_RUNS = 200
const PRUNE_EVERY_MS = 60 * 60 * 1000
// A working run that changes nothing but the time is not worth a second write
// within this long: "last OK" is at most a minute behind on a busy source.
const QUIET_REWRITE_MS = 60 * 1000

const countRows = (result) => (Array.isArray(result) ? result.length : null)
const scrubFor = (source, error) => scrubError(error, { urls: String(source).startsWith('mcp') ? 'origin' : 'keep' })

/** A run log that records nothing: what the bridge runs with when the file cannot be opened. */
export function disabledSourceRuns(reason = null) {
  return {
    disabled: true,
    reason,
    track: (_source, fn) => fn(),
    record: () => null,
    markUnconfigured: () => null,
    markNotified: () => null,
    health: () => [],
    get: () => null,
    runs: () => [],
    prune: () => ({ deleted: 0, forgotten: 0 }),
    forget: () => 0,
    close: () => {},
  }
}

/**
 * Open the run log without ever taking the bridge down. A file SQLite says is not a
 * database is moved aside (`<file>.corrupt-<time>`) and a fresh one made; anything
 * else (a read-only directory, a path through a file) is logged and source health is
 * switched off for this process.
 */
export function openSourceRuns(opts = {}) {
  const log = opts.log || (() => {})
  try {
    return createSourceRuns(opts)
  } catch (error) {
    const { file } = opts
    const corrupt = /not a database|malformed|corrupt/i.test(String(error?.message))
    if (corrupt && file && file !== ':memory:' && existsSync(file)) {
      const aside = `${file}.corrupt-${Date.now()}`
      try {
        renameSync(file, aside)
        for (const extra of ['-wal', '-shm']) rmSync(`${file}${extra}`, { force: true })
        log(`source run log ${file} was unreadable (${error.message}); moved to ${aside} and started a new one`)
        return createSourceRuns(opts)
      } catch (again) {
        log(`source run log could not be recreated: ${again.message || again}`)
      }
    }
    log(`source health is off: the run log ${file} could not be opened (${error?.message || error})`)
    return disabledSourceRuns(String(error?.message || error))
  }
}

export function createSourceRuns({
  file,
  now = () => Date.now(),
  threshold = DEFAULT_THRESHOLD,
  minFailingMs = DEFAULT_MIN_FAILING_MS,
  renotifyMs = DEFAULT_RENOTIFY_MS,
  retentionDays = 30,
  maxRunsPerSource = 500,
  // Tells the owner a source is failing (health.mjs: needsNotice). The notice
  // counts as sent once this resolves; if it throws, the next failure tries again.
  onFailing = null,
  log = () => {},
} = {}) {
  if (!file) throw new Error('createSourceRuns requires file')
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS source_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        ok INTEGER NOT NULL,
        error TEXT,
        rows INTEGER
      );
      CREATE INDEX IF NOT EXISTS source_runs_source_idx ON source_runs (source, id);
      CREATE INDEX IF NOT EXISTS source_runs_finished_idx ON source_runs (finished_at);
      CREATE TABLE IF NOT EXISTS source_health (
        source TEXT PRIMARY KEY,
        health TEXT NOT NULL
      );
    `)
    if (file !== ':memory:') {
      // WAL with NORMAL: a commit is not an fsync, and a crash loses at most the
      // newest runs, never the file.
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL')
    }
  } catch (error) {
    try { db.close() } catch {}
    throw error
  }

  const iso = (ms) => new Date(ms).toISOString()
  const insertRun = db.prepare('INSERT INTO source_runs (source, started_at, finished_at, ok, error, rows) VALUES (?, ?, ?, ?, ?, ?)')
  const readHealth = db.prepare('SELECT health FROM source_health WHERE source = ?')
  const writeHealth = db.prepare('INSERT INTO source_health (source, health) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET health = excluded.health')

  let sincePrune = 0
  let prunedAt = 0
  const noticeInFlight = new Set()

  function get(source) {
    try {
      const row = readHealth.get(String(source))
      return row ? JSON.parse(row.health) : null
    } catch {
      return null
    }
  }

  const same = (a, b) => a.state === b.state && a.failures === b.failures && a.error === b.error
    && a.rows === b.rows && a.notifiedAt === b.notifiedAt
  const quiet = (prev, next) => prev && same(prev, next)
    && Date.parse(next.lastRunAt) - Date.parse(prev.lastRunAt) < QUIET_REWRITE_MS

  function notice(health) {
    if (!onFailing || noticeInFlight.has(health.source)) return
    noticeInFlight.add(health.source)
    Promise.resolve()
      .then(() => onFailing({ ...health }))
      .then(() => markNotified(health.source, health.lastRunAt))
      .catch((e) => log(`source failing notice for ${health.source} not queued, will retry: ${e?.message || e}`))
      .finally(() => noticeInFlight.delete(health.source))
  }

  /** The notice for this outage was queued at `at`. */
  function markNotified(source, at = iso(now())) {
    try {
      const current = get(source)
      if (!current) return null
      const next = { ...current, notifiedAt: at }
      writeHealth.run(String(source), JSON.stringify(next))
      return next
    } catch (e) {
      log(`source notice for ${source} not marked: ${e.message || e}`)
      return null
    }
  }

  /**
   * Store one finished run and fold it into the source's health. Returns the new
   * health, or null if the write failed. `error` is scrubbed here, before storage.
   */
  function record({ source, startedAt, finishedAt, ok, error = null, rows = null } = {}) {
    let folded
    let run
    try {
      if (!source) return null
      run = {
        source: String(source),
        startedAt: startedAt || iso(now()),
        finishedAt: finishedAt || iso(now()),
        ok: Boolean(ok),
        error: ok ? null : scrubFor(source, error) || 'failed',
        rows: Number.isFinite(rows) ? Math.trunc(rows) : null,
      }
      db.exec('BEGIN IMMEDIATE')
      try {
        insertRun.run(run.source, run.startedAt, run.finishedAt, run.ok ? 1 : 0, run.error, run.rows)
        const prev = get(run.source)
        folded = foldRun(prev, run, { threshold, minFailingMs, renotifyMs })
        if (!quiet(prev, folded.health)) writeHealth.run(run.source, JSON.stringify(folded.health))
        db.exec('COMMIT')
      } catch (e) {
        try { db.exec('ROLLBACK') } catch {}
        throw e
      }
    } catch (e) {
      try { log(`source run for ${run?.source ?? '?'} not recorded: ${e?.message || e}`) } catch {}
      return null
    }
    sincePrune += 1
    if (sincePrune >= PRUNE_EVERY_RUNS || now() - prunedAt >= PRUNE_EVERY_MS) prune()
    if (folded.notify) notice(folded.health)
    return folded.health
  }

  /** The source answered that it is not set up. Not a failure; ends any streak. */
  function markUnconfigured(source, reason = null) {
    try {
      const next = foldUnconfigured(get(source), String(source), { at: iso(now()), reason: reason ? scrubFor(source, reason) : null })
      writeHealth.run(String(source), JSON.stringify(next))
      return next
    } catch (e) {
      log(`source ${source} not marked unconfigured: ${e?.message || e}`)
      return null
    }
  }

  /**
   * Run `fn` as one run of `source`. Returns or throws what `fn` did.
   *
   * `rows(result)` counts what came back (default: an array's length). `isFault`
   * decides what a thrown error means: true, the source failed; false, only this
   * request was wrong and the source answered (recorded as a working run); null,
   * the failure was not the source's at all and nothing is recorded.
   */
  async function track(source, fn, { rows = countRows, isFault = isSourceFault } = {}) {
    const startedAt = iso(now())
    let result
    try {
      result = await fn()
    } catch (error) {
      let fault = true
      try { fault = isFault(error) } catch {}
      if (fault !== null) record({ source, startedAt, finishedAt: iso(now()), ok: !fault, error: fault ? error : null })
      throw error
    }
    let count = null
    try { count = rows(result) } catch {}
    record({ source, startedAt, finishedAt: iso(now()), ok: true, rows: count })
    return result
  }

  /** Every source's health, by id. */
  function health() {
    try {
      return db.prepare('SELECT health FROM source_health ORDER BY source').all()
        .map((row) => { try { return JSON.parse(row.health) } catch { return null } })
        .filter(Boolean)
    } catch (e) {
      log(`source health unreadable: ${e.message || e}`)
      return []
    }
  }

  /** A source's newest runs, newest first. */
  function runs(source, { limit = 50 } = {}) {
    const n = Math.max(1, Math.min(500, Number(limit) || 50))
    try {
      return db.prepare('SELECT * FROM source_runs WHERE source = ? ORDER BY id DESC LIMIT ?').all(String(source), n)
        .map((r) => ({ source: r.source, startedAt: r.started_at, finishedAt: r.finished_at, ok: r.ok === 1, error: r.error, rows: r.rows }))
    } catch (e) {
      log(`source runs unreadable: ${e.message || e}`)
      return []
    }
  }

  /**
   * Drop runs older than `retentionDays` and beyond the newest `maxRunsPerSource`
   * of each source, and forget sources that have not run in `retentionDays` (an
   * account removed, a feed switched off). A source's health row outlives its old
   * runs, so "last worked 40 days ago" survives the log being pruned.
   */
  function prune() {
    sincePrune = 0
    prunedAt = now()
    const cutoff = iso(now() - retentionDays * DAY)
    try {
      const old = db.prepare('DELETE FROM source_runs WHERE finished_at < ?').run(cutoff).changes
      const over = db.prepare(`
        DELETE FROM source_runs WHERE id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY source ORDER BY id DESC) AS n FROM source_runs
          ) WHERE n > ?
        )
      `).run(maxRunsPerSource).changes
      let forgotten = 0
      for (const h of health()) {
        if (h.lastRunAt && h.lastRunAt < cutoff) {
          db.prepare('DELETE FROM source_health WHERE source = ?').run(h.source)
          forgotten += 1
        }
      }
      return { deleted: Number(old) + Number(over), forgotten }
    } catch (e) {
      log(`source run prune failed: ${e.message || e}`)
      return { deleted: 0, forgotten: 0 }
    }
  }

  /**
   * Forget a source whose code is gone (its runs and its health row), so it never
   * shows as failing or "needs you" again. Returns how many rows went.
   */
  function forget(source) {
    try {
      const runs = db.prepare('DELETE FROM source_runs WHERE source = ?').run(source).changes
      const rows = db.prepare('DELETE FROM source_health WHERE source = ?').run(source).changes
      return Number(runs) + Number(rows)
    } catch (e) {
      log(`source forget failed: ${e.message || e}`)
      return 0
    }
  }

  prune()

  return {
    disabled: false, reason: null,
    record, track, markUnconfigured, markNotified, health, get, runs, prune, forget,
    close: () => { try { db.close() } catch {} },
  }
}
