// A pinned habit metric on the Overview: the web's HabitMetricSection in its
// compact Home form (no range switcher, no head, 30 days), with MetricChart drawn
// in react-native-svg instead of Recharts. Only what the compact tile shows is
// here: the headline line or bars, the goal line, the stacked parts strip and its
// legend. The WHOOP recovery line and sleep-window strip never reach the Overview
// (the synced sleep habit is filtered out there), so they are not ported.
import React, { useMemo, useState } from 'react'
import { View } from 'react-native'
import Svg, { Circle, Defs, Line, LinearGradient, Path, Rect, Stop, Text as SvgText } from 'react-native-svg'
import { colors, fonts } from '../../theme'
import { T } from '../../ui/Text'
import { ov } from './parts'
import {
  axisBounds, fmtMetric, metricSeries, metricStats, niceTicks,
  type MetricConfig, type MetricDay, type MetricStats,
} from './metric'
import { isoToDate } from '../../lib/components/overview/time'

export function HabitMetricSection({ habit, entries, today, days = 30 }: { habit: any; entries: any; today: string; days?: number }) {
  const metric = habit.metric as MetricConfig
  const series = useMemo(() => metricSeries(entries, habit.id, today, days), [entries, habit.id, today, days])
  const stats = useMemo(() => metricStats(series), [series])
  return (
    <View>
      <MetricStatsStrip metric={metric} stats={stats} color={habit.color} />
      <MetricChart metric={metric} series={series} color={habit.color} height={120} />
    </View>
  )
}

// The numbers above the chart: where it sits now, and which way it's going.
function MetricStatsStrip({ metric, stats, color }: { metric: MetricConfig; stats: MetricStats; color: string }) {
  const good = stats.delta == null ? null : metric.direction === 'lower' ? stats.delta < 0 : stats.delta > 0
  const flat = stats.delta != null && Math.abs(stats.delta) < 0.05
  const small = (text: string) => <T size={10.5} muted>{` ${text}`}</T>
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 16, rowGap: 4, marginTop: 8, marginBottom: 2 }}>
      <T size={20} weight={700} color={color}>{fmtMetric(stats.latest?.value, metric)}{small('latest')}</T>
      <T size={15} weight={700}>{fmtMetric(stats.recentAvg, metric)}{small('7-day avg')}</T>
      {stats.delta != null && !flat && (
        <T size={12.5} weight={600} color={good ? '#40c463' : '#f0506e'}>
          {stats.delta > 0 ? '▲' : '▼'} {fmtMetric(Math.abs(stats.delta), metric, false)}{small('vs. prior week')}
        </T>
      )}
      <View style={{ flex: 1 }} />
      <T size={15} weight={600} muted>{fmtMetric(stats.avg, metric)}{small('average')}</T>
    </View>
  )
}

const Y_WIDTH = 42
const RIGHT = 12
const AXIS = { fontSize: 10.5, fill: colors.muted, fontFamily: fonts[400] }
const fmtAxisDay = (iso: string) => isoToDate(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })

// d3's curveMonotoneX: curves without overshooting a point's own value, so the
// eye never reads a peak the data doesn't have (Recharts' type="monotone").
function monotonePath(pts: { x: number; y: number }[]): string {
  if (!pts.length) return ''
  if (pts.length === 1) return `M${pts[0].x},${pts[0].y}`
  if (pts.length === 2) return `M${pts[0].x},${pts[0].y}L${pts[1].x},${pts[1].y}`
  const n = pts.length
  const sign = (v: number) => (v < 0 ? -1 : 1)
  const t: number[] = new Array(n).fill(0)
  for (let i = 1; i < n - 1; i++) {
    const h0 = pts[i].x - pts[i - 1].x, h1 = pts[i + 1].x - pts[i].x
    const s0 = (pts[i].y - pts[i - 1].y) / (h0 || 1), s1 = (pts[i + 1].y - pts[i].y) / (h1 || 1)
    const p = (s0 * h1 + s1 * h0) / (h0 + h1 || 1)
    t[i] = (sign(s0) + sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0
  }
  const end = (a: { x: number; y: number }, b: { x: number; y: number }, tn: number) => {
    const h = b.x - a.x
    return h ? (3 * (b.y - a.y) / h - tn) / 2 : tn
  }
  t[0] = end(pts[0], pts[1], t[1])
  t[n - 1] = end(pts[n - 2], pts[n - 1], t[n - 2])
  let d = `M${pts[0].x},${pts[0].y}`
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i], b = pts[i + 1], dx = (b.x - a.x) / 3
    d += `C${a.x + dx},${a.y + dx * t[i]},${b.x - dx},${b.y - dx * t[i + 1]},${b.x},${b.y}`
  }
  return d
}

