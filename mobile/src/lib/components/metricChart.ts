// The pure half of web/src/components/MetricChart.tsx: the metric a habit carries,
// the per-day series and the stats strip's numbers. The drawing lives with the
// native chart (features/habits/MetricChart.tsx); this stays verbatim so both
// sides compute the same "7-day avg" from the same days.
export interface MetricPart { key: string; label: string; color: string }

export interface MetricConfig {
  label: string
  unit: string
  /** Axis floor/ceiling; null means "fit the data". */
  min: number | null
  max: number | null
  /** Optional reference line, e.g. "85 is a good night". */
  goal: number | null
  decimals: number
  /** Which way is good — colors the trend arrow. */
  direction: 'higher' | 'lower'
  chart: 'line' | 'bar'
  /** Where the number comes from — 'whoop-sleep' is filled by the sync job. */
  source: 'manual' | 'whoop-sleep'
  /** Also gets its own tile on the Home board. */
  pinned: boolean
  /** Optional stacked breakdown drawn under the value (e.g. sleep stages). */
  parts: MetricPart[]
}

export interface MetricWindow { start: string; end: string }
export type MetricStatMap = Record<string, number>

export interface MetricEntry {
  count?: number
  note?: string
  value?: number | null
  parts?: Record<string, number>
  stats?: MetricStatMap
  window?: MetricWindow | null
}
export interface MetricDay {
  date: string
  value: number | null
  parts: Record<string, number>
  partsTotal: number
  note?: string
  stats?: MetricStatMap
  window?: MetricWindow | null
}

const toDate = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const toISO = (d: Date): string => {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const addDays = (iso: string, n: number): string => {
  const d = toDate(iso)
  d.setDate(d.getDate() + n)
  return toISO(d)
}

export function fmtMetric(value: number | null | undefined, metric: MetricConfig, withUnit = true): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const n = value.toFixed(metric.decimals)
  return withUnit && metric.unit ? `${n}${metric.unit.length > 1 ? ' ' : ''}${metric.unit}` : n
}

/** The last `days` days, oldest first — including the days with nothing logged. */
export function metricSeries(
  entries: Record<string, Record<string, MetricEntry>>,
  habitId: string,
  today: string,
  days: number,
): MetricDay[] {
  const out: MetricDay[] = []
  for (let i = days - 1; i >= 0; i--) {
    const date = addDays(today, -i)
    const entry = entries[date]?.[habitId]
    const parts = entry?.parts || {}
    out.push({
      date,
      value: typeof entry?.value === 'number' ? entry.value : null,
      parts,
      partsTotal: Object.values(parts).reduce((a, b) => a + b, 0),
      note: entry?.note,
      stats: entry?.stats,
      window: entry?.window ?? null,
    })
  }
  return out
}

export interface MetricStats {
  latest: MetricDay | null
  logged: number
  avg: number | null
  recentAvg: number | null
  priorAvg: number | null
  delta: number | null
  best: number | null
  worst: number | null
}

// The trend compares the last 7 calendar days to the 7 before them (not the last
// 7 *logged* days) — a week with three missed nights should read as a worse week.
export function metricStats(series: MetricDay[]): MetricStats {
  const values = series.filter((d) => d.value != null)
  const mean = (list: MetricDay[]): number | null => {
    const nums = list.filter((d) => d.value != null).map((d) => d.value as number)
    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null
  }
  const recentAvg = mean(series.slice(-7))
  const priorAvg = mean(series.slice(-14, -7))
  return {
    latest: values.length ? values[values.length - 1] : null,
    logged: values.length,
    avg: mean(series),
    recentAvg,
    priorAvg,
    delta: recentAvg != null && priorAvg != null ? recentAvg - priorAvg : null,
    best: values.length ? Math.max(...values.map((d) => d.value as number)) : null,
    worst: values.length ? Math.min(...values.map((d) => d.value as number)) : null,
  }
}

// Round a raw data range out to friendly axis bounds, unless the metric pins one.
export function axisBounds(series: MetricDay[], metric: MetricConfig): { lo: number; hi: number } {
  const values = series.filter((d) => d.value != null).map((d) => d.value as number)
  const goal = metric.goal != null ? [metric.goal] : []
  const pool = [...values, ...goal]
  let lo = metric.min != null ? metric.min : pool.length ? Math.min(...pool) : 0
  let hi = metric.max != null ? metric.max : pool.length ? Math.max(...pool) : 1
  if (metric.min == null || metric.max == null) {
    const pad = Math.max((hi - lo) * 0.12, Math.abs(hi) * 0.02, 0.5)
    if (metric.min == null) lo -= pad
    if (metric.max == null) hi += pad
  }
  if (hi <= lo) hi = lo + 1
  return { lo, hi }
}

/** Round numbers for an axis: about `count` steps, each 1/2/5 × 10ⁿ. */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
  const span = hi - lo
  if (!(span > 0)) return [lo]
  const raw = span / count
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6)
  return out
}
