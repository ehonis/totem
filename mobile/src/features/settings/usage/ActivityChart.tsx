// The web's 30-day stacked activity chart (usageMeta.tsx ActivityChart) as plain
// Views: one column per day, split by channel. A tap on a column names its day
// and count under the chart, where the web shows a hover tooltip.
import React, { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { CHANNEL_META, CHANNEL_ORDER, fmtInt } from '../../../lib/usageMeta'
import { colors } from '../../../theme'
import { T } from '../../../ui/Text'
import { Press } from '../../../ui/kit'

// "YYYY-MM-DD" as a local date, so a day never slips back across UTC midnight.
function dayOf(key: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    const [y, m, d] = key.split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  return new Date(key)
}

export function ActivityChart({ daily, height = 96 }: { daily?: { date: string; count: number; channels?: Record<string, number> }[]; height?: number }) {
  const [picked, setPicked] = useState<number | null>(null)
  if (!daily?.length) return null
  const max = Math.max(1, ...daily.map((d) => d.count))
  const shown = picked != null ? daily[picked] : null
  const first = dayOf(daily[0].date)
  const last = dayOf(daily[daily.length - 1].date)
  const fmt = (d: Date) => d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  return (
    <View style={{ gap: 6 }}>
      <View style={[st.bars, { height }]} accessibilityLabel={`Requests per day, ${fmt(first)} to ${fmt(last)}`}>
        {daily.map((d, i) => {
          const pct = d.count ? Math.max(4, Math.round((d.count / max) * 100)) : 0
          return (
            <Press
              key={d.date}
              style={st.col}
              onPress={() => setPicked(picked === i ? null : i)}
              accessibilityLabel={`${fmt(dayOf(d.date))}: ${d.count} requests`}
            >
              <View style={[st.bar, { height: `${pct}%` }, picked === i && st.barOn]}>
                {CHANNEL_ORDER.map((id) => {
                  const n = d.channels?.[id] || 0
                  return n ? <View key={id} style={{ height: `${(n / d.count) * 100}%`, backgroundColor: CHANNEL_META[id]?.color }} /> : null
                })}
              </View>
            </Press>
          )
        })}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        {shown ? (
          <T size={12} muted>
            {dayOf(shown.date).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}: {fmtInt(shown.count)} {shown.count === 1 ? 'request' : 'requests'}
            {CHANNEL_ORDER.filter((id) => shown.channels?.[id]).map((id) => ` · ${CHANNEL_META[id].label} ${shown.channels![id]}`).join('')}
          </T>
        ) : (
          <>
            <T size={11.5} muted>{fmt(first)}</T>
            <T size={11.5} muted>{fmt(last)}</T>
          </>
        )}
      </View>
    </View>
  )
}

const st = StyleSheet.create({
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  col: { flex: 1, height: '100%', justifyContent: 'flex-end' },
  bar: { width: '100%', borderRadius: 2, overflow: 'hidden', flexDirection: 'column-reverse', backgroundColor: colors.bg3 },
  barOn: { opacity: 0.75 },
})
