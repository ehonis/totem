import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  Area, Bar, BarChart, CartesianGrid, ComposedChart, LabelList, Line, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import {
  AXIS_TICK, AreaWash, CHART_SURFACE, ChartLegend, ChartTip, ChartTipHead,
  ChartTipLead, ChartTipRow, GRID, activeDot, crosshair, niceTicks, xAxisProps,
  yAxisProps,
} from './chartkit'
import { RECOVERY_YELLOW, recoveryColor, recoveryGradientStops } from './recoveryLine'

// The number a habit carries alongside its check mark, and the graph that draws
// it. Kept in its own module (rather than in HabitsView) so the Habits tab and
// the Home board can both render the identical chart without importing each
// other. The bridge validates this exact shape — see normalizeHabitMetric.
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

/** A local wall-clock span, "YYYY-MM-DDTHH:MM" at each end (no offset — see the
 *  bridge's normalizeEntryWindow: it's a clock reading, not an instant). */
export interface MetricWindow { start: string; end: string }

/**
 * Standalone readings that came with the day's number but share no unit with it
 * and never sum to anything — sleep efficiency, respiratory rate, disturbances.
 * Kept apart from `parts` on purpose: parts stack into a total, stats can't.
 */
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
  recentAvg: number | null // last 7 logged-days window
  priorAvg: number | null // the 7 days before that
  delta: number | null
  best: number | null
  worst: number | null
}

// Stats for the header strip. The trend compares the last 7 calendar days to the
// 7 before them (not the last 7 *logged* days) — a week with three missed nights
// should read as a worse week, not get quietly averaged away.
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

// Round a raw data range out to friendly axis bounds, unless the metric pins one
// (a 0–100 sleep score should always be drawn on 0–100).
function axisBounds(series: MetricDay[], metric: MetricConfig): { lo: number; hi: number } {
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

interface MetricChartProps {
  metric: MetricConfig
  series: MetricDay[]
  /** Habit color — the line/bar color for the headline number. */
  color: string
  height?: number
  /** Compact Home tile: shorter parts strip, tighter axis. */
  compact?: boolean
}

/** A Recharts row. Part values are namespaced so a part named "value" can't win. */
type Row = MetricDay & Record<string, unknown>
const partKey = (key: string) => `p:${key}`
const RECOVERY_KEY = 's:recovery'

/** Left inset, shared by both panels so their columns line up. */
const Y_WIDTH = 42
/** Band width in the merged strip — wide enough to read four stage segments. */
const BAND_BAR = 26

const renderNothing = () => null
/**
 * A bar that draws nothing — but still exists.
 *
 * Recharts filters zero-dimension rectangles out of a bar's points *unless* the
 * bar has a custom shape, and a filtered-out rect takes its label with it. Both
 * strips hang their day labels off a bar that is legitimately zero-height at
 * times (the riser on the night with the range's earliest bedtime; the cap that
 * marks the top of a stack), so those hosts opt out of the filter this way
 * rather than by faking a pixel of height.
 */
const noShape = () => <g />

const fmtAxisDay = (iso: string) => toDate(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
const fmtTipDay = (iso: string) => toDate(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })

// ---------- the window strip's scale ----------
// Minutes are measured from noon of the window's *own* evening, never from the
// date the entry is filed under. Two reasons: the filing date is a setting
// (WHOOP_SLEEP_DATE_MODE picks the evening or the morning), and a night that
// begins at 00:13 belongs to the evening before it on any reading. Anchoring to
// the span itself puts a 22:36 bedtime and a 00:13 bedtime on one continuous
// scale instead of a day apart, which is the whole point of the strip.
const NOON = 12 * 60
const W_PAD = 'w:pad'
const W_REST = 'w:rest'
/**
 * Not a series — the text of the day's label, precomputed onto the row.
 *
 * It has to travel as data rather than be looked up at draw time: Recharts
 * hands a label renderer the index of the *rendered bar*, not of the row, so on
 * a range where some days have no bar (an unlogged night) every label after the
 * gap would be pulled off the row it belongs to. Reading it back through a
 * dataKey goes via the row's own payload, which can't drift.
 */
const DAY_LABEL = 'd:label'
/** Zero-height cap on the parts stack — an anchor for that strip's label. */
const P_CAP = 'p:cap'

/** Type size of the per-day labels, and Inter's tabular advance at that size. */
const DAY_LABEL_SIZE = 9.5
const DAY_LABEL_ADVANCE = 0.57 * DAY_LABEL_SIZE
/** Clear space between two neighbouring labels, so they read as separate. */
const DAY_LABEL_GUTTER = 5

/**
 * Room the widest label in this series needs. Estimated from its own text
 * rather than a fixed worst case: a duration ("12h05m") wants half again the
 * room a bare count ("360") does, and charging every metric the widest price
 * would thin labels that had space to spare. Digits are tabular here — see
 * .recharts-wrapper in styles.css — so a character count is a fair proxy.
 */
const dayLabelWidth = (rows: Row[]): number => {
  let longest = 0
  for (const r of rows) {
    const text = r[DAY_LABEL]
    if (typeof text === 'string') longest = Math.max(longest, text.length)
  }
  return longest * DAY_LABEL_ADVANCE + DAY_LABEL_GUTTER
}

/** The rendered width of an element, or 0 before it has been measured. */
function useMeasuredWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width]
}