/** Which days get an x label: evenly spaced, the newest always kept (Recharts' preserveStartEnd). */
function xTickIndices(series: MetricDay[], xAt: (i: number) => number): number[] {
  const width = (i: number) => fmtAxisDay(series[i].date).length * 5.9
  const out: number[] = []
  const last = series.length - 1
  for (let i = 0; i <= last; i++) {
    const prev = out[out.length - 1]
    if (prev == null || xAt(i) - xAt(prev) >= (width(i) + width(prev)) / 2 + 32) out.push(i)
  }
  while (out.length && out[out.length - 1] !== last && xAt(last) - xAt(out[out.length - 1]) < (width(last) + width(out[out.length - 1])) / 2 + 32) out.pop()
  if (out[out.length - 1] !== last) out.push(last)
  return out
}

/** A bar whose top corners are rounded, as one path. */
function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h))
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`
}

function MetricChart({ metric, series, color, height = 120 }: { metric: MetricConfig; series: MetricDay[]; color: string; height?: number }) {
  const [width, setWidth] = useState(0)
  const { lo, hi } = useMemo(() => axisBounds(series, metric), [series, metric])
  const hasParts = metric.parts.length > 0 && series.some((d) => d.partsTotal > 0)
  const hasValues = series.some((d) => d.value != null)

  if (!hasValues && !hasParts) {
    return (
      <T size={13} muted style={{ paddingVertical: 10 }}>
        No {metric.label.toLowerCase()} logged yet — add today's number from the check-in.
      </T>
    )
  }

  const n = series.length
  const plotW = Math.max(0, width - Y_WIDTH - RIGHT)
  const band = plotW / Math.max(1, n)
  // A bar (or a parts strip under a line) puts each day in the middle of its slot;
  // a line alone runs edge to edge, as Recharts' point scale does.
  const banded = metric.chart === 'bar' || hasParts
  const xAt = (i: number) => Y_WIDTH + (banded ? band * (i + 0.5) : n > 1 ? (plotW * i) / (n - 1) : plotW / 2)
  const barW = Math.min(24, band * 0.8)

  // Top panel: the x axis lives under the parts strip when there is one.
  const top = 10
  const bottom = height - (hasParts ? 8 : 20)
  const yAt = (v: number) => top + ((hi - v) / (hi - lo)) * (bottom - top)
  const ticks = niceTicks(lo, hi, 4)
  const xTicks = width ? xTickIndices(series, xAt) : []
  const goalShown = metric.goal != null && metric.goal > lo && metric.goal < hi

  const xAxis = (y: number) => (
    <>
      <Line x1={Y_WIDTH} x2={Y_WIDTH + plotW} y1={y} y2={y} stroke={colors.line} strokeWidth={1} />
      {xTicks.map((i) => (
        <SvgText key={i} x={xAt(i)} y={y + 14} textAnchor={i === n - 1 && !banded ? 'end' : i === 0 && !banded ? 'start' : 'middle'} {...AXIS}>
          {fmtAxisDay(series[i].date)}
        </SvgText>
      ))}
    </>
  )

  const pts = series.map((d, i) => (d.value != null ? { x: xAt(i), y: yAt(d.value) } : null)).filter(Boolean) as { x: number; y: number }[]
  const line = monotonePath(pts)
  const showDots = pts.length <= 60

  // Parts strip: stacked from a common baseline, scaled to its own round ceiling.
  const partsH = 38 + 20
  const pTop = 4, pBottom = 38
  const partsMax = Math.max(1, ...series.map((d) => d.partsTotal))
  const pCeil = niceTicks(0, partsMax, 5).slice(-1)[0] || partsMax
  const pScale = (v: number) => (v / pCeil) * (pBottom - pTop)

  return (
    <View style={{ marginTop: 4, marginBottom: 2 }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 && (
        <Svg width={width} height={height}>
          <Defs>
            <LinearGradient id="wash" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={color} stopOpacity={0.26} />
              <Stop offset="1" stopColor={color} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Line x1={Y_WIDTH} x2={Y_WIDTH + plotW} y1={top} y2={top} stroke={colors.line} strokeWidth={1} />
          {ticks.map((v) => (
            <React.Fragment key={v}>
              <Line x1={Y_WIDTH} x2={Y_WIDTH + plotW} y1={yAt(v)} y2={yAt(v)} stroke={colors.line} strokeWidth={1} />
              <SvgText x={Y_WIDTH - 6} y={yAt(v) + 3.5} textAnchor="end" {...AXIS}>{fmtMetric(v, metric, false)}</SvgText>
            </React.Fragment>
          ))}
          {metric.chart === 'bar' ? (
            series.map((d, i) => {
              if (d.value == null) return null
              // Bars stand on zero, or on the floor when the axis starts above it.
              const y = yAt(d.value), base = yAt(Math.min(hi, Math.max(lo, 0)))
              const h = base - y
              return h > 0 ? <Path key={d.date} d={topRounded(xAt(i) - barW / 2, y, barW, h, 4)} fill={color} /> : null
            })
          ) : (
            <>
              {pts.length > 1 && (
                <Path d={`${line}L${pts[pts.length - 1].x},${bottom}L${pts[0].x},${bottom}Z`} fill="url(#wash)" />
              )}
              <Path d={line} stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
              {showDots && pts.map((p, i) => <Circle key={i} cx={p.x} cy={p.y} r={3} fill={color} stroke={ov.knock} strokeWidth={2} />)}
            </>
          )}
          {goalShown && (
            <>
              <Line
                x1={Y_WIDTH} x2={Y_WIDTH + plotW} y1={yAt(metric.goal!)} y2={yAt(metric.goal!)}
                stroke={colors.muted} strokeOpacity={0.7} strokeDasharray="4 4" strokeWidth={1}
              />
              <SvgText x={Y_WIDTH + plotW - 5} y={yAt(metric.goal!) + 10} textAnchor="end" {...AXIS}>
                {`goal ${fmtMetric(metric.goal, metric)}`}
              </SvgText>
            </>
          )}
          {!hasParts && xAxis(bottom)}
        </Svg>
      )}

      {width > 0 && hasParts && (
        <Svg width={width} height={partsH}>
          {series.map((d, i) => {
            if (!d.partsTotal) return null
            let y = pBottom
            const present = metric.parts.filter((p) => (d.parts[p.key] || 0) > 0)
            return present.map((p, k) => {
              const h = pScale(d.parts[p.key] || 0)
              y -= h
              const x = xAt(i) - barW / 2
              // A hairline in the surface colour is the gap between segments.
              return k === present.length - 1
                ? <Path key={`${d.date}-${p.key}`} d={topRounded(x, y, barW, h, 3)} fill={p.color} stroke={ov.knock} strokeWidth={1} />
                : <Rect key={`${d.date}-${p.key}`} x={x} y={y} width={barW} height={h} fill={p.color} stroke={ov.knock} strokeWidth={1} />
            })
          })}
          {xAxis(pBottom)}
        </Svg>
      )}

      {hasParts && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 8 }}>
          {metric.parts.map((p) => (
            <View key={p.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <View style={{ width: 9, height: 9, borderRadius: 3, backgroundColor: p.color }} />
              <T size={11} muted>{p.label}</T>
            </View>
          ))}
        </View>
      )}
    </View>
  )
}
