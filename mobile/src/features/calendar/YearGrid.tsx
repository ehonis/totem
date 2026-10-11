// Year (.year): twelve mini months; a dot under any day with an event. The web
// lays them four across, which at phone width makes each day a 9px target, so the
// phone uses three across, as iOS Calendar's own year view does.
import React, { useMemo } from 'react'
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { colors } from '../../theme'
import { T } from '../../ui/Text'
import { Press } from '../../ui/kit'
import { FAB_CLEARANCE } from '../../shell/Screen'
import { addDays, isToday, parseDate, startOfMonth, startOfWeek, type CalEvent } from './dates'

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

interface MiniMonthProps {
  month: Date
  eventDays: Set<string>
  onPickDay: (d: Date) => void
  onPickMonth: (d: Date) => void
}

function MiniMonth({ month, eventDays, onPickDay, onPickMonth }: MiniMonthProps) {
  const gridStart = startOfWeek(startOfMonth(month))
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))
  return (
    <View style={st.mini}>
      <Press onPress={() => onPickMonth(month)} style={{ paddingBottom: 6, alignSelf: 'flex-start' }}>
        <T size={13} weight={600} color={colors.accent}>{month.toLocaleDateString([], { month: 'long' })}</T>
      </Press>
      <View style={st.row7}>
        {DOW.map((d, i) => <T key={i} size={10} muted align="center" style={st.cell7}>{d}</T>)}
      </View>
      <View style={[st.row7, { flexWrap: 'wrap' }]}>
        {cells.map((d) => {
          // Days of the neighbouring months hold their place but show nothing.
          if (d.getMonth() !== month.getMonth()) return <View key={d.getTime()} style={[st.cell7, st.day]} />
          const today = isToday(d)
          const has = eventDays.has(d.toDateString())
          return (
            <Press key={d.getTime()} onPress={() => onPickDay(d)} style={[st.cell7, st.day, today && { backgroundColor: colors.accent }]}>
              <T size={10.5} lineHeight={13} color={today ? colors.white : colors.text}>{d.getDate()}</T>
              {has ? <View style={[st.dot, { backgroundColor: today ? colors.white : colors.accent2 }]} /> : null}
            </Press>
          )
        })}
      </View>
    </View>
  )
}

interface YearGridProps {
  anchor: Date
  events: CalEvent[]
  onPickDay: (d: Date) => void
  onPickMonth: (d: Date) => void
  refreshing: boolean
  onRefresh: () => void
}

export default function YearGrid({ anchor, events, onPickDay, onPickMonth, refreshing, onRefresh }: YearGridProps) {
  const eventDays = useMemo(() => {
    const s = new Set<string>()
    for (const e of events) s.add(parseDate(e.start).toDateString())
    return s
  }, [events])
  const months = Array.from({ length: 12 }, (_, m) => new Date(anchor.getFullYear(), m, 1))
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={st.year}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.muted} />}
    >
      {months.map((m) => (
        <View key={m.getTime()} style={st.slot}>
          <MiniMonth month={m} eventDays={eventDays} onPickDay={onPickDay} onPickMonth={onPickMonth} />
        </View>
      ))}
    </ScrollView>
  )
}

const st = StyleSheet.create({
  year: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -5, paddingBottom: FAB_CLEARANCE },
  slot: { width: '33.333%', padding: 5 },
  mini: { backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line, borderRadius: 10, padding: 8 },
  row7: { flexDirection: 'row' },
  cell7: { width: '14.2857%' },
  day: { aspectRatio: 1, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  dot: { position: 'absolute', bottom: -1, width: 3, height: 3, borderRadius: 1.5 },
})