/** Local minute stamp -> Date. Bare "YYYY-MM-DDTHH:MM" parses as local by spec. */
const stampToDate = (stamp: string): Date | null => {
  const d = new Date(stamp)
  return Number.isFinite(d.getTime()) ? d : null
}

function windowBand(w: MetricWindow): { from: number; to: number } | null {
  const start = stampToDate(w.start)
  const end = stampToDate(w.end)
  if (!start || !end) return null
  const anchor = new Date(start)
  anchor.setHours(12, 0, 0, 0)
  if (start.getHours() < 12) anchor.setDate(anchor.getDate() - 1)
  const from = (start.getTime() - anchor.getTime()) / 60_000
  const to = (end.getTime() - anchor.getTime()) / 60_000
  return to > from ? { from, to } : null
}

/** Shared bounds for every band, snapped out to whole hours. Null if no spans. */
function bandScale(series: MetricDay[]): { lo: number; hi: number } | null {
  let lo = Infinity
  let hi = -Infinity
  for (const d of series) {
    const b = d.window ? windowBand(d.window) : null
    if (!b) continue
    lo = Math.min(lo, b.from)
    hi = Math.max(hi, b.to)
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null
  return { lo: Math.floor(lo / 60) * 60, hi: Math.ceil(hi / 60) * 60 }
}

/** Minutes-from-anchor -> the clock the wearer saw. */
function fmtBandClock(mins: number): string {
  const mod = (((Math.round(mins) + NOON) % 1440) + 1440) % 1440
  const h = Math.floor(mod / 60)
  const m = mod % 60
  const suffix = h < 12 ? 'AM' : 'PM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return m === 0 ? `${h12} ${suffix}` : `${h12}:${String(m).padStart(2, '0')} ${suffix}`
}

const fmtStampClock = (stamp: string): string => {
  const [h, m] = stamp.slice(11).split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return stamp
  const suffix = h < 12 ? 'AM' : 'PM'
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${suffix}`
}

const fmtDuration = (mins: number): string => {
  const total = Math.round(mins)
  const h = Math.floor(total / 60)
  const m = total % 60
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

/** Spaceless, for a label sitting in a ~28px column: "6h25m", not "6h 25m". */
const fmtDurationTight = (mins: number): string => fmtDuration(mins).replace(' ', '')

// ---------- stat readings ----------
// Presentation for the readings a source attaches to a day. This lives here
// rather than in the habit's metric config because the keys are properties of
// the *source's* schema (WHOOP decides what a sleep record carries), not choices
// the user makes per habit — and normalizeHabitMetric is a whitelist, so config
// seeded into habits.json would be stripped on the next habit edit anyway.
// The display order is deliberate: how well you slept, then how long, then why.
type StatKind = 'pct' | 'dur' | 'num'
const STAT_META: Record<string, { label: string; kind: StatKind; unit?: string; decimals?: number }> = {
  recovery: { label: 'Recovery', kind: 'pct' },
  efficiency: { label: 'Efficiency', kind: 'pct' },
  consistency: { label: 'Consistency', kind: 'pct' },
  'in-bed': { label: 'Time in bed', kind: 'dur' },
  needed: { label: 'Sleep needed', kind: 'dur' },
  debt: { label: 'Sleep debt', kind: 'dur' },
  'strain-need': { label: 'Added by strain', kind: 'dur' },
  disturbances: { label: 'Disturbances', kind: 'num' },
  cycles: { label: 'Sleep cycles', kind: 'num' },
  'respiratory-rate': { label: 'Respiratory rate', kind: 'num', unit: 'rpm', decimals: 1 },
}
const STAT_ORDER = Object.keys(STAT_META)

/** Humanized fallback, so a key a source adds later still shows up. */
const statLabel = (key: string) =>
  STAT_META[key]?.label ?? key.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())

function fmtStat(key: string, value: number): string {
  const meta = STAT_META[key]
  if (meta?.kind === 'dur') return fmtDuration(value)
  if (meta?.kind === 'pct') return `${Math.round(value)}%`
  const n = value.toFixed(meta?.decimals ?? 0)
  return meta?.unit ? `${n} ${meta.unit}` : n
}

/** Present keys in STAT_ORDER first, then anything unrecognized, alphabetically. */
function orderedStats(stats: MetricStatMap): [string, number][] {
  const keys = Object.keys(stats)
  const known = STAT_ORDER.filter((k) => k in stats)
  const rest = keys.filter((k) => !(k in STAT_META)).sort()
  return [...known, ...rest].map((k) => [k, stats[k]] as [string, number])
}


// One row per day, drawn as two panels sharing an x-axis and a crosshair: the
// headline number on top, and the day's detail as a strip beneath it. The strip
// comes in two forms, and the data picks which:
//
//   - days carry a `window` -> the merged strip. Each night is one floating bar
//     on a labelled clock axis, running bedtime to wake, subdivided by stage.
//     Position answers "when", length answers "how long", color answers "which
//     stage" — three questions off one mark, which is why they're merged.
//   - days carry only `parts` -> the plain strip: the breakdown stacked from a
//     common baseline, no clock scale to hang it on.
//
// The headline number stays out of both. A 0–100 score and a clock time are
// different units, and drawing them against two hidden y-scales in one frame
// invents a correlation that isn't in the data. Separate panels, one shared x,
// and a synced crosshair keep the comparison honest.
//
// The line runs unbroken across unlogged days and carries a dot on every day
// that actually has a number. The dots are what makes that honest: the curve
// between two of them is interpolation, and only a dot means "this was logged."
// Past ~60 points they'd collide with each other, so a long range drops them and
// leans on the crosshair instead.
export function MetricChart({ metric, series, color, height = 150, compact }: MetricChartProps) {
  const uid = useId().replace(/:/g, '')
  const [cardRef, cardWidth] = useMeasuredWidth<HTMLDivElement>()
  const { lo, hi } = useMemo(() => axisBounds(series, metric), [series, metric])
  const hasParts = metric.parts.length > 0 && series.some((d) => d.partsTotal > 0)
  const hasValues = series.some((d) => d.value != null)
  const recoveryStops = useMemo(() => recoveryGradientStops(series), [series])
  const hasRecovery = recoveryStops.length > 0
  // Data-driven, not source-driven: any metric whose days carry a span gets the
  // strip. It needs room for its own clock axis, so a Home tile opts out.
  const band = useMemo(() => bandScale(series), [series])
  const hasWindow = !compact && band != null
  const hasBands = hasParts || hasWindow
  // One strip, not two: when the days carry spans, the stage breakdown is drawn
  // *inside* each span on the clock axis rather than as its own panel below it.
  // The standalone strip stays for metrics with parts but no spans (and for the
  // compact tile, which has no room for a clock axis).
  const hasPartsStrip = hasParts && !hasWindow

  const plotWidth = Math.max(0, cardWidth - Y_WIDTH - 12)

  const rows: Row[] = useMemo(() => {
    const built = series.map((d) => {
      const row: Row = { ...d }
      if (Number.isFinite(d.stats?.recovery)) row[RECOVERY_KEY] = d.stats!.recovery
      const span = band && d.window ? windowBand(d.window) : null
      // Standing alone, the parts are just a breakdown and always get emitted.
      // Inside the merged strip they're segments of a span, so a day with no span
      // has nowhere to put them — emitting them anyway would stack them up from
      // the axis floor and assert a bedtime that isn't in the data.
      if (!band || span) {
        for (const p of metric.parts) row[partKey(p.key)] = d.parts[p.key] || 0
        row[P_CAP] = 0
      }
      if (band && span) {
        // A floating bar, done as a stack: an invisible riser to the start of the
        // span, then the span's contents. Recharts has no range bar, and giving the
        // strip a 0-based domain (rather than one starting at `band.lo`) keeps the
        // stack arithmetic exact instead of leaning on domain clipping.
        row[W_PAD] = span.from - band.lo
        // Whatever the span covers that the parts don't account for: the entire
        // band on a night logged before stages were captured, or a no-data gap.
        // Without it the bar would stop short and misreport the wake time.
        row[W_REST] = Math.max(0, span.to - span.from - d.partsTotal)
      }
      // What the day's label says. On the merged strip that's the length of the
      // night — the bar's two ends already say *when* it ran, and length is the
      // one thing a clock axis makes you measure by eye. On the plain strip it's
      // the stack's own total. `parts` is a generic breakdown any habit can
      // define and its unit isn't always minutes, so only the source that stages
      // durations into it gets the "6h25m" read; the rest get the bare total.
      const mins = span ? span.to - span.from : null
      if (mins) row[DAY_LABEL] = fmtDurationTight(mins)
      else if (!span && d.partsTotal) {
        row[DAY_LABEL] = metric.source === 'whoop-sleep'
          ? fmtDurationTight(d.partsTotal)
          : String(Math.round(d.partsTotal))
      }
      return row
    })

    // Then thin: a range too dense to sit its labels side by side drops some of
    // them rather than overlapping. How many fit is measured off the card, not
    // assumed — the same thirty nights are ~28px a column on a laptop and ~45px
    // on a wide monitor, and only one of those has room above every bar. Kept
    // counting back from the newest day, so today keeps its label at any stride.
    const stride = Math.max(1, Math.ceil(
      // Before the first measurement, guess low rather than high: too many
      // labels for one frame is a visible flash of overlapping text.
      plotWidth ? dayLabelWidth(built) / (plotWidth / built.length) : built.length / 25,
    ))
    if (stride > 1) {
      built.forEach((row, i) => {
        if ((built.length - 1 - i) % stride !== 0) delete row[DAY_LABEL]
      })
    }
    return built
  }, [series, metric.parts, metric.source, band, plotWidth])

  /** Does any night have span time the parts don't account for? Drives the legend. */
  const hasRest = hasWindow && rows.some((r) => ((r[W_REST] as number) || 0) > 0)

  /**
   * The day's number, set just clear of the top of its bar.
   *
   * `edge` picks which end of the host rect is that top, because the two strips
   * hang their labels off different bars. The merged strip rides the invisible
   * riser, whose *lower* edge tracks the top of the visible bar at any bedtime;
   * the plain strip rides its topmost segment, whose upper edge is the stack
   * top. Recharts reports a reversed-axis rect with a negative height, so both
   * edges are taken as a min/max of the two corners rather than assumed.
   */
  const dayLabelRenderer = (edge: 'lower' | 'upper') => (props: any) => {
    const { x, y, width, height, value } = props
    if (typeof value !== 'string' || !value) return null
    const h = Number.isFinite(height) ? height : 0
    if (![x, y, width].every((n) => Number.isFinite(n))) return null
    const top = edge === 'lower' ? Math.max(y, y + h) : Math.min(y, y + h)
    return (
      <text
        x={x + width / 2}
        y={Math.max(top - 5, 9)}
        textAnchor="middle"
        fontSize={DAY_LABEL_SIZE}
        fill="var(--muted)"
      >
        {value}
      </text>
    )
  }
  const renderBandLabel = dayLabelRenderer('lower')
  const renderPartsLabel = dayLabelRenderer('upper')

  // A dot is r3 plus a 2px surface ring — 10px of mark, so they need ~12px of
  // run each before they start touching. Roughly 60 across a card's width.
  const showDots = series.filter((d) => d.value != null).length <= 60
  const showRecoveryDots = recoveryStops.length <= 60
  const renderDot = useMemo(() => (props: any) => {
    const { cx, cy, key } = props
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return <g key={key} />
    return <circle key={key} cx={cx} cy={cy} r={3} fill={color} stroke={CHART_SURFACE} strokeWidth={2} />
  }, [color])
  const renderRecoveryDot = useMemo(() => (props: any) => {
    const { cx, cy, key, payload } = props
    const score = payload?.[RECOVERY_KEY]
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(score)) return <g key={key} />
    return (
      <circle
        key={key}
        cx={cx}
        cy={cy}
        r={3}
        fill={recoveryColor(score)}
        stroke={CHART_SURFACE}
        strokeWidth={2}
      />
    )
  }, [])

  // One readout for both panels. The parts strip gets the crosshair but no card
  // of its own — syncId hands the hovered day to the panel above, so a second
  // card would just be the same numbers twice.
  const tip = (
    <Tooltip cursor={crosshair} isAnimationActive={false} content={<MetricTip metric={metric} color={color} />} />
  )
  const cursorOnly = <Tooltip cursor={crosshair} isAnimationActive={false} content={renderNothing} />
  const xAxis = (hidden: boolean) => (
    <XAxis dataKey="date" {...xAxisProps} tickFormatter={fmtAxisDay} hide={hidden} />
  )

  if (!hasValues && !hasRecovery && !hasParts && !hasWindow) {
    return <div className="metric-empty">No {metric.label.toLowerCase()} logged yet — add today's number from the check-in.</div>
  }

  const partsHeight = compact ? 38 : 52
  // The merged strip is now the detailed panel, so it gets the room: it carries a
  // labelled clock axis, four stage segments per night, and is the thing you
  // actually read bedtime drift off.
  const bandHeight = 190

  return (
    <div className="metric-chart" ref={cardRef}>
      <ResponsiveContainer width="100%" height={height}>
        {/* When the parts strip owns the x-axis, the top panel still needs a few
            pixels below the plot or Recharts drops its lowest y-tick for want of
            room to draw the label. */}
        <ComposedChart data={rows} syncId={uid} margin={{ top: 10, right: 12, bottom: hasBands ? 8 : 0, left: 0 }}>
          <defs>
            <AreaWash id={`wash-${uid}`} color={color} />
            {hasRecovery && (
              <>
                {/* Vertical, because recovery color is a function of score (y),
                    not the date's horizontal position. The helper normalizes the
                    WHOOP thresholds to this path's observed score domain. */}
                <linearGradient id={`recovery-${uid}`} x1="0" y1="1" x2="0" y2="0">
                  {recoveryStops.map((stop, i) => (
                    <stop key={`${stop.offset}-${i}`} offset={stop.offset} stopColor={stop.color} />
                  ))}
                </linearGradient>
              </>
            )}
          </defs>
          <CartesianGrid stroke={GRID} vertical={false} />
          {xAxis(hasBands)}
          <YAxis
            {...yAxisProps}
            width={Y_WIDTH}
            domain={[lo, hi]}
            ticks={niceTicks(lo, hi, compact ? 4 : 5)}
            tickFormatter={(v: number) => fmtMetric(v, metric, false)}
          />
          {metric.goal != null && metric.goal > lo && metric.goal < hi && (
            <ReferenceLine
              y={metric.goal}
              stroke="var(--muted)"
              strokeDasharray="4 4"
              strokeOpacity={0.7}
              label={{ value: `goal ${fmtMetric(metric.goal, metric)}`, position: 'insideTopRight', ...AXIS_TICK, dy: -3 }}
            />
          )}
          {tip}
          {metric.chart === 'bar' ? (
            <Bar dataKey="value" fill={color} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
          ) : (
            <>
              {/* An inkless bar. A Recharts line alone gets a point scale (first
                  point on the y-axis, last on the right edge) while a bar gets a
                  band scale (points centered in their day's slot) — so without
                  this the line would sit half a day off from the parts strip
                  below it. The bar establishes the band; it draws nothing. */}
              {hasBands && (
                <Bar dataKey="value" fillOpacity={0} isAnimationActive={false} legendType="none" />
              )}
              {/* monotone, not natural/basis: it curves without overshooting
                  past a point's own value, so the eye never reads a peak the
                  data doesn't have. The wash uses the same curve as the line. */}
              <Area
                type="monotone" dataKey="value" stroke="none" fill={`url(#wash-${uid})`}
                connectNulls isAnimationActive={false} activeDot={false}
              />
              <Line
                type="monotone" dataKey="value" stroke={color} strokeWidth={2}
                strokeLinecap="round" strokeLinejoin="round"
                dot={showDots ? renderDot : false} activeDot={activeDot(color)}
                connectNulls isAnimationActive={false}
              />
            </>
          )}
          {hasRecovery && (
            <Line
              type="monotone"
              dataKey={RECOVERY_KEY}
              name="Recovery"
              stroke={`url(#recovery-${uid})`}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={showRecoveryDots ? renderRecoveryDot : false}
              activeDot={renderRecoveryDot}
              connectNulls
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>

      {hasPartsStrip && (
        <ResponsiveContainer width="100%" height={partsHeight + (compact ? 20 : 32)}>
          <BarChart data={rows} syncId={uid} margin={{ top: compact ? 4 : 16, right: 12, bottom: 0, left: 0 }}>
            {xAxis(false)}
            {/* Untitled and tickless — the strip is a texture read, and the
                tooltip carries its numbers. It keeps the main chart's left
                inset so the two panels' columns stay aligned. */}
            <YAxis width={Y_WIDTH} tick={false} tickLine={false} axisLine={false} />
            {cursorOnly}
            {metric.parts.map((p, i) => (
              <Bar
                key={p.key}
                dataKey={partKey(p.key)}
                stackId="parts"
                fill={p.color}
                /* A hairline in the surface color is the 2px gap between
                   stacked segments, not a border around them. */
                stroke={CHART_SURFACE}
                strokeWidth={1}
                maxBarSize={24}
                radius={i === metric.parts.length - 1 ? [3, 3, 0, 0] : undefined}
                isAnimationActive={false}
              />
            ))}
            {/* The stack's cap: no height, no ink, and the label hangs off it.
                Riding the topmost *part* instead would lose the label on any day
                that part happens to be zero — a night with no awake time, say.
                A Home tile gives each day ~10px, which is not a column you can
                put a number in, so it keeps the tooltip and skips the labels. */}
            <Bar dataKey={P_CAP} stackId="parts" shape={noShape} isAnimationActive={false} legendType="none">
              {!compact && <LabelList dataKey={DAY_LABEL} content={renderPartsLabel} />}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}

      {hasWindow && band && (
        <ResponsiveContainer width="100%" height={bandHeight}>
          {/* top margin is the labels' room — they sit above the tallest bar. */}
          <BarChart data={rows} syncId={uid} margin={{ top: 18, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            {xAxis(false)}
            {/* Clock time, labelled — unlike the parts strip this axis carries
                meaning the tooltip can't replace: the eye reads bedtime drift
                across the month off the y position alone. */}
            {/* Reversed: the night reads top-to-bottom the way it's lived and the
                way a calendar draws it — you go to bed at the top of the bar and
                wake at the bottom. The stack is unaffected; only the scale flips. */}
            <YAxis
              {...yAxisProps}
              reversed
              width={Y_WIDTH}
              domain={[0, band.hi - band.lo]}
              ticks={bandTicks(band)}
              tickFormatter={(v: number) => fmtBandClock(band.lo + v)}
            />
            {cursorOnly}
            {/* The invisible riser up to bedtime. It draws no ink, but it does
                carry the night's duration label — its lower edge tracks the top
                of the visible bar for free, on every night, at any bedtime. */}
            <Bar dataKey={W_PAD} stackId="window" shape={noShape} isAnimationActive={false} legendType="none">
              <LabelList dataKey={DAY_LABEL} content={renderBandLabel} />
            </Bar>
            {/* Then the night itself, subdivided by stage. The segment *lengths*
                are real minutes and the bar's two ends are the real clock times,
                but the order within the night is not: WHOOP reports per-stage
                totals, not a hypnogram. Hence the caption under the legend — a
                reader must not take the deep block's position for "when". */}
            {metric.parts.map((p) => (
              <Bar
                key={p.key}
                dataKey={partKey(p.key)}
                stackId="window"
                fill={p.color}
                stroke={CHART_SURFACE}
                strokeWidth={0.75}
                maxBarSize={BAND_BAR}
                isAnimationActive={false}
              />
            ))}
            {/* Span time no stage accounts for, so the bar always reaches wake. */}
            <Bar
              dataKey={W_REST}
              stackId="window"
              fill={color}
              fillOpacity={0.3}
              stroke={color}
              strokeOpacity={0.55}
              strokeWidth={1}
              maxBarSize={BAND_BAR}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      )}

      {(hasRecovery || hasParts || hasWindow) && (
        <ChartLegend
          items={[
            ...(hasRecovery ? [{ color: RECOVERY_YELLOW, label: 'Recovery · red 0–33 · yellow 34–66 · green 67–100', kind: 'line' as const }] : []),
            ...(hasParts ? metric.parts.map((p) => ({ color: p.color, label: p.label })) : []),
            ...(hasRest ? [{ color, label: metric.source === 'whoop-sleep' ? 'In bed, unscored' : 'Unaccounted' }] : []),
          ]}
        />
      )}
      {hasWindow && hasParts && (
        <div className="metric-band-note">
          Bar ends are the real bedtime and wake time; segment sizes are real minutes.
          Their order isn't when the stages happened — WHOOP reports totals, not a hypnogram.
        </div>
      )}
    </div>
  )
}

/** Even-hour gridlines, thinned to keep the strip's labels from colliding. */
function bandTicks({ lo, hi }: { lo: number; hi: number }): number[] {
  const span = hi - lo
  const step = span > 900 ? 240 : span > 480 ? 120 : 60
  const out: number[] = []
  for (let t = 0; t <= span; t += step) out.push(t)
  return out
}

// One tooltip covering both panels: the day's headline number, then the
// breakdown, then whatever note was left on it.
function MetricTip({ active, payload, metric, color }: any) {
  if (!active || !payload?.length) return null
  const day = payload[0]?.payload as MetricDay | undefined
  if (!day) return null
  return (
    <ChartTip>
      <ChartTipHead>{fmtTipDay(day.date)}</ChartTipHead>
      <ChartTipLead
        color={color}
        value={day.value != null ? fmtMetric(day.value, metric) : 'not logged'}
        sub={metric.label}
      />
      {day.partsTotal > 0 && (
        <div className="ck-tip-rows">
          {metric.parts.filter((p: MetricPart) => day.parts[p.key]).map((p: MetricPart) => (
            <ChartTipRow key={p.key} color={p.color} label={p.label} value={day.parts[p.key]} />
          ))}
          <div className="ck-tip-row total">
            <span className="ck-tip-label">Total</span>
            <b>{Math.round(day.partsTotal)}</b>
          </div>
        </div>
      )}
      {day.window && (
        <div className="ck-tip-rows">
          <div className="ck-tip-row total">
            <span className="ck-tip-label">{metric.source === 'whoop-sleep' ? 'In bed' : 'Window'}</span>
            <b>{fmtStampClock(day.window.start)} → {fmtStampClock(day.window.end)}</b>
          </div>
        </div>
      )}
      {day.stats && Object.keys(day.stats).length > 0 && (
        <div className="ck-tip-rows ck-tip-stats">
          {orderedStats(day.stats).map(([key, v]) => (
            <div className="ck-tip-row" key={key}>
              <span className="ck-tip-label">{statLabel(key)}</span>
              <b>{fmtStat(key, v)}</b>
            </div>
          ))}
        </div>
      )}
      {day.note && <div className="ck-tip-note">{day.note}</div>}
    </ChartTip>
  )
}

// The numbers above the chart: where it sits now, and which way it's going.
export function MetricStatsStrip({ metric, stats, color }: { metric: MetricConfig; stats: MetricStats; color: string }) {
  const good = stats.delta == null ? null : metric.direction === 'lower' ? stats.delta < 0 : stats.delta > 0
  const flat = stats.delta != null && Math.abs(stats.delta) < 0.05
  return (
    <div className="metric-stats">
      <span className="metric-stat lead">
        <b style={{ color }}>{fmtMetric(stats.latest?.value, metric)}</b>
        <small>latest</small>
      </span>
      <span className="metric-stat">
        <b>{fmtMetric(stats.recentAvg, metric)}</b>
        <small>7-day avg</small>
      </span>
      {stats.delta != null && !flat && (
        <span className={`metric-trend${good ? ' good' : ' bad'}`}>
          {stats.delta > 0 ? '▲' : '▼'} {fmtMetric(Math.abs(stats.delta), metric, false)}
          <small>vs. prior week</small>
        </span>
      )}
      <span style={{ flex: 1 }} />
      <span className="metric-stat muted-stat">
        <b>{fmtMetric(stats.avg, metric)}</b>
        <small>average</small>
      </span>
    </div>
  )
}
