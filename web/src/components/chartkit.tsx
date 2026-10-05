import React from 'react'

// Shared chrome for every Recharts graph in the dashboard, so the Habits metric
// chart and the other trend charts read as one system instead of two
// hand-rolled SVGs that drifted apart.
//
// Everything here is theme-token driven — Recharts takes CSS colors, so
// `var(--line)` works as a stroke and the charts follow the app's palette for
// free. The rules encoded below (hairline solid grid, 2px lines, a 2px surface
// ring on hover markers, recessive axes, tooltips that never gate a value) are
// applied once here rather than remembered at each call site.

/** The card these charts sit on — the color of the gaps and rings. */
export const CHART_SURFACE = 'var(--bg-2)'
export const GRID = 'var(--line)'
export const AXIS_TICK = { fill: 'var(--muted)', fontSize: 10.5 } as const

/** Recessive x-axis: hairline rule, muted ticks, no tick marks. */
export const xAxisProps = {
  tick: AXIS_TICK,
  tickLine: false,
  axisLine: { stroke: GRID },
  minTickGap: 32,
  interval: 'preserveStartEnd' as const,
  height: 20,
}

/** Recessive y-axis: no rule at all — the gridlines already carry the scale. */
export const yAxisProps = {
  tick: AXIS_TICK,
  tickLine: false,
  axisLine: false,
}

/**
 * Y-axis ticks on round numbers. Recharts divides the domain evenly, which on a
 * 0–100 axis with four ticks lands on 0/35/70/100 — the ticks carry the values
 * you didn't directly label, so they have to be numbers a reader can do
 * arithmetic with. Steps come off the 1 / 2 / 2.5 / 5 × 10ⁿ ladder.
 */
export function niceTicks(lo: number, hi: number, target = 5): number[] {
  if (!(hi > lo) || !Number.isFinite(lo) || !Number.isFinite(hi)) return [lo]
  const raw = (hi - lo) / Math.max(1, target - 1)
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag
  const out: number[] = []
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-6; t += step) {
    out.push(Number(t.toPrecision(12)))
  }
  return out.length ? out : [lo, hi]
}

/** Vertical crosshair. The reader aims at a date, never at a 2px line. */
export const crosshair = { stroke: 'var(--muted)', strokeWidth: 1, strokeOpacity: 0.45 }

/** A hovered point: series-colored, ringed in the surface so it stays legible. */
export const activeDot = (color: string) => ({
  r: 4.5, fill: color, stroke: CHART_SURFACE, strokeWidth: 2,
})

/** Top-to-transparent wash under a line. ~25% at the line, nothing at the axis. */
export function AreaWash({ id, color }: { id: string; color: string }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor={color} stopOpacity={0.26} />
      <stop offset="100%" stopColor={color} stopOpacity={0} />
    </linearGradient>
  )
}

// ---------- tooltip parts ----------
// Values lead, labels follow: the number is the strong element and the series
// name is secondary, because the reader already knows which line they're on.

export function ChartTip({ children }: { children: React.ReactNode }) {
  return <div className="ck-tip">{children}</div>
}

export function ChartTipHead({ children }: { children: React.ReactNode }) {
  return <div className="ck-tip-head">{children}</div>
}

/** The headline number for the hovered x. Only the dot wears the series color. */
export function ChartTipLead({ color, value, sub }: { color: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="ck-tip-lead">
      <span className="ck-tip-key" style={{ background: color }} />
      <b>{value}</b>
      {sub && <small>{sub}</small>}
    </div>
  )
}

export function ChartTipRow({ color, label, value }: { color: string; label: string; value: React.ReactNode }) {
  return (
    <div className="ck-tip-row">
      <span className="ck-tip-dot" style={{ background: color }} />
      <span className="ck-tip-label">{label}</span>
      <b>{value}</b>
    </div>
  )
}

/**
 * Legend rows keyed by a short stroke (lines) or a swatch (bars/areas) — always
 * present once a chart carries two or more series, so identity is never
 * color-alone.
 */
export function ChartLegend({ items }: { items: { color: string; label: string; kind?: 'line' | 'area' }[] }) {
  return (
    <div className="ck-legend">
      {items.map((it) => (
        <span key={it.label} className="ck-legend-item">
          <span
            className={`ck-legend-key ${it.kind === 'line' ? 'line' : 'area'}`}
            style={{ background: it.color }}
          />
          {it.label}
        </span>
      ))}
    </div>
  )
}
