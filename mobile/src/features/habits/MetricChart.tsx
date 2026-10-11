// The graph under a habit that carries a number (web MetricChart.tsx +
// HabitMetricSection). The web draws it with Recharts; here it is react-native-svg
// with the same anatomy: the headline value as a line or bars on the metric's axis,
// a dashed goal line, and — when the metric has a breakdown — a stacked strip of the
// parts underneath with each day's total on top, then a legend. Tooltips (a hover
// affordance) are left out; the stats strip carries the numbers.
import React, { useMemo, useState } from 'react'
import { View } from 'react-native'
import Svg, { Defs, G, Line, LinearGradient, Path, Rect, Stop, Text as SvgText, Circle } from 'react-native-svg'
import { colors, fonts } from '../../theme'
import { T } from '../../ui/Text'
import {
  axisBounds, fmtMetric, metricSeries, metricStats, niceTicks,
  type MetricConfig, type MetricDay, type MetricStats,
} from '../../lib/components/metricChart'
import { SegSwitch } from './form'
import type { Entries, Habit } from './logic'

const Y_WIDTH = 42
const X_AXIS = 18
const TICK = { fontSize: 10, fill: colors.muted, fontFamily: fonts[400] }

const fmtAxisDay = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString([], { month: 'short', day: 'numeric' })
}
const fmtTick = (v: number) => (Math.abs(v) >= 1000 ? String(Math.round(v)) : String(Math.round(v * 100) / 100))

