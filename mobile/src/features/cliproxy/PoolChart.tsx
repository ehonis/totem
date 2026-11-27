// One provider's pooled quota over the visible range: the web's pool chart
// (web/src/cliproxy/pool/PoolChart.tsx), drawn with react-native-svg from the
// same layout (lib/cliproxy/pool/poolChartLayout.ts, the web's file), so every
// line, label and marker lands where the dashboard puts it.
//
// Touch, not a mouse: in the page (`scrub="hold"`) a press-and-hold puts the
// crosshair down and a drag then walks it, so a plain swipe still scrolls the
// page, as Stocks does; sideways (`scrub="drag"`) a drag walks it at once. A tap
// puts it where the finger is, a tap on the reading takes it away, two fingers
// pinch to zoom and slide the view, and a double tap shows the whole range.
import React, { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import Svg, { Circle, ClipPath, Defs, G, Line, LinearGradient, Path, Rect, Stop, Text as SvgText, TSpan } from 'react-native-svg'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import { idleSpans, type IdleSchedule, type PoolLimitEvent, type PoolLimitEventKind, type PoolModel, type SeriesPoint } from '../../lib/cliproxy/pool/poolModel'
import {
  accountBands,
  areaPath,
  bandPath,
  chartFrame,
  chartYMax,
  columnLabels,
  hoverReading,
  linePath,
  placeMarkers,
  placeResetLabels,
  timeColumns,
  usesHourColumns,
  windowed,
  type ChartFrame,
  type HoverReading,
  type PoolChartMode,
} from '../../lib/cliproxy/pool/poolChartLayout'
import { bandOpacity, EVENT_LONG_KEY, EVENT_PAST_KEY, formatPercent, formatRate, formatStamp } from '../../lib/cliproxy/pool/poolFormat'
import { poolText } from '../../lib/cliproxy/pool/poolText'
import type { TimeView } from '../../lib/cliproxy/pool/poolZoom'
import { colors, fonts, textAlpha } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { tap } from '../../ui/haptics'
import { focalView, thinResets } from './chartGestures'

export const CHART_COLORS = {
  grid: 'rgba(38, 43, 56, 0.6)',
  gridStrong: colors.line,
  text: colors.text,
  secondary: textAlpha(80),
  tertiary: colors.muted,
  card: colors.bg2,
  weeklyOut: colors.red,
  fiveOut: colors.amber,
  weeklyReset: colors.green,
}

export const EVENT_COLOR: Record<PoolLimitEventKind, string> = {
  'weekly-out': CHART_COLORS.weeklyOut,
  'five-out': CHART_COLORS.fiveOut,
  'weekly-reset': CHART_COLORS.weeklyReset,
}

// A phone's margins: room for "100%" on the left and two label rows on top.
const M = { top: 40, right: 10, bottom: 38, left: 40 }
const EVENT_ROWS = [M.top - 22, M.top - 6]
const FONT = 11
const eventName = (e: PoolLimitEvent) => (e.recorded ? EVENT_PAST_KEY : EVENT_LONG_KEY)[e.kind]

/**
 * A label with a halo in the card's colour, so it reads over a line. The web's
 * `paint-order: stroke`; react-native-svg has none, so the halo is a copy drawn first.
 */
function HaloText({ children, ...props }: React.ComponentProps<typeof SvgText>) {
  return (
    <>
      <SvgText {...props} fill={CHART_COLORS.card} fillOpacity={1} stroke={CHART_COLORS.card} strokeWidth={3} strokeLinejoin="round">{children}</SvgText>
      <SvgText {...props}>{children}</SvgText>
    </>
  )
}

export interface PoolChartProps {
  model: PoolModel
  mode: PoolChartMode
  startMs: number
  endMs: number
  bounds: TimeView
  onViewChange: (view: TimeView | null) => void
  now: number
  showAccounts: boolean
  hourly?: boolean
  idle?: IdleSchedule
  minResetLabel?: number
  /** At most one refill label in each of this many slices of the view (the biggest); 0 for no limit. */
  resetSlots?: number
  eventKinds?: readonly PoolLimitEventKind[]
  overlay?: { label: string; model: PoolModel } | null
  accent: string
  overlayAccent: string
  width: number
  height: number
  /** `hold` inside a scrolling page; `drag` where nothing else wants the finger. */
  scrub: 'hold' | 'drag'
  /** The page stops scrolling while a finger is on the chart (a scrub or a pinch). */
  onTouching?: (touching: boolean) => void
  label: string
}

/** Everything but the crosshair: redrawn only when the data, the view or the size moves. */
const ChartBody = memo(function ChartBody({ frame, model, mode, now, showAccounts, hourly, idle, minResetLabel, resetSlots, resetAnchor, eventKinds, overlay, accent, overlayAccent, zoomed, height, markers }: {
  frame: ChartFrame
  model: PoolModel
  mode: PoolChartMode
  now: number
  showAccounts: boolean
  hourly: boolean
  idle?: IdleSchedule
  minResetLabel: number
  resetSlots: number
  resetAnchor: number
  eventKinds: readonly PoolLimitEventKind[]
  overlay: PoolModel | null
  accent: string
  overlayAccent: string
  zoomed: boolean
  height: number
  markers: ReturnType<typeof placeMarkers>
}) {
  const { startMs, endMs, plotLeft, plotTop, plotW, plotH, x, y, yMax, width } = frame
  const rateMode = mode === 'rate'
  const recorded = rateMode ? model.recordedRate : model.recorded
  const projected = rateMode ? model.projectedRate : model.projected
  const visible = (series: SeriesPoint[]) => windowed(series, startMs, endMs)
  const recordedVisible = visible(recorded)
  const projectedVisible = visible(projected)
  const overlayRecorded = overlay ? visible(overlay.recorded) : []
  const overlayProjected = overlay ? visible(overlay.projected) : []
  const bands = !showAccounts || rateMode ? [] : accountBands(model)
  const resets = rateMode ? [] : placeResetLabels(resetSlots ? { ...model, resets: thinResets(model.resets, startMs, endMs, resetSlots, resetAnchor) } : model, frame, { now, minResetLabel, labelW: 38, labelH: 14 })
  const hourColumns = usesHourColumns(hourly, endMs - startMs)
  const columns = timeColumns({ startMs, endMs, now, hourColumns, zoomed, plotW, minColumnPx: 36 })
  const labels = columnLabels(columns, frame, hourColumns)
  const yTicks = [0, yMax / 2, yMax]
  const tickLabel = (v: number) => (rateMode ? (Number.isInteger(v) ? `${v}%/h` : formatRate(v)) : formatPercent(v))
  const nowVisible = now >= startMs && now <= endMs
  const nowValue = rateMode ? (model.burnPerHour ?? 0) : (model.current ?? 0)
  const hasData = recordedVisible.length > 1 || projectedVisible.length > 1
  // Ids of its own: on the web preview every chart's defs share one document.
  const uid = useId().replace(/[^A-Za-z0-9]/g, '')
  const fillId = `pool-fill-${uid}`
  const clipId = `pool-plot-${uid}`

  return (
    <Svg width={width} height={height}>
      <Defs>
        <LinearGradient id={fillId} x1="0" x2="0" y1="0" y2="1">
          <Stop offset="0%" stopColor={accent} stopOpacity={0.28} />
          <Stop offset="78%" stopColor={accent} stopOpacity={0.02} />
        </LinearGradient>
        <ClipPath id={clipId}>
          <Rect x={plotLeft} y={0} width={plotW} height={plotTop + plotH} />
        </ClipPath>
      </Defs>

      {/* quiet hours and off days: only the projection assumes them, so shade the future */}
      {idleSpans(Math.max(startMs, now), endMs, idle ?? {}).map((span) => (
        <Rect key={`q${span.startMs}`} x={x(span.startMs)} y={plotTop} width={Math.max(0, x(span.endMs) - x(span.startMs))} height={plotH} fill={colors.text} opacity={0.045} />
      ))}

      {columns.filter((col) => col.t >= startMs).map((col) => (
        <Line key={`g${col.t}`} x1={x(col.t)} x2={x(col.t)} y1={plotTop} y2={plotTop + plotH} stroke={CHART_COLORS.grid} strokeWidth={1} />
      ))}
      {yTicks.map((v) => (
        <G key={`y${v}`}>
          <Line x1={plotLeft} x2={plotLeft + plotW} y1={y(v)} y2={y(v)} stroke={v === 0 ? CHART_COLORS.gridStrong : CHART_COLORS.grid} strokeWidth={1} />
          <SvgText x={plotLeft - 6} y={y(v) + 4} textAnchor="end" fontSize={FONT} fontFamily={fonts[400]} fill={CHART_COLORS.secondary}>{tickLabel(v)}</SvgText>
        </G>
      ))}

      <G clipPath={`url(#${clipId})`}>
        {bands.length > 0 ? (
          bands.map((band, index) => (
            <G key={band.key} opacity={bandOpacity(index, bands.length)}>
              <Path d={bandPath(frame, band.recorded)} fill={accent} stroke={accent} strokeOpacity={0.5} strokeWidth={1} />
              <Path d={bandPath(frame, band.projected)} fill={accent} fillOpacity={0.6} stroke={accent} strokeOpacity={0.5} strokeWidth={1} />
            </G>
          ))
        ) : (
          <>
            {recordedVisible.length > 1 ? <Path d={areaPath(frame, recordedVisible)} fill={`url(#${fillId})`} /> : null}
            {projectedVisible.length > 1 ? <Path d={areaPath(frame, projectedVisible)} fill={`url(#${fillId})`} opacity={0.55} /> : null}
          </>
        )}
        {recordedVisible.length > 1 ? <Path d={linePath(frame, recordedVisible)} fill="none" stroke={accent} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" /> : null}
        {projectedVisible.length > 1 ? <Path d={linePath(frame, projectedVisible)} fill="none" stroke={accent} strokeWidth={2} strokeDasharray="7 5" strokeLinejoin="round" /> : null}
        {overlayRecorded.length > 1 ? <Path d={linePath(frame, overlayRecorded)} fill="none" stroke={overlayAccent} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" /> : null}
        {overlayProjected.length > 1 ? <Path d={linePath(frame, overlayProjected)} fill="none" stroke={overlayAccent} strokeWidth={1.75} strokeDasharray="7 5" strokeLinejoin="round" /> : null}
      </G>

      {markers.map((marker) => {
        const color = EVENT_COLOR[marker.event.kind]
        const past = !!marker.event.recorded
        const five = marker.event.kind === 'five-out'
        return (
          <G key={marker.key}>
            <Line
              x1={marker.cx} x2={marker.cx}
              y1={marker.labelY === null ? plotTop : marker.labelY + 4} y2={plotTop + plotH}
              stroke={color}
              strokeWidth={past || five ? 1 : 1.25}
              strokeDasharray={past ? undefined : '3 4'}
              opacity={past ? 0.45 : five ? 0.6 : 0.85}
            />
            {marker.labelY !== null ? (
              <HaloText x={marker.cx} y={marker.labelY} textAnchor="middle" fontSize={FONT} fontFamily={fonts[600]} fill={color} fillOpacity={past ? 0.7 : 1}>
                {marker.text}
              </HaloText>
            ) : null}
          </G>
        )
      })}

      {resets.map((label) => (
        <HaloText key={label.key} x={label.x} y={label.y} textAnchor="middle" fontSize={FONT + 0.5} fontFamily={fonts[500]} fill={label.projected ? CHART_COLORS.secondary : CHART_COLORS.text} fillOpacity={label.projected ? 1 : 0.85}>
          {label.text}
        </HaloText>
      ))}

      {nowVisible ? (
        <G>
          <Line x1={x(now)} x2={x(now)} y1={plotTop - 12} y2={plotTop + plotH + 4} stroke={CHART_COLORS.tertiary} strokeWidth={1} />
          <SvgText x={x(now)} y={plotTop - 17} textAnchor="middle" fontSize={FONT + 0.5} fontFamily={fonts[500]} fill={CHART_COLORS.secondary}>{poolText.t('quota_management.pool_now')}</SvgText>
          {hasData ? <Circle cx={x(now)} cy={y(nowValue)} r={4} fill={accent} stroke={CHART_COLORS.card} strokeWidth={2.5} /> : null}
          {overlay && overlay.current != null ? <Circle cx={x(now)} cy={y(overlay.current)} r={3.5} fill={overlayAccent} stroke={CHART_COLORS.card} strokeWidth={2.5} /> : null}
        </G>
      ) : null}

      {labels.map(({ column, x: lx }) => (
        <SvgText key={`x${column.t}`} x={lx} y={plotTop + plotH + 16} textAnchor="middle" fontSize={FONT} fontFamily={fonts[column.today ? 600 : 400]} fill={column.today ? CHART_COLORS.text : CHART_COLORS.secondary}>
          <TSpan x={lx}>{column.weekday}</TSpan>
          <TSpan x={lx} dy={14}>{column.day}</TSpan>
        </SvgText>
      ))}
    </Svg>
  )
})

/** The reading under the crosshair, on the side away from the finger. */
function Reading({ hover, rateMode, overlay, overlayAccent, side, onDismiss }: {
  hover: HoverReading
  rateMode: boolean
  overlay: { label: string } | null
  overlayAccent: string
  side: 'left' | 'right'
  onDismiss: () => void
}) {
  const { t } = poolText
  return (
    <Press
      onPress={() => { tap(); onDismiss() }}
      accessibilityRole="button"
      accessibilityLabel={`${formatStamp(hover.t)}, ${rateMode ? formatRate(hover.v) : formatPercent(hover.v)}. Tap to hide.`}
      style={[st.reading, side === 'left' ? { left: 6 } : { right: 6 }]}
    >
      <T size={11.5} color={CHART_COLORS.tertiary}>{formatStamp(hover.t)}</T>
      <View style={st.readingRow}>
        <T size={15} weight={600} style={st.num}>{rateMode ? formatRate(hover.v) : formatPercent(hover.v)}</T>
        <T size={11.5} color={CHART_COLORS.tertiary}>{t(hover.isProjected ? 'quota_management.pool_legend_projected' : 'quota_management.pool_legend_recorded')}</T>
      </View>
      {overlay && hover.overlayV !== null ? (
        <View style={st.readingRow}>
          <T size={13} weight={600} color={overlayAccent} style={st.num}>{formatPercent(hover.overlayV)}</T>
          <T size={11.5} color={CHART_COLORS.tertiary}>{overlay.label}</T>
        </View>
      ) : null}
      {hover.events.length > 0 ? (
        <View style={st.readingSection}>
          {hover.events.map((e) => (
            <View key={`${e.kind}-${e.t}-${e.recorded ? 'r' : 'p'}`} style={[st.readingEvent, { borderLeftColor: EVENT_COLOR[e.kind] }]}>
              <T size={11.5} weight={600}>{`${t(eventName(e))} · ${formatStamp(e.t)}`}</T>
              <T size={11.5} color={CHART_COLORS.secondary} numberOfLines={2}>{e.labels.join(', ')}</T>
            </View>
          ))}
        </View>
      ) : null}
      {hover.accounts.length > 0 && hover.windowed ? (
        <View style={st.readingSection}>
          <View style={st.readingRow}>
            <T size={10.5} color={CHART_COLORS.tertiary} style={{ flex: 1 }}> </T>
            <T size={10.5} color={CHART_COLORS.tertiary} style={st.cell}>{t('quota_management.pool_tooltip_usable')}</T>
            <T size={10.5} color={CHART_COLORS.tertiary} style={st.cell}>{t('quota_management.pool_window_weekly')}</T>
            <T size={10.5} color={CHART_COLORS.tertiary} style={st.cell}>{t('quota_management.pool_window_five_hour')}</T>
          </View>
          {hover.accounts.map((a) => (
            <View key={a.label} style={st.readingRow}>
              <T size={11.5} color={CHART_COLORS.secondary} numberOfLines={1} style={{ flex: 1 }}>{a.label}</T>
              <T size={11.5} weight={600} style={[st.cell, st.num]}>{formatPercent(a.v)}</T>
              {(['weekly', 'five'] as const).map((limit) => (
                <T
                  key={limit}
                  size={11.5}
                  color={a.binding === limit ? CHART_COLORS.text : a.binding ? CHART_COLORS.tertiary : CHART_COLORS.secondary}
                  weight={a.binding === limit ? 600 : 400}
                  style={[st.cell, st.num, a.binding === limit && st.binding]}
                  accessibilityLabel={a.binding === limit ? `${formatPercent(a[limit])} ${t('quota_management.pool_tooltip_binding')}` : undefined}
                >
                  {formatPercent(a[limit])}
                </T>
              ))}
            </View>
          ))}
          {hover.accounts.some((a) => a.binding) ? (
            <T size={10.5} color={CHART_COLORS.tertiary}>{t('quota_management.pool_tooltip_binding_note')}</T>
          ) : null}
        </View>
      ) : null}
      {hover.accounts.length > 0 && !hover.windowed ? (
        <View style={st.readingSection}>
          {hover.accounts.map((a) => (
            <View key={a.label} style={st.readingRow}>
              <T size={11.5} color={CHART_COLORS.secondary} numberOfLines={1} style={{ flex: 1 }}>{a.label}</T>
              <T size={11.5} weight={600} style={st.num}>{formatPercent(a.v)}</T>
            </View>
          ))}
        </View>
      ) : null}
    </Press>
  )
}

export function PoolChart(props: PoolChartProps) {
  const {
    model, mode, startMs, endMs, bounds, onViewChange, now, showAccounts, hourly = false, idle,
    minResetLabel = 0, resetSlots = 0, eventKinds = [], overlay = null, accent, overlayAccent, width, height, scrub, onTouching, label,
  } = props
  const rateMode = mode === 'rate'
  const yMax = useMemo(() => chartYMax(model, rateMode), [model, rateMode])
  const frame = useMemo(() => chartFrame({ startMs, endMs, width, height, margin: M, yMax }), [startMs, endMs, width, height, yMax])
  const markers = useMemo(() => placeMarkers(model, frame, { now, eventKinds, rows: EVENT_ROWS, charW: 6 }), [model, frame, now, eventKinds])
  const shownOverlay = rateMode ? null : overlay
  const zoomed = startMs > bounds.startMs || endMs < bounds.endMs

  const [hoverT, setHoverT] = useState<number | null>(null)
  const hover = useMemo(
    () => hoverReading({ model, frame, hoverT, now, rateMode, showAccounts, markers, overlay: shownOverlay?.model ?? null }),
    [model, frame, hoverT, now, rateMode, showAccounts, markers, shownOverlay],
  )

  // Gestures read the newest view and size through a ref: they are built once per mount.
  const live = useRef({ frame, bounds, onViewChange, onTouching })
  live.current = { frame, bounds, onViewChange, onTouching }
  const tAt = (px: number) => {
    const f = live.current.frame
    const frac = Math.min(1, Math.max(0, (px - f.plotLeft) / f.plotW))
    return f.startMs + frac * (f.endMs - f.startMs)
  }
  // One view change per frame, however fast the fingers report.
  const pending = useRef<{ view: TimeView | null } | null>(null)
  const flush = useCallback(() => {
    const next = pending.current
    pending.current = null
    if (next) live.current.onViewChange(next.view)
  }, [])
  const propose = useCallback((view: TimeView | null) => {
    const first = pending.current === null
    pending.current = { view }
    if (first) requestAnimationFrame(flush)
  }, [flush])
  const pinchFrom = useRef<{ view: TimeView; anchorMs: number } | null>(null)
  const lastTick = useRef<number | null>(null)

  const gesture = useMemo(() => {
    const touching = (on: boolean) => live.current.onTouching?.(on)
    const walk = (px: number) => {
      const t = tAt(px)
      // A light tick every 24th of the view the crosshair crosses: an hour on the
      // 5-hour page would buzz without a break on a week.
      const f = live.current.frame
      const step = Math.floor(((t - f.startMs) / Math.max(1, f.endMs - f.startMs)) * 24)
      if (lastTick.current !== null && step !== lastTick.current) tap()
      lastTick.current = step
      setHoverT(t)
    }
    let pan = Gesture.Pan().runOnJS(true).maxPointers(1)
    // Sideways the view is drawn turned, and iOS measures a pan's offsets on the
    // unturned screen (RNPanHandler: translationInView: window), so the drag starts on
    // distance alone, in any direction: iOS's 10 pt tap slop, so a tap, a double tap
    // or the first finger of a pinch that wobbles is not taken for a drag.
    pan = scrub === 'hold' ? pan.activateAfterLongPress(220) : pan.minDistance(10)
    pan = pan
      .onStart((e) => { touching(true); lastTick.current = null; tap(); walk(e.x) })
      .onUpdate((e) => walk(e.x))
      .onFinalize(() => touching(false))
    const pinch = Gesture.Pinch()
      .runOnJS(true)
      .onStart((e) => {
        touching(true)
        const f = live.current.frame
        pinchFrom.current = { view: { startMs: f.startMs, endMs: f.endMs }, anchorMs: tAt(e.focalX) }
        setHoverT(null)
      })
      .onUpdate((e) => {
        const from = pinchFrom.current
        if (!from) return
        const f = live.current.frame
        propose(focalView(from.view, live.current.bounds, from.anchorMs, e.scale, (e.focalX - f.plotLeft) / f.plotW))
      })
      .onFinalize(() => { pinchFrom.current = null; touching(false) })
    const single = Gesture.Tap().runOnJS(true).maxDuration(250).onEnd((e, ok) => { if (ok) { tap(); setHoverT(tAt(e.x)) } })
    const double = Gesture.Tap().runOnJS(true).numberOfTaps(2).maxDelay(250).onEnd((_e, ok) => {
      if (!ok) return
      tap()
      setHoverT(null)
      live.current.onViewChange(null)
    })
    return Gesture.Race(pinch, pan, Gesture.Exclusive(double, single))
    // Built once per scrub style; everything else is read through `live`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrub, propose])

  // A reading from another view would point at nothing. (Paging moves it out of
  // view, where it reads as nothing; the clock's minute tick keeps it.)
  useEffect(() => { setHoverT(null) }, [mode, hourly])

  const side = hover && frame.x(hover.t) > width / 2 ? 'left' : 'right'
  const hasData = windowed(rateMode ? model.recordedRate : model.recorded, startMs, endMs).length > 1
    || windowed(rateMode ? model.projectedRate : model.projected, startMs, endMs).length > 1
  const nowText = rateMode ? formatRate(model.burnPerHour) : formatPercent(model.current)

  return (
    <View style={{ width, height }}>
      <GestureDetector gesture={gesture}>
        <View
          style={{ width, height }}
          accessible
          accessibilityRole="image"
          accessibilityLabel={`${label} chart. Now ${nowText}${model.poolEmptyAtMs ? `, runs out ${formatStamp(model.poolEmptyAtMs)}` : ''}.`}
          accessibilityHint="Touch and hold, then drag, to read a moment. Pinch to zoom, double tap to see the whole range."
        >
          <ChartBody
            frame={frame}
            model={model}
            mode={mode}
            now={now}
            showAccounts={showAccounts}
            hourly={hourly}
            idle={idle}
            minResetLabel={minResetLabel}
            resetSlots={resetSlots}
            resetAnchor={bounds.startMs}
            eventKinds={eventKinds}
            overlay={shownOverlay?.model ?? null}
            accent={accent}
            overlayAccent={overlayAccent}
            zoomed={zoomed}
            height={height}
            markers={markers}
          />
          {hover ? (
            <Svg width={width} height={height} style={StyleSheet.absoluteFill} pointerEvents="none">
              <Line x1={frame.x(hover.t)} x2={frame.x(hover.t)} y1={frame.plotTop} y2={frame.plotTop + frame.plotH} stroke={CHART_COLORS.secondary} strokeWidth={1} strokeDasharray="2 3" />
              <Circle cx={frame.x(hover.t)} cy={frame.y(hover.v)} r={4} fill={CHART_COLORS.card} stroke={accent} strokeWidth={2} />
            </Svg>
          ) : null}
          {!hasData ? (
            <View pointerEvents="none" style={[st.empty, { top: M.top, left: M.left, right: M.right, bottom: M.bottom }]}>
              <T size={12.5} color={CHART_COLORS.tertiary} align="center">{poolText.t('quota_management.pool_no_data')}</T>
            </View>
          ) : null}
        </View>
      </GestureDetector>
      {/* Beside the chart's touch area, not in it: a tap that hides the reading must
          not also land on the chart and put it back. */}
      {hover ? (
        <Reading hover={hover} rateMode={rateMode} overlay={shownOverlay} overlayAccent={overlayAccent} side={side} onDismiss={() => setHoverT(null)} />
      ) : null}
    </View>
  )
}

const st = StyleSheet.create({
  empty: { position: 'absolute', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  reading: {
    position: 'absolute', top: 4, minWidth: 150, maxWidth: 260, paddingVertical: 8, paddingHorizontal: 10, gap: 2,
    borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.bg,
    shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 12, shadowOffset: { width: 0, height: 6 },
  },
  readingRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
  readingSection: { marginTop: 6, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, gap: 3 },
  readingEvent: { paddingLeft: 7, borderLeftWidth: 2, gap: 1 },
  cell: { width: 44, textAlign: 'right' },
  num: { fontVariant: ['tabular-nums'] },
  binding: { textDecorationLine: 'underline' },
})
