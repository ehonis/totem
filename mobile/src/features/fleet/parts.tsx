// Small pieces both Fleet screens draw: the status dot, btop-style bars, a
// sparkline, and the labelled number tiles.
import React, { useState } from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import Svg, { Polyline } from 'react-native-svg'
import { colors, alpha, radius } from '../../theme'
import { T } from '../../ui/Text'
import { heat } from '../../lib/fleet/format'
import type { FleetStatus, Health } from '../../lib/fleet/api'

export const HEALTH_COLOR: Record<Health, string> = {
  ok: colors.green,
  warn: colors.amber,
  bad: colors.red,
  // Down is a quieter red than bad: the machine is not reporting, not misbehaving.
  down: '#8c5560',
}

export const HEALTH_LABEL: Record<Health, string> = { ok: 'Healthy', warn: 'Warning', bad: 'Problem', down: 'Offline' }

export const HEAT_COLOR = { calm: colors.green, warm: colors.amber, hot: colors.red } as const
export const heatColor = (p: number) => HEAT_COLOR[heat(p)]

const STATE_NAMES: Record<string, string> = {
  AK: 'Alaska', AL: 'Alabama', AR: 'Arkansas', AZ: 'Arizona', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DC: 'D.C.', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', IA: 'Iowa', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', MA: 'Massachusetts', MD: 'Maryland', ME: 'Maine',
  MI: 'Michigan', MN: 'Minnesota', MO: 'Missouri', MS: 'Mississippi', MT: 'Montana', NC: 'North Carolina',
  ND: 'North Dakota', NE: 'Nebraska', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NV: 'Nevada',
  NY: 'New York', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VA: 'Virginia', VT: 'Vermont',
  WA: 'Washington', WI: 'Wisconsin', WV: 'West Virginia', WY: 'Wyoming',
}

/** "19.45¢/kWh, Ohio average" / "your rate" / "US average". */
export function rateLabel(rate: FleetStatus['rate']) {
  const where = rate.source === 'custom'
    ? 'your rate'
    : rate.source === 'state' && rate.state
      ? `${STATE_NAMES[rate.state] || rate.state} average`
      : 'US average'
  return `${rate.centsPerKwh.toFixed(2)}¢/kWh, ${where}`
}

export function StatusDot({ level, size = 9 }: { level: Health; size?: number }) {
  const c = HEALTH_COLOR[level]
  return (
    <View
      accessibilityLabel={HEALTH_LABEL[level]}
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c, shadowColor: c, shadowOpacity: level === 'down' ? 0 : 0.7, shadowRadius: 4, shadowOffset: { width: 0, height: 0 } }}
    />
  )
}

/** A btop meter: a track filled to `pct`, coloured by heat unless given a colour. */
export function Bar({ pct, color, height = 6, style }: { pct: number | null | undefined; color?: string; height?: number; style?: StyleProp<ViewStyle> }) {
  const p = Math.max(0, Math.min(100, pct ?? 0))
  return (
    <View style={[{ height, borderRadius: height / 2, backgroundColor: alpha(colors.text, 0.08), overflow: 'hidden' }, style]}>
      <View style={{ width: `${p}%`, height: '100%', borderRadius: height / 2, backgroundColor: color || heatColor(p) }} />
    </View>
  )
}

/** A label, a bar and a value on one line (CPU 0 ▮▮▮▯ 42%). */
export function MeterRow({ label, pct, value, color, labelWidth = 44 }: { label: string; pct: number | null | undefined; value: string; color?: string; labelWidth?: number }) {
  return (
    <View style={st.meterRow}>
      <T size={12.5} muted numberOfLines={1} style={{ width: labelWidth }}>{label}</T>
      <Bar pct={pct} color={color} style={{ flex: 1 }} />
      <T size={12.5} mono color={colors.text} align="right" numberOfLines={1} style={{ minWidth: 52 }}>{value}</T>
    </View>
  )
}

/** One or more lines over the same width, scaled to `max` (or to the data). */
export function Sparkline({ series, height = 44, max }: { series: { values: number[]; color: string }[]; height?: number; max?: number }) {
  const [width, setWidth] = useState(0)
  const top = max ?? Math.max(1, ...series.flatMap((s) => s.values))
  return (
    <View style={{ height }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 ? (
        <Svg width={width} height={height}>
          {series.map((s, i) => {
            if (s.values.length < 2) return null
            const step = width / (s.values.length - 1)
            const points = s.values
              .map((v, j) => `${(j * step).toFixed(1)},${(height - 1 - (Math.max(0, v) / top) * (height - 2)).toFixed(1)}`)
              .join(' ')
            return <Polyline key={i} points={points} fill="none" stroke={s.color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
          })}
        </Svg>
      ) : null}
    </View>
  )
}

/** A small label over a number. */
export function Stat({ label, value, sub, style }: { label: string; value: string; sub?: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ minWidth: 0, gap: 2 }, style]}>
      <T size={11.5} muted numberOfLines={1} style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</T>
      <T size={17} weight={600} numberOfLines={1}>{value}</T>
      {sub ? <T size={11.5} muted numberOfLines={1}>{sub}</T> : null}
    </View>
  )
}

/** A titled card block on the detail screen (btop's boxes). */
export function Box({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <View style={st.box}>
      <View style={st.boxHead}>
        <T size={13} weight={600} style={{ flex: 1 }}>{title}</T>
        {right}
      </View>
      {children}
    </View>
  )
}

const st = StyleSheet.create({
  meterRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 20 },
  box: { backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line, borderRadius: radius.lg, padding: 14, gap: 10 },
  boxHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
})