export function MetricChart({ metric, series, color, height = 150, compact }: {
  metric: MetricConfig
  series: MetricDay[]
  color: string
  height?: number
  compact?: boolean
}) {
  const [width, setWidth] = useState(0)
  const logged = series.some((d) => d.value != null || d.partsTotal > 0)
  const hasParts = metric.parts.length > 0 && series.some((d) => d.partsTotal > 0)
  const band = hasParts ? (compact ? 44 : 70) : 0
  const plotH = height - X_AXIS
  const { lo, hi } = useMemo(() => axisBounds(series, metric), [series, metric])
  const ticks = useMemo(() => niceTicks(lo, hi, 3).filter((t) => t >= lo && t <= hi), [lo, hi])
  const partsMax = useMemo(() => Math.max(1, ...series.map((d) => d.partsTotal)), [series])

  if (!logged) return <T size={12} muted style={{ paddingTop: 10, paddingBottom: 2 }}>Nothing logged in this range yet.</T>

  const plotW = Math.max(0, width - Y_WIDTH - 4)
  const n = series.length
  const slot = n ? plotW / n : 0
  const xAt = (i: number) => Y_WIDTH + slot * (i + 0.5)
  const yAt = (v: number) => 6 + (1 - (v - lo) / (hi - lo)) * (plotH - 12)
  const barW = Math.max(2, Math.min(18, slot * 0.62))

  // The line breaks over days with nothing logged rather than inventing a slope.
  let linePath = ''
  let areaPath = ''
  if (metric.chart === 'line') {
    let run: [number, number][] = []
    const flush = () => {
      if (!run.length) return
      linePath += run.map(([x, y], k) => `${k ? 'L' : 'M'} ${x} ${y}`).join(' ') + ' '
      if (run.length > 1) areaPath += `M ${run[0][0]} ${plotH - 6} ` + run.map(([x, y]) => `L ${x} ${y}`).join(' ') + ` L ${run[run.length - 1][0]} ${plotH - 6} Z `
      run = []
    }
    series.forEach((d, i) => { if (d.value == null) flush(); else run.push([xAt(i), yAt(d.value)]) })
    flush()
  }

  // About four date labels, evenly spaced, the last one on the newest day.
  const labelEvery = Math.max(1, Math.round(n / 4))
  const xLabels = series.map((d, i) => ({ d, i })).filter(({ i }) => (n - 1 - i) % labelEvery === 0)
  const totalH = plotH + band + X_AXIS

  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ marginTop: 4, marginBottom: 2 }}>
      {width > 0 && (
        <Svg width={width} height={totalH}>
          <Defs>
            <LinearGradient id={`mcwash${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={color} stopOpacity={0.28} />
              <Stop offset="1" stopColor={color} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          {ticks.map((t) => (
            <G key={t}>
              <Line x1={Y_WIDTH} x2={width - 4} y1={yAt(t)} y2={yAt(t)} stroke={colors.line} strokeWidth={1} />
              <SvgText {...TICK} x={Y_WIDTH - 6} y={yAt(t) + 3.5} textAnchor="end">{fmtTick(t)}</SvgText>
            </G>
          ))}
          {metric.chart === 'bar'
            ? series.map((d, i) => d.value == null ? null : (
                <Rect
                  key={d.date}
                  x={xAt(i) - barW / 2} y={yAt(d.value)} width={barW}
                  height={Math.max(1, yAt(Math.max(lo, 0)) - yAt(d.value))}
                  rx={2} fill={color}
                />
              ))
            : (
              <>
                {areaPath ? <Path d={areaPath} fill={`url(#mcwash${color.replace("#", "")})`} /> : null}
                <Path d={linePath} stroke={color} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
                {series.map((d, i) => d.value == null ? null : <Circle key={d.date} cx={xAt(i)} cy={yAt(d.value)} r={n > 60 ? 1.5 : 2.5} fill={color} />)}
              </>
            )}
          {metric.goal != null && metric.goal >= lo && metric.goal <= hi && (
            <G>
              <Line x1={Y_WIDTH} x2={width - 4} y1={yAt(metric.goal)} y2={yAt(metric.goal)} stroke={colors.muted} strokeDasharray="4 4" strokeWidth={1} />
              <SvgText {...TICK} x={width - 6} y={yAt(metric.goal) - 4} textAnchor="end">{`goal ${fmtMetric(metric.goal, metric)}`}</SvgText>
            </G>
          )}
          {hasParts && (() => { let lastLabel = -Infinity; return series.map((d, i) => {
            if (!d.partsTotal) return null
            const base = plotH + band - 4
            const scale = (band - 18) / partsMax
            let y = base
            const w = Math.max(2, Math.min(12, slot * 0.5))
            return (
              <G key={`p-${d.date}`}>
                {metric.parts.map((p) => {
                  const v = d.parts[p.key] || 0
                  if (!v) return null
                  const h = v * scale
                  y -= h
                  return <Rect key={p.key} x={xAt(i) - w / 2} y={y} width={w} height={h} fill={p.color} />
                })}
                {!compact && xAt(i) - lastLabel >= 24 && (lastLabel = xAt(i)) && (
                  <SvgText {...TICK} fontSize={9.5} x={xAt(i)} y={y - 3} textAnchor="middle">{String(Math.round(d.partsTotal))}</SvgText>
                )}
              </G>
            )
          }) })()}
          {xLabels.map(({ d, i }) => (
            <SvgText key={`x-${d.date}`} {...TICK} x={Math.min(Math.max(xAt(i), Y_WIDTH + 14), width - 18)} y={totalH - 4} textAnchor="middle">{fmtAxisDay(d.date)}</SvgText>
          ))}
        </Svg>
      )}
      {!compact && metric.parts.length > 0 && (
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

// The numbers above the chart: where it sits now, and which way it's going.
export function MetricStatsStrip({ metric, stats, color }: { metric: MetricConfig; stats: MetricStats; color: string }) {
  const good = stats.delta == null ? null : metric.direction === 'lower' ? stats.delta < 0 : stats.delta > 0
  const flat = stats.delta != null && Math.abs(stats.delta) < 0.05
  const stat = (value: string, caption: string, opts: { lead?: boolean; muted?: boolean; color?: string } = {}) => (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 5 }}>
      <T size={opts.lead ? 20 : 15} weight={opts.lead ? 700 : 600} color={opts.color ?? (opts.muted ? colors.muted : colors.text)} style={{ fontVariant: ['tabular-nums'] }}>{value}</T>
      <T size={10.5} muted>{caption}</T>
    </View>
  )
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 16, rowGap: 4, marginTop: 8, marginBottom: 2 }}>
      {stat(fmtMetric(stats.latest?.value, metric), 'latest', { lead: true, color })}
      {stat(fmtMetric(stats.recentAvg, metric), '7-day avg')}
      {stats.delta != null && !flat && (
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 5 }}>
          <T size={12.5} weight={600} color={good ? '#40c463' : colors.red}>
            {stats.delta > 0 ? '▲' : '▼'} {fmtMetric(Math.abs(stats.delta), metric, false)}
          </T>
          <T size={10.5} muted>vs. prior week</T>
        </View>
      )}
      <View style={{ flex: 1 }} />
      {stat(fmtMetric(stats.avg, metric), 'average', { muted: true })}
    </View>
  )
}

const METRIC_RANGES = [
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
  { days: 365, label: '1y' },
]

/** HabitMetricSection on the Habits tab: label, range switch, stats, chart. */
export function HabitMetricSection({ habit, entries, today }: { habit: Habit; entries: Entries; today: string }) {
  const metric = habit.metric!
  const [days, setDays] = useState(30)
  const series = useMemo(() => metricSeries(entries, habit.id, today, days), [entries, habit.id, today, days])
  const stats = useMemo(() => metricStats(series), [series])
  return (
    <View style={{ marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.line }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap' }}>
        <T size={12} weight={600} muted>{metric.label}</T>
        <SegSwitch
          small
          value={String(days)}
          options={METRIC_RANGES.map((r) => ({ value: String(r.days), label: r.label }))}
          onChange={(v) => setDays(Number(v))}
        />
      </View>
      <MetricStatsStrip metric={metric} stats={stats} color={habit.color} />
      <MetricChart metric={metric} series={series} color={habit.color} height={160} />
    </View>
  )
}
