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
 * Sources split the way Settings → Connections shows them: what is wrong first
 * (failing before erroring), then what has never been set up or read, then what
 * works, each alphabetical. Only the first list is shown in full; the other two
 * fold into a count. A source still carries the goals it feeds (`goals`), so a
 * problem row can say which goal's number has stopped arriving.
 */
export function sortSources(payload: SourceHealthPayload | null, { exclude }: { exclude?: (s: SourceHealth) => boolean } = {}) {
  const shown = (payload?.sources || []).filter((s) => !exclude?.(s))
  const byLabel = (a: SourceHealth, b: SourceHealth) => a.label.localeCompare(b.label)
  return {
    problems: shown.filter((s) => s.state === 'failing' || s.state === 'degraded')
      .sort((a, b) => Number(a.state !== 'failing') - Number(b.state !== 'failing') || byLabel(a, b)),
    waiting: shown.filter((s) => s.state === 'unconfigured' || s.state === 'unknown').sort(byLabel),
    healthy: shown.filter((s) => s.state === 'ok').sort(byLabel),
  }
}

/** "2 not set up · 1 not read yet": the folded row's label, one count per state. */
export function waitingLabel(sources: SourceHealth[]) {
  const unset = sources.filter((s) => s.state === 'unconfigured').length
  const unread = sources.length - unset
  return [unset ? `${unset} not set up` : '', unread ? `${unread} not read yet` : ''].filter(Boolean).join(' · ')
}

/** MCP servers and the gateway: the web lists these in its own MCP section. */
export const isMcpSource = (s: SourceHealth) => s.kind === 'mcp' || s.kind === 'mcp-gateway'

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
