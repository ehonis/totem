// Source health: what the bridge's run log (sources/ on the server) says about each
// data source, for Settings → Connections and the goals a failing source feeds.
// GET /api/sources; docs/source-health.md.
import { useEffect, useState } from 'react'
import { api } from '../api'
import { ago } from '../chat/settle'

export type SourceState = 'ok' | 'degraded' | 'failing' | 'unconfigured' | 'unknown'

export interface SourceHealth {
  source: string
  kind: string
  instance: string | null
  label: string
  via: string | null
  state: SourceState
  lastRunAt: string | null
  lastOkAt: string | null
  lastErrorAt: string | null
  failures: number
  failingSince: string | null
  error: string | null
  rows: number | null
  goals: { id: string; title: string }[]
}

export interface SourcedGoal {
  id: string
  title: string
  periodType: string | null
  sources: string[]
  failing: string[]
}

export interface SourceHealthPayload {
  generatedAt: string
  /** Why source health is off (the run log could not be opened), or null. */
  disabled: string | null
  sources: SourceHealth[]
  goals: SourcedGoal[]
  metricSources: Record<string, string>
}

export interface SourceRun {
  source: string
  startedAt: string
  finishedAt: string
  ok: boolean
  error: string | null
  rows: number | null
}

export const getSourceHealth = () => api<SourceHealthPayload>('/api/sources')
export const getSourceRuns = (source: string, limit = 20) =>
  api<{ source: string; runs: SourceRun[] }>(`/api/sources/runs?source=${encodeURIComponent(source)}&limit=${limit}`)

/** "3h ago", or null for no time at all. */
export function since(iso: string | null, now = Date.now()): string | null {
  const at = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(at)) return null
  const short = ago(at, now)
  return short === 'now' ? 'just now' : `${short} ago`
}

/** The one line under a source's name: what is wrong, or when it last worked. */
export function sourceSummary(s: SourceHealth, now = Date.now()): string {
  if (s.state === 'unknown') return 'Not read yet'
  if (s.state === 'unconfigured') return s.error ? `Not set up: ${s.error}` : 'Not set up'
  const lastOk = since(s.lastOkAt, now)
  if (s.state === 'ok') {
    const rows = s.rows != null ? ` · ${s.rows} ${s.rows === 1 ? 'row' : 'rows'}` : ''
    return `Last OK ${lastOk}${rows}`
  }
  const streak = `${s.failures} failed ${s.failures === 1 ? 'read' : 'reads'} in a row`
  const from = s.state === 'failing' ? `Failing since ${since(s.failingSince, now)}` : streak
  return [from, lastOk ? `last OK ${lastOk}` : 'never worked'].join(' · ')
}

/**
 * Sources in the order the panel shows them: each goal's sources under that goal,
 * then every other source, failing first. A source feeding two goals is listed
 * under both, since that is the question the panel answers: "is this goal's data
 * actually arriving?".
 */
export function groupSources(payload: SourceHealthPayload | null) {
  if (!payload) return { goals: [], other: [] }
  const byId = new Map(payload.sources.map((s) => [s.source, s]))
  const goals = payload.goals.map((g) => ({
    goal: g,
    sources: g.sources.map((id) => byId.get(id)).filter((s): s is SourceHealth => Boolean(s)),
  }))
  const feeding = new Set(payload.goals.flatMap((g) => g.sources))
  const rank: Record<SourceState, number> = { failing: 0, degraded: 1, unconfigured: 2, unknown: 3, ok: 4 }
  const other = payload.sources
    .filter((s) => !feeding.has(s.source))
    .sort((a, b) => rank[a.state] - rank[b.state] || a.label.localeCompare(b.label))
  return { goals, other }
}

/** The failing source a metric of this kind reads, if any. */
export function failingSourceFor(payload: SourceHealthPayload | null, metricKind: string): SourceHealth | null {
  const id = payload?.metricSources?.[metricKind]
  if (!id) return null
  const s = payload!.sources.find((x) => x.source === id)
  return s?.state === 'failing' ? s : null
}

// One fetch shared by every goal card on the page, refreshed at most once a minute.
const MAX_AGE_MS = 60_000
let cached: { at: number; data: SourceHealthPayload | null } | null = null
let inFlight: Promise<SourceHealthPayload | null> | null = null

function loadShared(): Promise<SourceHealthPayload | null> {
  if (cached && Date.now() - cached.at < MAX_AGE_MS) return Promise.resolve(cached.data)
  inFlight ??= getSourceHealth()
    .catch(() => null)
    .then((data) => { cached = { at: Date.now(), data }; return data })
    .finally(() => { inFlight = null })
  return inFlight
}

/** The health payload, shared and lightly cached; null until loaded or if it cannot be read. */
export function useSourceHealth(): SourceHealthPayload | null {
  const [data, setData] = useState<SourceHealthPayload | null>(cached?.data ?? null)
  useEffect(() => {
    let alive = true
    loadShared().then((d) => { if (alive) setData(d) })
    return () => { alive = false }
  }, [])
  return data
}

/** For tests: forget the shared copy. */
export function resetSourceHealthCache() { cached = null; inFlight = null }
