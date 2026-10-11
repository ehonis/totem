// The pure half of the web's MetricChart.tsx (series, stats, number format, axis
// bounds) and chartkit's niceTicks, copied as-is so a pinned tile reads the same
// numbers the dashboard does.
import { addDays } from '../../lib/components/overview/time'

export interface MetricPart { key: string; label: string; color: string }

export interface MetricConfig {
  label: string
  unit: string
  min: number | null
  max: number | null
  goal: number | null
  decimals: number
  direction: 'higher' | 'lower'
  chart: 'line' | 'bar'
  source: 'manual' | 'whoop-sleep'
  pinned: boolean
  parts: MetricPart[]
}

export interface MetricDay {
  date: string
  value: number | null
  parts: Record<string, number>
  partsTotal: number
  note?: string
}

export function fmtMetric(value: number | null | undefined, metric: MetricConfig, withUnit = true): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const n = value.toFixed(metric.decimals)
  return withUnit && metric.unit ? `${n}${metric.unit.length > 1 ? ' ' : ''}${metric.unit}` : n
}

/** The last `days` days, oldest first — including the days with nothing logged. */
export function metricSeries(entries: Record<string, Record<string, any>>, habitId: string, today: string, days: number): MetricDay[] {
  const out: MetricDay[] = []
  for (let i = days - 1; i >= 0; i--) {
    const date = addDays(today, -i)
    const entry = entries[date]?.[habitId]
    const parts: Record<string, number> = entry?.parts || {}
    out.push({
      date,
      value: typeof entry?.value === 'number' ? entry.value : null,
      parts,
      partsTotal: Object.values(parts).reduce((a, b) => a + b, 0),
      note: entry?.note,
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
}

// The trend compares the last 7 calendar days to the 7 before them (not the last
// 7 *logged* days), so a week with missed days reads as a worse week.
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
  }
}

// Round a raw data range out to friendly bounds, unless the metric pins one.
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

/** Ticks on round numbers, off the 1 / 2 / 2.5 / 5 × 10ⁿ ladder (chartkit.tsx). */
export function niceTicks(lo: number, hi: number, target = 5): number[] {
  if (!(hi > lo) || !Number.isFinite(lo) || !Number.isFinite(hi)) return [lo]
  const raw = (hi - lo) / Math.max(1, target - 1)
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag
  const out: number[] = []
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-6; t += step) out.push(Number(t.toPrecision(12)))
  return out.length ? out : [lo, hi]
}
